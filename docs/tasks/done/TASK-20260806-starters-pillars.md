# TASK-20260806-starters-pillars: Five pillar starter apps (umbrella AL-08)

- **Status**: done — merged to main via PR #7 (2026-08-06)
- **Owner**: Jeetu (autonomous run; Claude implements — umbrella Phase-0 approval pre-approves this plan while it stays inside AL-08's scope)
- **Risk tier**: medium (`examples/` alone is Low, but the shelf/e2e surface is Playground logic → Medium; no protocol/runner/auth touch)
- **Branch**: `feat/TASK-20260806-starters-pillars`
- **Packages touched**: `examples/` (five new apps), `apps/playground` (STARTER_LOOKS rows + one vitest + one Playwright spec), docs
- **Spec impact**: none (no `packages/protocol` change; starters ride the existing envelope/hooks contract byte-for-byte)
- **Related**: umbrella `TASK-20260805-alpha-umbrella` child **AL-08** (roadmap A8a) · `internal/07-roadmap.md` §2 ("every starter is a contract", kid-first bar) + §5 (pillar table) · ADR-0011 (LLM-optional apps) · TASK-20260804-hub-polish AC18 (read-only starter + Install in run view)

## Spec (what & why)

Ship the five **pillar starters** from roadmap §5 — the launch shelf that demonstrates the product's two pillars (agent-as-brain, own-your-data) and the three feelings (education, family, solo-business) without requiring a key:

1. **Adventure Quest** — agent = dungeon master, DB = inventory/map: BOTH pillars in one app.
2. **Quiz Me** — education wow: agent generates quiz questions on a chosen topic, tracks scores in the DB.
3. **Trivia Night** — pass-and-play multiplayer FEELING, zero networking (turns passed on one device).
4. **Family Trip Planner** — single-user v1: the family aspiration (destinations, packing, itinerary in the DB).
5. **Pocket Ledger** — solo-business rep: income/expense entries, simple totals, export-your-data story.

Every starter is a contract (roadmap §2): ONE `examples/<folder>/app.html` built exactly like the shipped three (byte-synced embedded hooks, announce metadata, no browser storage, CDN allowlist only, ≤5 MB), auto-registered on the hub shelf by the existing `import.meta.glob` (the ONE-definition install-source rule — no second registry is created), opening read-only with Install in the run view, validated by `examples/validate.test.mjs`, and exercised by a real-browser Playwright test on the mock adapter (no keys exist in this environment; none are needed).

**LLM posture (ADR-0011), declared per app:**
- *Adventure Quest* and *Quiz Me* are **agent-as-brain** with a graceful no-LLM stance: the app is the referee/structure-keeper; when the reply errors or is off-schema (which is exactly what the demo brain's canned `{kind:'answer', message}` reply is), a **local engine** takes the turn (Adventure Quest: a built-in scene narrator over the same scene graph; Quiz Me: a built-in question bank) and the app says so in a visible note — the chess pattern.
- *Trivia Night*, *Family Trip Planner*, *Pocket Ledger* are **LLM-free like the pig**: `RESPONSE_SCHEMA = null`, no `sendMessage` call in authored code — instant, offline, keyless.

**Demo-mode wow:** default playground mode is byok+mock (the demo brain). All five must deliver their core experience with zero keys: the three LLM-free ones trivially, the two brain apps through their local engines (with the agent upgrading the experience when a real key exists).

**Kid-first bar (roadmap §2):** big touch targets (≥44px), emoji-forward, short words, no jargon, both themes styled, usable at 375px, no `window.confirm` (two-tap destructive actions), skeletons over spinners.

**App Autopsy finding (studied, decided, no new infrastructure):** the "view the build conversation" surface exists for BUILT apps — `useBuilderChat` pins the bootstrap turn and `RunView.resolveMainThread` opens the run view on it. Starters ship **no** build conversation today: installing a starter is `userLibrary().save(html, name, installSource)` — an app row only, no chat thread seeded — and none of the three shipped starters (chess, flying-pig, habit-tracker) attach one. Per the umbrella's instruction this task **notes the gap and ships without inventing new infrastructure**; a "starter ships a pre-seeded bootstrap thread" idea is queued in next-steps for a later owner call. The five new starters behave exactly like the existing three: read-only open → Install → the copy gains the chat tab and starts its own (empty) main thread.

**Acceptance criteria** (each becomes at least one test):
1. **AC1 — validate suite:** each of the five apps passes all six per-app checks in `examples/validate.test.mjs` (single-file w/ allowlisted CDN scripts only · hooks block byte-identical to `packages/sdk/embedded/snug-hooks.js` after normalization · announce metadata complete · no browser storage · parses as HTML w/ the exact 3-CDN + 1-babel script shape · ≤5 MB). Suite grows 18 → 48 (+ the posture tests below).
2. **AC2 — declared LLM posture is real, per app:** the validate suite gains a posture check on the app-authored region (after the section-5 banner): `trivia-night`, `trip-planner`, `pocket-ledger` declare `RESPONSE_SCHEMA = null` and never call `sendMessage`; `adventure-quest` and `quiz-me` pass a `responseSchema` on `sendMessage` AND handle the off-schema/demo case (a visible fallback path exists — asserted behaviorally in AC5's Playwright runs, statically here).
3. **AC3 — shelf registration through the ONE definition:** `listStarterApps()` lists all eight ids with no change to `starterApps.ts` (glob-only registration), and the hub renders a tile per new starter with its own `STARTER_LOOKS` look (emoji/color/blurb — not the `⬡` fallback). Vitest: new `starterShelf.test.tsx`.
4. **AC4 — read-only + Install contract holds for a new starter:** opening a new starter from the hub routes to `/run/starter--<folder>` without writing an app row, and the run view offers Install (covered by the shape of existing AC18 tests; asserted for one NEW starter in the Playwright spec so the contract is proven beyond chess).
5. **AC5 — Playwright, one per starter (mock adapter, keyless):** hub → open the starter read-only → the app boots inside the `sandbox="allow-scripts"` iframe → ONE meaningful interaction works (Adventure Quest: begin + make a choice → narration advances and the pack/map update, demo-brain fallback note visible; Quiz Me: pick a topic → the built-in bank quiz starts under the demo brain → answering updates the score; Trivia Night: add two players → answer one question → the pass-the-device screen names player 2; Trip Planner: add a destination + check a packing item; Pocket Ledger: add one income + one expense → totals and profit correct) → **no unexpected console errors** (the existing BENIGN allowlist only). New `e2e/starters.spec.ts`.
6. **AC6 — nothing weakened:** all existing suites stay green (root vitest 910 baseline, Playwright 30 baseline) with zero edits that loosen an existing assertion. New totals recorded at close.

**Out of scope**: auth-spectrum starters (AL-09) · any new protocol/runner/SDK surface · seeding starter build-conversations (noted above, queued) · multiplayer networking (Trivia Night is deliberately one-device) · multi-user Trip Planner (v1 is single-user by owner decision) · Kid Mode UX trials (Beta).

## Plan

Order (TDD where the seam allows — validate + shelf vitest are honest red-first; Playwright red is demonstrated on one spec, not five 60s timeouts):

1. **Task file** (this) — commit.
2. **Tests first (red):**
   - `examples/validate.test.mjs`: add the five folders to `APPS`; add the AC2 posture checks (a new per-app test that reads the authored region after the banner). Red: ENOENT per missing app.
   - `apps/playground/src/__tests__/starterShelf.test.tsx`: `listStarterApps()` contains the 8 ids; HubView renders each new tile with its non-fallback look. Red: glob finds no folder.
   - `apps/playground/e2e/starters.spec.ts`: 5 tests per AC5, reusing the owner-report BENIGN console allowlist and the frameLocator pattern. Red shown for adventure-quest only (runtime economy), then the suite runs full at Gate 5.
   - Commit the red tests.
3. **Author the five apps** (`examples/<folder>/app.html` + `README.md` each): hooks block extracted byte-for-byte from `examples/chess/app.html` by script (never retyped — the validate byte-compare is the lock); authored code after the banner. Per-app design:
   - `adventure-quest` — scene graph (map) lives in the app; `useAppDB` tables `quest_inventory`, `quest_journal` (+ hero state via `usePersistedState`); each choice → `sendMessage('take_action', {scene, choice, hero, inventory, recentEvents}, {responseSchema})` where the schema asks for `{narration, foundItem?, loseItem?, hpDelta?, goldDelta?, message}`; app clamps/applies effects (referee), logs the leg to the journal, renders the pack from SQL. Off-schema/demo reply → local narrator for that scene + note. Export .sqlite works (db ops seen).
   - `quiz-me` — topic chips + free topic; `sendMessage('make_quiz', {topic, count: 5}, {responseSchema})` asking for 5 `{question, choices[4], answerIndex, funFact}`; replies validated hard (shape, 4 choices, answerIndex in range, no duplicate correct leak); invalid/demo → built-in bank (per-topic where available, mixed otherwise) + note. Quiz itself runs locally; result saved to `quiz_scores` via `useAppDB`; history rendered as CSS bars.
   - `trivia-night` — LLM-free; 2–4 players (name + emoji), local category question bank, pass-the-device interstitial between turns, scores + winner crown; match state + hall of fame via `usePersistedState`.
   - `trip-planner` — LLM-free; `useAppDB` tables `trip_destinations`, `trip_packing`, `trip_itinerary`; three tabs (dream board / packing / day plan); two-tap remove; export story card.
   - `pocket-ledger` — LLM-free; `useAppDB` table `ledger_entries` (amounts in integer cents, kind income|expense, category); running totals + per-category bars + this-month filter; own-your-data export card (habit-tracker pattern).
4. **Hub looks:** add five `STARTER_LOOKS` rows in `HubView.tsx` (data only — no logic change).
5. **Green:** validate suite → shelf vitest → Playwright spec; then full root `pnpm build` + `pnpm test` + `pnpm --filter playground test:e2e`.
6. **Docs (Gate 6):** `examples/README.md` table + stale flying-pig README fixed (it still describes the pre-ADR-0011 coach game — drift), code-map examples row (18 → new count), next-steps ✅ entry + queued starter-autopsy idea, journal below.

Cross-package impact: none beyond playground (shelf is data-driven). No spec-sync (C3 untouched). C1/C2 untouched — apps run under the existing sandbox; no new capability.

Shared literals pinned (lessons 2026-08-03): folder names are the contract — `adventure-quest`, `quiz-me`, `trivia-night`, `trip-planner`, `pocket-ledger`; ids `starter--<folder>`; install sources `starter:<folder>`; announce appIds `adventure-quest`, `quiz-me`, `trivia-night`, `trip-planner`, `pocket-ledger`.

## Decisions & surprises

- **Starters ship no App Autopsy conversation today** (see spec) — noted, not built; queued in next-steps as an owner call.
- Validate-suite convention kept: `APPS` stays an explicit list (per `examples/README.md` "Adding an example") rather than a readdir — the glob and the list CAN drift, but the shelf vitest (AC3) now pins folder-count agreement from the other side.
- The demo brain's app-mode reply is a fixed `{kind:'answer', message}` JSON — for agent-as-brain starters that is the *off-schema* case by design, so the graceful-fallback path IS the demo path. The visible note doubles as honest UI ("the storyteller is offline — a local guide took over").
- **SURPRISE (the big one): `<form onSubmit>` is dead inside the C2 sandbox.** `allow-scripts` without `allow-forms` makes Chromium block a form submission at initiation — *before* the `submit` event dispatches — so a React `onSubmit` handler simply never runs in a real browser, while jsdom (which never submits) stays green. The new Playwright spec caught it on trivia-night and trip-planner; auditing for the pattern showed the SHIPPED habit-tracker had it too — its add-habit and ask flows have been dead in real browsers since it shipped. Fixed all three (onClick + Enter keydown), locked with a red-first validate rule (no form elements), promoted to lessons.md, and queued a KB-template line so generated apps can't repeat it.
- **SURPRISE: a `usePersistedState` write racing initial hydration is silently lost.** Trivia Night's roster add vanished in the e2e: the hook's `kvGet` resolves after the user's first write and overwrites it (and pre-hydration writes are never persisted — `hydratedKey` gating). The app-level fix: the roster became a real `tn_players` table (SQL inserts have no hydration race, and the roster now rides in the export); hall-of-fame stays kv because it writes at podium time. SDK-level fix (expose hydration state from the hook) queued in next-steps — it needs the byte-sync + KB cycle.
- **Trip-planner initially shipped the same ready-gating gap pocket-ledger avoided**: mutating buttons enabled before the DDL finished → `no such table` on a fast first click. All DB starters now gate mutations on `ready`.
- **Environment: port 8787 was owned by the main checkout's long-lived `pnpm --filter server dev:local`** (another agent/owner process — off-limits from this worktree). Added `SNUG_SERVER_PORT` as an override honored by BOTH the vite proxy and the e2e config so parallel worktrees can run the Playwright suite; defaults unchanged, no test weakened. This suite ran with `SNUG_SERVER_PORT=18787`.
- Trivia-night scores are keyed by roster id, not player name — two kids named Sam keep separate scores (caught in self-review, not by a test).

## Session journal (append-only, newest last)

### 2026-08-06 00:45 — Claude (Fable 5) — session
- Done: Gate-2 reads (process/TDD/lessons/umbrella/roadmap §2+§5/ADR-0011/code-map; chess + flying-pig + habit-tracker end-to-end; validate suite; starterApps ONE-definition rule; HubView/RunView read-only+Install flow; demo adapter chain; e2e patterns incl. BENIGN console allowlist). Task file written.
- State: plan approved by umbrella pre-approval; starting tests-first.
- Next step: red tests (validate APPS + posture, shelf vitest, starters e2e), then author the five apps.

### 2026-08-06 01:25 — Claude (Fable 5) — session (close)
- Done: red-first tests (validate ENOENT-red on the five, shelf vitest red, starters e2e authored) → five apps assembled with the byte-exact hooks block (extracted from chess programmatically, never retyped) → validate 56 green on first assembly → first e2e run 3/5. The two failures unearthed the form-submit sandbox kill and the kv hydration race (see Decisions & surprises); fixes landed red-first via a new no-form validate rule (18 → 64 total with posture checks), habit-tracker repaired, TN roster moved to SQL, TP ready-gated. Second issue round: my own locator anchored past a leading emoji. Final: validate 64/64 · playground vitest 250 (was 248; `starterShelf` +2) · full root `pnpm build` + `pnpm test` green (vitest 912, was 910) · full Playwright **35/35** (was 30; `starters.spec.ts` +5) on `SNUG_SERVER_PORT=18787`. Docs: examples README (8-row table + no-form + posture contract), stale flying-pig README rewritten to the ADR-0011 exemplar it actually is, code-map rows, next-steps ✅ + 3 queued items, lessons entry.
- State: all ACs test-backed and green; branch has 5 commits, not pushed (umbrella owns PR/merge). No push, no PR, no publish — per instructions.
- Next step (for the orchestrator): AI review + merge per umbrella DoD; the umbrella's live agent-browser sweep should walk each new starter once (kid-first eyeball pass is a human/owner call the suite can't make).
- Open questions: starter App Autopsy pre-seeded thread (queued, owner call) · SDK hydration-state exposure (queued) · KB no-form line (queued, prompt-change discipline).

### 2026-08-06 02:40 — Claude (Fable 5) — review round (adversarial verdict: MERGE-AFTER-FIXES, 5 items — all applied)
- **Fix 1 (read-only leak, the real fix, not the journal escape):** `RunView` now hands an UNINSTALLED starter an **ephemeral in-memory DbDriver** (`createDbDriver({ backend: createMemoryBackend() })`, closed on unmount) instead of the user DB's materialized face — browsing leaves ZERO trace in the user's file. This also closes AL-01's queued kv-orphan leak (chess play before install; next-steps annotated). **Documented semantic: pre-install play data vanishes on install — trying is not owning.** Guard tests at the OUTCOME/BYTE level per the 2026-08-04 lesson: interact with an uninstalled starter → download the full user-file export → assert the bytes contain no `app_x737461727465722d2d` (hex "starter--") DDL; companion test proves the owned copy starts fresh AND its data persists across leave-and-return. **Mutation evidence:** stashing the RunView hunk (leak restored) turns the export-bytes guard RED; popped → green.
- **Fix 2 (money parsing):** red-first behavior cases in the validate suite execute `parseCents` EXTRACTED from the shipped source: `1,000`→100000 (thousands, was $1.00), `1,50`→150, `1,234.56`→123456, `1,000,000`→cap-exact, `1,2,3`/`1,0000`→rejected to the warn path. While writing cases: `-5` silently parsed as +$5.00 (pre-existing) — signed input now rejected ("the in/out buttons carry the sign").
- **Fix 3 (dedup flake — pre-existing, inherited):** the post-install wait matched `/\/run\//`, which the READ-ONLY starter route also satisfies, so `firstUrl` could capture before the install navigation landed (reviewer measured 2-of-3 full runs failing). Now waits for the uuid URL shape. **Correction to the previous session's "35/35" claim:** that number was true of the runs I made but the suite contained this latent race. Evidence after the fix: `dedup.spec.ts --repeat-each 8` → 8/8, then **3 consecutive full Playwright runs 37/37** (plus a 4th standalone 37/37). Candid note: an earlier proof loop showed two runs at "36 passed" with the no-server hard-reload test listed under a truncated status heading; not reproduced in the four subsequent full runs — if it recurs, suspect back-to-back persistent-context launches, not dedup.
- **Fix 4 (Quiz Me Enter):** free-topic input accepts Enter (the README promised it); the e2e now drives the Enter path (chips share the same `startQuiz` handler).
- **Fix 5 (claim drift):** (a) `starterShelf` now pins the shelf COUNT (`toHaveLength(8)`) — the "folder-count pinned" line is now true rather than corrected; (b) `validateQuiz` **now rejects duplicate choices** (chose the check over amending the claim — dupes leak or ambiguate the answer); (c) shipped table names vs plan: `aq_inventory`/`aq_journal` (plan said `quest_*`), `trip_places`/`trip_packing`/`trip_days` (plan said `trip_destinations`/`trip_packing`/`trip_itinerary`), `tn_players` added post-plan (hydration-race fix), `quiz_scores` + `ledger_entries` as planned; (d) **Trivia Night persistence, stated accurately:** match state is VOLATILE by design (a party round is disposable — reload = new round); what persists is the roster (`tn_players`, SQL) and the hall-of-fame best (kv, written at podium time). The plan's "match state via usePersistedState" did not ship and was wrong as written.
- **Both optional NOTEs taken:** podium rows keyed by roster id; validate-suite lint rejecting string-built SQL at `exec()` call sites (red-first on trip-planner's concatenated DELETE, fixed via per-kind literal statements).
- Totals after the round: validate **73** (was 64) · playground vitest 250 (shelf test strengthened in place) · Playwright **37** (was 35) · root `pnpm build` + `pnpm test` green.
- State: committed on the branch, not pushed; stopping per instructions.
