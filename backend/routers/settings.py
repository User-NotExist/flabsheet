"""Instance settings every signed-in page reads (``GET /settings``).

The submission killswitch (FR-ADM-05) and the leaderboard mode (FR-MON-07)
live in the single ``instance_settings`` row. Pages poll this endpoint, so it
is one primary-key read and returns nothing role-specific.

``GET /settings/time`` is the server's clock for the top bar. Deadlines and
submission times are the server's, so the bar shows this clock and not the
browser's, which may be wrong or in another time zone.

``PUT /admin/settings/submissions`` (admin) turns the killswitch on or off.
It takes effect on the next submit, because ``routers/submissions.py`` reads
the row on every request. Both changes are written to the operation log as
``settings.killswitch``.

    PUT /admin/settings/submissions
    {"submissions_open": false, "submissions_message": "Maintenance until 17:00"}

Not here yet: ``PUT /admin/settings/leaderboard`` (staff, admin).
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, StringConstraints
from sqlalchemy.orm import Session as DbSession

from db.models.instance_settings import InstanceSettings, LeaderboardMode
from db.models.user import UserRole
from db.postgres import get_database
from services.auth import CurrentSession, require_role
from services.operation_log import log_operation
from services.session import SessionData

router = APIRouter(prefix="/settings", tags=["settings"])
admin_router = APIRouter(prefix="/admin/settings", tags=["settings"])

Db = Annotated[DbSession, Depends(get_database)]
Admin = Annotated[SessionData, Depends(require_role(UserRole.admin))]

MAX_MESSAGE_LENGTH = 500  # a banner line on every page, not an announcement


class SettingsOut(BaseModel):
    submissions_open: bool
    # The admin's message for the banner while submissions are closed
    submissions_message: Optional[str]
    leaderboard_mode: LeaderboardMode


def _settings_out(row: InstanceSettings) -> SettingsOut:
    return SettingsOut(
        submissions_open=row.submissions_open,
        submissions_message=row.submissions_message,
        leaderboard_mode=row.leaderboard_mode,
    )


@router.get("", response_model=SettingsOut)
def get_settings(session: CurrentSession, db: Db):
    row = db.get(InstanceSettings, 1)
    assert row is not None  # seeded when the table is created
    return _settings_out(row)


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


class SubmissionsIn(BaseModel):
    submissions_open: bool
    # Shown in the banner while closed; blank means no message
    submissions_message: Optional[
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=MAX_MESSAGE_LENGTH)]
    ] = None


@admin_router.put("/submissions", response_model=SettingsOut)
def set_submissions(body: SubmissionsIn, db: Db, session: Admin):
    """Turn the submission killswitch on (``submissions_open: false``) or off.

    Submissions already queued or running are still judged (FR-ADM-05). The
    message only exists while the switch is on: reopening clears it, so an old
    notice never shows up in the next closure.
    """
    # Locked so two admins pressing the switch at once log in a sane order
    row = db.get(InstanceSettings, 1, with_for_update=True)
    assert row is not None  # seeded when the table is created
    message = None if body.submissions_open else (body.submissions_message or None)
    if row.submissions_open != body.submissions_open or row.submissions_message != message:
        row.submissions_open = body.submissions_open
        row.submissions_message = message
        row.updated_by = session.user_id
        log_operation(
            db,
            "settings.killswitch",
            user_id=session.user_id,
            info={"submissions_open": body.submissions_open, "message": message},
        )
        db.commit()
    return _settings_out(row)
