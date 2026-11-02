# Backups, upgrades and recovery

[Setup](../README.md#setup) · [Changelog](../CHANGELOG.md) · [Security](SECURITY_REVIEW.md)

## Backups

```sh
python -m scripts.deploy backup --source data/sideword.sqlite3 --destination backup.sqlite3
```

Creates a new private file with configuration, credentials and retry/ACK metadata,
but no queued content or deleted free pages. Non-reset deployment backups use the same command.
Protect/encrypt backups and set retention: they still contain secrets. Configuration
exports are unencrypted and omit both sessions and delivery evidence. Neither includes
browser keys/history. Ordinary restarts retain pending content; backup restores do not.

Exclude live database/journals from volume snapshots and backup agents if content must
not be retained there. Existing copies are not retroactively scrubbed. Application deletion
cannot guarantee physical erasure from SSDs, old backups, snapshots or host memory.

## Upgrade

0.21.0 adds an encrypted link-preview follow-up message; 0.20.0 clients keep those messages
queued until reloaded with matching assets.

0.20.0 adds an optional encrypted link-preview field to text messages. Clients before 0.20.0
reject those messages, which stay queued until the client is reloaded with matching assets.

0.17.0 adds a detached media queue channel. Use matching server/client assets and a fresh
pre-release database; no schema or inline-attachment wire migration is provided. Text/card
ACKs and media ACKs are independent; see [media delivery](PROTOCOL.md#independent-media-delivery).

Actions deployments reset **all server-side state** when upgrading between different
`0.x.y` versions, even with compatible schemas: users, chats, invitations, sessions,
pending messages, delivery metadata and administrative records. No data is migrated.
Same-version retries preserve data. Releases `1.0.0+` preserve data and reject incompatible
schemas; no migration strategy exists. Downgrades are blocked.

The deployer preserves configuration, secrets, volumes and networking. It locks deployment,
stops database writers and initializes private fresh state on persistent storage. The original
SQLite files remain recoverable until image, Docker/listener health and public HTTP/WS
isolation checks pass. Success deletes those files and inventoried deployment backups.
Uninventoried backups, exports and external copies need separate [retention](#backups).

Failed replacements restore the prior database/image where possible. Retries recover
interrupted work or finish verified cleanup without another reset. Recovery uncertainty
leaves the service offline; cleanup errors retain the verified backend. Never delete recovery
records/copies to force a retry. Failed attempts may extend queued-content retention.
Non-reset activation failures leave the service offline with its logical backup/image retained.

Keep configuration and database paths/mounts unchanged during recovery. Stop external
host-side writers/tools; other container writers are rejected. Unversioned data or a missing
rollback image requires operator review. Inherit the image's Python health probe.

Server resets **leave browser-local keys, histories, pins and outboxes intact**. Use matching
client assets, recreate administrators through bootstrap credentials or local
`scripts.create_admin`, and issue new invitations: old sessions/invites no longer work.
Reconnect deliberately; old history/outboxes must not be assumed to belong to recreated chats.

Outside the Actions deployer, stop writers and select fresh persistent state manually for
new pre-1.0 versions. Review [.env.example](../.env.example) without replacing secrets.
SQLite 3.35+ is required; startup rejects WAL. Releases deploy neither backend nor Pages.

## Restore safely

Snapshots can revive revoked credentials and undo later policy changes:

1. Stop writers; restore matching code/assets/data with external access blocked.
2. Rotate `SIDEWORD_SECRET_KEY` on every worker.
3. In one transaction delete `refresh_uses`, then `client_sessions`, then `admin_sessions`.
4. Reapply invite revocations, closures, deactivations and password resets made since backup.
5. Verify old JWTs/refresh credentials fail and test recovery before reopening access.

Invite resume credentials/passwords survive key rotation; revoke/change them separately.
Backups retain delivery IDs/evidence but omit pending content; affected sends show
unavailable. Older snapshots also lose later retry evidence: verify before resending.

## Rollback

Use the target release's matching code/assets/backup, test offline and follow
[credential invalidation](#restore-safely). Newer data/protections may be lost.

## Public deployment controls

- Require HTTPS/WSS. Block `/admin` and descendants, `/docs`, `/redoc`, `/openapi.json`
  over HTTP **and WS**. Proxy restricted **8001**; Docker's **8000** includes admin.
- Route aliases to one process/database. Independent workers do not share connections;
  disable presence across them. Trust only actual proxy IPs in `SIDEWORD_TRUSTED_PROXY_IPS`
  (shared runner) or `FORWARDED_ALLOW_IPS` (Uvicorn/Docker), never `*`.
- Redact invite URLs, request bodies, Authorization, cookies and WS auth at every layer.
  Use `--no-access-log --log-level warning`; WS URLs otherwise reach INFO logs.
- Set gateway/time/resource limits. Allow send bodies up to 10 MiB, other bodies 2 MiB,
  outbound WS 4 MiB. Group copies multiply resources; four HTTP operations can hold
  40 MiB of bodies before additional JSON/base64/ORM/WS copies. Measure runtime memory
  and set host budgets; wire limits are not RSS guarantees. Lower limits may reject files.
- Preserve transport ping/pong, TLS certificate checks and private no-store protections.
  See [API limits](API.md#send-retries-and-capacity) and [.env.example](../.env.example).

### Link-preview service

Previews are off unless the relay has `SIDEWORD_LINK_PREVIEW_SERVICE_URL` and
`SIDEWORD_LINK_PREVIEW_TOKEN` (32+ random characters). The relay authenticates and
rate-limits users, then forwards to a separate fetcher; it never fetches URLs itself. Only
senders request previews; recipients receive them inside encrypted messages.
Previews use their own concurrency limit, not the message request slots.

Run the fetcher with [docker-compose.link-preview.yml](../docker-compose.link-preview.yml):
same image, no database, volumes, `.env` or published ports, read-only and resource-limited.
The Actions deployer starts only `sideword`; recreate `link-preview` after image updates.

The fetcher's address checks are not a network boundary. Restrict its `sw-preview0` bridge
on the host to DNS at your resolver and TCP 443 to public addresses:

```sh
iptables -N SIDEWORD-PREVIEW
iptables -A SIDEWORD-PREVIEW -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A SIDEWORD-PREVIEW -d RESOLVER_IP -p udp --dport 53 -j RETURN
iptables -A SIDEWORD-PREVIEW -d RESOLVER_IP -p tcp --dport 53 -j RETURN
iptables -A SIDEWORD-PREVIEW -d 0.0.0.0/8,10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.0.0.0/24,192.168.0.0/16,198.18.0.0/15,224.0.0.0/3 -j DROP
iptables -A SIDEWORD-PREVIEW -p tcp --dport 443 -j RETURN
iptables -A SIDEWORD-PREVIEW -j DROP
iptables -I DOCKER-USER -i sw-preview0 -j SIDEWORD-PREVIEW
```

Persist the rules, block IPv6 equivalently if enabled, and verify that private, metadata and
non-443 destinations fail from the container. Fetched sites see the fetcher's address; the
relay can link accounts to requested URLs. Neither component logs or stores them.

### Public asset transfers

Cache/compress only public `/static/` GET/HEAD responses; retain gzip, ETag/Last-Modified,
query-string cache keys and `public, max-age=3600, must-revalidate`. Deploy templates/assets
together and advance revisions; old revision URLs serve current files. Purge reused revisions
on rollback. Keep client/invite/API/admin/redirect/error responses `no-store`, uncompressed,
and preserve WS/private buffering rules. Verify proxy/CDN behavior after deployment.

## Repository identity and integrations

The source repository is [vladleesi/sideword](https://github.com/vladleesi/sideword).
Existing clones can update their remote without renaming their checkout directory:

```sh
git remote set-url origin https://github.com/vladleesi/sideword.git
# For an existing SSH remote, use git@github.com:vladleesi/sideword.git instead.
```

Repository branding does not rename operational resources. Preserve existing checkout
and deployment directories, Compose project names/networks, the `sideword` service,
`sideword-chat-server` container/image tag, `sideword-data` volume, database mounts,
`SIDEWORD_` settings and browser storage identifiers. Changing a checkout directory can
change Compose's default project name; keep the existing project identity for existing
installations. A repository rename alone requires no database reset or service restart.

Actions derives API/release/artifact lookups from `github.repository` or
`GITHUB_REPOSITORY`. Promotion remains exact-commit `develop` → `main`; backend
activation and the Pages workflow remain manual. Existing Pages settings can also
publish directly from `main:/docs`; check the repository's actual Pages source before
assuming publication requires a workflow dispatch.

Before the next manual deployment, verify external integrations against the renamed
repository: Google Workload Identity provider attribute conditions/mappings, service
account IAM bindings and any GitHub OIDC `sub` allowlists may match the repository name.
Use `repo:vladleesi/sideword:ref:refs/heads/main` where a default branch subject was
previously bound to the old name; environment/custom subjects differ. Preserve existing
provider, service account, registry, VM and secret resources. Check GitHub App/Renovate
access and external webhooks/consumers separately. Local workflow review cannot verify
cloud IAM policies or third-party configuration; do not dispatch a deployment merely
to test a rename.

Pages project paths follow the repository name. The site's canonical URL is
`https://vladleesi.dev/sideword/`, under the existing account domain; the repository has
no separate custom domain. Preserve Pages source/domain settings, verify HTTPS and the
new path, and update the homepage, canonical/social URLs, sitemap and robots together.
Do not rely on the former project-site path redirecting. Publishing revised site content
requires it to reach the configured Pages source or an authorized Pages deployment.
