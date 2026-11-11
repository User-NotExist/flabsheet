"""Statement images, streamed from storage (``GET /images/{id}``).

The browser never gets a storage URL: RustFS is not reachable from the
internet, so the API streams the bytes. Uploading is in ``routers/problems.py``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session as DbSession

from db.models.problem import Image, Problem, ProblemStatus
from db.models.user import UserRole
from db.postgres import get_database
from services import storage
from services.auth import CurrentSession

router = APIRouter(prefix="/images", tags=["images"])

Db = Annotated[DbSession, Depends(get_database)]


@router.get("/{image_id}")
def get_image(image_id: int, session: CurrentSession, db: Db):
    image = db.get(Image, image_id)
    problem = db.get(Problem, image.problem_id) if image else None
    # Ids are sequential, so a student could walk them: images of problems
    # that are not enabled must look exactly like missing ones.
    visible = problem is not None and (
        session.role is not UserRole.student or problem.status is ProblemStatus.enabled
    )
    if image is None or not visible:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Image not found")

    return StreamingResponse(
        storage.stream(storage.ASSETS, image.object_key),
        media_type=image.mime,
        headers={
            "Content-Length": str(image.bytes),
            # Uploaded by staff, but still served as inert data: no scripts
            # even when the URL is opened directly (NFR-SEC-03).
            "Content-Security-Policy": "sandbox",
            "X-Content-Type-Options": "nosniff",
            # Objects never change, but access depends on the session
            "Cache-Control": "private, max-age=86400, immutable",
        },
    )
