"""Authenticated, rate-limited forwarding to the isolated link-preview service.

The relay never fetches the requested URL itself, stores no results and logs no URLs.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import time
from urllib.parse import urlsplit

import h11
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings, get_settings
from ..deps import get_current_user
from ..link_preview import (
    FIELD_LIMITS,
    MAX_IMAGE_BYTES,
    MAX_URL_LENGTH,
    PreviewError,
    clean_text,
    exchange,
    inspect_image,
    validate_url,
)
from ..models import User

router = APIRouter(prefix="/api/v1", tags=["link-previews"])

SERVICE_DEADLINE_SECONDS = 15
MAX_SERVICE_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_TRACKED_USERS = 10000


class LinkPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str = Field(min_length=1, max_length=MAX_URL_LENGTH)


class _Limiter:
    """Per-process user rate limit; state holds user IDs only. Concurrency is in guards."""

    def __init__(self):
        self.requests: dict[int, list[float]] = {}

    def allow(self, user_id: int, per_minute: int) -> bool:
        now = time.monotonic()
        self.requests = {key: [t for t in times if t > now - 60]
                         for key, times in self.requests.items()}
        self.requests = {key: times for key, times in self.requests.items() if times}
        recent = self.requests.get(user_id, [])
        if len(recent) >= per_minute or (user_id not in self.requests
                                         and len(self.requests) >= MAX_TRACKED_USERS):
            return False
        self.requests[user_id] = [*recent, now]
        return True


limiter = _Limiter()


async def request_service(settings: Settings, url: str) -> tuple[int, bytes]:
    """POST one URL to the configured internal service over a bounded HTTP/1.1 exchange."""

    service = urlsplit(settings.link_preview_service_url)
    async with asyncio.timeout(SERVICE_DEADLINE_SECONDS):
        reader, writer = await asyncio.open_connection(service.hostname, service.port)
        try:
            response = await exchange(
                reader, writer, method="POST", host=service.netloc, target="/preview",
                headers=[("Authorization", f"Bearer {settings.link_preview_token}"),
                         ("Content-Type", "application/json")],
                body=json.dumps({"url": url}).encode(), max_body=MAX_SERVICE_RESPONSE_BYTES)
        finally:
            writer.close()
    if response.truncated:
        raise PreviewError("fetch_failed")
    return response.status, response.body


def _text(value: object, limit: int) -> str | None:
    return clean_text(value, limit) if isinstance(value, str) else None


def checked_result(data: object) -> dict:
    """Revalidate service output: plain bounded text, an HTTPS URL and a checked image."""

    if not isinstance(data, dict):
        raise PreviewError("fetch_failed")
    url = data.get("url")
    try:
        url = validate_url(url).url if url is not None else None
    except PreviewError:
        url = None
    final_host = data.get("final_host")
    try:
        final_host = (validate_url(f"https://{final_host}/").host
                      if isinstance(final_host, str) else None)
    except PreviewError:
        final_host = None
    image = data.get("image")
    checked_image = None
    if (isinstance(image, dict) and isinstance(image.get("data"), str)
            and isinstance(image.get("mime"), str)):
        try:
            raw = base64.b64decode(image["data"], validate=True)
        except (binascii.Error, ValueError):
            raw = b""
        if len(raw) <= MAX_IMAGE_BYTES and (info := inspect_image(raw, image["mime"])):
            checked_image = {"mime": info[0], "width": info[1], "height": info[2],
                             "data": image["data"]}
    result = {
        "title": _text(data.get("title"), FIELD_LIMITS["title"]),
        "description": _text(data.get("description"), FIELD_LIMITS["description"]),
        "site_name": _text(data.get("site_name"), FIELD_LIMITS["site_name"]),
        "url": url, "final_host": final_host, "image": checked_image,
    }
    if not (result["title"] or result["description"] or checked_image):
        raise PreviewError("no_metadata")
    return result


@router.post("/link-previews")
async def link_preview(payload: LinkPreviewRequest,
                       user: User = Depends(get_current_user)) -> JSONResponse:
    settings = get_settings()
    if not settings.link_previews_enabled:
        raise HTTPException(404, "link previews are not enabled on this server")
    try:
        validate_url(payload.url)
    except PreviewError as exc:
        raise HTTPException(422, "this address cannot be previewed") from exc
    if not limiter.allow(user.id, settings.link_previews_per_minute):
        raise HTTPException(429, "preview rate exceeded; retry later",
                            headers={"Retry-After": "60"})
    try:
        status, body = await request_service(settings, payload.url)
        if status == 422:
            raise HTTPException(422, "this address cannot be previewed")
        if status in (503, 504):
            raise HTTPException(503, "preview unavailable; retry later")
        if status != 200:
            raise HTTPException(502, "preview unavailable")
        result = checked_result(json.loads(body))
    except (OSError, TimeoutError, ValueError, PreviewError, h11.ProtocolError) as exc:
        # Generic detail only: errors can contain the requested address.
        raise HTTPException(502, "preview unavailable") from exc
    return JSONResponse(result, headers={"Cache-Control": "no-store"})
