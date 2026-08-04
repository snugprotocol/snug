# 0010 — Per-app data as LLM-designed native tables; materialized runtime DB for isolation

- **Status:** proposed
- **Date:** 2026-08-03
- **Task:** TASK-20260803-living-apps

## Context
ADR-0007 landed per-app data as a **blob-embedded standalone SQLite DB** per app inside the single user DB (`snug_app_data`): total physical isolation, no SQL rewriting — but each app's data is an opaque blob the hub and the LLM cannot see into. The owner's vision goes further: each app's data should have its **own unique shape** — real tables planned by the LLM from the app's context, requirements, and vision (a portfolio app gets `financial`, `equities`, `trades`, …), recorded in metadata the hub consults when loading and working on the app, with the LLM generating DDL and read/write queries and the hub client as the execution layer. The portable-hub adversarial review had rejected SQL parsing/prefix-rewriting as fragile and injection-prone, and sql.js exposes no SQLite authorizer — so direct namespaced execution cannot be safely validated.

## Decision
- **At rest**: each app's data lives as real tables in the single user DB under a spec-normative namespace — `app_<token>__<table>` (`<token>` = app UUID sans dashes; `<table>` matches `^[a-z][a-z0-9_]{0,40}$`, never `snug_*`/`sqlite_*`). A registry row per app (`snug_app_schemas.schema_json` — ordered table list with natural-name DDL) is the metadata the hub and LLM read; `snug_app_migrations` is an append-only DDL audit.
- **At run**: the driver **materializes** the app's tables into that app's own in-memory sql.js DB with natural names; app SQL executes there — isolation stays *physical* at runtime (a materialized DB only ever contains its own app's tables), the wire protocol stays at v1, and the LLM writes app queries against natural table names. Debounced write-back refreshes the rest tables transactionally and auto-registers schema drift (app-code DDL is legal).
- **DDL execution layer**: LLM-proposed schemas/migrations arrive via a build-time tool (`schema_apply`) and are executed host-side by the hub client (`applyAppDdl`), which validates names and updates runtime + rest + registry + audit atomically.
- Per-app `.sqlite` export = materialize + export (standalone DB, natural names). `snug_app_data` is dropped; v1→v2 migration explodes existing blobs into native tables (per-app failure quarantine).

## Alternatives considered
- **Direct execution + SQL validation/rewriting** — rejected (again): no authorizer in sql.js; statement parsing is the fragile, injection-prone path the prior review killed.
- **Keep blob DBs, add registry metadata only** — rejected: data stays an opaque blob row, which is exactly what the owner declined; hub/LLM still can't see or query the shape at rest.
- **Named-query registry instead of SQL in app code** — rejected at interview: new wire operation (protocol churn) and a larger SDK surface for little gain at v1.

## Consequences
- Supersedes ADR-0007's blob-embedded app-data layout (its single-file, `snug_*` hub-namespace, and isolation *property* survive — the enforcement mechanism changes).
- `USERDB_SCHEMA_VERSION` → 2; spec v0.2 draft amended in place (never pushed); DDL snapshot regenerated deliberately; High-tier work.
- Write amplification (full rest-table refresh per debounce) accepted at v1 caps; per-table dirty tracking is the future lever.
- Portable surface = tables + indexes; triggers/views are out of scope and documented as such.
