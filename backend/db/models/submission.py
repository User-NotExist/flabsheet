"""Submissions, per-test results, judge event dedup, the outbox and best scores.

Flow: a submission row and its ``judge_outbox`` row are written in one
transaction; a relay pushes the outbox payload to the Redis stream and sets
``sent_at``. Worker events are deduplicated by ``judge_events.event_id`` before
they update ``submissions`` / ``submission_results``. ``problem_scores`` keeps
the score of each user's latest submission per problem
(``submission_created_at`` decides which one is latest when events arrive out
of order).

    sub = Submission(user_id=..., problem_id=..., problem_version_id=..., job_id=ulid, ...)
    db.add(sub)
    db.add(JudgeOutbox(job_id=ulid, stream="judge:practice:1", payload={...}))
    db.commit()
"""

from __future__ import annotations

import enum
from datetime import datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Integer,
    Numeric,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from db.postgres import Base


# CREATE TYPE submission_status AS ENUM ('queued', 'running', 'done');
class SubmissionStatus(str, enum.Enum):
    queued = "queued"
    running = "running"
    done = "done"


submission_status_enum = Enum(
    SubmissionStatus,
    name="submission_status",
    values_callable=lambda e: [m.value for m in e],
)

MAX_SOURCE_BYTES = 64 * 1024  # 64 KiB of source code per submission


class Submission(Base):
    __tablename__ = "submissions"
    __table_args__ = (
        CheckConstraint(
            f"source_bytes <= {MAX_SOURCE_BYTES}",
            name="submissions_source_bytes_check",
        ),
    )

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    problem_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("problems.id", ondelete="RESTRICT"), nullable=False
    )
    problem_version_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("problem_versions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    language_id: Mapped[str] = mapped_column(Text, nullable=False)
    source_key: Mapped[str] = mapped_column(Text, nullable=False)
    source_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    source_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    is_staff: Mapped[bool] = mapped_column(Boolean, nullable=False)
    status: Mapped[SubmissionStatus] = mapped_column(
        submission_status_enum,
        nullable=False,
        server_default=SubmissionStatus.queued.value,
    )
    # Free text rather than an enum so verdicts from a newer worker are kept
    verdict: Mapped[Optional[str]] = mapped_column(Text)
    verdict_unknown: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )
    score_milli: Mapped[Optional[int]] = mapped_column(Integer)
    judge_reason: Mapped[Optional[str]] = mapped_column(Text)  # done.reason for SE / JE
    compile_log: Mapped[Optional[str]] = mapped_column(Text)
    attempt: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="1"
    )
    job_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)  # ULID
    lane: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="practice"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))

    results: Mapped[list["SubmissionResult"]] = relationship(
        back_populates="submission",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class SubmissionResult(Base):
    """One test case result. Rows of an older attempt are cleared on rejudge."""

    __tablename__ = "submission_results"

    submission_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("submissions.id", ondelete="CASCADE"),
        primary_key=True,
    )
    test_case_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("test_cases.id"), primary_key=True
    )
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    time_ms: Mapped[Optional[int]] = mapped_column(Integer)
    memory_kb: Mapped[Optional[int]] = mapped_column(Integer)
    fraction: Mapped[Optional[Decimal]] = mapped_column(Numeric(7, 6))
    checker_msg: Mapped[Optional[str]] = mapped_column(Text)  # ≤ 1 KiB from the judge
    # Only stored for sample and visible cases, so hidden outputs never leak
    output_preview: Mapped[Optional[str]] = mapped_column(Text)
    preview_truncated: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="false"
    )

    submission: Mapped[Submission] = relationship(back_populates="results")


class JudgeEvent(Base):
    """Processed worker events, keyed by the worker's idempotency key."""

    __tablename__ = "judge_events"

    event_id: Mapped[str] = mapped_column(Text, primary_key=True)
    # NULL for build events, which belong to a problem version, not a submission
    submission_id: Mapped[Optional[int]] = mapped_column(
        BigInteger, ForeignKey("submissions.id", ondelete="CASCADE")
    )
    job_id: Mapped[str] = mapped_column(Text, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class JudgeOutbox(Base):
    """Jobs waiting to be pushed to Redis Streams (transactional outbox)."""

    __tablename__ = "judge_outbox"

    id: Mapped[int] = mapped_column(
        BigInteger, Identity(always=True), primary_key=True
    )
    job_id: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    stream: Mapped[str] = mapped_column(Text, nullable=False)  # judge:practice:1, judge:build:_ ...
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    sent_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    tries: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="0"
    )
    last_error: Mapped[Optional[str]] = mapped_column(Text)


class ProblemScore(Base):
    """Current score per (user, problem), read by the leaderboard."""

    __tablename__ = "problem_scores"

    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), primary_key=True
    )
    problem_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("problems.id", ondelete="CASCADE"), primary_key=True
    )
    submission_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("submissions.id"), nullable=False
    )
    # Decides which submission is latest when results arrive out of order
    submission_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    score_milli: Mapped[int] = mapped_column(Integer, nullable=False)
    achieved_at: Mapped[datetime] = mapped_column(  # when this score became current
        DateTime(timezone=True), nullable=False
    )
