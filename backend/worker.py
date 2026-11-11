"""Background worker: the second process of the backend, run by arq.

    uv run arq worker.WorkerSettings

Jobs are thin async wrappers around the sync functions in ``services/``; they
run in a thread, because the services use sync SQLAlchemy, redis-py and boto3.
The API enqueues ``start_build`` and ``assemble_package`` (``services/jobs.py``)
so they start at once; the two crons re-send and resume whatever was lost, so
every job here is safe to run twice.

The schema is created by ``main.py``: start the API once before the worker on
an empty database.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from arq import cron

# Every model, so SQLAlchemy can resolve foreign keys between their tables
import db.models.instance_settings  # noqa: F401
import db.models.operation_log  # noqa: F401
import db.models.problem  # noqa: F401
import db.models.student_import  # noqa: F401
import db.models.submission  # noqa: F401
import db.models.user  # noqa: F401
from db.postgres import SessionLocal
from services import judge, packages
from services.jobs import redis_settings

logger = logging.getLogger(__name__)

EVERY_5_SECONDS = set(range(0, 60, 5))


async def start_build(ctx: dict[str, Any], version_id: int) -> None:
    await asyncio.to_thread(packages.start_build, version_id)


async def assemble_package(ctx: dict[str, Any], version_id: int) -> None:
    await asyncio.to_thread(packages.assemble_package, version_id)


def _flush_outbox() -> None:
    with SessionLocal() as db:
        judge.flush_outbox(db)


async def flush_outbox(ctx: dict[str, Any]) -> None:
    """Re-send judge jobs that were committed while Redis was unreachable."""
    await asyncio.to_thread(_flush_outbox)


def _resume_builds() -> None:
    with SessionLocal() as db:
        to_start = packages.pending_build_ids(db)
        to_assemble = packages.pending_assembly_ids(db)
    # One failure (storage down, a broken version) must not block the others
    for step, ids in ((packages.start_build, to_start), (packages.assemble_package, to_assemble)):
        for version_id in ids:
            try:
                step(version_id)
            except Exception:
                logger.warning("%s(%s) failed; retrying on the next run", step.__name__, version_id, exc_info=True)


async def resume_builds(ctx: dict[str, Any]) -> None:
    """Start builds and assemble packages whose enqueued job was lost or failed."""
    await asyncio.to_thread(_resume_builds)


async def _quiet_cron_logs(ctx: dict[str, Any]) -> None:
    # arq logs the start and end of every job at INFO, which for two crons is
    # four lines every 5 s; the services log what actually happened.
    logging.getLogger("arq.worker").setLevel(logging.WARNING)
    logging.getLogger("services").setLevel(logging.INFO)


class WorkerSettings:
    on_startup = _quiet_cron_logs
    functions = [start_build, assemble_package]
    cron_jobs = [
        cron(flush_outbox, second=EVERY_5_SECONDS),
        cron(resume_builds, second=EVERY_5_SECONDS),
    ]
    redis_settings = redis_settings()
    # Package jobs hold whole test files in memory (up to 8 MiB each)
    max_jobs = 4
    # A failed job is not retried by arq: resume_builds picks the version up
    max_tries = 1
    job_timeout = 600
