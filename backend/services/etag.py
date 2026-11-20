"""ETag / 304 for JSON responses that clients poll.

The ETag is a hash of the exact body sent to this caller, so it already
covers everything the body depends on (role, ``is_me``, mode, snapshot) and
two viewers share one only when they would get the same bytes. The server
still builds the body; what a 304 saves is sending it and the client's
re-render.

Responses stay ``Cache-Control: private, no-store`` (``services/cache_control.py``):
the client remembers the last body and ETag itself and sends ``If-None-Match``
by hand, and the browser then passes the 304 to the script without storing
anything.

Usage::

    @router.get("", response_model=LeaderboardOut)
    def get_leaderboard(request: Request, ...):
        ...
        return etag_json(request, LeaderboardOut(...))
"""

from __future__ import annotations

import hashlib

from fastapi import Request, Response, status
from pydantic import BaseModel

# 128 bits: enough that two different bodies never share a tag in practice
_HASH_BYTES = 16


def _matches(if_none_match: str, etag: str) -> bool:
    # A list of tags, possibly weak (W/"..."); "*" matches any current body
    for candidate in if_none_match.split(","):
        candidate = candidate.strip()
        if candidate == "*" or candidate.removeprefix("W/") == etag:
            return True
    return False


def etag_json(request: Request, model: BaseModel) -> Response:
    """``model`` as JSON with a strong ETag, or an empty 304 when the client has it."""
    body = model.model_dump_json().encode()
    etag = '"' + hashlib.sha256(body).hexdigest()[: _HASH_BYTES * 2] + '"'
    headers = {"ETag": etag}

    if_none_match = request.headers.get("if-none-match")
    if if_none_match is not None and _matches(if_none_match, etag):
        return Response(status_code=status.HTTP_304_NOT_MODIFIED, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)
