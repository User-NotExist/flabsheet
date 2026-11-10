from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    DDL,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Text,
    event,
    func,
)
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.postgres import Base


# CREATE TYPE user_role AS ENUM ('student', 'staff', 'admin');
class UserRole(str, enum.Enum):
    student = "student"
    staff = "staff"
    admin = "admin"


user_role_enum = Enum(
    UserRole,
    name="user_role",
    values_callable=lambda e: [m.value for m in e],  # store 'student', not 'STUDENT'
)


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            r"login_id ~ '^[A-Za-z0-9._-]{1,64}$'",
            name="users_login_id_check",
        ),
        CheckConstraint(
            "length(display_name) BETWEEN 1 AND 100",
            name="users_display_name_check",
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    login_id: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(user_role_enum, nullable=False)
    # argon2id encoded string: algorithm, cost settings, random 16-byte salt and hash in one value
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    created_by: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("users.id")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),  # ORM-side; not part of the original DDL
    )

    creator: Mapped[Optional["User"]] = relationship(
        remote_side=[id], foreign_keys=[created_by]
    )
    sessions: Mapped[list["Session"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
        passive_deletes=True,  # let ON DELETE CASCADE do the work
    )


class Session(Base):
    __tablename__ = "sessions"

    # SHA-256 of the cookie token, never the token
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    csrf_token: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # created_at + 7 days
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    user: Mapped[User] = relationship(back_populates="sessions")