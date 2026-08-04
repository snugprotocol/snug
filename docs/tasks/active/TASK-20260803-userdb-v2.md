# TASK-20260803-userdb-v2: User-DB schema v2 — native app tables, schema registry, factory pins, docs (child 1 of living-apps)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: **high** (`packages/protocol/src/userdb-schema.ts` = spec surface; driver seam C2-adjacent)
- **Branch**: `feat/TASK-20260803-living-apps` (umbrella branch)
- **Packages touched**: `protocol`, `db`
- **Spec impact**: spec v0.2 draft amended in place (never pushed)
- **Related**: umbrella [TASK-20260803-living-apps](TASK-20260803-living-apps.md), ADR-0010

## Spec (what & why)

Foundation for the living-apps umbrella: schema v2 with real per-app tables + registry, materializer driver backend, factory version pinning, bootstrap-message pinning, per-app docs tables, install-source dedup key. Wire protocol v1 unchanged; `createDbDriver` guardrails reused, not re-implemented.

**Acceptance criteria** (umbrella AC1/AC2/AC3-part/AC5-part/AC6-part/AC8-part/AC10):
1. `applyAppDdl` creates prefixed rest tables + registry row matching runtime `sqlite_master`; name-rule negatives rejected; app A cannot reach app B's tables in either name form (C2-adjacent negative).
2. Per-app export = standalone `.sqlite`, natural names; whole-DB export→import deep-equal round trip incl. schemas/docs; BLOB-column fidelity through materialize → write-back → reopen.
3. App-code DDL via `exec` auto-registers on write-back; `applyAppDdl` atomic under induced failure.
4. Factory pin: v1 pinned on install/build; 7 versions → factory + 5 recent; `resetToFactory` restores byte-exact HTML.
5. Bootstrap: message `pinned`/`meta` columns; prune helper retains pinned at any cap.
6. `installApp` with `install_source`: second install of same source returns the existing app (DB-level partial unique index as backstop).
7. Migration v1→v2 structural (new tables/columns/index, `snug_app_data` dropped, oldest surviving version per app stamped pinned, `user_version`=2); data abandoned by design (owner-approved).
8. Protocol DDL snapshot + invariants tests updated deliberately; per-app driver (v1 `snug-db` store) untouched and green.

**Out of scope**: tools/prompts (child 2), playground UI (children 3–4).

## Shared literals (from umbrella — verbatim)

`USERDB_SCHEMA_VERSION = 2` · rest-table prefix `app_<32-hex-token>__` (UUID sans dashes; non-UUID namespace → djb2 fallback token) · table-name rule `^[a-z][a-z0-9_]{0,40}$` · tables `snug_app_schemas` / `snug_app_migrations` / `snug_app_docs` · columns `snug_apps.install_source` / `snug_app_versions.pinned` / `snug_chat_messages.pinned` / `snug_chat_messages.meta` · index `idx_snug_apps_install_source` (partial unique `WHERE install_source IS NOT NULL`) · doc slugs `vision|requirements|plan|lessons|memory|next-tasks` · install-source format `starter:<folder>`.

## Plan

`packages/protocol/src/userdb-schema.ts` (constants + DDL + naming rule + token fn spec) → protocol tests → `packages/db/src/userdb/userdb.ts` (materializer PersistenceBackend replacing blobBackend; registry/docs/pin APIs; migration) → db tests. Tests FIRST per AC.

## Decisions & surprises

—

## Session journal (append-only, newest last)
