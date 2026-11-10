"""Login sessions: PostgreSQL is the source of truth, Redis is a read cache.

Every active session is mirrored in Redis as ``session:<sha256(token)>`` holding
a snapshot of the session and its user (role, is_active, ...), so checking a
request normally costs one Redis GET and no SQL. On a cache miss, or if Redis is
unreachable, the session is read from PostgreSQL and the cache is refilled.

Because the snapshot contains user fields, any code that changes a user's
``role``, ``is_active``, ``display_name`` or ``must_change_password`` must call
:func:`invalidate_user_sessions` after committing, e.g.::

    user.role = UserRole.staff
    db.commit()
    invalidate_user_sessions(db, user.id)   # next request re-reads from Postgres
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

import redis
from sqlalchemy import select, update
from sqlalchemy.orm import Session as DbSession

from config import settings
from db.models.user import Session, User, UserRole
from db.redis import redis_client

logger = logging.getLogger(__name__)

CACHE_PREFIX = "session:"
# last_seen_at is written back to Postgres at most this often per session
LAST_SEEN_INTERVAL = timedelta(minutes=5)


@dataclass
class SessionData:
    """What a request knows about its caller. Cached in Redis as JSON."""

    session_id: str
    csrf_token: str
    expires_at: float  # unix timestamp
    seen_at: float  # unix timestamp of the last last_seen_at write
    user_id: int
    login_id: str
    display_name: str
    role: UserRole
    is_active: bool
    must_change_password: bool

    def to_json(self) -> str:
        data = asdict(self)
        data["role"] = self.role.value
        return json.dumps(data)

    @classmethod
    def from_json(cls, raw: str) -> "SessionData":
        data = json.loads(raw)
        data["role"] = UserRole(data["role"])
        return cls(**data)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(token: str) -> str:
    """Session id as stored in Postgres/Redis: SHA-256 of the cookie token."""
    return hashlib.sha256(token.encode()).hexdigest()


def _key(session_id: str) -> str:
    return CACHE_PREFIX + session_id


# --- Redis cache (every helper degrades to a no-op if Redis is down) ---------


def _cache_get(session_id: str) -> Optional[SessionData]:
    try:
        raw = redis_client.get(_key(session_id))
    except redis.RedisError:
        logger.warning("session cache read failed; falling back to Postgres", exc_info=True)
        return None
    if raw is None:
        return None
    try:
        return SessionData.from_json(raw)
    except (ValueError, TypeError, KeyError):
        # Unreadable entry (e.g. written by an older version): treat as a miss
        return None


def _cache_put(data: SessionData) -> None:
    ttl = int(data.expires_at - _now().timestamp())
    if ttl <= 0:
        return
    try:
        redis_client.set(_key(data.session_id), data.to_json(), ex=ttl)
    except redis.RedisError:
        logger.warning("session cache write failed", exc_info=True)


def _cache_delete(session_ids: list[str]) -> None:
    if not session_ids:
        return
    try:
        redis_client.delete(*(_key(sid) for sid in session_ids))
    except redis.RedisError:
        # A stale entry would keep a revoked session alive, so make this loud
        logger.error("session cache delete failed for %d session(s)", len(session_ids), exc_info=True)
        raise


# --- public API --------------------------------------------------------------


def _snapshot(session: Session, user: User, seen_at: datetime) -> SessionData:
    return SessionData(
        session_id=session.id,
        csrf_token=session.csrf_token,
        expires_at=session.expires_at.timestamp(),
        seen_at=seen_at.timestamp(),
        user_id=user.id,
        login_id=user.login_id,
        display_name=user.display_name,
        role=user.role,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
    )


def create_session(db: DbSession, user: User) -> tuple[str, SessionData]:
    """Create a session row for ``user`` and return ``(cookie_token, data)``.

    The row is flushed, not committed: call :func:`cache_session` with the
    returned data after the caller's ``db.commit()`` succeeds.
    """
    token = secrets.token_urlsafe(32)
    now = _now()
    session = Session(
        id=hash_token(token),
        user_id=user.id,
        csrf_token=secrets.token_urlsafe(32),
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=settings.session_ttl_days),
    )
    db.add(session)
    db.flush()
    return token, _snapshot(session, user, now)


def cache_session(data: SessionData) -> None:
    _cache_put(data)


def get_session(db: DbSession, token: str) -> Optional[SessionData]:
    """Resolve a cookie token to an active session, or None.

    Active means: exists, not revoked, not expired, and the user is active.
    """
    if not token:
        return None
    session_id = hash_token(token)
    now = _now()

    data = _cache_get(session_id)
    if data is None:
        row = db.execute(
            select(Session, User)
            .join(User, User.id == Session.user_id)
            .where(
                Session.id == session_id,
                Session.revoked_at.is_(None),
                Session.expires_at > now,
            )
        ).first()
        if row is None:
            return None
        session, user = row
        data = _snapshot(session, user, session.last_seen_at)
        if data.is_active:
            _cache_put(data)

    if not data.is_active or data.expires_at <= now.timestamp():
        return None

    if now.timestamp() - data.seen_at >= LAST_SEEN_INTERVAL.total_seconds():
        db.execute(update(Session).where(Session.id == session_id).values(last_seen_at=now))
        db.commit()
        data.seen_at = now.timestamp()
        _cache_put(data)

    return data


def revoke_session(db: DbSession, session_id: str) -> None:
    """Revoke one session (logout). Commits."""
    db.execute(
        update(Session)
        .where(Session.id == session_id, Session.revoked_at.is_(None))
        .values(revoked_at=_now())
    )
    db.commit()
    _cache_delete([session_id])


def revoke_user_sessions(
    db: DbSession, user_id: int, *, except_session_id: Optional[str] = None
) -> int:
    """Revoke every active session of a user, optionally keeping one. Commits.

    Returns the number of sessions revoked.
    """
    stmt = (
        update(Session)
        .where(Session.user_id == user_id, Session.revoked_at.is_(None))
        .values(revoked_at=_now())
        .returning(Session.id)
    )
    if except_session_id is not None:
        stmt = stmt.where(Session.id != except_session_id)
    revoked = list(db.scalars(stmt))
    db.commit()
    _cache_delete(revoked)
    return len(revoked)


def invalidate_user_sessions(db: DbSession, user_id: int) -> None:
    """Drop the cached snapshots of a user's sessions without revoking them.

    Call after committing a change to the user's role, is_active, display_name
    or must_change_password; the next request refills the cache from Postgres.
    """
    ids = list(
        db.scalars(
            select(Session.id).where(
                Session.user_id == user_id,
                Session.revoked_at.is_(None),
                Session.expires_at > _now(),
            )
        )
    )
    _cache_delete(ids)
