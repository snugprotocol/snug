# TASK-20260819-desktop-icon-squircle: macOS app icon — squircle, transparent margin, dark niche

- **Status**: in-review
- **Owner**: Jeetu
- **Risk tier**: medium (apps/desktop assets + tests; no protocol/runner/auth surface)
- **Branch**: `fix/TASK-20260819-desktop-icon-squircle`
- **Packages touched**: `apps/desktop` (icon generation script, committed icon set, appIcon test), `docs/code-map.md`
- **Spec impact**: none
- **Related**: TASK-20260804-logo-variants (done — "Ember Niche" mark), TASK-20260813-ui-polish-inspector (done — icon pipeline; its "dock-icon eyeball check" was still queued, and this task is what that check would have caught), lessons 2026-08-04 (outcome-not-proxy: the icon test passed on wrong art)

## Spec (what & why)

The shipped macOS dock icon is wrong three ways: (1) the canvas corners are opaque **white** (Chromium page background baked into the Playwright screenshot); (2) the arched niche renders **white** instead of the intended dark — the `NICHE` backing path in `generate-icons.mjs` is defeated by fill-winding (the inner subpath knocks out under nonzero too), so the page background shows through; (3) the mark is scaled full-bleed edge-to-edge with zero transparent margin, so on the dock it renders as an oversized square with white chips instead of a macOS squircle. Owner decision 2026-08-19: redraw the mac-facing masters on Apple's icon grid — artwork ≈ 824/1024 with ~10% transparent margin on all sides, outer tile at Apple's ~22.4% continuous-corner squircle radius filled ember `#e8873a` edge-to-edge *of the squircle*, niche painted `#171310` to match the web logo's knockout-over-dark-bg look. Windows-facing files stay full-bleed (Windows expects no margin) but must also get the dark niche.

**Acceptance criteria** (each becomes at least one test):
1. Mac-facing files (`icon.png` 512 master, `icon.icns` extracted 512): canvas corners and the outer ~10% margin band are fully transparent (alpha 0).
2. Mac-facing files: pixels just inside the squircle's edge midpoints are ember `#e8873a`; the squircle fills the 824/1024 artwork box.
3. All files (mac + windows): niche interior sample points (center and mid-arch) read `#171310` — not white, not transparent.
4. Windows-facing files (`icon.ico`, `32x32.png`, `128x128.png`, `128x128@2x.png`) remain fully opaque full-bleed with ember at canvas-edge midpoints (current behavior, minus the white niche).
5. `pnpm --filter desktop test` green (tsc-gated vitest incl. rewritten `appIcon.test.ts`); `pnpm --filter desktop gate` still GREEN on macOS.
6. Owner eyeball: dock screenshot showing the icon next to neighbor apps — shape/size reads native (this closes the queued eyeball check from TASK-20260813).

**Out of scope**: web/playground logo and favicon (already correct); Windows gate leg (deliberately RED, ADR-0021 D8); any change to the mark's path geometry in `Logo.tsx`/`favicon.svg`; tauri.conf.json icon list (same six files).

## Plan

Root causes confirmed by pixel sampling (research 2026-08-19): white niche = winding bug on the backing path; white corners = `omitBackground: false`; no margin = deliberate 2026-08-13 full-bleed instruction, now reversed by owner for mac-facing files. `tauri icon` does NOT add margin or squircle — it only resizes the source, so the margin/shape must be baked into the master(s). One `tauri icon` run takes one source ⇒ two masters means two invocations with selective keep.

Files to touch, in order:
1. **`apps/desktop/src/__tests__/appIcon.test.ts`** — tests FIRST (Gate 3). Rewrite as per-file assertion groups: mac-facing (transparent corners + transparent margin band + ember inside squircle edge + `#171310` at niche samples) and windows-facing (opaque full-bleed + ember edge midpoints + `#171310` at niche samples). All new assertions must FAIL against the currently committed icons (white niche fails AC3 for every file; opaque corners fail AC1) — run and record the red.
2. **`apps/desktop/scripts/generate-icons.mjs`** —
   - Fix the niche: paint an explicit `#171310` shape behind the ember path (clipped to the tile outline so no dark leaks past the squircle/tile edge), keeping the ember path evenodd on top. Do not rely on winding of the existing backing path.
   - Mac master: compose on Apple's grid — 1024 canvas, artwork box 100..924, outer squircle at ~22.4% continuous-corner radius filled ember, niche knocked to the dark plate; screenshot with `omitBackground: true`.
   - Windows master: full-bleed composition (as today) with the fixed dark niche, opaque.
   - Run `tauri icon` twice (once per master), keep `icon.icns` + `icon.png` from the mac run, `icon.ico` + `32x32.png` + `128x128.png` + `128x128@2x.png` from the windows run, prune the rest. Correct the header comment claiming `tauri icon` produces the macOS safe area (it doesn't).
3. Regenerate `apps/desktop/src-tauri/icons/*` (6 files) — commit the regenerated binaries.
4. **`docs/code-map.md`** line ~50 — correct the icon-generator entry (two masters, margin baked in master, per-file test groups).

Test plan: step 1 red first → implement → `pnpm --filter desktop test` green → `pnpm --filter desktop gate` (macOS) → build the app and take a dock screenshot for AC6. Note CI is billing-blocked (next-steps 2026-08-19) — evidence is local; record commands + results in the journal.

Cross-package impact: none — `apps/desktop` consumes packages, nothing consumes it. No protocol change ⇒ no spec-sync.

## Decisions & surprises

- 2026-08-19 owner: Apple squircle radius (~22.4%) for mac-facing masters, not the brand mark's native ~28.6% — dock consistency wins; the brand shape stays canonical everywhere else.
- 2026-08-19 owner: niche = `#171310` (the dark theme `--bg` the web knockout shows), described as "black" in the ask.
- The 2026-08-13 "cover it completely" full-bleed instruction is superseded for mac-facing files only; Windows keeps full-bleed.

## Session journal (append-only, newest last)

### 2026-08-19 — Claude (with Jeetu) — session
- Done: research (icon pipeline root-cause: winding bug ⇒ white niche; omitBackground:false ⇒ white corners; full-bleed ⇒ no squircle margin), owner interview (4 decisions), spec + plan written, branch cut.
- State: planned — awaiting owner plan approval before Gate 3.
- Next step: on approval, rewrite `appIcon.test.ts` (red), then fix `generate-icons.mjs`, regenerate, verify, dock screenshot.
- Open questions: none blocking.

### 2026-08-19 — Claude — session (implementation)
- Done: rewrote `appIcon.test.ts` per-platform (16 assertions; 9 red against the shipped set — white niche confirmed as rgba(255,255,255,255) at the sampled centre). Rewrote `generate-icons.mjs`: two masters (mac Apple-grid squircle w/ transparent margin + win full-bleed on opaque `#171310` plate), niche dark as a solid single-subpath layer (winding-proof), `omitBackground: true`, `tauri icon` per master with the six shipped files copied explicitly. Regenerated all six binaries. Corrected `docs/code-map.md` icon entry.
- Evidence (all local — CI billing-blocked): `vitest run appIcon.test.ts` 16/16 green; `pnpm --filter desktop test` 128/128 green; `pnpm --filter desktop gate` ✓ GATE GREEN. AC6: dock-style preview (dark + light) rendered and sent to owner — squircle radius matches neighbors, niche `#171310`, no white.
- State: implementation complete on `fix/TASK-20260819-desktop-icon-squircle`; awaiting owner dock check on a real build + PR review.
- Next step: owner eyeball on hardware (`pnpm --filter desktop tauri build` or dev run), then PR.
