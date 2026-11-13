"""Manage staff accounts (admin only). Create and reset return the password once.

The list also shows admins so the page can explain why the last one has no
deactivate action. Admins are never created here (FR-AUTH-10: seed-admin only),
and no route changes a role.

    POST /staff {"login_id": "krit", "display_name": "Krit S."}       -> generated password
    POST /staff {"login_id": "ploy", "display_name": "Ploy N.", "password": "…"}
    PATCH /staff/7 {"is_active": false}
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from psycopg.errors import UniqueViolation
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from db.models.user import User, UserRole
from db.postgres import get_database
from routers.auth import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH
from services.auth import require_role
from services.operation_log import log_operation
from services.session import SessionData, invalidate_user_sessions, revoke_user_sessions
from services.students import issue_password

router = APIRouter(prefix="/staff", tags=["staff"])
Db = Annotated[DbSession, Depends(get_database)]
Admin = Annotated[SessionData, Depends(require_role(UserRole.admin))]
LoginId = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9._-]{1,64}$")
]
DisplayName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=100, pattern=r"^[^\x00]+$"),
]
_MANAGED_ROLES = (UserRole.staff, UserRole.admin)


class StaffCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    login_id: LoginId
    display_name: DisplayName
    # Omit to generate one. Either way the account must change it at first login.
    password: str | None = Field(None, min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)


class StaffPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    display_name: DisplayName | None = None
    is_active: bool | None = None


class StaffOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    login_id: str
    display_name: str
    role: UserRole
    is_active: bool


class StaffCredential(BaseModel):
    staff: StaffOut
    password: str


@router.get("", response_model=list[StaffOut])
def list_staff(db: Db, session: Admin):
    query = (
        select(User.id, User.login_id, User.display_name, User.role, User.is_active)
        .where(User.role.in_(_MANAGED_ROLES))
        .order_by(User.role.desc(), User.login_id)
    )
    return db.execute(query).mappings().all()


@router.post("", response_model=StaffCredential, status_code=201)
def create_staff(body: StaffCreate, db: Db, session: Admin, response: Response):
    staff = User(
        login_id=body.login_id,
        display_name=body.display_name,
        created_by=session.user_id,
        role=UserRole.staff,
    )
    password = issue_password(staff, body.password)
    db.add(staff)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        if isinstance(exc.orig, UniqueViolation):
            raise HTTPException(409, "That login ID already exists.") from exc
        raise
    log_operation(
        db, "staff.create", user_id=session.user_id,
        info={"staff_id": staff.id, "generated_password": body.password is None},
    )
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return StaffCredential(staff=StaffOut.model_validate(staff), password=password)


def _staff_for_update(db: DbSession, user_id: int) -> User:
    query = select(User).where(User.id == user_id, User.role.in_(_MANAGED_ROLES)).with_for_update()
    staff = db.scalar(query)
    if staff is None:
        raise HTTPException(404, "Staff account not found.")
    return staff


def _check_can_deactivate(db: DbSession, target: User, session: SessionData) -> None:
    if target.id == session.user_id:
        raise HTTPException(409, "You cannot deactivate your own account.")
    if target.role != UserRole.admin or not target.is_active:
        return
    # Lock every active admin so two admins can't deactivate each other at once.
    active_admins = db.scalars(
        select(User.id).where(User.role == UserRole.admin, User.is_active).with_for_update()
    ).all()
    if len(active_admins) <= 1:
        raise HTTPException(409, "The last active admin cannot be deactivated.")


@router.patch("/{user_id}", response_model=StaffOut)
def edit_staff(user_id: int, body: StaffPatch, db: Db, session: Admin):
    if body.display_name is None and body.is_active is None:
        raise HTTPException(422, "Enter a display name or an active status.")
    staff = _staff_for_update(db, user_id)
    if body.is_active is False:
        _check_can_deactivate(db, staff, session)
    if body.display_name is not None:
        staff.display_name = body.display_name
    if body.is_active is not None:
        staff.is_active = body.is_active
    log_operation(
        db, "staff.edit", user_id=session.user_id,
        info={"staff_id": user_id, **body.model_dump(exclude_none=True)},
    )
    if body.is_active is False:
        revoke_user_sessions(db, user_id)
    else:
        db.commit()
        invalidate_user_sessions(db, user_id)
    return staff


@router.post("/{user_id}/reset-password", response_model=StaffCredential)
def reset_password(user_id: int, db: Db, session: Admin, response: Response):
    if user_id == session.user_id:
        # Resetting would sign the admin out; change password keeps this session.
        raise HTTPException(409, "Use change password for your own account.")
    staff = _staff_for_update(db, user_id)
    password = issue_password(staff)
    log_operation(db, "staff.reset_password", user_id=session.user_id, info={"staff_id": user_id})
    revoke_user_sessions(db, user_id)
    response.headers["Cache-Control"] = "no-store"
    return StaffCredential(staff=StaffOut.model_validate(staff), password=password)
