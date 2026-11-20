"""Default ``Cache-Control: private, no-store`` on every response.

Nearly every response depends on the session (role, own submissions, staff
data), and lab computers are shared, so nothing may be kept in the browser's
HTTP cache or its back/forward cache unless a route opts in. Without a header,
browsers are free to apply heuristic caching. A route that sets its own
``Cache-Control`` keeps it (statement images: ``private, max-age=86400,
immutable``; the SSE stream: ``no-cache``).

Written as a pure ASGI middleware rather than ``BaseHTTPMiddleware``, which
buffers through a memory stream and interferes with streaming responses
(SSE, images, CSV exports).

Usage::

    app.add_middleware(DefaultNoStoreMiddleware)
"""

from __future__ import annotations

from starlette.types import ASGIApp, Message, Receive, Scope, Send

DEFAULT_CACHE_CONTROL = b"private, no-store"


class DefaultNoStoreMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_default(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                # ASGI header names are lower-case bytes
                if not any(name == b"cache-control" for name, _ in headers):
                    headers.append((b"cache-control", DEFAULT_CACHE_CONTROL))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_default)
