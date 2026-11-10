from __future__ import annotations

from typing import Annotated

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from config import settings
from db.models.user import User, UserRole
from db.postgres import get_database
from services.auth import CurrentSession
from services.operation_log import log_operation, log_operation_now
from services.rate_limit import clear_login_failures, login_retry_after, record_login_failure
from services.session import (
    SessionData,
    cache_session,
    create_session,
    invalidate_user_sessions,
    revoke_session,
    revoke_user_sessions,
)

router = APIRouter(prefix="/auth", tags=["auth"])

Db = Annotated[DbSession, Depends(get_database)]

MIN_PASSWORD_LENGTH = 8  # same rule as cli.py seed-admin
MAX_PASSWORD_LENGTH = 1024  # bound the argon2 work an unauthenticated caller can request

password_hasher = PasswordHasher()
# Verified when the login id is unknown so that response time does not reveal
# whether an account exists.
_DUMMY_HASH = password_hasher.hash("flabsheet-dummy-password")


class LoginRequest(BaseModel):
    login_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,64}$")
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


class UserOut(BaseModel):
    id: int
    login_id: str
    display_name: str
    role: UserRole
    must_change_password: bool


class AuthResponse(BaseModel):
    user: UserOut
    # Send back in the X-CSRF-Token header on POST/PUT/PATCH/DELETE requests
    csrf_token: str


def _auth_response(session: SessionData) -> AuthResponse:
    return AuthResponse(
        user=UserOut(
            id=session.user_id,
            login_id=session.login_id,
            display_name=session.display_name,
            role=session.role,
            must_change_password=session.must_change_password,
        ),
        csrf_token=session.csrf_token,
    )


def _verify_password(password_hash: str, password: str) -> bool:
    try:
        return password_hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        settings.session_cookie_name,
        token,
        max_age=settings.session_ttl_days * 24 * 3600,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        settings.session_cookie_name,
        path="/",
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


@router.post("/login", response_model=AuthResponse)
def login(body: LoginRequest, request: Request, response: Response, db: Db):
    client_ip = _client_ip(request)

    retry_after = login_retry_after(body.login_id, client_ip)
    if retry_after:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many failed login attempts. Try again later.",
            headers={"Retry-After": str(retry_after)},
        )

    # login_id is CITEXT, so this comparison is case-insensitive
    user = db.scalar(select(User).where(User.login_id == body.login_id))
    password_ok = _verify_password(user.password_hash if user else _DUMMY_HASH, body.password)

    if user is None or not password_ok or not user.is_active:
        record_login_failure(body.login_id, client_ip)
        if user is None:
            reason = "unknown_user"
        elif not password_ok:
            reason = "bad_password"
        else:
            reason = "inactive"
        log_operation_now(
            "auth.login_failed",
            user_id=user.id if user else None,
            info={"login_id": body.login_id, "ip": client_ip, "reason": reason},
        )
        # Same response for every failure reason: do not reveal which one it was
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid login id or password")

    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(body.password)

    token, session = create_session(db, user)
    log_operation(db, "auth.login", user_id=user.id, info={"ip": client_ip})
    db.commit()
    cache_session(session)
    clear_login_failures(body.login_id, client_ip)

    _set_session_cookie(response, token)
    return _auth_response(session)


@router.get("/me", response_model=AuthResponse)
def me(session: CurrentSession):
    return _auth_response(session)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(session: CurrentSession, response: Response, db: Db):
    log_operation(db, "auth.logout", user_id=session.user_id)
    revoke_session(db, session.session_id)  # commits
    _clear_session_cookie(response)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
def logout_all(session: CurrentSession, response: Response, db: Db):
    """Revoke every session of the current user, including this one."""
    log_operation(db, "auth.logout_all", user_id=session.user_id)
    revoke_user_sessions(db, session.user_id)  # commits
    _clear_session_cookie(response)


@router.post("/change-password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(body: ChangePasswordRequest, session: CurrentSession, db: Db):
    """Change the caller's password and sign out all their other sessions."""
    user = db.get(User, session.user_id)
    if user is None or not _verify_password(user.password_hash, body.current_password):
        log_operation_now("auth.change_password_failed", user_id=session.user_id)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    if body.new_password == body.current_password:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST, "New password must differ from the current password"
        )

    user.password_hash = password_hasher.hash(body.new_password)
    user.must_change_password = False
    log_operation(db, "auth.change_password", user_id=user.id)
    revoke_user_sessions(db, user.id, except_session_id=session.session_id)  # commits
    # This session's cached snapshot still says must_change_password; refresh it
    invalidate_user_sessions(db, user.id)
