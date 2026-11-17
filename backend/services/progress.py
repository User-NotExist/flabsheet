"""Progress matrix: active students × enabled problems (FR-MON-01, FR-MON-04).

Each cell is the student's current score (``problem_scores``) on one enabled
problem. The problems and students are the same sets the leaderboard ranks
(``services/leaderboard.py``): enabled problems with a built version, and
active students. So a row total here always equals that student's leaderboard
total, which is the FR-MON-01 acceptance check.

A cell's state comes from the score alone: ``solved`` at full points,
``attempted`` with any score row, else ``not_attempted``. A student whose only
submissions are still judging, or under review after a JE, has no score row
yet and shows as not attempted (excluded from scoring, FR-MON-06).

    matrix = progress_matrix(db)
    matrix.problems     # [ProgressProblem], in problem id order (the problem list order)
    matrix.students     # [ProgressStudent], highest total first
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from db.models.problem import Problem, ProblemStatus, ProblemVersion
from db.models.submission import ProblemScore
from db.models.user import User, UserRole

CellState = Literal["not_attempted", "attempted", "solved"]


@dataclass
class ProgressProblem:
    id: int
    slug: str
    title: str
    max_points: int


@dataclass
class ProgressCell:
    problem_id: int
    score_milli: int
    state: CellState
    # The submission that set this score: the one a cell click opens
    submission_id: int


@dataclass
class ProgressStudent:
    id: int
    login_id: str
    display_name: str
    total_milli: int = 0
    solved: int = 0
    cells: list[ProgressCell] = field(default_factory=list)


@dataclass
class ProgressMatrix:
    problems: list[ProgressProblem]
    students: list[ProgressStudent]


def progress_matrix(db: Session) -> ProgressMatrix:
    """Three plain reads (problems, students, scores), joined in Python.

    The score read is bounded by students × enabled problems, which stays in
    the low thousands for a course, so this is cheaper than a pivot in SQL.
    """
    problems = [
        ProgressProblem(id=pid, slug=slug, title=title, max_points=max_points)
        for pid, slug, title, max_points in db.execute(
            select(Problem.id, Problem.slug, Problem.title, ProblemVersion.max_points)
            .join(ProblemVersion, ProblemVersion.id == Problem.current_version_id)
            .where(Problem.status == ProblemStatus.enabled)
            .order_by(Problem.id)
        )
    ]
    students = {
        uid: ProgressStudent(id=uid, login_id=login_id, display_name=name)
        for uid, login_id, name in db.execute(
            select(User.id, User.login_id, User.display_name).where(
                User.role == UserRole.student, User.is_active.is_(True)
            )
        )
    }
    max_by_problem = {p.id: p.max_points for p in problems}
    if max_by_problem and students:
        scores = db.execute(
            select(
                ProblemScore.user_id,
                ProblemScore.problem_id,
                ProblemScore.score_milli,
                ProblemScore.submission_id,
            ).where(ProblemScore.problem_id.in_(max_by_problem))
        )
        for user_id, problem_id, score_milli, submission_id in scores:
            student = students.get(user_id)
            if student is None:  # inactive, or staff (they never get a row anyway)
                continue
            # Same "solved" rule as the leaderboard's solved count
            solved = score_milli >= max_by_problem[problem_id] * 1000
            student.cells.append(
                ProgressCell(
                    problem_id=problem_id,
                    score_milli=score_milli,
                    state="solved" if solved else "attempted",
                    submission_id=submission_id,
                )
            )
            student.total_milli += score_milli
            student.solved += solved
    ordered = sorted(
        students.values(), key=lambda s: (-s.total_milli, s.login_id.lower(), s.id)
    )
    return ProgressMatrix(problems=problems, students=ordered)
