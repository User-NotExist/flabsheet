"""Notifications: per-user messages in the MongoDB ``notifications`` collection.

One document per notification per user (docs/data-and-storage.md, "MongoDB")::

    {_id: ObjectId, user_id: 42,
     type: "clarification.answered" | "clarification.new" | "announcement" | "manual",
     title: "…", body: "…" | None, link: "/problems/two-sum#clarifications" | None,
     data: {...},            # differs by type, e.g. {clarification_id, problem_id}
     is_read: False, created_at: datetime}

A TTL index (``db/mongo.py``) removes documents 90 days after ``created_at``.

Writing is best effort, like ``services/operation_log.py``: a notification is
a side effect of a reply or an announcement that has already been stored, so
a MongoDB failure is logged as a warning and never fails that request.

    from services.notifications import active_student_ids, notify

    notify([author_id], "clarification.answered", "Your question was answered",
           link=f"/problems/{slug}#clarifications", data={"clarification_id": str(_id)})
    notify(active_student_ids(db), "announcement", title, body=body)   # one insert_many
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from pymongo.errors import PyMongoError
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from db.models.user import User, UserRole
from db.mongo import notifications

logger = logging.getLogger(__name__)

NotificationType = Literal["clarification.answered", "clarification.new", "announcement", "manual"]

MAX_TITLE_LENGTH = 200  # same bound as a clarification title
MAX_BODY_LENGTH = 1000  # a notification is a pointer; the full text lives at its link
MAX_LINK_LENGTH = 300
# A path on this site, never another site ("//host" is protocol-relative)
LINK_PATTERN = r"^/(?!/)[^\s\\]*$"


def active_student_ids(db: DbSession) -> list[int]:
    """Every active student, the audience of an announcement."""
    return list(
        db.scalars(
            select(User.id).where(User.role == UserRole.student, User.is_active.is_(True))
        )
    )


def notify(
    user_ids: Iterable[int],
    kind: NotificationType,
    title: str,
    *,
    body: Optional[str] = None,
    link: Optional[str] = None,
    data: Optional[Mapping[str, Any]] = None,
) -> int:
    """Insert one notification per user in a single ``insert_many``.

    Returns how many were written; 0 when there was nobody to notify or
    MongoDB failed (logged, never raised).
    """
    ids = sorted(set(user_ids))
    if not ids:
        return 0
    now = datetime.now(timezone.utc)
    documents = [
        {
            "user_id": user_id,
            "type": kind,
            "title": title[:MAX_TITLE_LENGTH],
            "body": body[:MAX_BODY_LENGTH] if body else None,
            "link": link,
            "data": dict(data or {}),
            "is_read": False,
            "created_at": now,
        }
        for user_id in ids
    ]
    try:
        notifications().insert_many(documents, ordered=False)
    except PyMongoError:
        logger.warning("could not write %d %s notifications", len(documents), kind, exc_info=True)
        return 0
    return len(documents)


def delete_for_problem(problem_id: int) -> None:
    """Drop notifications that link to a deleted problem. Call after the
    commit; best effort, the TTL index removes any leftover within 90 days."""
    try:
        notifications().delete_many({"data.problem_id": problem_id})
    except PyMongoError:
        logger.warning("could not delete notifications of problem %s", problem_id, exc_info=True)
