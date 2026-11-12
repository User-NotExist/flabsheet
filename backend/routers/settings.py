"""Instance settings every signed-in page reads (``GET /settings``).

The submission killswitch (FR-ADM-05) and the leaderboard mode (FR-MON-07)
live in the single ``instance_settings`` row. Pages poll this endpoint, so it
is one primary-key read and returns nothing role-specific.

``GET /settings/time`` is the server's clock for the top bar. Deadlines and
submission times are the server's, so the bar shows this clock and not the
browser's, which may be wrong or in another time zone.

Not here yet: the admin and staff endpoints that change the settings
(``PUT /admin/settings/submissions``, ``PUT /admin/settings/leaderboard``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from db.models.instance_settings import InstanceSettings, LeaderboardMode
from db.postgres import get_database
from services.auth import CurrentSession

router = APIRouter(prefix="/settings", tags=["settings"])

Db = Annotated[DbSession, Depends(get_database)]


class SettingsOut(BaseModel):
    submissions_open: bool
    # The admin's message for the banner while submissions are closed
    submissions_message: Optional[str]
    leaderboard_mode: LeaderboardMode


@router.get("", response_model=SettingsOut)
def get_settings(session: CurrentSession, db: Db):
    row = db.get(InstanceSettings, 1)
    assert row is not None  # seeded when the table is created
    return SettingsOut(
        submissions_open=row.submissions_open,
        submissions_message=row.submissions_message,
        leaderboard_mode=row.leaderboard_mode,
    )


class TimeOut(BaseModel):
    # Aware, in the server's time zone (the process's TZ, set in the compose files)
    now: datetime
    # Sent apart from ``now`` because JavaScript's Date drops the offset
    utc_offset_minutes: int


@router.get("/time", response_model=TimeOut)
def get_time(session: CurrentSession):
    now = datetime.now().astimezone()
    offset = now.utcoffset()
    assert offset is not None  # astimezone() always returns an aware value
    return TimeOut(now=now, utc_offset_minutes=int(offset.total_seconds() // 60))
