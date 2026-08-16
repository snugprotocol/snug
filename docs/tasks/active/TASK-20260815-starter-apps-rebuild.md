# TASK-20260815-starter-apps-rebuild: The gold-standard connected starter portfolio (child C)

- **Status**: draft (planned; blocked on child B merge)
- **Owner**: Jeetu
- **Risk tier**: **medium** — `examples/` is Low by table, but this ships five connection
  manifests (install-act channel) + playground shelf logic; treat as Medium (full TDD +
  AI review + human review). No High-tier surface touched.
- **Branch**: `feat/TASK-20260815-starter-apps-rebuild` (off `main` after B merges)
- **Packages touched**: `examples/` (remove 9, add 5), `apps/playground` (STARTER_LOOKS, HubView), `packages/knowledge` (only if an app exposes a KB gap — record, don't drift)
- **Spec impact**: none
- **Related**: umbrella [TASK-20260815-starter-portfolio-revamp](TASK-20260815-starter-portfolio-revamp.md) · children A+B (the apps showcase both) · ADR-0026 (hue symbolic addressing) · ADR-0028/0030 (spotify scopes, coinbase Ed25519) · next-steps "real-provider verification gap" (owner-run, stays owed)

## Spec (what & why)

Curate the shelf down to apps that earn their place, and add five connected starters that
raise the benchmark for personal apps: Apple-grade UI/UX with designer-level personal
touches, each **complementary to the provider's own app** (never a clone), each exploiting
the full approved API surface plus the new provider lane (A) and cards (B).

**Remove (9):** connection-demo, crypto-portfolio, habit-tracker, spotify-party-dj,
trip-planner, my-repos, hue-lights-party, pocket-ledger, weather-planner.
**Keep (5):** chess, flying-pig, adventure-quest, quiz-me, trivia-night.
**Add (5):**
1. **trade-copilot** — baseline: byte-export of the owner's "Coinbase Trade Copilot"
   (`~/Snug/user.sqlite`, app_id `ef7c383a-a9e3-4a59-84d7-151f883948b8`, v1 HTML
   52,838 B + its runtime contract; slot `coinbase`, ADR-0030 field shape). Then extend:
   portfolio intelligence Coinbase's app doesn't offer + smart-order orchestration
   (TWAP-style slicing planned/journaled in-app, each slice a governed POST through the
   confirm gate). Desktop-only (Coinbase CORS).
2. **spotify** — clean slate. Listening analytics + affinity insights; chat tab with
   sample provider-lane prompts ("most-played last week", "build me a set from my
   heavy-rotation artists"); playback control as complement, not clone. Web + desktop.
3. **hue** — clean slate. Benchmark room/zone control (LAN, `snug-connection://hue/...`,
   desktop-only) + LLM actions: "match all selected fixtures to this color", search-then-
   set across matching lights, scene suggestions via cards.
4. **weather** — clean slate, OpenWeather (query-key kind, registry-pinned). A planning
   surface (day timeline, comparisons, "should I…" answers via the provider lane), not a
   forecast-tile clone. Web + desktop.
5. **github** — clean slate, same GitHub registry entry (oauth_app / PAT options as
   pinned). Repo pulse + review-queue focus + chat actions (label, issue triage) —
   complement to github.com, not a mirror. Web + desktop.

**Authoring provenance bundle (owner addition, 2026-08-15).** Every rebuilt/new starter
saves its dev-time authoring record in the codebase, colocated and clearly mapped:
`examples/<folder>/authoring/` with two parts —
- `prompts/`: the actual prompts generated and sent to the LLM while authoring the app
  (numbered per iteration: `01-build.md`, `02-<change>.md`, …) plus `00-assembly.md`
  pinning which KB template/layers (and repo SHA) rendered the system side;
- `docs/`: the same standard wiki pages the hub generates for a user-authored app at
  runtime (`snug_app_docs` slugs: `vision.md`, `requirements.md`, `plan.md`,
  `lessons.md`, `memory.md`, `next-tasks.md` — write the ones that have real content,
  matching the app-doc-write tool's doctrine), file-per-slug so a future phase can
  ingest them 1:1 into `snug_app_docs`.
For **trade-copilot**, `docs/` is seeded from the owner's REAL rows (vision 680 B,
requirements 1,324 B, plan 2,312 B, lessons 656 B, next-tasks 392 B in
`~/Snug/user.sqlite`), then updated alongside the extension work; extension prompts land
in `prompts/`. Purpose: next-phase leverage (owner will specify); this task only saves
them, well-formed. Nothing in `authoring/` ships into the app bundle (the shelf glob
matches only `app.html`).

**Acceptance criteria** (each becomes at least one test; the validate suite IS the test
bed for most):
1. `examples/` holds exactly the 10 folders above with `app.html` + `README.md`; `APPS` matches disk (suite gate); `LLM_FREE_APPS` = flying-pig, trivia-night only.
2. All five new apps: hooks block byte-identical to `packages/sdk/embedded/snug-hooks.js`; announce metadata complete; no browser storage; no `<form>`; ≤5 MB; CDN-allowlist-only; no string-built SQL — the full per-app assertion loop green.
3. All five ship valid `connection.json` (registry borrows for coinbase/spotify/openweather/github; hue = `lanHost`, no pinned host, symbolic URLs only — extend the existing hue-specific pins to the new folder) and valid `runtime-contract.json` naming their slot(s); `MANIFEST_APPS` pin updated 6→5.
4. trade-copilot baseline fidelity: extraction script output == DB bytes for v1 HTML before extension edits begin (recorded in journal); hooks block re-verified after any edit.
5. Each app degrades gracefully keyless/unconnected: honest un-connected state (connection-demo's old job), demo-brain fallback never crashes; LLM posture honest per ADR-0011.
6. STARTER_LOOKS entries for all five (desktopOnly: trade-copilot, hue); removed apps' looks deleted; HubView fallback still covers unknown folders.
7. Design bar verified in a REAL browser both themes at 375px and desktop widths (screenshots in PR; geometry lesson 2026-08-14) — skeletons, ≥44px targets, no hover-only affordances.
8. `pnpm --filter examples test` + playground + desktop + root forced run green.
9. Authoring bundle: each of the five new/rebuilt starters ships `authoring/prompts/`
   (≥ the build prompt + assembly pin) and `authoring/docs/` with valid standard-slug
   pages; a validate-suite check asserts presence + slug validity for the five and that
   `authoring/` content never reaches the bundled app (glob scope pinned by test);
   trade-copilot's seeded docs byte-match its DB rows at extraction time (journaled).

**Out of scope**: live hardware verification against real provider accounts (owner-run,
next-steps); KB/platform changes beyond what A/B shipped (gaps get recorded, not
hot-fixed here); localization; mobile-web polish beyond the 375px bar.

## Plan

1. Tests/curation first: update `APPS`/`LLM_FREE_APPS`/`MANIFEST_APPS` + folder removals in one commit — suite red until the five new apps exist (the APPS-vs-disk gate enforces the target state).
2. Extraction: scratchpad script reads `~/Snug/user.sqlite` read-only → `examples/trade-copilot/app.html` + `runtime-contract.json` + `authoring/docs/*.md` from its `snug_app_docs` rows (byte-fidelity journaled); verify hooks-block byte-identity (if the owner's copy predates a hooks revision, re-copy the block from `packages/sdk/embedded/snug-hooks.js` and diff only app-authored remainder, journaled). Author `connection.json` (registry borrow: provider name "Coinbase" → pinned fields/request/testRequest arrive by substitution — borrower-authored seats refused, so the manifest stays bare like spotify-party-dj's was).
3. Build spotify, hue, weather, github from the rendered KB template (20-html-template.md), one at a time, validate-suite green each before the next — saving every authored LLM prompt into `authoring/prompts/` AS the build happens (not reconstructed after) and writing `authoring/docs/` per the app-doc-write doctrine (vision/requirements/plan seeded at first build; lessons/next-tasks as they arise). If parallel agents are used: worktree isolation mandatory (lesson 2026-08-12), shared literals pinned in this file (folders/slots above), every agent's output re-verified against the validate suite by the orchestrator.
4. Extend trade-copilot past baseline (TWAP planner journaled in app DB; slices via `useConnectedFetch` POSTs — each rides the executor confirm gate; card-driven parameter confirmation via the app-attached chat).
5. STARTER_LOOKS + desktopOnly flags; remove dead looks.
6. READMEs (per-app story: what it demos, complement thesis, connection posture) + `examples/README.md` table rewrite (10 apps, updated contract notes if A/B taught new affordances).
7. Real-browser design pass on all five (both themes, 375px + desktop); screenshots.
8. Verify: examples + playground + desktop suites, root `turbo run test --force` (examples KB≡SDK suite force-run — turbo inputs gap).

Cross-package: examples + playground; no protocol/auth/sdk/knowledge source changes expected.

## Decisions & surprises

_(running)_

## Session journal (append-only, newest last)

### 2026-08-15 — Claude (Fable 5) — session
- Done: spec + plan drafted under the umbrella interview; Trade Copilot located + shape-verified in the owner's DB (read-only). Owner addition folded in same-day: per-starter `authoring/` provenance bundle (prompts + standard-slug wiki docs; trade-copilot's docs seeded from its real `snug_app_docs` rows — vision/requirements/plan/lessons/next-tasks all present in the DB). AC9 + plan steps 2/3 updated.
- State: awaiting umbrella approval; sequenced after child B.
- Next step: on B's merge — branch, curation-gate commit first (step 1).
- Open questions: none.
