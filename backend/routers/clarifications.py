"""Clarifications: Q&A threads on problems and course announcements (MongoDB).

    GET    /problems/{slug}/clarifications          threads on a problem, pinned first
    POST   /problems/{slug}/clarifications          ask (student, staff) or announce (staff)
    GET    /clarifications                          staff: the queue, paged and filtered;
                                                    students: their own questions
    POST   /clarifications                          staff: a course-wide announcement
    GET    /clarifications/announcements            course-wide announcements, pinned first
    GET    /clarifications/{id}                     one thread with its replies
    PATCH  /clarifications/{id}                     title, body, tags; staff also status, pin, visibility
    DELETE /clarifications/{id}
    POST   /clarifications/{id}/replies
    PATCH  /clarifications/{id}/replies/{reply_id}
    DELETE /clarifications/{id}/replies/{reply_id}

The rules for who may do what are in ``services/clarifications.py``; every
response carries ``permissions`` (and ``can_edit``/``can_delete`` per reply)
computed from the same rules, so the UI never has to repeat them.

Side effects across databases: an announcement notifies every active student
(Postgres) in one ``insert_many``; a staff reply notifies the thread's author
and marks the question answered. Notifications are best effort
(``services/notifications.py``).

No route here writes to Postgres, so the operation log is written with
``log_operation_now`` once the MongoDB write has succeeded: ``log_operation``
waits for a Postgres commit that never comes.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Optional

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import AfterValidator, BaseModel, Field, StringConstraints
from pymongo import DESCENDING, ReturnDocument
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from db.models.problem import Problem, ProblemStatus
from db.models.user import User, UserRole
from db.mongo import clarifications
from db.postgres import get_database
from routers.solve import get_solvable_problem
from services import clarifications as rules
from services.auth import CurrentSession, require_role
from services.clarifications import Kind, Status, Visibility
from services.errors import ApiError
from services.notifications import active_student_ids, notify
from services.operation_log import log_operation_now
from services.rate_limit import question_retry_after, reply_retry_after
from services.session import SessionData

router = APIRouter(prefix="/clarifications", tags=["clarifications"])
problem_router = APIRouter(prefix="/problems", tags=["clarifications"])

Db = Annotated[DbSession, Depends(get_database)]
Staff = Annotated[SessionData, Depends(require_role(UserRole.staff, UserRole.admin))]

MAX_PAGE_SIZE = 100
# A problem's tab and the dashboard load their threads whole; this bounds a
# pathological course without paging the common case
MAX_LISTED = 200

Title = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=rules.MAX_TITLE_LENGTH)
]
Body = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=rules.MAX_BODY_LENGTH)
]
Tag = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=rules.MAX_TAG_LENGTH)
]


def _unique(tags: list[str]) -> list[str]:
    return list(dict.fromkeys(tags))  # first occurrence wins, order kept


Tags = Annotated[list[Tag], Field(max_length=rules.MAX_TAGS), AfterValidator(_unique)]


# --- models -----------------------------------------------------------------


class AuthorOut(BaseModel):
    display_name: str
    # The author's current role; None for a user that no longer exists
    role: Optional[UserRole]
    is_me: bool
    # Staff and admin viewers only: students never get other students' ids
    login_id: Optional[str]


class ProblemRef(BaseModel):
    id: int
    slug: str
    title: str


class Permissions(BaseModel):
    edit: bool
    delete: bool
    reply: bool
    # Status, pin and visibility
    moderate: bool


class ReplyOut(BaseModel):
    id: str  # MongoDB ObjectId
    author: AuthorOut
    # The author's role when they replied: what "staff answered" is based on
    role: UserRole
    body_md: str
    created_at: datetime
    edited_at: Optional[datetime]
    can_edit: bool
    can_delete: bool


class ClarificationListItem(BaseModel):
    id: str  # MongoDB ObjectId
    # None for a course-wide announcement, or a problem deleted since
    problem: Optional[ProblemRef]
    author: AuthorOut
    kind: Kind
    title: str
    body_md: str
    visibility: Visibility
    status: Status
    pinned: bool
    tags: list[str]
    reply_count: int
    created_at: datetime
    updated_at: datetime


class ClarificationOut(ClarificationListItem):
    replies: list[ReplyOut]
    permissions: Permissions


class ClarificationPage(BaseModel):
    items: list[ClarificationListItem]
    total: int


class ClarificationCreate(BaseModel):
    kind: Kind = "question"
    title: Title
    body_md: Body
    # Questions start private: the author and staff only. Only staff may send
    # "public"; announcements are always public.
    visibility: Visibility = "private"
    tags: Tags = Field(default_factory=list)


class AnnouncementCreate(BaseModel):
    title: Title
    body_md: Body
    tags: Tags = Field(default_factory=list)


class ClarificationPatch(BaseModel):
    title: Optional[Title] = None
    body_md: Optional[Body] = None
    tags: Optional[Tags] = None
    # Staff and admin only
    status: Optional[Status] = None
    pinned: Optional[bool] = None
    visibility: Optional[Visibility] = None


class ReplyIn(BaseModel):
    body_md: Body


# --- shaping ------------------------------------------------------------------


class _Shaper:
    """Turns documents into responses with one Postgres query for all the
    authors and one for all the problems, however many documents."""

    def __init__(self, db: DbSession, session: SessionData, docs: list[dict[str, Any]]):
        self.session = session
        self.staff = rules.is_staff(session)
        author_ids = {doc["author_id"] for doc in docs}
        for doc in docs:
            author_ids.update(reply["author_id"] for reply in doc.get("replies") or [])
        self.users = rules.users_by_id(db, author_ids)
        problem_ids = {doc["problem_id"] for doc in docs if doc.get("problem_id") is not None}
        self.problems = rules.problems_by_id(db, problem_ids)

    def author(self, user_id: int) -> AuthorOut:
        user: Optional[User] = self.users.get(user_id)
        return AuthorOut(
            display_name=user.display_name if user else "Unknown user",
            role=user.role if user else None,
            is_me=user_id == self.session.user_id,
            login_id=user.login_id if user and self.staff else None,
        )

    def problem(self, problem_id: Optional[int]) -> Optional[ProblemRef]:
        found = self.problems.get(problem_id) if problem_id is not None else None
        if found is None:
            return None
        return ProblemRef(id=found.id, slug=found.slug, title=found.title)

    def item(self, doc: dict[str, Any]) -> ClarificationListItem:
        return ClarificationListItem(**self._fields(doc))

    def full(self, doc: dict[str, Any]) -> ClarificationOut:
        return ClarificationOut(
            **self._fields(doc),
            replies=[
                ReplyOut(
                    id=str(reply["_id"]),
                    author=self.author(reply["author_id"]),
                    role=reply["role"],
                    body_md=reply["body_md"],
                    created_at=reply["created_at"],
                    edited_at=reply.get("edited_at"),
                    can_edit=rules.can_edit_reply(doc, reply, self.session),
                    can_delete=rules.can_delete_reply(reply, self.session),
                )
                for reply in doc.get("replies") or []
            ],
            permissions=Permissions(**rules.permissions(doc, self.session)),
        )

    def _fields(self, doc: dict[str, Any]) -> dict[str, Any]:
        replies = doc.get("replies")
        return {
            "id": str(doc["_id"]),
            "problem": self.problem(doc.get("problem_id")),
            "author": self.author(doc["author_id"]),
            "kind": doc["kind"],
            "title": doc["title"],
            "body_md": doc["body_md"],
            "visibility": doc["visibility"],
            "status": doc["status"],
            "pinned": doc.get("pinned", False),
            "tags": doc.get("tags") or [],
            # List queries project the count instead of shipping every reply
            "reply_count": doc["reply_count"] if "reply_count" in doc else len(replies or []),
            "created_at": doc["created_at"],
            "updated_at": doc["updated_at"],
        }


# Everything but the replies, plus their count, for list responses
_LIST_PROJECTION = {
    "problem_id": 1, "author_id": 1, "kind": 1, "title": 1, "body_md": 1, "visibility": 1,
    "status": 1, "pinned": 1, "tags": 1, "created_at": 1, "updated_at": 1,
    "reply_count": {"$size": {"$ifNull": ["$replies", []]}},
}  # fmt: skip


def _list(
    query: dict[str, Any], sort: list[tuple[str, int]], skip: int = 0, limit: int = MAX_LISTED
) -> list[dict[str, Any]]:
    return list(
        clarifications().aggregate(
            [
                {"$match": query},
                {"$sort": dict(sort)},
                {"$skip": skip},
                {"$limit": limit},
                {"$project": _LIST_PROJECTION},
            ]
        )
    )


_PINNED_FIRST = [("pinned", DESCENDING), ("updated_at", DESCENDING), ("_id", DESCENDING)]


def _rate_limited(retry_after: int, what: str) -> ApiError:
    return ApiError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        f"You are posting {what} too fast. Try again in {retry_after} s.",
        code="rate_limited",
        headers={"Retry-After": str(retry_after)},
    )


_PUBLIC_FROZEN = (
    "Staff made this question public, so it can no longer change. Ask a new question to follow up."
)


def _cannot(doc: dict[str, Any], session: SessionData, action: str) -> HTTPException:
    """Why a student may not edit or delete a thread they can read: 403 when it
    is not theirs, 409 when it is but its state no longer allows it."""
    if doc["author_id"] != session.user_id or doc["kind"] != "question":
        return HTTPException(status.HTTP_403_FORBIDDEN, f"You can only {action} your own questions")
    if action == "edit" and doc["visibility"] == "public":
        return HTTPException(status.HTTP_409_CONFLICT, _PUBLIC_FROZEN)
    if action == "delete":
        return HTTPException(
            status.HTTP_409_CONFLICT, "A question with replies can no longer be deleted."
        )
    return HTTPException(
        status.HTTP_409_CONFLICT,
        "This question can no longer be edited: staff have replied or it is no longer open.",
    )


def _new_thread(
    session: SessionData,
    *,
    problem_id: Optional[int],
    kind: Kind,
    title: str,
    body_md: str,
    visibility: Visibility,
    tags: list[str],
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    doc: dict[str, Any] = {
        "problem_id": problem_id,
        "author_id": session.user_id,
        "kind": kind,
        "title": title,
        "body_md": body_md,
        "visibility": visibility,
        # An announcement takes no student replies and is not waiting for an
        # answer, so it starts outside the open queue
        "status": "closed" if kind == "announcement" else "open",
        "pinned": False,
        "replies": [],
        "tags": tags,
        "created_at": now,
        "updated_at": now,
    }
    doc["_id"] = clarifications().insert_one(doc).inserted_id
    return doc


def _announce(db: DbSession, doc: dict[str, Any], problem: Optional[Problem]) -> int:
    """Notify the students who can read a new announcement. Best effort."""
    if problem is not None and problem.status is not ProblemStatus.enabled:
        return 0  # students cannot open the problem, so there is nothing to link to
    link = f"/problems/{problem.slug}#clarifications" if problem else "/#announcements"
    data: dict[str, Any] = {"clarification_id": str(doc["_id"])}
    if problem is not None:
        data["problem_id"] = problem.id
    return notify(
        active_student_ids(db), "announcement", doc["title"], body=doc["body_md"], link=link, data=data
    )


# --- problem threads ------------------------------------------------------------


@problem_router.get("/{slug}/clarifications", response_model=list[ClarificationListItem])
def list_problem_clarifications(slug: str, session: CurrentSession, db: Db):
    """Threads on one problem the caller may read, pinned first, then most recently active."""
    problem = get_solvable_problem(db, session, slug)
    query = {"problem_id": problem.id, **rules.read_filter(db, session)}
    docs = _list(query, _PINNED_FIRST)
    shaper = _Shaper(db, session, docs)
    return [shaper.item(doc) for doc in docs]


@problem_router.post(
    "/{slug}/clarifications", response_model=ClarificationOut, status_code=status.HTTP_201_CREATED
)
def create_problem_clarification(
    slug: str, body: ClarificationCreate, session: CurrentSession, db: Db
):
    """Ask a question about a problem, or (staff) post an announcement on it."""
    problem = get_solvable_problem(db, session, slug)
    if body.kind == "announcement" and not rules.is_staff(session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only staff can post announcements")
    if body.visibility == "public" and not rules.is_staff(session):
        # Staff read a question before every student can (services/clarifications.py)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only staff can make a question public")
    retry_after = question_retry_after(session.user_id)
    if retry_after:
        raise _rate_limited(retry_after, "questions")

    announcement = body.kind == "announcement"
    doc = _new_thread(
        session,
        problem_id=problem.id,
        kind=body.kind,
        title=body.title,
        body_md=body.body_md,
        visibility="public" if announcement else body.visibility,
        tags=body.tags,
    )
    info: dict[str, Any] = {"clarification_id": str(doc["_id"]), "problem_id": problem.id, "kind": body.kind}
    if announcement:
        info["notified"] = _announce(db, doc, problem)
    log_operation_now(
        "clarification.announce" if announcement else "clarification.create",
        user_id=session.user_id,
        info=info,
    )
    return _Shaper(db, session, [doc]).full(doc)


# --- lists across problems ---------------------------------------------------------


@router.get("", response_model=ClarificationPage)
def list_clarifications(
    session: CurrentSession,
    db: Db,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 25,
    thread_status: Annotated[Optional[Status], Query(alias="status")] = None,
    problem: Annotated[Optional[str], Query(max_length=64)] = None,
    kind: Optional[Kind] = None,
):
    """Staff: every thread, most recently active first (the queue). Students:
    their own questions, newest first; the filters apply to both."""
    conditions: list[dict[str, Any]] = []
    if rules.is_staff(session):
        sort = [("updated_at", DESCENDING), ("_id", DESCENDING)]
    else:
        conditions += rules.read_filter(db, session)["$and"]
        conditions.append({"author_id": session.user_id})
        sort = [("created_at", DESCENDING), ("_id", DESCENDING)]
    if thread_status:
        conditions.append({"status": thread_status})
    if kind:
        conditions.append({"kind": kind})
    if problem:
        # An unknown slug matches nothing rather than everything
        problem_id = db.scalar(select(Problem.id).where(Problem.slug == problem.strip()))
        conditions.append({"problem_id": problem_id if problem_id is not None else -1})
    query: dict[str, Any] = {"$and": conditions} if conditions else {}

    total = clarifications().count_documents(query)
    docs = _list(query, sort, skip=(page - 1) * page_size, limit=page_size)
    shaper = _Shaper(db, session, docs)
    return ClarificationPage(items=[shaper.item(doc) for doc in docs], total=total)


@router.post("", response_model=ClarificationOut, status_code=status.HTTP_201_CREATED)
def create_announcement(body: AnnouncementCreate, session: Staff, db: Db):
    """A course-wide announcement (no problem), sent to every active student."""
    retry_after = question_retry_after(session.user_id)
    if retry_after:
        raise _rate_limited(retry_after, "announcements")
    doc = _new_thread(
        session,
        problem_id=None,
        kind="announcement",
        title=body.title,
        body_md=body.body_md,
        visibility="public",
        tags=body.tags,
    )
    notified = _announce(db, doc, None)
    log_operation_now(
        "clarification.announce",
        user_id=session.user_id,
        info={"clarification_id": str(doc["_id"]), "problem_id": None, "notified": notified},
    )
    return _Shaper(db, session, [doc]).full(doc)


@router.get("/announcements", response_model=list[ClarificationListItem])
def list_announcements(session: CurrentSession, db: Db):
    """Course-wide announcements, pinned first, for the dashboard."""
    docs = _list({"problem_id": None, "kind": "announcement"}, _PINNED_FIRST)
    shaper = _Shaper(db, session, docs)
    return [shaper.item(doc) for doc in docs]


# --- one thread ---------------------------------------------------------------------


@router.get("/{clarification_id}", response_model=ClarificationOut)
def get_clarification(clarification_id: str, session: CurrentSession, db: Db):
    doc = rules.find_visible(db, session, rules.parse_id(clarification_id))
    return _Shaper(db, session, [doc]).full(doc)


@router.patch("/{clarification_id}", response_model=ClarificationOut)
def update_clarification(
    clarification_id: str, body: ClarificationPatch, session: CurrentSession, db: Db
):
    """Students change their own question's title, body and tags while it is
    open with no staff reply; staff change anything on any thread."""
    oid = rules.parse_id(clarification_id)
    current = rules.find_visible(db, session, oid)
    changes = body.model_dump(exclude_none=True)
    moderation = {"status", "pinned", "visibility"} & changes.keys()
    if moderation and not rules.is_staff(session):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Only staff can change the status, pin or visibility"
        )
    # Only what actually changes is written and logged
    changes = {key: value for key, value in changes.items() if current.get(key) != value}
    if not changes:
        return _Shaper(db, session, [current]).full(current)
    if not rules.is_staff(session) and not rules.permissions(current, session)["edit"]:
        raise _cannot(current, session, "edit")
    if changes.get("visibility") == "private" and current["kind"] == "announcement":
        raise HTTPException(status.HTTP_409_CONFLICT, "Announcements are always public")

    query = {"_id": oid} if rules.is_staff(session) else rules.student_edit_filter(oid, session)
    updated = clarifications().find_one_and_update(
        query,
        {"$set": {**changes, "updated_at": datetime.now(timezone.utc)}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        # Deleted meanwhile, or (student) a staff reply or status change got in first
        if rules.is_staff(session):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Clarification not found")
        raise _cannot(current, session, "edit")
    log_operation_now(
        "clarification.update",
        user_id=session.user_id,
        info={"clarification_id": clarification_id, "fields": sorted(changes)},
    )
    return _Shaper(db, session, [updated]).full(updated)


@router.delete("/{clarification_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_clarification(clarification_id: str, session: CurrentSession, db: Db):
    """Students delete their own question while nobody has replied; staff delete any thread."""
    oid = rules.parse_id(clarification_id)
    current = rules.find_visible(db, session, oid)
    if not rules.is_staff(session) and not rules.permissions(current, session)["delete"]:
        raise _cannot(current, session, "delete")
    query = {"_id": oid} if rules.is_staff(session) else rules.student_delete_filter(oid, session)
    if clarifications().delete_one(query).deleted_count == 0:
        # Deleted meanwhile, or (student) a reply arrived after the read
        if rules.is_staff(session):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Clarification not found")
        raise _cannot(current, session, "delete")
    log_operation_now(
        "clarification.delete",
        user_id=session.user_id,
        info={
            "clarification_id": clarification_id,
            "problem_id": current.get("problem_id"),
            "kind": current["kind"],
            "title": current["title"],
            "author_id": current["author_id"],
        },
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- replies --------------------------------------------------------------------------


@router.post(
    "/{clarification_id}/replies", response_model=ClarificationOut, status_code=status.HTTP_201_CREATED
)
def create_reply(clarification_id: str, body: ReplyIn, session: CurrentSession, db: Db):
    """Reply to a thread. A staff reply answers a question and notifies its author;
    the author's follow-up on an answered question opens it again for staff."""
    oid = rules.parse_id(clarification_id)
    current = rules.find_visible(db, session, oid)
    staff = rules.is_staff(session)
    if len(current.get("replies") or []) >= rules.MAX_REPLIES:
        raise HTTPException(status.HTTP_409_CONFLICT, "This thread has reached its reply limit.")
    if not rules.permissions(current, session)["reply"]:
        if current["author_id"] == session.user_id and current["kind"] == "question":
            if current["visibility"] == "public":
                raise HTTPException(status.HTTP_409_CONFLICT, _PUBLIC_FROZEN)
            raise HTTPException(status.HTTP_409_CONFLICT, "This question is closed.")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only reply to your own questions")
    retry_after = reply_retry_after(session.user_id)
    if retry_after:
        raise _rate_limited(retry_after, "replies")

    now = datetime.now(timezone.utc)
    reply = {
        "_id": ObjectId(),
        "author_id": session.user_id,
        "role": session.role.value,
        "body_md": body.body_md,
        "created_at": now,
        "edited_at": None,
    }
    update: dict[str, Any] = {"$push": {"replies": reply}, "$set": {"updated_at": now}}
    question = current["kind"] == "question"
    if question and staff:
        update["$set"]["status"] = "answered"
    elif question and current["status"] == "answered":
        update["$set"]["status"] = "open"
    updated = clarifications().find_one_and_update(
        rules.reply_filter(oid, session), update, return_document=ReturnDocument.AFTER
    )
    if updated is None:
        # The thread changed between the read and the write (closed, made public,
        # full or deleted)
        raise HTTPException(status.HTTP_409_CONFLICT, "This thread can no longer take replies.")

    notified = 0
    if question and staff and current["author_id"] != session.user_id:
        problem = rules.problems_by_id(db, {current["problem_id"]}).get(current["problem_id"])
        notified = notify(
            [current["author_id"]],
            "clarification.answered",
            f"Staff replied: {current['title']}",
            body=body.body_md,
            link=f"/problems/{problem.slug}#clarifications" if problem else None,
            data={"clarification_id": clarification_id, "problem_id": current["problem_id"]},
        )
    log_operation_now(
        "clarification.reply",
        user_id=session.user_id,
        info={"clarification_id": clarification_id, "reply_id": str(reply["_id"]), "notified": notified},
    )
    return _Shaper(db, session, [updated]).full(updated)


@router.patch("/{clarification_id}/replies/{reply_id}", response_model=ClarificationOut)
def update_reply(
    clarification_id: str, reply_id: str, body: ReplyIn, session: CurrentSession, db: Db
):
    """Edit one reply: your own on a private thread, or any as staff. Only that
    array element changes."""
    oid = rules.parse_id(clarification_id)
    rid = rules.parse_id(reply_id, "Reply")
    current = rules.find_visible(db, session, oid)
    now = datetime.now(timezone.utc)
    updated = clarifications().find_one_and_update(
        rules.reply_element_filter(oid, rid, session, edit=True),
        {"$set": {"replies.$.body_md": body.body_md, "replies.$.edited_at": now, "updated_at": now}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        own = any(
            reply["_id"] == rid and reply["author_id"] == session.user_id
            for reply in current.get("replies") or []
        )
        if own and current["visibility"] == "public" and not rules.is_staff(session):
            raise HTTPException(status.HTTP_409_CONFLICT, _PUBLIC_FROZEN)
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reply not found")
    log_operation_now(
        "clarification.reply_update",
        user_id=session.user_id,
        info={"clarification_id": clarification_id, "reply_id": reply_id},
    )
    return _Shaper(db, session, [updated]).full(updated)


@router.delete("/{clarification_id}/replies/{reply_id}", response_model=ClarificationOut)
def delete_reply(clarification_id: str, reply_id: str, session: CurrentSession, db: Db):
    """Delete one reply (``$pull``): your own, or any as staff. The status is left
    as it is; staff set it by hand if the deleted reply was the answer."""
    oid = rules.parse_id(clarification_id)
    rid = rules.parse_id(reply_id, "Reply")
    rules.find_visible(db, session, oid)
    updated = clarifications().find_one_and_update(
        rules.reply_element_filter(oid, rid, session, edit=False),
        {"$pull": {"replies": {"_id": rid}}, "$set": {"updated_at": datetime.now(timezone.utc)}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Reply not found")
    log_operation_now(
        "clarification.reply_delete",
        user_id=session.user_id,
        info={"clarification_id": clarification_id, "reply_id": reply_id},
    )
    return _Shaper(db, session, [updated]).full(updated)
