# TASK-20260731-sdk-db: `packages/sdk` + `packages/db` — in-app hooks + per-app database (child 4 of build-hub)

- **Status**: in-progress
- **Owner**: Jeetu (delegated session)
- **Risk tier**: medium
- **Branch**: `feat/TASK-20260731-sdk-db`
- **Packages touched**: `packages/sdk`, `packages/db` (consumes protocol; db implements runner's `DbDriver`)
- **Spec impact**: none (implements existing frames)
- **Related**: umbrella P2#4; KB≡SDK sync contract (knowledge-store journal); runner handoff notes (DbDriver shape, 8 MiB db frame class)

## Spec (what & why)

**`packages/sdk`** — the in-app side of the protocol, two consumption forms with ONE source of truth:
1. **Embedded form** (v1 primary): the copy-exactly hook code generated apps embed. Canonical source = `packages/sdk/embedded/snug-hooks.js` (plain browser JS, no imports, React-via-globals). The KB's `20-html-template.md` code block MUST equal it — enforced by the **KB≡SDK sync test** (extract rendered KB block, normalize whitespace, byte-compare). Editing either side without the other fails CI.
2. **Module form**: typed ESM exports (`useSnugApp`, `usePersistedState`, `useAppDB`) for bundler-built apps, implementing the identical contract (announce/ready handshake, per-request UUID map, terminal-resolution, streaming via `onStream` never resolving, db ops over frames with TOP-LEVEL response fields, pre-ready guard). Behavior locked by shared contract tests run against BOTH forms (module directly; embedded via `new Function` in jsdom).

**`packages/db`** — the per-app database (the differentiator; all-new build):
- `createDbDriver(opts?) → DbDriver` (runner's interface: `handle(namespace, frame) → DbDriverResult` with top-level `rows/columns/value/bytesBase64`).
- Engine: **sql.js** (WASM SQLite). One database per `namespace` (host-assigned). kv ops (`kvGet`/`kvSet`) implemented as a `snug_kv(key TEXT PRIMARY KEY, value TEXT)` table inside the same per-namespace DB (one file = whole app state).
- Persistence drivers (auto-detect, injectable for tests): **OPFS** (`navigator.storage.getDirectory`, one file per namespace) → **IndexedDB** fallback → in-memory (explicit `persistence: 'none'` signal surfaced to caller). Debounced write-back after mutations; `flush()` for tests/teardown.
- `export` → real SQLite file bytes (base64 over the frame; ≤ 5 MiB enforced) — openable in DB Browser for SQLite (magic-bytes + reopen test). `import` replaces the namespace DB (validated: header magic + sql.js open succeeds; size cap).
- SQL safety: single-statement `exec` with params; errors returned as `DbDriverResult` failures (never throw across the driver boundary).

**Acceptance criteria** (each ≥1 test):
1. KB≡SDK sync: rendered KB block ≡ `embedded/snug-hooks.js` (normalized); fails on either drifting.
2. Contract suite runs against BOTH sdk forms: handshake, sendMessage terminal/streaming/error, multiple in-flight, pre-ready guard, db op field shapes (top-level), theme from host-ready + host-event.
3. db round-trip: create → exec DDL+DML with params → kvSet/kvGet → export → magic bytes `SQLite format 3\0` → import into a fresh driver → identical query results (umbrella AC-5).
4. Namespace isolation: two namespaces can't see each other's tables/kv (negative test).
5. Persistence fallback: OPFS absent → IndexedDB used (fake-indexeddb) → both absent → memory + `persistence:'none'` surfaced; reload (new driver, same backend) restores state.
6. Size caps: export >5 MiB → typed error; import >5 MiB or bad magic → typed error; results fit the 8 MiB db frame class.
7. `exec` returns `{rows: unknown[][], columns: string[]}` exactly (KB-documented shape); SQL errors → `ok:false` typed, driver never throws.
8. Both packages build; browser-safe (sql.js wasm located via injectable locator; no `node:` imports in src); root `pnpm test` green.

**Out of scope**: agent-writes-SQL demo flow (child 6); server persistence; migrations story (post-v1).

## Plan
db first (driver + persistence + tests), then sdk (embedded file extracted from current KB block — fix any bugs found IN BOTH via the sync discipline, module form, contract suite), then cross-package integration test (runner host + sdk module + db driver in one jsdom harness exercising a full app round-trip with a scripted mock transport). Deps: sql.js (runtime, db), fake-indexeddb (dev). Runner/knowledge untouched except: if a KB hook bug surfaces, fix KB + regen + snapshots in the same commit (sync discipline).

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: task file.
- Next: implement (delegated), review, merge.
