# Spec v0.2 draft — Portable User Database Format (staging)

> **Status: DRAFT, staged for the `snugprotocol/spec` repo.** Pushing requires an
> explicit ask (PROCESS release rules). Source of truth for constants:
> `packages/protocol/src/userdb-schema.ts` (locked by the DDL snapshot test).
> Wire protocol (frames + envelope) is UNCHANGED at v1 — v0.2 adds a storage and
> hub-behavior layer on top of v0.1.

## 1. The three actors

- **LLM provider** — serves model calls. Reached browser-direct (BYOK key or local
  OpenAI-compatible endpoint) or through a hub's subscription path.
- **Hub provider** — a multi-tenant service that provisions Snug apps per user. A hub
  is a *convenience*, never a requirement: app execution must work with no hub backend.
- **End user** — owns apps and data as ONE SQLite file, portable across hubs, LLM
  providers, and devices.

## 2. The user database

One SQLite file per user (`user.sqlite`) is the canonical artifact. `PRAGMA
user_version` carries the schema version (currently **2**); migrations are
forward-only (v1→v2 is structural; v1 blob app data does not survive). Size cap:
`MAX_USERDB_BYTES` (64 MiB v1).

### 2.1 Hub-namespace tables (normative DDL in `userdb-schema.ts`)

| Table | Holds |
|---|---|
| `snug_meta` | db uuid, created-at (key/value) |
| `snug_profile` | display profile (key/value, JSON values) |
| `snug_settings` | mode, provider, model, endpoints (key/value, JSON values) |
| `snug_secrets` | BYOK keys, personal-origin tokens (opaque strings; see §4) |
| `snug_apps` | one row per app: display metadata, `current_version`, `install_source` (unique when present — a marketplace/starter identity may be installed at most once) |
| `snug_app_versions` | complete HTML per version; hubs retain ≥ `VERSIONS_RETAINED` (5) unpinned versions, pruning oldest; the factory version (v1 of a build or install) is `pinned` and NEVER pruned; revert/reset = copy-forward as a NEW version |
| `snug_app_schemas` | one row per app with data: the app's runtime `sqlite_master` DDL **verbatim** (`schema_json`: objects in creation order + AUTOINCREMENT sequence counters) and its namespace `token` |
| `snug_app_migrations` | append-only DDL audit per app (`seq`, statement, applied-at) |
| `snug_app_docs` | per-app knowledge wiki: `(app_id, slug)` → markdown (`vision`, `requirements`, `plan`, `lessons`, `memory`, `next-tasks` are advisory slug values; the table shape is normative) |
| `snug_chat_threads` / `snug_chat_messages` | every chat surface's history; messages carry `pinned` (bootstrap turns survive any pruning for the life of the app) and `meta` (JSON sidecar) |
| `snug_sync` | sync-origin CONFIG only (self-describing when ported) |

### 2.2 Per-app data: native namespaced tables (v2, ADR-0010)

Each app's data lives as REAL tables in the same file under
`app_<token>__<name>`, where `token = appDataToken(namespace)` — a **normative,
total, injective** function of the host-assigned namespace: UUID-shaped →
32 lowercase hex (dashes stripped); anything else → `'x' + hex(utf8(namespace))`.

Rules (all normative):
- **Reserved prefixes** (case-insensitive): `snug_`, `sqlite_`, `app_`. App object
  names must match `^[A-Za-z][A-Za-z0-9_]{0,40}$` and carry no reserved prefix; the
  single exemption is the driver-internal `snug_kv` (at rest `app_<token>__snug_kv`).
  A conforming hub REFUSES to persist (fails closed, prior state retained) any runtime
  whose object names violate the rule — unvalidated names are never interpolated.
- **Isolation is physical at runtime**: app SQL executes only against a materialized
  database containing that app's own objects under natural names; hub-namespace and
  other apps' tables are unreachable.
- **DDL is stored verbatim** in `snug_app_schemas.schema_json` (tables, indexes,
  triggers, views, in creation order) and replayed on materialization; DDL bodies are
  never rewritten. At-rest table names are produced by SQLite `ALTER TABLE … RENAME`
  (a pure name swap), not by editing statement text.
- Per-app export = materialize + export: a standalone `.sqlite` with natural names.
- Hub-namespace tables are `snug_`-prefixed; apps can never reach them.
- Push-state (last pushed revision/hash) lives OUTSIDE the image (sidecar) so the file
  never contains its own revision.

### 2.3 Client-authoritative writes

The user DB is the single source of truth in every mode. In subscription mode the hub
may cache artifacts and thread history server-side, but the client fetches artifact
content and writes it into the user DB itself; hub stores are transient caches.

## 3. Hub provider obligations

A conforming hub:
1. **Never requires its backend for app execution** — the hub client is static files;
   app reads/writes hit the browser copy (OPFS) of the user DB.
2. **Offers Export/Import** — one-click download/upload of the canonical `.sqlite`
   (default export strips `snug_secrets` and VACUUMs; including secrets is explicit
   opt-in). Import treats the file's endpoint settings as executable config and
   requires user re-confirmation before agent turns run.
3. **May host the user DB as the default sync origin** via:
   - `GET /userdb` → `200` bytes + `ETag` revision (`application/octet-stream`,
     `nosniff`, `no-store`) or `404` when none.
   - `PUT /userdb` with `If-Match: <revision>` (or `If-None-Match: *` first write) →
     `204` + new `ETag`; mismatch → `412` + current `ETag`; missing precondition →
     `428`; over-quota → `413`. Cookie auth requires CSRF double-submit
     (`x-snug-csrf`). Unauthenticated → `401`; CORS is fail-closed (explicit origin,
     credentialed).
   - First login provisions the user record only — a hub never creates an empty DB
     image that could clobber local state; the client pushes up.
4. **Supports pluggable origins** through the `SyncProvider` contract
   (`info/pull/push(bytes, baseRevision)`); personal origins (e.g. Dropbox) may carry
   secrets on explicit opt-in. Conflict policy v1: revision-token CAS; divergence is
   surfaced to the user; last-writer-wins only on explicit user action.

## 4. Secrets posture

Secrets (`snug_secrets`) exist in the local runtime copy. They are stripped from
hub-origin pushes and default exports (VACUUMed so freed pages leak nothing) and never
enter browser `localStorage`/`sessionStorage`, any frame posted to an app iframe, or
any hub request. Persistent at-rest storage is a documented trade-off for portability;
no KMS/host-blind claim is made until a KeyProvider ships.

## 5. Execution modes

- `byok` — browser-direct frontier API; key from `snug_secrets`.
- `local` — browser-direct OpenAI-compatible endpoint (e.g. Ollama).
- `subscription` — hub-mediated `/invoke` (opt-in); body may carry a validated
  `model`; artifacts still land client-authoritatively (§2.2).

C1/C2 are unchanged in every mode: app iframes stay `sandbox="allow-scripts"` with
`connect-src` blocked; LLM calls originate from the HOST page only; credentials never
enter the iframe.
