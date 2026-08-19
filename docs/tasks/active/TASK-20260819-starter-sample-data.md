# TASK-20260819-starter-sample-data: Ledger-style sample data + wiki-doc completion for Rewind, Trade Copilot, Moodboard, Telepath

- **Status**: planned
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
