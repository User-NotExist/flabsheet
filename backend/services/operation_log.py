"""Helpers for writing rows to the ``operation_logs`` table.

Usage from any other module::

    from services.operation_log import log_operation

    log_operation(db, "user.create", user_id=admin.id, info={"login_id": new_user.login_id})
    db.commit()  # the log row commits (or rolls back) together with the operation
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Optional, Union

from sqlalchemy.orm import Session

from db.models.operation_log import OperationLog
from db.session import SessionLocal

Info = Union[str, Mapping[str, Any], None]


def _serialize_info(info: Info) -> Optional[str]:
    if info is None or isinstance(info, str):
        return info
    return json.dumps(info, ensure_ascii=False, default=str)


def log_operation(
    db: Session,
    op_type: str,
    *,
    user_id: Optional[int] = None,
    info: Info = None,
) -> OperationLog:
    """Add an operation log row to the caller's session.

    The row is flushed but NOT committed, so it lives in the same transaction
    as the operation being logged: if the caller rolls back, the log entry is
    discarded too. ``info`` may be a string or a dict (stored as JSON).
    ``user_id`` may be None for system events.
    """
    if not op_type:
        raise ValueError("op_type must be a non-empty string")

    entry = OperationLog(user_id=user_id, type=op_type, info=_serialize_info(info))
    db.add(entry)
    db.flush()  # populate id/created_at and surface DB errors at the call site
    return entry


def log_operation_now(
    op_type: str,
    *,
    user_id: Optional[int] = None,
    info: Info = None,
) -> None:
    """Write and commit a log row in its own session/transaction.

    Use this when the entry must persist even if the surrounding operation
    fails and rolls back (e.g. failed login attempts, permission denials).
    """
    with SessionLocal() as db:
        log_operation(db, op_type, user_id=user_id, info=info)
        db.commit()
