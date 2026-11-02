"""Isolated link-preview service: run as a separate process with restricted egress.

Start with ``uvicorn --factory app.preview_service:create_preview_app``. It holds only its
service token; it has no database, relay secrets or client credentials, and never logs
requested URLs or fetched content.
"""

from __future__ import annotations

import base64
import hmac
import json
import os

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from .link_preview import PreviewError, build_preview

TOKEN_ENV = "SIDEWORD_LINK_PREVIEW_TOKEN"
MAX_REQUEST_BYTES = 4096
DEFAULT_CONCURRENCY = 4
CLIENT_ERRORS = frozenset({"invalid_url"})
HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def _error(code: str, status: int) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status, headers=HEADERS)


def create_preview_app(token: str | None = None, *, builder=build_preview,
                       concurrency: int = DEFAULT_CONCURRENCY) -> Starlette:
    token = token if token is not None else os.environ.get(TOKEN_ENV, "")
    if len(token) < 32 or not token.isascii():
        raise RuntimeError(f"{TOKEN_ENV} must contain at least 32 ASCII characters")
    expected = f"Bearer {token}".encode()
    active = 0

    async def preview(request: Request) -> JSONResponse:
        nonlocal active
        supplied = request.headers.get("authorization", "").encode("latin-1", "replace")
        if not hmac.compare_digest(supplied, expected):
            return _error("unauthorized", 401)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                return _error("request_too_large", 413)
        try:
            url = json.loads(body)["url"]
        except (ValueError, TypeError, KeyError):
            return _error("invalid_request", 422)
        if active >= concurrency:
            return _error("busy", 503)
        active += 1
        try:
            result = await builder(url)
        except PreviewError as exc:
            if exc.code in CLIENT_ERRORS:
                return _error(exc.code, 422)
            # Blocked DNS answers look like any failed fetch, so callers cannot map internal names.
            return _error("fetch_failed" if exc.code == "blocked_destination" else exc.code, 502)
        except TimeoutError:
            return _error("timeout", 504)
        except Exception:  # Details may contain the URL; return only a generic code.
            return _error("fetch_failed", 502)
        finally:
            active -= 1
        image = result.get("image")
        if image:
            image = {**image, "data": base64.b64encode(image["data"]).decode("ascii")}
        return JSONResponse({**result, "image": image}, headers=HEADERS)

    async def health(_: Request) -> JSONResponse:
        return JSONResponse({"status": "ok"}, headers=HEADERS)

    return Starlette(routes=[Route("/preview", preview, methods=["POST"]),
                             Route("/health", health, methods=["GET"])])
