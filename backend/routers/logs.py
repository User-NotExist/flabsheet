"""Read the operation log (admin only). Nothing here writes: rows come from
``services/operation_log.py``.

The log grows with every login, so it is never sent whole: the list is paged
and filtered in SQL, newest first.

    GET /admin/logs?page=2&page_size=50
    GET /admin/logs?type=auth.login_failed&user=krit
    GET /admin/logs?from=2026-11-01T00:00:00%2B07:00&to=2026-11-02T00:00:00%2B07:00
    GET /admin/logs/types            -> ["auth.login", "staff.create", ...]

``from`` is inclusive and ``to`` exclusive. Both carry a UTC offset: the
browser sends the edges of the chosen days in its own time zone, the one it
also shows the times in. Reading the log is not logged itself.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime, BaseModel
from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.orm import Session as DbSession

from db.models.operation_log import OperationLog
from db.models.user import User, UserRole
from db.postgres import get_database
from services.auth import require_role
from services.session import SessionData

router = APIRouter(prefix="/admin/logs", tags=["logs"])
Db = Annotated[DbSession, Depends(get_database)]
Admin = Annotated[SessionData, Depends(require_role(UserRole.admin))]

MAX_PAGE_SIZE = 100  # bound the rows (and the info text) one request can pull
MAX_FILTER_LENGTH = 100  # longer than any type or display name


class LogUser(BaseModel):
    id: int
    login_id: str
    display_name: str
    role: UserRole


class LogOut(BaseModel):
    id: int
    created_at: datetime
    type: str
    # As stored: JSON text for a dict, or a plain string
    info: Optional[str]
    # None for system events and for users deleted since
    user: Optional[LogUser]


class LogPage(BaseModel):
    items: list[LogOut]
    # Rows matching the filters, over all pages
    total: int


def _conditions(
    op_type: Optional[str],
    user: Optional[str],
    since: Optional[datetime],
    until: Optional[datetime],
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if op_type:
        conditions.append(OperationLog.type == op_type)
    if user:
        # autoescape: "%" and "_" in the search text match themselves
        conditions.append(
            or_(
                User.login_id.icontains(user, autoescape=True),
                User.display_name.icontains(user, autoescape=True),
            )
        )
    if since is not None:
        conditions.append(OperationLog.created_at >= since)
    if until is not None:
        conditions.append(OperationLog.created_at < until)
    return conditions


@router.get("", response_model=LogPage)
def list_logs(
    db: Db,
    session: Admin,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 25,
    op_type: Annotated[Optional[str], Query(alias="type", max_length=MAX_FILTER_LENGTH)] = None,
    user: Annotated[Optional[str], Query(max_length=MAX_FILTER_LENGTH)] = None,
    since: Annotated[Optional[AwareDatetime], Query(alias="from")] = None,
    until: Annotated[Optional[AwareDatetime], Query(alias="to")] = None,
):
    conditions = _conditions(op_type, user and user.strip(), since, until)
    # Outer join: rows without a user must still be listed
    joined = select(OperationLog.id).outerjoin(User, User.id == OperationLog.user_id).where(*conditions)
    total = db.scalar(select(func.count()).select_from(joined.subquery())) or 0

    query = (
        select(
            OperationLog.id,
            OperationLog.created_at,
            OperationLog.type,
            OperationLog.info,
            User.id.label("user_id"),
            User.login_id,
            User.display_name,
            User.role,
        )
        .outerjoin(User, User.id == OperationLog.user_id)
        .where(*conditions)
        # id breaks ties: rows of one transaction share a created_at
        .order_by(OperationLog.created_at.desc(), OperationLog.id.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [
        LogOut(
            id=row.id,
            created_at=row.created_at,
            type=row.type,
            info=row.info,
            user=None
            if row.user_id is None
            else LogUser(
                id=row.user_id,
                login_id=row.login_id,
                display_name=row.display_name,
                role=row.role,
            ),
        )
        for row in db.execute(query)
    ]
    return LogPage(items=items, total=total)


@router.get("/types", response_model=list[str])
def list_types(db: Db, session: Admin):
    # A scan of the whole table: fine at course scale, and it lists exactly the
    # types an admin can find, including ones no current code writes any more
    return db.scalars(select(OperationLog.type).distinct().order_by(OperationLog.type)).all()
