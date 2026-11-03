"""Client/invite structure, local assets and unchanged admin sign-in."""

from html.parser import HTMLParser
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.main import create_app
from app.templates import templates

ROOT = Path(__file__).resolve().parents[1]


class Structure(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.stack = []
        self.nodes = []
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = {"tag": tag, "attrs": dict(attrs), "parents": self.stack.copy()}
        self.nodes.append(node)
        if tag not in {"input", "meta", "link", "br", "hr", "img"}:
            self.stack.append(node)

    def handle_endtag(self, tag):
        if self.stack and self.stack[-1]["tag"] == tag:
            self.stack.pop()

    def by_id(self, identifier):
        matches = [node for node in self.nodes if node["attrs"].get("id") == identifier]
        assert len(matches) == 1
        return matches[0]


def test_client_retains_controls_accessibility_and_separate_mobile_views():
    html = (ROOT / "app/templates/client.html").read_text()
    tree = Structure(html)
    ids = [node["attrs"]["id"] for node in tree.nodes if "id" in node["attrs"]]
    assert len(ids) == len(set(ids))
    for identifier in (
        "activation-form", "invite-token", "display-name", "join-password",
        "display-name-error", "activation-error", "reconnect-session", "setup-panel",
        "client-panel", "chat-list", "refresh-button", "participant-count",
        "conversation-kind", "conversation-title", "participant-keys", "message-list",
        "message-form", "message-input", "send-button", "pending-sends",
        "pending-send-list", "retry-pending-sends", "reset-button", "identity-label",
        "connection-state", "status-message", "error-message",
    ):
        tree.by_id(identifier)
    grid = tree.by_id("client-panel")
    assert grid["attrs"]["data-mobile-view"] == "chats"
    pending = tree.by_id("pending-sends")
    assert pending["parents"][-1] is grid
    warning = tree.by_id("key-change-warning")
    assert warning["attrs"]["role"] == "alert"
    assert all(node["tag"] != "dialog" for node in warning["parents"])
    for identifier in ("device-settings", "conversation-details", "message-details"):
        dialog = tree.by_id(identifier)
        assert dialog["tag"] == "dialog"
        tree.by_id(dialog["attrs"]["aria-labelledby"])
    assert tree.by_id("participant-keys")["parents"][2]["attrs"]["id"] == "conversation-details"
    assert tree.by_id("message-list")["attrs"]["role"] == "log"
    assert tree.by_id("message-list")["attrs"]["aria-live"] == "polite"
    assert tree.by_id("message-input")["attrs"]["maxlength"] == "16000"
    waiting = tree.by_id("waiting-notice")
    assert "hidden" in waiting["attrs"]
    assert waiting["attrs"]["role"] == "status"
    assert waiting["attrs"]["aria-live"] == "polite"
    assert waiting["attrs"]["aria-atomic"] == "true"
    assert "waiting-notice" in tree.by_id("message-input")["attrs"]["aria-describedby"].split()
    assert "You're the only person in this conversation." in html
    assert "once someone else joins using a room invite." in html
    assert "Enter to send · Shift+Enter for a new line" in html
    assert tree.by_id("display-name-error")["attrs"]["role"] == "alert"
    assert tree.by_id("error-message")["attrs"]["role"] == "alert"
    for identifier, name in (("device-settings-button", "Device settings"),
                             ("conversation-details-button", "Conversation details")):
        button = tree.by_id(identifier)
        assert button["attrs"]["aria-label"] == name
        icons = [node for node in tree.nodes if node["tag"] == "svg"
                 and node["parents"][-1] is button]
        assert len(icons) == 1
        assert icons[0]["attrs"]["aria-hidden"] == "true"
        assert icons[0]["attrs"]["focusable"] == "false"
    assert tree.by_id("back-to-chats")["attrs"]["aria-label"] == "Back to conversations"
    assert "Web client · " in html and "unaudited" not in html
    assert "hidden" in tree.by_id("setup-panel")["attrs"]
    assert "hidden" not in tree.by_id("loading-panel")["attrs"]
    assert tree.by_id("loading-panel")["attrs"]["role"] == "status"
    progress = [node for node in tree.nodes if node["tag"] == "progress"]
    assert len(progress) == 1
    assert tree.by_id("loading-panel") in progress[0]["parents"]
    assert progress[0]["attrs"]["aria-label"] == "Restoring conversations"
    assert "value" not in progress[0]["attrs"]
    assert "aria-valuenow" not in progress[0]["attrs"]
    assert "First-use key pinning is not identity verification." in html
    assert html.index('/static/appearance.js') < html.index('/static/client.css')
    assert all(node["attrs"].get("src", "").startswith("/static/")
               for node in tree.nodes if node["tag"] == "script")
    assert not any("style" in node["attrs"] or any(key.startswith("on") for key in node["attrs"])
                   for node in tree.nodes)


def test_viewport_and_full_technical_value_styles():
    css = (ROOT / "app/static/client.css").read_text()
    assert "height: 100dvh" in css
    # iOS keyboards pan the visual viewport; the fixed workspace follows its offset.
    assert ".messenger { position: fixed; top: var(--visual-viewport-offset-top, 0px);" in css
    assert "text-size-adjust: 100%" in css
    assert "touch-action: manipulation" in css
    assert "grid-template-columns: 280px minmax(0, 1fr)" in css
    assert '[data-mobile-view="chats"] .conversation { display: none; }' in css
    assert '[data-mobile-view="conversation"] .chat-sidebar { display: none; }' in css
    assert "white-space: pre-wrap" in css
    assert "overflow-wrap: anywhere" in css
    assert "prefers-reduced-motion" in css
    assert 'data-theme="dark"' in css
    assert "text-overflow: ellipsis" not in css
    assert "gradient(" not in css


def test_client_fonts_are_local_and_allowed_by_its_csp():
    with TestClient(create_app(), base_url="https://testserver") as client:
        response = client.get("/client")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        policy = response.headers["content-security-policy"]
        for directive in ("default-src 'none'", "script-src 'self'", "style-src 'self'",
                          "font-src 'self'", "base-uri 'none'", "frame-ancestors 'none'"):
            assert directive in policy
        assert "unsafe-inline" not in policy
        directives = {
            parts[0]: parts[1:]
            for directive in policy.split(";") if (parts := directive.split())
        }
        assert directives["img-src"] == ["'self'", "data:", "blob:"]
        assert directives["connect-src"] == ["'self'"]
        assert directives["object-src"] == ["'none'"]
        assert all("blob:" not in values for name, values in directives.items()
                   if name != "img-src")
        assert "unsafe-eval" not in policy
        assert not any("http:" in value or "https:" in value
                       for values in directives.values() for value in values)
        assert client.get("/static/client-media.js").status_code == 200
        assert (response.text.index("/static/client-media.js")
                < response.text.index("/static/client.js"))
        # Link cards are local: no remote image, frame or connect sources are allowed.
        assert client.get("/static/client-links.js").status_code == 200
        assert (response.text.index("/static/client-links.js")
                < response.text.index("/static/client.js"))
        # Link previews are on by default.
        assert ('id="link-previews-on" type="radio" name="link-previews" value="on" checked'
                in response.text)
        assert 'id="external-link-note"' in response.text
        for name in ("IBMPlexSans-Regular.woff2", "IBMPlexSans-Medium.woff2",
                     "IBMPlexSans-SemiBold.woff2", "IBMPlexMono-Regular.woff2", "OFL.txt"):
            asset = client.get(f"/static/fonts/{name}")
            assert asset.status_code == 200
            assert asset.content == (ROOT / "docs/fonts" / name).read_bytes()
        assert client.get("/static/appearance.js").status_code == 200


def test_admin_pages_use_admin_palette_icons_and_other_pages_keep_shared_mark():
    with TestClient(create_app(), base_url="https://testserver") as client:
        admin = client.get("/admin/login").text
        for asset in ("admin-mark.svg", "admin-apple-touch-icon.png"):
            assert f"/static/{asset}?v=1" in admin
            assert client.get(f"/static/{asset}").status_code == 200
        assert "/static/mark.svg" not in admin
        assert "/static/apple-touch-icon.png" not in admin
        mark = (ROOT / "app/static/admin-mark.svg").read_text()
        for color in ("#3A5BD9", "#FFFFFF", "#7893F5", "#0B0D14"):
            assert color in mark
        for page in ("/", "/client"):
            text = client.get(page).text
            assert "/static/mark.svg?v=1" in text
            assert "admin-mark.svg" not in text and "admin-apple-touch-icon" not in text


def test_admin_login_retains_original_styles_fields_csrf_and_errors():
    with TestClient(create_app(), base_url="https://testserver") as client:
        response = client.get("/admin/login")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        tree = Structure(response.text)
        forms = [node for node in tree.nodes if node["tag"] == "form"]
        assert len(forms) == 1
        assert forms[0]["attrs"]["action"] == "/admin/login"
        assert forms[0]["attrs"]["method"] == "post"
        inputs = {node["attrs"].get("name"): node["attrs"] for node in tree.nodes
                  if node["tag"] == "input"}
        assert inputs["csrf_token"]["value"] == client.cookies.get("sideword_csrf")
        assert inputs["username"]["autocomplete"] == "username"
        assert "autofocus" in inputs["username"]
        assert inputs["password"]["autocomplete"] == "current-password"
        assert "admin.css" in response.text
        assert "client.css" not in response.text
        assert "appearance.js" not in response.text
        rejected = client.post("/admin/login", data={
            "csrf_token": inputs["csrf_token"]["value"],
            "username": "no-such-admin", "password": "incorrect-password",
        }, headers={"Origin": "https://testserver"})
        assert rejected.status_code == 401
        assert any(node["attrs"].get("class") == "alert" for node in Structure(rejected.text).nodes)
        assert "Invalid username or password." in rejected.text


@pytest.mark.parametrize("status, expected, action", [
    ("active", "Open it in a compatible Sideword client to activate.", "Open web messenger"),
    ("expired", "This link expired. Ask your administrator for a fresh invite.", None),
    ("used", "This room is sealed. All participant slots are filled.",
     "Reconnect from your joined browser"),
    ("revoked", "This link was revoked by an administrator.", None),
    ("unknown", "This invite token does not exist.", None),
])
def test_invite_states_use_client_theme_and_preserve_status_messages(status, expected, action):
    request = Request({"type": "http", "method": "GET", "path": "/l/example-invite",
                       "headers": []})
    html = templates.env.get_template("landing.html").render(
        request=request, token="example-invite", status=status,
        details={"is_personal": True, "password_required": True},
    )
    assert expected in html
    assert "client.css" in html
    assert "admin.css" not in html
    assert html.index("appearance.js") < html.index("client.css")
    assert "Web client · " in html and "unaudited" not in html
    assert len([node for node in Structure(html).nodes
                if node["attrs"].get("name") == "appearance"]) == 3
    if action:
        assert action in html
        assert 'href="/client?invite=example-invite"' in html
        # Tokens are URL-encoded, so characters such as & or # cannot alter the query.
        tricky = templates.env.get_template("landing.html").render(
            request=request, token="a&b#c", status=status,
            details={"is_personal": True, "password_required": True})
        assert 'href="/client?invite=a%26b%23c"' in tricky
    else:
        assert 'href="/client?invite=' not in html
    if status == "active":
        assert "private 1:1 chat" in html
        assert "Opening this page does not reserve a participant slot." in html
        assert "Ask the creator for it separately." in html
        assert 'class="invite-token"' in html
    else:
        assert 'class="invite-token"' not in html


def test_group_invite_preserves_type_and_optional_password_guidance():
    request = Request({"type": "http", "method": "GET", "path": "/l/example-invite",
                       "headers": []})
    html = templates.env.get_template("landing.html").render(
        request=request, token="example-invite", status="active",
        details={"is_personal": False, "password_required": False},
    )
    assert "<b>group</b> invite link" in html
    assert "The room also requires a phrase or password." not in html


def test_message_details_structure_and_theme_confirmation_styles():
    tree = Structure((ROOT / "app/templates/client.html").read_text())
    details = tree.by_id("message-details")
    assert details["tag"] == "dialog"
    for identifier in ("message-details-status", "message-details-time",
                       "message-details-recipients", "message-details-note"):
        assert details in tree.by_id(identifier)["parents"]
    # Production dialogs show delivery state only; internal IDs are not displayed.
    html = (ROOT / "app/templates/client.html").read_text()
    for removed in ("message-details-technical", "Technical details", "session-countdown",
                    "Display names are labels"):
        assert removed not in html
    css = (ROOT / "app/static/client.css").read_text()
    assert ".message-status.status-read { color: var(--signature); }" in css
    assert "--signature: var(--accent)" in css
    assert ".message-details::backdrop" in css
    assert "max-height: 80dvh" in css
    assert "font-family: var(--sans)" in css


def test_editorial_message_layout_uses_compact_bubbles_and_integrated_svg_indicators():
    css = (ROOT / "app/static/client.css").read_text()
    assert ".message.mine { align-self: flex-end; align-items: flex-end; }" in css
    assert ".message-header" in css and ".message-sender" in css
    assert ".message-sender { min-width: 0; font-size: .675rem;" in css
    assert (".message-header time, .message-separator { flex-shrink: 0; "
            "color: var(--muted); font-size: .675rem;") in css
    assert "width: fit-content" in css and "max-width: min(84%, 34rem)" in css
    assert ".message:has(.attachment-card, .link-card) { max-width: min(84%, 24rem); }" in css
    assert ".message-content { display: inline; white-space: pre-wrap" in css
    assert ".message-bubble { position: relative; width: fit-content; min-width: 0;" in css
    assert '.message.mine .message-content::after { content: ""; display: inline-block;' in css
    assert "width: calc(28px + .35em); height: 1em;" in css
    assert ".message-footer { position: absolute;" in css
    assert "min-height: 20px; margin-top: .1rem" not in css
    assert "background: var(--mine); padding-bottom:" not in css
    assert ".message.continuation { margin-top: .25rem; }" in css


def test_attachment_cards_use_the_same_text_and_media_spacing_for_both_senders():
    css = (ROOT / "app/static/client.css").read_text()
    # The sender-only status spacer must be outranked inside cards (specificity 0,4,1 > 0,3,1).
    assert ".message.mine .attachment-card > .message-content::after { display: none; }" in css
    assert "align-items: center; gap: 0 .4rem;" in css
    assert (".attachment-card > .message-content { grid-column: 1 / -1; grid-row: 1; "
            "margin-bottom: .4rem; }") in css
    assert (".attachment-card .media-preview { grid-column: 1 / -1; grid-row: 3; "
            "margin-top: .4rem;") in css
    assert ".media-preview:empty { display: none; }" in css
    assert css.index(".attachment-card .media-preview {") < css.index(".media-preview:empty {")
    assert ".message-status svg { display: block; width: 20px; height: 15px" in css
    assert ('svg[data-icon="check"], .message-status svg[data-icon="double-check"] '
            '{ width: 14px; height: 10.5px; }') in css
    assert "border-radius: 2px" in css
    assert "border-radius: 3px 3px 0 0" in css
    assert "avatar" not in css
    assert "border-right: 2px solid var(--accent)" not in css
    assert "box-shadow" not in css


def test_client_pages_show_the_application_version_in_the_header_badge():
    from app.version import __version__
    with TestClient(create_app(), base_url="https://testserver") as client:
        pages = [client.get("/client").text, client.get("/l/not-a-real-invite").text]
    for page in pages:
        assert f'<span class="app-version">v{__version__}</span>' in page
        assert page.count('class="app-version"') == 1


def test_admin_pages_show_the_application_version_in_the_top_bar():
    from app.version import __version__
    with TestClient(create_app(), base_url="https://testserver") as client:
        page = client.get("/admin/login").text
    assert f'<span class="app-version">v{__version__}</span>' in page
    assert page.count('class="app-version"') == 1


def test_preview_and_media_cards_fill_wide_bubbles_without_widening_them():
    css = (ROOT / "app/static/client.css").read_text()
    # Link previews keep one width; the bubble matches it and text wraps inside.
    assert ".link-card { display: block; width: 20rem; max-width: 100%;" in css
    assert ".message-bubble:has(> .link-card) { width: calc(20rem + 1.3rem); }" in css
    assert "width: fit-content; min-width: 16.5rem; max-width: 100%;" in css
    assert "min-height: 0; width: 0; min-width: 100%;" in css
    assert "-webkit-line-clamp: 3; line-clamp: 3;" in css
    assert "-webkit-line-clamp: 4; line-clamp: 4;" in css


def test_image_previews_use_a_frame_filling_skeleton_with_reduced_motion_support():
    css = (ROOT / "app/static/client.css").read_text()
    assert (".media-preview > .media-loading { position: relative; align-self: stretch; "
            "flex: 1;") in css
    assert "animation: media-pulse 1.6s ease-in-out infinite;" in css
    assert ".media-image { animation: media-fade-in .25s ease-out; }" in css
    assert ("@media (prefers-reduced-motion: reduce) { .media-preview > .media-loading::before, "
            ".media-image {") in css
    # The glyph is an inline data image, which the client CSP already allows for images.
    assert 'mask: url("data:image/svg+xml,' in css


def test_client_pages_share_the_current_stylesheet_and_viewport_fallbacks():
    import re
    client_html = (ROOT / "app/templates/client.html").read_text()
    landing_html = (ROOT / "app/templates/landing.html").read_text()
    revision = re.search(r"client\.css\?v=(\d+)", client_html)[1]
    assert f"client.css?v={revision}" in landing_html
    css = (ROOT / "app/static/client.css").read_text()
    # Every dynamic-viewport size has a classic viewport fallback for older engines.
    for line in css.splitlines():
        for match in re.finditer(r"([a-z-]+):\s*([^;{}]*\d+dvh[^;{}]*);", line):
            earlier = re.findall(rf"(?:^|[;{{\s]){re.escape(match[1])}:\s*([^;{{}}]*);",
                                 line[:match.start()])
            assert any(re.search(r"\d+vh\b", value) for value in earlier), line


def test_emoji_picker_is_local_accessible_and_in_the_composer_flow():
    html = (ROOT / "app/templates/client.html").read_text()
    tree = Structure(html)
    form = tree.by_id("message-form")
    button = tree.by_id("emoji-button")
    picker = tree.by_id("emoji-picker")
    assert form in button["parents"] and form in picker["parents"]
    assert button["attrs"]["type"] == "button"
    assert button["attrs"]["aria-label"] == "Emoji"
    assert button["attrs"]["aria-expanded"] == "false"
    assert button["attrs"]["aria-controls"] == "emoji-picker"
    assert "disabled" in button["attrs"]
    icons = [node for node in tree.nodes if node["tag"] == "svg" and node["parents"][-1] is button]
    assert len(icons) == 1 and icons[0]["attrs"]["aria-hidden"] == "true"
    assert "hidden" in picker["attrs"] and picker["attrs"]["aria-label"] == "Emoji picker"
    # The picker follows the field and Send in DOM order, so focus order matches the layout.
    order = [node["attrs"].get("id") for node in tree.nodes]
    expected = ["attachment-button", "emoji-button", "message-input", "send-button", "emoji-picker"]
    assert [order.index(identifier) for identifier in expected] == sorted(
        order.index(identifier) for identifier in expected)
    search = tree.by_id("emoji-search")
    assert picker in search["parents"]
    assert search["attrs"]["aria-label"] == "Search emoji"
    assert search["attrs"]["maxlength"] == "40"
    assert tree.by_id("emoji-status")["attrs"]["role"] == "status"
    assert html.index("/static/client-emoji.js") < html.index("/static/client.js")
    script = (ROOT / "app/static/client-emoji.js").read_text()
    # DOM properties only; the catalog is the file's only request and needs no credentials.
    for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(",
                 "new Function", "http:", "https:"):
        assert sink not in script
    assert 'CATALOG_URL = "/static/emoji-catalog.json?v=1"' in script
    assert 'credentials: "omit"' in script


def test_emoji_layout_keeps_mobile_composer_and_large_emoji_contracts():
    css = (ROOT / "app/static/client.css").read_text()
    assert ".composer { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto;" in css
    assert ".composer.has-attachment #emoji-button { grid-column: 2; grid-row: 2; }" in css
    assert ".composer.has-attachment #send-button { grid-column: 4; grid-row: 2;" in css
    assert (".composer.has-attachment #attachment-button, "
            ".composer.has-attachment #emoji-button,") in css
    # In-flow panel: bounded by the visual viewport, scrolls internally, never covers the field.
    assert ".emoji-picker { grid-column: 1 / -1;" in css
    assert "height: min(16rem, 40vh); height: min(16rem, 40dvh);" in css
    assert (".emoji-grid { position: relative; min-height: 0; overflow-y: auto; "
            "overscroll-behavior: contain; }") in css
    assert ("@media (max-height: 500px) and (max-width: 760px) { "
            ".emoji-picker { height: 9.5rem; }") in css
    emoji_section = css.split("/* Emoji picker")[1].split("/* One to three emoji")[0]
    assert "position: fixed" not in emoji_section
    # The in-flow panel eases open; reduced motion turns that off.
    assert "overflow: hidden; animation: emoji-picker-in .16s cubic-bezier(.2, 0, 0, 1); }" in css
    assert "@keyframes emoji-picker-in { from { height: 0; opacity: 0; } }" in css
    assert "@media (prefers-reduced-motion: reduce) { .emoji-picker { animation: none; }" in css
    assert ('.message-bubble.emoji-only, .message.mine .message-bubble.emoji-only { '
            'padding: 0 .1rem; background: transparent;') in css
    assert '.message-bubble.emoji-only[data-emoji-count="1"] { font-size: 2.75rem; }' in css
    # Outranks the sender status spacer (0,3,1) so large emoji do not reserve a text line.
    assert ".message.mine .emoji-only > .message-content::after { display: none; }" in css
    assert ".emoji-only > .message-footer { position: static;" in css
    assert '--emoji: "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif;' in css


def test_emoji_catalog_is_a_cached_public_static_file_under_the_unchanged_csp():
    with TestClient(create_app(), base_url="https://testserver") as client:
        page = client.get("/client")
        policy = page.headers["content-security-policy"]
        assert "connect-src 'self'" in policy and "trusted-types 'none'" in policy
        catalog = client.get("/static/emoji-catalog.json?v=1", headers={"Accept-Encoding": "gzip"})
        script = client.get("/static/client-emoji.js?v=1")
    assert catalog.status_code == 200 and script.status_code == 200
    assert catalog.headers["content-type"].startswith("application/json")
    assert catalog.headers["content-encoding"] == "gzip"
    assert catalog.headers["cache-control"] == "public, max-age=3600, must-revalidate"
    assert [group[0] for group in catalog.json()] == [
        "smileys", "nature", "food", "activities", "travel", "objects", "symbols", "flags"]


def test_reaction_layout_keeps_status_touch_and_card_contracts():
    css = (ROOT / "app/static/client.css").read_text()
    # Chips share the last line with the read mark, which keeps its end position and space.
    assert ".message.mine .has-reactions > .message-content::after { display: none; }" in css
    assert (".message.mine .has-reactions > .message-reactions "
            "{ padding-right: calc(28px + .5rem); }") in css
    assert (".message-bubble.has-reactions > .message-footer { position: absolute; right: .65rem; "
            "bottom: .45rem; grid-column: auto; grid-row: auto; margin: 0; }") in css
    assert ".attachment-card > .message-reactions { grid-column: 1 / -1; grid-row: 5; }" in css
    # The picker floats beside the message instead of resizing the bubble; motion is optional.
    assert ".reaction-picker { position: fixed; z-index: 3;" in css
    assert "@media (prefers-reduced-motion: reduce) { .reaction-picker { animation: none; }" in css
    # Without hover the trigger stays visible, with room beside bubbles and larger touch targets.
    assert "@media (hover: none) { .reaction-trigger { opacity: .7; } }" in css
    assert ".message.mine, .message.theirs { max-width: min(calc(100% - 2.5rem), 34rem); }" in css
    assert (".message.mine:has(.attachment-card, .link-card), "
            ".message.theirs:has(.attachment-card, .link-card) "
            "{ max-width: min(calc(100% - 2.5rem), 24rem); }") in css
    assert ".reaction-option { width: 44px; height: 44px; }" in css
    assert ".reaction-trigger:disabled { display: none; }" in css
    assert '.reaction-chip[aria-pressed="true"], .reaction-option[aria-pressed="true"]' in css
    script = (ROOT / "app/static/client.js").read_text()
    assert "innerHTML" not in script and "insertAdjacentHTML" not in script
