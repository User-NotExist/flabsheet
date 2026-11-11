"""Endpoints the judge worker calls: events and job refresh.

Both require the worker's bearer token (``JUDGE_API_TOKEN``). Nothing here
checks where the request comes from: the reverse proxy must refuse
``/internal/*`` from the public internet (NFR-SEC-06).

Only build jobs exist so far, so only ``build_done`` is handled. The judge
drops an event on any 4xx other than 401 and 409, and retries on 5xx, so a
handler bug must surface as a 5xx and never as a 4xx.
"""

from __future__ import annotations

import logging
import secrets
from typing import Annotated, Any, Optional, Union

from fastapi import APIRouter, Body, Depends, Header, HTTPException, status
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session as DbSession

from config import settings
from db.models.problem import BuildStatus, ProblemVersion
from db.models.submission import JudgeEvent
from db.postgres import get_database
from services.jobs import enqueue
from services.packages import record_build_result, refreshed_build_payload

logger = logging.getLogger(__name__)


def require_worker(authorization: Annotated[Optional[str], Header()] = None) -> None:
    expected = settings.judge_api_token
    sent = authorization or ""
    # An empty token must not match an empty header: unset means closed
    if not expected or not secrets.compare_digest(
        sent.encode(), f"Bearer {expected}".encode()
    ):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid worker token")


router = APIRouter(
    prefix="/internal",
    tags=["internal"],
    dependencies=[Depends(require_worker)],
)

Db = Annotated[DbSession, Depends(get_database)]


def _handle_build_done(db: DbSession, event: dict[str, Any]) -> None:
    job_id = str(event.get("job_id") or "")
    version = db.scalar(
        select(ProblemVersion)
        .where(ProblemVersion.build_job_id == job_id)
        .with_for_update()
    )
    if version is None:
        return  # the problem was deleted while its build ran

    # event_id is the judge's idempotency key: a replayed event inserts nothing
    inserted = db.execute(
        insert(JudgeEvent)
        .values(
            event_id=str(event["event_id"]),
            job_id=job_id,
            attempt=int(event.get("attempt") or 1),
            seq=int(event.get("seq") or 1),
            type="build_done",
        )
        .on_conflict_do_nothing(index_elements=[JudgeEvent.event_id])
    ).rowcount
    if not inserted or version.build_status is not BuildStatus.pending:
        db.commit()
        return

    payload = event.get("payload")
    ready = record_build_result(version, payload if isinstance(payload, dict) else {})
    db.commit()
    if ready:
        # Best effort: the worker cron finds the version if this is lost
        enqueue("assemble_package", version.id)


@router.post("/judge-events")
def judge_events(
    body: Annotated[Union[dict[str, Any], list[dict[str, Any]]], Body()], db: Db
):
    """Accept one event, or the array of up to 50 the worker sends when it replays its spool."""
    # Each event commits on its own, in order, so a failure half-way keeps
    # the earlier ones and the replay skips them as duplicates.
    for event in body if isinstance(body, list) else [body]:
        if event.get("type") == "build_done" and event.get("event_id"):
            _handle_build_done(db, event)
        else:
            logger.warning("ignoring judge event of type %r", event.get("type"))
    return {"ok": True}


@router.post("/judge-jobs/{job_id}/refresh")
def refresh_job(job_id: str, db: Db):
    """The same job with fresh presigned URLs, for a job the worker reclaimed late."""
    payload = refreshed_build_payload(db, job_id)
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    return payload
