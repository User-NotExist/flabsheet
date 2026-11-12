"""FastAPI dependencies that check the caller's session and role.

Usage::

    from services.auth import CurrentSession, require_role
    from db.models.user import UserRole

    @router.get("/things")
    def list_things(session: CurrentSession):          # any logged-in user
        ...

    @router.post("/users", dependencies=[Depends(require_role(UserRole.admin))])
    def create_user(...):                               # admins only
        ...

    @router.get("/grades")
    def grades(session: SessionData = Depends(require_role(UserRole.staff, UserRole.admin))):
        ...

``current_session`` also enforces CSRF: state-changing methods must send the
session's CSRF token (returned by login and ``GET /auth/me``) in ``X-CSRF-Token``.
"""

from __future__ import annotations

import secrets
from typing import Annotated, Callable

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session as DbSession

from config import settings
from db.models.user import UserRole
from db.postgres import get_database
from services.operation_log import log_operation_now
from services.session import SessionData, get_session

CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


def current_session(
    request: Request, db: Annotated[DbSession, Depends(get_database)]
) -> SessionData:
    """Return the caller's active session or raise 401 (403 on a CSRF failure)."""
    token = request.cookies.get(settings.session_cookie_name)
    session = get_session(db, token) if token else None
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")

    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not secrets.compare_digest(sent.encode(), session.csrf_token.encode()):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")

    return session


AccountSession = Annotated[SessionData, Depends(current_session)]


def require_changed_password(session: AccountSession) -> SessionData:
    """A temporary password grants access to account routes until it is changed."""
    if session.must_change_password:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Change your password to continue")
    return session


CurrentSession = Annotated[SessionData, Depends(require_changed_password)]


def require_role(*roles: UserRole) -> Callable[..., SessionData]:
    """Dependency factory: the caller must be logged in with one of ``roles``."""
    if not roles:
        raise ValueError("require_role needs at least one role")
    allowed = frozenset(roles)

    def dependency(request: Request, session: CurrentSession) -> SessionData:
        if session.role not in allowed:
            log_operation_now(
                "auth.permission_denied",
                user_id=session.user_id,
                info={"method": request.method, "path": request.url.path, "role": session.role.value},
            )
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Insufficient permissions")
        return session

    return dependency
