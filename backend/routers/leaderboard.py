"""The leaderboard (FR-STD-02/03, FR-MON-07).

    GET /leaderboard    standings, shaped for the caller

Students see what the staff chose: the live standings, the snapshot taken at
freeze time, or a 403 (code ``leaderboard_hidden``) while it is hidden. Their
rows carry no student id or login id (FR-STD-03); ``is_me`` marks their own.

Staff and admins always get the live standings with login ids, plus the mode
students are in.

Pages poll this, so the response carries an ETag (``services/etag.py``) and a
request with a matching ``If-None-Match`` gets an empty 304. The mode itself is changed with
``PUT /admin/settings/leaderboard`` (routers/settings.py).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from db.models.instance_settings import InstanceSettings, LeaderboardMode
from db.models.user import UserRole
from db.postgres import get_database
from services import leaderboard
from services.auth import CurrentSession
from services.etag import etag_json
from services.errors import ApiError

router = APIRouter(prefix="/leaderboard", tags=["leaderboard"])

Db = Annotated[DbSession, Depends(get_database)]


class LeaderboardRow(BaseModel):
    rank: int
    display_name: str
    total_milli: int
    solved: int
    is_me: bool
    # Staff and admins only; always null for a student (FR-STD-03)
    login_id: Optional[str] = None


class LeaderboardOut(BaseModel):
    mode: LeaderboardMode
    # Set while frozen: the standings students see are as of this time
    frozen_at: Optional[datetime]
    # True when ``rows`` are the frozen snapshot rather than live standings
    showing_snapshot: bool
    rows: list[LeaderboardRow]


@router.get("", response_model=LeaderboardOut)
def get_leaderboard(request: Request, session: CurrentSession, db: Db):
    settings_row = db.get(InstanceSettings, 1)
    assert settings_row is not None  # seeded when the table is created
    mode = settings_row.leaderboard_mode
    is_staff = session.role in (UserRole.staff, UserRole.admin)

    if is_staff:
        standings, showing_snapshot = leaderboard.live_standings(db), False
    elif mode is LeaderboardMode.hidden:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "The leaderboard is hidden right now.",
            code="leaderboard_hidden",
        )
    elif mode is LeaderboardMode.frozen:
        standings = leaderboard.frozen_standings(db, settings_row.leaderboard_snapshot)
        showing_snapshot = True
    else:
        standings, showing_snapshot = leaderboard.live_standings(db), False

    rows = [
        LeaderboardRow(
            rank=row["rank"],
            display_name=row["display_name"],
            total_milli=row["total_milli"],
            solved=row["solved"],
            is_me=row["user_id"] == session.user_id,
            login_id=row["login_id"] if is_staff else None,
        )
        for row in standings
    ]
    out = LeaderboardOut(
        mode=mode,
        frozen_at=settings_row.leaderboard_frozen_at if mode is LeaderboardMode.frozen else None,
        showing_snapshot=showing_snapshot,
        rows=rows,
    )
    return etag_json(request, out)
