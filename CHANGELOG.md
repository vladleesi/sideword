# Changelog

## 0.22.2 — 2026-11-02

### Backend

- Cap link-preview source images at 256 KiB instead of 1 MiB to keep preview traffic small on egress-limited hosts.
- Try preview addresses IPv6 first, alternating with IPv4, so IPv6-only hosts such as cost-free cloud VMs reach dual-stack sites.

### Web

- Send link-preview images of at most 24 KB inside messages, including wide banners, since every recipient receives a copy.

## 0.22.1 — 2026-11-01

### Backend

- Redirect admin bulk deletion only to fixed admin pages instead of a path built from the request, resolving the CodeQL `py/url-redirection` alert; behavior is unchanged.

## 0.22.0 — 2026-11-01

### Web

- Turn link previews on by default on new devices; a device where previews were turned off keeps that choice, and the setting's help text says it is on by default.
- Simplify device settings, conversation details and message details: show connection state instead of the device ID (now collapsible), drop the session countdown and message technical IDs, show key states only when they need attention, and shorten the security text.
- Show "Delivered to" and "Pending" only when they list someone, so a fully read message no longer shows "Delivered to: None confirmed"; notes appear only when they apply.
- Remove a stale link-preview help sentence about an on-device cache that no longer exists.

## 0.21.0 — 2026-11-01

### Backend

- Rename the product to Sideword in the API title and description, server pages and release documentation; operational names, settings and storage identifiers are unchanged.
- Load link previews through official oEmbed APIs for YouTube, Vimeo, Reddit, TikTok, Spotify and SoundCloud, and through a page's advertised oEmbed endpoint when it has no preview tags; only plain-text fields and thumbnails are used, with the same fetch protections and one 12-second budget.

### Web

- Deliver link previews that finish loading after Send: the sender's client sends them in an encrypted follow-up bound to the original message, so sender and recipients both see the card ease in while recipients still never fetch; clients before 0.21.0 keep such follow-ups queued until reloaded.
- Present the bundled client as the Sideword web messenger.

## 0.20.0 — 2026-11-01

### Backend

- Report blocked link-preview destinations like other failed fetches, so the preview service no longer hints at internal DNS records.
- Apply the client's security headers to invite pages and URL-encode invite tokens in their links.
- Enforce Trusted Types on client and invite pages, and send `nosniff` with static assets.

### Web

- Move link previews to the sender: the composing client fetches the preview and sends it inside the encrypted message, so recipients never fetch and link owners cannot see when a message is opened; older clients reject preview payloads until reloaded.
- Prefetch the draft's link once it looks complete; removing it before sending cancels the request, and Send never waits for a preview that is still loading.
- Remove invite tokens from the address bar and session history when the page loads.
- Give link previews one fixed card width, narrow text-only messages to about 70 characters per line and cap messages with previews or media at a compact width.
- Replace the chat image loading spinner with a frame-filling skeleton and fade images in; reduced motion keeps them static.
- Load stored history with one render instead of one per message.
- Add classic viewport fallbacks for dynamic viewport sizes, load the current stylesheet on invite pages, and drop the "unaudited" labels from the client and documentation.

## 0.19.0 — 2026-11-01

- Make HTTP(S) URLs in messages clickable through DOM-built, no-referrer links that open in a new tab; other schemes stay text and encrypted payloads are unchanged.
- Warn inline about links to lookalike or `@`-deceptive hosts.
- Add opt-in link previews through the optional isolated `link-preview` service: when enabled on a device, compact cards with title, description and image load automatically; nothing shows when no preview is available, and images are re-encoded locally.
- Show the backend version in the client and administration headers.
- Use admin-palette icons on administration pages.

## 0.18.0 — 2026-10-31

- Add a locally stored device setting for incoming images: show supported JPEG/PNG/WebP images automatically (default) or hide them behind Show image. Hidden images are not copied to Blob URLs or decoded, generic-type files stay downloads, and this device's own images always preview.
- Open decoded previews in an accessible full-screen viewer with fit, zoom buttons, +/−/0 keys, double-click/tap zoom, scrollable panning, Escape and a separate generic download; the viewer uses its own validated Blob URL, released on close, chat switch, session loss and page hide, and suppresses read confirmations underneath it.
- Reduce oversized JPEG/PNG/WebP selections up to 20 MiB, including browser-copied chat images that paste as large PNGs, to validated metadata-free JPEGs that fit the chat's send limit; Send waits for local reduction and failures show inline errors.
- Show a local thumbnail for selected, pasted or dropped images after size and peer-key checks; stale reads and decodes are discarded on cancel, replacement or chat switching, and nothing uploads until Send.
- Show a visible unavailable state for declared images that fail validation or decoding instead of collapsing the frame.
- Use identical text, file-row and image spacing in sent and received attachment cards; hidden rows no longer add gaps.

## 0.17.0 — 2026-10-29

- Deliver encrypted text and attachment references without waiting for media transfer; use a separate bounded media queue with independent durable ACKs, immutable retries and the original expiry deadline.
- Add optional text above compact filename-free attachment cards and automatic visible JPEG/PNG/WebP previews with loading placeholders; retain the 1 MiB limit, original downloads, validation/resource caps and image-only Blob CSP; show recovery controls only for sends needing attention.
- Keep restored chats at the latest messages while media loads; reserve stable preview frames and preserve older reading positions after user scrolling.
- Match success indicators across the client, administration and Pages site with accessible forest/sage greens for light and dark themes.
- Simplify the Pages architecture section into one annotated delivery flow without repeated steps or dividers.

## 0.16.0 — 2026-10-28

- Automatically reset server-side SQLite state on increasing pre-1.0 version deployments, even with compatible schemas; preserve same-version data, reject downgrades, and retain schema checks for stable releases.
- Keep one private database recovery copy by rename on persistent storage, restore the previous database/image after failed activation, recover interrupted replacements, and remove recovery files and inventoried deployment backups only after full verification.
- Preserve browser-local keys/history across server resets; users, invitations, sessions, queued messages and administrative records are recreated without migration or data transfer.

## 0.15.1 — 2026-10-28

- Fix manual deployment publication with Docker containerd manifest/index IDs; verify the checked image through its registry manifest and normalize the config digest for host verification, including single-image BuildKit provenance indexes.

## 0.15.0 — 2026-10-28

- Harden deletion with SQLite overwrite-on-delete and truncated rollback journals; omit queued ciphertext and deleted free pages from supported backups while preserving restart recovery and retry metadata.
- Default undelivered content to seven days with fixed deadlines, block expired delivery before cleanup, and show expired/unavailable confirmations per recipient; the schema change requires fresh state.
- Add one encrypted attachment per message, up to 1 MiB, in personal and group chats; encrypt filenames, declared types and bytes with per-recipient message keys and reuse durable delivery, encrypted history and immutable outbox retries.
- Accept clipboard file/image pastes and file drops into the conversation through the same review-before-send flow, retaining one-file/1 MiB limits and ordinary text paste.
- Introduce application payload v1 for explicit text/file messages while retaining cryptographic envelope v1 and HTTP API v1; require fresh state and matching clients without legacy payload fallback.
- Bound envelope, aggregate send, per-chat storage, HTTP concurrency and polling/WebSocket buffers; keep existing sender/global quotas and cap text at 16,000 UTF-8 bytes.
- Refine file selection, compact sent cards, two-line filenames and inline errors; downloads use explicit generic Blobs with sanitized names and URL cleanup. No previews, captions or automatic opening.

## 0.14.0 — 2026-10-28

- Store display names per chat membership while retaining the shared device identity; reconnects preserve room names and configuration bundle v2 carries them through export/import. The membership schema changes require fresh server state; no automatic migration is provided.
- Match the test client's red palette to the Pages site and stabilize opening by preparing the initial chat snapshot before revealing the workspace, reserving connection-label width and avoiding late font swaps.
- Keep the full loader for normal openings and use a subtle progress line on browser reloads, delayed by one second with accessible progress semantics and reduced-motion support.

## 0.13.2 — 2026-10-22

- Replace the Debian container base with Python 3.12 on Alpine, use compatible binary dependency wheels, and preserve the non-root runtime, persistent paths, health checks and strict vulnerability gates.

## 0.13.1 — 2026-10-22

- Remove curl, pip and its bundled libraries from the runtime image, apply available Debian updates during builds, and use a local Python health check while preserving dependency validation and strict vulnerability gates.
- Include the administrator password-reset command in container images and verify its presence before retaining a build.

## 0.13.0 — 2026-10-22

- Refresh runtime and development dependencies, exclude older vulnerable ASGI/JWT/template/parser versions, and scan resolved Python dependencies in CI.
- Require a JSON Content-Type on JSON API requests; keep authentication, invite, WebSocket and encrypted delivery protections covered by regression tests.
- Reject admin passwords over 72 UTF-8 bytes during creation and verification without truncation or compatibility hash formats.
- Remove legacy WebSocket URL/subprotocol authentication, deletion-only ACKs, automatic read-and-delete behavior, old receipt/history conversions and database migrations; require the current protocol and fresh state for each pre-release.
- Replace the deprecated Starlette HTTPX test adapter with maintained HTTPX2 and keep configuration exports in the current format.
- Update GitHub Actions to numeric release tags and the Python 3.12 Docker base; preserve hidden Pages assets and monitor dependencies on develop through Renovate's approval-gated Dependency Dashboard.

## 0.12.1 — 2026-10-15

- Reduce roster-loading queries by fetching each membership and its user together while preserving key validation and invite reconnect checks.
- Speed up message rendering by avoiding repeated delivery-status calculations for timestamps and sharing date formatters within each render; preserve message order, displayed status, and locale/time-zone updates.

## 0.12.0 — 2026-10-15

- Send messages with Enter and insert a new line with Shift+Enter in the test client; preserve composition input and prevent repeated key presses from submitting twice.
- Explain when a conversation is waiting for another participant, why sending is disabled, and how messaging becomes available while keeping saved history visible.

## 0.11.1 — 2026-10-09

- Recover stalled WebSocket connections with bounded connection/authentication waits and capped, randomized retries; release sockets on offline events and navigation, and reconnect restored pages.
- Bound HTTP requests and response-body waits so interrupted synchronization can retry without losing encrypted outbox data or treating an uncertain response as confirmed delivery.
- Verify the live connection's device identity before processing its backlog, and distinguish initialized connections from recipient delivery; retain independent device keys and history across browser origins.

## 0.11.0 — 2026-10-08

- Require registered renewable client sessions for activation, HTTP and WebSocket authentication; remove legacy JWT issuance, migration and compatibility settings.
- Remove ambiguous row-ID acknowledgements and client-message-ID reads; clients must use exact delivery references.
- Recheck authenticated session expiry and revocation before issuing a new session; preserve saved browser keys and history when retired logins are rejected.

## 0.10.0 — 2026-10-08

- Add reversible conversation closure that blocks new joins, sends, queued delivery and presence through every session while preserving memberships, local history and pending messages.
- Keep closed conversations available as saved history, pause their outgoing retries, and retain messaging in other conversations; administrators can reopen without changing invite revocation.
- Clarify that invite revocation disables its admissions and issuing sessions while conversation closure controls all participants; preserve closure state in configuration exports and imports.
- Compact the admin Chats table with expandable member counts, stacked type tags and shorter Close/Reopen labels; keep invite actions on one row.

## 0.9.2 — 2026-10-08

- Revalidate each affected WebSocket on invite revocation or deletion, preserving connections authenticated through other valid invites.
- Clarify identity-wide chat membership, invite-bound session expiry and revocation, local history preservation, and the separate controls required to remove participants or terminate conversations.

## 0.9.1 — 2026-10-07

- Reduce client asset transfers with public-only gzip compression, bounded browser/CDN caching and proxy buffering; preserve no-store responses for invites, authenticated APIs and errors.

## 0.9.0 — 2026-10-07

- Replace technical receipt messages with compact sending, sent, delivered, read and failed indicators; show orange double checks once any recipient confirms reading, with accessible per-recipient message details and expandable full identifiers.
- Use compact, content-sized message bubbles with matching sender/time typography above each group, small overlapping checks beside the final text line, and viewport-aware desktop details or a mobile sheet.
- Separate durable delivery acknowledgements from visibility-based viewing confirmations, removing ciphertext after encrypted local persistence while preserving retries and original group recipients.
- Clean up cancelled WebSocket initialization as well as active receive loops, publishing offline presence without closing remaining observers.
- Negotiate delivery/viewing support before using new request fields; keep durable deletion acknowledgements compatible with older backends without claiming unsupported confirmations.
- Retain bounded sender-only confirmation metadata for recovery across polling, WebSockets, reloads and tabs; migrate legacy receipt history without claiming human reading and preserve existing client authentication and encryption.

## 0.8.0 — 2026-10-07

- Show ephemeral participant presence and online counts in the test client using authenticated, opt-in WebSocket snapshots; handle multiple connections, reconnects, heartbeat expiry, and unknown status when connectivity is unreliable.
- Scope presence to current conversation memberships without storing activity history; add a presence toggle for deployments with independent workers and preserve legacy WebSocket event streams.

## 0.7.0 — 2026-10-07

- Show sender names beneath outgoing and personal-chat messages, and reader names with public IDs on read receipts; fall back to public IDs for unnamed participants and refresh labels in saved history when the roster is available.
- Prevent selecting the Send button label and refresh client scripts and styles on reload.
- Redesign the test client as a compact messaging workspace with separate mobile conversation views, visible pending retries, and accessible conversation and device dialogs.
- Keep full participant IDs and fingerprints available for comparison and copying, distinguish local pins from identity verification, and show changed-key messaging blocks outside the details dialog.
- Match client activation and invite landing pages to the Sideword visual identity with bundled IBM Plex fonts and persistent Light, Dark, and System appearance preferences; keep admin sign-in unchanged.
- Show a loading state during saved-device restoration so refreshing a chat does not briefly display the invite activation form.
- Compact the mobile client headers with visible Back navigation and labeled settings/details icons, preserving the desktop layout and visible connection/security information.
- Restore the selected mobile conversation and view after refresh, open conversations at their latest messages, and preserve older reading positions during polling and viewport changes.

## 0.6.0 — 2026-10-07

- Replace the test encryption protocol with native non-exportable P-256 ECDH keys, keeping HKDF-SHA-256, AES-256-GCM, local key pinning, encrypted history, and durable delivery safeguards.
- Require validated 65-byte P-256 public points for activation and configuration imports; reject retired device credentials and mixed-curve rooms. Existing test rooms require new invites and identities; the browser starts a separate P-256 device store without deleting prior data.
- Keep the test envelope at v1 and the HTTP API at /api/v1 with an explicit P256 algorithm identifier and a new authenticated context; remove all X25519 encryption support.
- Check that browser device keys can be restored from local storage before invite activation, avoiding admission on incompatible storage while retaining non-exportable keys.
- Report unreadable or missing local device data separately from a device change, preserve unreadable records, and keep startup storage errors visible on the join form.
- Explain browser storage, changed keys, login, invite, and service failures in plain language; show HTTP status for rejected requests and keep raw server validation values and exception text out of client errors.

## 0.5.0 — 2026-10-06

- Show each sender's chosen display name alongside their public ID on incoming group messages, including existing local history when sender routing metadata is available; refresh client assets on reload.
- Open restored chat history at the latest messages after refresh, including when server synchronization is unavailable, while preserving the scroll position when reading older messages.

## 0.4.0 — 2026-10-06

- Require body-based invite activation and switch the bundled client to keep admission tokens out of activation URLs; remove the path-based activation endpoint.
- Require HTTPS or local loopback for every invite activation, including password-free rooms and legacy token issuance.
- Reject invalid supplied bearer authentication instead of silently allocating an anonymous participant; validate resume credentials before acquiring the admission write reservation.
- Automatically create versioned GitHub tags and releases after CI promotion, using the matching changelog section as release notes.

## 0.3.3 — 2026-09-27

- Open the join form for a different invite URL instead of resuming the previous chat; select the invited room after activation.
- Pause background chat activity while a new invite awaits activation and preserve device keys, encrypted history, and pending sends across invite changes.

## 0.3.2 — 2026-09-27

- Recheck participant and invite validity when issuing renewable sessions, including activation retries and legacy migration across token expiry or sunset.
- Cap renewable session deadlines by invite expiry and report the earlier session deadline in profile access metadata.
- Verify refresh/revocation races and isolated backup recovery, including both signing-key rotation and removal of restored session records.

## 0.3.1 — 2026-09-27

- Reject admin logins verified against a password changed by a concurrent reset, preserving session revocation.
- Enforce the admin session cap atomically across concurrent logins and reclaim expired sessions during login.

## 0.3.0 — 2026-09-27

- Reject malformed non-ASCII CSRF tokens without a server error and accept validated same-origin no-referrer login forms.
- Keep existing chat messages in place during incoming delivery and preserve the scroll position when reading older messages.
- Stabilize the message viewport and composer during sends/read receipts; show pending retries in the sidebar and prevent input focus from scrolling the page.
- Deduplicate message uploads within a bounded retry window and persist an encrypted browser outbox before sending.
- Add admin CSRF protection, persistent login throttling, and revocable sessions.
- Add opt-in renewable client sessions with hashed refresh rotation, replay detection, per-device revocation, and explicit legacy sunset controls.
- Bound request bodies/rates, WebSocket connections/frames, queued ciphertext, receipts, retry metadata, and participant creation; enforce TLS and local-only administration by default.
- Add exact delivery ACK/read endpoints and random delivery IDs; switch browser retries to the safer contract while preserving legacy APIs.
- Atomically consume read messages and create receipts, preventing duplicate receipts from concurrent readers.
- Preserve the browser v1 wire format while separating protocol operations from UI and storage.
- Compute fingerprints locally, pin peer keys, and block unexpected key changes.
- Generate new private keys non-exportable and retain messages when history storage is unavailable.
- Revalidate WebSocket sessions before delivery and while idle; preserve existing authentication methods.
- Disable raw shared-runner access logs and document security limits and protocol migration requirements.

## 0.2.0 — 2026-09-27

- Standardize Sideword Server configuration, Docker resources, and client identifiers.
- Add a shared backend version for health and OpenAPI responses.
- Establish `develop` for changes and checked promotion to `main`.
- Add protected invites, resumable participant slots, and sealed rooms.
- Improve admin invite creation, encrypted password recovery, and live link lists.

## 0.1.0

- Initial backend: invite-based chats, encrypted-message relay, browser test client, administration, and configuration export/import.
