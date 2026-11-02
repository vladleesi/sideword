# Security review

**Reviewed:** 2026-11-01 · **Application:** 0.22.0. Maintainer source/test review;
not an independent security or cryptographic audit. [Report vulnerabilities](../SECURITY.md).

## Controls and supporting evidence

| Area | Protection / evidence |
| --- | --- |
| Admission | HTTPS, validated P-256 keys, scrypt passwords, serialized slots and persistent guess limits; [tests](../tests/test_invite_protection.py) |
| Authorization | Live registered sessions, refresh rotation/replay revocation, membership/closure checks across HTTP/WS, public admin blocking; [sessions](../tests/test_security_stages.py), [closure](../tests/test_conversation_closure.py), [listener](../tests/test_shared_listener.py) |
| Encryption | P-256/HKDF/AES-GCM, non-exportable keys, peer pins and encrypted local history/outbox; [protocol](PROTOCOL.md), [crypto](../tests/client_crypto.test.cjs) |
| Delivery | Exact owner-bound references, atomic delivery receipts, immutable retries and persistence before ACK; [tests](../tests/client_delivery.test.cjs), [status](../tests/test_message_status.py) |
| Attachments | Strict payload/size validation, ciphertext-only relay, gesture-only paste/drop and safe explicit downloads; [client](../tests/client_attachments.test.cjs), [relay](../tests/test_attachments.py) |
| Previews | Optional click-to-reveal mode, still-image validation, dimension/resource caps, native decode checks, viewer/composer URL cleanup and trust checks before pre-send reads; [formats/lifecycle](../tests/client_media.test.cjs), [integration](../tests/client_media_integration.test.cjs), [policy](PROTOCOL.md#local-image-previews) |
| Links | HTTP(S)-only DOM anchors, no-referrer new tabs and lookalike warnings; [tests](../tests/client_links.test.cjs), [policy](PROTOCOL.md#links-and-link-previews) |
| Link previews | Device setting, on by default; sender-made previews inside the encrypted payload, so recipients never fetch; strict payload validation; isolated fetcher (page tags or official/discovered oEmbed JSON, never provider HTML) with HTTPS-only, public-address and pinned connections, revalidated redirects, size/time limits and checked images; per-user limits; local re-encoding; [fetcher](../tests/test_link_preview.py), [relay](../tests/test_link_preview_relay.py), [operations](UPGRADING.md#link-preview-service) |
| Detached media | Recipient/session-bound reads, inherited expiry, shared queue quotas and separate durable ACKs; [relay](../tests/test_media_transfer.py), [client](../tests/client_transfers.test.cjs) |
| Capacity/browser | Bounded requests/queues, CSP with Trusted Types and framing denial on client and invite pages, text-only rendering, invite tokens removed from the URL on load, no-store, `nosniff` assets, CSRF and redacted errors; [guards](../app/guards.py), [tests](../tests/test_security_stages.py), [delivery](../tests/test_static_delivery.py) |
| Build/deployment | Exact-image gates, non-root images, recoverable pre-1.0 resets and verified cleanup; [CI](../.github/workflows/test.yml), [deployment tests](../tests/test_deploy.py) |

## Threat model and limits

- Relay sees identities, memberships, routing (including media-parent links), timing, sizes and confirmations. It cannot
  verify plaintext file size/type, third-party encryption or real-world identity, and
  performs no malware inspection of encrypted files. Filenames/types are untrusted.
- V1 has no recipient forward secrecy, ratchet or post-compromise recovery. A stolen
  identity key exposes recorded inbound messages. First-use pins cannot authenticate
  initial keys, rosters or malicious served code; compromised devices remain a risk.
- TLS terminators and served code are trusted. Non-exportable keys do not stop same-origin
  malicious code. Bearer theft permits queue deletion/disruption without decryption proof.
- Links a sender previews, including unsent drafts, are visible to the relay and fetcher with
  the sender's account. Preview text and images are sender-controlled; recipients bind them
  to the message's own link and sender, keep the first one, and always show the real host.
- Names do not unlink identities. Presence/receipts are assertions, not proof of attention.
  Revocation cannot retract sent data. Process limits are not distributed DoS protection.
  See [access lifecycle](SESSION_LIFECYCLE.md) and [operator controls](UPGRADING.md#public-deployment-controls).

## Delivery, local storage and retention

References and media require separate durable local persistence before ACK. Each ACK
removes only its recipient ciphertext. Unacknowledged content expires after seven days by default;
delivery stops at the fixed deadline and cleanup runs at startup/hourly.
SQLite uses overwrite-on-delete, full synchronization and truncated rollback journals;
WAL is rejected. [Deletion tests](../tests/test_secure_deletion.py) check ordinary file
remnants, backup exclusion and retry/restart behavior. Supported backups omit queued
content/free pages while retaining bounded retry/receipt metadata and credentials.
This is best-effort deletion, not guaranteed physical erasure; see [backups](UPGRADING.md#backups).

Local history/outboxes, including link previews, remain encrypted. Session and refresh
bearer tokens are stored unencrypted in IndexedDB beside the non-exportable keys; same-origin
script or device access can read them. Encrypting them with a key stored beside them would
not protect against either; moving refresh credentials to HttpOnly cookies needs an API change. Optional downloads export ordinary local files that
revocation/deletion cannot erase. Card viewing does not confirm file opening.

## Prioritized findings and improvements

| Priority | Remaining action |
| --- | --- |
| F-01 · Medium · P1 | Independent protocol review; stronger secrecy needs a reviewed ratchet/group design. |
| F-03 · Medium · P1 | Verify credential redaction at every logging layer and protect exports; no-referrer does not erase browser history/logs. |
| F-04 · Low · P2 | Manage untracked backups/rollback images, test restores and monitor disk; automatic cleanup covers inventoried deployment backups only. |
| F-06 · Low · P2 | Preserve checked image digests and advisory monitoring; dependency ranges/numeric Action tags can resolve differently. |

## Verification record and gaps

A 2026-11-01 maintainer review of the web client found no HTML or script sinks, fixed-path
navigation, bounded WebSocket/JSON input and validated local preferences; it added the
header, invite-URL and viewport-fallback fixes above, moved link previews to the sender and
made blocked preview destinations indistinguishable from failed fetches. Browser support targets Safari 15.4+,
Chrome 105+ and Firefox 121+; older engines without `:has()` keep default message widths.

Synthetic Python/Node regressions cover payload boundaries/tampering, peer mismatch,
authorization, ciphertext persistence, duplicate WS/poll delivery, reload retries,
quota failures withholding ACKs, deletion/expiry, safe downloads and transfer gestures.
Client edge cases cover background ACKs, queued duplicates/retries and focus/storage loss before reads.
Preview tests use synthetic images and decoder/DOM fakes; native browser codec behavior and
peak memory remain unverified. Header checks cannot eliminate browser decoder vulnerabilities.
PNG preview copies omit optional profile/text/background metadata; downloads retain originals.
Scroll regressions cover bounded nearby retention, stable image frames and latest-message
positioning after history restoration and delayed content resizing.
Image regressions cover the automatic default, no decoding while hidden, preference persistence/tab sync,
viewer zoom/keyboard/focus/cleanup, stale viewer and pre-send decodes, peer checks
before pre-send reads, and header-bounded oversized-image reduction with cancellation. They use DOM fakes. Real browser layout, touch gestures,
screen-reader output and focus rendering were not checked in a browser.
Link and preview tests use DOM, DNS and socket fakes; real TLS, DNS, firewall rules,
Docker networking and browser layout were not checked. Lookalike warnings are heuristics.
Detached-media tests cover metadata-first delivery, independent persistence/ACKs, immutable
retries, interrupted handoff, routing/content substitution, cancellation and bounded retries.
Deployment regressions use fake commands and real SQLite to check digest binding,
version-aware resets, interrupted recovery/cleanup, writer locks, path/permission tampering
and redacted failures. Live Docker/VM behavior remains unverified. Failed replacements can
retain the original queue privately until [recovery completes](UPGRADING.md#upgrade).
These do not establish browser/OS behavior, native interoperability or deployed memory,
proxy/IAM/log/backup controls. Independent cryptographic review remains outstanding.

Previous image/advisory/deployment checks were for **0.13.2**, not this release.
One unsuppressed hosted Medium `py/url-redirection` alert remains in admin bulk deletion;
source review limits destinations to users/links/chats. CodeQL gate tests cover failures
and severity handling; hosted enforcement for this release remains unverified.
Scanner policies/settings belong in [Contributing](../CONTRIBUTING.md#security-checks).
