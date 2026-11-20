"""Clarifications: Q&A threads on problems and course announcements, in MongoDB.

One document per thread in ``clarifications``, with its replies embedded
(docs/data-and-storage.md, "MongoDB")::

    {_id: ObjectId,
     problem_id: 7 | None,            # problems.id; None = course-wide announcement
     author_id: 42,                   # users.id
     kind: "question" | "announcement",
     title: "…", body_md: "…",        # 1-200 / 1-5000 chars
     visibility: "public" | "private",    # private = author + staff only
     status: "open" | "answered" | "closed",
     pinned: False,
     replies: [{_id: ObjectId, author_id, role: "student" | "staff" | "admin",
                body_md, created_at, edited_at: None}],   # at most 100
     tags: [],                        # at most 5 free-form strings
     created_at, updated_at}

Who may do what (the backend enforces all of it; the UI only reads
``permissions()``):

- A student reads public threads and their own, and only on problems they can
  see now (enabled), like ``routers/solve.py``: anything else answers 404.
- A student's question is always created private. Only staff make a thread
  public, after reading it: a student could otherwise publish a solution to
  every other student.
- A student edits their own question while it is ``open`` with no staff reply,
  deletes it while it has no replies at all, replies to it unless ``closed``,
  edits their own replies and deletes them. All of that but deleting needs the
  thread to be private: once staff publish it, its student content is frozen,
  so what staff checked is what everyone reads (a follow-up is a new question).
- Staff and admins do all of that on any thread, and also post announcements,
  set the status, pin and change the visibility.

Every conditional write puts its condition in the update's filter, so a check
and its write cannot be split by a concurrent reply (see ``student_edit_filter``).
Each reply change touches one array element: ``$push`` to add, ``$set`` on
``replies.$`` to edit, ``$pull`` to delete.

    query = {"problem_id": problem.id, **read_filter(db, session)}
    found = find_visible(db, session, clarification_id)   # or 404
    perms = permissions(found, session)
"""

from __future__ import annotations

import logging
from typing import Any, Literal, Mapping

from bson import ObjectId
from fastapi import HTTPException, status
from pymongo.errors import PyMongoError
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from db.models.problem import Problem, ProblemStatus
from db.models.user import User, UserRole
from db.mongo import clarifications
from services.session import SessionData

logger = logging.getLogger(__name__)

Kind = Literal["question", "announcement"]
Visibility = Literal["public", "private"]
Status = Literal["open", "answered", "closed"]

MAX_TITLE_LENGTH = 200
MAX_BODY_LENGTH = 5000
MAX_REPLIES = 100  # keeps a thread document far below the 16 MiB BSON limit
MAX_TAGS = 5
MAX_TAG_LENGTH = 32

STAFF_ROLES = frozenset({UserRole.staff, UserRole.admin})
_STAFF_ROLE_VALUES = [role.value for role in STAFF_ROLES]


def is_staff(session: SessionData) -> bool:
    return session.role in STAFF_ROLES


def parse_id(value: str, what: str = "Clarification") -> ObjectId:
    """An ObjectId from a path segment; anything else is simply not found."""
    if not ObjectId.is_valid(value):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"{what} not found")
    return ObjectId(value)


def enabled_problem_ids(db: DbSession) -> list[int]:
    return list(db.scalars(select(Problem.id).where(Problem.status == ProblemStatus.enabled)))


def read_filter(db: DbSession, session: SessionData) -> dict[str, Any]:
    """Conditions a thread must meet for the caller to read it.

    Staff read everything. A student needs the thread to be public or their
    own, and its problem to be one they can open now (or none: course-wide).
    """
    if is_staff(session):
        return {}
    return {
        "$and": [
            {"$or": [{"visibility": "public"}, {"author_id": session.user_id}]},
            # None in $in matches course-wide threads
            {"problem_id": {"$in": [None, *enabled_problem_ids(db)]}},
        ]
    }


def find_visible(db: DbSession, session: SessionData, clarification_id: ObjectId) -> dict[str, Any]:
    """The thread if the caller may read it, else 404 (private threads of
    others look missing, like drafts on the solve page)."""
    found = clarifications().find_one({"_id": clarification_id, **read_filter(db, session)})
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Clarification not found")
    return found


def _has_staff_reply(doc: Mapping[str, Any]) -> bool:
    return any(reply.get("role") in _STAFF_ROLE_VALUES for reply in doc.get("replies") or [])


def permissions(doc: Mapping[str, Any], session: SessionData) -> dict[str, bool]:
    """What the caller may do with a thread they can read. Mirrors the write
    filters below; sent to the UI so it shows only the controls that work."""
    if is_staff(session):
        return {"edit": True, "delete": True, "reply": True, "moderate": True}
    own = doc.get("author_id") == session.user_id and doc.get("kind") == "question"
    # Writes that add or change student text need a private thread (see the top)
    writable = own and doc.get("visibility") == "private"
    replies = doc.get("replies") or []
    return {
        "edit": writable and doc.get("status") == "open" and not _has_staff_reply(doc),
        "delete": own and not replies,
        "reply": writable and doc.get("status") != "closed" and len(replies) < MAX_REPLIES,
        "moderate": False,
    }


def can_edit_reply(doc: Mapping[str, Any], reply: Mapping[str, Any], session: SessionData) -> bool:
    if is_staff(session):
        return True
    return reply.get("author_id") == session.user_id and doc.get("visibility") == "private"


def can_delete_reply(reply: Mapping[str, Any], session: SessionData) -> bool:
    # Removing text never publishes anything, so a public thread allows it
    return is_staff(session) or reply.get("author_id") == session.user_id


# --- write filters: the permission rules as MongoDB conditions --------------


def student_edit_filter(clarification_id: ObjectId, session: SessionData) -> dict[str, Any]:
    # $nin over an array field: no element has a staff role (an empty list matches)
    return {
        "_id": clarification_id,
        "author_id": session.user_id,
        "kind": "question",
        "visibility": "private",
        "status": "open",
        "replies.role": {"$nin": _STAFF_ROLE_VALUES},
    }


def student_delete_filter(clarification_id: ObjectId, session: SessionData) -> dict[str, Any]:
    return {"_id": clarification_id, "author_id": session.user_id, "replies": {"$size": 0}}


def reply_filter(clarification_id: ObjectId, session: SessionData) -> dict[str, Any]:
    """A thread that can take one more reply from the caller."""
    query: dict[str, Any] = {
        "_id": clarification_id,
        # The 101st element does not exist: the cap is checked by the same write
        f"replies.{MAX_REPLIES - 1}": {"$exists": False},
    }
    if not is_staff(session):
        query.update(
            author_id=session.user_id,
            kind="question",
            visibility="private",
            status={"$ne": "closed"},
        )
    return query


def reply_element_filter(
    clarification_id: ObjectId, reply_id: ObjectId, session: SessionData, *, edit: bool
) -> dict[str, Any]:
    """The thread holding a reply the caller may edit (``edit=True``) or delete.
    ``$elemMatch`` makes the positional ``replies.$`` point at that very reply."""
    element: dict[str, Any] = {"_id": reply_id}
    query: dict[str, Any] = {"_id": clarification_id, "replies": {"$elemMatch": element}}
    if not is_staff(session):
        element["author_id"] = session.user_id
        if edit:
            query["visibility"] = "private"
    return query


# --- reads across databases --------------------------------------------------


def users_by_id(db: DbSession, ids: set[int]) -> dict[int, User]:
    """Authors of threads and replies, in one query however many rows."""
    if not ids:
        return {}
    return {user.id: user for user in db.scalars(select(User).where(User.id.in_(ids)))}


def problems_by_id(db: DbSession, ids: set[int]) -> dict[int, Problem]:
    if not ids:
        return {}
    return {problem.id: problem for problem in db.scalars(select(Problem).where(Problem.id.in_(ids)))}


def delete_for_problem(problem_id: int) -> None:
    """Drop a deleted problem's threads. Call after the commit; best effort:
    students never see a leftover (its problem is not enabled), staff see it
    in the queue without a problem and can delete it there."""
    try:
        clarifications().delete_many({"problem_id": problem_id})
    except PyMongoError:
        logger.warning("could not delete clarifications of problem %s", problem_id, exc_info=True)
