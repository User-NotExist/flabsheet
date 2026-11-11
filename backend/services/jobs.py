"""Hand a background job to the arq worker (``worker.py``) from sync code.

    from services.jobs import enqueue

    db.commit()
    enqueue("start_build", version.id)   # after the commit, never before

Enqueueing is best effort: it returns False instead of raising when Redis is
down. Every job therefore needs a database state the worker's cron can find
and resume (a pending version without a build job, ...), and the enqueue only
makes it start sooner.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from arq import create_pool
from arq.connections import RedisSettings

from config import settings

logger = logging.getLogger(__name__)


def redis_settings() -> RedisSettings:
    redis = RedisSettings.from_dsn(settings.redis_url)
    redis.conn_retries = 1  # a request thread must not wait out arq's 5 retries
    return redis


async def _enqueue(function: str, args: tuple[Any, ...]) -> None:
    pool = await create_pool(redis_settings())
    try:
        await pool.enqueue_job(function, *args)
    finally:
        await pool.aclose()


def enqueue(function: str, *args: Any) -> bool:
    """Queue ``function(*args)`` for the worker. Call from sync code only."""
    try:
        # arq is async-only. Sync handlers run in worker threads without an
        # event loop, so a short-lived loop per call is safe here.
        asyncio.run(_enqueue(function, args))
        return True
    except Exception:
        logger.warning("could not enqueue %s; the worker cron will pick it up", function, exc_info=True)
        return False
