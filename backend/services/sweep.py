"""Orphan sweep for statement images: removes images nothing links to any more.

Runs weekly from the worker (``worker.py``), in two passes:

1. **Unlinked rows.** An ``Image`` older than ``GRACE`` whose id no statement
   or hint links (``/images/{id}``) loses its row. Every problem's text counts,
   not only its own, because a statement copied from another problem keeps
   the other problem's links.
2. **Files with no row.** An object under ``images/`` in the assets bucket
   older than ``GRACE`` whose key no ``Image`` row holds is deleted. This
   catches the files of pass 1, of deleted problems (their rows cascade away)
   and of uploads that died between the file and the row.

Rows go first and files after, so a crash leaves an unused file and never a
row pointing at nothing (docs/data-and-storage.md). ``GRACE`` covers uploads
still in progress and images inserted in an editor that has not been saved
yet. ``ORPHAN_SWEEP_ENABLED=false`` turns the sweep off, which a restore needs
until the restored data is checked.

    from services import sweep

    with SessionLocal() as db:
        rows, files = sweep.sweep_images(db)
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from db.models.problem import Image, Problem, TestCase
from services import storage

logger = logging.getLogger(__name__)

GRACE = timedelta(hours=24)
IMAGE_PREFIX = "images/"

# The editor writes `/api/images/{id}`. Matching any `/images/{id}` also keeps
# images linked some other way (an absolute URL): matching too much only
# keeps an image, matching too little would delete one.
_IMAGE_LINK = re.compile(r"/images/(\d+)")


def _linked_ids(db: Session) -> set[int]:
    texts = list(db.scalars(select(Problem.statement_md)))
    texts += db.scalars(select(TestCase.hint_md).where(TestCase.hint_md.is_not(None)))
    return {int(match) for text in texts for match in _IMAGE_LINK.findall(text or "")}


def _delete_unlinked_rows(db: Session, cutoff: datetime) -> int:
    linked = _linked_ids(db)
    candidates = db.scalars(select(Image.id).where(Image.created_at < cutoff)).all()
    unlinked = [image_id for image_id in candidates if image_id not in linked]
    if unlinked:
        db.execute(delete(Image).where(Image.id.in_(unlinked)))
        db.commit()
    return len(unlinked)


def _delete_files_without_row(db: Session, cutoff: datetime) -> int:
    # Read the keys after listing: a row committed meanwhile is then still
    # seen, while a file uploaded meanwhile is younger than the cutoff anyway.
    old = [key for key, modified in storage.list_objects(storage.ASSETS, IMAGE_PREFIX) if modified < cutoff]
    if not old:
        return 0
    known = set(db.scalars(select(Image.object_key)).all())
    orphans = [key for key in old if key not in known]
    storage.delete_objects(storage.ASSETS, orphans)
    return len(orphans)


def sweep_images(db: Session) -> tuple[int, int]:
    """Run both passes; returns (rows deleted, files deleted)."""
    cutoff = datetime.now(timezone.utc) - GRACE
    rows = _delete_unlinked_rows(db, cutoff)
    files = _delete_files_without_row(db, cutoff)
    if rows or files:
        logger.info("orphan sweep: deleted %d image rows and %d image files", rows, files)
    return rows, files
