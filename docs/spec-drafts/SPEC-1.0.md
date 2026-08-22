# Snug Protocol — Specification 1.0

- **Version:** 1.0 · **Date:** 2026-08-22 · **Task:** TASK-20260822-spec-10-final
  (consolidated at v0.3 by TASK-20260820-spec-v03-whitepaper)
- **Status: NORMATIVE.** This is the complete specification of the protocol — wire,
  storage, connected apps, runtime contracts, and linked-device connections. One section
  is explicitly **provisional** and so marked: §17 (standing approvals); everything else
  is stable at 1.0. The version stays 1.0 through pre-launch editorial corrections; every
  published change is recorded in the spec changelog.
- **Supersedes as documents:** the v0.1 `SPEC.md` wire-protocol core, `SPEC-v0.2-draft.md`
  (content carried forward into Part II), and the v0.3 consolidated draft this document
  finalises. In the published spec repository, this document IS `SPEC.md`; the historical
  filenames remain as pointer stubs.
- **Versioning:** spec versions are independent of implementation package versions.
  Post-1.0, additive changes bump the minor (1.x); a change that breaks a conforming
  implementation bumps the major. Every published change is a single commit referencing
  its origin task.
- **Normative schemas:** JSON Schema for every published message type, exported
  byte-identical from the reference implementation (`packages/protocol`). Schemas are
  `io: 'input'` shapes: validators MUST accept unknown fields (rule R2).
- **Source of truth:** where this prose and the reference implementation disagree, the
  implementation's contract files win and this document is the bug. The load-bearing files:
  `packages/protocol/src/{constants,frames,envelope,reply,userdb-schema,auth-schema,connection-requirement,connection-url,render-directive,runtime-contract,chat-intent,sidecar-contract,security}.ts`
  and `packages/db/src/crypto/container.ts` (all locked by tests, several by snapshot).

## Stability at a glance

| Part | Surface | Stability |
|---|---|---|
| I | Wire protocol — the nine core frames, chat envelope, rules R1–R6 | **Normative** (published since v0.1) |
| II | Portable user database (storage schema v6), `.snug` naming, `SNUGENC1` | **Normative** (first published as the v0.2 draft) |
| III | Connected apps: requirements, grants, custody, the executor | **Normative at 1.0** |
| IV | Runtime contracts and the app chat surface | **Normative at 1.0** |
| V | Linked-device connections (the sidecar surface) | **Normative at 1.0** |

The net and open-url frame pairs, `capabilities.net`/`openUrl`, and rule R7 joined Part I
with the v0.3 consolidation and are normative at 1.0 (Appendix C records the publication
line). One section is explicitly **provisional** and so marked: §17 (standing approvals).

**Revisions, v0.3-draft → 1.0** (2026-08-22): (1) §11.1's `SNUGENC1` slot-table layout
corrected to the shipping container — 61-byte slot stride (kind + IV + 48 reserved
MUST-be-zero bytes), 160-byte two-slot header (found by the pre-launch spec-vs-code
conformance review; first publication of the correction). (2) §20.8's route table carries
`POST /session/forget`, the wizard-only deep-delete unlink (first publication; the
reference implementation shipped it 2026-08-21). (3) §12.12 gains the web-surface
capability seats (`webRedirectPosture`, `webRegistration`). (4) Editorial promotion:
normative status, post-1.0 versioning semantics, stability table. No JSON schema bytes
changed from the v0.3 publication.

## Conventions

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used in the sense of
RFC 2119. Constants are stated with their exported names so they can be checked
mechanically against the reference implementation.

---

# Part I — The wire protocol

## 1. Overview

Snug connects agents to apps: LLM-authored single-file HTML micro-apps run in a sandboxed
iframe and think through the **host's** agent at runtime, over two coupled contracts:

1. **Frames** — postMessage messages between the app iframe and the host runner.
2. **Chat envelope** — the tagged message a host sends to its own agent endpoint for an
   app-originated turn, and the JSON-only reply contract for the agent.

Every frame carries `v: 1`; the chat envelope carries `snug: 1`. The wire protocol is
version 1 and has been additively extended, never broken, since v0.1.

## 2. Frames

Thirteen frame types are defined, and all thirteen are published as JSON Schemas — the
nine core frames since v0.1, the net pair and the open-url pair with v0.3 (Appendix C).
The strict pairs' refinement rules are carried by this prose, not by the schemas, which
JSON Schema cannot express (§3).

| Type | Direction | Purpose |
|---|---|---|
| `snug:app-announce` | app → host | Self-describing metadata on mount: `appId` (≤128), `displayName` (≤80), optional `description` (≤400), `iconEmoji` (≤8), `iconColor` (≤32). Hosts ack with `snug:host-ready`. |
| `snug:host-ready` | host → app | On iframe load AND as announce-ack (idempotent): `instanceId`, `protocolVersions`, `capabilities`, `theme`, `locale?`. |
| `snug:app-message` | app → host | An agent request: `requestId`, `instanceId`, `appId`, `action` (≤128), structured `payload?`, `state?`, `responseSchema?`. |
| `snug:app-cancel` | app → host | Abort an in-flight `requestId`. |
| `snug:app-response` | host → app | Streaming / final / error, per R3. Three shapes: cumulative `text` (+ optional `seq`); a final `data` object; or an `error`. |
| `snug:db-request` / `snug:db-response` | app ↔ host | Host-brokered per-app storage: `op ∈ exec, export, import, kvGet, kvSet`. |
| `snug:net-request` / `snug:net-response` | app ↔ host | The governed network capability (§3). The iframe still has **zero** network of its own (C2); this pair is the app's only path to the network, and the host is the only caller. |
| `snug:open-url-request` / `snug:open-url-result` | app ↔ host | Host-mediated navigation (§4). The **host** opens the user's real browser after its own confirm dialog, on a user gesture; the sandbox gains no capability. |
| `snug:host-event` / `snug:app-event` | either | Open additive channel (`theme-change`, `visibility`, `connection-event`, `resize {height}`, …); unknown events ignored. Subject to rule R7. |

**Capability advertisement.** `snug:host-ready.capabilities` requires `streaming`, `db`,
and `auth` booleans; `net?: boolean` and `openUrl?: boolean` are optional additive flags
(R2-safe — pre-feature frames still parse). Absence of a flag is how an app knows to render
a fallback rather than a broken control.

## 3. The net frames

`snug:net-request` is **strict** (an unknown key rejects the frame — the one deliberate
departure from tolerant parsing, because this frame's fields become a real network request):

- `url` (1–4096), `method ∈ NET_METHODS` = `GET, HEAD, POST, PUT, PATCH, DELETE`
- `headers?` (names 1–128, values ≤4096), `body?` (≤262 144 chars)
- A `body` on GET/HEAD is **rejected**.
- Any header whose lowercase name is in `STRIP_HEADERS` (`authorization`, `cookie`,
  `set-cookie`, `x-api-key`, `proxy-authorization`) makes the **whole frame malformed** —
  an app cannot send a credential-shaped header across the bridge at all (C1).
- **There is no `appId` seat, by design.** The net binding is host-assigned, like
  `dbNamespace`: the host knows which app a frame came from by message source (R4), and an
  identity field would only exist to be forged.

`snug:net-response` carries `status` (100–599), whitelist-filtered `headers`, `body`, and
`truncated?` — or an envelope error. The response-header whitelist is
`content-type, content-length, cache-control, etag, last-modified, retry-after, link` plus
the `x-ratelimit-*` glob; `set-cookie` never crosses.

What the host MUST do between these two frames — the ceiling, the confirm gate, the
injection, the scrub — is Part III (§14). The frames only carry the request and the answer.

## 4. The open-url frames

`snug:open-url-request` is strict: `url` (1–2048), which MUST parse as a URL, MUST be
`https:`, and MUST carry no username or password (the phishing shape is refused at the
schema). There is no target, no window-features seat, and no navigation primitive — the
frame is a request that the **host** open the URL in the user's real browser.

Host obligations: show the **full URL** in the host's own confirm dialog, open only on a
user gesture, and answer with `snug:open-url-result` — `status ∈ opened, declined, refused`
(+ `reason?` ≤300). C2 is unchanged: the sandbox never gains `allow-popups`, and a host
that advertises `capabilities.openUrl: true` is promising exactly this mediated flow.

## 5. Normative rules

- **R1 Versioning.** Every frame carries `v: 1`; the chat envelope carries `snug: 1`.
  Unsupported versions are rejected with `UNSUPPORTED_VERSION`. Parse failures surface a
  `requestId` recovered from the raw frame when it carried a plausible string id (1–128);
  hosts answer `UNSUPPORTED_VERSION`/`MALFORMED` on the wire only in that case (never
  otherwise). `snug:host-ready.protocolVersions` advertises support.
- **R2 Additivity.** A frame with a valid `v` but unrecognized `snug:*` type MUST be
  silently ignored. Unknown fields on known frames MUST be ignored (the strict net and
  open-url frames are the stated exceptions: their fields become real-world effects, so
  unknown keys reject). The `snug:` type prefix and the event namespaces are reserved.
- **R3 Terminal frame.** Every accepted `requestId` receives exactly one terminal
  `snug:app-response` (`ok:true, streaming:false` or `ok:false`). `streaming:true` frames
  are cumulative prose, display-provisional; the terminal frame is authoritative. Hosts MAY
  suppress streaming for schema-constrained requests. (`mode: 'delta'` + `seq` reserved.)
- **R4 Identity.** Hosts route by `event.source` (sandboxed iframes have a null origin;
  `targetOrigin` is necessarily `'*'`). The host mints `instanceId` (delivered in
  `snug:host-ready`); apps echo it in every request. A new `snug:app-announce` from the
  same iframe invalidates in-flight work (`SUPERSEDED`). `appId` is display metadata,
  **not** a security principal. `requestId` MUST be unique per instance.
- **R5 Error codes.** `error.code` is an open string; known codes:
  `PARSE_FAILED`, `THREAD_CONFLICT`, `NETWORK_ERROR`, `RESET_FAILED`, `CANCELLED`,
  `SUPERSEDED`, `UNSUPPORTED_VERSION`, `CONSENT_REQUIRED` (reserved), `AUTH_REQUIRED`
  (reserved), `HOST_ERROR`. The net capability adds its own registry (Appendix A):
  `NET_INVALID_REQUEST`, `NET_NOT_APPROVED`, `NET_IMPORTED_UNAPPROVED`,
  `NET_AMBIGUOUS_CONNECTION`, `NET_SCHEME_BLOCKED`, `NET_HOST_BLOCKED`,
  `NET_SSRF_BLOCKED`, `NET_CONFIRM_DENIED`, `NET_REDIRECT_BLOCKED`, `NET_SIZE_EXCEEDED`,
  `NET_FETCH_FAILED`, `NET_AUTH_FAILED` (+ `NET_SCRUBBED_HEADER_STRIPPED`, reserved).
  Receivers treat unknown codes per `retryable` and render as `HOST_ERROR`.
- **R6 Limits.** Frames ≤ 256 KiB, except two larger size classes: `db-request`/
  `db-response` ≤ 8 MiB (so a base64-encoded 5 MiB artifact round-trips through the db
  bridge), and `net-request`/`net-response` ≤ `MAX_NET_FRAME_BYTES` = 1 MiB + 64 KiB
  (a 1 MiB response body plus envelope margin; an oversized net answer becomes a terminal
  `NET_SIZE_EXCEEDED`, never a silent drop). Net request bodies ≤ 256 KiB; net response
  bodies ≤ 1 MiB, capped **while reading**. Artifacts ≤ 5 MiB; `rawExcerpt` ≤ 200 chars;
  announce strings capped (displayName 80, description 400). Parse-failure budget: 3
  consecutive, then the host requires an explicit user reset. Thread-conflict backoff:
  100/250/500 ms.
- **R7 Push hints (since v0.3).** A host-initiated push (`snug:host-event`) carries
  **references, never content** — a doorbell, not a delivery. The app answers a hint with
  its own governed reads, and the host rebuilds every field of a hint before forwarding.
  Two frame-layer facts force this shape and make it normative rather than stylistic:
  host-event frames ride the ordinary 256 KiB class and an oversized frame is dropped
  **silently**, and host-event frames carry no `instanceId`, so a stale sender is
  indistinguishable from a live one. With hints, a stale or dropped event costs one
  redundant refetch and can never inject state.
- **Security (C1/C2).** Credentials never enter the iframe, the LLM payload, or a
  publisher. Hosts MUST strip `authorization`, `cookie`, `set-cookie`, `x-api-key`,
  `proxy-authorization` from any app-originated request at the envelope boundary. Iframes
  run `sandbox="allow-scripts"` only — storage is therefore **host-brokered** via db
  frames, and the network is host-brokered via net frames.

## 6. Chat envelope

Wire form: `[SNUG_APP_REQUEST]\n{json}` where json = `{snug: 1, appId, instanceId,
requestId, action, payload?, state?, responseSchema?}`. Detection = tag prefix **and** the
`snug: 1` marker — two independent signals, so ordinary chat content quoting the tag is
never processed as an app request. Servers SHOULD skip thread history for app requests (the
envelope is self-contained via `state`) and MUST apply the C1 header strip.

**Agent reply contract:** the agent responds with ONLY a JSON object (a human-readable
`message` field is recommended). Hosts parse with graduated tolerance (raw parse → fenced
block → balanced-object extraction), reject null/array/scalar, and convert failures to
`PARSE_FAILED` frames carrying `rawExcerpt` (≤200) and `attemptsRemaining`.

---

# Part II — The portable user database

## 7. The three actors

- **LLM provider** — serves model calls. Reached browser-direct (BYOK key or local
  OpenAI-compatible endpoint) or through a hub's subscription path.
- **Hub provider** — a multi-tenant service that provisions Snug apps per user. A hub is a
  *convenience*, never a requirement: app execution must work with no hub backend.
- **End user** — owns apps and data as ONE file, portable across hubs, LLM providers, and
  devices.

## 8. The user database

One SQLite file per user (`user.snug` — §10) is the canonical artifact. `PRAGMA
user_version` carries the storage schema version — **currently 6** — and migrations are
forward-only. A file stamped newer than the implementation understands is refused, never
overwritten. Size cap: `MAX_USERDB_BYTES` (64 MiB).

| Storage version | Change |
|---|---|
| v2 | native per-app tables (structural; v1 blob data does not survive) |
| v3 | added `snug_auth_specs` (superseded) |
| v4 | added `snug_connections` — the requirement/grant split of Part III |
| v5 | **dropped** `snug_auth_specs` (the one destructive migration; its data migrated to v4's shape) |
| v6 | added `snug_app_versions.runtime_contract_json` (Part IV) |

Two self-healing obligations (normative, easy to omit, expensive to omit):

1. **Verify tables against `sqlite_master`; do not trust the version stamp.** A
   forward-only migrator stamps `user_version` on completion, so the stamp claims which
   migrations *ran* — never that the tables they create *exist*. A conforming hub verifies
   the expected table set on open and replays the idempotent DDL on any miss.
   `snug_auth_specs` is deliberately **absent from the replayed DDL**, so self-healing can
   never resurrect the dropped table.
2. **Wipe the legacy (pre-slot) credential slice exactly once**, on the open that advances
   a file past the versions that wrote it. Legacy keys are `auth:<appId>:<field>` with no
   slot; the wipe MUST be scoped by **segment count**, never by prefix — both shapes begin
   `auth:<appId>:`, so a prefix delete would also take every live slot-keyed credential.

### 8.1 Hub-namespace tables (normative DDL in `userdb-schema.ts`, locked by snapshot test)

| Table | Holds |
|---|---|
| `snug_meta` | db uuid, created-at (key/value) |
| `snug_profile` | display profile (key/value, JSON values) |
| `snug_settings` | mode, provider, model, endpoints (key/value, JSON values) — also the sanctioned home for host-internal namespaced keys (below) |
| `snug_secrets` | BYOK keys, connection credentials, personal-origin tokens (opaque strings; §12 and §13) |
| `snug_apps` | one row per app: display metadata, `uses_db`, `current_version`, `install_source` (unique when present — a starter identity installs at most once) |
| `snug_app_versions` | complete HTML per version + `pinned` + **`runtime_contract_json`** (v6, Part IV); hubs retain ≥ `VERSIONS_RETAINED` (5) unpinned versions, pruning oldest; the factory version (v1 of a build or install) is `pinned` and NEVER pruned; revert/reset = copy-forward as a NEW version |
| `snug_app_schemas` | one row per app with data: the app's runtime `sqlite_master` DDL **verbatim** (objects in creation order + AUTOINCREMENT counters) and its namespace `token` |
| `snug_app_migrations` | append-only DDL audit per app (`seq`, statement, applied-at) |
| `snug_app_docs` | per-app knowledge wiki: `(app_id, slug)` → markdown. Advisory slugs: `vision`, `requirements`, `plan`, `lessons`, `memory`, `next-tasks`; the table shape is normative. A starter MAY seed rows at install; seeding MUST be absent-slugs-only — an existing row is never overwritten, because the wiki is the app's living memory |
| `snug_chat_threads` / `snug_chat_messages` | every chat surface's history; messages carry `pinned` (bootstrap turns survive pruning) and `meta` (JSON sidecar) |
| `snug_sync` | sync-origin CONFIG only (self-describing when ported) |
| `snug_connections` | connection requirements and grants, keyed `(app_id, slot)` — Part III §12 |

**Namespaced `snug_settings` keys.** Host-side state that is neither an app's data nor a
grant goes into `snug_settings` under a namespaced key rather than a new table — a new
`snug_` table is a portable-format change (version bump + migration + spec change), while a
settings key is host-internal machinery. Two exist today and both travel in the file, so
they are documented for transparency: `appModel:<appId>` (a per-app model preference;
absent means inherit the global setting, live) and `sidecarIdentityDirectory` (a
third-party-identity directory with its own lifecycle rules — §20).

### 8.2 Per-app data: native namespaced tables

Each app's data lives as REAL tables in the same file under `app_<token>__<name>`, where
`token = appDataToken(namespace)` — a **normative, total, injective** function of the
host-assigned namespace: UUID-shaped → 32 lowercase hex (dashes stripped); anything else →
`'x' + hex(utf8(namespace))` (the `x` prefix sits outside the hex alphabet, so the ranges
cannot collide).

Rules (all normative):

- **Reserved prefixes** (case-insensitive): `snug_`, `sqlite_`, `app_`. App object names
  must match `^[A-Za-z][A-Za-z0-9_]{0,40}$` and carry no reserved prefix; the single
  exemption is the driver-internal `snug_kv` (at rest `app_<token>__snug_kv`). A
  conforming hub REFUSES to persist (fails closed, prior state retained) any runtime whose
  object names violate the rule — unvalidated names are never interpolated.
- **Isolation is physical at runtime**: app SQL executes only against a materialized
  database containing that app's own objects under natural names; hub-namespace and other
  apps' tables are unreachable — absent, not filtered.
- **DDL is stored verbatim** (tables, indexes, triggers, views, in creation order) and
  replayed on materialization; DDL bodies are never rewritten. At-rest names are produced
  by `ALTER TABLE … RENAME` (a pure name swap), never by editing statement text.
- Per-app export = materialize + export: a standalone `.snug` with natural names.
- Push-state (last pushed revision/hash) lives OUTSIDE the image (sidecar file), so the
  file never contains its own revision.

### 8.3 Client-authoritative writes

The user DB is the single source of truth in every mode. In subscription mode the hub may
cache artifacts and thread history server-side, but the client fetches artifact content
and writes it into the user DB itself; hub stores are transient caches.

## 9. Hub provider obligations

A conforming hub:

1. **Never requires its backend for app execution** — the hub client is static files; app
   reads/writes hit the browser copy (OPFS) of the user DB.
2. **Offers Export/Import** — one-click download/upload of the canonical `.snug` (default
   export strips `snug_secrets` and VACUUMs; including secrets is explicit opt-in). Import
   treats the file's endpoint settings as executable config and requires user
   re-confirmation before agent turns run. Import obligations specific to connections and
   contracts are in §12.4 and §22.
3. **May host the user DB as the default sync origin** via:
   - `GET /userdb` → `200` bytes + `ETag` revision (`application/octet-stream`, `nosniff`,
     `no-store`) or `404` when none.
   - `PUT /userdb` with `If-Match: <revision>` (or `If-None-Match: *` first write) → `204`
     + new `ETag`; mismatch → `412` + current `ETag`; missing precondition → `428`;
     over-quota → `413`. Cookie auth requires CSRF double-submit (`x-snug-csrf`).
     Unauthenticated → `401`; CORS is fail-closed (explicit origin, credentialed).
   - First login provisions the user record only — a hub never creates an empty DB image
     that could clobber local state; the client pushes up.
4. **Supports pluggable origins** through the `SyncProvider` contract
   (`info/pull/push(bytes, baseRevision)`); personal origins (e.g. Dropbox) may carry
   secrets on explicit opt-in. Conflict policy v1: revision-token CAS; divergence is
   surfaced to the user; last-writer-wins only on explicit user action.

## 10. File naming

The canonical user file is **`user.snug`**; the artifact a hub offers for download is
**`snug-user.snug`**. `.snug` is the Snug Protocol's extension for the one portable file a
user owns.

The extension is a **naming convention, not a format claim**. A conforming implementation
determines a file's format from its leading bytes, never from its name:

| Leading bytes | Format |
|---|---|
| `SQLite format 3\0` | a plain user database (§8) |
| `SNUGENC1\n` | a protected user database (§11) |

- Implementations SHOULD accept the historical `.sqlite` extension on input — users hold
  exports and backups made before this revision — and MUST NOT reject a file on its
  extension alone.
- A hub that finds a pre-existing `user.sqlite` and no `user.snug` MUST read it and adopt
  the canonical name on its next write, **without renaming, copying or deleting the
  original**. The old file remains the user's own backup; once the canonical file exists
  it takes precedence.

The same read-and-adopt rule applies to any name a hub derives from the user file — sync
sidecars, quarantine copies, remote sync paths. Renaming a file an implementation looks
for is a data-loss operation unless every derived name moves with it.

## 11. Protected user files — the `SNUGENC1` container

A user MAY protect their file with a passphrase. A protected file is not a SQLite
database; it is a container carrying one.

**This section is normative because misidentifying a protected file destroys data.** A hub
that does not recognise the magic concludes the bytes are corrupt. A conforming hub MUST
detect it and prompt for a secret; it MUST NOT treat a protected file as corruption, MUST
NOT quarantine or overwrite it, and MUST NOT create a fresh empty database beside it.

Protection is **optional and reversible**. A conforming hub never requires it, opens an
unprotected file exactly as §8 describes, and can return a protected file to plaintext on
the user's instruction.

### 11.1 Layout

```
offset  size      field
0       9         magic            "SNUGENC1\n"
9       1         version          0x01
10      2         kdf id           0x0001 = PBKDF2-HMAC-SHA256
12      4         iterations       u32 big-endian (reference: 600,000)
16      16        salt
32      2         slot count       u16 big-endian
34      4         header checksum  FNV-1a/32 over the header with this field zeroed
38      …         slot table       slot count × 61 (see below)
…       …         wrapped keys     slot count × 48 (AES-256-GCM of the 32-byte file key)
…       12        payload IV
…       …         payload          AES-256-GCM of the SQLite bytes of §8
```

**Each slot-table entry is 61 bytes and only the first 13 are written**: `{ kind:u8,
iv:12 }` followed by **48 reserved bytes that MUST be zero**. The stride is stated
explicitly because it is load-bearing for interoperability rather than cosmetic: the header
*through the end of the slot table* is the GCM additional authenticated data (rule 4
below), so an implementation that packs entries at 13 bytes computes a different AAD span
and **cannot open a conforming file at all** — the failure is a wrong-secret error on a
perfectly good container, which rule 6 exists to prevent misreporting. For two slots the
header is 38 + 2×61 = **160 bytes**, and the wrapped keys begin there.

The reserved region is where each slot's wrapped key would sit if the two were interleaved;
the reference implementation stores the wrapped keys contiguously after the header instead,
so the space is carried and zeroed rather than reclaimed. It is not a version-negotiation
seat — a future revision that uses it takes a new magic string.

Slot kinds: `0x01` passphrase, `0x02` recovery key. The iteration count lives in the
header so it can be raised later without orphaning old files.

### 11.2 Rules (all normative)

1. **Key wrapping.** A random 32-byte *file key* encrypts the payload; each slot
   independently wraps that file key under a key derived from its own secret. Changing one
   secret MUST NOT require re-encrypting the payload or invalidate other slots.
2. **Two slots minimum.** An implementation MUST NOT create a container with only a
   passphrase slot. A single point of loss with no recovery path is not an acceptable
   shape for a user's only copy of their data.
3. **Recovery-key entropy** MUST be at least 128 bits. Mind the arithmetic when the
   alphabet excludes ambiguous glyphs: 26 symbols of a 30-glyph alphabet is 127.6 bits,
   and a base-32 assumption hides the shortfall. (The reference implementation uses 27
   symbols ≈ 132.5 bits.)
4. **AAD.** The header — offset 0 through the end of the slot table — MUST be supplied as
   GCM additional authenticated data for every slot unwrap and for the payload.
5. **Nonces.** Every IV MUST be 12 fresh CSPRNG bytes per encryption operation. Counters
   and derived nonces are forbidden: an implementation may write one logical save into two
   physical slots, so a repeat is reachable in ordinary operation, and a repeated GCM
   nonce discloses plaintext and forges the authentication key.
6. **Failure reporting.** Implementations MUST distinguish **locked** (a structurally
   valid container that no supplied secret opened) from **corrupt** (malformed, truncated,
   or a failed header checksum). Reporting damage as a wrong passphrase sends a user
   hunting for a secret that was never the problem; reporting a wrong passphrase as damage
   invites them to destroy a healthy file. The header checksum is an integrity *hint* for
   this purpose — it is unkeyed and does not resist a tamperer; rule 4 is what makes
   tampering fail.
7. **A locked file is never quarantined, rewritten or replaced.** It is healthy.
8. **Portability.** The container MUST be self-opening: everything needed to unwrap it,
   apart from the secret, travels inside it. No implementation may require state held
   outside the file — which is what keeps §7's portability promise true for protected
   files.
9. **Size limits** (`MAX_USERDB_BYTES`, §8) apply to the PLAINTEXT the container carries,
   not to the container.

### 11.3 Custody, unchanged

Protection changes where the file is readable, not who holds custody. §13's custody rules
stand: the key was always the user's and still is. The claim this supports is exactly
*"the file can be encrypted with a passphrase only the user holds"* — it is **not**
zero-knowledge, **not** end-to-end encryption, and it says nothing about a host page that
has already unlocked the file. A hub-origin sync copy remains the secrets-stripped
plaintext of §9.

**A file whose passphrase and recovery key are both lost is unrecoverable.** There is no
escrow and no reset. That is the property, not a gap in it, and an implementation MUST
state it plainly to the user before protection is enabled rather than afterwards.

---

# Part III — Connected apps: requirements, grants, and credential custody

## 12. What a connection is

A **connection** binds one app to one third-party provider, so that the host — never the
app — may attach real credentials to outbound requests on that app's behalf.

The concept is split in two, and the split is the substance of this part:

- A **connection requirement** describes *what the app needs*: the provider, the auth
  kind, the credential fields, the registration walkthrough, endpoints and scopes, the
  header/query template, and the hosts it declares it will call. It is **credential-free**
  and is written at **authoring** moments — app build, an auth-touching edit, or a starter
  install.
- A **connection grant** describes *what the user allowed*: approved status, the
  **frozen** host ceiling, the approval timestamp, and the revocation tombstone. It is
  written **only** on an explicit user approval act.

Credential **values** are in neither. They live in `snug_secrets` under the `auth:`
namespace (§13) and never enter a requirement, a grant, an LLM prompt, or an app iframe.

An app holding requirements but no grant is in the normal pre-connect state: its network
calls fail closed and the user is offered a connect flow. A conforming host **never**
treats the presence of a requirement as permission to attach a credential.

### 12.1 Who may create a requirement

**A running app may never propose a connection.** There is no frame, no SDK call, and no
announce field through which app code can ask for a credential grant. (The open-url frames
of §4 carry no credential seat and open nothing without the host's own confirm.) Exactly
three proposers exist:

| Proposer | Channel | Review |
|---|---|---|
| the user | Settings / connect CTA | manual entry |
| the app's builder assistant | a `connection_requirement` directive in the build conversation | strong, unless the registry rung pinned the values |
| the install act | the starter's own `connection.json`, vouched at install | **always strong** (field-by-field) |

Two obligations bind all three: **a proposer may write `declared` rows only** (a write
aimed at an `approved` row stages instead — §12.3; a write aimed at a `revoked` row is
refused outright, and reconnecting discloses the prior revocation), and **approval is the
only writer of grants**.

One distinction this doctrine does not blur, stated here because readers reasonably ask:
*proposing a grant* (never available to a model at runtime) is different from *composing a
request under an existing grant* (available to the provider chat lane of §16, gated by the
unchanged executor). The LLM can author a request; it can never widen what a request may
reach, place a credential, or see one.

Starter vouching is a **two-fact check**: the app's `install_source` must resolve to a
bundled starter manifest AND the installed HTML (both the pinned factory version and the
current version) must match the bundled starter bytes. A mismatch means the declaration is
not vouched and is treated as absent.

### 12.2 Storage: `snug_connections`

`PRAGMA user_version = 6` (Part II). Normative DDL is `USERDB_DDL` in `userdb-schema.ts`:

```sql
CREATE TABLE IF NOT EXISTS snug_connections (
  app_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  requirement_json TEXT NOT NULL,
  requirement_version INTEGER NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL,
  status TEXT NOT NULL,
  pending_requirement_json TEXT,
  imported INTEGER NOT NULL DEFAULT 0,
  allowed_hosts TEXT NOT NULL DEFAULT '[]',
  approved_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, slot)
)
```

| Column | Normative meaning |
|---|---|
| `app_id` | host-assigned app identity. Never app-claimed. |
| `slot` | stable connection id **within** the app, `^[a-z0-9][a-z0-9-]{0,39}$`. Lowercase and dash-only by construction: SQLite compares bytes exactly, so a mixed-case form would fork one provider into two rows. |
| `requirement_json` | the requirement (§12.5), credential-free, schema-valid. |
| `requirement_version` | integer, bumped on every persisted replacement whose **canonical form** differs. |
| `provenance` | `registry` \| `inference` \| `user_docs` \| `starter` \| `user`. Drives review posture. |
| `confidence` | model-derived confidence when provenance is model-derived. **Display-only** — never an approval input. |
| `status` | `declared` \| `approved` \| `revoked`. Exactly three values. |
| `pending_requirement_json` | a changed requirement staged against an **approved** row (§12.3). |
| `imported` | `1` when the row arrived by DB import and must be re-reviewed. |
| `allowed_hosts` | the **FROZEN** host union, computed at approval. Sorted, unique, normalized. |
| `approved_at` / `revoked_at` | grant timestamps. `revoked_at` is a **tombstone** and survives. |

A conforming host MUST bound declared slots per app: `AUTH_MAX_SLOTS_PER_APP` = **8**.
Replacing an existing slot does not count against the cap; **revoked tombstones do**
count, since they are exactly what a flooding attacker leaves behind.

"Needs re-approval" is **derived**, never a fourth status:
`status = 'approved' AND pending_requirement_json IS NOT NULL`. A fourth value would
require a write that moves a row *out of* `approved` to signal a *pending* change — the
silent de-grant/re-grant the staging seat exists to prevent.

### 12.3 Write rules

A conforming host exposes exactly five writers; each is the sole legal author of one
transition, so "which writer may I call?" is answerable from `status` alone:

| Writer | Legal on | Effect | Refuses |
|---|---|---|---|
| `putDeclaredConnection` | absent or `declared` row | insert or replace a declared row | `approved` (stage instead), `revoked` (explicit reconnect only), over-cap new slot |
| `stagePendingRequirement` | `approved` row | writes `pending_requirement_json` **only** | any non-`approved` row |
| `approveConnection` | `declared` row | freezes `allowed_hosts` from **`requirement_json`** (never from a pending column storage may have forged), stamps `approved_at`, status → `approved` | — |
| `reapproveConnection` | `approved` row with pending | **re-validates** the pending requirement (it is reachable without passing the stager), promotes pending → current, **re-freezes** hosts, clears pending | — |
| `revokeConnection` | `approved` row | status → `revoked`, stamps `revoked_at`, **keeps the row**, wipes the `auth:<appId>:<slot>:*` credential slice | — |

While a change is staged, the grant continues serving `requirement_json` **and its old
frozen hosts** — a host MUST NOT bind the executor to `pending_requirement_json`. The user
is shown the field-by-field diff old→pending, and only re-approval promotes it. There is
no path by which an edit widens a host ceiling without a human seeing the diff.

**Canonicalization** (for `requirement_version` and import comparison): recursive **key**
sort, whitespace-free JSON. **Array order is preserved and significant** —
`registration.instructions` is a numbered walkthrough, `fields` is the wizard's input
order, `scopes` is what review renders. The canonical form is compared as a **string**,
not a digest, so comparison is exact and synchronous.

### 12.4 Import reconciliation

A user DB is portable, so an imported file's connection rows are untrusted input. On
import, for each incoming `snug_connections` row:

- **byte-identical** `(app_id, slot, requirement_json, allowed_hosts)` to a locally
  **approved** pre-import row → the local grant is **restored**. Identical rows carry no
  new attack surface, and blanket demotion would revoke every approval on each routine
  two-device sync and train approval fatigue.
- **anything else** that validates strictly → lands `declared` with `imported = 1`,
  `approved_at` cleared, and `allowed_hosts` **recomputed from the requirement** rather
  than trusted from the column.
- **structurally unusable** rows → dropped, and reported to the user.

Because branch 1 compares stored `allowed_hosts` bytes, **host-union output stability is
normative**: `deriveConnectionAllowedHosts` MUST be sorted, unique, and normalized, or an
otherwise-unchanged connection mass-demotes on the first sync pull.

### 12.5 The connection requirement contract

Schema: `connectionRequirementSchema` (`connection-requirement.ts`). Strict at every
level — an unknown key anywhere is a rejection, never a passthrough, so a seat added in a
future version cannot ride in unreviewed on a channel that predates it.

```
connectionRequirement = {
  slot,                    // ^[a-z0-9][a-z0-9-]{0,39}$
  provider: { name,        // ≤120, printable ASCII, NFC (§12.6)
              homepageUrl?, docsUrl? },        // https, ≤300
  kind,                    // api_key | bearer_token | basic_auth
                           // | oauth2_client_creds | oauth2_auth_code
                           // | linked_device | none          — SEVEN kinds
  fields?,                 // 1..8 × { key ^[a-z0-9_]{1,40}$, label ≤80,
                           //          type text|secret|password|url,
                           //          description? ≤200, placeholder? ≤60, required? }
  registration?: { consoleUrl?,                // https, ≤300
                   instructions? },            // ≤10 × ≤300, PLAIN TEXT (§12.7)
  endpoints?,              // authorize/token/refresh/revoke, https, ≤300
  scopes?,                 // ≤64 × ≤200
  pkce?, authorizeParams?,
  request?: { headerTemplate?,                 // ≤8 entries, name ^[A-Za-z0-9-]{1,64}$,
                                               // value ≤300 (§12.8)
              queryTemplate? },                // ≤8 entries, name ^[A-Za-z0-9_.\[\]-]{1,64}$,
                                               // value ≤300 (§12.9)
  userLayer?,              // registry-synthesized ONLY (§12.10)
  lanHost?: { class,       // 'rfc1918-ipv4-literal' (single-member union; additive)
              label },     // ≤80 (§12.11)
  declaredApiHosts?,       // 1..32 × ≤253, bare hostnames, normalized (IDNA toASCII,
                           // lowercase). Presence rules: §12.11 (XOR with lanHost)
  testRequest?             // { method: 'GET', pathAndQuery ≤200, leading '/' }
}
```

**Seven kinds.** The kind set grew from six to seven when `linked_device` was **appended**
(never inserted — a stored row's kind must never be re-read as a different kind). Widening
the set remains a schema version change, not a configuration change. Three kinds carry
coherence rules enforced at parse:

- **`none`** — the keyless provider: a public API needing no credential but still needing
  a host ceiling. It MUST carry no `fields` and no `request` template (either placement);
  `declaredApiHosts` stays required — keyless means "no credentials", never "no host
  gate". A `none` connection with no grant still fails closed.
- **`linked_device`** — a provider that authenticates a *device session* rather than a
  request (Part V). It MUST declare at least one credential field (the minted helper
  token's slot — a row with no field would parse cleanly and then fail mid-send); it MUST
  carry no `endpoints` (a linked device never redirects, and a tolerated `refreshUrl`
  would widen the derived ceiling for a kind that cannot use it); and it MUST carry no
  `lanHost` seat (a helper is a capability, not a network host — §18).
- **`oauth2_auth_code` / `oauth2_client_creds`** — `pkce` defaults to true (public-client
  posture).

`declaredApiHosts` is a **request** for a ceiling, never the ceiling. The frozen ceiling
is `snug_connections.allowed_hosts`, derived at approval as: `declaredApiHosts` ∪ every
OAuth endpoint host (authorize, token, **refresh** — it receives long-lived credentials —
revoke) ∪ the embedded `userLayer`'s declared hosts and endpoint hosts. `lanHost`
contributes **no** host; a pre-collection LAN row derives an **empty** ceiling, which
refuses every host — the correct answer before an address exists.

### 12.6 Provider name: the confusable guard, and its stated limits

`provider.name` is printable ASCII (U+0020–U+007E) and NFC-normalized. It stops
**non-ASCII homoglyphs** (`ѕpotify` with Cyrillic U+0455; fullwidth Latin; zero-width and
bidi characters) and **registry-key evasion** (a homoglyph name normalizes to a different
registry key, misses the borrow ban of §12.12, and keeps attacker-authored endpoints while
*looking* pinned).

It does **not** stop pure-ASCII lookalikes: `5potify` and `C0inbase` are accepted, and no
charset rule can reject them without rejecting legitimate names. Those are carried by the
borrow ban's host-intersection trigger and by the review screen's provenance disclosure. A
conforming host MUST NOT present this guard to users as protection against lookalike
names.

### 12.7 Registration walkthroughs are plain text

`registration.instructions` are rendered as a numbered list of **plain text** — never as
HTML, never as links. They arrive from an untrusted channel and are displayed with the
host's own chrome and legitimacy; markup here would be phishing wearing the host's
clothes. `consoleUrl` is https-only and must be rendered with its **full host visible**.

### 12.8 Header templates and the pinned helper enum

`request.headerTemplate` places credentials into outbound requests. The schema bounds the
envelope (entry count, header-name charset, value length); the **content** rule depends on
the sibling `fields` list, so it is a separate **lint** a conforming host MUST apply
before a requirement is reviewed, stored, or rendered.

A template value may reference **only**:

- a **declared field key** from this requirement's own `fields`;
- a **pinned request token**: `request.method` · `request.url` · `request.pathAndQuery` ·
  `request.body` · `request.timestamp`;
- a **pinned helper** — the enum has **five** members with fixed arities:

  | Helper | Arity | Semantics |
  |---|---|---|
  | `timestamp` | 0 | unix seconds, memoized per render pass (§12.8.1) |
  | `base64` | 1 | UTF-8 in → base64 out |
  | `hmac_sha256` | 2 | hex HMAC-SHA256 |
  | `hmac_sha256_b64` | 2–6 | `base64(HMAC-SHA256(base64decode(secret), concat(parts)))` — the three transforms fused, because the composition is otherwise inexpressible in a flat grammar; the message tail is variadic because real prehash strings are multi-part |
  | `cdp_jwt` | 2 | a provider-scoped Ed25519 JWT signer (Coinbase CDP). **Both arguments MUST be declared field keys** — never quoted literals, never request tokens. Ed25519 only; no algorithm negotiation. |

- a **quoted literal**.

The grammar is **flat**: a helper call is a placeholder form, never an argument form. A
conforming host MUST reject a nested call and MUST NOT evaluate it. Helpers not in the
enum do not exist; adding one is a reviewed spec-level change, never a configuration knob —
an unused helper is reachable signing surface.

The lint's load-bearing job is making the render engine's *unknown-token-as-literal*
fallback unreachable: `{{hmac_sha256(api_secrt, request.body)}}` — one transposed
character — would silently sign the eight-byte string `"api_secrt"` instead of the
credential. A conforming host rejects that at review time, not at signing time.

**A quoted argument is a literal in the ENGINE, not only in the lint.** A conforming host
MUST render a quoted argument **verbatim** — it MUST NOT resolve the quoted text against
credential fields or request tokens. `{{base64('api_key')}}` MUST render
`base64("api_key")`, the literal token text, even when `api_key` is a declared field
holding a live credential. A host that strips the quotes and resolves the bare text emits
the **credential** from a template that passed review precisely because the quotes made it
look inert. This is a credential-disclosure requirement, not a formatting one.

#### 12.8.1 `request.timestamp` and the one-timestamp rule

**The timestamp MUST be evaluated once per render pass and memoized.** Two independent
evaluations can straddle a second boundary, so a signed timestamp and a sent timestamp
would disagree intermittently.

`request.timestamp` is the token that makes the memoization *reachable*: every signing
scheme of this shape sends the timestamp in one header and signs it inside another, so the
timestamp must be writable in **argument** position — and the helper form `timestamp()`
cannot go there, because the grammar admits no nesting. It is a **render fact**, not a
request fact: minted during the render pass, served from the **same** memoized value as
`{{timestamp()}}`. The conformance property: an HMAC **recomputed independently from the
timestamp value the host actually sent** equals the signature the host sent.

```
CB-ACCESS-TIMESTAMP: {{request.timestamp}}
CB-ACCESS-SIGN:      {{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}
```

### 12.9 Query-parameter templates

`request.queryTemplate` places credentials into the **query string** — the placement some
providers require and header templates cannot express (OpenWeather's `?appid=`,
CoinGecko's demo key). Query-parameter **names** get their own charset,
`^[A-Za-z0-9_.\[\]-]{1,64}$` (real query names carry underscores, dots, and bracketed
forms the header rule rejects); both charsets still exclude every character that could
smuggle URL structure or template metacharacters. Values follow §12.8 in full: same
bounds, same vocabulary, same flat grammar — and a conforming host MUST derive both
templates' lints from **one** resolution of the declared field keys.

Rendered query values are **credentials inside a URL**, which makes the URL itself
secret-bearing. Two host obligations follow:

- **Placement after the ceiling.** Query credentials are rendered into the URL only
  **after** the frozen-ceiling host checks have passed, so the ceiling decision is always
  made against the app-supplied URL.
- **Scrubbing is enumerated, not aspirational.** The credentialed URL MUST NOT appear in
  any surface the app, the model, or the user's logs can read: fetch-error messages,
  response echo surfaces, LLM-visible inspectors, host UI. The request URL returned to
  the app is the URL the app asked for, **never** the credentialed one.

### 12.10 `userLayer` is registry-synthesized only

The embedded org→user second layer keeps two-layer providers expressible. It is
**rejected on the assistant, manifest, user-docs and user channels** — on the basis of
*where it came from*, never what it says. A `userLayer` pointing at genuine provider URLs
is still a model-authored seat, and the next one will not point at a genuine provider.

### 12.11 LAN-class providers: `lanHost` and the host XOR

A provider whose API lives on a device on the **user's own network** — a Philips Hue
bridge is the archetype — has no host any registry or author can pin: the address belongs
to the user's router. `lanHost` is a DECLARATION THAT A HOST WILL BE COLLECTED, never a
host:

```
lanHost = { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' }
```

`class` is a single-member union today. Future device classes are **additive** — a new
literal plus its own validator and its own admission rule, never a widening of this one.
(A linked-device helper is deliberately NOT a lanHost class — §18.)

**The host XOR (normative).** Exactly one host source:

| `lanHost` | `declaredApiHosts` | verdict |
| --- | --- | --- |
| absent | 1..32 hosts | **accepted** — the ordinary shape |
| absent | absent or `[]` | **refused** (`declaredApiHosts` required) |
| present | absent | **accepted** — the pre-collection shape a LAN registry entry emits |
| present | exactly one host **of the declared class** | **accepted** — the post-collection shape the wizard writes |
| present | a host outside the class, two or more hosts, or `[]` | **refused** |

A public host beside a `lanHost` would freeze a public host into a ceiling the review
screen presents as "a device on your own network". Host obligations: (a) a
pre-collection LAN row derives an empty ceiling, so the binding wizard order is **collect
the address → approve the row → freeze the ceiling → pair**; (b) the schema is the FIRST
of two seats that refuse an off-class host — the registry-borrow path re-validates the
class independently, because a requirement can reach admission without passing this
schema; (c) nothing platform-conditional is persisted: a LAN row opened on a web hub is
**disclosed** as desktop-only, never refused or rewritten.

**LAN transport obligations** (desktop hosts): first pairing records a TOFU certificate
pin — the SHA-256 fingerprint of the device's leaf certificate — in the connection's
dynamic state (§13); every later request verifies against the pin and fails closed on
mismatch. The pairing window is a disclosed residual: an attacker already on the LAN at
the moment of first pairing can be pinned instead of the device.

### 12.12 The registry

A host MAY keep a registry of pinned providers. Where it does, five rules govern it:

**The borrow ban.** A requirement that **names** a registry provider, **or** whose
`declaredApiHosts` **intersect** a registry entry's hosts, has the registry's pinned
values **substituted** for its own: hosts, endpoints, registration block, and the display
name. Declared values for those seats are **discarded, not merged**. Both triggers are
required (name-match alone is evaded by renaming; host-match alone is evaded by trading on
a brand while declaring no overlapping host), and the ban is **kind-agnostic** — an
`api_key` requirement naming a known OAuth provider must not borrow its legitimacy while
pointing the credential at a host of its choosing. A borrow MUST be surfaced to the user:
"these values came from the host's registry, not from the app". For a LAN entry the
borrow path **preserves** the declaration's collected address (the registry has nothing to
substitute) and **re-validates its class** independently of the schema.

**Pinned scopes.** A registry entry MAY pin a provider's scope list. A pin is
**entry-level, never per-flow** (privilege breadth is brand identity); it **replaces** any
authored list on a borrow hit; it renders verbatim on review and re-approval diffs; and a
pin change on an approved row always **re-consents** — never silently promotes. The
governing principle, stated once: **prefer a scope the token cannot exceed over a rule the
app promises to follow.** A capability excluded from the pinned scopes is structurally
unreachable regardless of app code — the strongest control this part offers.

**Auth options.** An entry MAY offer alternative complete credential flows (e.g. PAT vs
OAuth app). An option carries its own kind, fields, endpoints, and walkthrough — but **no
identity seats**: display name, hosts, aliases, `lanHost`, and scopes belong to the
**entry**, because which hosts may receive a credential is a per-provider decision, never
a per-flow one. Substitution honors the option whose pinned field list the declaration
matches; no match means the default.

**Pairing families.** Providers whose credential is *obtained by ceremony* rather than
typed carry a `pairing` seat in the **registry entry — never on the persisted
requirement row**. A requirement seat carrying claim mechanics would be a channel through
which a prompt-injected declaration aims an uncredentialed request; registry data is
host-shipped and reviewed. Three families exist, and every one carries a **required
`verify` probe** (verify-before-claim: prove the counterparty is live and speaking the
expected protocol before any credential is written):

| Family | Shape | Reference example |
|---|---|---|
| `exchange` | a local pairing exchange (e.g. press-button + POST) against the collected LAN address | Hue |
| `device-link` | start → QR → poll; the poll **releases** a once-minted helper token (Part V) | WhatsApp |
| `token-claim` | the user pastes a one-time setup token; the host decodes a claim URL, POSTs it once, and receives the durable access credential | SimpleFIN |

Token-claim obligations: the decoded claim URL AND the returned access URL are both
checked against the row's **frozen ceiling** (https-only, exact host, no userinfo,
redirects refused on both hops); the returned path must match the registry's pinned access
path **exactly**; credentials and the `claimVerifiedAt` marker are committed **together**
(one write, no window); every refusal message is a fixed sentence, never derived from
pasted bytes. Note the family is registry data over an ordinary kind (`basic_auth` for
SimpleFIN) — **pairing is not a kind**.

**Capability facts.** `browserCallable` is tri-state: `true`/`false` are documented facts
a wizard may disclose; **absent means unknown and is disclosed as unknown — never rendered
as "works"**. A desktop OAuth redirect posture the registry does not vouch for means the
wizard **refuses honestly at entry**, never guesses. A loopback-class redirect posture is
representable only beside PKCE — `pkce: false` plus a loopback redirect leaves auth-code
injection undefendable, so the combination is refused.

**Web-surface capability facts (since 1.0).** A registry entry MAY carry two further
render-time seats: `webRedirectPosture` (sole member today: `'origin-callback'` — the
provider's client registration can accept the connecting web origin's `/oauth/callback`
as an exact authorized redirect URI) and `webRegistration` (the web-surface console
walkthrough). Structural rule: `webRegistration` requires `webRedirectPosture`, and both
require an OAuth kind. Like the desktop posture, these are registry data resolved at
wizard render time — they are **never persisted** and are never part of a
`ConnectionRequirement`; fields, scopes, hosts, and templates remain the row's, always.
Absence semantics deliberately differ from the desktop posture: an absent web seat does
NOT refuse — the entry-level walkthrough serves the web surface too. A pinned web
walkthrough **binds to the row's endpoints**, not to the provider's name: the override
applies only when the row's authorize and token URLs byte-match the registry pin, and a
row that merely carries a pinned provider's name with endpoints of its own keeps its own
registration under the copy-only honesty rules — a reviewed walkthrough must never dress
a flow whose token exchange goes somewhere the registry never vouched for.

### 12.13 The `connection_requirement` directive

Requirements reach the host from a build conversation as a `connection_requirement`
directive: `{ v: 1, kind: 'connection_requirement', requirement, confidence?,
provenance? }`. `confidence` and `provenance` on the wire are **display-only**: the host
computes provenance from the channel it actually received the directive on and recomputes
confidence from the ladder rung it resolved; no gating decision reads the claimed values.
A registry-resolved proposal MAY carry the entry's alternative flows for the user to pick
between; the pick is reviewed like any declared requirement.

## 13. Credential custody

Credential values live in `snug_secrets` and nowhere else:

| Key | Holds |
|---|---|
| `auth:<appId>:<slot>:<fieldKey>` | one credential value |
| `auth:<appId>:<slot>:_connection` | dynamic connection state for that slot (below) |
| `auth:_flow:<flowId>` | in-flight authorization state (the slot rides in the payload) |
| `auth:_state_hmac` | app-agnostic OAuth state-signing key |

The rules of §9 carry over verbatim: secrets exist in the local runtime copy, are stripped
from hub-origin pushes and default exports (VACUUMed so freed pages leak nothing), and
never enter `localStorage`/`sessionStorage`, any frame posted to an app iframe, or any hub
request.

**The `_connection` state** is not bookkeeping; four of its fields are security markers:

```
status: 'pending' | 'connected' | 'expired' | 'error'
obtainedAt?, expiresIn?, scopesGranted?, lastError?
lanPin?:        { fingerprint, cn? }   // TOFU leaf-cert pin; cn is diagnostic, never a trust input
lanVerifiedAt?:   number               // verify-before-claim marker — LAN family
linkVerifiedAt?:  number               // verify-before-claim marker — linked-device family
claimVerifiedAt?: number               // verify-before-claim marker — token-claim family
```

The three verify markers are deliberately **separate fields**: each describes a different
proof about a different transport, and collapsing them would let a stale marker from one
family vouch for another. Absence of the marker on a `connected` row means pairing is
still owed — the wizard self-repairs rather than requiring a data migration.

Two rules specific to connections:

- **Revocation wipes the slot's credential slice** (`auth:<appId>:<slot>:*`) while
  **keeping the row** as a tombstone.
- **A requirement never contains a credential value.** It contains field *definitions*. A
  host that finds a credential-shaped value inside a requirement rejects the requirement.

**OAuth obligations.** Authorization-code flows default to PKCE (S256); the `state`
parameter is HMAC-signed with `auth:_state_hmac` and verified constant-time; token,
refresh, and revoke POSTs are **ceiling-checked** like any other credentialed call; access
tokens refresh transparently inside a 60-second expiry skew. Every secret submitted in an
OAuth POST body (`client_secret`, `refresh_token`, `code`, `code_verifier`, `token`) joins
the scrub candidate set for that seat's error handling (§14.3).

## 14. The connected-fetch executor

One seat — and only one — both reads credential values and calls fetch. Everything an
app-originated network request passes through is this ordered gate sequence, and the
order is normative:

| # | Gate | Obligation |
|---|---|---|
| 1 | **Shape** | hand-written validation, fail closed; body on GET/HEAD rejected; body byte-capped |
| — | *(resolution)* | connection-relative URLs (§15) resolve here — translation only, **grants nothing** |
| 2 | **Binding** | the acting `appId` is HOST-assigned; the request carries no identity field |
| 3 | **Grant** | a connection row must exist with `status = 'approved'`; imported rows refuse with the distinct `NET_IMPORTED_UNAPPROVED`; the row must be the **unique** approved grant claiming this host — two claimants refuse (`NET_AMBIGUOUS_CONNECTION`), never tiebreak |
| 4 | **Ceiling** | https-only + exact-hostname membership in the frozen ceiling, punycode-normalized on both sides. One admission: `http` to an RFC-1918 IPv4 **literal** already inside the ceiling, under an explicit desktop transport policy; absent policy is byte-identical to the browser profile |
| 5 | **SSRF guard** | loopback, RFC-1918, link-local/metadata, CGNAT, IPv6 forms refused **even for ceiling members**; malformed fails closed. Exactly two classes stand this gate down: the LAN class of §12.11 (under the desktop policy) and the sidecar symbolic host of Part V — each stands down **this gate only** |
| 6 | **Confirm** | every mutating method (POST/PUT/PATCH/DELETE) requires the user's confirmation naming host, method, and URL, **before any credential is read**. The confirm seat carries optional `slot` and `body` so a standing grant (§17) can decide on *what* is being sent; their absence on the wizard's probe path is what keeps standing grants off probes |
| 6a | **Local transports** | a send to a local helper transport (Part V) departs here — **after** gate 6, never before. Transport shape never excuses consent: speech in the user's name is gated by the confirm gate and nothing else. The helper path injects credentials itself and applies gates 7 and 10's obligations; a missing helper transport refuses, it never falls back to the network |
| 7 | **Strip** | app-supplied credential-shaped headers are stripped (C1 belt to the schema's braces) |
| 8 | **Injection** | credentials attach host-side per kind (template render / OAuth bearer), ceiling-checked internally |
| 9 | **Fetch** | `redirect: 'manual'` on every transport; any 30x is `NET_REDIRECT_BLOCKED`, never followed |
| 10 | **Read** | response read under the 1 MiB cap **while reading** (overflow → terminal `NET_SIZE_EXCEEDED`); injected credential values scrubbed from body and whitelisted header values, raw and percent-encoded; headers whitelist-filtered |

There is **no strictness knob anywhere in this pipeline**. Host-bound injection is always
strict; a security property that can be disabled by configuration will be disabled in some
deployment, and that deployment is the one that gets attacked.

### 14.1 Scrub honesty

The value scrub is exact-substring over the values this request injected (raw and
percent-encoded). A provider that re-encodes a credential (base64, hex, split fields)
defeats it **by design**; the frozen ceiling — who can receive the secret at all — is the
primary wall, and the scrub is a second line. Hosts MUST NOT present the scrub as more.

### 14.2 LLM-bound delivery is scrubbed harder than app-bound

The executor's scrub is designed for app-bound delivery, where a resolved LAN address in a
response body is the provider's own data surface. When a result is bound for a **model**
(the provider chat lane, §16), the host MUST additionally scrub every RFC-1918 IPv4
literal unconditionally — LLM-bound delivery exports the body to a third-party API, and a
per-class rule would be one mis-wire away from leaking.

### 14.3 Provider error forwarding

When a provider's error body must be shown to a human, a conforming host bounds **volume
and shape** — up to 160 chars, and only a named field of a recognized error envelope (or,
failing that, a best-effort head that is never markup/structure) — after value-scrubbing
with the candidate set **only the calling seat can build**: gate 10's injected values at
the executor seat; the submitted form parameters at the OAuth seat. Order is scrub first,
extract second, and the extractor MUST re-scrub its own output — `JSON.parse` decodes
`\u` escapes and can reconstitute a correctly-scrubbed secret. The extractor is
explicitly **not** a credential guard; the value scrub is the control.

## 15. Connection-relative addressing

An app can address its OWN declared connection by slot instead of by a host it cannot
know:

```
snug-connection://<slot><pathAndQuery>
```

Grammar (`connection-url.ts`): scheme match is case-insensitive and everything after is
exact; `//` is required; a path is required (apps address resources, not devices); the
slot must match `CONNECTION_SLOT_RULE` (imported, never restated); `pathAndQuery` may not
begin `//` and may not contain `\` or `#`. The parse result is three-way — *not a
connection URL* (fall through to the literal-URL path untouched), *malformed* (refused
loudly, never guessed at), or *ok*.

Resolution happens after gate 1 and **grants nothing**: the slot selects the connection,
whose frozen ceiling must contain **exactly one host** (`NET_AMBIGUOUS_CONNECTION`
otherwise — a symbolic address must have one meaning); the URL is rebuilt against that
host by URL composition, never string concatenation; and the resolved host is re-checked
against the ceiling canonically. Refusals: unknown slot → `NET_INVALID_REQUEST`;
unapproved → `NET_NOT_APPROVED`. The resolved host is disclosed to the **user** (confirm
dialog) and never to the **app** — refusal messages are host-clean, and error-path text is
scrubbed of resolved forms.

This is the addressing mode every starter SHOULD use: installed apps never receive
rebuilds, so a host baked into shipped HTML is a liability the slot indirection removes.

## 16. The provider chat lane

A conforming host MAY offer a chat surface that composes provider requests on the user's
behalf (Part IV classifies its intents). Where it does:

- The turn's context receives connection **facts** — slot, provider name, scope summary,
  symbolic or public host identity — never credentials, and never a resolved LAN address
  (LAN rows render symbolically; dotted-decimal RFC-1918 literals are scrubbed from
  rendered context).
- Requests the model composes execute through the **unchanged** executor of §14 — same
  ceiling, same confirm gate, same injection, same scrub. The model is a request author,
  never a grant author: zero ceiling matches means refusal plus a connect CTA, exactly as
  it does for app code.
- Mutating-call confirms MAY render inline in the chat surface, but an inline card is
  **presentation, not authority**: a card's resolution becomes an ordinary user message,
  and the only approval seat remains the executor's confirm gate. Concurrent confirms
  queue FIFO — a second confirm MUST NOT orphan the first's resolver — and an aborted turn
  denies its own parked confirms by reference identity, so deny-after-decide is a no-op.
- LLM-bound results are scrubbed per §14.2.

## 17. Standing approvals — **PROVISIONAL**

> **Status: provisional.** The gate contract below is normative for any host that offers
> standing approvals; the *arming channel* is deliberately unspecified (the frame
> vocabulary has no seat for it, and minting one is a future wire revision), and the
> reference implementation's grant store is in-memory (a reload disarms). This section
> pins the shape so implementers do not invent worse ones; it does not claim the surface
> is finished.

A **standing approval** is a pre-recorded answer to the confirm gate for a narrow, frozen
scope — the mechanism behind "armed auto-reply". Rules:

1. **Arming is an explicit user gesture** on a host surface, never an app or model act.
2. **Scope is frozen at arm time**: one connection slot + one target (e.g. one thread) +
   one trigger class. Widening requires disarm + re-arm; no request can talk its way
   wider.
3. **The standing gate is a separate gate consulted BEFORE the session confirm gate**, and
   it **wraps** that gate rather than widening it — the session gate's key (app, host,
   method) cannot tell one thread from another, so reusing it would turn one remembered
   send into a blanket approval. Anything outside the frozen scope returns **no opinion**
   and falls through to the ordinary confirm; the refusal to decide is never itself an
   approval.
4. **The target is derived from the request with two independent sources that MUST
   agree** (e.g. path segment and body field). Trusting either alone is a vulnerability
   with two spellings; disagreement is refused, never resolved.
5. **Guardrails ride the grant and are host-enforced**: a rate cap over a rolling window
   (the send is recorded **before** the grant answers, or the cap does not hold), quiet
   hours, a kill switch, and — v1 — one armed target at a time.
6. **Every unattended act is journaled** and the armed state is disclosed wherever the
   connection is disclosed.

Armed is a recorded answer, not a bypass.

---

# Part IV — Runtime contracts and the app chat surface

## 18. Runtime contracts

An installed app's LLM turn is ONE self-contained request. A **runtime contract** is the
compact, host-held description from which that turn's system instructions are assembled —
what the app is, which settings shape an answer, what state arrives, what shape to reply
in — replacing kilobytes of authoring instructions a runtime move cannot act on. The
effect is protocol-level: every conforming app becomes cheap enough to run on a small
local model.

### 18.1 Shape (normative)

A contract is a strict JSON object — an unknown key is a rejection, because an unknown
field here would be unreviewed text reaching the model's system instructions:

| Field | Bound | Meaning |
|---|---|---|
| `overview` (required) | 1–600 chars | what the app is; the model's role |
| `personaNote?` | ≤400 | voice/tone |
| `stateGuidance?` | ≤500 | what the app sends each turn (state, never history) |
| `responseGuidance?` | ≤500 | the minimal reply shape |
| `settings?` | ≤16 entries; keys `[a-z0-9_]{1,40}`; scalar values (strings ≤120) | the settings slice that shapes answers |
| `maxOutputTokens?` | int 256–8192 | opt-in, narrowing-only output ceiling; absent means "behave exactly as a contract-less app" |

The serialized contract MUST be ≤ **2560 bytes** as a whole; per-field bounds deliberately
sum to more, so a contract may spend its budget on any field.

### 18.2 Custody (normative)

- **Host-assigned, never app-claimed.** No frame carries a contract; an app frame
  attempting to is ignored by the tolerant parser.
- **Version-linked.** The contract lives on the app VERSION row
  (`snug_app_versions.runtime_contract_json`). Writing a new version **copies it
  forward**; revert and factory-reset copy it **from the version being restored** —
  reverted code runs under the contract that shipped with it.
- **Imported contracts are untrusted.** On whole-DB import, a hub MUST drop every
  contract it cannot match — byte-for-byte after canonical (key-sorted) serialization —
  against a contract it already holds. A contract speaks with system authority; accepting
  one from an untrusted file would let that file dictate the model's instructions. The
  affected app runs contract-less: degraded, never compromised.
- **Graceful degradation.** An absent, malformed, or over-bound stored contract reads as
  "no contract" and the turn proceeds on generic instructions.

## 19. The app chat surface

A conforming hub MAY offer a chat surface beside an installed app. Where it does:

**Classification precedes execution.** A message is classified into one of eight intents,
and one exhaustive, compile-checked map assigns each intent a lane — a fall-through that
silently routes unknown intents somewhere is exactly the defect this rule exists to
prevent:

| Intent | Lane |
|---|---|
| `data_read`, `data_write` | **data** |
| `schema_change`, `app_change` | **feature** |
| `provider_read`, `provider_write` | **provider** (§16) |
| `app_question`, `other` | **answer** |

Classification MUST fail closed: an unusable classification produces a clarifying reply
(≤300 chars), never a default lane — in particular, never the lane that writes code.
`clarify` is deliberately not a lane; it is the router's failure posture.

**The data lane.** Reads are isolated by construction: generated SQL executes against a
throwaway copy of the app's own materialized database — never live storage, never behind a
"read-only" flag. Isolation is what the copy CONTAINS: other apps' tables and every
hub-namespace table are physically absent. Results are bounded before re-entering the
model's context (reference: 200 rows / 32 KiB), and truncation says so in-band. Writes are
**proposed, previewed, approved, then re-validated**: verbatim statements plus an
affected-row preview computed on the throwaway copy; execution only on explicit approval;
at execution the dry run re-runs against live data and **halts if the affected-row counts
drifted** from what was approved. Declining executes nothing. (Count comparison, not row
comparison, is a disclosed limit of this revision.)

**The feature lane** writes app versions on model authority — there is deliberately no
pre-write confirm. The wall is versioning: a visible in-place reload, a revertable version
write, and the pinned factory version. Hosts MUST disclose this asymmetry rather than
imply the data lane's gate covers it.

**Stored data is untrusted input.** Rows may contain text crafted to read as instructions.
Any prompt carrying stored data or query results MUST delimit it as untrusted, and
delimiter spellings MUST be defanged in the data.

---

# Part V — Linked-device connections (the sidecar surface)

## 20. The model

Some providers authenticate a **device session**, not a request: there is no API key to
paste and no OAuth redirect to run — a long-lived, stateful client holds session key
material and speaks a proprietary transport (WhatsApp's linked-device protocol is the
reference case). Snug's answer keeps every existing wall intact:

- A **helper** — a local, user-installed companion process — owns the device session:
  its key material, its transport, its sync state. The helper is **LLM-free**: transport
  and custody, never a second brain. Every analysis or compose turn runs in the governed
  host.
- The app reaches the helper **only** through the connected-fetch executor of §14, as an
  ordinary `linked_device` connection — same grant, same confirm gate, same governance.

### 20.1 A helper is a capability, never a host

The frozen ceiling is host-granular and has **no port dimension**, so `127.0.0.1` in a
ceiling would grant every loopback port on the machine — and a loopback host:port pair is
not even storable under the host grammar. A conforming host therefore MUST NOT admit a
loopback or localhost address into any ceiling for a helper. Instead:

- The helper listens on a **unix-domain socket with `0600` permissions** (or an equivalent
  OS-scoped IPC endpoint). With no TCP endpoint there is no port to squat and no network
  path to filter: the filesystem decides who may connect.
- The connection declares a **symbolic host** — a name under the RFC 6761-reserved
  `.localhost` TLD (pattern `<provider>.sidecar.localhost`) that can never resolve
  publicly and is **never dialled**. The name exists so the connection has a stable
  identity the ceiling can hold: hosts are the ceiling's unit, and a capability needs a
  host-shaped identity to be containable. The executor matches on it to route to the
  helper transport, and it stands down gate 5 (SSRF) **only** — every other gate applies,
  including gate 6's confirm on every send (§14, gate 6a).
- The symbolic host is **single-homed in the protocol contract** — a second spelling once
  sent an app's reads to a real DNS resolver, which is the failure this rule exists to
  prevent.

### 20.2 Credential custody: the split

Two secrets exist and have opposite exposure rules:

- **Provider session key material** (the keys to the user's *account*) lives ONLY in the
  helper's own store and is serialized on **no** route — not scrubbed, not redacted:
  never in a response in the first place. Compromising everything Snug stores yields a
  key to a helper, not to the account.
- **The helper access token** (the key to *this helper*) is minted **exactly once** at
  pairing — ≥256 bits CSPRNG; a second mint is refused — crosses the wire exactly once on
  the releasing pairing poll, and lands in `snug_secrets` as the connection's declared
  credential field, injected thereafter by the executor like any credential.

Pairing routes are guarded by a **spawn nonce**: a per-launch secret the host passes to
the helper at spawn, required on every pairing/verify route. The pairing status route
*releases the access token*, so it must not be reachable by an arbitrary local caller —
"local" is not "trusted".

### 20.3 The helper contract

- **A closed, enumerated route table**, method-pinned, is the entire reachable surface.
  The app-reachable subset is **derived by filter from the one table** (wizard-only
  prefixes: pairing and session-status routes), never a second hand-written list — two
  lists drift invisibly until an app reaches a route nobody intended.
- **Every route requires a credential** — the access token for app routes, the spawn
  nonce for wizard routes. No open route exists.
- **Path admission checks the decoded form**: percent-decode first (malformed encoding
  refuses), then refuse any `.`/`..` segment, then match method + pattern anchored.
  Placeholder segments match exactly one non-empty segment.
- **Caps refuse, never truncate**: request and response bytes are bounded (reference:
  1 MiB, enforced *while reading*), and an over-cap resource is refused with a structured
  answer — a truncated payload is a corrupt payload.
- Where a native shell mediates the socket (desktop hosts), the shell's route admission
  MUST be held equivalent to the protocol table by test.

### 20.4 Lifecycle

- **One writer per session store.** Exactly one helper instance may hold a device session:
  the host reaps a stale helper **before** spawning (order is load-bearing — reaping after
  leaves two live helpers fighting over one session), and the helper watches its own
  parent and exits through its clean shutdown path when orphaned (signal: a **changed**
  parent pid, not `ppid == 1` — subreapers exist).
- **Termination is graceful-first** (SIGTERM, bounded wait, then SIGKILL): the helper's
  clean shutdown flushes durable state a hard kill would drop.
- **A stale-process verdict must identify the process** (command line naming this host's
  helper entry), never trust a recorded pid alone — pids are recycled, and a bare number
  would kill a stranger.
- **Durable helper state is quarantined on corruption**, never treated as fresh truth;
  and deleting or forgetting the connection MUST sweep the helper's session store and
  derived caches with it.

### 20.5 Live updates

Rule R7 (§5) was written for this surface: the host MAY run a **pump** that long-polls the
helper's event route *through the governed executor* on the app's behalf and forwards
**hints** (`{jid, kind, ts}`-shaped references, every field rebuilt by the host) over
`snug:host-event`. The app answers a hint with its own governed reads. Media bytes stop at
the app frame: memory-only, never written to the app's database, never into an LLM-bound
payload.

**The two-population rule.** Read-on-behalf eligibility (the pump) keys on an **approved**
grant whose ceiling holds the symbolic host. The pseudonymisation population (§20.6) keys
on the connection **fact in any status** — approved, declared-by-import, or revoked with
data left behind. These are different predicates by design and MUST NOT be conflated.

### 20.6 The pseudonymisation backstop

A linked-device connection is the one place Snug routinely handles **other people's**
data: thread participants never consented, are not Snug users, and cannot opt out. Under
BYOK their message content reaches the user's configured model provider — that is the
feature — but their *identities* need not. A conforming host that mediates linked-device
data to a model MUST enforce an egress backstop, host-side, that does not rely on
app-layer redaction:

- **Harvest at the governed seat.** Third-party identities (display names, provider ids)
  are extracted from directory-shaped helper responses at the one seat every governed
  read crosses. **Extraction is the scrub**: only the identity fields enter the
  directory; message text and unknown fields never do — a directory that ingested content
  would itself become the leak.
- **Redact on every LLM-bound surface** of any app holding a sidecar connection fact, in
  any status: the app-message envelope (all string values and object keys; response-schema
  values case-sensitively with keys and `required` untouched; envelope ids verbatim — a
  disclosed residual channel) inside **every** leaf transport, and provider-lane results
  classified by the **canonical** connection-URL grammar with the executor's own
  normalization (hand-rolled classifiers have already been beaten by case and whitespace).
  Provider-id patterns and dialable digit runs (≥7 digits) are redacted as primitives.
- **Fail closed.** An unreadable directory refuses the send; a scrub failure on the
  provider lane surfaces as a tool error, never the raw body; a malformed envelope is
  scrubbed as a raw string with an unescape-normalized shadow pass.
- **Lifecycle.** The directory is third-party PII in its own right: it is wiped — in the
  same transaction — when the last approved sidecar connection is revoked or its app
  deleted; it deliberately **survives import** (the demoted-to-`declared` rows travel
  with the replayable app data the scrub exists for); and the in-memory session copy
  resets on import/restore/revoke/delete, so one user file's contacts are never written
  into another's.

**Honest statement of class (normative to repeat wherever this is claimed):** the
backstop is **anti-default and anti-naive, not anti-adversarial**. Disclosed residuals: an
app that obfuscates (homoglyphs, base64, numbers smuggled as JSON numerics) defeats
substring redaction; identities never surfaced through the helper seam are invisible to
the directory; rows an app persisted in its own tables can reach a model through the data
lane; and message content itself reaches the provider by design. Third-party consent
remains a real residual, disclosed to the user before linking.

### 20.7 Disclosure obligations

Before a linked-device connection is created, a conforming host discloses: any
provider-ToS risk (unofficial automation can violate terms and cost the account — pacing
is harm reduction, never a guarantee and never detection evasion), the third-party-consent
residual of §20.6, and — wherever the connection is disclosed — any standing approval
(§17) currently armed on it.

### 20.8 Reference binding (non-normative)

The reference implementation binds this surface to WhatsApp: a Node helper owning a
linked-device session; symbolic host `whatsapp.sidecar.localhost`; a 12-route table
(pair/start, pair/qr, pair/status, session/status, session/forget wizard-only; chats,
per-chat history/messages GET+POST, events, media, picture app-reachable —
`POST /session/forget` is the deep-delete unlink: nonce-guarded provider logout plus
auth-store erasure behind a persist tombstone, added 2026-08-21 ahead of the next
consolidated push); a `device-link` pairing family entry in the registry; and the macOS
desktop shell mediating the socket with a Rust-side admission table held equivalent by a
source-parsing test. None of those specifics are normative; §20.1–§20.7 are.

---

# Part VI — Conformance

An implementation may claim conformance with the parts it implements; Part I is the
minimum. Each item below is asserted by the reference implementation's test suite.

**Hosts (wire):**
- Validate every inbound frame against the published schemas, accepting unknown fields
  (R2) and rejecting unsupported versions (R1); strict net/open-url frames refuse unknown
  keys.
- Mint `instanceId`, deliver it in `snug:host-ready`, route by message source, never by
  `appId` (R4).
- Emit exactly one terminal `snug:app-response` per accepted `requestId` (R3).
- Enforce the size classes, string caps, parse budget, and backoff of R6.
- Push hints, never content, on host-initiated events (R7).
- Strip the five credential headers at the envelope boundary (C1); run app frames
  `sandbox="allow-scripts"` only with `connect-src` blocked (C2); advertise only the
  capabilities actually mediated.
- Parse agent replies with graduated tolerance; convert failure to `PARSE_FAILED` with
  `rawExcerpt` and `attemptsRemaining`.
- Execute app code with no configured model for apps that request none.

**Apps and SDKs:**
- Announce on mount; wait for `snug:host-ready`; echo `instanceId`; unique `requestId`
  per instance; ignore unknown frames and fields; treat streaming frames as provisional;
  never assume storage or network APIs — use the frames; feature-detect `net`/`openUrl`
  from capabilities and render honest fallbacks.

**Hubs (Part II):**
- Carry the schema version in `PRAGMA user_version`, migrate forward-only, refuse
  newer-stamped files, self-heal the table set, and run the legacy-slice wipe once.
- Compute namespace tokens with the normative function; refuse violating object names
  (fail closed); materialize per-app runtimes so isolation is physical; store DDL
  verbatim.
- Offer export/import per §9; strip secrets and VACUUM by default; re-confirm imported
  endpoint settings; reconcile imported connections per §12.4 and contracts per §18.2.
- Retain ≥5 unpinned versions; never prune the pinned factory version.
- Decide file format by leading bytes; read-and-adopt legacy names (§10); honor every
  SNUGENC1 rule of §11, including locked-vs-corrupt reporting.
- Never require the backend for app execution.

**Hosts (connected apps, Part III):**
- Persist requirements and grants only through the five writers; enforce the slot cap;
  derive ceilings with stable output; freeze at approval; stage edits; disclose diffs.
- Apply the full validation stack before a requirement is shown, stored, or acted on:
  schema bounds → template lint (one field-key resolution for both templates) →
  registry-borrow ban → provider-name guard.
- Render every re-admitted seat verbatim in the approval review — fields, walkthrough,
  templates uncollapsed, the complete host list, the freeze disclosure. This contract
  trades "the channel cannot express it" for "the user sees exactly what it expresses";
  a review that truncates voids the trade.
- Run the ten-gate executor in order; confirm before credential read on every mutating
  call, local transports included; never follow a redirect; never expose a credentialed
  URL; scrub per §14.1–§14.3.
- Disclose provenance honestly; disclose prior revocations keyed by provider/host, not by
  slot name.

**Hosts (linked-device, Part V):**
- Never admit a loopback address into a ceiling; reach helpers through a dedicated
  OS-scoped transport behind the symbolic-host pattern; enforce the custody split, the
  closed route table with derived subsets, decoded-form admission, refuse-don't-truncate
  caps, single-writer lifecycle, graceful-first termination, and the pseudonymisation
  backstop with its honest class statement and disclosures.

---

# Appendix A — Error code registry

**Wire (R5):** `PARSE_FAILED` · `THREAD_CONFLICT` · `NETWORK_ERROR` · `RESET_FAILED` ·
`CANCELLED` · `SUPERSEDED` · `UNSUPPORTED_VERSION` · `CONSENT_REQUIRED` (reserved) ·
`AUTH_REQUIRED` (reserved) · `HOST_ERROR`. (`MALFORMED` is R1's wire answer to an
unparseable frame, not a member of this list.)

**Net capability:** `NET_INVALID_REQUEST` · `NET_NOT_APPROVED` ·
`NET_IMPORTED_UNAPPROVED` · `NET_AMBIGUOUS_CONNECTION` · `NET_SCHEME_BLOCKED` ·
`NET_HOST_BLOCKED` · `NET_SSRF_BLOCKED` · `NET_CONFIRM_DENIED` · `NET_REDIRECT_BLOCKED` ·
`NET_SIZE_EXCEEDED` · `NET_FETCH_FAILED` · `NET_AUTH_FAILED` ·
`NET_SCRUBBED_HEADER_STRIPPED` (reserved).

# Appendix B — Normative constants

| Constant | Value |
|---|---|
| `PROTOCOL_VERSION` | 1 |
| `MAX_FRAME_BYTES` | 256 KiB (262 144) |
| `MAX_DB_FRAME_BYTES` | 8 MiB (8 388 608) |
| `MAX_NET_FRAME_BYTES` | 1 MiB + 64 KiB (1 114 112) |
| `MAX_NET_REQUEST_BODY_BYTES` | 256 KiB |
| `MAX_NET_RESPONSE_BODY_BYTES` | 1 MiB |
| `MAX_ARTIFACT_BYTES` | 5 MiB |
| `RAW_EXCERPT_CHARS` | 200 chars |
| `MAX_PARSE_FAILURES` | 3 consecutive |
| `THREAD_CONFLICT_BACKOFF_MS` | 100/250/500 ms |
| announce caps | displayName 80 · description 400 · iconEmoji 8 · iconColor 32 |
| id/action caps | 128 |
| `STRIP_HEADERS` | authorization · cookie · set-cookie · x-api-key · proxy-authorization |
| `NET_METHODS` / mutating | GET HEAD POST PUT PATCH DELETE / POST PUT PATCH DELETE |
| net response-header whitelist | content-type · content-length · cache-control · etag · last-modified · retry-after · link · `x-ratelimit-*` |
| `MAX_USERDB_BYTES` | 64 MiB |
| `USERDB_SCHEMA_VERSION` | 6 |
| `VERSIONS_RETAINED` | 5 |
| `USERDB_FILE` / legacy | `user.snug` / `user.sqlite` |
| `CONTAINER.MAGIC` / KDF / iterations | `SNUGENC1\n` / PBKDF2-HMAC-SHA256 / 600,000 |
| `AUTH_MAX_SLOTS_PER_APP` | 8 |
| requirement bounds | fields 8 · instructions 10×300 · header entries 8×300 · query entries 8×300 · urls 300 · label 80 · description 200 · placeholder 60 · testRequest path 200 · provider name 120 · hosts 32×253 · scopes 64×200 |
| `RUNTIME_CONTRACT_MAX_BYTES` | 2560 |
| data-lane result bounds | 200 rows / 32 KiB |
| helper token entropy | ≥256 bits |

# Appendix C — Published schemas and publication lines

**Fourteen schema files** are published, byte-identical from `packages/protocol`
(`io: 'input'` for the tolerant set):
`app-announce` · `app-cancel` · `app-event` · `app-message` · `app-request-envelope` ·
`app-response` · `db-request` · `db-response` · `host-event` · `host-ready` ·
`net-request` · `net-response` · `open-url-request` · `open-url-result`.

Two publication-line facts, decided at v0.3 (owner ask 2026-08-20):

1. **The strict pairs publish strict.** `net-*` and `open-url-*` schemas carry
   `additionalProperties: false` — that IS their contract (§2, R2's stated exception).
   Their superRefine rules (body-on-GET refusal, credential-header refusal, https-only +
   userinfo-free URLs) are not expressible in JSON Schema; this prose is normative for
   them, and the exported schema is deliberately the weaker envelope, never the full
   contract. A validator passing the schema has not yet validated the frame.
2. **The Part III–V contracts publish as prose, not as JSON Schemas.** The
   connection-requirement, connection-url, chat-intent, runtime-contract and
   sidecar-contract shapes carry refinements JSON Schema cannot express (the host XOR,
   the per-kind coherence arms, canonicalization, derived route subsets). Exporting a
   schema weaker than the real contract would invite implementations that validate
   against the export and admit what the contract refuses — so none is offered. This
   specification's prose is normative for those surfaces, the reference implementation's
   contract files are the machine-readable authority, and in-package tests lock them.
