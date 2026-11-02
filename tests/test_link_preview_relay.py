"""Relay forwarding for opt-in link previews: auth, limits, revalidation and privacy."""

import asyncio
import base64
import json
import logging
from pathlib import Path

import pytest
from csrf_client import TestClient
from pydantic import ValidationError
from test_ws_auth import _create_websocket_user, _websocket_token

from app import link_preview
from app.config import Settings, get_settings
from app.main import create_app
from app.routers import link_previews

PNG = (Path(__file__).resolve().parent / "fixtures" / "media" / "valid.png").read_bytes()
SECRET_URL = "https://example.com/private?token=never-log-this"
SERVICE_TOKEN = "s" * 40


@pytest.fixture
def enabled(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "link_preview_service_url", "http://preview.internal:8002")
    monkeypatch.setattr(settings, "link_preview_token", SERVICE_TOKEN)
    monkeypatch.setattr(settings, "link_previews_per_minute", 3)
    monkeypatch.setattr(link_previews, "limiter", link_previews._Limiter())
    calls = []

    async def service(_settings, url):
        calls.append(url)
        return 200, json.dumps({
            "title": "Title‮ <script>alert(1)</script>", "description": "D" * 900,
            "site_name": "Site", "url": "javascript:alert(1)", "final_host": "example.com",
            "image": {"mime": "image/png", "width": 2, "height": 2,
                      "data": base64.b64encode(PNG).decode()},
        }).encode()
    monkeypatch.setattr(link_previews, "request_service", service)
    return calls


def session():
    user, link = asyncio.run(_create_websocket_user())
    return {"Authorization": f"Bearer {_websocket_token(user, link)}"}


def test_previews_are_unavailable_unless_configured():
    auth = session()
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/me", headers=auth).json()["link_previews_available"] is False
        reply = client.post("/api/v1/link-previews", json={"url": "https://example.com/"},
                            headers=auth)
        assert reply.status_code == 404


def test_previews_require_client_authentication(enabled):
    with TestClient(create_app()) as client:
        for headers in ({}, {"Authorization": "Bearer invalid"}):
            reply = client.post("/api/v1/link-previews", json={"url": "https://example.com/"},
                                headers=headers)
            assert reply.status_code in (401, 422)
    assert enabled == []


def test_relay_revalidates_service_output_and_never_caches(enabled):
    auth = session()
    with TestClient(create_app()) as client:
        assert client.get("/api/v1/me", headers=auth).json()["link_previews_available"] is True
        reply = client.post("/api/v1/link-previews", json={"url": "https://example.com/a"},
                            headers=auth)
    assert reply.status_code == 200
    assert reply.headers["cache-control"] == "no-store"
    assert reply.headers["content-type"].startswith("application/json")
    body = reply.json()
    assert body["title"] == "Title <script>alert(1)</script>"
    assert len(body["description"]) == link_preview.FIELD_LIMITS["description"]
    assert body["url"] is None
    assert base64.b64decode(body["image"]["data"]) == PNG
    assert enabled == ["https://example.com/a"]


@pytest.mark.parametrize("image", [
    {"mime": "image/svg+xml", "data": base64.b64encode(b"<svg/>").decode()},
    {"mime": "image/png", "data": "not base64!"},
    {"mime": "image/jpeg", "data": base64.b64encode(PNG).decode()},
    {"mime": "image/png", "data": base64.b64encode(PNG + b"\x00" * (1024 * 1024)).decode()},
    "https://cdn.example/remote.png",
])
def test_relay_drops_unsafe_images_from_the_service(monkeypatch, enabled, image):
    async def service(_settings, url):
        return 200, json.dumps({"title": "T", "image": image}).encode()
    monkeypatch.setattr(link_previews, "request_service", service)
    with TestClient(create_app()) as client:
        reply = client.post("/api/v1/link-previews", json={"url": "https://example.com/"},
                            headers=session())
    assert reply.json()["image"] is None


@pytest.mark.parametrize("url", [
    "http://example.com/", "https://127.0.0.1/", "https://user@example.com/",
    "javascript:alert(1)", "https://localhost/", "https://[::1]/", "x" * 3000,
])
def test_relay_rejects_unsupported_addresses_before_contacting_the_service(enabled, url):
    with TestClient(create_app()) as client:
        reply = client.post("/api/v1/link-previews", json={"url": url}, headers=session())
    assert reply.status_code == 422
    assert enabled == []
    detail = reply.json()["detail"]
    assert detail == "this address cannot be previewed" or detail[0]["type"] == "string_too_long"
    assert url not in reply.text  # Errors never echo the submitted address.


def test_requests_are_rate_limited_per_user(enabled):
    first, second = session(), session()
    with TestClient(create_app()) as client:
        def ask(auth):
            return client.post("/api/v1/link-previews", json={"url": "https://example.com/"},
                               headers=auth).status_code
        assert [ask(first) for _ in range(4)] == [200, 200, 200, 429]
        assert ask(second) == 200


def test_preview_concurrency_is_bounded_separately_from_messaging(enabled):
    from app.guards import SecurityGuards
    reached = []

    async def app(scope, receive, send):
        reached.append(scope["path"])
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    async def call(guards, path, method="POST"):
        statuses = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            if message["type"] == "http.response.start":
                statuses.append(message["status"])
        await guards({"type": "http", "method": method, "path": path, "scheme": "https",
                      "headers": [], "client": ("203.0.113.9", 1), "query_string": b""},
                     receive, send)
        return statuses[0]

    guards = SecurityGuards(app)
    guards.preview_requests = get_settings().link_preview_concurrency
    assert asyncio.run(call(guards, "/api/v1/link-previews")) == 429
    # Busy previews leave message capacity untouched, and vice versa.
    assert asyncio.run(call(guards, "/api/v1/chats/1/messages", "GET")) == 200
    guards.preview_requests = 0
    guards.http_requests = get_settings().max_http_concurrency
    assert asyncio.run(call(guards, "/api/v1/link-previews")) == 200
    assert reached == ["/api/v1/chats/1/messages", "/api/v1/link-previews"]


@pytest.mark.parametrize(("status", "body", "expected"), [
    (422, b'{"error":"blocked_destination"}', 422), (503, b"{}", 503), (504, b"{}", 503),
    (502, b"{}", 502), (200, b"not json", 502), (200, b"[]", 502),
    (200, b'{"title": null, "description": null, "image": null}', 502),
])
def test_service_failures_map_to_generic_errors(monkeypatch, enabled, status, body, expected):
    async def service(_settings, url):
        return status, body
    monkeypatch.setattr(link_previews, "request_service", service)
    with TestClient(create_app()) as client:
        reply = client.post("/api/v1/link-previews", json={"url": SECRET_URL}, headers=session())
    assert reply.status_code == expected
    assert "never-log-this" not in reply.text


def test_transport_failures_do_not_leak_urls_to_responses_or_logs(monkeypatch, enabled, caplog):
    caplog.set_level(logging.DEBUG)

    async def service(_settings, url):
        raise OSError(f"cannot reach preview service for {url}")
    monkeypatch.setattr(link_previews, "request_service", service)
    with TestClient(create_app()) as client:
        reply = client.post("/api/v1/link-previews", json={"url": SECRET_URL}, headers=session())
        invalid = client.post("/api/v1/link-previews",
                              json={"url": SECRET_URL, "extra": SECRET_URL}, headers=session())
    assert reply.status_code == 502 and invalid.status_code == 422
    for text in (reply.text, invalid.text, caplog.text):
        assert "never-log-this" not in text and SERVICE_TOKEN not in text


def test_internal_service_request_is_bounded_and_authenticated(monkeypatch):
    sent = bytearray()

    class Writer:
        def write(self, data):
            sent.extend(data)

        async def drain(self):
            pass

        def close(self):
            pass

    async def connect(host, port):
        assert (host, port) == ("preview.internal", 8002)
        reader = asyncio.StreamReader()
        reader.feed_data(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
        reader.feed_eof()
        return reader, Writer()
    monkeypatch.setattr(asyncio, "open_connection", connect)
    settings = Settings(link_preview_service_url="http://preview.internal:8002",
                        link_preview_token=SERVICE_TOKEN, secret_key="k" * 40)
    status, body = asyncio.run(link_previews.request_service(settings, "https://example.com/"))
    assert (status, body) == (200, b"{}")
    request = bytes(sent)
    assert request.startswith(b"POST /preview HTTP/1.1\r\n")
    assert f"Bearer {SERVICE_TOKEN}\r\n".encode() in request
    assert request.endswith(b'{"url": "https://example.com/"}')


@pytest.mark.parametrize("fields", [
    {"link_preview_service_url": "http://preview:8002"},
    {"link_preview_service_url": "https://preview:8002", "link_preview_token": SERVICE_TOKEN},
    {"link_preview_service_url": "http://user:pass@preview:8002",
     "link_preview_token": SERVICE_TOKEN},
    {"link_preview_service_url": "http://preview", "link_preview_token": SERVICE_TOKEN},
    {"link_preview_service_url": "http://preview:8002/x", "link_preview_token": SERVICE_TOKEN},
    {"link_preview_service_url": "http://preview:8002", "link_preview_token": "short"},
])
def test_preview_configuration_is_validated(fields):
    with pytest.raises(ValidationError):
        Settings(secret_key="k" * 40, **fields)


def test_client_policy_is_unchanged_and_admin_stays_private(enabled):
    with TestClient(create_app(), base_url="https://testserver") as client:
        policy = client.get("/client").headers["content-security-policy"]
    assert "connect-src 'self'" in policy and "img-src 'self' data: blob:" in policy
    from scripts.serve_shared import PublicListener
    blocked = []

    async def app(scope, receive, send):
        blocked.append(scope["path"])

    async def run(path):
        async def receive():
            return {"type": "http.request"}

        async def send(message):
            pass
        await PublicListener(app)({"type": "http", "path": path}, receive, send)
    asyncio.run(run("/api/v1/link-previews"))
    asyncio.run(run("/admin/"))
    assert blocked == ["/api/v1/link-previews"]


def test_opt_in_compose_isolates_the_preview_service():
    import yaml
    root = Path(__file__).resolve().parents[1]
    base = yaml.safe_load((root / "docker-compose.yml").read_text())
    assert set(base["services"]) == {"sideword"} and "networks" not in base["services"]["sideword"]
    override = yaml.safe_load((root / "docker-compose.link-preview.yml").read_text())
    service = override["services"]["link-preview"]
    for absent in ("ports", "volumes", "env_file", "privileged"):
        assert absent not in service
    assert service["read_only"] is True and service["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in service["security_opt"]
    assert service["mem_limit"] and service["pids_limit"] and service["cpus"]
    assert set(service["environment"]) == {"SIDEWORD_LINK_PREVIEW_TOKEN"}
    assert "--no-access-log" in service["command"] and "--factory" in service["command"]
    assert override["networks"]["link-preview-internal"]["internal"] is True
    assert override["networks"]["link-preview-egress"]["enable_ipv6"] is False
    assert override["services"]["sideword"]["networks"] == ["default", "link-preview-internal"]
