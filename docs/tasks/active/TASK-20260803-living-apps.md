# TASK-20260803-living-apps: LLM-designed per-app data schemas, app-context chat, factory-pinned versions, per-app knowledge wiki, SSO/marketplace retrofit

- **Status**: planned (awaiting owner approval)
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated: `packages/protocol/src/userdb-schema.ts` = spec surface; db driver work is C2-adjacent; auth UI touches the SSO surface; `db`/`protocol` widely depended)
- **Branch**: `feat/TASK-20260803-living-apps` (created off `main` at plan time; no implementation code until approval)
- **Packages touched**: `protocol` (userdb-schema), `db` (userdb + driver), `knowledge` (schema/doc tools + prompts), `apps/playground` (chat/versions/marketplace/SSO UI), `apps/server` (only if endpoint shape changes), `sdk`/`runner` (only if driver seam shape changes)
- **Spec impact**: spec v0.2 **draft amendment** (draft is staged, never pushed — amend in place; → [SPEC_SYNC.md](../engineering/SPEC_SYNC.md))
- **Related**: ADR-0007 (single portable user DB — this task supersedes its blob-embedded app-data layout; new ADR required), TASK-20260803-portable-hub (baseline), TASK-20260803-versions-chat (chat/versions baseline), next-steps "marketplace/spotlight curation" (still out of scope)

## Spec (what & why)

Five owner-directed evolutions of the portable hub (vision, 2026-08-03):

1. **App data = real, LLM-designed tables, not a blob.** Replace the single `snug_app_data` blob row per app: each app's data lives as its **own tables with its own schema under the app's unique namespace**, inside the same single user DB file. At build time the LLM proposes the best schema for the app (from context, requirements, vision); the hub client executes that DDL dynamically. The schema/shape is recorded in app metadata (registry) which the hub consults when loading and working on the app. After build, the LLM generates the read/write queries against that schema; the hub client is the execution layer for queries and DDL. (Example: a mini portfolio app ends up with `financial`, `equities`, `inventory`, `trades`… tables planned by the LLM.)
2. **Chat page attaches to the loaded app.** Today's chat is too generic — it lacks the context to add features on request. Every chat page binds to the currently loaded app, loads that app's past threads & messages, and lets the user continue enhancing it. The first/bootstrap build message is **permanent** — retained as long as the app lives — so the user can always get back to the context from the beginning.
3. **Factory version pinned forever.** For every app built or installed from the marketplace, that original version is **pinned and never recycled** — the user can always reset to factory default. On top of that, the 5 most recent versions are retained (as today).
4. **Per-app knowledge wiki with compounding memory.** Store prompts in the DB (as before), and additionally capture the user's vision, requirements, plan, lessons learnt, and memory for every app — updated on every app change. All markdowns/docs/next-tasks/lessons live in the DB, isolated per app, wiki-style — so each subsequent change compounds (the same compound-engineering effect this repo's process uses) instead of losing vision/context.
5. **Web-client retrofit + marketplace dedup.** Integrate Google SSO properly into the revamped web client UI/UX; fix the bug where clicking a marketplace app repeatedly installs duplicate copies — connect to the existing install if present. DB schema changes allowed to track install identity. Keep evolving the UI/UX with the app vision.

**Acceptance criteria** (each becomes at least one test; refined at plan approval):
1. Building an app creates its LLM-proposed tables under the app's namespace in the single user DB; the schema is recorded in a registry (metadata) row; app A cannot read or write app B's tables (negative test, C2-adjacent).
2. Per-app `.sqlite` export still derives a standalone DB containing exactly that app's tables; whole-DB export/import round-trips all app schemas + data.
3. An enhance turn sees the app's current schema (from the registry) in LLM context; an LLM-proposed schema change (DDL) is executed by the hub client and the registry row is updated in the same transaction.
4. Opening an app's chat loads all prior threads/messages for that app from the user DB (fresh session over same bytes included); the enhance prompt includes the app's code, metadata, schema, and knowledge docs.
5. The bootstrap (first build) message survives any message pruning/cap for the life of the app; deleting the app removes it.
6. The factory version (v1 of a built or marketplace-installed app) is never pruned: after 7+ edits, retention = factory + 5 most recent; one-click "reset to factory" restores its exact HTML.
7. Every build/enhance turn's prompts persist in the DB; per-app knowledge docs (vision/requirements/plan/lessons/memory/next-tasks) are created at build, updated on app change, isolated per app, and round-trip export/import.
8. Clicking an already-installed marketplace/starter app opens the existing install — no duplicate app row (regression test on repeated clicks); install identity is tracked in the schema.
9. Google SSO is integrated in the revamped client UI; login/logout state is reflected consistently across pages.
10. `packages/protocol/src/userdb-schema.ts` + spec v0.2 draft updated together; DDL snapshot test updated deliberately; full C1/C2 negative suites stay green.

**Out of scope**: marketplace curation/review flow and remote marketplaces (gallery = current starters); non-Google SSO; CRDT/multi-device merge; vendored-runtime offline work; `packages/auth` credential broker; pushing spec v0.2 (needs explicit ask); migrating pre-existing blob app data (pre-launch — abandoned, per portable-hub F13 precedent, confirm at interview).

## Interview notes (Gate 1)

Answered 2026-08-03 (owner):
1. **Isolation for real namespaced tables** → **Materialized runtime DB.** At rest: real prefixed tables in the ONE user DB + schema registry row. At app load the driver materializes that app's tables into the app's own in-memory sql.js DB with natural names (`trades`, not `app_x__trades`); app SQL executes there (physical isolation preserved, wire v1 unchanged); changed tables write back. → ADR-0010.
2. **Runtime query surface** → **SQL in app code** (today's `useAppDB` exec surface). LLM writes queries into the app at build/enhance time against the registered schema; DDL proposed by the LLM via a new build-time tool, executed host-side by the hub client.
3. **Knowledge cadence** → **On every app change**: whenever a turn writes a new app version, the assistant also updates the app's wiki docs via doc tools (prompt-enforced).
4. **Retrofit scope** → **Full pass**: login/identity surfaced consistently, chat page redesigned around the attached app, marketplace installed-state, creative evolution within warm-ember.

## Plan

### Current-state map (Gate 2 — two fresh-context explorers, 2026-08-03)

- **User DB v1** (`packages/protocol/src/userdb-schema.ts`, `USERDB_SCHEMA_VERSION=1`, byte-locked by `userdb-schema.test.ts` snapshot): 10 `snug_*` tables; **no indexes, no FKs**. Per-app data = one BLOB row in `snug_app_data` (a complete standalone sql.js DB), served to the runner via `blobBackend` + `createDbDriver` composition (`packages/db/src/userdb/userdb.ts:383-418` → `packages/db/src/driver.ts`). SQL executes host-side; driver blocks ATTACH / `PRAGMA writable_schema` / `load_extension`, single-statement only; isolation is physical (own DB per namespace).
- **Versions**: `insertVersion` prunes `version <= n-5` unconditionally (`userdb.ts:444-455`); **nothing is pinnable**. Revert = copy-forward (`userdb.ts:556-563`).
- **Chat**: `snug_chat_threads(app_id nullable)`/`snug_chat_messages`; run-rail thread id `app:<id>` pinned + hydrated (`useBuilderChat.ts:88-120`), but **no thread list UI**, artifact cards not persisted, and **direct-mode prompts carry zero context** — `builder.ts:160-163` sends only the current message; system prompt is static (`assemble.ts:28-38`); subscription mode gets server-side text history only, never the app HTML. **Volatile builder pin**: `artifactSink.ts:42` keeps the thread→app install only in the sink closure; the durable thread row never records the app id for builder threads (`useBuilderChat.ts:115`) → returning to `/build` in a new session installs a duplicate app instead of versioning.
- **Marketplace dup bug (root cause confirmed)**: `HubView.tsx:57-68` `installStarter` → `library.ts:53-57` → `userdb.ts:463-484` unconditional `INSERT` with fresh UUID; starter identity (`starter--chess`) discarded; `snug_apps` has **no source/slug column and no unique key** (`userdb-schema.ts:66-76`); tile has no installed state and double-clicks race.
- **Auth UI**: only `SettingsView` `AccountCard` (202-229); `useAuth` imported exactly once app-wide; shell header has no identity affordance; `logout()` never rebuilds the sync loop (`state/sync.ts:67-68` comment is wrong for logout); OIDC callback always redirects `/` (no return path). Server half (`apps/server/src/routes/auth.ts`) is complete and hardened.
- **Design system**: warm-ember tokens + hand-built kit; Hub/Builder/Run are post-revamp; `SettingsView` + `VersionsPanel` are inline-style pre-revamp stragglers; `STARTER_LOOKS` hardcoded per starter.

### Target design

**Wire protocol v1 unchanged** (frames `exec|kvGet|kvSet|export|import`, envelope, SDK hooks — apps written for v1 run unchanged). Everything happens behind the `DbDriver` seam and in the user-DB layout, which is spec v0.2 **draft** surface — amendable in place, never pushed.

**A. App data = real namespaced tables + schema registry (ADR-0010, supersedes ADR-0007's blob layout).**
- `USERDB_SCHEMA_VERSION` → **2**. Layout changes in `packages/protocol/src/userdb-schema.ts`:
  - **At-rest data tables**: `app_<token>__<table>` where `<token>` = app UUID with `-` stripped (fixed 32 hex chars) and `<table>` matches `^[a-z][a-z0-9_]{0,40}$`, never `snug_*`/`sqlite_*` (spec-normative naming rule; makes the one-identifier DDL rewrite trivial and unambiguous — no general SQL parsing).
  - `snug_app_schemas` — registry: `app_id TEXT PRIMARY KEY, schema_json TEXT NOT NULL, updated_at TEXT NOT NULL`. `schema_json` = ordered `[{name, ddl, indexes[]}]` where `ddl` is the natural-name `CREATE TABLE` exactly as it appears in the app runtime DB's `sqlite_master`. The hub reads this when loading/working on an app; the LLM reads it as enhance-turn context.
  - `snug_app_migrations` — append-only DDL audit: `app_id, seq, ddl, applied_at, PRIMARY KEY (app_id, seq)`.
  - `snug_app_data` **dropped**. v1→v2 migration is **structural only** (add new tables/columns/index, drop `snug_app_data`, stamp each app's oldest surviving version `pinned=1` so the factory invariant holds): existing blob data is **abandoned** — owner-confirmed 2026-08-03 ("plan to clean all the data and start fresh"), consistent with the portable-hub F13 pre-launch precedent. No data-fidelity obligations from v1 files.
- `packages/db/src/userdb/`: `blobBackend` replaced by a **materializer**: on first driver op for a namespace, build the app's in-memory DB from registry DDL + rest-table rows (natural names, incl. driver-internal `snug_kv`); app `exec` runs there (existing guardrails inherited). Debounced write-back (existing 250 ms pipeline): inside one outer transaction, refresh the app's rest tables from the runtime DB; if runtime `sqlite_master` diverged from the registry (app-code DDL is legal), auto-register new/changed tables + append to `snug_app_migrations`. Values copy as sql.js natives (numbers/strings/`Uint8Array`/null — BLOB fidelity tested).
- New service API: `getAppSchema(appId)` · `applyAppDdl(appId, statements[])` — the hub-client execution layer for LLM-proposed DDL: validates names, executes against the materialized runtime DB, syncs registry + rest tables + audit atomically. `deriveAppExport` = materialize → `export()` (still a standalone `.sqlite` with natural names). Portable surface = tables + indexes (triggers/views out of scope, documented).
- Isolation stays **physical at runtime**: a materialized DB only ever contains its own app's tables — negative test: app A `exec` referencing `app_<B>__x` or B's natural table fails with no data movement.

**B. App-context chat.**
- **Context assembler** (`apps/playground/src/agent/appContext.ts`, new): builds a capped context block — app metadata, current HTML (truncation marker past cap), `schema_json`, knowledge docs, recent thread history — used identically in direct mode (extra system/user block) and subscription mode (prepended into the wire message; server untouched).
- **Durable pin**: on sink install, write the app id onto the thread row; sink initializes its pin from the thread row → kills the second duplicate-app source and makes builder threads resumable.
- **Threads UX**: per-app thread list (`listThreads` filtered by app) + new-thread; run-rail redesigned around the attached app: tabs **chat · versions · docs · inspector**.
- **Bootstrap immortality**: `snug_chat_messages` gains `pinned INTEGER NOT NULL DEFAULT 0` + `meta TEXT` (JSON: artifact refs so cards persist, wire-text when it differs from display). First build user message + assistant reply pinned; the (new, capped) message-pruning helper skips pinned rows — spec text states pinned rows live as long as the app.

**C. Factory version pinning.** `snug_app_versions` gains `pinned INTEGER NOT NULL DEFAULT 0`; v1 of every install/build path sets it. Pruning becomes `... AND pinned = 0` → retention = **factory + 5 most recent**. VersionsPanel: "factory" badge + always-available "reset to factory" (copy-forward revert). Migration stamps `pinned=1` on each app's oldest surviving version.

**D. Per-app knowledge wiki.** `snug_app_docs`: `app_id, slug, title, content, updated_at, PRIMARY KEY (app_id, slug)`. Standard slugs `vision · requirements · plan · lessons · memory · next-tasks` (free-form extras allowed). New tool `app_doc_write {slug, title?, content}` (knowledge store, both modes) targeting the pinned app; prompts updated: first build seeds vision/requirements/plan from the idea; **every turn that writes an app version must also update the relevant docs** (lessons/memory/plan deltas) — the compounding loop. Docs tab renders the wiki (read + manual edit); docs ride export/import for free.

**E. Marketplace dedup + SSO/UI retrofit.**
- `snug_apps` gains `install_source TEXT` (`starter:<folder>`, later `marketplace:<id>`; NULL for built apps) + partial unique index `WHERE install_source IS NOT NULL`. `installStarter` becomes find-or-open: existing install → navigate to it; tiles show installed/open state; install button latched while in flight. DB-level uniqueness is the backstop (constraint violation → open existing).
- SSO retrofit: identity chip in the shell header (all pages) — sign-in/avatar/menu; logout **rebuilds the sync loop** (bug); post-login return path (one-shot state cookie carries it; `apps/server/src/routes/auth.ts` callback redirect — only server change in this task); first sign-in surfaces "sync to this hub?" suggestion.
- Design pass: SettingsView + VersionsPanel onto system classes (kill inline styles); AccountCard explains the static-demo case instead of vanishing; starter cosmetics derived not hardcoded; docs/threads tabs styled in warm-ember.

### Child tasks (umbrella pattern), order 1 → 2 → {3, 4}

- **Child 1 — userdb v2 core** (`protocol` + `db`) — *High; foundation.* Schema v2 constants + DDL + naming rule; migration v1→v2 (blob explode, pinned stamps, new tables/columns/index); materializer driver; `getAppSchema`/`applyAppDdl`; export/import; pruning changes; message-prune helper. DDL snapshot deliberately regenerated; spec draft §2.1 amended in the same commits.
- **Child 2 — schema + docs tools, prompts** (`knowledge` + playground tool wiring) — *Medium.* `schema_apply` + `app_doc_write` tool definitions; prompt updates (schema-first build honoring context/requirements/vision; docs-on-every-change rule; edit-in-place context); playground executes `schema_apply` via `applyAppDdl` and `app_doc_write` via docs CRUD, both against the sink's pinned app. Knowledge lint + content-drift suites updated.
- **Child 3 — app-context chat + versions UX** (playground) — *Medium.* Context assembler; durable thread pin; per-app thread list + docs tab + rail redesign; bootstrap pinning; artifact-card persistence via `meta`; factory badge/reset UI.
- **Child 4 — marketplace dedup + SSO retrofit + design pass** (playground + `apps/server` return-path) — *Medium.* Find-or-open install; tile states; identity chip; logout/sync fix; post-login return; Settings/Versions restyle.

### Test plan (tests FIRST, per AC)

- **AC1** (c1): `applyAppDdl` → prefixed rest tables + registry row match runtime `sqlite_master`; name-rule negatives (`snug_*`, `sqlite_*`, bad identifiers rejected); isolation negative: app A cannot reach B's tables in either name form.
- **AC2** (c1): per-app export = standalone DB, natural names, data equal; whole-DB export→import→deep-equal round trip incl. schemas/docs; BLOB-column fidelity through materialize/write-back/reopen.
- **AC3** (c1/c3): context assembler includes `schema_json` (unit); `applyAppDdl` atomicity — induced failure mid-apply leaves registry+rest+audit consistent; app-code DDL (CREATE TABLE via `exec`) auto-registers on write-back.
- **AC4** (c3): thread list per app; fresh session over same bytes → threads + messages + artifact cards render; assembler caps/truncation markers (unit); Playwright: reopen app → prior conversation visible → enhance turn's outgoing request contains app HTML + schema (mock adapter capture).
- **AC5** (c1/c3): first build pins user+assistant bootstrap messages; prune helper retains pinned regardless of cap; unpinned prune still works.
- **AC6** (c1/c3): 7 edits → factory + 5 recent exactly; reset-to-factory restores byte-exact v1 HTML after v1 would have been pruned; migration stamps existing apps.
- **AC7** (c2): tool schemas + prompt lint; docs CRUD round-trip; prompt instructs docs-on-change (content test); Playwright: build → vision/requirements/plan docs exist; enhance → lessons/plan updated.
- **AC8** (c1/c4): repeated `installStarter` clicks (incl. racing two) → exactly one app row (unit + Playwright regression); partial unique index enforced at DB level; installed tile opens existing app.
- **AC9** (c4): identity chip renders all four auth states; logout rebuilds sync loop (unit on `state/sync`); callback honors return path (server unit); cross-origin/CSRF negatives stay green.
- **AC10**: protocol DDL snapshot + `userdb-schema.test.ts` invariants updated deliberately; migration test v1→v2 (structural: new tables/columns/index present, `snug_app_data` gone, `user_version`=2, oldest surviving versions stamped pinned; blob data abandoned by design); **full C1/C2 negative suites + root `pnpm test` + Playwright** (protocol change → everything runs, per dependency graph).

### Spec-sync impact (Gate 2 statement per SPEC_SYNC)

Wire protocol: **no message/schema changes** — envelope + frames stay v1. `packages/protocol/src/userdb-schema.ts` changes (schema_version 2; `snug_app_data` removed; `snug_app_schemas`/`snug_app_migrations`/`snug_app_docs` added; `install_source`, two `pinned` columns, `meta`; namespaced-table naming rule; factory-pin + bootstrap-retention semantics) amend the **staged** spec v0.2 draft (`docs/spec-drafts/spec-v0.2-userdb.md`) in place — it has never been pushed, so no published-spec churn; `docs/spec-changelog.md` entry updated. Push still requires an explicit ask.

### Risks & mitigations

- **Write amplification** (full rest-table refresh per debounce): bounded by 64 MiB cap / typical tiny app data; lever = per-table dirty tracking later; perf smoke test in child 1.
- **DDL identifier rewrite**: constrained to one leading identifier under the strict naming rule — property-tested; no general SQL parsing (honors the portable-hub review's rejection).
- **Migration**: structural-only, data abandoned (owner-confirmed) — no fidelity risk; tested for structure, not content.
- **Context bloat**: assembler enforces byte caps per section with explicit truncation markers; caps unit-tested.
- **Lessons applied**: shared literals (tool names, table-name rule, prefix format) pinned in this file before any fan-out (2026-08-03 lesson); each child merge gets an independent fresh-context adversarial review with runnable probes (2026-07-31 lesson); High tier → this plan itself gets a fresh-context AI review before implementation.

### Shared literals (pinned before fan-out — 2026-08-03 lesson)

`USERDB_SCHEMA_VERSION = 2` · rest-table prefix `app_<32-hex-token>__` (UUID sans dashes) · table-name rule `^[a-z][a-z0-9_]{0,40}$` · new tables `snug_app_schemas` / `snug_app_migrations` / `snug_app_docs` · new columns `snug_apps.install_source` / `snug_app_versions.pinned` / `snug_chat_messages.pinned` / `snug_chat_messages.meta` · index `idx_snug_apps_install_source` (partial unique) · tool names `schema_apply` / `app_doc_write` · doc slugs `vision|requirements|plan|lessons|memory|next-tasks` · install-source format `starter:<folder>`.

### Post-approval sequence

1. Owner approves this plan (STOP is here).
2. Fresh-context AI review of the plan (High-tier requirement) — fold findings.
3. Spawn child task files 1 → 2 → {3, 4}, each Gate 3 failing-tests-first.
4. Independent adversarial review per child merge; Gate 6 close.

## Decisions & surprises

- This task **reverses a portable-hub implementation decision**: the umbrella plan explicitly rejected SQL namespace prefixing as "fragile, injection-prone" and chose blob-embedded per-app DBs. The owner now wants real per-app tables (LLM-designed schemas, hub-executed DDL/queries). The isolation property (ADR-0007: "an app can only touch its own namespace") must be preserved by a new mechanism — this is the core design risk and the subject of interview Q1. New ADR required; spec v0.2 draft amended (not yet pushed, so no published-spec churn).

## Session journal (append-only, newest last)

### 2026-08-03 — Jeetu/Claude — session
- Done: task file created from owner vision (5 workstreams); PROCESS/architecture/code-map/lessons/ADR-0007/SPEC_SYNC/portable-hub+versions-chat task files read; two explorer agents mapping userdb layer + playground client.
- State: Gate 1 in progress — interview pending.
- Next step: interview → fold answers → Gate 2 plan → branch → STOP for owner approval.
- Open questions: isolation mechanism; query surface; knowledge cadence; retrofit scope; blob-data migration (default: abandon, pre-launch).

### 2026-08-03 — Jeetu/Claude — session (Gates 1–2 complete)
- Done: interview answered (materialized runtime DB · SQL in app code · docs on every app change · full retrofit pass); both explorers folded into Current-state map (duplicate-install root cause = unconditional UUID insert + no source column; direct-mode prompts carry zero app context; volatile builder pin = second dup source; no version pinning; logout leaves stale sync loop); full Gate 2 plan written (design A–E, 4 children 1→2→{3,4}, test plan per AC, spec-sync statement, shared literals pinned, risks); ADR-0010 drafted (proposed) + index updated; migration decision: explode blobs (data preserved) rather than abandon — pre-launch either is acceptable, lossless chosen since blobs live in the same file. Branch `feat/TASK-20260803-living-apps` created; Gate 1–2 artifacts committed on it.
- State: **Gate 2 complete, awaiting owner plan approval.** No implementation code written.
- Next step: owner approves → fresh-context AI plan review (High tier) → spawn child 1 (userdb v2 core) failing-tests-first.
- Open questions: none blocking. Owner may override two judgment calls: (a) blob-explode migration vs abandon, (b) per-app thread list (multi-thread) vs single implicit thread per app.

### 2026-08-03 — Jeetu/Claude — session (plan approved)
- Done: owner approved the plan ("rest all looks good, go ahead") with one amendment: **abandon pre-launch data — no blob-explode migration** (owner will clean all data and start fresh). Plan/AC10/risks amended: v1→v2 migration is structural only. Multi-thread-per-app judgment call stands.
- State: entering High-tier pre-implementation step — fresh-context AI plan review.
- Next step: fold review findings → spawn child task files → child 1 failing tests first.
