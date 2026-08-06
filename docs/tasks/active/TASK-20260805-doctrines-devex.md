# TASK-20260805-doctrines-devex: Doctrine ADRs + dev-ex script + two queued cache/host fixes (AL-01)

- **Status**: in-progress
- **Owner**: Jeetu (Claude autonomous run)
- **Risk tier**: medium (`packages/db` + `packages/adapters` — full TDD + AI review)
- **Branch**: `feat/TASK-20260805-doctrines-devex`
- **Packages touched**: `packages/db`, `packages/adapters`, `scripts/` (new), root `package.json`, `docs/decisions`, `docs/code-map.md`, `docs/next-steps.md`
- **Spec impact**: none (no `packages/protocol` change)
- **Related**: TASK-20260805-alpha-umbrella (child AL-01) · roadmap A1 + A15 + A9-part (`internal/07-roadmap.md` §2, §4) · ADR-0013, ADR-0014 (authored here) · ADR-0012 (the `supportsCaching` gate) · next-steps queue entries 2026-08-04 (`importUserDb`/`namespaceByFile`, code-map counts) and 2026-08-05 (`supportsCaching` host match)

## Spec (what & why)

Four deliverables, all queued and owner-approved via the Alpha umbrella (Phase 0):

1. **ADR-0013 — "Hosted hub is static files only (zero-backend doctrine)"** and 2. **ADR-0014 — "Credentials are local-first (custody doctrine)"**: the two standing doctrines from roadmap §2 are owner decisions (2026-08-04/05) that every later Alpha child builds on — they must be recorded as ADRs *before* the auth port starts, so the custody promise and the zero-budget hosting model are citable constraints, not tribal knowledge.
3. **Code-map test-count regen script (A15)**: per-package test counts in `docs/code-map.md` drift every task and get re-baselined by hand (they are stale again right now: the map says db=163, a measured run says 168). A dependency-free script regenerates ONLY the count numbers from a real run.
4. **Two queued bug fixes (TDD)**: (a) `importUserDb` resets only part of the session-cache family that is keyed on the replaced DB handle — the F1-resurrection cache-coherence family; restoring a backup after a `deleteApp` leaves the app bricked by the stale tombstone. (b) `supportsCaching()` matches the Anthropic host with `endsWith('api.anthropic.com')`, which over-matches sibling domains such as `notapi.anthropic.com` — make it exact before any config surface exposes `baseUrl`.

**Acceptance criteria** (each becomes at least one test, except pure docs):
1. ADR-0013 exists in `docs/decisions/`, status accepted, house style, indexed in the README — content: hosted playground is demo/WebLLM/BYOK/local only; no subscription mode, no OIDC, no hub-origin sync on the hosted instance; personal sync via Dropbox/file export; the full server stays first-class OSS for self-hosters. *(doc — no test)*
2. ADR-0014 exists likewise — through all of 1.x every credential lives in `snug_secrets` in the user's own file; the hub has no custody in any hosted mode; the broker (2.0) is convenience, never the default custody model; source systems referenced ONLY by codename (C4/C5 — verified by grep for real names before commit). *(doc — grep check)*
3. `pnpm run update-code-map` rewrites ONLY the test-count numbers in `docs/code-map.md`'s Tests column from a real `pnpm test` run; counts it cannot resolve (Playwright, prose rows) are left byte-identical; running it twice in a row is a no-op (idempotent). Unit tests cover the parse and rewrite functions against fixture snippets and run as part of the script command.
4. **Regression (red first):** install app → write data through `driver.handle` → `exportUserDb` → `deleteApp` → `importUserDb(backup)` → the app serves frames again AND its data is back (`SELECT` returns the pre-delete rows). Fails today: the stale `deletedApps` tombstone refuses every frame for an app the imported file contains.
5. **Guard on the fix's shape:** after importing a file that does NOT contain a deleted app, frames for that app stay refused (the terminal-delete guard survives import for apps genuinely absent from the new world — a blanket `deletedApps.clear()` must fail this).
6. **Regression (red first):** `anthropicAdapter({ baseUrl: 'https://notapi.anthropic.com' })` with `cache: true` sends NO `cache_control`. Fails today (`endsWith` over-match).
7. `https://api.anthropic.com:8443` (non-default port) still caches — the gate is on `URL.hostname` (port-insensitive), and the fix must not tighten that to `URL.host`.

**Out of scope**: everything else in the umbrella (auth port, starters, spec push …); the OpenAI "0% cached" UI inconsistency (separate queue entry); Playwright-count regeneration (the script leaves Playwright numbers alone — they come from a different runner the script does not invoke); the pre-existing `deleteApp`→`installApp`-same-id tombstone behavior WITHOUT an import in between (delete is terminal by doctrine; not touched).

## Plan

Files to touch, in order (tests FIRST per TDD.md):

1. **Docs first (no code risk):** `docs/decisions/0013-hosted-hub-static-zero-backend.md`, `docs/decisions/0014-credentials-local-first.md`, index them in `docs/decisions/README.md`. Content sources: roadmap §2 doctrines 1–2, owner goals §0, ADR-0012 for house style, `internal/03-audit-auth.md` context via codenames only.
2. **Bug 4a (packages/db):** new `packages/db/src/userdb/__tests__/import-cache-coherence.test.ts` — AC4 (red) + AC5, using the existing memory-backend + `locateWasm` harness from `delete-app.test.ts`. Then fix in `userdb.ts` `importUserDb`: reset the WHOLE session-cache family keyed on the old handle — `lastSavedHash.clear()` (already there), `namespaceByFile.clear()`, and drop `deletedApps` tombstones for apps the imported file actually contains (file-is-truth; tombstones for absent apps are kept deliberately — R1 orphan protection for still-running iframes).
3. **Bug 4b (packages/adapters):** extend `packages/adapters/src/__tests__/observability.test.ts` (where the AC12–AC14 caching-gate tests live) — AC6 (red) + AC7. Then fix `anthropic.ts` `supportsCaching`: `hostname === 'api.anthropic.com'`.
4. **A15 script:** `scripts/update-code-map-counts.mjs` (pure functions + CLI main), `scripts/update-code-map-counts.test.mjs` (node:test, dependency-free), root `package.json` script `"update-code-map": "node --test scripts/ && node scripts/update-code-map-counts.mjs"` so the unit tests run on every invocation. Run it once; commit the refreshed counts (db 163→168 at minimum).
5. **Gate 5:** `pnpm build` + root `pnpm test --force` (db → dependents sdk/playground; adapters → server/playground: in doubt, run everything). Mutation-check both bug fixes (stash fix → red → restore → green; record evidence in the journal).
6. **Gate 6 in-branch:** next-steps ✅ the two queued bugs + the A15 chore (dated), code-map refreshed counts, journal entries, commit everything small + task-id-prefixed. **No push, no PR — stop after local commits.**

Cross-package impact: `db` ← `sdk`, `playground`; `adapters` ← `server`, `playground` → full root suite covers all dependents. Spec-sync: not touched.

Test plan summary: AC3 → node:test units (parse + rewrite + idempotence + leave-unknown-alone); AC4/AC5 → new db suite; AC6/AC7 → adapters suite. Red shown before fix for AC4 and AC6 (the two regressions).

## Decisions & surprises

- **The queued `namespaceByFile` staleness is real but latent; the LIVE defect in the same reset is `deletedApps`.** Analysis: `namespaceByFile` values are pure functions of the key (`appDataToken`/`namespaceToFileName` are deterministic and injective), and the driver facade re-notes the namespace on every `handle()` before the materializer can read the map — so a stale *presence* is unobservable through today's public API. The observable member of the cache-coherence family is the `deletedApps` tombstone: `importUserDb` swaps the world (file-is-truth) but keeps session tombstones, so restoring a pre-delete backup leaves the restored app refusing every frame while `listApps()` shows it. The fix resets the whole family in one block; the regression test asserts the user-visible outcome (restore revives), which is the altitude where `importUserDb` makes its decision.
- Tombstones for apps NOT in the imported file are kept on purpose: clearing them would re-open the R1 orphan path (a still-running iframe of a deleted app writing `app_<token>__*` tables + a registry row into the imported file with no `snug_apps` row). AC5 locks this asymmetry.
- Code-map drift found immediately: db says 163, measured 168 — the A15 script's first real run pays for itself.

## Session journal (append-only, newest last)

### 2026-08-05 — Claude (Fable 5) — session (AL-01 start)
- Done: mandatory reads; branch created off main (carrying the pre-existing `docs/next-steps.md` roadmap entries and the untracked umbrella task file, per orchestrator); baseline measured green at 906 vitest tests (+18 examples node:test), turbo-cached run, exit 0; spec/plan written (this file).
- State: plan pre-approved via the umbrella (Phase 0); starting implementation with the ADRs.
- Next step: ADR-0013/0014, then TDD on the two bugs, then the A15 script.
