<p align="center"><img src="docs/mark.svg" alt="Sideword" width="96" height="96"></p>

<h1 align="center">Sideword</h1>

<p align="center">
  <a href="https://github.com/vladleesi/sideword/releases/latest"><img src="https://img.shields.io/github/v/release/vladleesi/sideword?style=flat-square&amp;label=Release" alt="Latest release"></a>
  <a href="https://github.com/vladleesi/sideword/actions/workflows/test.yml?query=branch%3Adevelop"><img src="https://img.shields.io/github/actions/workflow/status/vladleesi/sideword/test.yml?branch=develop&amp;event=push&amp;label=Tests&amp;style=flat-square" alt="Tests on develop"></a>
  <a href="#run-locally"><img src="https://img.shields.io/badge/Python-3.12%2B-3776AB?style=flat-square&amp;logo=python&amp;logoColor=white" alt="Python 3.12+"></a>
  <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-009688?style=flat-square&amp;logo=fastapi&amp;logoColor=white" alt="FastAPI"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/SQLite-003B57?style=flat-square&amp;logo=sqlite&amp;logoColor=white" alt="SQLite"></a>
  <a href="#docker"><img src="https://img.shields.io/badge/Docker-2496ED?style=flat-square&amp;logo=docker&amp;logoColor=white" alt="Docker"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License: MIT"></a>
</p>

Sideword is a self-hosted, end-to-end encrypted messenger for private conversations.
It includes a browser-based messenger, an administrative interface and a FastAPI/SQLite
backend in one application.

Read the [security limits](SECURITY.md) before using Sideword for sensitive conversations.

## Overview

An administrator creates a personal or group chat and shares invite links. Participants
open the bundled web app, join with a browser-local identity and exchange encrypted
messages and files. No separate client build or installation is required.

## Features

- Invite-only individual and group conversations, with per-chat display names.
- Expiring invites, optional room passwords and administrative chat/access controls.
- Client-side encryption for text, replies, reactions, attachments, filenames and file types.
- Attachments up to 1 MiB, with local image previews and explicit downloads;
  [group size and media limits](docs/PROTOCOL.md#independent-media-delivery) apply.
- Real-time WebSocket delivery with HTTP polling fallback, delivery/viewing status
  and optional participant presence.
- Renewable sessions, encrypted browser-local history and persistent send retries.
- Clickable links and optional sender-made encrypted link previews when the separate
  [preview service](docs/UPGRADING.md#link-preview-service) is configured.
- A bundled admin UI, Docker tooling and documented HTTP/WebSocket interfaces.

## Privacy and security

The web app encrypts message content locally and creates a separate envelope for each
recipient. The server temporarily stores and relays ciphertext; each recipient's copy is
deleted after its durable acknowledgement or expiry (seven days by default).
Server deletion cannot erase recipients' local history or downloaded files, and physical
erasure from storage, snapshots or backups is not guaranteed.

The server sees identities, memberships, routing, timing, sizes and confirmations.
Optional link-preview requests also disclose the sender's requested URL, including
unsent drafts, to the relay and fetcher. Invite admission and authenticated sessions
control access; they do not verify who a peer is. Compare peer key fingerprints through
another trusted channel. First-use pins cannot authenticate initial key substitution
or malicious code served by the host.

Browser keys are non-exportable and local history is encrypted, but same-origin code
and device compromise remain risks. Use a dedicated, trusted browser origin. Different
origins, profiles and devices have independent identities: keys and history do not sync.
Clearing browser storage can permanently lose them. The protocol has no recipient
forward secrecy or post-compromise recovery.

See the [security policy](SECURITY.md), [security review](docs/SECURITY_REVIEW.md),
[device lifecycle](docs/SESSION_LIFECYCLE.md) and [recovery guide](docs/UPGRADING.md).

## Getting started

### Setup

Use Docker with Compose v2, or Python 3.12+ for a local installation.

```sh
git clone https://github.com/vladleesi/sideword.git
cd sideword
cp .env.example .env
```

Set `SIDEWORD_ADMIN_USERNAME`, `SIDEWORD_ADMIN_PASSWORD` and a random
`SIDEWORD_SECRET_KEY` in `.env`. Generate the signing secret with:

```sh
python -c "import secrets; print(secrets.token_urlsafe(64))"
```

Keep `.env` private. Review [.env.example](.env.example) for configuration.

### Docker

```sh
docker compose up -d --build
```

Loopback **8000** includes administration. Data uses the `sideword-data` volume;
exports use `./exports`. `docker compose down -v` deletes data. Existing installations
must preserve their paths and Compose project identity; see
[repository rename compatibility](docs/UPGRADING.md#repository-identity-and-integrations).

### Run locally

```sh
python -m venv .venv
# Activate .venv, then:
python -m pip install -r requirements.txt
python -m scripts.serve_shared
```

Loopback **8000** includes administration; **8001** blocks admin/schema routes.

### Open the web app

Open `http://localhost:8000/client` for the messenger and
`http://localhost:8000/admin/links` to create invites. Share invite links and any room
password separately. Local `/docs` provides OpenAPI; `/health` reports health and the
application version.

Create or reset an admin with `python -m scripts.create_admin --username admin`
(Docker: prefix with `docker compose exec sideword`). Passwords are limited to 72 UTF-8
bytes; resets revoke admin sessions. Remove bootstrap credentials after account creation.

### Public access and upgrades

Set `SIDEWORD_PUBLIC_URL=https://chat.example.com` and use an HTTPS/WSS proxy to
restricted port **8001**. Docker's **8000** needs explicit admin/schema blocking over
HTTP and WebSocket paths. Follow the [deployment controls](docs/UPGRADING.md#public-deployment-controls).

Increasing pre-1.0 application versions resets all server state in Actions deployments;
same-version redeployments preserve it. Browser-local keys/history remain. Use matching
server/client assets and read the [upgrade and recovery rules](docs/UPGRADING.md#upgrade)
before changing versions.

## Architecture

The bundled web messenger performs encryption, peer key checks and local persistence.
The FastAPI backend authenticates sessions, enforces chat membership and relays encrypted
messages over WebSocket or HTTP, using SQLite for configuration, delivery queues and
bounded retry/status metadata. The admin interface manages chats, invites and users.
An optional isolated service fetches sender-requested link previews.

The backend and bundled web client ship in one image with one application release
version. API, WebSocket, encryption, payload and asset revisions have separate meanings;
see [versioning](CONTRIBUTING.md#application-and-contract-versions).

## Documentation

- [Access, sessions and devices](docs/SESSION_LIFECYCLE.md)
- [Installation operations, backups, upgrades and recovery](docs/UPGRADING.md)
- [HTTP and WebSocket API](docs/API.md)
- [Encryption, payloads and client requirements](docs/PROTOCOL.md)
- [Security evidence and limitations](docs/SECURITY_REVIEW.md)
- [Changelog](CHANGELOG.md) and [third-party notices](THIRD_PARTY_NOTICES.md)

## Contributing

Use [issues](https://github.com/vladleesi/sideword/issues) for bugs and proposals and
pull requests for focused changes. Read the [development and release guidance](CONTRIBUTING.md)
and [code of conduct](CODE_OF_CONDUCT.md). Report vulnerabilities privately as described
in [SECURITY.md](SECURITY.md).

## License

Sideword is [MIT licensed](LICENSE). Bundled third-party materials retain their
[own notices and licenses](THIRD_PARTY_NOTICES.md).
