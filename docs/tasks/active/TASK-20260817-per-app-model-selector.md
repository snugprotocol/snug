# TASK-20260817-per-app-model-selector: per-app model selector in the app header

- **Status**: in-review (Gates 3–5 done — implemented, green, owner-walked in a real browser; awaiting review + merge)
- **Owner**: Jeetu
- **Risk tier**: medium (see [engineering/PROCESS.md](../engineering/PROCESS.md#risk-tiers)) — **explicitly NOT escalated to High**; see "Why this is not High" below
- **Branch**: `feat/TASK-20260817-per-app-model-selector`
- **Packages touched**: `packages/adapters` (new pinned catalog module), `apps/playground` (selector UI + resolution + state), `packages/db` (cascade-delete extension). **NOT** `packages/protocol`, **NOT** `packages/runner`, **NOT** `packages/auth`.
- **Spec impact**: none — no `packages/protocol` schema bytes change, no `USERDB_SCHEMA_VERSION` bump, no wire-protocol change. No [SPEC_SYNC.md](../engineering/SPEC_SYNC.md) step, no `spec-changelog.md` entry.
- **Related**: ADR-0007 (single portable user DB) · ADR-0012 (prompt-caching scope — the builder-lane hazard below) · ADR-0015 (webllm brain OVERRIDE) · ADR-0018 (runtime contract — deliberately NOT the storage site) · next-steps "WebLLM 1.2-GA queue: model picker" (adjacent, not this) · draft ADR-0036 (below)

## Spec (what & why)

Today the LLM model is ONE global setting: `snug_settings.model`, read from `modelStore` and applied identically to every app, every lane (`state/mode.ts:107`, `agent/transport.ts:238`, `agent/inferrerAdapter.ts:105`, `agent/useBuilderChat.ts:378-385`). Apps differ in what they need — a data-heavy analysis app wants a frontier model, a small utility app wants a cheap fast one — and the user has no way to say so without changing the global default and remembering to change it back.

This task adds a **model selector to each opened app's own header**, beside `🔌 connections` and `export .sqlite` (`run/RunView.tsx:705-773`) — the same place the owner already chose for per-app doors. It offers up to 5 **pinned popular models** for the active provider, plus the inherited default. A pick is **persisted in the user DB** keyed to that app, so it survives reload, a new session, sync and export. All app-scoped LLM calls for that app route to the picked model.

**Owner decisions taken at Gate 1** (interview 2026-08-17):
1. Routing scope: **all four app-scoped lanes** — app-frame turns, app-attached chat, the builder lane, and connection inference.
2. Catalog: a **hardcoded, reviewed per-provider catalog in `packages/adapters`**, beside the existing `ANTHROPIC_DEFAULT_MODEL`/`OPENAI_DEFAULT_MODEL`. No live `/models` fetch.
3. Unset state: the selector shows **the Settings default, labelled as inherited**. An app that has never been picked-for FOLLOWS a later change to the Settings default. Only an explicit pick pins it.
4. Modes: **shown for byok (anthropic/openai), local and subscription; hidden for mock, webllm and demo.**

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — the control exists where the owner asked.** An opened, installed app whose mode/provider supports it renders a model selector in the run header (`data-testid="app-model-select"`), in the same action cluster as `manage-connections` and export. Asserted by rendered element and cluster membership, not by CSS text.
2. **AC2 — the catalog is per-provider, ≤5, and pinned.** `popularModelsFor('anthropic')` and `popularModelsFor('openai')` each return between 1 and 5 entries; every entry's id is a non-empty string; each provider's list CONTAINS that provider's `*_DEFAULT_MODEL`. A structural test pins the ≤5 bound so a sixth cannot be added silently.
3. **AC3 — unset means inherited, and inheritance is live.** With no per-app pick stored, the selector's effective value equals the Settings default (or the provider default when Settings is empty), and is rendered as inherited (a distinct option/label, not a silent copy). Changing the Settings default and re-reading the app yields the NEW default. Mutation-check: breaking the inheritance read must red this test.
4. **AC4 — a pick persists across a reload and a fresh session.** Selecting a model writes to the user DB; a fresh `hydrate` over the SAME DB bytes (new stores, simulating reload) resolves that app to the picked model. Asserted against the DB and the re-hydrated resolution, never against component state.
5. **AC5 — a pick is per-app, not global.** Picking for app A leaves app B and the Settings default untouched; A and B resolve to different models in the same session.
6. **AC6 — every in-scope lane routes to the resolved model.** Four tests, one per lane, each asserting the model that reaches `createTurnAdapter`/the `/invoke` body for an app with a pick: (a) app-frame turn via `resolveAppTransport`, (b) app-attached chat via `useBuilderChat` with an attached app, (c) the builder lane for that app, (d) the connection inferrer for that app. Each asserts the value AT THE ADAPTER SEAM (the altitude where the decision lands), and each must fail if the per-app resolution is reverted.
7. **AC7 — the brain override still wins.** With `?webllm=1` (brain `webllm`) or the demo fallback, the per-app pick is IGNORED and no selector renders (ADR-0015: the brain overrides the configured mode entirely). Same for `provider === 'mock'`.
8. **AC8 — subscription mode carries the pick to the server.** In subscription mode the resolved per-app model is sent as the `/invoke` body `model` field, which the server already accepts and swaps per request (`routes/invoke.ts:96-98`).
9. **AC9 — deleting the app deletes its pick.** `deleteApp(appId)` removes the stored per-app model row in the same transaction as the rest of the cascade; no orphan key survives. Mutation-check by reverting the cascade line.
10. **AC10 — local mode offers the detected Ollama models.** In local mode the selector lists the probe-detected models (`state/ollama.ts`) rather than the frontier catalog, reusing the Settings precedent; when the probe found none it falls back to inherited-only and says so.
11. **AC11 — an unknown/stale stored model does not break the app.** A stored pick naming a model absent from the current provider's catalog (provider switched, catalog pruned) still resolves and is still SHOWN — never silently dropped and never crashing the header.

**Out of scope** (deliberate, each with a reason):
- **No live `/models` fetch** — owner decision 2; costs a keyed network call and has no Anthropic equivalent in browser mode.
- **No free-text "other…" escape on this control** — owner chose the pinned catalog; Settings keeps the free-text field for arbitrary ids, and AC11 keeps an already-stored arbitrary id working.
- **No new provider** — the 5-place provider fan-out (`mode.ts`, `SettingsView.tsx`, `adapter.ts`, server `config.ts`, server `adapter.ts`) is untouched.
- **No `RuntimeContract` field.** The explorer pass suggested one; it is REFUSED. The model is a host-side user preference, not app-declared config — putting it in the contract would make it version-linked (reverting an app version would revert the user's model choice), would ride the `packages/protocol` schema (High tier + spec-sync), and would export/import as app content. Storage stays host-side. Recorded as ADR-0036 D1.
- **No global-default UI change** — `SettingsView`'s model field stays exactly as it is.
- **No per-lane model choice** — one model per app across all four lanes; a per-lane matrix is a bigger product decision.
- **Prompt-cache tuning for the builder lane** is not re-derived (see Risks).

## Why this is not High tier

PROCESS.md auto-escalates on `packages/protocol` schemas, `packages/runner` sandbox/CSP, `packages/auth`, C1/C2, publish/CI config. This task touches none of them:
- Storage is a namespaced key in the existing free-form `snug_settings` KV (`db.setSetting`/`getSetting` → `kvSet`/`kvGet`, `packages/db/src/userdb/userdb.ts:1287-1294`, `:2731-2732`). **No new column, no new table, no `USERDB_SCHEMA_VERSION` bump, no migration** — `snug_settings` is already `(key TEXT PRIMARY KEY, value TEXT NOT NULL)` and already holds hub-level keys.
- No credential, host, ceiling, frame, iframe or CSP surface is read or written. The model id never leaves the host page except as the `model` field the adapters and `/invoke` already send.
- `packages/db` is a widely-depended package → PROCESS.md floors it at **Medium**, which is where this lands. `packages/adapters` gains a new leaf module only.

If review disagrees and wants the pick on `snug_apps` as a typed column instead, that IS a v7 migration and a High-tier task — flagged now rather than discovered mid-implementation.

## Plan

### Storage decision (ADR-0036 D2)

Key shape: **`appModel:<appId>` in `snug_settings`**, value = the model id string.

Considered and rejected: (a) a new `snug_apps.model` column — needs `USERDB_SCHEMA_VERSION` 7 + `addColumnIfMissing` migration + spec-changelog, i.e. High tier, for one nullable string; (b) a new `snug_app_*` table — same cost, more of it; (c) localStorage — the owner explicitly asked for DB persistence "so it remembers across session too", and localStorage does not sync, export or travel with the portable file (it is where `theme`/rail prefs live BECAUSE those are deliberately global workspace prefs, `state/railLayout.ts:6-8`).

The cost of the KV choice is that `snug_settings` is not app-keyed, so the cascade must be taught — hence AC9. There is an exact precedent to copy: `deleteApp` step 3b already prefix-deletes the app's `snug_secrets` slice with LIKE + ESCAPE (`userdb.ts:1994-1996`), including its documented colon-in-appId caveat. The new delete is an equality match on one key, so it does not even inherit that caveat.

### Files to touch, in order

**Phase 0 — tests first ([TDD.md](../engineering/TDD.md)), all red before any implementation.**

1. `packages/adapters/src/__tests__/model-catalog.test.ts` — AC2.
2. `packages/db/src/__tests__/userdb.appModel.test.ts` (or extend the existing cascade suite) — AC4 (DB round-trip), AC9 (cascade).
3. `apps/playground/src/__tests__/appModel.test.ts` — AC3, AC5, AC11 (resolution unit tests).
4. `apps/playground/src/__tests__/appModelRouting.test.ts` — AC6 a–d, AC7, AC8 (four lanes at the adapter seam).
5. `apps/playground/src/__tests__/appModelSelector.test.tsx` — AC1, AC10, and the AC7 no-render case.

**Phase 1 — the catalog (`packages/adapters`).**

6. `packages/adapters/src/model-catalog.ts` (new leaf) — `PopularModel { id, label }`, `POPULAR_MODELS: Record<'anthropic'|'openai', readonly PopularModel[]>` (≤5 each), `popularModelsFor(provider)`. Ids are pinned literals; each list contains its provider's existing default constant so the two cannot drift.
7. `packages/adapters/src/index.ts` — export the above beside the existing `ANTHROPIC_DEFAULT_MODEL`/`OPENAI_DEFAULT_MODEL` exports (lines 20, 22).

**Phase 2 — persistence + resolution (`packages/db`, `apps/playground`).**

8. `packages/db/src/userdb/userdb.ts` — extend `deleteApp`'s transaction (the step-3 block, `:1971-1997`) with the `appModel:<appId>` settings delete, placed with the other app-keyed deletes and BEFORE the app row itself.
9. `apps/playground/src/state/appModel.ts` (new) — the per-app model store + accessors:
   - `appModelStore: Store<Record<string, string>>` hydrated from the DB alongside the other settings;
   - `hydrateAppModels(db)` — reads the `appModel:` slice; called from `hydrateSettings`'s caller so import/pull re-hydration is covered;
   - `setAppModel(appId, modelId | undefined)` — store + `db.setSetting`; `undefined` clears back to inherited;
   - **`resolveModelForApp(appId?)`** — THE single resolution function: per-app pick → else `modelStore.get()` → else `undefined` (adapters apply their own default). This is the one place the precedence rule lives.
   - `useAppModel(appId)` hook for the UI.
10. `apps/playground/src/state/mode.ts` — call `hydrateAppModels` from `hydrateSettings`/`initSettings` so a reload, an import and a first sync pull all rehydrate the picks (F15 note: a model id is not executable config in the endpoint sense, so it does NOT need to join the `needsEndpointConfirm` gate — recorded as ADR-0036 D3).

**Phase 3 — routing the four lanes.** Each currently reads `modelStore.get()` or `useModel()`; each becomes `resolveModelForApp(<its appId>)`. The codebase rule that these are read **per send, never captured at construction** (`transport.ts:119-126`) is preserved in every case.

11. `apps/playground/src/agent/transport.ts:238` — `const model = resolveModelForApp(appId)`. `appId` is already a parameter of `resolveAppTransport` (`:211-216`), so this lane is a one-line change and it also fixes subscription mode (`createServerAppTransport(model, appId)`, `:239`) → AC6a, AC8.
12. `apps/playground/src/agent/useBuilderChat.ts:374-386` — the agent memo uses the attached app's model. `attachedAppId` already exists at `:341`; add it to the memo deps so a newly-attached app re-resolves → AC6b, AC6c. **Both the app-attached chat and the builder lane run through this memo**, which is why owner decision 1's (b) and (c) land together here.
13. `apps/playground/src/agent/inferrerAdapter.ts:105` — `liveInferenceAdapter` reads `modelStore.get()` and has **no `appId` in scope**. Thread the app id from its caller (`agent/connectionInferrerAdapter.ts` / `connectionPipeline.ts`) as an optional argument, defaulting to the global when absent → AC6d. **If threading it proves to reach further than the connection pipeline, this lane is dropped to a follow-up and the task file says so** — the other three lanes are the owner's core ask and do not depend on it.

**Phase 4 — the control (`apps/playground`).**

14. `apps/playground/src/run/ModelSelect.tsx` (new) — a small component owning the visibility rule, the option list and the write. Visibility: hidden when `brain.kind !== 'settings'` (webllm/demo), hidden when `mode === 'byok' && provider === 'mock'`; options from `popularModelsFor(provider)` in byok, from `ollamaStore` detected models in local, from the byok provider's catalog in subscription. First option is always the inherited default, labelled as such (AC3). Plain `<select>` — the codebase has no Select primitive and both existing dropdowns are plain (`SettingsView.tsx:206`, `RunView.tsx:562`).
15. `apps/playground/src/run/RunView.tsx` — mount it in the action cluster (`:705`), between `manage-connections` and `export .sqlite`. Starters (`isStarterId(id)`) are excluded on the same reasoning the connections button uses: a read-only, un-owned starter has no app row to key a pick to.
16. `apps/playground/src/theme/app.css` — reuse `.thread-picker select`'s rules (`:1350-1359`) for the header select; add a narrow-width rule in the existing mobile block (`:1312-1330`) so the cluster does not overflow — `lessons.md` (2026-08-14) requires a REAL-BROWSER measurement for any geometry claim, so this is verified in Playwright, not jsdom.

**Phase 5 — docs (Gate 6, in-branch).** `docs/decisions/0036-per-app-model-selection.md` (drafted at Gate 2, decisions D1–D3 above) · `docs/code-map.md` rows for the new modules · `docs/architecture.md` one line if the reviewer judges the seam architectural · `docs/lessons.md` if the work earns a rule · `docs/next-steps.md` pruned/appended.

### Cross-package impact (dependency graph, [architecture.md](../architecture.md))

- `adapters` ← `server`, `playground` → changing `adapters` runs **`adapters` + `server` + `playground`**. The change is additive (a new exported leaf module), so `server` should be unaffected — that is a claim to VERIFY by running it, not a scope note (`lessons.md` 2026-08-12).
- `db` ← `sdk`, `playground` → changing `db` runs **`db` + `sdk` + `playground`**.
- `desktop` consumes the playground SOURCE and all seven packages → **`pnpm --filter desktop test` also runs.** No shell-level change, so `test:rust` and the `gate` script are not required by this diff (the macOS gate is unaffected; the Windows leg stays deliberately red per ADR-0021 D8 and this task must not be read as touching it).
- `protocol`, `runner`, `auth`, `knowledge` — untouched.
- **Verification bar:** `turbo run test --force` from the REPO ROOT showing `Cached: 0 cached` (`lessons.md` 2026-08-13/08-10/08-11), plus the playground Playwright suite for the header geometry. Note the standing ~1-in-5 playground vitest flake (next-steps 2026-08-14): a red must be classified, never waved through.

### Test plan (tests FIRST)

| AC | Test | Altitude | Mutation to prove it fails |
|---|---|---|---|
| 1 | `appModelSelector.test.tsx` | rendered header | remove the mount from RunView |
| 2 | `model-catalog.test.ts` | pure module | add a 6th entry / empty a list |
| 3 | `appModel.test.ts` | `resolveModelForApp` | make unset return the provider default instead of Settings' |
| 4 | `userdb.appModel.test.ts` + re-hydrate | DB bytes | drop the `setSetting` write |
| 5 | `appModel.test.ts` | resolution | key the store globally instead of per app |
| 6 a–d | `appModelRouting.test.ts` | the `createTurnAdapter` / `/invoke` body seam | revert each lane's read to `modelStore.get()` — each must red INDEPENDENTLY |
| 7 | routing + selector tests | brain override | let the pick through under `webllm` |
| 8 | `appModelRouting.test.ts` | `/invoke` request body | drop the model from `createServerAppTransport` |
| 9 | `userdb.appModel.test.ts` | DB after `deleteApp` | remove the cascade line |
| 10 | `appModelSelector.test.tsx` | rendered options | feed the frontier catalog in local mode |
| 11 | `appModel.test.ts` + selector | resolution + render | drop unknown ids on read |

Per `lessons.md`: every guard above is mutation-checked by reverting the fix and watching red (2026-08-04); AC6's four lanes are asserted at the seam where the DECISION lands, not where the effect renders (2026-08-05); and AC4 asserts DB STATE, not a return value (2026-08-17).

### Spec-sync impact

**None.** No `packages/protocol` bytes change; `USERDB_SCHEMA_VERSION` stays 6; wire protocol stays v1. No `docs/spec-changelog.md` entry is owed. This is asserted, not assumed — a test in `packages/protocol` already pins the schema version, and the diff must show zero protocol files.

## Risks & open questions (for approval)

1. **Builder-lane prompt caching (ADR-0012).** Caching rides the stable tools+system prefix of BUILDER turns. Switching models per app changes the cache key domain, so an app on a non-default model gets its own cache lineage — correct, but it means cache-hit % will look worse right after a switch. No code change is planned for this; naming it so the observability reading is not misread as a regression.
2. **A weak model on the builder lane can build worse apps.** Owner chose to include the builder lane. The mitigation is honesty, not restriction: the selector is on the app's own header where the user sees which model authored the current edit. If the owner wants the builder lane pinned to the default instead, that is a one-line scope cut in step 12 — say so at approval.
3. **The inferrer lane (step 13) may not have a clean `appId` path.** Pre-committed fallback: drop it to a follow-up rather than thread an id through unrelated layers. Flagged before implementation rather than discovered mid-diff.
4. **Catalog staleness.** Hardcoded ids go stale as providers ship models. Accepted: the list is small, reviewed, and one edit; Settings' free-text field remains the escape hatch for anything not listed, and AC11 keeps such an id working.
5. **Sync/export.** The pick rides `snug_settings`, so it syncs and exports with the file like `mode`/`provider`/`model` do today. That is consistent with the existing model setting; no secret is involved. Confirm at review that this is the intended portability.

## Decisions & surprises

- **D1 (2026-08-17)** — the per-app model does NOT go on `RuntimeContract` (rejects the explorer pass's suggestion): it is a host-side user preference, not app-declared config, and putting it there would version-link it, escalate to High tier via `packages/protocol`, and export it as app content.
- **D2 (2026-08-17)** — storage is `snug_settings['appModel:<appId>']`, not a `snug_apps` column: no schema bump, no migration, no spec-sync; the price is teaching `deleteApp`'s cascade (AC9), which has an exact precedent at step 3b.
- **D3 (2026-08-17)** — a model id does NOT join the F15 `needsEndpointConfirm` gate. That gate exists for executable ENDPOINT config arriving via import (`mode.ts:15-16`); a model id names a model at an endpoint the user already confirmed. To revisit if review disagrees.
- **Surprise** — both the app-attached chat lane and the builder lane resolve through ONE `useMemo` (`useBuilderChat.ts:374-386`), so owner-decision items (b) and (c) are a single change, not two.

## Session journal (append-only, newest last)

### 2026-08-17 — Jeetu — session (Gates 1–2)
- Done: read PROCESS/architecture/code-map/lessons/next-steps + the actual code across all four LLM lanes; two parallel explorer passes mapped the provider/model config path and the run-header chrome; owner interview settled routing scope, catalog source, unset-state semantics and mode gating; wrote spec + plan + test plan into this file; drafted ADR-0036 decisions D1–D3.
- State: **Gate 2, awaiting owner approval. No implementation code written. Branch not yet created.**
- Next step: on approval — create `feat/TASK-20260817-per-app-model-selector` off `main`, then Phase 0 (all tests red) before any implementation.
- Open questions: the five Risks above, chiefly (2) whether the builder lane stays in scope and (3) the inferrer-lane fallback.

### 2026-08-18 — Jeetu — session (Gate 3, tests first)
- Done: **plan approved by the owner** (all four lanes stay in scope, including the builder lane). Branch `feat/TASK-20260817-per-app-model-selector` created off `main` (clean tree at `219aa49`). Wrote all five test files, verified each is RED for the right reason (missing module, not a fixture error):
  - `packages/adapters/src/__tests__/model-catalog.test.ts` — AC2. 5 failing: `popularModelsFor is not a function`.
  - `packages/db/src/userdb/__tests__/app-model-setting.test.ts` — AC4 (storage), AC5 (storage altitude), AC9. **3 pass / 2 fail, and that split is the evidence**: the KV round-trip already works (which is exactly why D2 chose it — no migration), and precisely the two cascade tests fail because `deleteApp` does not yet know the `appModel:<appId>` key. The AC9 mutation check is therefore already demonstrated ahead of the fix.
  - `apps/playground/src/__tests__/appModel.test.ts` — AC3, AC4 (hydration), AC5, AC11.
  - `apps/playground/src/__tests__/appModelRouting.test.ts` — AC6a–d, AC7, AC8. Asserts at the **wire** (the `model` field of the request body a recording `fetch` sees), so a lane that resolves correctly but drops the field still reds. Each lane is a separate test, so reverting one lane reds exactly one.
  - `apps/playground/src/__tests__/appModelSelector.test.tsx` — AC1, AC7 (no-render), AC10, AC11. **Renders** via `createRoot`/`act` rather than scanning source, and asserts `resolveModelForApp` after a change event rather than the element's own `value` (per `lessons.md` 2026-08-17: an onChange that updates local state and writes nothing would pass a value assertion).
- State: Gate 3 complete. No implementation code written yet — `state/appModel.ts`, `run/ModelSelect.tsx`, `packages/adapters/src/model-catalog.ts` do not exist.
- Next step: Gate 4 Phase 1 — the catalog module, then persistence/resolution, then the four lanes, then the control.
- Open questions: unchanged — Risk 3 (the inferrer lane's `appId` path) is now written as a test (`AC6d`) that will confirm or refute the threading cost during implementation.

### 2026-08-18 — Jeetu — session (Gates 4–5, implement + verify)
- Done: **all 11 acceptance criteria implemented and green.**
  - `packages/adapters/src/model-catalog.ts` — pinned ≤5 catalog per provider, each containing that provider's `*_DEFAULT_MODEL`.
  - `packages/db/src/userdb/app-settings-keys.ts` — the ONE definition of `appModel:<appId>` (the `auth-secrets.ts` precedent); typed `listAppModels`/`setAppModel` accessors so no caller hand-rolls a prefix scan over the shared `snug_settings` namespace; `deleteApp` step 3c cascades by EQUALITY.
  - `apps/playground/src/state/appModel.ts` — THE precedence rule; hydration wired into `hydrateSettings` so boot/import/first-pull all restore picks.
  - Four lanes repointed: `transport.ts` (app frame + subscription), `builder.ts` + `useBuilderChat.ts` (builder AND app-attached chat — one memo), `inferrerAdapter.ts` (+ its two app-scoped call sites).
  - `apps/playground/src/run/ModelSelect.tsx`, mounted in the run header between `manage-connections` and export; CSS + a real `.visually-hidden` rule (the class did not exist — referencing it without adding it would have been a no-op label).
- **Verification — every guard mutation-checked** (revert the fix, watch red, restore): the ≤5 bound (2 red), the default-in-catalog pin (1 red), the `deleteApp` cascade (2 red), and each routing lane INDEPENDENTLY — transport 4 red, builder 1 red, inferrer 1 red. No lane hides behind another.
- **Verification — four consecutive `turbo run test --force` root runs**, 23/23 tasks, `Cached: 0 cached` each time (2 further targeted runs before that). Playground 1184 · db 311 · adapters · server 126 · sdk 41 · auth · protocol · knowledge · runner · desktop · whatsapp-sidecar all green. The standing ~1-in-5 playground flake did not surface in any of the six runs.
- **Verification — the real-browser walk** (`lessons.md` 2026-08-17: a feature is done when someone walks it). Installed two starters as real apps in one session and:
  - the selector renders in the run header, labelled "model for this app", 44 px tall, inside the header bounds, with no horizontal page scroll — measured with `getBoundingClientRect` at 1280 px AND at a real 420 px viewport (jsdom rects are 0×0 and would have proved nothing);
  - it is correctly ABSENT on a read-only starter and for the `mock` provider;
  - **a pick survived a full page reload** against real OPFS-backed SQLite;
  - **AC3's live inheritance, both directions**: changing the Settings default moved the un-pinned app to `default (claude-sonnet-4-6)` while the pinned app HELD `claude-opus-5` and offered the new default as the way back;
  - **end-to-end on the wire**: a real chess move produced a real app-frame turn whose outbound Anthropic request carried `claude-opus-5` (the pin), while the un-pinned app's turn carried `claude-sonnet-4-6` (the default). Two apps, one session, each routing to its own model.
- Docs: ADR-0036 written (D1 rejects the `RuntimeContract` home, D2 the storage choice + its cascade obligation, D3 the F15 exemption); `code-map.md` row added; `next-steps.md` records the inferrer residual and disambiguates the still-open WebLLM picker.
- State: **Gate 5 done.** Two commits on `feat/TASK-20260817-per-app-model-selector` (tests, then implementation) plus this docs commit.
- Next step: AI review of the diff + task file, then human review and PR.
- Open questions: none blocking. Risk 3 RESOLVED as scoped — two of three inferrer call sites had an app id and were wired; the connection-requirement inferrer genuinely has none and is queued rather than forced.

### 2026-08-18 — Jeetu — session (follow-on: header icon buttons + control swap)
- Ask: replace the connections and `export .sqlite` buttons with icon buttons carrying tooltips, and swap the model selector ahead of the connections button.
- Done:
  - Extracted the per-app cluster into `run/RunHeaderActions.tsx` so it is testable without a route, a runner and an iframe (RunView keeps theme + rail — those are WORKSPACE preferences, not properties of this app).
  - Both controls became icon buttons: `⚯` connections, `⤓` export, each with an `aria-label` (the accessible name) AND a `title` (the tooltip). Order is now model select → connections → export.
  - New `.btn-icon` rule trims the text-label padding and sizes the glyph; `.btn` already carried `min-width: var(--tap)`, so the square tap target is inherited rather than re-specified.
- **The trap this avoided, and why the `aria-label` is load-bearing:** a glyph is not an accessible name. `e2e/starters.spec.ts` locates the export control **twice** by `getByRole('button', { name: 'export .sqlite' })`. Dropping the words to a bare icon would have broken both specs in a lane CI does not yet run — surfacing much later as a mystery. `aria-label="export .sqlite"` is kept verbatim and pinned by test; a mutation removing it reds 2 tests.
- **Glyph choice corrected after seeing it rendered.** The first pass used `🔌`, which came out as a faint monochrome outline that ignored `currentColor` — it read as *disabled* beside its neighbours and would not restyle with the theme. Switched to `⚯`, matching the rail tabs' existing vocabulary (`✎ ◍ ✧ ⧉`). Only the browser showed this; both versions passed every test.
- **Migrated, not deleted, the pre-existing ordering test.** `connectionSurfaces.test.tsx` asserted `manage < 'export .sqlite' < theme` as source-string indices inside `RunView.tsx` — a claim the swap and the extraction both invalidate. Rather than drop it, the same claim is re-asserted across the two files, the two gates it covered are re-pointed with both halves asserted (so neither can vanish silently), and the rendered document order is pinned in `runHeaderIcons.test.tsx` by measuring nodes with `compareDocumentPosition` instead of string positions.
- Verified: `runHeaderIcons.test.tsx` (11, rendered DOM) + migrated `connectionSurfaces` (24 total) · playground 1196 · **`turbo run test --force` 23/23, `Cached: 0 cached`** · mutation checks on the accessible name (2 red) and the swap (1 red) · real browser — live DOM order `app-model-select → manage-connections → export-sqlite`, both icons exactly 44×44 (tap-target minimum) at 1280 px AND 420 px with no horizontal scroll, tooltips present, and the connections icon opens the wizard ("approve this connection").

### 2026-08-18 — Jeetu — close-session (Gate 6)
- Done: journal current (this entry). **Lessons distilled into `docs/lessons.md`** — five rules across three sections: the emoji/`currentColor` finding (only a screenshot could catch it), the icon-replaces-label locator hazard, migrate-the-claim-never-delete-the-test on a component extraction, the shared-KV-namespace cascade obligation, and inheritance-as-absence. **Docs drift closed in-branch**: `architecture.md` gains a "Per-app model selection" section plus a status-line mention; `glossary.md` gains *per-app model* and *effective model*; `code-map.md` rows for both the feature and the header-icon cluster; `next-steps.md` carries the inferrer residual and disambiguates the still-open WebLLM picker. **ADR-0036 written** (D1 rejects the `RuntimeContract` home, D2 the storage choice + its cascade obligation, D3 the F15 exemption).
- **Spec impact: NONE, verified rather than assumed.** `git diff --stat main..HEAD -- packages/protocol` is EMPTY, so C3 is satisfied by construction: no spec-changelog entry and no SPEC_SYNC plan is owed. `USERDB_SCHEMA_VERSION` stays 6 and the wire protocol stays v1.
- Root-file sync rule: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md` untouched (diff empty) — all knowledge went to `docs/`.
- Final verification after the doc edits: `turbo run test --force` → **23/23 tasks, `Cached: 0 cached`** (the seventh forced root run of this task; the standing ~1-in-5 playground flake never surfaced).
- State: five commits on `feat/TASK-20260817-per-app-model-selector`. Branch pushed and PR opened; task file moves to `done/` on merge.
- Next step: merge the PR, then delete the branch.
- Open questions: none blocking. Two residuals are RECORDED, not forgotten — the connection-requirement inferrer has no app id (queued in `next-steps.md`), and prompt-cache hit % will dip for an app on a non-default model (expected, stated in ADR-0036 so the observability reading is not misread).
