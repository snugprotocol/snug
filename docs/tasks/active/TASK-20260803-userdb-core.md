# TASK-20260803-userdb-core: Single per-user DB — schema constants, UserDb service, DbDriver face (child 1 of portable-hub)

- **Status**: planned
- **Owner**: Jeetu
- **Risk tier**: **high** (touches `packages/protocol` (userdb-schema spec constants) + `packages/db` foundation)
- **Branch**: `feat/TASK-20260803-portable-hub` (umbrella branch)
- **Packages touched**: `protocol`, `db`
- **Spec impact**: spec v0.2 draft surface created (`packages/protocol/src/userdb-schema.ts`); prose + changelog land in child 6
- **Related**: umbrella [TASK-20260803-portable-hub](TASK-20260803-portable-hub.md) (plan §Target architecture + §Amendments F5–F8, F10, F13), ADR-0007

## Spec (what & why)

Foundation for the portable hub: DDL + limit constants in protocol (one spec source), and a `UserDb` service in `packages/db` owning one sql.js handle over one OPFS file (`snug-userdb/user.sqlite`) with hub-namespace tables (`snug_meta/profile/settings/secrets/apps/app_versions/chat_threads/chat_messages/app_data/sync`), forward migrations via `PRAGMA user_version`, app versioning (retain ≥5, prune, revert = copy-forward), blob-embedded per-app databases behind the runner `DbDriver` shape, per-app export derivation, whole-file export/import with secrets-strip default.

**Acceptance criteria** (umbrella AC1/AC7-storage/AC10-partial/AC11-storage/AC12-partial):
1. Round-trip: 2 apps × 3 versions + chat + settings + secrets + app data → export (default) → import into fresh backend → everything restored EXCEPT secrets; export with `includeSecrets: true` restores secrets too.
2. DDL snapshot test locks `userdb-schema.ts`; migration test v0→v1 (fresh) and idempotent re-open.
3. Version retention: 7 writes → 5 retained (oldest pruned), `current_version` correct; revert(v) copy-forwards as new version with exact HTML.
4. DbDriver face: `handle(namespace, frame)` passes the existing per-app driver contract semantics (exec/kvGet/kvSet/export/import) with data landing in `snug_app_data` blobs; per-app export bytes are a valid standalone SQLite file.
5. Interleaved writes survive: typed CRUD write + driver write in any order both persist (single shared handle — F7).
6. Corruption fails closed: corrupt user-DB bytes → quarantined (`.bak` name), `openUserDb` reports recovery state, never silently fresh (F6); no fail-open.
7. Size guard: writes that would exceed `MAX_USERDB_BYTES` (64 MiB) are refused with a typed error (F8).
8. Web Lock single-writer + BroadcastChannel invalidation seam exists and is unit-tested via injected fakes (F12).

**Out of scope**: sync loop/providers (child 4), playground integration (children 2/3), spec prose (child 6).

## Plan

Files: `packages/protocol/src/userdb-schema.ts` (+ export from index, no zod/wire change) → `packages/db/src/userdb/{schema-apply.ts,migrations.ts,userdb.ts,driver-face.ts,locks.ts}` + `packages/db/src/userdb/__tests__/*`. Tests FIRST. Reuse `driver.ts` internals (sql.js load, base64, guardrails) via extraction, not duplication. Existing per-app driver untouched and its suite stays green.

## Decisions & surprises

—

## Session journal (append-only, newest last)
