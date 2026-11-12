"""Submissions: the judge job, the judge's events, live progress and the 15-minute rule.

A submit writes the ``submissions`` row and its ``judge_outbox`` row in one
transaction (SRS 6.2), so a stored submission always has a job. The judge then
reports ``started``, ``compiled``, ``test_result`` (one per test), and ``done``;
:func:`apply_event` applies each exactly once and in a way that is safe when
events repeat or belong to an attempt that was superseded (SRS 6.4).

After every committed change :func:`publish_progress` sends a small snapshot to
the Redis channel ``sub:{submission_id}``, which the SSE route relays to the
browser. The snapshot never carries test data, only counts and the verdict.

    submission = create_submission(db, user_id=..., is_staff=False, problem=problem,
                                   language=LANGUAGES["py312"], source=b"print(1)")
    ...
    outcome = apply_event(db, event)        # in /internal/judge-events
    if outcome is Outcome.superseded: ...   # answer 409
"""

from __future__ import annotations

import enum
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping, Optional

import redis
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from config import settings
from db.models.problem import Problem, ProblemVersion, TestCase, TestCaseVisibility
from db.models.submission import (
    JudgeEvent,
    JudgeOutbox,
    Submission,
    SubmissionResult,
    SubmissionStatus,
)
from db.redis import redis_client
from services import storage
from services.judge import new_job_id, send_outbox
from services.languages import LANGUAGES, Language
from services.packages import language_time_limits

logger = logging.getLogger(__name__)

LANE = "practice"  # every student and staff submission (SRS 6.6)
# Verdicts the judge documents. Anything else is stored as it came and flagged.
KNOWN_VERDICTS = frozenset(
    {"AC", "PA", "WA", "PE", "TLE", "MLE", "OLE", "RE", "CE", "SE", "JE"}
)
# SE and JE say nothing about the code, so they never become a score (FR-JDG-06)
NON_SCORING_VERDICTS = frozenset({"SE", "JE"})
ACTIVE_STATUSES = (
    SubmissionStatus.queued,
    SubmissionStatus.compiling,
    SubmissionStatus.running,
)
FINAL_STATUSES = (SubmissionStatus.done, SubmissionStatus.review)
DELAYED_AFTER = timedelta(minutes=15)  # FR-JDG-05
MAX_COMPILE_LOG_CHARS = 64 * 1024  # the judge caps compiler logs at 64 KiB
MAX_CHECKER_MSG_CHARS = 1024

# FR-JDG-06: the latest submission by submit time sets the score, also when an
# older one finishes after it (docs/data-and-storage.md).
_UPSERT_SCORE = text(
    """
    INSERT INTO problem_scores AS ps
      (user_id, problem_id, submission_id, submission_created_at, score_milli, achieved_at)
    VALUES (:user_id, :problem_id, :submission_id, :created_at, :score_milli, now())
    ON CONFLICT (user_id, problem_id) DO UPDATE
      SET submission_id         = EXCLUDED.submission_id,
          submission_created_at = EXCLUDED.submission_created_at,
          score_milli           = EXCLUDED.score_milli,
          achieved_at = CASE WHEN ps.score_milli = EXCLUDED.score_milli
                             THEN ps.achieved_at ELSE now() END
      WHERE EXCLUDED.submission_created_at >= ps.submission_created_at
    """
)


class Outcome(enum.Enum):
    applied = "applied"
    ignored = "ignored"  # duplicate, or the submission no longer exists
    superseded = "superseded"  # a newer attempt or job owns the submission


def stream_name() -> str:
    return f"judge:{LANE}:{settings.judge_course_id}"


def channel(submission_id: int) -> str:
    return f"sub:{submission_id}"


def source_key(submission_id: int, language: Language) -> str:
    return f"sources/{submission_id}/{language.source_name}"


# --- the judge job ----------------------------------------------------------


def judge_job_payload(db: Session, submission: Submission) -> dict[str, Any]:
    """The JudgeJob JSON for a submission (``judge-worker-go/README.md``).

    Used for the first send, for outbox retries and for the judge's refresh
    call, so all three always agree apart from the freshly signed URL.
    """
    version = db.get(ProblemVersion, submission.problem_version_id)
    assert version is not None  # ON DELETE RESTRICT keeps it while the submission exists
    language = LANGUAGES[submission.language_id]
    return {
        "kind": "judge",
        "job_id": submission.job_id,
        "submission_id": submission.id,
        "attempt": submission.attempt,
        "course_id": settings.judge_course_id,
        "lane": submission.lane,
        "language": language.id,
        "source": {
            "files": [
                {
                    "name": language.source_name,
                    "url": storage.presign_get(storage.PROBLEMS, submission.source_key),
                    "sha256": submission.source_sha256,
                }
            ]
        },
        "problem": {
            "id": version.problem_id,
            "version": version.version,
            "package_sha256": version.package_sha256,
            "package_key": version.package_key,
        },
        "limits": {
            "time_ms": language_time_limits(version)[language.id],
            "memory_mb": version.memory_limit_mb,
        },
        "feedback": {"preview_samples": True},
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def refreshed_judge_payload(db: Session, job_id: str) -> Optional[dict[str, Any]]:
    """The judge job with a fresh URL, or None when it is no longer wanted."""
    submission = db.scalar(select(Submission).where(Submission.job_id == job_id))
    if submission is None or submission.status in FINAL_STATUSES:
        return None
    return judge_job_payload(db, submission)


def create_submission(
    db: Session,
    *,
    user_id: int,
    is_staff: bool,
    problem: Problem,
    language: Language,
    source: bytes,
) -> Submission:
    """Store the source, the submission and its job, then send the job. Commits."""
    assert problem.current_version_id is not None
    submission = Submission(
        user_id=user_id,
        problem_id=problem.id,
        problem_version_id=problem.current_version_id,
        language_id=language.id,
        # The key contains the id, which the insert assigns
        source_key="",
        source_sha256=hashlib.sha256(source).hexdigest(),
        source_bytes=len(source),
        is_staff=is_staff,
        status=SubmissionStatus.queued,
        attempt=1,
        job_id=new_job_id(),
        lane=LANE,
    )
    db.add(submission)
    db.flush()
    submission.source_key = source_key(submission.id, language)
    # Upload before the commit: a failed upload rolls the row back, and a
    # failed commit only leaves a file for the orphan sweep.
    storage.put_bytes(storage.PROBLEMS, submission.source_key, source, "text/plain; charset=utf-8")
    row = JudgeOutbox(
        job_id=submission.job_id,
        stream=stream_name(),
        payload=judge_job_payload(db, submission),
    )
    db.add(row)
    db.commit()
    # If Redis is down the submission stays queued and flush_outbox retries
    send_outbox(db, row)
    return submission


# --- live progress ----------------------------------------------------------


def progress(db: Session, submission: Submission) -> dict[str, Any]:
    """What the live status line needs. Contains no test data."""
    tests_done = db.scalar(
        select(func.count())
        .select_from(SubmissionResult)
        .where(
            SubmissionResult.submission_id == submission.id,
            SubmissionResult.attempt == submission.attempt,
        )
    )
    return {
        "id": submission.id,
        "status": submission.status.value,
        "tests_done": tests_done or 0,
        "verdict": submission.verdict,
        "score_milli": submission.score_milli,
    }


def publish_progress(db: Session, submission: Submission) -> None:
    """Tell open pages about a committed change. Best effort: they also poll."""
    try:
        redis_client.publish(channel(submission.id), json.dumps(progress(db, submission)))
    except redis.RedisError:
        logger.warning("could not publish progress of submission %s", submission.id, exc_info=True)


# --- judge events -----------------------------------------------------------


def _int(value: Any) -> Optional[int]:
    # bool is an int in Python; the judge never sends one for a number
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _reset_for_new_attempt(db: Session, submission: Submission, attempt: int) -> None:
    submission.attempt = attempt
    submission.verdict = None
    submission.verdict_unknown = False
    submission.score_milli = None
    submission.judge_reason = None
    submission.compile_log = None
    submission.finished_at = None
    db.execute(delete(SubmissionResult).where(SubmissionResult.submission_id == submission.id))


def _store_test_result(db: Session, submission: Submission, payload: Mapping[str, Any]) -> None:
    name = str(payload.get("testcase") or "")
    case = db.scalar(
        select(TestCase).where(
            TestCase.problem_version_id == submission.problem_version_id,
            TestCase.name == name,
        )
    )
    if case is None:
        logger.warning("submission %s: result for unknown test case %r", submission.id, name)
        return
    # The judge only sends output for cases the package marks `sample`; check
    # again here so a hidden case's output is never stored (NFR-SEC-07).
    shown = case.visibility is not TestCaseVisibility.hidden
    preview = payload.get("output_preview") if shown else None
    message = payload.get("checker_msg")
    fraction = payload.get("fraction")
    values = {
        "attempt": submission.attempt,
        "verdict": str(payload.get("verdict") or ""),
        "time_ms": _int(payload.get("time_ms")),
        "memory_kb": _int(payload.get("memory_kb")),
        "fraction": fraction if isinstance(fraction, (int, float)) and not isinstance(fraction, bool) else None,
        "checker_msg": str(message)[:MAX_CHECKER_MSG_CHARS] if message else None,
        # PostgreSQL text cannot hold NUL, which a program is free to print
        "output_preview": preview.replace("\x00", "�") if isinstance(preview, str) else None,
        "preview_truncated": shown and payload.get("preview_truncated") is True,
    }
    db.execute(
        insert(SubmissionResult)
        .values(submission_id=submission.id, test_case_id=case.id, **values)
        .on_conflict_do_update(
            index_elements=[SubmissionResult.submission_id, SubmissionResult.test_case_id],
            set_=values,
        )
    )


def _finish(db: Session, submission: Submission, payload: Mapping[str, Any]) -> None:
    verdict = str(payload.get("verdict") or "")
    submission.verdict = verdict
    submission.verdict_unknown = verdict not in KNOWN_VERDICTS
    submission.score_milli = _int(payload.get("score_milli"))
    reason = payload.get("reason")
    detail = payload.get("detail")
    submission.judge_reason = (
        ": ".join(str(part) for part in (reason, detail) if part)[:2000] or None
    )
    submission.finished_at = datetime.now(timezone.utc)
    # FR-MON-06: a judge error is held for staff instead of being scored
    submission.status = SubmissionStatus.review if verdict == "JE" else SubmissionStatus.done

    scoring = (
        not submission.verdict_unknown
        and verdict not in NON_SCORING_VERDICTS
        and submission.score_milli is not None
    )
    # Staff test submissions are judged but never ranked (FR-PRB-14), so they
    # get no row in the table the leaderboard and exports read.
    if scoring and not submission.is_staff:
        db.execute(
            _UPSERT_SCORE,
            {
                "user_id": submission.user_id,
                "problem_id": submission.problem_id,
                "submission_id": submission.id,
                "created_at": submission.created_at,
                "score_milli": submission.score_milli,
            },
        )


def apply_event(db: Session, event: Mapping[str, Any]) -> Outcome:
    """Apply one judge event for a submission, in its own transaction. Commits."""
    submission_id = _int(event.get("submission_id"))
    attempt = _int(event.get("attempt")) or 1
    kind = str(event.get("type") or "")
    payload = event.get("payload")
    payload = payload if isinstance(payload, dict) else {}

    submission = (
        db.scalar(select(Submission).where(Submission.id == submission_id).with_for_update())
        if submission_id is not None
        else None
    )
    if submission is None:
        db.rollback()
        return Outcome.ignored  # deleted with its problem
    # A rejudge replaces job_id; a redelivered old job can carry a high attempt,
    # so the job id is compared as well as the attempt.
    if attempt < submission.attempt or str(event.get("job_id") or "") != submission.job_id:
        db.rollback()
        return Outcome.superseded

    # event_id is the judge's idempotency key: a replayed event inserts nothing.
    # RETURNING tells the two cases apart; the driver's rowcount does not (-1).
    inserted = db.execute(
        insert(JudgeEvent)
        .values(
            event_id=str(event["event_id"]),
            submission_id=submission.id,
            job_id=submission.job_id,
            attempt=attempt,
            seq=_int(event.get("seq")) or 1,
            type=kind,
        )
        .on_conflict_do_nothing(index_elements=[JudgeEvent.event_id])
        .returning(JudgeEvent.event_id)
    ).first()
    if inserted is None:
        db.commit()
        return Outcome.ignored

    if attempt > submission.attempt:
        # The job was redelivered to another worker: its results replace the old ones
        _reset_for_new_attempt(db, submission, attempt)
    finished = submission.finished_at is not None

    if kind == "done":
        _finish(db, submission, payload)
    elif finished:
        pass  # a result is final; only a newer attempt may reopen it
    elif kind == "started":
        submission.status = SubmissionStatus.compiling
        submission.started_at = datetime.now(timezone.utc)
    elif kind == "compiled":
        log = payload.get("log")
        submission.compile_log = (
            log[:MAX_COMPILE_LOG_CHARS].replace("\x00", "�") if isinstance(log, str) and log else None
        )
        submission.status = SubmissionStatus.compiling
    elif kind == "test_result":
        _store_test_result(db, submission, payload)
        submission.status = SubmissionStatus.running
    elif kind != "skipped":
        # `skipped` needs no row: with one `sum` subtask every test runs
        logger.warning("submission %s: ignoring judge event of type %r", submission.id, kind)

    db.commit()
    publish_progress(db, submission)
    return Outcome.applied


# --- the 15-minute rule -----------------------------------------------------


def detect_delayed(db: Session) -> int:
    """Mark submissions with no ``done`` after 15 minutes as delayed (FR-JDG-05).

    The job stays in the queue: a late result still finishes the submission.
    """
    cutoff = datetime.now(timezone.utc) - DELAYED_AFTER
    ids = db.scalars(
        update(Submission)
        .where(Submission.status.in_(ACTIVE_STATUSES), Submission.created_at < cutoff)
        .values(status=SubmissionStatus.delayed)
        .returning(Submission.id)
    ).all()
    db.commit()
    for submission in db.scalars(select(Submission).where(Submission.id.in_(ids))):
        publish_progress(db, submission)
    if ids:
        logger.info("marked %d submission(s) as delayed", len(ids))
    return len(ids)
