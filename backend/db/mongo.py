"""MongoDB: the operation log, submission reports, clarifications and notifications.

PostgreSQL stays the system of record for everything relational. Data shaped
as one self-contained document per thing lives here instead
(docs/data-and-storage.md, "MongoDB"); documents refer to Postgres rows by id,
without foreign keys:

- ``operation_logs``: one document per audit event, written after the
  Postgres commit (``services/operation_log.py``).
- ``submission_reports``: one document per submission attempt, holding the
  per-test results and the compile log (``services/reports.py``).
- ``clarifications``: one document per Q&A thread or announcement, with its
  replies embedded (``services/clarifications.py``).
- ``notifications``: one document per notification per user, expired after
  90 days by a TTL index (``services/notifications.py``).

    from db.mongo import operation_logs
    operation_logs().insert_one({...})

Every write is atomic on its own document (a fan-out ``insert_many`` is many
independent inserts), so a standalone server is enough and no multi-document
transaction is used anywhere.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pymongo import ASCENDING, DESCENDING, IndexModel, MongoClient
from pymongo.collection import Collection
from pymongo.database import Database

from config import settings

logger = logging.getLogger(__name__)

OPERATION_LOGS = "operation_logs"
SUBMISSION_REPORTS = "submission_reports"
CLARIFICATIONS = "clarifications"
NOTIFICATIONS = "notifications"

# Notifications are a reminder, not a record: old ones expire on their own
NOTIFICATION_TTL_SECONDS = 90 * 24 * 3600

# Sync client to match the sync SQLAlchemy stack; pymongo pools connections
# and is safe to share across FastAPI's worker threads. Short timeouts so a
# down server fails a request quickly instead of hanging it for 30 s.
# tz_aware: datetimes come back with UTC tzinfo, like timestamptz columns.
mongo_client: MongoClient[dict[str, Any]] = MongoClient(
    settings.mongo_url,
    tz_aware=True,
    serverSelectionTimeoutMS=2000,
    connectTimeoutMS=2000,
    socketTimeoutMS=5000,
)


def get_mongo() -> Database[dict[str, Any]]:
    return mongo_client[settings.mongo_db]


def operation_logs() -> Collection[dict[str, Any]]:
    return get_mongo()[OPERATION_LOGS]


def submission_reports() -> Collection[dict[str, Any]]:
    return get_mongo()[SUBMISSION_REPORTS]


def clarifications() -> Collection[dict[str, Any]]:
    return get_mongo()[CLARIFICATIONS]


def notifications() -> Collection[dict[str, Any]]:
    return get_mongo()[NOTIFICATIONS]


def mongo_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Turn an unhandled ``PyMongoError`` into a 503. On /internal/* that makes
    the judge retry the event instead of dropping it."""
    logger.error("mongo error on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse(
        {"detail": "The database is unavailable. Please try again."},
        status_code=503,
    )


# Each index serves a named screen or job, like the Postgres ones
_INDEXES: dict[str, list[IndexModel]] = {
    OPERATION_LOGS: [
        # /admin/logs: newest first; _id breaks ties between equal times
        IndexModel([("created_at", DESCENDING), ("_id", DESCENDING)], name="created_at"),
        IndexModel([("type", ASCENDING), ("created_at", DESCENDING)], name="type_created_at"),
        IndexModel([("user_id", ASCENDING), ("created_at", DESCENDING)], name="user_created_at"),
        # cli.py migrate-to-mongo upserts on the old Postgres id, so it can run twice
        IndexModel(
            [("legacy_id", ASCENDING)],
            name="legacy_id",
            unique=True,
            partialFilterExpression={"legacy_id": {"$exists": True}},
        ),
    ],
    SUBMISSION_REPORTS: [
        IndexModel([("submission_id", ASCENDING), ("attempt", DESCENDING)], name="submission_attempt"),
        # Deleting a problem removes its submissions' reports
        IndexModel([("problem_id", ASCENDING)], name="problem"),
    ],
    CLARIFICATIONS: [
        # Problem page tab, pinned first; problem_id null = course-wide
        # announcements on the dashboard. Also deleting a problem's threads.
        IndexModel(
            [("problem_id", ASCENDING), ("pinned", DESCENDING), ("updated_at", DESCENDING)],
            name="problem_pinned_updated",
        ),
        # A student's own questions (GET /clarifications as a student)
        IndexModel([("author_id", ASCENDING), ("created_at", DESCENDING)], name="author_created_at"),
        # Staff queue (/manage/clarifications), filtered by status
        IndexModel([("status", ASCENDING), ("updated_at", DESCENDING)], name="status_updated_at"),
    ],
    NOTIFICATIONS: [
        # The bell and /notifications: own, newest first; unread count
        IndexModel(
            [("user_id", ASCENDING), ("is_read", ASCENDING), ("created_at", DESCENDING)],
            name="user_read_created_at",
        ),
        IndexModel(
            [("created_at", ASCENDING)],
            name="created_at_ttl",
            expireAfterSeconds=NOTIFICATION_TTL_SECONDS,
        ),
    ],
}


def ensure_indexes() -> None:
    """Create missing indexes (and with them the collections). Idempotent,
    like ``create_all``: an existing index with the same name is left alone."""
    db = get_mongo()
    for name, indexes in _INDEXES.items():
        db[name].create_indexes(indexes)
