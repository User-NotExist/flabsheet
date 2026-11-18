"""Submission reports: per-test results and the compile log, in MongoDB.

One document per submission attempt in ``submission_reports``. The Postgres
``submissions`` row keeps the status, verdict and score; the document keeps
what the result page shows test by test (docs/data-and-storage.md, "MongoDB")::

    {_id: "123:2", submission_id: 123, attempt: 2, problem_id: 7, user_id: 42,
     compile_log: "..." | None, updated_at: datetime,
     results: {"<test_case_id>": {verdict, time_ms, memory_kb, fraction,
                                  checker_msg, output_preview, preview_truncated}}}

Write order (``services/submissions.py`` ``apply_event``): the submission is
locked and the event deduplicated in Postgres, the document is written here,
and only then does Postgres commit. Every write is an idempotent ``$set`` on a
fixed key, so when the commit fails the judge's retry writes the same values
again, and a Mongo failure rolls the event back (503, the judge retries).

A rejudge starts a new attempt and so a new document; readers always ask for
``submission.attempt``, and older attempts stay as history.

    store_result(submission, case.id, {...})   # inside apply_event, before commit
    report = current_report(submission)        # result page
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, Optional

from pymongo.errors import PyMongoError

from db.models.submission import Submission
from db.mongo import submission_reports

logger = logging.getLogger(__name__)


def report_id(submission_id: int, attempt: int) -> str:
    return f"{submission_id}:{attempt}"


def _upsert(submission: Submission, fields: Mapping[str, Any]) -> None:
    submission_reports().update_one(
        {"_id": report_id(submission.id, submission.attempt)},
        {
            "$set": {**fields, "updated_at": datetime.now(timezone.utc)},
            "$setOnInsert": {
                "submission_id": submission.id,
                "attempt": submission.attempt,
                "problem_id": submission.problem_id,
                "user_id": submission.user_id,
            },
        },
        upsert=True,
    )


def store_compile_log(submission: Submission, log: Optional[str]) -> None:
    """Record the ``compiled`` event's log for the current attempt. Raises on a Mongo error."""
    _upsert(submission, {"compile_log": log})


def store_result(submission: Submission, test_case_id: int, values: Mapping[str, Any]) -> None:
    """Record one test case result for the current attempt. Raises on a Mongo error.

    The caller has already dropped the output of a hidden case (NFR-SEC-07).
    """
    _upsert(submission, {f"results.{test_case_id}": dict(values)})


def current_report(submission: Submission) -> dict[str, Any]:
    """The current attempt's document, or an empty one before any event arrived."""
    found = submission_reports().find_one({"_id": report_id(submission.id, submission.attempt)})
    return found or {"compile_log": None, "results": {}}


def results_by_case(report: Mapping[str, Any]) -> dict[int, dict[str, Any]]:
    """``results`` keyed by test case id (BSON keys are strings)."""
    return {int(key): value for key, value in (report.get("results") or {}).items()}


def tests_done(submission: Submission) -> int:
    """How many tests of the current attempt have a result."""
    rows = list(
        submission_reports().aggregate(
            [
                {"$match": {"_id": report_id(submission.id, submission.attempt)}},
                {"$project": {"n": {"$size": {"$objectToArray": {"$ifNull": ["$results", {}]}}}}},
            ]
        )
    )
    return rows[0]["n"] if rows else 0


def delete_for_problem(problem_id: int) -> None:
    """Drop the reports of a deleted problem's submissions. Call after the
    commit; best effort, a leftover document is never read again."""
    try:
        submission_reports().delete_many({"problem_id": problem_id})
    except PyMongoError:
        logger.warning("could not delete reports of problem %s", problem_id, exc_info=True)
