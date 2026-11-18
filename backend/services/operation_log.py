"""Write audit events to the MongoDB ``operation_logs`` collection.

Usage from any other module::

    from services.operation_log import log_operation

    log_operation(db, "user.create", user_id=admin.id, info={"login_id": new_user.login_id})
    db.commit()  # the entry is written to MongoDB only once this commit succeeds

Entries are held on the SQLAlchemy session and inserted by an ``after_commit``
hook, so an operation that rolls back leaves no entry, as when the log was a
Postgres table. Mongo is written after the commit and best effort, like Redis:
if it is down the entry is lost with a warning and the request still succeeds
(the operation already committed, so failing it would only mislead).

Document shape::

    {_id: ObjectId, created_at: datetime, type: "auth.login",
     user_id: 42 | None, info: {...} | "text" | None}
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional, Union

from pymongo.errors import PyMongoError
from sqlalchemy import event
from sqlalchemy.orm import Session, SessionTransaction

from db.mongo import operation_logs
from db.postgres import SessionLocal

logger = logging.getLogger(__name__)

Info = Union[str, Mapping[str, Any], None]

_PENDING = "pending_operation_logs"  # key in Session.info


def _document(op_type: str, user_id: Optional[int], info: Info) -> dict[str, Any]:
    if not op_type:
        raise ValueError("op_type must be a non-empty string")
    if info is not None and not isinstance(info, str):
        # Round trip through JSON, as the old text column did: values such as
        # datetimes or Decimals become strings and every key becomes a string,
        # so the document is always valid BSON.
        info = json.loads(json.dumps(info, ensure_ascii=False, default=str))
    return {
        "created_at": datetime.now(timezone.utc),
        "type": op_type,
        "user_id": user_id,
        "info": info,
    }


def _insert(documents: list[dict[str, Any]]) -> None:
    try:
        operation_logs().insert_many(documents, ordered=False)
    except PyMongoError:
        logger.warning(
            "could not write %d operation log entries: %s",
            len(documents),
            [doc["type"] for doc in documents],
            exc_info=True,
        )


def log_operation(
    db: Session,
    op_type: str,
    *,
    user_id: Optional[int] = None,
    info: Info = None,
) -> None:
    """Queue an entry that is written when ``db`` commits.

    If the caller rolls back (or closes the session without committing), the
    entry is discarded. ``info`` may be a string or a dict (stored as a nested
    document). ``user_id`` may be None for system events. Call it outside
    ``begin_nested()``: a rolled-back savepoint does not discard its entries.
    """
    document = _document(op_type, user_id, info)
    # Start the transaction now (as the old flush did), so its end is seen by
    # _discard_pending even if the caller runs no other statement.
    db.connection()
    db.info.setdefault(_PENDING, []).append(document)


def log_operation_now(
    op_type: str,
    *,
    user_id: Optional[int] = None,
    info: Info = None,
) -> None:
    """Write an entry right away, outside any transaction.

    Use this when the entry must persist even if the surrounding operation
    fails and rolls back (e.g. failed login attempts, permission denials).
    """
    _insert([_document(op_type, user_id, info)])


@event.listens_for(SessionLocal, "after_commit")
def _write_pending(session: Session) -> None:
    # Runs after the DBAPI commit: it must never raise, or the caller would see
    # an error for an operation that did commit. _insert swallows Mongo errors.
    documents = session.info.pop(_PENDING, None)
    if documents:
        _insert(documents)


@event.listens_for(SessionLocal, "after_transaction_end")
def _discard_pending(session: Session, transaction: SessionTransaction) -> None:
    # after_commit has already taken the entries of a committed transaction;
    # whatever is left belongs to one that rolled back or was closed.
    if transaction.parent is None and not transaction.nested:
        session.info.pop(_PENDING, None)
