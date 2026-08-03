# TASK-20260803-portable-hub: Portable user-owned hub — single user DB, local-first execution, sync origins, SSO

- **Status**: done (merged via PR)
- **Owner**: Jeetu
- **Risk tier**: **high** (auto-escalated: touches `packages/protocol` (portable DB format = spec surface), `packages/auth` (SSO), C1/C2 adjacency (serverless LLM call path), `packages/db` (widely depended))
- **Branch**: `feat/TASK-20260803-portable-hub` (to be created after plan approval)
- **Packages touched**: `db`, `protocol`, `sdk`, `runner` (host side only), `auth`, `adapters`, `apps/server`, `apps/playground`, `knowledge` (prompt updates), spec repo (downstream, needs explicit ask)
- **Spec impact**: spec v0.2 planned — portable user-DB format + sync + versioning become normative (→ [SPEC_SYNC.md](../engineering/SPEC_SYNC.md))
- **Related**: ADR-0003 (v1 scope/C1/C2), ADR-0004 (prompt store), ADR-0006 (runner CSP), TASK-20260731-build-hub (v1 baseline), next-steps "auth broker v1.1"

## Spec (what & why)

Evolve Snug from v1 (per-app DB, hub-server-mediated LLM calls) to a three-actor model: **LLM providers**, **hub providers** (multi-tenant SaaS provisioning SNUG apps), and the **end user** who owns their apps + data and can port both to any hub and any LLM provider. The load-bearing artifact becomes a **single SQLite file per user** holding all app code, app data, metadata, settings, and profiles. Apps execute **without any hub backend**: the DB runs in browser OPFS via SQLite WASM, and LLM calls go direct-from-browser (local LLM or frontier API via BYOK) unless the user explicitly opts into the hub provider's server-side LLM subscription. The user DB syncs periodically from OPFS back to a configurable origin (hub-hosted by default; personal cloud storage pluggable; always exportable as one `.sqlite` file).

Vision points (from owner, 2026-08-03):
1. Single SQLite DB per user — app code, data, metadata, settings, profiles.
2. No backend/middle tier required to run apps; offline-capable; app-related reads/writes and compute happen in-browser against OPFS SQLite; LLM calls direct from browser (local LLM or frontier API) — hub server never executes app code or writes user data.
3. DB origin hosted by hub by default; runtime copy in OPFS with periodic sync back; origin switchable to Dropbox/OneDrive/Drive/S3 (architecture + one example adapter now); every hub must offer single-file Export.
4. User chooses LLM provider + model; BYOK or hub-provider subscription (subscription path may route through hub server — the one sanctioned exception to #2).
5. Apps built or installed from marketplace/spotlight land in the same DB; edits update it; ≥5 versions retained per app with switch-back.
6. Google SSO on the sample hub; login provisions/maintains the user DB.
7. Every app's Chat page can modify the app; app code lives in the DB so the latest version loads on a new session/device.

**Acceptance criteria** (each becomes at least one test; refined at plan approval):
1. A single user `.sqlite` file contains apps (code), app versions, per-app data namespaces, chat threads, settings, and profile; exporting and re-importing it on a fresh origin/profile restores apps, data, and chat history.
2. An app runs end-to-end (load → interact → data persist) with **no hub backend process running**, served by the static hub client, from the OPFS copy of the user DB. (True network-offline app runtime is out of scope — generated apps load their runtime from the CDN allowlist; vendored-runtime template queued in next-steps. AC wording amended per plan review F3.)
3. In BYOK mode, LLM traffic goes browser → provider directly (no hub-server hop), from the **host page** — app iframes still cannot reach the network (C2 negative test stays green); credentials never enter the iframe (C1 negative test).
4. A local-LLM endpoint (OpenAI-compatible, e.g. Ollama) is selectable as a provider and works with no hub server and no frontier-API reachability (LLM traffic to localhost only; CDN caveat as AC2; Ollama CORS + https/mixed-content practicalities documented with targeted picker errors — F17).
5. Sync: OPFS copy periodically persists to the configured origin; origin is switchable via a `SyncProvider` interface; hub-origin + one example adapter (Dropbox) implemented; conflict story defined (last-writer-wins v1, documented).
6. Provider+model picker: BYOK and hub-subscription modes; subscription mode routes via hub server; BYOK keys stored in the user DB settings (with documented at-rest posture) and never sent to the hub.
7. Installing a starter/marketplace app writes it into the user DB; editing an app via its Chat page writes a new version; ≥5 versions retained (pruning beyond N); version list + one-click revert works.
8. Google SSO on the sample hub: login yields a per-user DB provisioned/loaded by the hub; logout/login on a new device restores the same state from origin.
9. Chat/builder edits round-trip: edit app → new version in DB → reload in fresh session loads latest version; chat history for the app persists in the same DB.
10. Spec sync: portable DB schema (tables, versioning semantics, namespace rule, mandatory Export, size caps) documented as spec v0.2 draft sourced from **`packages/protocol/src/userdb-schema.ts`** DDL/limit constants (one spec source per SPEC_SYNC — F10; wire frames/envelope unchanged at v1), locked by a DDL snapshot test + spec-changelog entry (push to spec repo only on explicit ask).
11. Secrets lifecycle (F1/F14): BYOK/Dropbox secrets survive a hub-origin sync round-trip locally; the pushed payload and default export contain zero secret bytes; keys absent from localStorage/sessionStorage and from every frame posted to the iframe.
12. Sync safety (F1/F6/F12): local-first-then-login pushes local state up (never clobbered by an empty provisioned DB); a corrupt local user DB is quarantined and restored from origin with **no auto-push** after recovery; two tabs cannot interleave-destroy writes (single writer via Web Lock, readers invalidated via BroadcastChannel).
13. Subscription mode is client-authoritative (F4): a subscription-mode chat edit lands as a new version of the target app in the **user DB** (client fetches artifact HTML on the SSE artifact event); server artifact/thread stores are transient cache, and export after a subscription edit contains the newest version.
14. Hub endpoints fail closed (F2/F11/F19): `/userdb` refuses unauthenticated requests (401) and cross-origin credentialed access; enabling auth requires explicit `SNUG_CORS_ORIGIN` (boot failure otherwise, no reflect-any); mutating cookie-auth'd routes carry CSRF defense; `GET /userdb` served `application/octet-stream` + `nosniff` + `no-store`.

**Out of scope**: desktop local hub app (later phase); adapters beyond Dropbox (OneDrive/Drive/S3 — interface only); multi-device concurrent-write merge/CRDT (v1 = last-writer-wins); hub marketplace curation/review flow; payments/subscription billing for hub LLM; KeyProvider/KMS encryption of BYOK keys at rest (documented posture instead); non-Google SSO providers.

## Interview notes (Gate 1)

Answered 2026-08-03 (owner):
1. **LLM call path (C1/C2 tension)** → **Host-page bridge.** "Directly from the app" is realized as: the hub's *client-side* (static JS, offline-capable, no backend) makes the LLM call on the app's behalf via the existing runner bridge/transport seam. App iframes stay `connect-src`-blocked; keys never enter the iframe. C1/C2 unchanged. → ADR-0008.
2. **DB shape** → **One physical `.sqlite` per user, per-app logical namespaces** enforced by the db driver/SDK; per-app `.sqlite` export derivable on demand. Keeps "single portable file" AND "isolated app data". → ADR-0007.
3. **Scope** → **All four slices in this umbrella** (user DB v2 + versioning · serverless run + BYOK/local LLM · sync origins + Dropbox adapter · Google SSO + provisioning), spawned as child tasks like TASK-20260731-build-hub.
4. **SSO stack** → **Direct Google OIDC** (Authorization Code + PKCE, openid-client) in `apps/server`; no vendor dependency; signed httpOnly cookie session. (Task-level decision, no ADR — sample-hub implementation detail, not protocol.)

## Plan

### Current-state map (Gate 2 code reading, 2026-08-03)

State today is split across **four disjoint stores** — the merge target of ADR-0007:
- **App code**: BYOK mode → IndexedDB `snug-playground/artifacts` (`apps/playground/src/state/library.ts:44-72`); server mode → `apps/server` better-sqlite3 `artifacts.sqlite` (`apps/server/src/stores/artifacts.ts:53-59`). **No versioning anywhere** — every `artifact_write` mints a fresh id (`library.ts:109-118`, `apps/playground/src/agent/tools.ts:49-57`).
- **Per-app data**: already OPFS SQLite — `packages/db` auto-detects OPFS→IDB→memory, one `<namespace>.sqlite` per app, namespace = library id (`packages/db/src/persistence.ts`, `apps/playground/src/run/RunView.tsx:266-282`). kv lives in `snug_kv` inside the same file.
- **Chat**: client-side React state only, dies on navigation (`agent/useBuilderChat.ts:43`); BYOK builder sends single-turn only (`agent/builder.ts:130-134`); server mode keeps history in `threads.sqlite` capped at 40 (`apps/server/src/stores/threads.ts`).
- **Settings**: localStorage `snug:mode` / `snug:byok-provider`, sessionStorage `snug:byok-key`, localStorage app-meta overlay `snug:app-meta` (`state/mode.ts:12-15`, `state/appMeta.ts:21`). No model picker (provider only), no user concept.

Helpful existing seams: BYOK mode is **already fully serverless** (browser-direct anthropic/openai/mock via `agent/adapter.ts:49-53`); per-app export already builds a host-side `DbRequestFrame {op:'export'}` (`run/exportDb.ts:13-21`); starter apps are build-time bundles that never enter the library (`starter/starterApps.ts`); `apps/server` has **no auth/user/static hosting** (rate-limit by IP only; `packages/auth` is a one-line stub); artifact HTML is served with the runner's byte-exact CSP (`apps/server/src/routes/artifacts.ts:19-25`).

### Target architecture

**Key insight from code reading: the wire protocol does not change.** Frames (`snug:db-request` ops `exec|kvGet|kvSet|export|import`), envelope, and SDK hooks stay at v1 — apps written for v1 run unchanged. The evolution happens entirely behind two existing seams:
- `DbDriver.handle(namespace, frame)` (`packages/runner/src/transport.ts:63-65`) — a new **user-DB driver** implements it over one file.
- `AgentTransport.send(wire, …)` (`packages/runner/src/transport.ts:32-34`) — BYOK/local/subscription transports plug in here; adapters are already browser-safe (`packages/adapters/src/index.ts:3-4`).

**Single-file layout (ADR-0007) — blob-embedded app databases, no SQL rewriting.** One sql.js user DB persisted as one `<user>.sqlite`. Hub-namespace tables:
`snug_meta` (schema_version via `PRAGMA user_version` + db uuid) · `snug_profile` · `snug_settings` · `snug_secrets` (BYOK keys, Dropbox token — see sync posture below) · `snug_apps` (app_id, display meta, current_version) · `snug_app_versions` (app_id, version, html, created_at, note; retain ≥5, prune beyond N default 5, revert = copy-forward as new version) · `snug_chat_threads` / `snug_chat_messages` (builder + per-app threads) · `snug_app_data` (namespace PK, bytes BLOB) · `snug_sync` (origin config, revision, last_sync).
Per-app data stays a **physically separate sql.js database stored as a BLOB row** in `snug_app_data` — total isolation preserved, per-app `.sqlite` export = read the blob, and today's driver internals (one in-memory Database per namespace, debounced write-back `packages/db/src/driver.ts:196-219`) are reused with the persistence target switched from "own OPFS file" to "blob row in the user DB". No SQL parsing/prefixing (rejected: fragile, injection-prone). `ATTACH` stays forbidden.

**Secrets posture (C1-adjacent, honest per ADR-0003):** BYOK keys/tokens live in `snug_secrets` in the *local OPFS copy*. Hub-origin sync and default export **strip `snug_secrets`**; export offers an explicit "include secrets" toggle for personal-origin/full portability. Keys are re-entered on a new device unless the user opted in. (Prevents "BYOK key never reaches the hub" from being silently violated by sync.)

### Child tasks (umbrella pattern per TASK-20260731-build-hub), order & files

**Child 1 — `userdb` core (packages/db)** — *foundation; everything depends on it; High.*
New `packages/db/src/userdb/`: `schema.ts` (DDL constants + `USERDB_SCHEMA_VERSION`, exported — spec surface), `migrations.ts` (user_version forward migrations), `userdb.ts` (`openUserDb(backend, file)` → typed API: apps/versions/chat/settings/secrets/profile CRUD + `deriveAppExport(namespace)` + whole-file export/import with secrets-strip option), `userDbDriver.ts` (implements the runner `DbDriver` shape over `snug_app_data` blobs, reusing `driver.ts` machinery). Existing per-app driver stays (v1 compat + tests).
**Child 2 — serverless run + provider/model picker (apps/playground + packages/adapters)** — *after 1; Medium (High where it brushes C1/C2 tests).*
Adapters: add `baseUrl`-only local provider path (OpenAI-compatible, Ollama default `http://localhost:11434/v1`), add `anthropic-dangerous-direct-browser-access` header to `anthropic.ts`, optional `model` plumb-through everywhere. Playground: settings gain model picker + local-LLM endpoint + mode = `byok | local | subscription`; `createAppTransport`/builder pick in-page `runAgentTurn` (byok/local) vs `createHttpTransport` (subscription). Migrate `state/mode.ts`, `state/appMeta.ts`, `state/library.ts` reads/writes into the user DB (settings/apps tables); starter "install" now copies HTML into `snug_apps`+`snug_app_versions`.
**Child 3 — versions + chat persistence (apps/playground)** — *after 1, parallel with 2; Medium.*
`artifact_write` (BYOK tool + rail chat) writes a **new version of the same app id** instead of minting a new id; version list + revert UI on the app page; `useBuilderChat` persists messages to `snug_chat_threads/messages` keyed `app:<id>` / `builder:<uuid>`; reload restores thread + latest version (AC9).
**Child 4 — sync origins (packages/db + apps/playground + apps/server)** — *after 1; Medium.*
`packages/db/src/sync/`: `SyncProvider` interface (`pull()/push(bytes, baseRevision)/info()`), `syncLoop` (debounced periodic + pagehide flush, LWW with revision token, divergence warning callback), `hubOrigin` provider (fetch to hub endpoints) + `dropbox` provider (raw fetch, OAuth code flow client-side, token in `snug_secrets`). Server: `GET/PUT /userdb` with `If-Match` revision, auth-gated (child 5), per-user blob store `userdbs.sqlite`. Playground: origin picker + Export/Import UI (generalizing `run/exportDb.ts` download path).
**Child 5 — Google SSO + provisioning (apps/server + apps/playground)** — *parallel with 4 until its endpoints need auth; High (auth).*
`openid-client` + `@fastify/cookie` in apps/server: `/auth/login` (PKCE) → `/auth/callback` → signed httpOnly session cookie → `/auth/me`, `/auth/logout`; `users` table (google sub, email, name, userdb ref); first login provisions an empty user DB server-side; login on new device pulls from origin (AC8). Playground: login button replaces the inert "connect account" chip (`views/SettingsView.tsx:100`); logged-out = local-only mode (everything still works, OPFS only). `packages/auth` (credential broker) stays untouched — hub login ≠ app credential brokering; noted to avoid scope creep.
**Child 6 — spec v0.2 draft + docs (docs + spec prep)** — *last; High (spec).*
Spec prose "Portable User Database Format" (tables, versioning semantics, namespace rule, sync/export requirements incl. mandatory Export) drafted for the spec repo **locally only** (push needs explicit ask); `docs/spec-changelog.md` entry; architecture.md/code-map.md/product-vision.md updated; wire schemas regenerated only if constants moved (not expected).

### Test plan (tests FIRST, per AC)

- AC1 (child 1): userdb round-trip — create 2 apps × 3 versions + chat + settings + app data → export → import into fresh backend → deep equality; secrets-strip export test.
- AC2 (child 2): Playwright — BYOK/local mode with **no server process**: install starter → run → write data → reload → data persists (OPFS).
- AC3 (children 2/1): existing C1/C2 suites stay green (negative gate); new probes — BYOK key never appears in any frame posted to the iframe; Playwright network interception asserts zero requests to hub origin during a BYOK turn.
- AC4 (child 2): local adapter unit tests against a mocked OpenAI-compatible endpoint; model picker state test.
- AC5 (child 4): SyncProvider contract suite (both providers); LWW conflict test (stale baseRevision → divergence surfaced, newest wins only on explicit user action); periodic-loop timer test; Dropbox adapter fetch-mock tests.
- AC6 (children 2/4): subscription mode routes via `/invoke` (unit); BYOK turn sends zero bytes to hub origin (probe); key stored in `snug_secrets` and absent from hub-origin push payload (unit).
- AC7 (children 2/3): starter install lands in user DB; 7 writes → 5 retained + prune order; revert restores exact HTML.
- AC8 (child 5): OIDC callback against a fake issuer (unit + Playwright); session cookie flags (httpOnly/secure/sameSite); first-login provisioning; second-device restore (fresh browser context → login → apps present).
- AC9 (child 3): edit via chat → new version; fresh driver over same bytes → latest version + full thread rendered.
- AC10 (child 6): DDL snapshot test locks `schema.ts` (spec surface); migration test v(n-1)→v(n); spec-changelog entry exists.
- Regression: full `pnpm test` at root — db is depended on by sdk + playground; protocol untouched but its suite runs anyway (graph in architecture.md).

### Spec-sync impact (SPEC_SYNC Gate 2 statement)

Wire protocol: **no message/schema changes**; envelope + frames stay v1 (AC10 wording amended accordingly). Spec v0.2 adds a new normative section: Portable User Database Format + mandatory-Export rule, sourced from `packages/db/src/userdb/schema.ts` DDL constants. Push to `snugprotocol/spec` deferred to an explicit ask, per release rules.

### Risks & mitigations

- **Write amplification** (whole user DB serialized per debounce): acceptable at v1 caps (≤5 MiB artifacts); mitigation lever = per-namespace dirty tracking already exists in driver machinery; measure in child 1 perf test.
- **Multi-tab OPFS**: single-tab-writer v1 (Web Lock held by first tab; others read-only banner). Test in child 1.
- **Anthropic browser CORS**: requires the dangerous-direct-browser-access header; documented BYOK trade-off (already the v1 BYOK posture).
- **Secrets in synced file**: mitigated by strip-by-default (see posture above); adversarial probe in review.
- **Lesson applied** (2026-07-31): each child merge gets an independent fresh-context adversarial review with runnable probes targeting C1/C2/secrets surfaces — "tests pass" is not review.

### Plan amendments after fresh-context review (2026-08-03, F1–F19)

Reviewer verdict: redesign needed narrowly (sync/secrets lifecycle; subscription write path); host-page bridge + blob-embedded layout survived attack. All findings folded as follows — **this section supersedes conflicting text above**:

**Sync/secrets state machine — redesigned (F1, F5, F6, F12):**
- OPFS is **authoritative**; the origin is a replica. Push-state (last pushed revision, content hash, dirty flag) lives **outside the synced image** (OPFS sidecar file) so the image never contains its own revision (kills the F5 push loop). Change detection hashes the image excluding volatile rows.
- **Pull is a merge, never a swap**: local `snug_secrets` rows are preserved into any pulled image; pull may replace local state only when local has no un-pushed changes, otherwise divergence is surfaced (LWW only on explicit user action).
- **First login with existing local data pushes up**, never pulls the empty provisioned DB down.
- **Corruption recovery fails closed** (unlike the per-app driver): corrupt bytes quarantined to `.bak`, restore attempted from origin, **no auto-push** until a good state is user-confirmed.
- Network push cadence decoupled from the 250 ms OPFS debounce: interval + changed-hash; **no pagehide network push** (keepalive caps ~64 KiB — only the OPFS flush runs at pagehide; a newer-than-origin local copy pushes on next session start).
- Multi-tab: single writer via Web Lock (`snug-userdb`); reader tabs get a read-only banner + BroadcastChannel invalidation; writer-crash handoff tested.

**Subscription mode — client-authoritative (F4, F9, F16):** on the SSE `artifact` event the client GETs `/artifacts/:id` and writes the HTML into `snug_apps`/`snug_app_versions` as a new version of the **host-side pinned target id** (per-app chat pins the app id; a builder thread pins to the id minted by its first write, with a defined new-app escape hatch). Server artifact/thread stores are demoted to transient cache; the user DB is the single source of truth in every mode. `artifact-write` prompt in `packages/knowledge` updated for edit-in-place semantics (BYOK/server parity); `/invoke` body gains optional `model` (zod-validated) for subscription-mode model choice.

**Offline — re-scoped honestly (F3, ADR-0003 honesty rule):** the claim is "serverless: no hub backend needed; local LLM keeps LLM traffic on-device". Generated apps load React/Babel from the CDN allowlist (ADR-0006), and sandboxed srcdoc iframes cannot be service-worker-cached — true network-offline runtime requires a vendored-runtime template variant, **queued in next-steps, not claimed**. Child 5 adds static hosting of the built playground to `apps/server` (`@fastify/static`) so a "hub provider" actually serves the hub client (also fixes AC2's serving story).

**Spec source (F10):** DDL + userdb limit constants live in **`packages/protocol/src/userdb-schema.ts`** (High tier, one spec source, SPEC_SYNC-consistent); `packages/db` imports them. Adds `MAX_USERDB_BYTES` (64 MiB v1) and per-route body limit for `PUT /userdb`; per-user server quota = same constant (F8).

**Single-writer core (F7):** one shared `UserDb` service owns the sql.js handle and persistence pipeline; both the typed CRUD API and the `DbDriver` face are views over it. Interleaved-write survival test required.

**Child resequencing (F11):** server `/userdb` endpoints move from child 4 to child 5 (they need auth to exist; no unauthenticated per-user blob window). Child 4 is client-side only (sync core + providers, hub-origin tested against mocks). Order: **1 → {2, 3} → 4 → 5 → 6**.

**Minors folded:** F13 — no data migration (pre-launch; old IndexedDB/localStorage/per-app OPFS files abandoned, stated in child 2; user DB lives under a distinct OPFS directory `snug-userdb/` so it can never collide with `namespaceToFileName` output). F14 — ADR-0008 amended: persistent plaintext secrets are a deliberate, documented weakening vs sessionStorage-only BYOK; storage negatives in AC11. F15 — imported/first-pulled DBs are executable config: endpoint/provider settings require re-confirmation before use; stored keys never auto-attach to an unconfirmed endpoint. F17 — Ollama `OLLAMA_ORIGINS` + Safari mixed-content documented, targeted picker errors. F18 — session-signing key env-only, fail-closed outside dev, commented-out in `.env.example` (2026-08-02 lesson). F19 — folded into AC14. F2 — child 5 must land CORS fail-closed + `SameSite=Lax` + `Secure` + CSRF token on mutating routes, with cross-origin negative tests; also fixes `config.ts` `??` on `SNUG_CORS_ORIGIN` per the 2026-08-02 lesson.

### Post-approval sequence

1. ✅ Fresh-context AI review of this plan (High-tier requirement) — findings folded in above.
2. Spawn child task files (1→{2,3}→4→5→6), each with its own Gate 3 failing tests first.
3. Implementation per child; umbrella journal tracks cross-child state; each child merge gets an independent adversarial review with runnable probes.

## Decisions & surprises

- Tension identified at Gate 1: vision #2 says "API calls to LLMs … directly from the app code (the single HTML file)", which conflicts with hard constraints C1/C2 (iframe `connect-src` blocked; credentials never in iframe). Resolution decided at interview — see below.

## Session journal (append-only, newest last)

### 2026-08-03 14:05 — Jeetu/Claude — session
- Done: task file created from vision; docs (PROCESS, architecture, code-map, lessons, ADR-0003, product-vision, next-steps) read; v1 baseline confirmed (memory: snug-v1-hub-built).
- State: Gate 1 in progress — interview pending.
- Next step: batched interview questions → record answers → Gate 2 plan → STOP for approval.
- Open questions: LLM-call path vs C2; single-DB namespace shape; child-task split; SSO implementation choice.

### 2026-08-03 14:35 — Jeetu/Claude — session
- Done: interview answered (host-page bridge · one namespaced file · all four slices · direct Google OIDC); branch `feat/TASK-20260803-portable-hub` created; ADRs 0007–0009 drafted (proposed) + index updated; two fresh-context explorers mapped packages + apps (findings folded into Current-state map); full Gate 2 plan written (6 children, test plan per AC, spec-sync statement, risks). Status → planned.
- State: **Gate 2 complete, awaiting owner plan approval.** No implementation code written.
- Next step: owner approves plan → fresh-context AI plan review (High tier) → spawn child 1 (`userdb` core) with failing tests first.
- Open questions: none blocking; retention default (5) and single-tab-writer UX are confirmable at child-task level.

### 2026-08-03 15:20 — Jeetu/Claude — review + session
- Done: owner approved plan ("go ahead"). Fresh-context adversarial review completed (4 blockers / 8 majors / 7 minors, F1–F19); all findings folded — sync/secrets state machine redesigned (pull-merge, out-of-image push-state, fail-closed corruption recovery), subscription mode made client-authoritative, offline claim re-scoped honestly (+ static hosting added to child 5, vendored-runtime queued), spec source moved to `packages/protocol/src/userdb-schema.ts`, children resequenced 1→{2,3}→4→5→6. ADRs 0007/0008/0009 amended in place (still proposed-drafts of this task). ACs 2/4/10 amended; ACs 11–14 added.
- State: plan amended per review; spawning child task files next.
- Next step: child task files → child 1 Gate 3 failing tests.
- Open questions: owner may override two judgment calls made autonomously: (a) client-authoritative subscription mode, (b) offline re-scope + static hosting now / vendored-runtime later.

### 2026-08-03 17:10 — Jeetu/Claude — session (implementation complete)
- Done: all six children implemented and committed on this branch — child 1 `7dde1e8` (userdb core, 34 tests), child 2 `04a1299` (serverless run + picker), child 4 `520866a` (sync module, 44 tests, delegated agent), child 5 `15bc195` (server OIDC/CSRF//userdb/static, 54 new tests, delegated agent), child 3 `fb0a22e` (sink pinning + chat persistence + versions UI), integration `c44b144` (auth/sync UI, **CSRF header fork between the two agents caught and unified to `x-snug-csrf`**, makeAdapter wiring), durability `ab88f97` (A/B-slot OPFS persistence — real-browser e2e falsified in-place writes, renames, AND directory iteration under teardown; three data-loss bugs fixed), child 6 `9b1e3e2` (spec v0.2 draft staging + changelog + docs).
- Verification: full root suite 19/19 tasks green (protocol 80 · db 114 · adapters 60 · knowledge 55 · sdk 33 · runner 90 · server 89 · playground 51 unit); Playwright 25/25 twice consecutively (C2 gate + both AC2 serverless gates).
- State: fresh-context adversarial review of the merged umbrella running (runnable probes, C1/C2/secrets/sync/persistence surfaces); findings to be folded before this branch goes to PR.
- Next step: fold review findings → owner review of branch + PR → merge → move task files to done/ (spec push, npm, deploy all still require explicit asks).
- Known limitations (documented, deliberate): true network-offline runtime queued (CDN allowlist); chat artifact cards not persisted (text history is); Dropbox UI is paste-a-token (PKCE helpers shipped for the full flow); multi-device merge = divergence + explicit LWW.

### 2026-08-03 18:00 — Jeetu/Claude — adversarial review folded (Gate 5 complete)
- Review verdict was NOT-READY with 1 blocker + 3 majors + 3 minors — all fixed in `cf98f71`:
  - **Blocker (sidecar dead on OPFS)**: the JSON sidecar failed the A/B-slot completeness check (SQLite-magic only) → every session saw a `{}` sidecar → false divergence on every login, hash gate dead, auto pull-merge unreachable. Fixed with a `SNUGSYNC1` envelope magic the backend recognizes; regression test now runs the loop against the PRODUCTION OPFS path (`sync/__tests__/opfs-sidecar.test.ts`) — the review's core point was that all sync tests used the memory backend.
  - **Majors**: F15 guard added to `createDirectBuilder` (was app-transport only — an imported DB could route builder prompts to an attacker `localUrl`); auto pull-merge now arms F15 + rehydrates stores (`afterForeignBytes`, also fixes the store/DB split-brain after import); corrupt-state UI gained the recovery exit ("start fresh, quarantine kept" → restore via origin divergence or import).
  - **Minors**: per-IP rate limiting on `/userdb` + `/auth/*`; unique quarantine filenames; artifact-sink install latch (concurrent unpinned writes can't double-install).
- Surfaces that HELD under probes: secret VACUUM strip (bytes-level), A/B-slot crash windows, version pruning/revert, client C1 (no secret in any frame), server CSRF/CORS/session hardening, fail-closed config.
- Verification after fixes: root suite 19/19 tasks green (db 116); Playwright 25/25.
- State: ready for owner review. Branch is local-only — nothing pushed; PR/merge, spec push, npm, deploy all await explicit asks.

### 2026-08-03 18:20 — Jeetu/Claude — close-session (Gate 6)
- Done: ADRs 0007–0009 flipped to accepted (plan approved + implemented); decisions index cleaned; all Gate 6 artifacts verified in-branch — 3 lessons (`docs/lessons.md` 2026-08-03 entries), docs drift fixed (architecture, code-map, product-vision, glossary, next-steps dated), spec-changelog entry for the protocol change (`userdb-schema.ts`) with the spec-sync plan (draft staged in `docs/spec-drafts/spec-v0.2-userdb.md`; push to `snugprotocol/spec` awaits explicit ask), auto-memory updated (`snug-portable-hub-built`).
- State: implementation + both adversarial reviews complete; every suite green (root 19/19 tasks; Playwright 25/25). Branch `feat/TASK-20260803-portable-hub`, 15 commits ahead of local `main`, working tree clean after this commit. Task files stay in `active/` until merged (PROCESS: done/ only after merge).
- Next step (single): owner reviews the branch (start here, then the diff) → says "open the PR" → merge → move the seven task files to `done/`.
- Open questions: none for the implementation. Awaiting owner decisions only: PR/merge; spec v0.2 push; whether to prioritize the queued vendored-runtime offline work next.
