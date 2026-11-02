"""Hardened Open Graph metadata fetching for the isolated link-preview service.

The relay imports only the HTTP exchange and result validation helpers; outbound fetching
runs in the separate preview process. Everything fetched is untrusted text or image bytes.
"""

from __future__ import annotations

import asyncio
import codecs
import ipaddress
import json
import re
import socket
import ssl
import struct
import unicodedata
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlsplit

import h11

MAX_URL_LENGTH = 2048
MAX_REDIRECTS = 3
CONNECT_TIMEOUT_SECONDS = 3
FETCH_DEADLINE_SECONDS = 6
# Whole preview (oEmbed, page and image) stays within the relay's 15-second service deadline.
TOTAL_DEADLINE_SECONDS = 12
MAX_OEMBED_BYTES = 64 * 1024
OEMBED_TYPES = frozenset({"application/json", "application/json+oembed", "text/json"})
MAX_HEADER_BYTES = 16 * 1024
MAX_HTML_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGE_DIMENSION = 4096
MAX_IMAGE_PIXELS = 4_000_000
MAX_ADDRESSES_TRIED = 2
FIELD_LIMITS = {"title": 200, "description": 400, "site_name": 80}
IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp"})
HTML_TYPES = frozenset({"text/html", "application/xhtml+xml"})
USER_AGENT = "SidewordLinkPreview/1 (metadata only)"
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
# Metadata lives in <head>; stop reading once the body starts.
HEAD_END = re.compile(rb"</head|<body", re.IGNORECASE)

# Official oEmbed endpoints for sites whose pages withhold usable metadata from unknown
# fetchers. Requests still pass every SSRF, size and time check below.
_OEMBED_PROVIDERS = (
    (frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
                "youtu.be"}), "https://www.youtube.com/oembed?format=json&url="),
    (frozenset({"vimeo.com", "www.vimeo.com"}), "https://vimeo.com/api/oembed.json?url="),
    (frozenset({"reddit.com", "www.reddit.com", "old.reddit.com"}), "https://www.reddit.com/oembed?url="),
    (frozenset({"tiktok.com", "www.tiktok.com"}), "https://www.tiktok.com/oembed?url="),
    (frozenset({"open.spotify.com"}), "https://open.spotify.com/oembed?url="),
    (frozenset({"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"}),
     "https://soundcloud.com/oembed?format=json&url="),
)

_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".intranet", ".lan", ".home.arpa",
                     ".onion", ".test", ".invalid", ".example", ".corp")
_BLOCKED_NETWORKS = tuple(ipaddress.ip_network(network) for network in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16",
    "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23",
    "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
))

Resolver = Callable[[str], Awaitable[list[str]]]
Connector = Callable[[str, str], Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]


class PreviewError(Exception):
    """A stable, non-sensitive failure code; never carries the requested URL."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Target:
    host: str
    target: str
    url: str


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: bytes
    truncated: bool


def validate_url(url: object) -> Target:
    """Accept only credential-free HTTPS URLs on port 443 with canonical hosts."""

    if (not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH or not url.isascii()
            or any(ord(character) <= 0x20 or ord(character) == 0x7F for character in url)
            or "\\" in url):
        raise PreviewError("invalid_url")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError as exc:
        raise PreviewError("invalid_url") from exc
    if (parts.scheme.lower() != "https" or "@" in parts.netloc or parts.username is not None
            or parts.password is not None or port not in (None, 443) or not parts.hostname):
        raise PreviewError("invalid_url")
    host = parts.hostname.lower().removesuffix(".")
    bracketed = parts.netloc.startswith("[")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if bracketed and not isinstance(literal, ipaddress.IPv6Address):
        raise PreviewError("invalid_url")
    if literal is None:
        labels = host.split(".")
        if (len(host) > 253 or len(labels) < 2
                or not all(_LABEL.fullmatch(label) for label in labels)
                # Numeric-looking final labels are non-canonical IPv4 forms such as 127.1.
                or labels[-1].isdigit() or labels[-1].startswith("0x")
                or host == "localhost" or host.endswith(_BLOCKED_SUFFIXES)):
            raise PreviewError("invalid_url")
    elif not public_address(literal):
        raise PreviewError("blocked_destination")
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    netloc = f"[{host}]" if isinstance(literal, ipaddress.IPv6Address) else host
    return Target(host=host, target=target, url=f"https://{netloc}{target}")


def public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Allow only globally routable unicast destinations, including embedded IPv4 forms."""

    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id:
            return False
        if address.ipv4_mapped is not None:
            return public_address(address.ipv4_mapped)
    if any(address in network for network in _BLOCKED_NETWORKS
           if network.version == address.version):
        return False
    return (address.is_global and not address.is_multicast and not address.is_reserved
            and not address.is_private and not address.is_loopback
            and not address.is_link_local and not address.is_unspecified)


async def system_resolver(host: str) -> list[str]:
    loop = asyncio.get_running_loop()
    records = await loop.getaddrinfo(host, 443, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)
    return [record[4][0] for record in records]


async def resolve_public(host: str, resolver: Resolver) -> list[str]:
    """Resolve once and reject the host if any answer is non-public."""

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        return [str(literal)]
    try:
        async with asyncio.timeout(CONNECT_TIMEOUT_SECONDS):
            answers = await resolver(host)
    except (OSError, UnicodeError) as exc:
        raise PreviewError("fetch_failed") from exc
    addresses: list[str] = []
    for answer in answers:
        try:
            # Scoped IPv6 answers keep their scope and are rejected by public_address.
            address = ipaddress.ip_address(answer)
        except ValueError as exc:
            raise PreviewError("blocked_destination") from exc
        if not public_address(address):
            raise PreviewError("blocked_destination")
        if str(address) not in addresses:
            addresses.append(str(address))
    if not addresses:
        raise PreviewError("fetch_failed")
    return addresses


def _tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


async def pinned_tls_connector(address: str, server_name: str):
    """Connect to an already validated address; DNS is never consulted again."""

    reader, writer = await asyncio.open_connection(
        address, 443, ssl=_tls_context(), server_hostname=server_name,
        ssl_handshake_timeout=CONNECT_TIMEOUT_SECONDS,
    )
    peer = writer.get_extra_info("peername")
    if not peer or ipaddress.ip_address(peer[0]) != ipaddress.ip_address(address):
        writer.close()
        raise PreviewError("blocked_destination")
    return reader, writer


async def exchange(reader, writer, *, method: str, host: str, target: str,
                   headers: list[tuple[str, str]], body: bytes = b"", max_body: int,
                   stop: re.Pattern[bytes] | None = None) -> Response:
    """Run one bounded HTTP/1.1 exchange; bodies stop at ``max_body`` or a ``stop`` match."""

    connection = h11.Connection(h11.CLIENT, max_incomplete_event_size=MAX_HEADER_BYTES)
    request_headers = [("Host", host), *headers, ("Connection", "close")]
    if body:
        request_headers.append(("Content-Length", str(len(body))))
    try:
        writer.write(connection.send(h11.Request(method=method, target=target,
                                                 headers=request_headers)))
        if body:
            writer.write(connection.send(h11.Data(data=body)))
        writer.write(connection.send(h11.EndOfMessage()))
        await writer.drain()
        response = None
        content = bytearray()
        truncated = False
        while True:
            event = connection.next_event()
            if event is h11.NEED_DATA:
                # Small reads before the status/headers let h11 enforce MAX_HEADER_BYTES.
                connection.receive_data(await reader.read(4096 if response is None else 65536))
                continue
            if isinstance(event, h11.InformationalResponse):
                continue
            if isinstance(event, h11.Response):
                response = event
                continue
            if isinstance(event, h11.Data):
                room = max_body - len(content)
                searched = max(0, len(content) - 16)
                content.extend(event.data[:room])
                if len(event.data) > room or (stop and stop.search(content, searched)):
                    truncated = True
                    break
                continue
            break
    except h11.LocalProtocolError as exc:
        raise PreviewError("invalid_url") from exc
    except h11.RemoteProtocolError as exc:
        raise PreviewError("fetch_failed") from exc
    if response is None:
        raise PreviewError("fetch_failed")
    response_headers: dict[str, str] = {}
    for name, value in response.headers:
        key = name.decode("latin-1").lower()
        text = value.decode("latin-1")
        if key in response_headers:
            text = f"{response_headers[key]}, {text}"
        response_headers[key] = text
    return Response(response.status_code, response_headers, bytes(content), truncated)


async def _close(writer) -> None:
    writer.close()
    try:
        async with asyncio.timeout(1):
            await writer.wait_closed()
    except (OSError, TimeoutError, ssl.SSLError):
        pass


async def fetch(url: str, *, accept: str, max_bytes: int, allow_truncation: bool,
                resolver: Resolver, connector: Connector,
                stop: re.Pattern[bytes] | None = None) -> tuple[Target, str, bytes]:
    """Fetch one resource, revalidating every redirect hop and pinning each connection."""

    current = validate_url(url)
    for hop in range(MAX_REDIRECTS + 1):
        addresses = await resolve_public(current.host, resolver)
        response = None
        for address in addresses[:MAX_ADDRESSES_TRIED]:
            try:
                async with asyncio.timeout(CONNECT_TIMEOUT_SECONDS):
                    reader, writer = await connector(address, current.host)
            except (OSError, TimeoutError, ssl.SSLError):
                continue
            try:
                response = await exchange(reader, writer, method="GET",
                                          host=urlsplit(current.url).netloc,
                                          target=current.target, max_body=max_bytes, stop=stop,
                                          headers=[
                                              ("User-Agent", USER_AGENT), ("Accept", accept),
                                              ("Accept-Encoding", "identity")])
            except (OSError, ssl.SSLError) as exc:
                raise PreviewError("fetch_failed") from exc
            finally:
                await _close(writer)
            break
        if response is None:
            raise PreviewError("fetch_failed")
        if response.status in REDIRECT_STATUSES:
            location = response.headers.get("location", "")
            if not location or "," in location or hop == MAX_REDIRECTS:
                raise PreviewError("fetch_failed")
            current = validate_url(urljoin(current.url, location.strip()))
            continue
        if response.status != 200:
            raise PreviewError("fetch_failed")
        # Identity only: compressed bodies are rejected rather than expanded.
        encoding = response.headers.get("content-encoding", "identity").strip().lower()
        if encoding not in ("", "identity"):
            raise PreviewError("unsupported_content")
        if response.truncated and not allow_truncation:
            raise PreviewError("too_large")
        return current, response.headers.get("content-type", ""), response.body
    raise PreviewError("fetch_failed")


def media_type(content_type: str) -> tuple[str, str | None]:
    kind, _, parameters = content_type.partition(";")
    charset = None
    for parameter in parameters.split(";"):
        name, _, value = parameter.partition("=")
        if name.strip().lower() == "charset":
            charset = value.strip().strip("\"'") or None
    return kind.strip().lower(), charset


def clean_text(value: object, limit: int) -> str | None:
    """Return bounded single-line plain text without controls or invisible formatting."""

    if not isinstance(value, str):
        return None
    characters = []
    for character in unicodedata.normalize("NFC", value[: limit * 4]):
        category = unicodedata.category(character)
        if category in ("Cf", "Cs", "Co", "Cn"):
            continue
        characters.append(" " if category[0] in ("C", "Z") else character)
    text = " ".join("".join(characters).split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text or None


class _MetadataParser(HTMLParser):
    WANTED = frozenset({"og:title", "og:description", "og:image", "og:image:url",
                        "og:image:secure_url", "og:site_name", "og:url", "description"})

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: list[str] = []
        self.in_title = False
        self.title_done = False
        self.oembed: str | None = None

    def handle_starttag(self, tag, attrs):
        if tag == "title" and not self.title_done:
            self.in_title = True
        elif tag == "link" and self.oembed is None:
            values = {name.lower(): value for name, value in attrs if value is not None}
            rel = values.get("rel", "").lower().split()
            if "alternate" in rel and values.get("type", "").lower() == "application/json+oembed":
                self.oembed = values.get("href", "")[:MAX_URL_LENGTH]
        elif tag == "meta":
            values = {name.lower(): value for name, value in attrs if value is not None}
            key = (values.get("property") or values.get("name") or "").strip().lower()
            if key in self.WANTED and key not in self.meta and "content" in values:
                self.meta[key] = values["content"][:4096]

    def handle_endtag(self, tag):
        if tag == "title" and self.in_title:
            self.in_title = False
            self.title_done = True

    def handle_data(self, data):
        if self.in_title and sum(map(len, self.title)) < 1024:
            self.title.append(data)


def _decode_html(body: bytes, charset: str | None) -> str:
    if charset is None:
        declared = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_.:-]{1,40})", body[:4096], re.I)
        charset = declared.group(1).decode("ascii") if declared else None
    encoding = "utf-8"
    if charset:
        try:
            candidate = codecs.lookup(charset).name
        except LookupError:
            candidate = "utf-8"
        # UTF-7 and other stateful encodings can smuggle markup; never decode with them.
        if candidate not in ("utf-7",) and not candidate.startswith(("utf-16", "utf-32")):
            encoding = candidate
    return body.decode(encoding, errors="replace")


def preview_url(value: object, base: str) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return validate_url(urljoin(base, value.strip())).url
    except (PreviewError, ValueError):
        return None


def parse_metadata(body: bytes, content_type: str, page_url: str) -> dict[str, str | None]:
    kind, charset = media_type(content_type)
    if kind not in HTML_TYPES:
        raise PreviewError("unsupported_content")
    head_end = HEAD_END.search(body)
    if head_end:
        body = body[:head_end.start()]  # Metadata belongs to <head>; ignore body content.
    parser = _MetadataParser()
    try:
        parser.feed(_decode_html(body, charset))
        parser.close()
    except (AssertionError, ValueError):
        pass  # Keep metadata parsed before malformed markup.
    meta = parser.meta
    image = (meta.get("og:image:secure_url") or meta.get("og:image")
             or meta.get("og:image:url"))
    return {
        "title": clean_text(meta.get("og:title") or "".join(parser.title), FIELD_LIMITS["title"]),
        "description": clean_text(meta.get("og:description") or meta.get("description"),
                                  FIELD_LIMITS["description"]),
        "site_name": clean_text(meta.get("og:site_name"), FIELD_LIMITS["site_name"]),
        "url": preview_url(meta.get("og:url"), page_url),
        "image_url": preview_url(image, page_url),
        "oembed_url": preview_url(parser.oembed, page_url),
    }


def provider_oembed(target: Target) -> str | None:
    """Return the official oEmbed endpoint for a known provider's page, if any."""

    for hosts, endpoint in _OEMBED_PROVIDERS:
        if target.host in hosts:
            return endpoint + quote(target.url, safe="")
    return None


def parse_oembed(body: bytes, content_type: str, endpoint: str) -> dict[str, str | None]:
    """Use only plain-text oEmbed fields and the thumbnail URL; never the provider's HTML."""

    if media_type(content_type)[0] not in OEMBED_TYPES:
        raise PreviewError("unsupported_content")
    try:
        data = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise PreviewError("unsupported_content") from exc
    if not isinstance(data, dict):
        raise PreviewError("unsupported_content")
    title = clean_text(data.get("title"), FIELD_LIMITS["title"])
    author = clean_text(data.get("author_name"), FIELD_LIMITS["description"])
    return {
        "title": title or author,
        "description": author if title else None,
        "site_name": clean_text(data.get("provider_name"), FIELD_LIMITS["site_name"]),
        "url": None,
        "image_url": preview_url(data.get("thumbnail_url"), endpoint),
    }


def _dimensions_allowed(width: int, height: int) -> bool:
    return (0 < width <= MAX_IMAGE_DIMENSION and 0 < height <= MAX_IMAGE_DIMENSION
            and width * height <= MAX_IMAGE_PIXELS)


def _png(data: bytes) -> tuple[int, int] | None:
    offset, size = 8, None
    for index in range(1024):
        if offset + 12 > len(data):
            return None
        length, kind = struct.unpack(">I4s", data[offset:offset + 8])
        end = offset + 8 + length
        if (end + 4 > len(data)
                or zlib.crc32(data[offset + 4:end]) != struct.unpack(">I", data[end:end + 4])[0]):
            return None
        if index == 0 and (kind != b"IHDR" or length != 13):
            return None
        if kind == b"IHDR" and index == 0:
            size = struct.unpack(">II", data[offset + 8:offset + 16])
        elif kind in (b"acTL", b"fcTL", b"fdAT"):
            return None  # Animated PNG.
        elif kind == b"IEND":
            return size if end + 4 == len(data) else None
        offset = end + 4
    return None


def _jpeg(data: bytes) -> tuple[int, int] | None:
    offset = 2
    for _ in range(512):
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset + 3 > len(data):
            return None
        marker = data[offset]
        if marker in (0xD8, 0xD9, 0x01) or 0xD0 <= marker <= 0xD7:
            return None
        length = struct.unpack(">H", data[offset + 1:offset + 3])[0]
        if length < 2 or offset + 1 + length > len(data):
            return None
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            if length < 7:
                return None
            height, width = struct.unpack(">HH", data[offset + 4:offset + 8])
            return width, height
        offset += 1 + length
    return None


def _webp(data: bytes) -> tuple[int, int] | None:
    if len(data) < 30 or struct.unpack("<I", data[4:8])[0] + 8 != len(data):
        return None
    kind = data[12:16]
    if kind == b"VP8X":
        if data[20] & 0x02:
            return None  # Animated WebP.
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return width, height
    if kind == b"VP8 " and data[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L" and data[20] == 0x2F:
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def inspect_image(data: bytes, declared: str) -> tuple[str, int, int] | None:
    """Return (mime, width, height) for a still JPEG/PNG/WebP whose signature matches."""

    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES:
        return None
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        mime, size = "image/png", _png(data)
    elif data.startswith(b"\xff\xd8\xff"):
        mime, size = "image/jpeg", _jpeg(data)
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        mime, size = "image/webp", _webp(data)
    else:
        return None
    if mime != declared or size is None or not _dimensions_allowed(*size):
        return None
    return mime, size[0], size[1]


async def _within(deadline: float, operation):
    """Run one fetch within both its own limit and the preview's remaining time."""

    remaining = deadline - asyncio.get_running_loop().time()
    if remaining <= 0:
        operation.close()
        raise TimeoutError
    async with asyncio.timeout(min(FETCH_DEADLINE_SECONDS, remaining)):
        return await operation


async def _oembed(endpoint: str, deadline: float, resolver: Resolver,
                  connector: Connector) -> dict[str, str | None] | None:
    try:
        _, content_type, body = await _within(deadline, fetch(
            endpoint, accept="application/json", max_bytes=MAX_OEMBED_BYTES,
            allow_truncation=False, resolver=resolver, connector=connector))
        metadata = parse_oembed(body, content_type, endpoint)
    except (PreviewError, TimeoutError):
        return None
    return metadata if metadata["title"] or metadata["image_url"] else None


async def build_preview(url: str, *, resolver: Resolver = system_resolver,
                        connector: Connector = pinned_tls_connector) -> dict:
    """Fetch metadata (official oEmbed for known providers, page tags otherwise, discovered
    oEmbed as a fallback) and an optional validated thumbnail source image."""

    deadline = asyncio.get_running_loop().time() + TOTAL_DEADLINE_SECONDS
    target = validate_url(url)
    final_host = target.host
    endpoint = provider_oembed(target)
    metadata = await _oembed(endpoint, deadline, resolver, connector) if endpoint else None
    if metadata is None:
        page, content_type, body = await _within(deadline, fetch(
            url, accept="text/html,application/xhtml+xml;q=0.9", max_bytes=MAX_HTML_BYTES,
            allow_truncation=True, resolver=resolver, connector=connector, stop=HEAD_END))
        metadata = parse_metadata(body, content_type, page.url)
        final_host = page.host
        if (not (metadata["title"] or metadata["description"] or metadata["image_url"])
                and metadata["oembed_url"]):
            discovered = await _oembed(metadata["oembed_url"], deadline, resolver, connector)
            if discovered:
                metadata = {**discovered, "url": metadata["url"]}
    image = None
    if metadata["image_url"]:
        try:
            _, image_type, image_body = await _within(deadline, fetch(
                metadata["image_url"], accept="image/webp,image/png,image/jpeg",
                max_bytes=MAX_IMAGE_BYTES, allow_truncation=False,
                resolver=resolver, connector=connector))
            checked = inspect_image(image_body, media_type(image_type)[0])
            if checked:
                image = {"mime": checked[0], "width": checked[1], "height": checked[2],
                         "data": image_body}
        except (PreviewError, TimeoutError):
            image = None  # Metadata remains useful without a thumbnail.
    if not (metadata["title"] or metadata["description"] or image):
        raise PreviewError("no_metadata")
    return {"title": metadata["title"], "description": metadata["description"],
            "site_name": metadata["site_name"], "url": metadata["url"],
            "final_host": final_host, "image": image}
