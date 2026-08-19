# TASK-20260819-starter-sample-data: Ledger-style sample data + wiki-doc completion for Rewind, Trade Copilot, Moodboard, Telepath

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: medium (examples/ is nominally Low, escalated: app.html edits change install-act vouched bytes, Telepath sample data borders the pseudonymisation/scrub seam, and four extracted-core test suites ride on these files)
- **Branch**: `feat/TASK-20260819-starter-sample-data`
- **Packages touched**: `examples/spotify`, `examples/trade-copilot`, `examples/hue`, `examples/whatsapp` (+ their node:test suites), `apps/playground` (bundled-starter test expectations only — no source changes expected)
- **Spec impact**: none
- **Related**: ADR-0038 (Ledger sample-mode precedent), ADR-0035 (authoring docs → installed wiki), ADR-0031 (AC9 provenance bundles), TASK-20260818-telepath-linking-sync (ACTIVE — same `examples/whatsapp/app.html`; 3 owner walk items pending), lessons 2026-08-18 (decorate-at-render/scrub; installed starters never receive rebuilds), lessons 2026-08-15 (real-engine DDL)

## Spec (what & why)

The four connected starters open onto empty states (skeletons, "not connected yet" panels, sidecar status screens) — nothing shows a prospective user what the app is *for* before they connect. Ledger solved this (ADR-0038): a deterministic, clearly-bannered sample dataset that demonstrates the app's value pre-connect and is evicted wholesale by the first real sync. Owner ask 2026-08-19: replicate that WOW-before-connect experience for **Rewind** (`examples/spotify`), **Trade Copilot** (`examples/trade-copilot`), **Moodboard** (`examples/hue`), **Telepath** (`examples/whatsapp`), and complete each app's `authoring/` wiki bundle to Ledger's full set where files are missing — **without changing any connected-state UI/UX, feature, or functionality**. Owner confirmed 2026-08-19: Rewind's deliberate "No sample data pretends to be you" skeleton stance is superseded by a labeled sample portrait; Telepath proceeds at full scope now despite the active linking-sync task.

**Acceptance criteria** (each becomes at least one test):
1. Each of the four apps, when unconnected/unlinked (Telepath: sidecar unreachable or never linked), renders a populated sample experience — not a skeleton or bare status panel — with a visible sample banner (Ledger's `.sample-note` pattern) stating the data is sample and how to replace it with real data.
2. Sample datasets are deterministic (fixed-seed `mulberry32` and/or authored constant tables — no `Date.now()`/`Math.random()` in sample generation) and contain *planted insights* that show off each app's USP: Rewind — a listening portrait with rotation/discovery contrast across time ranges; Trade Copilot — a portfolio with balances, a filled TWAP plan history with slice outcomes, and agent notes; Moodboard — named rooms with distinct lighting states and applied moods (replacing the generic "room 1..4" stand-ins); Telepath — pseudonymised chats (`YOU`/`P1`/`P2`…), message history, and a completed sample analysis with charts.
3. Connected/linked behavior is byte-for-byte unchanged in logic: first real sync/connect fully evicts or bypasses sample content (DB-seeded rows carry a `sample` provenance flag and are deleted wholesale, Ledger pattern; render-only sample state is unmounted the moment real data phases take over). No sample content survives into a connected session.
4. Telepath: sample content never enters the LLM/analysis request path or the pseudonym label map (sample analysis is a canned constant, not a live analyse run); sample values stored/rendered follow decorate-at-render (lesson 2026-08-18).
5. Any new DDL executes against real sql.js (lesson 2026-08-15) — covered by extending each app's extracted-core/analysis test seam.
6. `authoring/` completion to Ledger's set — new files: `spotify/authoring/docs/{lessons.md,next-tasks.md}`, `hue/authoring/docs/{lessons.md,next-tasks.md}`, `whatsapp/authoring/docs/next-tasks.md` (trade-copilot already complete). All bodies real prose ≥40 chars (ADR-0031 AC9 floor), ingestable via the ADR-0035 `starterDocs.ts` glob without code changes.
7. Full local evidence green: `pnpm --filter examples test` (validate, connection-manifests, infer-connection, whatsapp-analysis ~204, ledger-analysis) and playground starter suites (`starterShelf`, `starterDocs`, `starterTileName`, `starterDeclaration`, `starterInstall`); `pnpm --filter playground test`.

**Out of scope**: shelf/HubView changes (tiles already fine); install-act / html_mismatch renderer work (known gap, parked in next-steps); rebuild-delivery for already-installed starters (installed copies won't receive this — accepted, see risks); README rewrites beyond a short "Sample mode" note per app; any `connection.json`/`runtime-contract.json` change; the desktop icon (separate task TASK-20260819-desktop-icon-squircle).

## Plan

**Reference pattern (from `examples/ledger`)**: inline seeded-PRNG generator + authored constant tables with planted insights → `seedSampleIfEmpty` guarded by row count → `sample INTEGER` provenance column → wholesale `DELETE … WHERE sample = 1` on first real sync → visible `.sample-note` banner. Docs: `authoring/docs/{vision,requirements,plan,lessons,next-tasks}.md` + `authoring/prompts/`.

**Per-app sample mechanism** (chosen to guarantee AC3's "no impact on connected behavior"):
- **Rewind (`spotify/app.html`, ~1,447 L)**: render-only. A constant sample portrait (top-5 tracks/artists × 3 time ranges, rotation/discovery percentages, one sample `weekly_rewind` card) rendered in the `unconnected` phase in place of the hero+skeleton; journal fallback still wins if a real journaled portrait exists. No DB seeding (keeps the visit journal clean). Remove the "no sample data" copy; add banner.
- **Trade Copilot (`trade-copilot/app.html`, ~1,972 L)**: render-only for portfolio/products/ticker/book panels in the unconnected state (constant sample market + accounts + agent notes); TWAP history panel seeded into `twap_plans`/`twap_slices` with `sample=1` + eviction on first real Coinbase fetch success (mirrors Ledger exactly, exercises the DB seam). Banner across the dashboard header.
- **Moodboard (`hue/app.html`, ~1,341 L)**: upgrade the existing stand-in preview — replace generic `room 1..4` with a named, colored sample home (e.g. Living Room warm dusk, Office focus-white, Bedroom candle, Kitchen bright) rendered as the real glowing tiles, moods previewing against them. Render-only; `moods` DB untouched. Banner replaces the current stand-in caption.
- **Telepath (`whatsapp/app.html`, ~1,874 L)**: render-only sample surface shown ONLY in the never-linked / helper-unreachable states — sample chat list, one openable thread, and a canned completed analysis with its deterministic charts. Zero writes to the real SQLite (real JID keyspace stays clean ⇒ nothing to evict; linked phases never consult sample constants). Pseudonyms pre-baked as `YOU`/`P1`/`P2`; no analyse call possible on sample data (analysis is a constant).

**Order of work** (tests FIRST per acceptance criterion, Gate 3):
1. Extend `examples/validate.test.mjs` (or a new `sample-mode.test.mjs` in the same runner list): for each of the 4 apps assert (a) a `SAMPLE`-marked constants block exists (adopt Ledger's `CORE-BEGIN/END`-style markers), (b) banner copy present, (c) no `Math.random(`/`Date.now(` inside the sample markers, (d) required authoring files exist with ≥40-char bodies. Red first.
2. Extend `whatsapp-analysis.test.mjs`: sample constants exported through the core seam — assert sample JIDs/labels never pass through `redactIdentifiers`/label-map builders, and canned analysis is inert. Extend/clone the trade-copilot seam for `sample=1` seeding + eviction (real sql.js). Red first.
3. Implement per app in this order: **hue → spotify → trade-copilot → whatsapp** (smallest/least-coupled first; whatsapp last and rebased-aware because of the active Telepath task).
4. Authoring docs (AC6) — write the five new files; run playground `starterDocs` suite to confirm glob ingestion unchanged.
5. Short "Sample mode" section in each of the 4 READMEs.
6. Full evidence pass: `pnpm --filter examples test` + `pnpm --filter playground test` (both `--force` — turbo declares no inputs; stale-green hazard, lesson 2026-08-10/13).

**Cross-package impact**: playground bundles `examples/*/app.html` via raw glob — starter tests re-run over new bytes; `starterDeclaration` compares *bundled* bytes so it stays green by construction. Desktop unaffected. No protocol change ⇒ no spec-sync.

**Known risks / accepted residuals**:
- Already-installed starters never receive rebuilds; installed copies (incl. owner's linked Telepath) will report `html_mismatch` against the new factory bytes, and that surface has no renderer (next-steps 2026-08-13). Accepted by owner 2026-08-19; sample mode reaches new installs only.
- TASK-20260818-telepath-linking-sync still owes 3 owner hardware walks on this same file; those walks should re-run on a build containing this change — noted in that task's journal at close.
- CI billing-blocked (next-steps 2026-08-19): all evidence local; journal every command + result.

## Decisions & surprises

- 2026-08-19 owner: two tasks (this + icon), full Telepath scope now, Rewind's anti-sample stance replaced by a labeled sample portrait (honesty preserved via the banner + eviction/unmount semantics).
- Render-only vs DB-seeded chosen per app (above) — only Trade Copilot's TWAP history uses DB seeding, to mirror Ledger where a journal is the feature; Telepath deliberately never writes sample rows (JID keyspace + scrub safety).

## Session journal (append-only, newest last)

### 2026-08-19 — Claude (with Jeetu) — session
- Done: 4-scout research (Ledger pattern distilled; four-app audit — none has sample data, docs gaps enumerated; process/overlap map), owner interview (4 decisions), spec + plan written, branch cut.
- State: planned — awaiting owner plan approval before Gate 3.
- Next step: on approval, write red tests (steps 1–2), then implement hue → spotify → trade-copilot → whatsapp.
- Open questions: none blocking.

### 2026-08-19 — Claude — session (implementation)
- Done: red `sample-mode.test.mjs` (20 red) wired into the examples runner; 4-agent parallel implementation (hue → SAMPLE_ROOMS five-room lit home + canned "Movie Night" designer mood; spotify → SampleShowcase portrait through real components, fictional artists, canned weekly-rewind card, journal fallback still outranks sample; trade-copilot → sample portfolio/book/ticker + completed-TWAP centrepiece with computed "patience saved ≈ $129.94" verdict + mid-flight plan + 3 canned Ledger-persona notes, render-only via `isSample` flag, DB untouched (plan deviation: NO twap seeding — zero schema/migration risk, noted in Decisions); whatsapp → sample chat list/thread/canned analysis mounted ONLY in helper-down/never-linked branch, `sample.invalid` jids, three real-session zero-states byte-preserved with their 2026-08-17/18 owner-fix comments). New docs: spotify+hue lessons/next-tasks, whatsapp next-tasks. READMEs: "Sample mode" sections. `starterDocs.test.ts` real-bundle pin updated for whatsapp `next-tasks.md`.
- Evidence (all local — CI billing-blocked): `pnpm --filter examples test` 257/257; `pnpm --filter playground test` 1244/1244 (121 files, tsc-gated); `e2e/starters.spec.ts` 5/5 Playwright.
- Plan deviation recorded: trade-copilot sample is render-only (constants), not DB-seeded — stronger guarantee for AC3, no eviction machinery needed.
- State: implementation complete on `feat/TASK-20260819-starter-sample-data`; connected starters are desktop-only/env-gated, so the visual sample-mode walk is an owner hardware item.
- Next step: owner walk of the four sample surfaces on desktop (plus re-run of the 3 pending Telepath linking-sync walk items on a build containing this change), then PR.

### 2026-08-19 — Claude — review (Gate 5, AI pass) + fix round
- Review: 8-finder AI review over the branch diff. Confirmed and FIXED: (1) hue — sample home rendered for ALL offline bridge phases and flashed during 'loading'; three drifted predicates unified on `sampleHome = phase === 'unconnected' && rooms.length === 0`, previous skeleton+overlay restored for paired-bridge failure phases; (2) whatsapp — sample surface lacked a real-data guard (linked user's helper crash showed fictional chats beside real ones) and `sampleJid` was never reset, so a later helper blip replaced a REAL open thread with the sample one; now gated on `chats.length === 0` + reset effect; (3) trade-copilot — `isSample` misfired for previously-connected installs during outages, omitted the persisted watchlist, and flickered on fresh boots; replaced with a durable `connected_once` flag (additive `app_meta` table, written on first successful fetch) + watchlist term, no dependence on fetch-error states; (4) test suite — banner-copy assertion was vacuous (whole-file /sample/i) and the render-only scan missed sample components outside the markers; now proximity-checked per banner + line-level scan of all sample identifiers, and the sample components were moved inside the markers (spotify, whatsapp); (5) code-map claim narrowed to the four flagship starters (weather/github have no sample mode; ledger predates the marker convention). Plus small cleanups (hoisted sample constants in trade-copilot, dead fallback removed in spotify, 13-week comment fix).
- Accepted residuals (reviewed, deliberately unchanged): spotify's expired-session sub-case shows the labelled sample for journal-less users (owner's banner-honesty decision covers it); trade-copilot's inline sample JSX outside the markers (covered by the new line-level scan); examples test suites keep per-suite marker extractors and a docs check overlapping validate's AC9 floor (no shared-helper precedent in examples/); sample-mode's SAMPLE_APPS is a hand-maintained list (unlike validate's folder assertion).
- Evidence after fixes: examples 261/261, playground 1244/1244, whatsapp-analysis 34/34 (all local; CI billing-blocked).
