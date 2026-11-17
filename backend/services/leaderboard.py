"""Leaderboard standings (FR-STD-02/03, FR-MON-07).

Standings rank every active student by total score: the sum of their current
score (``problem_scores``) over enabled problems. Ties go to whoever reached
the total first, which is the latest ``achieved_at`` among the problems that
add to it. Students with nothing scored share the last rank.

Staff test submissions never get a ``problem_scores`` row, so they cannot rank.

    rows = live_standings(db)          # cached in Redis for 5 s
    rows = compute_standings(db)       # fresh, e.g. for the freeze snapshot

Each row is a JSON-ready dict with the student's id and login id; the router
strips both before a student sees the list (FR-STD-03). The frozen snapshot in
``instance_settings.leaderboard_snapshot`` stores the same rows.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Optional

import redis
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from db.models.problem import Problem, ProblemStatus, ProblemVersion
from db.models.submission import ProblemScore
from db.models.user import User, UserRole
from db.redis import redis_client

logger = logging.getLogger(__name__)

CACHE_KEY = "lb:cache"
CACHE_TTL_SECONDS = 5  # NFR-PERF-05: recomputed at most every 5 s under load

Standing = dict[str, Any]


def compute_standings(db: Session) -> list[Standing]:
    """One query over active students × enabled problems, ranked."""
    # Only enabled problems with a built version count; the join filter keeps
    # students with no scores in the result (LEFT JOIN).
    enabled = (
        select(Problem.id.label("problem_id"), ProblemVersion.max_points)
        .join(ProblemVersion, ProblemVersion.id == Problem.current_version_id)
        .where(Problem.status == ProblemStatus.enabled)
        .subquery()
    )
    scored = (
        select(ProblemScore.user_id, ProblemScore.score_milli, ProblemScore.achieved_at, enabled.c.max_points)
        .join(enabled, enabled.c.problem_id == ProblemScore.problem_id)
        .subquery()
    )
    total = func.coalesce(func.sum(scored.c.score_milli), 0)
    solved = func.count().filter(scored.c.score_milli >= scored.c.max_points * 1000)
    # A zero score adds nothing to the total, so it must not move the tie time
    reached_at = func.max(case((scored.c.score_milli > 0, scored.c.achieved_at)))
    rows = db.execute(
        select(User.id, User.login_id, User.display_name, total, solved, reached_at)
        .outerjoin(scored, scored.c.user_id == User.id)
        .where(and_(User.role == UserRole.student, User.is_active.is_(True)))
        .group_by(User.id)
    ).all()
    standings = [
        {
            "user_id": user_id,
            "login_id": login_id,
            "display_name": display_name,
            "total_milli": int(total_milli),
            "solved": int(solved_count),
            "reached_at": reached.isoformat() if reached is not None else None,
        }
        for user_id, login_id, display_name, total_milli, solved_count, reached in rows
    ]
    return rank(standings)


def _sort_key(row: Standing) -> tuple[int, int, float]:
    reached = row["reached_at"]
    # Compared as instants, not strings: the offset in the ISO text may differ
    if reached is None:
        return (-row["total_milli"], 1, 0.0)  # no time sorts last
    return (-row["total_milli"], 0, datetime.fromisoformat(reached).timestamp())


def rank(rows: list[Standing]) -> list[Standing]:
    """Sort and number ``rows``; equal total and tie time share a rank."""
    ordered = sorted(rows, key=lambda r: (*_sort_key(r), r["display_name"], r["user_id"]))
    previous: Optional[tuple[int, int, float]] = None
    current_rank = 0
    for position, row in enumerate(ordered, start=1):
        key = _sort_key(row)
        if key != previous:
            current_rank, previous = position, key
        row["rank"] = current_rank
    return ordered


def live_standings(db: Session) -> list[Standing]:
    """The current standings, from the 5 s Redis cache when it has them."""
    try:
        cached = redis_client.get(CACHE_KEY)
        if cached is not None:
            return json.loads(cached)
    except (redis.RedisError, ValueError):
        logger.warning("could not read the leaderboard cache", exc_info=True)
    standings = compute_standings(db)
    try:
        redis_client.set(CACHE_KEY, json.dumps(standings), ex=CACHE_TTL_SECONDS)
    except redis.RedisError:
        logger.warning("could not cache the leaderboard", exc_info=True)
    return standings


def frozen_standings(db: Session, snapshot: Optional[list[Standing]]) -> list[Standing]:
    """The snapshot taken at freeze time, minus students deactivated since.

    Scores stay as they were at the freeze (FR-MON-07), but a deactivated
    student leaves the board at once (FR-STU-06), so the rest are re-ranked.
    """
    if not snapshot:
        return []
    active = set(
        db.scalars(
            select(User.id).where(
                User.id.in_([row["user_id"] for row in snapshot]),
                User.is_active.is_(True),
            )
        )
    )
    return rank([dict(row) for row in snapshot if row["user_id"] in active])


def snapshot_now(db: Session) -> tuple[datetime, list[Standing]]:
    """Fresh standings for a freeze, bypassing the cache so nothing is 5 s old."""
    frozen_at = db.scalar(select(func.now()))
    assert frozen_at is not None
    return frozen_at, compute_standings(db)
