# Sideword web client P-256 protocol v1

No recipient forward secrecy or post-compromise recovery. The backend and bundled
web client share one application release; HTTP API, WebSocket, message payload and
cryptographic envelope versions remain independent. See
[version meanings](../CONTRIBUTING.md#application-and-contract-versions).
`client-protocol.js` owns Web Crypto/payload operations; `client-media.js` owns local
preview validation/resources; `client-links.js` owns link detection; `client-emoji.js` owns
emoji detection and the picker; `client.js` owns trust, DOM, networking and persistence.
See [security limits](SECURITY_REVIEW.md).

## Wire representation

API `ciphertext` is standard base64 of UTF-8 envelope JSON:

```json
{"v":1,"alg":"P256-2DH-HKDF-SHA256-AES256GCM","epk":"<base64 65-byte point>","salt":"<base64 16 bytes>","iv":"<base64 12 bytes>","ct":"<base64 ciphertext + 16-byte tag>"}
```

Use uncompressed SEC1 P-256 points (`0x04 || X || Y`, 32-byte coordinates); validate
curve membership and reject compressed/other-curve keys. For each recipient:

1. Generate a fresh ephemeral ECDH pair, random 16-byte salt and 12-byte IV with CSPRNG.
2. Concatenate `DH(sender_identity_private, recipient_public) || DH(ephemeral_private,
   recipient_public)` (64 bytes); recipient derives equivalents with its private key.
3. HKDF-SHA-256 derives an AES-256-GCM key using that secret, salt and UTF-8 info:
   `sideword-web-p256-v1|{chat_id}|{client_message_id}|{sender_public_id}|{recipient_public_id}`.
   Use decimal chat ID and exact API strings.
4. Encrypt UTF-8 plaintext with that key/IV and the same context as AAD; append a
   128-bit GCM tag. Discard derived secrets/ephemeral keys; JS cannot guarantee erasure.

Reject unsupported formats/algorithms, invalid DH and authentication failures without
plaintext/weaker fallback. Context does not authenticate names, timestamps or group
membership. Groups use separate per-recipient envelopes, never a shared group key.

## Application payload v1

Plaintext JSON has exactly one of these field sets:

```json
{"v":1,"type":"text","text":"Hello"}
{"v":1,"type":"attachment-ref","text":"Optional message","name":"example.bin","mime":"application/octet-stream","size":3,"media_id":"<message-id>.media"}
{"v":1,"type":"attachment","name":"example.bin","mime":"application/octet-stream","size":3,"data":"AP8B"}
```

- Text: 1–16,000 UTF-8 bytes; arbitrary user text always goes inside `text`. An optional
  sender-made `preview` describes the first HTTPS link in `text`:
  `{"url":"https://example.com/","title":"…","description":null,"site_name":null,"final_host":null,"image":{"mime":"image/jpeg","data":"<base64>"}}`.
  All six fields are required (`null` when absent): normalized credential-free HTTPS `url`
  up to 2,048 characters; `title` ≤200, `description` ≤400, `site_name` ≤80 characters
  without control characters; lowercase `final_host`; `image` null or canonical base64 of
  a JPEG up to 96 KiB (this client sends at most 24 KiB, since each recipient gets a copy).
  At least one of title, description or image is set.
- Link-preview follow-up: `{"v":1,"type":"link-preview","target":"<client message ID>","preview":{…}}`
  attaches a preview loaded after sending to the sender's own earlier text message (`target`:
  1–58 ASCII letters, digits, underscores or hyphens). Recipients resolve the target within
  the same chat and sender only, keep the first preview, and show none of these messages.
  Clients before 0.20.0 reject inline previews and clients before 0.21.0 reject follow-ups;
  such messages stay queued until the client is reloaded.
- Reaction: `{"v":1,"type":"reaction","target_author":"<public ID>","target":"<client message ID>","emoji":"👍","rev":1}`
  sets or, with `"emoji":null`, removes the sender's one reaction to a message in the same
  chat. `emoji` is exactly one of 👍 ❤️ (U+2764 U+FE0F) 😂 🤔 😢; `target_author` and `target`
  are 1–64 ASCII letters, digits, underscores or hyphens; `rev` is a safe integer ≥ 1. See
  [reactions](#reactions).
- Attachment: `size` integer 0–1,048,576; `data` canonical padded standard base64,
  decoded length exactly `size`; nonempty `name` at most 255 UTF-16 code units;
  `mime` 0–127 printable ASCII characters, including empty.
- References carry the same metadata, optional text up to 16,000 UTF-8 bytes and
  `media_id` equal to the parent message ID plus `.media` (parent: 1–58 ASCII letters,
  digits, underscores or hyphens). File bytes are accepted only on the media channel.
- Reply: text and references may add `"reply":{"author":"<public ID>","target":"<client message ID>","excerpt":"…"}`
  naming a message in the same chat. `author` and `target` are 1–64 ASCII letters, digits,
  underscores or hyphens; `excerpt` is `null` or 1–200 UTF-16 code units without leading or
  trailing spaces, control or bidirectional formatting characters or unpaired surrogates.
  Replies hold no nested reply. See [replies](#replies).
- Reject unknown fields/types/versions, malformed encodings, size mismatches and
  payloads over 1,400,000 UTF-8 bytes. No legacy/raw-text fallback.

Names, declared types and file bytes are encrypted. One file per message; select,
paste or drop, optionally add text, review, then Send. No playback, compression or
chunking. Read no bytes before size validation/peer checks; never fetch pasted URLs.

### Independent media delivery

Send text/references normally; upload file envelopes separately with `channel: "media"`
and authenticated ID `<message-id>.media`. The relay requires the accepted parent and
matching recipients, inherits its expiry, and excludes media from WS/poll backlogs.
See the authenticated [media endpoint](API.md#encrypted-media).

Persist and ACK references without waiting for files. Separately authenticate media,
check routing/name/type/size against the reference, persist encrypted locally, then ACK.
Failed storage/verification remains retryable; recover lost ACKs from history. Viewing
or delivery of a card does not confirm file completion/opening.

Use an atomic encrypted outbox handoff and immutable media envelopes. The client allows
one background media request, six automatic attempts with backoff, bounded response
parsing, 16 MiB admission for file retries and 32 MiB total prepared retries.

### Encoding and resource budget

Maximal file with maximally escaped metadata:

| Stage | Bytes/ASCII characters |
| --- | --- |
| Original | 1,048,576 |
| File base64 | 1,398,104 |
| Payload JSON | 1,399,960 |
| GCM output + tag | 1,399,976 |
| Envelope JSON | 1,866,845 |
| Outer base64 per recipient | 2,489,128 |

Base64 length is `4 * ceil(n/3)`; envelope fields add 209 bytes plus base64 ciphertext.
The conservative four-recipient HTTP bound is 9,959,328 bytes, below 10 MiB; five
maximal copies exceed it. Smaller files support up to 100 recipients, within quotas.
The relay bounds opaque resources, not verified plaintext size/type. See [API limits](API.md#send-retries-and-capacity).

Encrypt recipients sequentially; retained envelopes still multiply bandwidth/storage.
File buffers, JSON/base64, crypto/storage copies and possibly two-byte JS strings
coexist: wire limits are not heap limits. Outbox: 100 records/32 MiB encrypted bytes;
history depends on browser quota. Storage failures withhold ACK and preserve retries.
Invalid message work is cooled down for 60 seconds in a bounded cache; reload may retry sooner.

### Downloads and confirmations

Render names with `textContent`. Suggested downloads remove path separators, controls,
bidi formatting and leading/trailing dots/spaces, capped at 180 UTF-16 units with
`download` fallback. Keep original metadata encrypted in history.

Explicit clicks create generic `application/octet-stream` Blobs and object URLs with
the `download` attribute. Never auto-open/download or embed unsupported contents. Revoke URLs
after a 60-second handoff or cleanup; at most eight live URLs. Browser/OS can refuse or
rename downloads. No server malware inspection; saved downloads are ordinary local
files that cannot be remotely revoked. Viewing confirms the card, not file opening.

### Local image previews

Preview still JPEG/PNG/WebP locally after signature/header, PNG CRC and encoded-dimension
checks; recheck decoded dimensions. Reject conflicting MIME, animation and unknown chunks.
Limits: 1 MiB, 4096 pixels per side, 4 megapixels and three active/loading previews.
Strip optional PNG metadata without decompression from preview copies; colors may differ.
Native decoder safety remains a [verification limit](SECURITY_REVIEW.md#verification-record-and-gaps).

Use typed local Blobs; preserve originals, encryption and ACK independence. Reuse nearby
previews; revoke distant/removed/chat-switched/session-invalidated/hidden-page URLs.
Canceled decodes retain slots until settled; stuck decoders may require reload. CSP
permits Blob URLs only for images; no external requests. Unsupported files stay downloadable.

Cards omit filenames, put media below optional text and reserve image frames before
decoding. Restore at latest messages; stop following when the user scrolls away.
Declared images that fail validation or decoding show an unavailable state.

Incoming images preview automatically unless a device `localStorage` setting selects
click-to-reveal; hidden images are neither copied to Blob URLs nor decoded until revealed.
Generic-type files preview only in automatic mode.

The full-screen viewer decodes its own validated copy (one decoder beyond the preview cap),
never navigates to Blob documents, downloads through the generic path and revokes its URL
on close, chat switch, session loss or page hide. It confirms nothing and suppresses read
confirmations for messages underneath.

Pre-send thumbnails read files only after size, transport and peer-key checks; cancel,
replacement or chat switching discards stale work. Nothing uploads before Send.

JPEG/PNG/WebP images above the chat's sendable size (1 MiB or less in large groups), up
to 20 MiB and 50 megapixels by header, are re-encoded locally as metadata-free JPEGs
within preview limits; transparency becomes white. Browser-copied images are PNGs, so
this lets chat images be pasted back. Output must pass preview validation; Send stays
disabled until reduction succeeds, and failure removes the selection with an error.

### Links and link previews

Only explicit `http://`/`https://` URLs in decrypted text become links; other schemes and
bare domains stay text. Bidi/zero-width characters end a URL. Links are DOM anchors with
the typed text, the parsed `href`, `noopener noreferrer` and a new tab; payloads and history
are unchanged.

Hosts with text before `@`, mixed scripts or Latin lookalike letters get an inline warning;
this is a heuristic, not a full confusable check.

Previews are made by the sender and sent inside the encrypted `text` payload, so recipients
never fetch anything and link owners cannot see when a message is opened. With the device
setting on (the default) and the server offering previews, the draft's first HTTPS link is
sent to the [link-preview API](API.md#link-previews) once it looks complete (followed by
text, pasted, or after a pause); removing it cancels the request and drops the result. Send never waits: a
ready preview goes inside the message; otherwise loading continues (or starts) and the preview
follows to the same recipients in an encrypted `link-preview` message, so both sides see the
card appear later. The image is included only when every recipient copy stays within half the
send limit. Previews live in encrypted history with their message.

Recipients show a preview only if its `url` is the message's first previewable link, revalidate
images locally, and always show the link's own host. Preview text is sender-controlled and can
be misleading, like any message text. Text renders with `textContent`; images are shown from
Blob URLs. The setting also hides received previews; without one, nothing is shown under the
link.

### Emoji

Emoji are ordinary Unicode text in the `text` payload; there is no emoji payload type. The
picker loads a same-origin static catalog of standard (RGI) emoji in default skin tone on
first open and inserts one whole emoji at the caret or over the selection, widened to whole
grapheme clusters. It refuses an emoji that would exceed the 16,000-byte or 16,000-character
limit instead of truncating it. Typed or pasted emoji, including skin tones, flags and ZWJ
sequences, are kept as written.

Messages of only one to three emoji (spaces allowed) render larger without a bubble; links,
files and mixed text render normally. Up to 24 recently used emoji are kept unencrypted in
this device's `localStorage`, validated on read and removed by Reset device.

### Reactions

Reactions are ordinary encrypted messages to every other current participant, so the relay
sees only an opaque message: no emoji, target or reaction state. Their small size and timing
can still suggest a reaction. The reactor is the authenticated envelope sender; payloads
carry no reactor field. Targets resolve within the envelope's chat only: the author's
public ID and client message ID, never relay row IDs or local entry IDs.

For each chat, target and reactor, the highest `rev` wins; equal revisions with different
emoji resolve to the greater emoji string, so every device converges in any arrival order.
Senders take the next revision after their own durably saved state and send one operation
at a time. Duplicate, stale and reordered operations therefore cannot restore a removed
reaction; they change nothing and are acknowledged without storing a new record, because
the state superseding them is already saved. Operations for messages not received yet are
kept and apply when the message arrives.

State-changing operations are saved in encrypted local history and rebuilt on reload;
they never appear in the timeline. Own operations use the normal encrypted outbox, retries
and pending-send recovery, and show as soon as they are queued. An unsent reaction is
marked until it is sent or replaced. Participants who join later do not receive earlier
reactions.

Clients before 0.24.0 reject reaction payloads as unsupported: they keep them queued without
acknowledging them, show "Message retained for retry", and apply nothing until updated or
until the content expires.

### Replies

A reply is an ordinary text or file-reference message with an encrypted `reply` field, so
the relay sees neither the quoted text nor which message is answered. Its target resolves
like a reaction's: author public ID and client message ID within the envelope's chat only.
The quote shows the target's own text, an "Image" or "File" label, never the target's own
quote, so chains never nest.

`excerpt` is the sender's short, single-line copy of the target's text (`null` for files
without text). It is shown only while the target is not on this device and is marked as
quoted by the sender, because it is sender-controlled and unverified. Once the target
arrives, in any order or after reload, the quote shows the device's own copy instead.
Filenames are never quoted.

Replies are composed per conversation in memory and cleared only after the reply is
durably queued; a send that fails earlier keeps the text and reply. Selecting a quote scrolls
to the original and outlines it briefly.

Clients before 0.25.0 reject payloads with `reply`: they keep such messages queued without
acknowledging or showing them until updated or until the content expires.

## Identity checks and local state

Compare full lowercase hex SHA-256 fingerprints of raw public points through another
trusted channel. First-use pins bind peer ID/local key/origin; atomic writes prevent
tab overwrites, and mismatches block sending/decryption. Pins cannot authenticate
initial substitution, a malicious roster or served code. Names grant no trust.

IndexedDB `sideword-test-client-p256-payload-v1` v1, store `device`, holds non-exportable
identity/history CryptoKeys. History/outboxes use separate AES-256-GCM, fresh 12-byte IVs
and full storage key as AAD; no plaintext/key export fallback. Origins have independent
state. Preserve unreadable keys/history and fail admission/renewal closed on storage or
identity mismatch; never silently replace keys. See [devices](SESSION_LIFECYCLE.md#persistence-devices-and-reconnects).

## Delivery requirements for future clients

- Serialize WS/poll receipt processing. Authenticate, check pins, decrypt, validate and
  durably persist locally **before** exact deletion ACK; keep failures retryable.
- Deduplicate by chat/sender/client message ID, not reusable SQLite row IDs. Receipts
  also bind reader/original delivery ID/stage. Normalize timestamps to UTC.
- Persist immutable outgoing envelopes before upload and retry identical IDs/ciphertext
  within the [retry window](API.md#send-retries-and-capacity), never re-encrypting.
- Encrypt acceptance/original recipients, confirmations, viewing intent and ACK markers.
  Hash event storage keys to hide recipient bindings; merge independent recipients/tabs
  without lost updates. ACK each receipt's own exact reference after persistence.
- Confirm viewing only after actual visibility and prior durable delivery; neither
  rendering/download nor presence substitutes for [confirmation rules](API.md#durable-delivery-and-actual-viewing).
- Respect closure/expiry without erasing history or automatically resending. Supported
  backups retain retry metadata but omit queued content; relay IDs do not prove decryption.

See [verification gaps](SECURITY_REVIEW.md#verification-record-and-gaps).
