"""Staff submission browser (FR-MON-03).

    GET /admin/submissions              every submission, newest first, with filters
    GET /admin/export/submissions.csv   the same rows as a CSV file

Filters combine with AND. The single submission view is GET /submissions/{id}
in routers/submissions.py, which already gives staff the full report.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session as DbSession

from db.models.problem import Problem, ProblemVersion
from db.models.submission import Submission, SubmissionStatus
from db.models.user import User, UserRole
from db.postgres import get_database
from routers.solve import LanguageOut, language_out
from routers.submissions import _overall_verdict
from services.auth import require_role

router = APIRouter(
    prefix="/admin/submissions",
    tags=["admin-submissions"],
    dependencies=[Depends(require_role(UserRole.staff, UserRole.admin))],
)

Db = Annotated[DbSession, Depends(get_database)]

MAX_PAGE_SIZE = 100


# --- models -----------------------------------------------------------------


class StudentRef(BaseModel):
    id: int
    login_id: str
    display_name: str


class ProblemRefOut(BaseModel):
    id: int
    slug: str
    title: str


class AdminSubmissionItem(BaseModel):
    id: int
    student: StudentRef
    problem: ProblemRefOut
    language: LanguageOut
    status: SubmissionStatus
    verdict: Optional[str]
    score_milli: Optional[int]
    max_points: int
    is_staff: bool
    created_at: datetime


class AdminSubmissionPage(BaseModel):
    items: list[AdminSubmissionItem]
    total: int
    page: int
    page_size: int


class SubmissionFilters(BaseModel):
    """Shared by the list and the CSV export, so both return the same rows."""

    student: Optional[str] = None  # login_id, exact (case-insensitive: citext)
    problem: Optional[str] = None  # slug
    verdict: Optional[str] = None  # stored judge verdict: AC, WA, TLE, ...
    status: Optional[SubmissionStatus] = None
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    include_staff: bool = False  # staff test submissions are hidden by default


def submission_filters(
    student: Optional[str] = None,
    problem: Optional[str] = None,
    verdict: Optional[str] = None,
    status: Optional[SubmissionStatus] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    include_staff: bool = False,
) -> SubmissionFilters:
    return SubmissionFilters(
        student=student or None,
        problem=problem or None,
        verdict=verdict or None,
        status=status,
        date_from=date_from,
        date_to=date_to,
        include_staff=include_staff,
    )


Filters = Annotated[SubmissionFilters, Depends(submission_filters)]


# --- query ------------------------------------------------------------------


def filtered_query(filters: SubmissionFilters) -> Select:
    """Submissions joined with their user, problem and version, filters applied."""
    query = (
        select(Submission, User, Problem, ProblemVersion.max_points)
        .join(User, User.id == Submission.user_id)
        .join(Problem, Problem.id == Submission.problem_id)
        .join(ProblemVersion, ProblemVersion.id == Submission.problem_version_id)
    )
    if filters.student is not None:
        query = query.where(User.login_id == filters.student)
    if filters.problem is not None:
        query = query.where(Problem.slug == filters.problem)
    if filters.verdict is not None:
        query = query.where(Submission.verdict == filters.verdict)
    if filters.status is not None:
        query = query.where(Submission.status == filters.status)
    if filters.date_from is not None:
        query = query.where(Submission.created_at >= filters.date_from)
    if filters.date_to is not None:
        query = query.where(Submission.created_at < filters.date_to)
    if not filters.include_staff:
        query = query.where(Submission.is_staff.is_(False))
    return query


# --- routes -----------------------------------------------------------------


@router.get("", response_model=AdminSubmissionPage)
def list_all_submissions(
    filters: Filters,
    db: Db,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 50,
):
    query = filtered_query(filters)
    total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = db.execute(
        query.order_by(Submission.created_at.desc(), Submission.id.desc())
        .limit(page_size)
        .offset((page - 1) * page_size)
    )
    items = [
        AdminSubmissionItem(
            id=submission.id,
            student=StudentRef(
                id=user.id, login_id=user.login_id, display_name=user.display_name
            ),
            problem=ProblemRefOut(id=problem.id, slug=problem.slug, title=problem.title),
            language=language_out(submission.language_id),
            status=submission.status,
            verdict=_overall_verdict(submission, max_points),
            score_milli=submission.score_milli,
            max_points=max_points,
            is_staff=submission.is_staff,
            created_at=submission.created_at,
        )
        for submission, user, problem, max_points in rows
    ]
    return AdminSubmissionPage(items=items, total=total, page=page, page_size=page_size)


# --- CSV export (FR-MON-05) -------------------------------------------------

export_router = APIRouter(
    prefix="/admin/export",
    tags=["admin-submissions"],
    dependencies=[Depends(require_role(UserRole.staff, UserRole.admin))],
)

CSV_HEADER = [
    "submission_id",
    "student_id",
    "problem_slug",
    "language",
    "verdict",
    "score",
    "submitted_at",
]


def _score_text(score_milli: Optional[int]) -> str:
    """1500 -> "1.5", None (not judged yet) -> ""."""
    if score_milli is None:
        return ""
    return f"{score_milli / 1000:g}"


@export_router.get("/submissions.csv")
def export_submissions_csv(filters: Filters, db: Db):
    """Raw submissions CSV, same filters as GET /admin/submissions.

    UTF-8 with a BOM so Excel opens Thai names correctly. All rows are read
    before streaming starts, so the generator never touches the database.
    """
    rows = db.execute(
        filtered_query(filters).order_by(
            Submission.created_at.desc(), Submission.id.desc()
        )
    ).all()

    def generate():
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        buffer.write("\ufeff")  # BOM
        writer.writerow(CSV_HEADER)
        for submission, user, problem, max_points in rows:
            writer.writerow(
                [
                    submission.id,
                    user.login_id,
                    problem.slug,
                    submission.language_id,
                    _overall_verdict(submission, max_points) or submission.status.value,
                    _score_text(submission.score_milli),
                    submission.created_at.isoformat(),
                ]
            )
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)
        yield buffer.getvalue()

    filename = f"submissions-{datetime.now():%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )