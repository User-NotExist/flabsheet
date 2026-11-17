"""Staff progress view and scores export (FR-MON-01, FR-MON-04).

    GET /admin/progress              students × enabled problems, current scores
    GET /admin/export/scores.csv     the same matrix as a CSV file

Both read ``services/progress.py``, so the page and the file always agree,
and both totals match the leaderboard. The raw submissions export lives in
routers/admin_submissions.py.
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from db.models.user import UserRole
from db.postgres import get_database
from services.auth import require_role
from services.progress import CellState, progress_matrix

router = APIRouter(
    prefix="/admin/progress",
    tags=["progress"],
    dependencies=[Depends(require_role(UserRole.staff, UserRole.admin))],
)
export_router = APIRouter(
    prefix="/admin/export",
    tags=["progress"],
    dependencies=[Depends(require_role(UserRole.staff, UserRole.admin))],
)

Db = Annotated[DbSession, Depends(get_database)]


class ProgressProblemOut(BaseModel):
    id: int
    slug: str
    title: str
    max_points: int


class ProgressCellOut(BaseModel):
    problem_id: int
    score_milli: int
    state: CellState
    submission_id: int


class ProgressRowOut(BaseModel):
    id: int
    login_id: str
    display_name: str
    total_milli: int
    solved: int
    # Only problems with a score; a missing problem is "not attempted"
    cells: list[ProgressCellOut]


class ProgressOut(BaseModel):
    problems: list[ProgressProblemOut]
    rows: list[ProgressRowOut]


@router.get("", response_model=ProgressOut)
def get_progress(db: Db):
    matrix = progress_matrix(db)
    return ProgressOut(
        problems=[ProgressProblemOut(**vars(p)) for p in matrix.problems],
        rows=[
            ProgressRowOut(
                id=s.id,
                login_id=s.login_id,
                display_name=s.display_name,
                total_milli=s.total_milli,
                solved=s.solved,
                cells=[ProgressCellOut(**vars(c)) for c in s.cells],
            )
            for s in matrix.students
        ],
    )


def _points_text(score_milli: Optional[int]) -> str:
    """Exact points: 33333 -> "33.333", 100000 -> "100", None -> "".

    Not ``:g``, which keeps 6 significant digits and would round 1234.567.
    """
    if score_milli is None:
        return ""
    whole, frac = divmod(score_milli, 1000)
    return f"{whole}.{frac:03d}".rstrip("0").rstrip(".") if frac else str(whole)


@export_router.get("/scores.csv")
def export_scores_csv(db: Db):
    """One row per active student: student_id, display_name, one column per
    enabled problem (its slug, holding the current score; 0 when not
    attempted, so spreadsheet formulas never meet a blank) and total.

    UTF-8 with a BOM so Excel opens Thai names correctly. The matrix is read
    before streaming starts, so the generator never touches the database.
    """
    matrix = progress_matrix(db)

    def generate():
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        buffer.write("﻿")  # BOM
        writer.writerow(
            ["student_id", "display_name", *(p.slug for p in matrix.problems), "total"]
        )
        for student in matrix.students:
            scores = {c.problem_id: c.score_milli for c in student.cells}
            writer.writerow(
                [
                    student.login_id,
                    student.display_name,
                    *(_points_text(scores.get(p.id, 0)) for p in matrix.problems),
                    _points_text(student.total_milli),
                ]
            )
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)
        yield buffer.getvalue()

    filename = f"scores-{datetime.now():%Y%m%d-%H%M}.csv"
    return StreamingResponse(
        generate(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
