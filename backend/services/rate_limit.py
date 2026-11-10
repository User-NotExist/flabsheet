"""Failed-login rate limiting backed by Redis counters.

Only failures count. After ``login_rate_limit_attempts`` failures for the same
(login_id, client IP) within ``login_rate_limit_window_seconds``, further
attempts are rejected until the window expires. If Redis is unreachable the
limiter fails open (logins keep working, unthrottled) and logs a warning.
"""

from __future__ import annotations

import logging

import redis

from config import settings
from db.redis import redis_client

logger = logging.getLogger(__name__)


def _key(login_id: str, client_ip: str) -> str:
    return f"login_fail:{login_id.lower()}:{client_ip}"


def login_retry_after(login_id: str, client_ip: str) -> int:
    """Seconds the caller must wait before trying again; 0 if not limited."""
    key = _key(login_id, client_ip)
    try:
        count = redis_client.get(key)
        if count is None or int(count) < settings.login_rate_limit_attempts:
            return 0
        return max(redis_client.ttl(key), 1)
    except redis.RedisError:
        logger.warning("login rate limit check failed; allowing attempt", exc_info=True)
        return 0


def record_login_failure(login_id: str, client_ip: str) -> None:
    key = _key(login_id, client_ip)
    try:
        pipe = redis_client.pipeline()
        pipe.incr(key)
        # NX: the window starts at the first failure and is not extended by later ones
        pipe.expire(key, settings.login_rate_limit_window_seconds, nx=True)
        pipe.execute()
    except redis.RedisError:
        logger.warning("recording login failure failed", exc_info=True)


def clear_login_failures(login_id: str, client_ip: str) -> None:
    try:
        redis_client.delete(_key(login_id, client_ip))
    except redis.RedisError:
        logger.warning("clearing login failures failed", exc_info=True)
