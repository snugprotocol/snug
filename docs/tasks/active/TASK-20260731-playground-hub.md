# TASK-20260731-playground-hub: `apps/playground` + `examples/` (child 6 of build-hub)

- **Status**: in-progress
- **Owner**: Jeetu (delegated session)
- **Risk tier**: medium (playground logic; executes the C2 real-browser gate)
- **Branch**: `feat/TASK-20260731-playground-hub`
- **Packages touched**: `apps/playground` (new), `examples/` (new); consumes all packages
- **Spec impact**: none
- **Related**: umbrella P3 (design brief), ADR-0005 (Vite SPA), ADR-0006 obligations (srcdoc CSP inheritance; Playwright suite), runner `BROWSER_CSP_CHECKS`, server SSE contract (child-5 notes)

## Spec (what & why)

The hosted demo hub: chat → build → run micro-apps, benchmark-setting UX. **v1 surfaces** (pin/share/install remain out of scope per ADR-0003):

1. **Hub** (`/`): app gallery from the artifact store (server mode) or local library (BYOK mode) — gradient tiles from announce metadata (iconEmoji/iconColor), always-visible create bar with 6 suggestion chips (from `prompts/ui`, rendered via knowledge loader), empty state that teaches in one sentence.
2. **Builder** (`/build`): chat surface — autogrow composer (Enter/Shift+Enter, Stop, `/` focus shortcut), streamed reply with reasoning pill, artifact card appears when SSE `artifact` event lands → primary "Run it" CTA. Suggestion chips only when composer empty.
3. **Run** (`/run/:id`): the star. `SnugAppFrame` center-stage; app header from announce (capability-reveal: header upgrades when the app self-describes); collapsible **Inspector** rail (the "watch it think" affordance): live timeline fed by runner `onFrame` + transport events — frames in/out, streaming progress, db ops, errors — structural payloads only, never prompt text; chat rail to keep talking to the agent about the app; budget-exhausted reset affordance; theme toggle proving `snug:host-event` live; `.sqlite` export button when the app uses the db (ownership moment: downloads a real file).
4. **Modes**: server mode (default; `createHttpTransport` → local server, mock adapter works offline) and **BYOK** (key stays in memory/sessionStorage with explicit copy about it; adapters + `runAgentTurn` + browser-side knowledge tools; artifacts in IndexedDB) — mode switch in Settings.
5. **`examples/`**: `chess/`, `flying-pig/`, `habit-tracker/` — curated single-file HTML apps built exactly per the KB template (embedded hooks, announce, JSON-only replies; habit-tracker exercises useAppDB + export). Bundled into the playground as a "Starter apps" shelf loadable without any server.
6. **E2E (Playwright)** — the umbrella's real-browser gate: (a) AC-7 flow: chat "build me tic-tac-toe" on mock adapter → artifact → run → bridge round-trip (scripted mock reply) → app renders agent data; (b) **execute runner's `BROWSER_CSP_CHECKS`** (all 14) against the real iframe — this is what turns the C2 claims from string assertions into proof; (c) StrictMode double-srcdoc mount → no false `onNavigatedAway` (runner review F-4); (d) mobile-viewport smoke (375px).

**Design brief (binding — "not another AI-generated app"):**
- Identity: **"snug"** = warm, tactile, confident. Dark-first (deep warm charcoal `#141210`-family, not blue-black), real light theme; one accent family (ember/amber) + per-app `iconColor` gradients; generous radius, soft inner glows, NO glassmorphism clichés, no purple-on-black AI-slop gradient.
- Typography: display serif for brand moments (system `Georgia/'Iowan Old Style'` stack), humanist sans for UI; big confident sizes; real typographic hierarchy.
- Design tokens in one `tokens.css` (custom properties, both themes); zero component libraries; hand-built primitives (Button, Card, Sheet, Rail) in `src/ui/`.
- Motion: 150–250ms ease-out; app tiles lift on hover with color-matched glow; streaming text with a soft caret; the Run view's frame gets a subtle "thinking" border pulse while a request is in flight (driven by onFrame, not fake).
- Voice: microcopy in lowercase-confident tone ("build something", "your apps", "it's thinking…"); every empty state teaches the next action in ≤1 sentence.
- Mobile: fully usable at 375px (rails become sheets); touch targets ≥44px; no hover-only affordances (survey AVOID list is binding: no window.confirm, no hover-reveal actions, skeletons not spinners, parse budget visible).

**Acceptance criteria** (each ≥1 test; E2E via Playwright, units via vitest):
1. Umbrella AC-7 E2E green (build→run→bridge round-trip, mock adapter, no network).
2. `BROWSER_CSP_CHECKS` all pass in Chromium (+ StrictMode navigation case) — C2 real-browser gate.
3. Hub renders artifacts + starter apps; tiles show announce metadata after run (capability reveal unit-tested with runner harness).
4. Inspector shows a frame timeline for a scripted round-trip (unit: feed onFrame events → rendered entries; payloads structural only — test asserts no system-prompt text present).
5. BYOK mode: key never in localStorage (sessionStorage/memory only — test), never sent to the reference server (spy).
6. Theme toggle flips tokens AND posts theme-change to a running app (integration with runner harness).
7. db export button produces a Blob download with SQLite magic (unit with db driver).
8. Examples validate: each parses as single-file HTML, contains the embedded hooks block verbatim (sync with sdk/embedded — script check), announces correctly in a jsdom harness.
9. Lighthouse-ish sanity: bundle < 400KB gz initial (report actual), no CLS-obvious layout jank (manual note), mobile viewport E2E passes.
10. Root `pnpm test` green; playground vitest suite green; `pnpm --filter playground e2e` green locally.

**Out of scope**: share/install links, pin semantics beyond the artifact list, auth teaser card (small "connect account — coming in v1.1" chip allowed, inert), deployment.

## Plan
Workstreams (disjoint): (A) app shell + design system + views + inspector (`apps/playground/src`), (B) examples (`examples/`), (C) e2e harness (`apps/playground/e2e` + playwright config). A is largest; B needs only merged KB/sdk; C wires runner's spec template. Integration by conductor: run suites, review, merge. Deps: vite, @vitejs/plugin-react, react-router-dom, @playwright/test (dev).

## Session journal (append-only, newest last)

### 2026-07-31 — Claude (Fable 5) — session
- Done: task file. Next: build via workflow, integrate, review, merge.
