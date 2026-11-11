from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Sequence, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.models.user import User
from db.postgres import Base



class OperationLog(Base):
    __tablename__ = "operation_logs"

    id: Mapped[int] = mapped_column(
        BigInteger,
        primary_key=True,
        autoincrement=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
    # Nullable so system events can be logged and history survives user deletion
    user_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL")
    )
    type: Mapped[str] = mapped_column(Text, nullable=False)
    info: Mapped[Optional[str]] = mapped_column(Text)

    # One-way relationship: User has no `logs` collection, so importing
    # db.models.user alone (cli.py, main.py) still configures mappers cleanly.
    user: Mapped[Optional[User]] = relationship()

# Newest-first log listing
Index("operation_logs_created_at_idx", OperationLog.created_at.desc())
