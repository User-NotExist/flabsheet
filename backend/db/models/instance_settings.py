"""Instance-wide settings: a single row with ``id = 1``.

The row is inserted right after the table is created, so code can always
``db.get(InstanceSettings, 1)`` instead of handling a missing row.

    settings_row = db.get(InstanceSettings, 1)
    settings_row.submissions_open = False
    db.commit()
"""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    SmallInteger,
    Text,
    event,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from db.postgres import Base


# CREATE TYPE leaderboard_mode AS ENUM ('live', 'frozen', 'hidden');
class LeaderboardMode(str, enum.Enum):
    live = "live"
    frozen = "frozen"
    hidden = "hidden"


leaderboard_mode_enum = Enum(
    LeaderboardMode,
    name="leaderboard_mode",
    values_callable=lambda e: [m.value for m in e],
)


class InstanceSettings(Base):
    __tablename__ = "instance_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="instance_settings_id_check"),
    )

    id: Mapped[int] = mapped_column(
        SmallInteger, primary_key=True, autoincrement=False, server_default="1"
    )
    submissions_open: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    submissions_message: Mapped[Optional[str]] = mapped_column(Text)
    leaderboard_mode: Mapped[LeaderboardMode] = mapped_column(
        leaderboard_mode_enum,
        nullable=False,
        server_default=LeaderboardMode.live.value,
    )
    leaderboard_frozen_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True)
    )
    # Standings served while the leaderboard is frozen
    leaderboard_snapshot: Mapped[Optional[Any]] = mapped_column(JSONB)
    updated_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),  # ORM-side; not part of the original DDL
    )


# Runs only when create_all actually creates the table, so it never duplicates the row.
event.listen(
    InstanceSettings.__table__,
    "after_create",
    DDL("INSERT INTO instance_settings DEFAULT VALUES"),
)
