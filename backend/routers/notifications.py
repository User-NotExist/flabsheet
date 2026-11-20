"""Notifications (MongoDB): every user reads and changes only their own.

    GET    /notifications?page=&page_size=    own, newest first, with unread_count
    GET    /notifications/unread-count        for the bell in the top bar
    PATCH  /notifications/{id}                {is_read}
    POST   /notifications/read-all
    DELETE /notifications/{id}                dismiss one
    DELETE /notifications?read=true           clear every read one
    POST   /admin/notifications               staff: send a "manual" one to a student or to all

Every query carries ``user_id: <caller>``, so another user's notification id
answers 404 exactly like a missing one. Notifications are written elsewhere
too: replies and announcements (``routers/clarifications.py``) through
``services/notifications.py``.

No route here writes to Postgres, so the operation log is written with
``log_operation_now`` after the MongoDB write.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, StringConstraints, model_validator
from pymongo import DESCENDING, ReturnDocument
from sqlalchemy.orm import Session as DbSession

from db.models.user import User, UserRole
from db.mongo import notifications
from db.postgres import get_database
from services import notifications as service
from services.auth import CurrentSession, require_role
from services.clarifications import parse_id
from services.operation_log import log_operation_now
from services.session import SessionData

router = APIRouter(prefix="/notifications", tags=["notifications"])
admin_router = APIRouter(prefix="/admin/notifications", tags=["notifications"])

Db = Annotated[DbSession, Depends(get_database)]
Staff = Annotated[SessionData, Depends(require_role(UserRole.staff, UserRole.admin))]

MAX_PAGE_SIZE = 100


class NotificationOut(BaseModel):
    id: str  # MongoDB ObjectId
    type: service.NotificationType
    title: str
    body: Optional[str]
    # A path on this site, or None
    link: Optional[str]
    data: dict[str, Any]
    is_read: bool
    created_at: datetime


class NotificationPage(BaseModel):
    items: list[NotificationOut]
    total: int
    unread_count: int


class UnreadCount(BaseModel):
    unread_count: int


class NotificationPatch(BaseModel):
    is_read: bool


class ChangedCount(BaseModel):
    # How many notifications the request changed or removed
    count: int


class ManualNotification(BaseModel):
    # One student, or every active student with all=true
    user_id: Optional[int] = None
    all: bool = False
    title: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=service.MAX_TITLE_LENGTH)
    ]
    body: Optional[
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=service.MAX_BODY_LENGTH)]
    ] = None
    link: Optional[
        Annotated[
            str,
            StringConstraints(
                strip_whitespace=True, max_length=service.MAX_LINK_LENGTH, pattern=service.LINK_PATTERN
            ),
        ]
    ] = None

    @model_validator(mode="after")
    def _one_target(self) -> "ManualNotification":
        if self.all == (self.user_id is not None):
            raise ValueError("Choose one student or all students")
        return self


class SentCount(BaseModel):
    sent: int


def _out(doc: dict[str, Any]) -> NotificationOut:
    return NotificationOut(
        id=str(doc["_id"]),
        type=doc["type"],
        title=doc["title"],
        body=doc.get("body"),
        link=doc.get("link"),
        data=doc.get("data") or {},
        is_read=doc.get("is_read", False),
        created_at=doc["created_at"],
    )


def _unread(user_id: int) -> int:
    return notifications().count_documents({"user_id": user_id, "is_read": False})


@router.get("", response_model=NotificationPage)
def list_notifications(
    session: CurrentSession,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 25,
):
    # Naming both is_read values lets MongoDB merge the two ranges of the
    # {user_id, is_read, created_at} index in created_at order instead of
    # sorting in memory
    query = {"user_id": session.user_id, "is_read": {"$in": [False, True]}}
    collection = notifications()
    total = collection.count_documents(query)
    documents = (
        collection.find(query)
        .sort([("created_at", DESCENDING), ("_id", DESCENDING)])
        .skip((page - 1) * page_size)
        .limit(page_size)
    )
    return NotificationPage(
        items=[_out(doc) for doc in documents], total=total, unread_count=_unread(session.user_id)
    )


@router.get("/unread-count", response_model=UnreadCount)
def unread_count(session: CurrentSession):
    return UnreadCount(unread_count=_unread(session.user_id))


@router.post("/read-all", response_model=ChangedCount)
def read_all(session: CurrentSession):
    result = notifications().update_many(
        {"user_id": session.user_id, "is_read": False}, {"$set": {"is_read": True}}
    )
    if result.modified_count:
        log_operation_now(
            "notification.read_all", user_id=session.user_id, info={"count": result.modified_count}
        )
    return ChangedCount(count=result.modified_count)


@router.delete("", response_model=ChangedCount)
def clear_read(session: CurrentSession, read: Annotated[bool, Query()]):
    """Remove every notification already read. ``read=true`` is required, so a
    bare ``DELETE /notifications`` cannot be mistaken for "delete everything"."""
    if not read:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Only read notifications can be cleared")
    result = notifications().delete_many({"user_id": session.user_id, "is_read": True})
    if result.deleted_count:
        log_operation_now(
            "notification.clear_read", user_id=session.user_id, info={"count": result.deleted_count}
        )
    return ChangedCount(count=result.deleted_count)


@router.patch("/{notification_id}", response_model=NotificationOut)
def update_notification(notification_id: str, body: NotificationPatch, session: CurrentSession):
    oid = parse_id(notification_id, "Notification")
    updated = notifications().find_one_and_update(
        {"_id": oid, "user_id": session.user_id},
        {"$set": {"is_read": body.is_read}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    log_operation_now(
        "notification.update",
        user_id=session.user_id,
        info={"notification_id": notification_id, "is_read": body.is_read},
    )
    return _out(updated)


@router.delete("/{notification_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_notification(notification_id: str, session: CurrentSession):
    oid = parse_id(notification_id, "Notification")
    if notifications().delete_one({"_id": oid, "user_id": session.user_id}).deleted_count == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Notification not found")
    log_operation_now(
        "notification.delete", user_id=session.user_id, info={"notification_id": notification_id}
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@admin_router.post("", response_model=SentCount, status_code=status.HTTP_201_CREATED)
def send_notification(body: ManualNotification, session: Staff, db: Db):
    """A message from staff to one active student or to every active student."""
    if body.all:
        user_ids = service.active_student_ids(db)
    else:
        student = db.get(User, body.user_id)
        if student is None or student.role is not UserRole.student or not student.is_active:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Student not found")
        user_ids = [student.id]
    sent = service.notify(
        user_ids,
        "manual",
        body.title,
        body=body.body or None,
        link=body.link or None,
        # The sender is in the operation log; students need no staff ids
        data={},
    )
    if user_ids and not sent:
        # Unlike a reply's side effect, sending is the whole request
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "The database is unavailable. Please try again."
        )
    log_operation_now(
        "notification.send",
        user_id=session.user_id,
        info={"target": "all" if body.all else body.user_id, "sent": sent, "title": body.title},
    )
    return SentCount(sent=sent)
