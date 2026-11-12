"""Problems as the people solving them see them (``GET /problems``, ``GET /problems/{slug}``).

Students get enabled problems only, and of the test data only the sample
cases (FR-STD-01, FR-PRB-10). Staff and admins get the same view of any
problem that has a built version, as a preview (FR-PRB-14); the response then
has ``preview: true`` and the reference solution.

A problem a student may not see answers 404, exactly like a missing one, so
slugs of drafts cannot be probed.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from db.models.problem import (
    Problem,
    ProblemLanguage,
    ProblemStatus,
    ProblemVersion,
    TestCaseVisibility,
)
from db.models.submission import ProblemScore, Submission
from db.models.user import UserRole
from db.postgres import get_database
from services import storage
from services.auth import CurrentSession
from services.languages import LANGUAGES
from services.packages import language_time_limits
from services.session import SessionData

router = APIRouter(prefix="/problems", tags=["solve"])

Db = Annotated[DbSession, Depends(get_database)]

# How much of an input or expected output a page shows. Test inputs may be
# 8 MiB; the judge caps the student's output preview on its side.
VIEW_BYTES = 16 * 1024
_READ_THREADS = 8


class LanguageOut(BaseModel):
    id: str
    display: str


class LanguageLimitOut(LanguageOut):
    time_limit_ms: int


class ProblemListItem(BaseModel):
    slug: str
    title: str
    max_points: int
    languages: list[LanguageOut]
    # The caller's current score (FR-JDG-06); None before the first scored result
    score_milli: Optional[int]
    state: Literal["not_attempted", "attempted", "solved"]


class SampleOut(BaseModel):
    ordinal: int
    input: str
    input_truncated: bool
    expected: str
    expected_truncated: bool


class ReferenceOut(BaseModel):
    language_id: str
    source: str


class ProblemOut(BaseModel):
    id: int
    slug: str
    title: str
    statement_md: str
    status: ProblemStatus
    max_points: int
    memory_limit_mb: int
    checker_strict: bool
    languages: list[LanguageLimitOut]
    samples: list[SampleOut]
    score_milli: Optional[int]
    # True for staff and admins: their submissions here are tests, never ranked
    preview: bool
    reference: Optional[ReferenceOut]  # staff and admins only


def read_text(key: Optional[str], total: Optional[int]) -> tuple[str, bool]:
    """The first ``VIEW_BYTES`` of a stored text file and whether more follows."""
    if not key or not total:
        return "", False
    data = storage.get_bytes(storage.PROBLEMS, key, limit=VIEW_BYTES)
    return data.decode("utf-8", errors="replace"), total > VIEW_BYTES


def language_out(language_id: str) -> LanguageOut:
    known = LANGUAGES.get(language_id)
    return LanguageOut(id=language_id, display=known.display if known else language_id)


def get_solvable_problem(db: DbSession, session: SessionData, slug: str) -> Problem:
    """The problem behind ``slug`` if the caller may open its solve page, else 404."""
    problem = db.scalar(select(Problem).where(Problem.slug == slug))
    visible = problem is not None and (
        session.role is not UserRole.student or problem.status is ProblemStatus.enabled
    )
    if problem is None or not visible:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Problem not found")
    if problem.current_version_id is None:
        # Only staff get here: an enabled problem always has a built version
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "This problem has no built version to preview yet.",
        )
    return problem


@router.get("", response_model=list[ProblemListItem])
def list_problems(session: CurrentSession, db: Db):
    """Enabled problems with the caller's own score and status (FR-STD-01)."""
    rows = db.execute(
        select(Problem, ProblemVersion)
        .join(ProblemVersion, ProblemVersion.id == Problem.current_version_id)
        .where(Problem.status == ProblemStatus.enabled)
        .order_by(Problem.id)
    ).all()

    languages: dict[int, list[str]] = {}
    for version_id, language_id in db.execute(
        select(ProblemLanguage.problem_version_id, ProblemLanguage.language_id)
        .where(ProblemLanguage.problem_version_id.in_([version.id for _, version in rows]))
        .order_by(ProblemLanguage.language_id)
    ):
        languages.setdefault(version_id, []).append(language_id)
    scores = dict(
        db.execute(
            select(ProblemScore.problem_id, ProblemScore.score_milli).where(
                ProblemScore.user_id == session.user_id
            )
        ).all()
    )
    attempted = set(
        db.scalars(
            select(Submission.problem_id)
            .where(Submission.user_id == session.user_id)
            .distinct()
        )
    )

    items = []
    for problem, version in rows:
        score = scores.get(problem.id)
        if score is not None and score >= version.max_points * 1000:
            state = "solved"
        elif problem.id in attempted:
            state = "attempted"
        else:
            state = "not_attempted"
        items.append(
            ProblemListItem(
                slug=problem.slug,
                title=problem.title,
                max_points=version.max_points,
                languages=[language_out(lang) for lang in languages.get(version.id, [])],
                score_milli=score,
                state=state,
            )
        )
    return items


@router.get("/{slug}", response_model=ProblemOut)
def get_problem(slug: str, session: CurrentSession, db: Db):
    """Statement, limits, languages and the sample cases. Never any other test data."""
    problem = get_solvable_problem(db, session, slug)
    version = problem.current_version
    assert version is not None
    staff = session.role is not UserRole.student

    samples = [c for c in version.test_cases if c.visibility is TestCaseVisibility.sample]
    with ThreadPoolExecutor(_READ_THREADS) as pool:
        inputs = list(pool.map(lambda c: read_text(c.input_key, c.input_bytes), samples))
        answers = list(pool.map(lambda c: read_text(c.answer_key, c.answer_bytes), samples))
        reference = (
            pool.submit(storage.get_bytes, storage.PROBLEMS, version.reference_source_key).result()
            if staff
            else None
        )

    limits = language_time_limits(version)
    return ProblemOut(
        id=problem.id,
        slug=problem.slug,
        title=problem.title,
        statement_md=problem.statement_md,
        status=problem.status,
        max_points=version.max_points,
        memory_limit_mb=version.memory_limit_mb,
        checker_strict=version.checker_strict,
        languages=[
            LanguageLimitOut(**language_out(language_id).model_dump(), time_limit_ms=time_ms)
            for language_id, time_ms in limits.items()
        ],
        samples=[
            SampleOut(
                ordinal=case.ordinal,
                input=text,
                input_truncated=text_cut,
                expected=answer,
                expected_truncated=answer_cut,
            )
            for case, (text, text_cut), (answer, answer_cut) in zip(samples, inputs, answers)
        ],
        score_milli=db.scalar(
            select(ProblemScore.score_milli).where(
                ProblemScore.user_id == session.user_id,
                ProblemScore.problem_id == problem.id,
            )
        ),
        preview=staff,
        reference=(
            ReferenceOut(
                language_id=version.reference_language,
                source=reference.decode("utf-8", errors="replace"),
            )
            if reference is not None
            else None
        ),
    )
