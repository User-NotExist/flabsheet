"""Problems, their immutable versions, per-language limits, test cases and images.

A problem points at its live version through ``current_version_id``. The
composite FK ``(id, current_version_id) -> problem_versions (problem_id, id)``
guarantees that the current version belongs to the same problem. Because
problems and problem_versions reference each other, that FK is created with
``ALTER TABLE`` after both tables exist (``use_alter=True``), and the ORM sets
``current_version_id`` in a second UPDATE (``post_update=True``).

    version = ProblemVersion(problem=problem, version=1, ...)
    db.add(version)
    problem.current_version = version
    db.commit()
"""

from __future__ import annotations

import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Double,
    Enum,
    ForeignKey,
    ForeignKeyConstraint,
    Identity,
    Integer,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.postgres import Base


# CREATE TYPE problem_status AS ENUM ('draft', 'enabled', 'disabled');
class ProblemStatus(str, enum.Enum):
    draft = "draft"
    enabled = "enabled"
    disabled = "disabled"


# CREATE TYPE build_status AS ENUM ('pending', 'building', 'ready', 'failed');
class BuildStatus(str, enum.Enum):
    pending = "pending"
    building = "building"
    ready = "ready"
    failed = "failed"


# CREATE TYPE tc_visibility AS ENUM ('sample', 'visible', 'hidden');
class TestCaseVisibility(str, enum.Enum):
    sample = "sample"
    visible = "visible"
    hidden = "hidden"


problem_status_enum = Enum(
    ProblemStatus,
    name="problem_status",
    values_callable=lambda e: [m.value for m in e],
)
build_status_enum = Enum(
    BuildStatus,
    name="build_status",
    values_callable=lambda e: [m.value for m in e],
)
tc_visibility_enum = Enum(
    TestCaseVisibility,
    name="tc_visibility",
    values_callable=lambda e: [m.value for m in e],
)

MAX_TEST_INPUT_BYTES = 8 * 1024 * 1024  # 8 MiB, keeps packages small enough for the judge
MAX_IMAGE_BYTES = 5 * 1024 * 1024  # 5 MiB per statement image
MAX_HINT_LENGTH = 1000


class Problem(Base):
    __tablename__ = "problems"
    __table_args__ = (
        CheckConstraint(
            r"slug ~ '^[a-z0-9-]{1,64}$'", name="problems_slug_check"
        ),
        CheckConstraint("max_points > 0", name="problems_max_points_check"),
        # current_version_id must belong to the same problem
        ForeignKeyConstraint(
            ["id", "current_version_id"],
            ["problem_versions.problem_id", "problem_versions.id"],
            name="problems_current_version_fk",
            use_alter=True,  # problem_versions doesn't exist yet when problems is created
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    slug: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    statement_md: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=""
    )
    max_points: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="100"
    )
    status: Mapped[ProblemStatus] = mapped_column(
        problem_status_enum, nullable=False, server_default=ProblemStatus.draft.value
    )
    current_version_id: Mapped[Optional[int]] = mapped_column(BigInteger)
    author_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
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

    # problems.id is part of the composite FK too, so both relationships name
    # their foreign key columns explicitly to avoid an ambiguous join.
    versions: Mapped[list["ProblemVersion"]] = relationship(
        back_populates="problem",
        primaryjoin="Problem.id == ProblemVersion.problem_id",
        foreign_keys="ProblemVersion.problem_id",
        order_by="ProblemVersion.version",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    current_version: Mapped[Optional["ProblemVersion"]] = relationship(
        primaryjoin="Problem.current_version_id == ProblemVersion.id",
        foreign_keys=[current_version_id],
        post_update=True,  # break the problems <-> problem_versions insert cycle
    )
    images: Mapped[list["Image"]] = relationship(
        back_populates="problem",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ProblemVersion(Base):
    __tablename__ = "problem_versions"
    __table_args__ = (
        CheckConstraint(
            "time_limit_ms BETWEEN 1 AND 60000",
            name="problem_versions_time_limit_ms_check",
        ),
        CheckConstraint(
            "memory_limit_mb BETWEEN 1 AND 8192",
            name="problem_versions_memory_limit_mb_check",
        ),
        UniqueConstraint("problem_id", "version"),
        UniqueConstraint("problem_id", "id"),  # target of problems_current_version_fk
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    problem_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("problems.id", ondelete="CASCADE"), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    time_limit_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    memory_limit_mb: Mapped[int] = mapped_column(Integer, nullable=False)
    checker_strict: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    float_abs: Mapped[Optional[float]] = mapped_column(Double)
    float_rel: Mapped[Optional[float]] = mapped_column(Double)
    reference_language: Mapped[str] = mapped_column(Text, nullable=False)
    reference_source_key: Mapped[str] = mapped_column(Text, nullable=False)
    package_sha256: Mapped[Optional[str]] = mapped_column(CHAR(64))
    package_key: Mapped[Optional[str]] = mapped_column(Text)
    build_status: Mapped[BuildStatus] = mapped_column(
        build_status_enum, nullable=False, server_default=BuildStatus.pending.value
    )
    build_job_id: Mapped[Optional[str]] = mapped_column(Text)
    build_reason: Mapped[Optional[str]] = mapped_column(Text)
    build_failed_testcase: Mapped[Optional[str]] = mapped_column(Text)
    build_log: Mapped[Optional[str]] = mapped_column(Text)
    max_ref_time_ms: Mapped[Optional[int]] = mapped_column(Integer)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    problem: Mapped[Problem] = relationship(
        back_populates="versions",
        primaryjoin="Problem.id == ProblemVersion.problem_id",
        foreign_keys=[problem_id],
    )
    languages: Mapped[list["ProblemLanguage"]] = relationship(
        back_populates="problem_version",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )
    test_cases: Mapped[list["TestCase"]] = relationship(
        back_populates="problem_version",
        order_by="TestCase.ordinal",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ProblemLanguage(Base):
    __tablename__ = "problem_languages"
    __table_args__ = (
        CheckConstraint(
            "time_limit_ms BETWEEN 1 AND 60000",
            name="problem_languages_time_limit_ms_check",
        ),
    )

    problem_version_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("problem_versions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    language_id: Mapped[str] = mapped_column(Text, primary_key=True)  # e.g. cpp20-gcc13, py312
    # NULL = use the version's time_limit_ms
    time_limit_ms: Mapped[Optional[int]] = mapped_column(Integer)

    problem_version: Mapped[ProblemVersion] = relationship(back_populates="languages")


class TestCase(Base):
    __tablename__ = "test_cases"
    __table_args__ = (
        CheckConstraint(
            f"input_bytes <= {MAX_TEST_INPUT_BYTES}",
            name="test_cases_input_bytes_check",
        ),
        CheckConstraint(
            f"length(hint_md) <= {MAX_HINT_LENGTH}",
            name="test_cases_hint_md_check",
        ),
        UniqueConstraint("problem_version_id", "ordinal"),
        UniqueConstraint("problem_version_id", "name"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    problem_version_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("problem_versions.id", ondelete="CASCADE"),
        nullable=False,
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)  # execution order, 1-based
    name: Mapped[str] = mapped_column(Text, nullable=False)  # file stem in the package: '1', '2', ...
    input_key: Mapped[str] = mapped_column(Text, nullable=False)
    input_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    input_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    # The answer_* columns are filled in after a successful build
    answer_key: Mapped[Optional[str]] = mapped_column(Text)
    answer_sha256: Mapped[Optional[str]] = mapped_column(CHAR(64))
    answer_bytes: Mapped[Optional[int]] = mapped_column(Integer)
    visibility: Mapped[TestCaseVisibility] = mapped_column(
        tc_visibility_enum,
        nullable=False,
        server_default=TestCaseVisibility.hidden.value,
    )
    hint_md: Mapped[Optional[str]] = mapped_column(Text)
    ref_time_ms: Mapped[Optional[int]] = mapped_column(Integer)

    problem_version: Mapped[ProblemVersion] = relationship(back_populates="test_cases")


class Image(Base):
    __tablename__ = "images"
    __table_args__ = (
        CheckConstraint(
            f"bytes <= {MAX_IMAGE_BYTES}", name="images_bytes_check"
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    problem_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("problems.id", ondelete="CASCADE"), nullable=False
    )
    object_key: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    mime: Mapped[str] = mapped_column(Text, nullable=False)
    bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    uploaded_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    problem: Mapped[Problem] = relationship(back_populates="images")
