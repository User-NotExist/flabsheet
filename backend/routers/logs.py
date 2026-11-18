"""Read the operation log (admin only). Nothing here writes: entries come from
``services/operation_log.py`` and live in the MongoDB ``operation_logs``
collection.

The log grows with every login, so it is never sent whole: the list is paged
and filtered in MongoDB, newest first.

    GET /admin/logs?page=2&page_size=50
    GET /admin/logs?type=auth.login_failed&user=krit
    GET /admin/logs?from=2026-11-01T00:00:00%2B07:00&to=2026-11-02T00:00:00%2B07:00
    GET /admin/logs/types            -> ["auth.login", "staff.create", ...]

``from`` is inclusive and ``to`` exclusive. Both carry a UTC offset: the
browser sends the edges of the chosen days in its own time zone, the one it
also shows the times in. Reading the log is not logged itself.

Entries keep only ``user_id``; the user filter and the user shown next to each
entry are read from Postgres, so both use the user's current name.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime, BaseModel
from pymongo import DESCENDING
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from db.models.user import User, UserRole
from db.mongo import operation_logs
from db.postgres import get_database
from services.auth import require_role
from services.session import SessionData

router = APIRouter(prefix="/admin/logs", tags=["logs"])
Db = Annotated[DbSession, Depends(get_database)]
Admin = Annotated[SessionData, Depends(require_role(UserRole.admin))]

MAX_PAGE_SIZE = 100  # bound the entries (and the info text) one request can pull
MAX_FILTER_LENGTH = 100  # longer than any type or display name


class LogUser(BaseModel):
    id: int
    login_id: str
    display_name: str
    role: UserRole


class LogOut(BaseModel):
    id: str  # MongoDB ObjectId
    created_at: datetime
    type: str
    # JSON text for a dict, or a plain string as logged
    info: Optional[str]
    # None for system events and for users deleted since
    user: Optional[LogUser]


class LogPage(BaseModel):
    items: list[LogOut]
    # Entries matching the filters, over all pages
    total: int


def _filter(
    db: DbSession,
    op_type: Optional[str],
    user: Optional[str],
    since: Optional[datetime],
    until: Optional[datetime],
) -> dict[str, Any]:
    query: dict[str, Any] = {}
    if op_type:
        query["type"] = op_type
    if user:
        # autoescape: "%" and "_" in the search text match themselves. Entries
        # without a user never match a user search, as with the old outer join.
        ids = db.scalars(
            select(User.id).where(
                or_(
                    User.login_id.icontains(user, autoescape=True),
                    User.display_name.icontains(user, autoescape=True),
                )
            )
        ).all()
        query["user_id"] = {"$in": list(ids)}
    created: dict[str, datetime] = {}
    if since is not None:
        created["$gte"] = since
    if until is not None:
        created["$lt"] = until
    if created:
        query["created_at"] = created
    return query


def _info_text(info: Any) -> Optional[str]:
    if info is None or isinstance(info, str):
        return info
    return json.dumps(info, ensure_ascii=False)


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
    query = _filter(db, op_type, user and user.strip(), since, until)
    collection = operation_logs()
    total = collection.count_documents(query)
    documents = list(
        collection.find(query)
        # _id breaks ties: it grows with insert order, and entries of one
        # commit can share a created_at
        .sort([("created_at", DESCENDING), ("_id", DESCENDING)])
        .skip((page - 1) * page_size)
        .limit(page_size)
    )

    user_ids = {doc["user_id"] for doc in documents if doc.get("user_id") is not None}
    users = (
        {u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids)))}
        if user_ids
        else {}
    )

    def user_out(user_id: Optional[int]) -> Optional[LogUser]:
        found = users.get(user_id) if user_id is not None else None
        if found is None:
            return None
        return LogUser(
            id=found.id,
            login_id=found.login_id,
            display_name=found.display_name,
            role=found.role,
        )

    items = [
        LogOut(
            id=str(doc["_id"]),
            created_at=doc["created_at"],
            type=doc["type"],
            info=_info_text(doc.get("info")),
            user=user_out(doc.get("user_id")),
        )
        for doc in documents
    ]
    return LogPage(items=items, total=total)


@router.get("/types", response_model=list[str])
def list_types(session: Admin):
    # A scan of the whole collection: fine at course scale, and it lists exactly
    # the types an admin can find, including ones no current code writes any more
    return sorted(operation_logs().distinct("type"))
