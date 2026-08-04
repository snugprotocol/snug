# 0010 — Per-app data as LLM-designed native tables; materialized runtime DB for isolation

- **Status:** proposed
- **Date:** 2026-08-03
- **Task:** TASK-20260803-living-apps

## Context
ADR-0007 landed per-app data as a **blob-embedded standalone SQLite DB** per app inside the single user DB (`snug_app_data`): total physical isolation, no SQL rewriting — but each app's data is an opaque blob the hub and the LLM cannot see into. The owner's vision goes further: each app's data should have its **own unique shape** — real tables planned by the LLM from the app's context, requirements, and vision (a portfolio app gets `financial`, `equities`, `trades`, …), recorded in metadata the hub consults when loading and working on the app, with the LLM generating DDL and read/write queries and the hub client as the execution layer. The portable-hub adversarial review had rejected SQL parsing/prefix-rewriting as fragile and injection-prone, and sql.js exposes no SQLite authorizer — so direct namespaced execution cannot be safely validated.

## Decision
- **At rest**: each app's data lives as real tables in the single user DB under a spec-normative namespace — `app_<token>__<table>`, where `<token>` = `appDataToken(namespace)`, a **total, injective** function of the host-assigned namespace (UUID-shaped → 32 lowercase hex sans dashes; anything else → `'x' + hex(utf8(namespace))` — `x` sits outside the hex alphabet so the ranges cannot collide). Object names must match `^[A-Za-z][A-Za-z0-9_]{0,40}$` and never start (case-insensitively) with the reserved prefixes `snug_` (one exemption: the driver-internal `snug_kv`, at rest `app_<token>__snug_kv`), `sqlite_`, or `app_` (blocks forging another app's rest name). A registry row per app (`snug_app_schemas.schema_json`) is the metadata the hub and LLM read; `snug_app_migrations` is an append-only DDL audit.
- **At run**: the driver **materializes** the app's objects into that app's own in-memory sql.js DB with natural names; app SQL executes there — isolation stays *physical* at runtime, the wire protocol stays at v1, and the LLM writes app queries against natural table names. App-code DDL stays legal (v1-compat: the KB-taught pattern is `CREATE TABLE IF NOT EXISTS` at startup).
- **No DDL body is ever string-rewritten.** The registry stores the runtime `sqlite_master` DDL **verbatim** (all objects with `sql NOT NULL`: tables, indexes, triggers, views, in creation order). Materialize replays it in the app's own sandbox runtime. Write-back creates each table in the outer DB from the same natural DDL, then renames it (`ALTER TABLE … RENAME` under `legacy_alter_table=ON` — a pure name swap) and copies rows; a name-gate violation fails the whole write-back closed (transaction rolled back, previous rest state retained, error surfaced) — nothing is built from an unvalidated name. `sqlite_sequence` rows are name-mapped both directions; generated columns copy via explicit non-generated column lists.
- **Write-back discipline**: synchronous `BEGIN IMMEDIATE … COMMIT`/`ROLLBACK` on the single shared handle (no torn exports possible), transactional `MAX_USERDB_BYTES` guard before commit, and a per-namespace unchanged-bytes gate so read-only sessions never dirty the outer DB (sync content-hash stability).
- **DDL execution layer**: LLM-proposed schemas/migrations arrive via a build-time tool (`schema_apply`) and are executed host-side by the hub client (`applyAppDdl`), which validates names and updates runtime + rest + registry + audit atomically.
- Per-app `.sqlite` export = materialize + export (standalone DB, natural names), keyed by the same token function. `snug_app_data` is dropped; the v1→v2 migration is **structural only** — pre-launch blob data is abandoned (owner-confirmed 2026-08-03).

## Alternatives considered
- **Direct execution + SQL validation/rewriting** — rejected (again): no authorizer in sql.js; statement parsing is the fragile, injection-prone path the prior review killed.
- **Keep blob DBs, add registry metadata only** — rejected: data stays an opaque blob row, which is exactly what the owner declined; hub/LLM still can't see or query the shape at rest.
- **Named-query registry instead of SQL in app code** — rejected at interview: new wire operation (protocol churn) and a larger SDK surface for little gain at v1.

## Consequences
- Supersedes ADR-0007's blob-embedded app-data layout (its single-file, `snug_*` hub-namespace, and isolation *property* survive — the enforcement mechanism changes).
- `USERDB_SCHEMA_VERSION` → 2; spec v0.2 draft amended in place (never pushed); DDL snapshot regenerated deliberately; High-tier work.
- Write amplification (full rest-table refresh per genuine change) accepted at v1 caps; per-table dirty tracking is the future lever. Read-only sessions are no-ops (unchanged-bytes gate).
- Portable surface = ALL app runtime objects (tables, indexes, triggers, views, sequence counters) via registry replay; at-rest physical tables carry the data, the registry carries the shape.
