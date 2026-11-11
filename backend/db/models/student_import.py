from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Integer, func
from sqlalchemy.orm import Mapped, mapped_column

from db.postgres import Base


class StudentImport(Base):
    """One bulk student import run by a staff member.

    Only the row count is kept: the generated passwords are never stored here.
    """

    __tablename__ = "student_imports"

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    staff_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    row_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
