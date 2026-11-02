"""Isolated link-preview fetcher: SSRF, parsing, image, timeout and leakage controls."""

import asyncio
import base64
import gzip
import logging
import struct
import zlib
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from app import link_preview as lp
from app.preview_service import create_preview_app

MEDIA = Path(__file__).resolve().parent / "fixtures" / "media"
PNG = (MEDIA / "valid.png").read_bytes()
TOKEN = "t" * 40
SECRET_URL = "https://example.com/private?token=never-log-this"


class FakeWriter:
    def __init__(self, peer):
        self.sent = bytearray()
        self.closed = False
        self.peer = peer

    def write(self, data):
        self.sent.extend(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass

    def get_extra_info(self, name):
        return (self.peer, 443) if name == "peername" else None


class FakeNet:
    """Serves canned responses keyed by Host; records resolutions and pinned connections."""

    def __init__(self, routes, dns=None, hang=False):
        self.routes = routes
        self.dns = dns or {}
        self.resolved = []
        self.connections = []
        self.writers = []
        self.hang = hang

    async def resolve(self, host):
        self.resolved.append(host)
        return self.dns.get(host, ["93.184.216.34"])

    async def connect(self, address, server_name):
        self.connections.append((address, server_name))
        reader = asyncio.StreamReader()
        writer = FakeWriter(address)
        self.writers.append(writer)
        if not self.hang:
            reader.feed_data(self.routes.get(server_name, response(404, b"")))
            reader.feed_eof()
        return reader, writer


def response(status, body, headers=(("Content-Type", "text/html; charset=utf-8"),),
             chunked=False):
    lines = [f"HTTP/1.1 {status} X".encode()]
    lines += [f"{name}: {value}".encode() for name, value in headers]
    if chunked:
        lines.append(b"Transfer-Encoding: chunked")
        payload = b"".join(b"%x\r\n%s\r\n" % (len(body[i:i + 4096]), body[i:i + 4096])
                           for i in range(0, len(body), 4096)) + b"0\r\n\r\n"
    else:
        lines.append(f"Content-Length: {len(body)}".encode())
        payload = body
    return b"\r\n".join(lines) + b"\r\n\r\n" + payload


def page(head):
    return f"<!doctype html><html><head>{head}</head><body>x</body></html>".encode()


def preview(url, net):
    return asyncio.run(lp.build_preview(url, resolver=net.resolve, connector=net.connect))


def code_of(url, net):
    with pytest.raises(lp.PreviewError) as error:
        preview(url, net)
    return error.value.code


@pytest.mark.parametrize("url", [
    "http://example.com/", "ftp://example.com/", "javascript:alert(1)", "data:text/html,x",
    "https://user:pass@example.com/", "https://user@example.com/", "https://example.com:8443/",
    "https://example.com:0/", "https://localhost/", "https://foo.localhost/",
    "https://metadata.google.internal/latest", "https://127.1/", "https://2130706433/",
    "https://0x7f000001/", "https://0177.0.0.1/", "https://%31%32%37.0.0.1/",
    "https://exa%2emple.com/", "https://example.com\\@evil.com/", "https://exa mple.com/",
    "https://example.com/\x00", "https://exämple.com/", "https:///path", "https://[::1/",
    "https://singlelabel/", "https://-bad-.com/", "https://" + "a" * 2050 + ".com/", "", None, 7,
])
def test_rejects_unsupported_malformed_and_encoded_urls(url):
    with pytest.raises(lp.PreviewError) as error:
        lp.validate_url(url)
    assert error.value.code in {"invalid_url", "blocked_destination"}


@pytest.mark.parametrize("url", [
    "https://127.0.0.1/", "https://10.0.0.1/", "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/", "https://192.168.1.1/", "https://172.16.0.1/", "https://0.0.0.0/",
    "https://224.0.0.1/", "https://255.255.255.255/", "https://198.18.0.1/",
    "https://[::1]/", "https://[::]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:a9fe:a9fe]/",
    "https://[fe80::1]/", "https://[fc00::1]/", "https://[fd00:ec2::254]/", "https://[ff02::1]/",
    "https://[2002:7f00:1::]/", "https://[64:ff9b::a9fe:a9fe]/", "https://[2001:0:4136::1]/",
])
def test_rejects_private_and_embedded_ip_literals(url):
    with pytest.raises(lp.PreviewError) as error:
        lp.validate_url(url)
    assert error.value.code == "blocked_destination"


def test_normalizes_supported_urls_and_drops_fragments():
    target = lp.validate_url("HTTPS://Example.COM./a%20b?q=1#secret")
    assert (target.host, target.target, target.url) == (
        "example.com", "/a%20b?q=1", "https://example.com/a%20b?q=1")
    assert lp.validate_url("https://[2606:4700::1111]/").url == "https://[2606:4700::1111]/"


@pytest.mark.parametrize("answers", [
    ["127.0.0.1"], ["10.1.2.3"], ["169.254.169.254"], ["::1"], ["fe80::1%eth0"],
    ["::ffff:10.0.0.1"], ["93.184.216.34", "192.168.0.1"], ["not-an-ip"],
])
def test_dns_answers_must_all_be_public(answers):
    net = FakeNet({}, dns={"example.com": answers})
    assert code_of("https://example.com/", net) == "blocked_destination"
    assert net.connections == []


def test_connections_are_pinned_to_validated_addresses_against_dns_rebinding():
    answers = iter([["93.184.216.34"], ["127.0.0.1"]])

    class Rebinding(FakeNet):
        async def resolve(self, host):
            self.resolved.append(host)
            return next(answers)

    net = Rebinding({"example.com": response(200, page("<title>Pinned</title>"))})
    assert preview("https://example.com/", net)["title"] == "Pinned"
    # One resolution, one connection to that exact address with TLS SNI for the host.
    assert net.resolved == ["example.com"]
    assert net.connections == [("93.184.216.34", "example.com")]
    request = bytes(net.writers[0].sent)
    assert request.startswith(b"GET / HTTP/1.1\r\n") and b"host: example.com\r\n" in request.lower()
    for header in (b"cookie", b"authorization", b"proxy", b"x-forwarded"):
        assert header not in request.lower()
    assert b"accept-encoding: identity" in request.lower()


def test_pinned_connector_rejects_peer_address_mismatch(monkeypatch):
    async def connected(*args, **kwargs):
        return asyncio.StreamReader(), FakeWriter("10.0.0.1")
    monkeypatch.setattr(asyncio, "open_connection", connected)
    with pytest.raises(lp.PreviewError) as error:
        asyncio.run(lp.pinned_tls_connector("93.184.216.34", "example.com"))
    assert error.value.code == "blocked_destination"


def test_proxy_environment_is_ignored(monkeypatch):
    for name in ("HTTPS_PROXY", "https_proxy", "ALL_PROXY", "HTTP_PROXY"):
        monkeypatch.setenv(name, "http://10.0.0.1:3128")
    net = FakeNet({"example.com": response(200, page("<title>Direct</title>"))})
    assert preview("https://example.com/", net)["title"] == "Direct"
    assert net.connections == [("93.184.216.34", "example.com")]


@pytest.mark.parametrize("location", [
    "http://example.org/", "https://127.0.0.1/", "https://169.254.169.254/latest",
    "https://[::1]/", "https://localhost/", "https://user@example.org/", "//10.0.0.1/",
    "https://example.org:22/", "javascript:alert(1)",
])
def test_redirects_are_revalidated_before_connecting(location):
    net = FakeNet({"example.com": response(302, b"", headers=(("Location", location),))})
    assert code_of("https://example.com/", net) in {"invalid_url", "blocked_destination"}
    assert [address for address, _ in net.connections] == ["93.184.216.34"]


def test_redirect_to_private_dns_answer_is_blocked():
    net = FakeNet({"example.com": response(301, b"", headers=(("Location", "https://evil.test.example/"),))},
                  dns={"rebind.example.net": ["10.0.0.5"]})
    net.routes["example.com"] = response(301, b"", headers=(("Location", "https://rebind.example.net/"),))
    assert code_of("https://example.com/", net) == "blocked_destination"
    assert net.resolved == ["example.com", "rebind.example.net"]
    assert len(net.connections) == 1


def test_redirect_count_is_bounded_and_relative_redirects_work():
    loop = {"example.com": response(302, b"", headers=(("Location", "/again"),))}
    assert code_of("https://example.com/", FakeNet(loop)) == "fetch_failed"
    net = FakeNet({"example.com": response(302, b"", headers=(("Location", "https://www.example.org/x"),)),
                   "www.example.org": response(200, page("<title>Moved</title>"))})
    result = preview("https://example.com/", net)
    assert result["title"] == "Moved" and result["final_host"] == "www.example.org"


def test_extracts_open_graph_fields_with_fallbacks_and_bounds():
    head = ('<meta property="og:title" content="  OG &amp; title‮\x07 ">'
            '<meta property="og:description" content="' + "d" * 2000 + '">'
            '<meta property="og:site_name" content="Site">'
            '<meta property="og:url" content="/canonical">'
            '<title>Ignored title</title>')
    net = FakeNet({"example.com": response(200, page(head))})
    result = preview("https://example.com/page", net)
    assert result["title"] == "OG & title"
    assert len(result["description"]) == lp.FIELD_LIMITS["description"]
    assert result["description"].endswith("…")
    assert (result["site_name"], result["url"]) == ("Site", "https://example.com/canonical")
    fallback = FakeNet({"example.com": response(200, page(
        '<TITLE>Plain title</TITLE><meta name="Description" content="Meta description">'))})
    result = preview("https://example.com/", fallback)
    assert (result["title"], result["description"]) == ("Plain title", "Meta description")
    # Newer parsers keep <title> content as raw text (HTML spec); older ones drop inner tags.
    # Either way the result is plain text that clients render with textContent.
    marked = FakeNet({"example.com": response(200, page("<title>Plain <b>title</b></title>"))})
    assert preview("https://example.com/", marked)["title"] in {"Plain title", "Plain <b>title</b>"}


def test_metadata_injection_stays_plain_text():
    head = ('<meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;">'
            '<meta property="og:description" content="<img src=x onerror=alert(1)>">'
            '<meta property="og:url" content="javascript:alert(1)">'
            '<script>document.title="<title>x</title>"</script>')
    result = preview("https://example.com/", FakeNet({"example.com": response(200, page(head))}))
    assert result["title"] == "<script>alert(1)</script>"
    assert result["description"] == "<img src=x onerror=alert(1)>"
    assert result["url"] is None
    assert set(result) == {"title", "description", "site_name", "url", "final_host", "image"}


@pytest.mark.parametrize("html", [
    b"<html><head><meta property='og:title' content='Unclosed",
    b"<meta property=og:title content=Bare><meta property=og:title content=Second>",
    b"<<<>>><meta \x00 property='og:title' content='Nul'><title>T",
    b"\xff\xfe<\x00t\x00",
    b"<meta charset='utf-7'><title>+ADw-script+AD4-</title>",
])
def test_malformed_html_and_tags_never_raise_unexpectedly(html):
    net = FakeNet({"example.com": response(200, html)})
    try:
        result = preview("https://example.com/", net)
    except lp.PreviewError as error:
        assert error.code == "no_metadata"
    else:
        assert "<script>" not in (result["title"] or "")


def test_reading_stops_at_the_end_of_the_head():
    class OpenStream(FakeNet):
        async def connect(self, address, server_name):
            self.connections.append((address, server_name))
            reader = asyncio.StreamReader()
            head = b'<html><head><meta property="og:title" content="Fast"></head><body>'
            reader.feed_data(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n"
                             b"Transfer-Encoding: chunked\r\n\r\n%x\r\n%s\r\n" % (len(head), head))
            # The body never finishes; the fetcher must not wait for it.
            return reader, FakeWriter(address)
    net = OpenStream({})
    result = asyncio.run(asyncio.wait_for(
        lp.build_preview("https://example.com/", resolver=net.resolve, connector=net.connect), 1))
    assert result["title"] == "Fast"
    late = page('<title>Head</title>').replace(
        b"</head>", b"</head><meta property='og:title' content='Late'>")
    net = FakeNet({"example.com": response(200, late)})
    assert preview("https://example.com/", net)["title"] == "Head"


def test_large_html_is_read_only_to_the_limit():
    body = page('<meta property="og:title" content="Early">') + b"x" * (3 * lp.MAX_HTML_BYTES)
    net = FakeNet({"example.com": response(200, body, chunked=True)})
    assert preview("https://example.com/", net)["title"] == "Early"


@pytest.mark.parametrize("headers", [
    (("Content-Type", "text/html"), ("Content-Encoding", "gzip")),
    (("Content-Type", "text/html"), ("Content-Encoding", "br")),
])
def test_compressed_responses_are_rejected_not_expanded(headers):
    bomb = gzip.compress(b"<title>" + b"A" * 50_000_000)
    net = FakeNet({"example.com": response(200, bomb, headers=headers)})
    assert code_of("https://example.com/", net) == "unsupported_content"


@pytest.mark.parametrize("content_type", ["application/json", "image/svg+xml", "text/plain", ""])
def test_unsupported_page_types_are_rejected(content_type):
    net = FakeNet({"example.com": response(200, page("<title>x</title>"),
                                           headers=(("Content-Type", content_type),))})
    assert code_of("https://example.com/", net) == "unsupported_content"


@pytest.mark.parametrize("status", [404, 500, 304])
def test_unsuccessful_statuses_fail_generically(status):
    net = FakeNet({"example.com": response(status, b"")})
    assert code_of("https://example.com/", net) == "fetch_failed"


def test_malformed_http_and_connection_failures_fail_generically():
    net = FakeNet({"example.com": b"NOT HTTP\r\n\r\n"})
    assert code_of("https://example.com/", net) == "fetch_failed"

    class Refused(FakeNet):
        async def connect(self, address, server_name):
            self.connections.append((address, server_name))
            raise ConnectionRefusedError
    refused = Refused({}, dns={"example.com": ["93.184.216.34", "93.184.216.35", "93.184.216.36"]})
    assert code_of("https://example.com/", refused) == "fetch_failed"
    assert len(refused.connections) == lp.MAX_ADDRESSES_TRIED
    huge_header = b"HTTP/1.1 200 OK\r\nX: " + b"a" * (lp.MAX_HEADER_BYTES * 2) + b"\r\n\r\n"
    assert code_of("https://example.com/", FakeNet({"example.com": huge_header})) == "fetch_failed"


def test_slow_servers_and_connections_time_out(monkeypatch):
    monkeypatch.setattr(lp, "FETCH_DEADLINE_SECONDS", 0.05)
    with pytest.raises(TimeoutError):
        preview("https://example.com/", FakeNet({}, hang=True))

    class SlowConnect(FakeNet):
        async def connect(self, address, server_name):
            await asyncio.sleep(10)
    monkeypatch.setattr(lp, "CONNECT_TIMEOUT_SECONDS", 0.01)
    with pytest.raises((TimeoutError, lp.PreviewError)):
        preview("https://example.com/", SlowConnect({}))

    class SlowDns(FakeNet):
        async def resolve(self, host):
            await asyncio.sleep(10)
    with pytest.raises((TimeoutError, lp.PreviewError)):
        preview("https://example.com/", SlowDns({}))


def image_site(image_body, image_type="image/png", image_url="https://img.example.net/a.png"):
    return FakeNet({
        "example.com": response(200, page(f'<meta property="og:title" content="T">'
                                          f'<meta property="og:image" content="{image_url}">')),
        "img.example.net": response(200, image_body, headers=(("Content-Type", image_type),)),
    })


def test_valid_thumbnail_source_uses_the_same_protected_fetch():
    net = image_site(PNG)
    result = preview("https://example.com/", net)
    assert result["image"] == {"mime": "image/png", "width": 2, "height": 2, "data": PNG}
    assert net.resolved == ["example.com", "img.example.net"]
    assert [server for _, server in net.connections] == ["example.com", "img.example.net"]


def png_with(width=2, height=2, extra=b""):
    def chunk(kind, data):
        crc = struct.pack(">I", zlib.crc32(kind + data))
        return struct.pack(">I", len(data)) + kind + data + crc
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + extra + chunk(b"IDAT", zlib.compress(b"\x00" * 7)) + chunk(b"IEND", b""))


@pytest.mark.parametrize(("body", "image_type"), [
    (b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "image/svg+xml"),
    (b'<svg xmlns="http://www.w3.org/2000/svg"/>', "image/png"),
    (b"GIF89a\x01\x00\x01\x00", "image/gif"),
    (b"BM" + b"\x00" * 60, "image/bmp"),
    (PNG, "image/jpeg"),
    (PNG, "text/html"),
    (PNG[:-5], "image/png"),
    (PNG[:31] + bytes([PNG[31] ^ 0xFF]) + PNG[32:], "image/png"),
    (png_with(5000, 2), "image/png"),
    (png_with(2100, 2100), "image/png"),
    (png_with(extra=struct.pack(">I", 8) + b"acTL" + b"\x00" * 8
              + struct.pack(">I", zlib.crc32(b"acTL" + b"\x00" * 8))), "image/png"),
    (b"RIFF\x1e\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02" + b"\x00" * 9, "image/webp"),
    (b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 6 + b"<script>", "image/jpeg"),
    (PNG + b"<html><script>alert(1)</script>", "image/png"),
])
def test_malicious_or_unsupported_images_are_dropped(body, image_type):
    result = preview("https://example.com/", image_site(body, image_type))
    assert result["title"] == "T" and result["image"] is None


def test_oversized_image_and_unsafe_image_urls_are_dropped():
    big = PNG + b"\x00" * lp.MAX_IMAGE_BYTES
    assert preview("https://example.com/", image_site(big))["image"] is None
    for image_url in ("http://img.example.net/a.png", "https://169.254.169.254/a.png",
                      "data:image/png;base64,AAAA", "https://localhost/a.png"):
        net = image_site(PNG, image_url=image_url)
        assert preview("https://example.com/", net)["image"] is None
        assert len(net.connections) == 1
    assert lp.inspect_image(PNG + b"\x00" * lp.MAX_IMAGE_BYTES, "image/png") is None


def test_empty_pages_report_no_metadata():
    net = FakeNet({"example.com": response(200, page(""))})
    assert code_of("https://example.com/", net) == "no_metadata"


# Isolated service boundary


def service(builder, **kwargs):
    return TestClient(create_preview_app(TOKEN, builder=builder, **kwargs))


def test_service_requires_a_strong_token_and_bearer_authentication(monkeypatch):
    monkeypatch.delenv("SIDEWORD_LINK_PREVIEW_TOKEN", raising=False)
    with pytest.raises(RuntimeError):
        create_preview_app()
    with pytest.raises(RuntimeError):
        create_preview_app("short")

    async def builder(url):
        raise AssertionError("must not fetch")
    client = service(builder)
    for headers in ({}, {"Authorization": "Bearer wrong"}, {"Authorization": TOKEN},
                    {"Authorization": f"Basic {TOKEN}"}):
        reply = client.post("/preview", json={"url": "https://example.com/"}, headers=headers)
        assert reply.status_code == 401
    assert client.get("/preview").status_code == 405


def test_service_bounds_requests_concurrency_and_maps_errors():
    auth = {"Authorization": f"Bearer {TOKEN}"}
    gate = asyncio.Event()

    async def builder(url):
        if url == "slow":
            await gate.wait()
        if url == "bad":
            raise lp.PreviewError("blocked_destination")
        if url == "timeout":
            raise TimeoutError
        if url == "crash":
            raise RuntimeError(f"connect failed for {SECRET_URL}")
        return {"title": "<b>T</b>", "description": None, "site_name": None, "url": None,
                "final_host": "example.com", "image": {"mime": "image/png", "width": 2,
                                                       "height": 2, "data": PNG}}
    client = service(builder)
    assert client.post("/preview", content=b"x" * 5000, headers=auth).status_code == 413
    assert client.post("/preview", content=b"{", headers=auth).status_code == 422
    assert client.post("/preview", json={"nope": 1}, headers=auth).status_code == 422
    blocked = client.post("/preview", json={"url": "bad"}, headers=auth)
    assert blocked.json() == {"error": "blocked_destination"}
    assert client.post("/preview", json={"url": "timeout"}, headers=auth).status_code == 504
    crashed = client.post("/preview", json={"url": "crash"}, headers=auth)
    assert crashed.status_code == 502 and SECRET_URL not in crashed.text
    ok = client.post("/preview", json={"url": "fine"}, headers=auth)
    assert ok.headers["cache-control"] == "no-store"
    assert base64.b64decode(ok.json()["image"]["data"]) == PNG
    assert ok.json()["title"] == "<b>T</b>"
    busy = create_preview_app(TOKEN, builder=builder, concurrency=1)

    async def overlapping():
        import httpx2 as httpx
        transport = httpx.ASGITransport(app=busy)
        async with httpx.AsyncClient(transport=transport, base_url="http://preview") as http:
            first = asyncio.create_task(http.post("/preview", json={"url": "slow"}, headers=auth))
            await asyncio.sleep(0.05)
            second = await http.post("/preview", json={"url": "fine"}, headers=auth)
            gate.set()
            return (await first).status_code, second.status_code
    assert asyncio.run(overlapping()) == (200, 503)


def test_service_and_fetcher_never_log_urls_or_content(caplog, capsys):
    caplog.set_level(logging.DEBUG)

    async def builder(url):
        raise RuntimeError(f"failure for {url}")
    client = service(builder)
    client.post("/preview", json={"url": SECRET_URL}, headers={"Authorization": f"Bearer {TOKEN}"})
    net = FakeNet({"example.com": response(200, page("<title>secret page body</title>"))})
    asyncio.run(lp.build_preview(SECRET_URL, resolver=net.resolve, connector=net.connect))
    captured = capsys.readouterr()
    for text in (caplog.text, captured.out, captured.err):
        assert "never-log-this" not in text and "secret page body" not in text and TOKEN not in text
