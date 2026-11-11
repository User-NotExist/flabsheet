"""API errors that carry a machine-readable ``code`` next to ``detail``.

Plain ``HTTPException`` answers ``{"detail": "Sentence."}``, which the frontend
shows to the user as is. Raise :class:`ApiError` instead when the UI has to
react to *which* error it was (disable a button, show a banner) and the HTTP
status alone does not say: the body becomes
``{"detail": "Sentence.", "code": "snake_case_code"}``.

    from services.errors import ApiError

    raise ApiError(status.HTTP_403_FORBIDDEN, "Submissions are closed.", code="submissions_closed")

Codes are part of the API contract: the frontend matches on them, so never
rename one. ``main.py`` registers :func:`api_error_handler`.
"""

from __future__ import annotations

from typing import Mapping, Optional

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


class ApiError(HTTPException):
    def __init__(
        self,
        status_code: int,
        detail: str,
        *,
        code: str,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        super().__init__(status_code, detail, headers=dict(headers) if headers else None)
        self.code = code


def api_error_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, ApiError)  # registered for ApiError only
    return JSONResponse(
        {"detail": exc.detail, "code": exc.code},
        status_code=exc.status_code,
        headers=exc.headers,
    )
