from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import BigInteger, DateTime, ForeignKey, Sequence, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.models.user import User
from db.session import Base


# Standalone sequence: partitioned tables can't use SERIAL/IDENTITY reliably
# across Postgres versions, so ids come from nextval() as a server default.
logs_id_seq = Sequence("logs_id_seq", metadata=Base.metadata)


class OperationLog(Base):
    __tablename__ = "operation_logs"

    # Extra table arguments for the partitioning strategy
    __table_args__ = (
        {"postgresql_partition_by": "RANGE (created_at)"},
    )

    # Note: created_at must be part of the primary key
    id: Mapped[int] = mapped_column(
        BigInteger,
        logs_id_seq,
        primary_key=True,
        server_default=logs_id_seq.next_value(),
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        primary_key=True,
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
