"""Instance settings every signed-in page reads (``GET /settings``).

The submission killswitch (FR-ADM-05) and the leaderboard mode (FR-MON-07)
live in the single ``instance_settings`` row. Pages poll this endpoint, so it
is one primary-key read and returns nothing role-specific.

``GET /settings/time`` is the server's clock for the top bar. Deadlines and
submission times are the server's, so the bar shows this clock and not the
browser's, which may be wrong or in another time zone.

``PUT /admin/settings/leaderboard`` (staff, admin) sets what students see on
the leaderboard. Freezing stores a snapshot of the standings taken at that
moment; leaving Frozen drops it, so a later freeze takes a new one.

Not here yet: the admin killswitch endpoint (``PUT /admin/settings/submissions``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session as DbSession

from db.models.instance_settings import InstanceSettings, LeaderboardMode
from db.models.user import UserRole
from db.postgres import get_database
from services import leaderboard
from services.auth import CurrentSession, SessionData, require_role
from services.operation_log import log_operation

router = APIRouter(prefix="/settings", tags=["settings"])

Db = Annotated[DbSession, Depends(get_database)]


class SettingsOut(BaseModel):
    submissions_open: bool
    # The admin's message for the banner while submissions are closed
    submissions_message: Optional[str]
    leaderboard_mode: LeaderboardMode
    # Set only while the leaderboard is frozen
    leaderboard_frozen_at: Optional[datetime]


@router.get("", response_model=SettingsOut)
def get_settings(session: CurrentSession, db: Db):
    row = db.get(InstanceSettings, 1)
    assert row is not None  # seeded when the table is created
    return SettingsOut(
        submissions_open=row.submissions_open,
        submissions_message=row.submissions_message,
        leaderboard_mode=row.leaderboard_mode,
        leaderboard_frozen_at=row.leaderboard_frozen_at,
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


# --- changing settings ------------------------------------------------------

admin_router = APIRouter(prefix="/admin/settings", tags=["settings"])

StaffSession = Annotated[SessionData, Depends(require_role(UserRole.staff, UserRole.admin))]


class LeaderboardModeIn(BaseModel):
    mode: LeaderboardMode


class LeaderboardModeOut(BaseModel):
    leaderboard_mode: LeaderboardMode
    leaderboard_frozen_at: Optional[datetime]


@admin_router.put("/leaderboard", response_model=LeaderboardModeOut)
def set_leaderboard_mode(body: LeaderboardModeIn, session: StaffSession, db: Db):
    # Lock the row so two staff freezing at once cannot store two snapshots
    row = db.get(InstanceSettings, 1, with_for_update=True)
    assert row is not None  # seeded when the table is created
    previous = row.leaderboard_mode
    if body.mode is not previous:
        if body.mode is LeaderboardMode.frozen:
            row.leaderboard_frozen_at, row.leaderboard_snapshot = leaderboard.snapshot_now(db)
        else:
            row.leaderboard_frozen_at = None
            row.leaderboard_snapshot = None
        row.leaderboard_mode = body.mode
        row.updated_by = session.user_id
        log_operation(
            db,
            "settings.leaderboard_mode",
            user_id=session.user_id,
            info={"from": previous.value, "to": body.mode.value},
        )
        db.commit()
    # Choosing Frozen again keeps the first freeze time and its snapshot
    return LeaderboardModeOut(
        leaderboard_mode=row.leaderboard_mode,
        leaderboard_frozen_at=row.leaderboard_frozen_at,
    )
