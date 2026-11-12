"""Sending jobs to the judge: job ids, the Redis streams and the outbox relay.

A job is first written to ``judge_outbox`` in the same transaction as the row
it belongs to, then pushed to Redis after the commit. If the push fails, the
row stays unsent and the worker's ``flush_outbox`` cron retries it, so a
committed job is never lost (queue contract: ``judge-worker-go/README.md``).

    job_id = new_job_id()
    row = JudgeOutbox(job_id=job_id, stream=BUILD_STREAM, payload=payload)
    db.add(row)
    db.commit()
    send_outbox(db, row)   # pushes, then marks the row sent
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import redis
from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models.submission import JudgeOutbox
from db.redis import redis_client

logger = logging.getLogger(__name__)

BUILD_STREAM = "judge:build:_"

# flush_outbox leaves younger rows alone: their own request is still pushing them
OUTBOX_GRACE_SECONDS = 10
OUTBOX_BATCH = 50

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def new_job_id() -> str:
    """A ULID: 48 bits of milliseconds then 80 random bits, so ids sort by time."""
    value = (int(time.time() * 1000) << 80) | int.from_bytes(os.urandom(10), "big")
    return "".join(_CROCKFORD[(value >> shift) & 31] for shift in range(125, -1, -5))


def _push(stream: str, payload: dict[str, Any]) -> None:
    lane = stream.split(":")[1]
    # The worker only reads streams listed in the lane's set, so both writes
    # go in one MULTI.
    pipe = redis_client.pipeline(transaction=True)
    pipe.xadd(stream, {"data": json.dumps(payload, separators=(",", ":"))})
    pipe.sadd(f"judge:streams:{lane}", stream)
    pipe.execute()


def send_outbox(db: Session, row: JudgeOutbox) -> bool:
    """Push one committed outbox row to its stream and record the outcome. Commits."""
    try:
        _push(row.stream, row.payload)
    except redis.RedisError as exc:
        logger.warning("judge job %s not sent; flush_outbox will retry", row.job_id, exc_info=True)
        row.tries += 1
        row.last_error = str(exc)[:500]
        db.commit()
        return False
    row.tries += 1
    row.sent_at = datetime.now(timezone.utc)
    row.last_error = None
    db.commit()
    return True


def flush_outbox(db: Session) -> int:
    """Re-send outbox rows that were committed but never reached Redis."""
    # Imported here: both build job payloads and themselves import this module
    from services.packages import refreshed_build_payload
    from services.submissions import refreshed_judge_payload

    cutoff = datetime.now(timezone.utc) - timedelta(seconds=OUTBOX_GRACE_SECONDS)
    rows = db.scalars(
        select(JudgeOutbox)
        .where(JudgeOutbox.sent_at.is_(None), JudgeOutbox.created_at < cutoff)
        .order_by(JudgeOutbox.created_at)
        .limit(OUTBOX_BATCH)
        .with_for_update(skip_locked=True)
    ).all()
    sent = 0
    for row in rows:
        # The stored presigned URLs may have expired while Redis was down
        refresh = refreshed_build_payload if row.stream == BUILD_STREAM else refreshed_judge_payload
        payload = refresh(db, row.job_id)
        if payload is None:  # the problem was deleted meanwhile
            db.delete(row)
            db.commit()
            continue
        row.payload = payload
        if send_outbox(db, row):
            sent += 1
    db.commit()
    return sent
