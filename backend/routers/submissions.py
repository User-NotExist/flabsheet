"""Submitting code and reading results (FR-STD-06 to 09, FR-PRB-14, FR-MON-02).

    POST /problems/{slug}/submissions   submit {language, source}
    GET  /submissions?problem={slug}    the caller's own history, newest first
    GET  /submissions/{id}              one result report
    GET  /submissions/{id}/stream       live progress (Server-Sent Events)

Responses are shaped per viewer. A student sees only their own submissions,
and for a hidden test case only the verdict, time and memory: never its
input, expected output, their output or the checker message, because any of
these would reveal the test (NFR-SEC-07). Staff see the checker message and
the test data of hidden cases too, but no output for them, since the judge
never sends it. ``?student_view=true`` gives staff the student shape, for the
preview page.

The stream route is the one ``async def`` in the backend: an open stream then
costs a Redis subscription instead of a worker thread. It opens its own short
database sessions, so no connection is held while the stream is idle.
"""

from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Annotated, Any, AsyncIterator, Optional

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from config import settings
from db.models.instance_settings import InstanceSettings
from db.models.problem import (
    Problem,
    ProblemStatus,
    ProblemVersion,
    TestCase,
    TestCaseVisibility,
)
from db.models.submission import (
    MAX_SOURCE_BYTES,
    ProblemScore,
    Submission,
    SubmissionResult,
    SubmissionStatus,
)
from db.models.user import User, UserRole
from db.postgres import SessionLocal, get_database
from routers.solve import LanguageOut, language_out, read_text
from services import storage
from services.auth import CurrentSession
from services.errors import ApiError
from services.languages import LANGUAGES
from services.rate_limit import submit_retry_after
from services.session import SessionData, get_session
from services.submissions import (
    ACTIVE_STATUSES,
    FINAL_STATUSES,
    channel,
    create_submission,
    progress,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["submissions"])

Db = Annotated[DbSession, Depends(get_database)]

MAX_ACTIVE_SUBMISSIONS = 3  # FR-STD-06: queued or being judged, per user
HISTORY_LIMIT = 200
_READ_THREADS = 8

# With no event for this long the stream sends the state read from the
# database instead, which also covers a publish that Redis dropped.
STREAM_IDLE_SECONDS = 15
# The browser reconnects by itself, so an abandoned stream cannot live forever
STREAM_MAX_SECONDS = 20 * 60

_FAILED_RUN_VERDICTS = frozenset({"WA", "PE", "TLE", "MLE", "OLE", "RE"})

_stream_redis: Optional[aioredis.Redis] = None


# --- models -----------------------------------------------------------------


class SubmitIn(BaseModel):
    language: str
    source: str


class SubmissionListItem(BaseModel):
    id: int
    language: LanguageOut
    status: SubmissionStatus
    verdict: Optional[str]
    score_milli: Optional[int]
    max_points: int
    is_staff: bool
    created_at: datetime


class ProblemRef(BaseModel):
    id: int
    slug: str
    title: str
    version: int


class AuthorOut(BaseModel):
    login_id: str
    display_name: str


class TestResultOut(BaseModel):
    ordinal: int
    visibility: TestCaseVisibility
    verdict: str
    time_ms: Optional[int]
    memory_kb: Optional[int]
    # The fields below are None when the viewer may not see them
    checker_msg: Optional[str]
    input: Optional[str]
    input_truncated: bool
    expected: Optional[str]
    expected_truncated: bool
    output: Optional[str]
    output_truncated: bool
    hint_md: Optional[str]  # only on a case that did not pass (FR-PRB-11)


class SubmissionOut(BaseModel):
    id: int
    problem: ProblemRef
    language: LanguageOut
    status: SubmissionStatus
    verdict: Optional[str]
    score_milli: Optional[int]
    max_points: int
    checker_strict: bool
    attempt: int
    is_staff: bool
    # True when this submission sets its author's current score (FR-JDG-06)
    is_current: bool
    created_at: datetime
    finished_at: Optional[datetime]
    source_name: str
    source: str
    compile_log: Optional[str]
    tests_total: int
    results: list[TestResultOut]
    # True when hidden-case details are included (staff, admin)
    staff_view: bool
    author: Optional[AuthorOut]  # staff view only
    judge_reason: Optional[str]  # staff view only


# --- helpers ----------------------------------------------------------------


def _may_view(session: SessionData, submission: Submission) -> bool:
    return session.role is not UserRole.student or submission.user_id == session.user_id


def _get_submission(db: DbSession, session: SessionData, submission_id: int) -> Submission:
    submission = db.get(Submission, submission_id)
    if submission is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Submission not found")
    if not _may_view(session, submission):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "You can only view your own submissions."
        )
    return submission


def _overall_verdict(submission: Submission, max_points: int) -> Optional[str]:
    """The verdict to show for the whole submission.

    The judge reports the first failing test's verdict even when other tests
    passed. With part of the points earned that reads wrong ("Wrong answer,
    50 / 100"), so it is shown as PA; the stored verdict stays as the judge
    sent it.
    """
    score = submission.score_milli
    if (
        submission.verdict in _FAILED_RUN_VERDICTS
        and score is not None
        and 0 < score < max_points * 1000
    ):
        return "PA"
    return submission.verdict


def _result_out(
    case: TestCase,
    result: SubmissionResult,
    texts: tuple[tuple[str, bool], tuple[str, bool]],
    staff_view: bool,
) -> TestResultOut:
    hidden = case.visibility is TestCaseVisibility.hidden
    detailed = staff_view or not hidden
    (input_text, input_cut), (expected, expected_cut) = texts
    return TestResultOut(
        ordinal=case.ordinal,
        visibility=case.visibility,
        verdict=result.verdict,
        time_ms=result.time_ms,
        memory_kb=result.memory_kb,
        checker_msg=result.checker_msg if detailed else None,
        input=input_text if detailed else None,
        input_truncated=input_cut and detailed,
        expected=expected if detailed else None,
        expected_truncated=expected_cut and detailed,
        # Never stored for a hidden case, so staff have none to see either
        output=None if hidden else result.output_preview,
        output_truncated=result.preview_truncated and not hidden,
        hint_md=case.hint_md if result.verdict != "AC" else None,
    )


def _submission_out(
    db: DbSession, submission: Submission, *, staff_view: bool
) -> SubmissionOut:
    problem = db.get(Problem, submission.problem_id)
    version = db.get(ProblemVersion, submission.problem_version_id)
    assert problem is not None and version is not None
    cases = {case.id: case for case in version.test_cases}
    results = sorted(
        (
            result
            for result in db.scalars(
                select(SubmissionResult).where(
                    SubmissionResult.submission_id == submission.id,
                    SubmissionResult.attempt == submission.attempt,
                )
            )
            if result.test_case_id in cases
        ),
        key=lambda result: cases[result.test_case_id].ordinal,
    )

    def texts(result: SubmissionResult) -> tuple[tuple[str, bool], tuple[str, bool]]:
        case = cases[result.test_case_id]
        # Hidden test data is not even read for a student's response
        if case.visibility is TestCaseVisibility.hidden and not staff_view:
            return ("", False), ("", False)
        return (
            read_text(case.input_key, case.input_bytes),
            read_text(case.answer_key, case.answer_bytes),
        )

    with ThreadPoolExecutor(_READ_THREADS) as pool:
        source = pool.submit(storage.get_bytes, storage.PROBLEMS, submission.source_key)
        case_texts = list(pool.map(texts, results))
        source_text = source.result().decode("utf-8", errors="replace")

    is_current = (
        db.scalar(
            select(ProblemScore.submission_id).where(
                ProblemScore.user_id == submission.user_id,
                ProblemScore.problem_id == submission.problem_id,
            )
        )
        == submission.id
    )
    author = db.get(User, submission.user_id) if staff_view else None
    language = LANGUAGES.get(submission.language_id)
    return SubmissionOut(
        id=submission.id,
        problem=ProblemRef(
            id=problem.id, slug=problem.slug, title=problem.title, version=version.version
        ),
        language=language_out(submission.language_id),
        status=submission.status,
        verdict=_overall_verdict(submission, version.max_points),
        score_milli=submission.score_milli,
        max_points=version.max_points,
        checker_strict=version.checker_strict,
        attempt=submission.attempt,
        is_staff=submission.is_staff,
        is_current=is_current,
        created_at=submission.created_at,
        finished_at=submission.finished_at,
        source_name=language.source_name if language else "source",
        source=source_text,
        # A student needs the log to fix a compile error; warnings of a build
        # that succeeded are for staff
        compile_log=(
            submission.compile_log if staff_view or submission.verdict == "CE" else None
        ),
        tests_total=len(cases),
        results=[
            _result_out(cases[result.test_case_id], result, text, staff_view)
            for result, text in zip(results, case_texts)
        ],
        staff_view=staff_view,
        author=(
            AuthorOut(login_id=author.login_id, display_name=author.display_name)
            if author
            else None
        ),
        judge_reason=submission.judge_reason if staff_view else None,
    )


# --- endpoints --------------------------------------------------------------


@router.post(
    "/problems/{slug}/submissions",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
)
def submit(slug: str, body: SubmitIn, session: CurrentSession, db: Db):
    """Queue a submission. The checks run in the order of SRS 6.2."""
    staff = session.role is not UserRole.student

    instance = db.get(InstanceSettings, 1)
    if instance is not None and not instance.submissions_open:
        # The killswitch covers staff test submissions too (FR-ADM-05)
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            instance.submissions_message or "Submissions are closed.",
            code="submissions_closed",
        )

    problem = db.scalar(select(Problem).where(Problem.slug == slug))
    # A draft looks like a missing problem to students (routers/solve.py)
    if problem is None or (not staff and problem.status is ProblemStatus.draft):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Problem not found")
    closed = (
        problem.status is ProblemStatus.archived
        if staff
        else problem.status is not ProblemStatus.enabled
    )
    version = problem.current_version
    if closed or version is None:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "This problem is not open for submissions.",
            code="problem_disabled",
        )

    language = LANGUAGES.get(body.language)
    if language is None or language.id not in {lang.language_id for lang in version.languages}:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "This language is not allowed for this problem.",
            code="language_not_allowed",
        )

    source = body.source.encode("utf-8", errors="replace")
    if not body.source.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Write some code before submitting.")
    if len(source) > MAX_SOURCE_BYTES:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE,
            f"Your code is larger than {MAX_SOURCE_BYTES // 1024} KB.",
        )

    retry_after = submit_retry_after(session.user_id)
    if retry_after:
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"You are submitting too fast. Try again in {retry_after} s.",
            code="rate_limited",
            headers={"Retry-After": str(retry_after)},
        )
    active = db.scalar(
        select(func.count())
        .select_from(Submission)
        .where(Submission.user_id == session.user_id, Submission.status.in_(ACTIVE_STATUSES))
    )
    if (active or 0) >= MAX_ACTIVE_SUBMISSIONS:
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"You already have {MAX_ACTIVE_SUBMISSIONS} submissions waiting to be judged. "
            "Wait for one to finish.",
            code="rate_limited",
        )

    submission = create_submission(
        db,
        user_id=session.user_id,
        is_staff=staff,
        problem=problem,
        language=language,
        source=source,
    )
    # A new submission has no results yet, so both views are the same
    return _submission_out(db, submission, staff_view=False)


@router.get("/submissions", response_model=list[SubmissionListItem])
def list_submissions(session: CurrentSession, db: Db, problem: Optional[str] = None):
    """The caller's own submissions, newest first, optionally for one problem (FR-STD-09)."""
    query = (
        select(Submission, ProblemVersion.max_points)
        .join(ProblemVersion, ProblemVersion.id == Submission.problem_version_id)
        .where(Submission.user_id == session.user_id)
        .order_by(Submission.created_at.desc(), Submission.id.desc())
        .limit(HISTORY_LIMIT)
    )
    if problem is not None:
        query = query.join(Problem, Problem.id == Submission.problem_id).where(
            Problem.slug == problem
        )
    return [
        SubmissionListItem(
            id=submission.id,
            language=language_out(submission.language_id),
            status=submission.status,
            verdict=_overall_verdict(submission, max_points),
            score_milli=submission.score_milli,
            max_points=max_points,
            is_staff=submission.is_staff,
            created_at=submission.created_at,
        )
        for submission, max_points in db.execute(query)
    ]


@router.get("/submissions/{submission_id}", response_model=SubmissionOut)
def get_submission(
    submission_id: int, session: CurrentSession, db: Db, student_view: bool = False
):
    submission = _get_submission(db, session, submission_id)
    staff_view = session.role is not UserRole.student and not student_view
    return _submission_out(db, submission, staff_view=staff_view)


# --- live progress ----------------------------------------------------------


def _stream_client() -> aioredis.Redis:
    global _stream_redis
    if _stream_redis is None:
        # No socket timeout: a subscription waits for as long as judging takes
        _stream_redis = aioredis.Redis.from_url(
            settings.redis_url, decode_responses=True, socket_connect_timeout=2
        )
    return _stream_redis


def _authorize_stream(token: Optional[str], submission_id: int) -> None:
    """The checks of ``CurrentSession`` and ``_get_submission``, in a session of their own."""
    with SessionLocal() as db:
        session = get_session(db, token) if token else None
        if session is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
        if session.must_change_password:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Change your password to continue")
        _get_submission(db, session, submission_id)


def _read_progress(submission_id: int) -> Optional[dict[str, Any]]:
    with SessionLocal() as db:
        submission = db.get(Submission, submission_id)
        return progress(db, submission) if submission else None


def _sse(data: dict[str, Any]) -> str:
    return f"data: {json.dumps(data, separators=(',', ':'))}\n\n"


def _is_final(data: dict[str, Any]) -> bool:
    return data.get("status") in {state.value for state in FINAL_STATUSES}


async def _progress_events(submission_id: int) -> AsyncIterator[str]:
    pubsub = _stream_client().pubsub()
    try:
        # Subscribe before reading the state, so a change in between is not lost
        await pubsub.subscribe(channel(submission_id))
        loop = asyncio.get_running_loop()
        deadline = loop.time() + STREAM_MAX_SECONDS
        current = await asyncio.to_thread(_read_progress, submission_id)
        while current is not None:
            yield _sse(current)
            if _is_final(current) or loop.time() > deadline:
                return
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=STREAM_IDLE_SECONDS
            )
            if message is not None:
                current = json.loads(message["data"])
            else:
                current = await asyncio.to_thread(_read_progress, submission_id)
    finally:
        await pubsub.aclose()


@router.get("/submissions/{submission_id}/stream")
async def stream_submission(submission_id: int, request: Request):
    """Progress snapshots ``{id, status, tests_done, verdict, score_milli}`` until the result is final.

    Each message replaces the previous one, so a client that reconnects just
    carries on. The snapshots hold no test data; the page fetches the report
    with ``GET /submissions/{id}`` once the status is final.
    """
    token = request.cookies.get(settings.session_cookie_name)
    await asyncio.to_thread(_authorize_stream, token, submission_id)
    return StreamingResponse(
        _progress_events(submission_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Tells nginx-style proxies to pass each event on at once
            "X-Accel-Buffering": "no",
        },
    )
