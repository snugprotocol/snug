# TASK-20260821-ui-polish: rename/version-delete/deep-delete + multi-provider BYOK + settings redesign

- **Status**: planned
- **Owner**: jeetu (via Claude, autonomous session — owner pre-approved run-through 2026-08-21)
- **Risk tier**: **high** (touches `packages/protocol` `sidecar-contract.ts` (internal draft), the whatsapp-sidecar router + desktop Rust route table, credential lifecycle on delete, `packages/db` cascade)
- **Branch**: `feat/ui-polish` (owner explicitly named the branch — deviation from `feat/TASK-<id>` recorded here)
- **Packages touched**: `packages/db`, `packages/protocol` (sidecar-contract, internal draft only), `apps/whatsapp-sidecar`, `apps/desktop` (Rust route table + TS), `apps/playground`, `packages/adapters` (read-only consumers; catalog unchanged)
- **Spec impact**: none — `sidecar-contract.ts` is an internal draft OUT of `schemas/` SOURCES; no `USERDB_SCHEMA_VERSION` bump (new keys ride the existing `snug_settings`/namespaced-key precedent, ADR-0036 D2)
- **Related**: ADR-0036 (per-app model), ADR-0045 (starter versioning / pinned factory versions), ADR-0040 (sidecar identity lifecycle), ADR-0032/0033/0037 (sidecar), lessons 2026-08-18 (namespaced key owes a cascade; inheriting is an absence)

## Spec (what & why)

Six owner-requested improvements in one branch. (1) Installed apps can be renamed to any unique name. (2) Any stored version of an installed app can be deleted EXCEPT pinned factory versions and the currently-running version (owner decision 2026-08-21: ALL pins protected — keeps reset-to-factory and the ADR-0045 starter-update vouch chain intact). (3) Deleting an app removes everything it owns; for Telepath specifically the wipe extends BEYOND the user DB to a full device unlink: the helper's on-disk session keys, thread cache and minted token are erased and the helper stopped, so the phone shows the companion unlinked and a reinstall needs a fresh QR (owner decision 2026-08-21). (4) BYOK settings support BOTH Anthropic and OpenAI keys at once plus the demo brain (no key); each keyed provider gets a default model picked from the pinned catalog filtered to that provider; a default-provider control (auto: Anthropic when both keys exist, user-overridable) feeds every app that has not overridden it; the standalone "model" card is removed. (5) The build page gets the same model selector the app run header has, listing models from every configured provider grouped by provider (owner decision 2026-08-21); picking a model implies its provider per app. (6) The Settings page is completely redesigned — Apple-design-inspired, same theme tokens, responsive — with particular attention to the connections section.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 rename**: an installed app can be renamed from the UI; `snug_apps.display_name` updates; the hub tile and run header show the new name after rename without reload.
2. **AC2 rename-unique**: a rename to a name already used by another installed app (case-insensitive, trimmed) is refused with a visible message and writes nothing; renaming an app to its own name (case change) is allowed.
3. **AC3 version-delete**: `deleteAppVersion(appId, version)` removes exactly that `snug_app_versions` row; the VersionsPanel offers delete on eligible rows and the row disappears.
4. **AC4 version-delete-guards** (negative): deleting a pinned version, the current version, or an unknown version each throws a named error and deletes nothing; the UI renders no delete control for pinned/current rows.
5. **AC5 telepath-unlink**: deleting an app whose connection ceiling holds the sidecar symbolic host triggers, after the DB cascade commits, a helper `session forget` (wizard-class route) + helper stop; the helper's `resetAuthStore` path erases session keys AND `thread-cache.json`; a helper-side test proves the forget route wipes the auth dir and (when linked) attempts a Baileys logout first.
6. **AC6 telepath-unlink-scope** (negative): deleting an app with NO sidecar fact never calls the forget/stop path; the forget route is wizard-class — reachable via `sidecar_wizard_fetch` only, never `sidecar_fetch` (Rust/TS route-table equivalence stays green with the new route classified wizard-only).
7. **AC7 db-cascade unchanged**: existing delete-app cascade suites stay green, PLUS the new per-app `appProvider:<appId>` settings key (introduced by AC9) is swept by `deleteApp` (equality delete, mutation-checked).
8. **AC8 multi-key settings**: keys for anthropic AND openai can be saved side-by-side in the redesigned Settings (already true at the store layer; now true in the UI — both fields visible/editable, each with a per-provider default-model select filtered to that provider's catalog entries).
9. **AC9 default provider**: with no explicit user choice, the resolved default provider is anthropic when an anthropic key exists, else openai when an openai key exists, else the demo brain; an explicit user pick (new `providerChoice` settings row) overrides and persists; every LLM lane for an app with no per-app override routes to the resolved default provider + that provider's default model.
10. **AC10 per-app provider override**: picking a model of the OTHER provider on an app's header stores `appProvider:<appId>` + `appModel:<appId>` and that app's sends route there (adapter + key + model), while other apps keep following the default; clearing back to "default" deletes both rows (absence, not a copy).
11. **AC11 model card removed**: the standalone "model" card is gone; the legacy global `model` settings row is adopted forward into `providerModel:<provider>` on hydrate (idempotent, never deletes the legacy row); local mode keeps a model picker inside the local-endpoint section (Ollama-detection behavior preserved); subscription keeps a default-model control inside its own section.
12. **AC12 build-page selector**: the build page renders the model selector; with a build thread attached to an app it reads/writes that app's pick; with a fresh thread the pick routes the build turns and is applied to the app on install.
13. **AC13 grouped selector**: with both providers keyed, the selector (run header + build page) lists both providers' catalog models in provider-labelled groups; with one key, only that provider's group plus the inherit row; under demo brain it renders nothing (existing behavior).
14. **AC14 settings redesign**: the redesigned page keeps every pinned behavior green (mode segment, F15 import-confirm, protection offer/turn-on/change/off, account, data, connections approve/re-approve/revoke, theme) — existing suites are the regression net; a new render test pins the section structure; the connections rows render provider identity, status and actions in the new layout.

**Out of scope**: provider-side OAuth revocation on delete (unchanged); trash/undo for app or version delete; starter-shelf surfaces; new providers beyond anthropic/openai/mock; changing the pinned model catalog; web-BYOK CORS work; subscription-mode server changes; editing threat-model deltas (no delta bytes change — the forget route is an erase-only wizard-class sibling of `/pair/*`).

## Plan

Order chosen so DB/helper layers land test-first before UI, and the redesign lands last on top of stable behavior.

**Phase A — db: rename guard + version delete + appProvider cascade** (`packages/db`)
- `userdb.ts`: add `deleteAppVersion(appId, version)` — NOT_FOUND on unknown app/version, named refusals `VERSION_PINNED` / `VERSION_CURRENT` (reuse `USERDB_ERROR_CODES` family), plain DELETE + markDirty. No VACUUM (version rows carry no secrets; delete-app already VACUUMs).
- `app-settings-keys.ts`: add `appProviderSettingKey(appId)` (`appProvider:<appId>`) beside `appModel:`; `deleteApp` gains the equality delete (step beside :2258); mutation-check per lesson 2026-08-18.
- Rename: `updateAppMeta` already exists; add a focused `renameApp` path in playground state (uniqueness enforced at the state layer — the DB has no name uniqueness and adding a constraint would need a schema bump; refusal is a UI concern).
- Tests FIRST: `delete-version.test.ts` (AC3/AC4), extend `app-model-setting.test.ts`-style suite for `appProvider` cascade (AC7).

**Phase B — helper: session forget route** (`packages/protocol` sidecar-contract + `apps/whatsapp-sidecar` + `apps/desktop`)
- `sidecar-contract.ts`: add `POST /session/forget` to the wizard-only route class (sibling of `/pair/*`, `/session/*` — already wizard-class, so the Rust/TS route-table equivalence test forces both tables).
- Helper `router.ts`/`baileys-socket.ts`: forget = best-effort `sock.logout()` when linked (unlinks companion on the phone), then `resetAuthStore(authDir)` (already erases every entry incl. `thread-cache.json`), reset in-memory state; never throws; answers `{ok:true}`.
- Desktop: route registered in `sidecar.rs` wizard table; playground calls it through the existing wizard-fetch platform seam, then `sidecar_ctl("stop")` best-effort.
- Playground `state/library.ts` `delete(id)`: BEFORE `db.deleteApp`, read whether any of the app's connection rows carry the sidecar symbolic host (reuse `appHasSidecarFact`/ceiling check from `sidecarIdentity`/net state); AFTER the cascade commits, fire forget+stop fire-and-forget with error surfacing to console only (delete must not fail on a dead helper). Desktop-only via platform capability; web no-ops.
- Tests FIRST: helper router test (forget wipes auth dir; wizard-class refusal from app class), route-table equivalence (updates itself), playground `library` test with a spy sidecar seam (fires for sidecar app, silent for others — AC5/AC6).

**Phase C — provider/model state rework** (`apps/playground/src/state/mode.ts`, `appModel.ts`, new `providerDefaults.ts`)
- New settings rows (all in `snug_settings`, no schema bump): `providerChoice` (explicit default-provider pick; absence = derived), `providerModel:anthropic` / `providerModel:openai` (per-provider default model; absence = adapter default).
- `resolveDefaultProvider()`: explicit choice (if still valid) → anthropic-if-key → openai-if-key → mock. `providerStore` becomes the RESOLVED value, recomputed on key save/delete and choice change — downstream consumers (transport, wizard, inspector) keep reading `providerStore` unchanged.
- `resolveModelForApp(appId)` precedence becomes: app pin → `providerModel:<provider resolved for that app>` → undefined (adapter default). New `resolveProviderForApp(appId)`: `appProvider:<appId>` pin → resolved default. Both read PER SEND (existing contract).
- Legacy adoption on hydrate: if legacy `model` row exists and `providerModel:<resolved provider>` absent → adopt (write new row once; never delete `model` — roaming files opened by an old build still read it). Local/subscription modes keep using `modelStore` (their pickers move INTO their mode sections).
- Transport/routing: `agent/transport.ts` + the four `runAgentTurn` call sites read provider per send via `resolveProviderForApp` (today provider is global). Key lookup stays `byok:<provider>`.
- Tests FIRST: `providerDefaults.test.ts` (AC9 derivation + explicit override + persistence), extend `appModel.test.ts` (AC10 absence-not-copy, cascade), `appModelRouting.test.ts` rows for cross-provider routing (AC10), hydrate-adoption test (AC11).

**Phase D — selectors** (`run/ModelSelect.tsx`, `views/BuilderView.tsx`)
- `ModelSelect`: grouped `<optgroup>` per configured provider (a provider is configured iff its key exists; mock never listed); value encodes provider+model; writes both rows; inherit row labels the resolved default (`default (anthropic · claude-sonnet-5)`); unknown stored ids still shown (existing rule). Local mode keeps Ollama-list behavior (single group).
- Builder: mount the selector in the builder chip row; `appId = chat.attachedAppId`; when absent, a thread-scoped pending pick (in-memory builder store) routes build turns and is written to the new app on install via the artifact sink's install path.
- Tests FIRST: extend `appModelSelector.test.tsx` (AC13 groups), new `builderModelSelect.test.tsx` (AC12: renders, routes fresh-thread turns, transfers on install).

**Phase E — rename + version-delete UI** (`views/HubView.tsx` or `run/RunView.tsx` header, `run/VersionsPanel.tsx`)
- Rename affordance on the run header app name (click-to-edit, Enter/blur commits, Escape cancels) + a rename action on the hub tile; uniqueness check against `useLibrary()` names (trim + case-insensitive), inline refusal copy; writes via `library.rename(id, name)` → `updateAppMeta`.
- VersionsPanel: delete button per eligible row (not pinned, not current), inline confirm matching the existing app-delete pattern; grep e2e/tests for pinned literals before changing any visible text (lesson 2026-08-18).
- Tests FIRST: `appRename.test.tsx` (AC1/AC2), extend `versionsPanelFactory`-family test (AC3/AC4 UI half).

**Phase F — settings redesign** (`views/SettingsView.tsx`, `views/ConnectionSlotsCard.tsx`, `theme/app.css`)
- Rebuild SettingsView as grouped sections (Apple Settings idiom: section label + inset rounded card of rows, clear hierarchy, `--space`/token-driven, no new palette): Brain (mode segment + per-mode content: byok → two provider rows each with key field + default-model select + default-provider control + demo brain row; local → endpoint + Ollama model picker; subscription → default model), Account, Your file (data + protection), Connections, Appearance (theme).
- ConnectionSlotsCard: redesigned rows — provider glyph (themable geometric, NOT emoji — lesson 2026-08-18), name + host line, status pill, actions aligned; responsive stacking below the 760px breakpoint; add a settings-specific responsive rule (grid → single column).
- Keep accessible names/testids that existing suites pin (`desktopSettingsView`, `connectionSettings`, protection suites, `mode.test`); where the removed model card's five `desktopSettingsView` tests die, classify each MIGRATED (into the local-section picker tests) or OBSOLETE (card gone) per the 2026-08-10 rule — never LOST.
- Verification: real-browser pass (dev server + screenshot at ≥3 widths) — lesson 2026-08-20 "run the product before claiming a UI feature works".

**Cross-package impact** (graph): `protocol` change → run everything (root `pnpm test --force`); `db` → `sdk`, `playground`, `desktop`; helper + desktop cargo suites; playground vitest serially if red (classified flake). Gate-5: root forced run + `pnpm --filter desktop test` + cargo + examples.

**Spec-sync**: none (internal-draft surface only). **ADR**: one ADR for the provider-defaults model (supersedes the "global model" half of ADR-0036's precedence, keeps its per-app half) + records the delete-version protection rule and the Telepath deep-delete decision — drafted at Gate 6 entry, numbered against main at that time.

**High-tier requirement**: fresh-context AI plan review BEFORE implementation (dispatched from this session, findings folded below).

## Decisions & surprises

- Owner 2026-08-21 (interview): protect ALL pinned versions + running; full device unlink on Telepath delete; grouped both-provider selector; run straight through after plan (no owner plan-approval stop) — review at `/close-session`.
- Branch name `feat/ui-polish` is an explicit owner instruction overriding the `feat/TASK-<id>` convention.

## Session journal (append-only, newest last)

### 2026-08-21 — Claude (autonomous) — session
- Done: Gates 1–2 — explored settings/BYOK/model + app-lifecycle/delete code (two fresh-context maps), owner interview (4 decisions), task file + plan written, branch cut from clean `main` @ `c8bb448`.
- State: plan awaiting fresh-context AI review (High tier), then TDD phases A→F.
- Next step: dispatch plan review, fold findings, start Phase A tests.
- Open questions: none blocking.
