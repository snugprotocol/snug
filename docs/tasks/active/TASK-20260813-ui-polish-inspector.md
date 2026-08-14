# TASK-20260813-ui-polish-inspector: header wordmark, desktop icon, resizable inspector, connection UX

- **Status**: in-progress (plan approved 2026-08-13)
- **Owner**: Jeetu
- **Risk tier**: **medium**
- **Branch**: `fix/TASK-20260813-ui-polish-inspector`
- **Packages touched**: `apps/playground` (all UI work), `apps/desktop` (icon assets + generator), `packages/adapters` (one `try`/`catch` in `agent-turn.ts` — see AC7)
- **Spec impact**: none — no `packages/protocol` schema changes, no `packages/runner` sandbox/CSP change, no `packages/auth` change
- **Related**: [ADR-0012](../../decisions/), TASK-20260804-logo-variants (mark provenance), TASK-20260812-desktop-auth-awareness (connection wizard surfaces)

## Spec (what & why)

Six owner-reported UI defects, all in the playground shell and run view (the desktop client renders
the *same* `apps/playground` `App` under a `HashRouter`, so one fix covers both clients). Five are
bugs with identified root causes; item 5 is a UX gap plus a design upgrade.

The through-line: the run view's "watch it think" rail is a hard 340px, which makes large payloads
unreadable; the connection story has no entry point once an app is connected; and two pieces of
chrome (wordmark, app icon) are visibly clipped.

**Risk tier rationale — Medium, not High.** No auto-escalation trigger is met: nothing touches
`packages/protocol` schemas, `packages/runner` sandbox/CSP, `packages/auth`, C1/C2, or publish/CI
config. Item 5 adds a *caller* of the existing `openConnectionWizard*` API but changes no
credential path. `apps/playground` is explicitly Medium in PROCESS.md's tier table.

**The one thing to weigh at approval:** fixing AC7 properly requires a small change in
`packages/adapters` (`agent-turn.ts`), which `server` and `playground` both consume. That is
Medium, not High (adapters is not in the High list), but it is the only change here that can
affect turn behaviour rather than pixels — so it gets its own failing tests at the adapter level
and the full dependents run at Gate 5. If you'd rather keep this task pixels-only, say so and
I'll fix only the render-side half (key + `startedAt` anchor) and split the adapter fix into its
own task — but note the stuck timer you reported will still occur on a thrown/aborted call.

**Acceptance criteria** (each becomes at least one test):

1. **AC1 — wordmark descender.** The "snug." wordmark in the shell header renders its `g`
   descender uncut at both `--text-brand` and `--text-brand-narrow`. Guard: `.brand` no longer
   sets `line-height: 1`, and `.brand-word` no longer clips its descender.
2. **AC2 — wordmark still truncates.** The overflow/ellipsis behaviour that `overflow: hidden`
   was there for still holds: a constrained `.brand` ellipsizes horizontally rather than
   overflowing the header.
3. **AC3 — desktop app icon is full-bleed.** Every file in `apps/desktop/src-tauri/icons/`
   has its artwork filling the canvas: the opaque plate covers 100% of the bitmap (corner pixels
   opaque) and the mark is centred, matching `apple-touch-icon.svg`'s composition.
4. **AC4 — inspector width is user-controlled.** The rail is resizable by dragging a divider
   between the app stage and the rail; the chosen width persists across reloads and is clamped to
   sane bounds.
5. **AC5 — inspector content fits.** Round-trip payload blocks wrap on whitespace and never
   degrade to one-character-per-line, and the rail body produces no horizontal scrollbar at the
   default width.
   **Outcome (2026-08-13): MET, after the owner supplied a repro.** My first pass declared this
   unreproducible — I had probed the wrong element. The collapse is in the round-trip **summary
   line**, not the `<pre>` payload block. See the journal entry below.
6. **AC6 — inspector toggle.** An icon button toggles the "watch it think" rail off and back on;
   default is **on**; the state persists across reloads.
7. **AC7 — live timer stops.** When a round trip settles, its elapsed figure freezes at the
   recorded `durationMs`; no interval survives the pending→done transition, and starting the next
   round trip does not resume a previous entry's timer.
8. **AC8 — timer identity.** Round-trip list items are keyed by a stable identity, so eviction of
   older entries cannot transplant one entry's timer state onto another.
9. **AC9 — manage-connections button.** An app with at least one connection row shows a
   connections control in the `run-header` (beside export / theme) whenever rows exist — connected
   **or not** — and it opens the connection wizard for that app. An app with no connection rows
   shows no such control.
10. **AC10 — connection surfaces redesigned.** The three red `.error-note` banners
    (`AuthRepairBanner`, the net-error CTA, `ConnectionWizardNote`) get a calm, on-brand treatment:
    a *needs-connection* state is visually distinct from a genuine *failure*, and `--danger` is
    reserved for the latter. Each keeps exactly one clear primary action plus a quiet dismiss.
    Existing `role="alert"` semantics and every `data-testid` in the map are preserved.
11. **AC11 — frames section removed.** The "app ↔ host frames" section no longer renders anywhere;
    `ThinkPanel` shows only the LLM round trips.

**Out of scope**
- Rewriting the connection **wizard** itself (steps, copy, credential handling) — only its entry
  points and the pre-wizard gate screen change.
- Any change to `inspector.ts`'s value-blind reducer semantics (see the removal note below).
- Mobile sheet redesign; the rail divider is a ≥760px affordance (the sheet already covers mobile).
- Re-theming the whole app; item 5's "flagship Apple polish" is scoped to the connection surfaces.

## Root causes (verified in code, not assumed)

| # | Root cause | Evidence |
|---|---|---|
| 1 | `.brand` sets `line-height: 1` so the line box equals the em box and the descender falls outside it; `.brand-word`'s `overflow: hidden` (present for the ellipsis) turns that overflow into a visible cut. `--font-display` is a serif with a deep `g` tail, which makes it obvious. | `apps/playground/src/theme/app.css:35`, `:51`; `tokens.css:77` |
| 2 | The committed icons are one hand-made, mis-composed source scaled six ways: the opaque plate covers only ~the top-left 60% of the canvas and the mark sits inset within *that*, so the mark occupies ~a quarter of the tile. No `.iconset`, no generation script — nothing regenerates them. | `apps/desktop/src-tauri/icons/*` (rendered + `sips` verified); no generator in `scripts/` |
| 3 | `.rail` is a hard `width: 340px`, leaving ~280px of text column. `.llm-block` *already* has `white-space: pre-wrap`, so the collapse is **not** a missing-wrap bug: it is `overflow-wrap: anywhere` (which, unlike `break-word`, reduces **min-content width**) inside a chain of column-flex ancestors that never declare `min-width: 0` — `.rail-body`, `.think-panel`, `.llm-inspector`, `.llm-list`, `.llm-entry-body`. The intrinsic width collapses toward one glyph and `.rail { overflow: hidden }` hides the evidence. | `app.css:272-280`, `:298`, `:854`, `:929`, `:1026`, `:1060-1071` |
| 4 | **Two independent causes, both real.** (a) *Identity*: `RoundTrip` is keyed `` `${entry.index}-${index}` ``, but `evict()` shifts every survivor's array position, so the key changes for an unchanged entry and React reuses/remounts `LiveTimer` across identity boundaries. `entry.index` is already unique, so the positional half is the bug. (b) *`pending` never flips* — the dominant cause: `agent-turn.ts:134` awaits `adapter.complete()` with **no `try`/`finally`**, so a throw/reject (webllm adapter throws; abort rejects) skips the `round_trip` emit at `:143` and the entry created at `:133` stays `pending: true` forever. There is no `onTurnEnd` counterpart to `onTurnStart`, so a stale pending entry survives until the next turn resets. Separately, `LiveTimer` measures from **its own mount**, not the round trip's start, so a remount restarts the clock at 0. | `LlmInspectorPanel.tsx:229`, `:63-75`; `packages/adapters/src/agent-turn.ts:130-143`; `llmInspector.ts:348,356` |
| 5 | No component renders a connections entry point in `run-header`; `openConnectionWizardForApp(appId, source)` already exists and is imported into `RunView` (`:21-26`) but called only from directive/error paths — so **no new imports or state plumbing are needed for the button**. `RunView` does not currently read `ConnectionRow` at all, so the gating read (`db.listConnections(id)`) is genuinely new — patterns to copy: `ConnectionSlotsCard.tsx:109-123` (all rows) and `AuthRepairBanner.tsx:36-49` (single slot). **Correction to the report's premise:** there is no maroon token and no full-page gate anywhere — `grep` for maroon/crimson/dark-red hexes returns zero hits outside build artifacts. What the owner is seeing is `.error-note` (`--danger` `#bf4530` in light theme, the closest thing to maroon) used for *all three* connection surfaces, including ones that are not failures. | `RunView.tsx:558-584,619,644-651`; `app.css:717-724`; `tokens.css:35-36,67-68`; `state/connectionWizard.ts:196` |
| 6 | The frames section is composed in `ThinkPanel`; the feed itself (`inspector.ts`) is a separate value-blind reducer wired into the runner's frame callback. | `ThinkPanel.tsx:44-46`, `InspectorPanel.tsx` |

**Note on the AC11 removal — there is a real byte-lock guarding this.**
`__tests__/railTabs.test.tsx:110-128` runs `git diff --exit-code` against `run/inspector.ts` and
`__tests__/inspector.test.ts` and **fails if either changes by a single byte**; `:180-196` asserts
the section order is exactly `['llm','frames']` with both headings; `:211-221` asserts the live
rail renders both sections; `:284-290` records locked-file hashes. Removing the frames section
therefore *requires* updating `railTabs.test.tsx` — this is a deliberate, recorded supersession of
a prior task's AC10/AC11, not a test being weakened to get green (TDD.md rule 4). The byte-lock
existed to stop a *visual* merge becoming a *real* one; that intent survives, because:

**`inspector.ts` and its wiring stay byte-for-byte intact.** Three live consumers read that same
reducer state and would break silently if the feed were deleted with its view:
- `inspector.inFlight` → the app-iframe "thinking" pulse (`RunView.tsx:698`)
- `inspector.sawDbOp` → gates the `export .sqlite` button (`RunView.tsx:426-429, 644-648`)
- `readySeen` ← set from the same `onFrame` hook (`RunView.tsx:408`)

Scope line: delete the meaningless **view**, keep the reducer and every signal other UI depends on.

## Plan

Tests first throughout (TDD.md); each AC gets at least one test, and the two bug fixes (AC7/AC8,
AC1) get regression tests that are **shown red before the fix**.

### Order of work

**Phase A — chrome fixes (AC1–AC3)**
1. `apps/playground/src/__tests__/brandWordmark.test.tsx` (new) — assert the computed
   `.brand`/`.brand-word` rules no longer clip descenders; assert ellipsis behaviour survives (AC2).
2. `apps/playground/src/theme/app.css` — `.brand`: drop `line-height: 1` for a descender-safe value;
   `.brand-word`: keep `text-overflow: ellipsis` + `white-space: nowrap` while giving the descender
   room. Both axes of `overflow` cannot differ (a non-`visible` axis forces the other to `auto`), so
   the fix is padding-bottom + matching negative margin, not `overflow-y: visible`.
3. Desktop icons: add `apps/desktop/scripts/generate-icons.mjs` that renders a 1024×1024 source
   from the **existing correct composition** (`apple-touch-icon.svg`, full-bleed plate + centred
   mark) and shells out to `tauri icon` (`@tauri-apps/cli` is already a desktop devDependency) to
   emit the whole set. Committing a generator, not just fixed bitmaps, is the point — the current
   defect exists precisely because the icons were hand-made once with nothing to regenerate them.
4. `apps/desktop/src/__tests__/appIcon.test.ts` (new) — AC3: decode each committed PNG and assert
   corner pixels are opaque (full-bleed) and the artwork is centred.

**Phase B — inspector (AC4–AC8, AC11)**
5. Timer tests first, at the altitude where the decision is made (lessons.md 2026-08-05):
   - `packages/adapters/src/__tests__/agent-turn.test.ts` — a `complete()` that **throws**, and one
     that **aborts**, must still emit a terminal event for the started round trip. This is the
     regression test for the dominant cause and must be seen RED first.
   - `apps/playground/src/__tests__/llmInspectorPanel.test.tsx` — drive a real pending→settled
     transition and assert the elapsed figure freezes (AC7); drive enough entries to trigger
     `evict()` and assert no timer transplant (AC8).
   Both get mutation-checked ("would this fail if the code were wrong?") before the fix lands.
6. `packages/adapters/src/agent-turn.ts` — wrap the `adapter.complete()` await in `try`/`catch` so
   a throw or abort emits a terminal `round_trip` (error outcome) for the entry `round_trip_start`
   opened. **This is the one shared-package change in the task** and the reason for the tier note
   below.
7. `LlmInspectorPanel.tsx` — key by `entry.index` alone; anchor `LiveTimer` to the entry's real
   start (add `startedAt` to `LlmInspectorEntry`) so a remount or tab-switch cannot restart the
   clock at 0; ensure the settled branch renders `durationMs`.
8. Rail resize + toggle: new `apps/playground/src/ui/RailDivider.tsx` (pointer-drag, keyboard
   accessible via arrow keys with `role="separator"` + `aria-valuenow`), rail width and
   visibility persisted in `localStorage` alongside the existing `snug:theme` convention.
   `.rail`'s literal `width: 340px` becomes a `--rail-width` custom property driven by that state,
   clamped (min ~280px, max ~70vw). Toggle button lives in `run-header`. Watch the fragile bits
   flagged in the map: the negative `margin` (`app.css:732`) and the hard-coded `73px`/`61px`
   header offsets (`:731`, `:1183`).
9. `app.css` (AC5) — add the missing `min-width: 0` to the column-flex chain (`.rail-body`,
   `.think-panel`, `.llm-inspector`, `.llm-list`, `.llm-entry-body`) and switch `.llm-block` from
   `overflow-wrap: anywhere` to `break-word` with `overflow-x: auto`, so intrinsic width stops
   collapsing. `pre-wrap` is already correct and stays.
10. Remove the frames view (AC11): delete `run/InspectorPanel.tsx`, drop the `frames` section and
    prop from `ThinkPanel.tsx`, remove `.inspector-list`/`.inspector-entry` CSS (`app.css:882-925`),
    update `RunView.tsx`'s `ThinkPanel` call site — **keeping** `inspector.ts` and its
    `inFlight`/`sawDbOp`/`readySeen` wiring. Update `railTabs.test.tsx`'s superseded section-order
    and hash assertions (see the supersession note above).

**Phase C — connection UX (AC9, AC10)**
11. Tests first: an app with ≥1 connection row renders the header control and clicking it opens
    the wizard on that app; an app with zero rows renders nothing; an app with several slots opens
    the picker rather than guessing a slot (AC9). A needs-connection state renders the calm
    surface and a genuine failure stays visually distinct (AC10).
12. `RunView.tsx` — add the connections control to the `run-header` action cluster (`:619`) beside
    export / theme, calling the already-imported `openConnectionWizardForApp(id, 'settings')`.
    Gating reads `db.listConnections(id)`; per AC9 it shows whenever rows exist regardless of
    status, so "connected" apps get the manage entry point the owner asked for. **Starter caveat:**
    a not-yet-installed starter has no persisted rows (its declaration is a bundled manifest), so
    it is gated like the existing install/disclosure controls (`isStarterId(id)`, `:628,:633`)
    rather than showing a control that would open an empty wizard.
13. Restyle the three connection surfaces (AC10): `AuthRepairBanner.tsx:57`, the net-error CTA
    (`RunView.tsx:559`), `ConnectionWizardNote.tsx:24`. Introduce a calm `.connection-note`
    treatment (neutral surface, ember accent) for *needs-connection*, keeping `.error-note` and
    `--danger` for genuine rejection/failure. Preserve `role="alert"` and every `data-testid`
    those suites assert on (`authShapedFailureSurface`, `netErrorCtaVisibility`,
    `connectionWizardGuards`).

### Cross-package impact
Per the dependency graph in [architecture.md](../../architecture.md): the UI changes are leaves
(`apps/playground`, `apps/desktop`) — nothing depends on them. The `packages/adapters` change is
**not** a leaf: `apps/server` and `apps/playground` both consume it, so per TDD.md's dependents
rule both get run explicitly, not just the root suite.

### Test plan
- Package suites: `pnpm --filter @snugprotocol/adapters test`, then its dependents
  `pnpm --filter server test` and `pnpm --filter playground test`, plus
  `pnpm --filter desktop test`; then root `pnpm test`. These `test` scripts are `tsc`-gated
  (code-map note, 2026-08-11), so green means it compiles too.
- New/changed test files: `brandWordmark.test.tsx`, `appIcon.test.ts`, `agent-turn.test.ts`
  (extended — throw/abort terminal event), `llmInspectorPanel.test.tsx` (extended — AC7/AC8),
  `railResize.test.tsx`, `connectionHeaderControl.test.tsx`, `connectionGate.test.tsx`, plus the
  superseded assertions in `railTabs.test.tsx`.
- `e2e/mobile.spec.ts:56` and `e2e/helpers.ts:8-14` pin the rail's selector contract
  (`role=button "open inspector"`, `aria-label "watch it think"`, `data-testid="frame-wrap"`) —
  the toggle/divider must preserve those names or update both in the same commit.
- Manual verification the owner must do (cannot be automated here): the built desktop icon on a
  real dock/taskbar, and the rail drag feel on a real trackpad.

### Spec-sync
Not applicable — `packages/protocol` is untouched, so no [SPEC_SYNC.md](../../engineering/SPEC_SYNC.md)
step and no [spec-changelog](../../spec-changelog.md) entry.

### ADR
One decision is worth recording if approved: **the rail becomes user-sized and dismissible, and
the frames view is deleted while its reducer is retained**. Draft as ADR-0024 at Gate 6.

## Decisions & surprises

- The desktop client has no header of its own — it mounts the playground `App`. Item 1's "fix on
  all clients" is therefore a single CSS change, not two.
- The correct icon composition already exists in `apple-touch-icon.svg`; the desktop icons are the
  outlier. Fixing by regenerating from the good source (via a committed script) rather than
  redrawing.
- Item 4's timer bug is **not** a missing `clearInterval` — `LiveTimer`'s cleanup is sound and the
  reducer settles entries correctly. It is two defects layered: a positional React key that
  `evict()` invalidates, and (dominant) `agent-turn.ts` skipping its terminal emit when
  `complete()` throws or aborts, leaving `pending: true` forever. My first read blamed the key
  alone; the adapter path is the bigger half and is why this task touches `packages/adapters`.
- Item 3 is likewise not a missing wrap — `pre-wrap` is already set. It is `overflow-wrap: anywhere`
  (which lowers min-content width) with no `min-width: 0` anywhere in the column-flex chain.
- Item 5's "maroon page" is `.error-note` (`--danger` `#bf4530` light). No maroon token and no
  full-page connection gate exist; the surfaces are three banners. The UX gap is real, but the
  redesign target is those banners, not a page that was never built.
- Item 6's section is guarded by a genuine `git diff --exit-code` byte-lock in `railTabs.test.tsx`.
  Updating it is a recorded supersession, and the reducer stays because three live signals
  (`inFlight`, `sawDbOp`, `readySeen`) read it.

## Session journal (append-only, newest last)

### 2026-08-13 — Jeetu — session
- Done: Gate 1 spec + Gate 2 plan. Read PROCESS/TDD/lessons/code-map and the actual code; traced a
  verified root cause for all six items (table above) rather than working from the symptoms.
  Branch `fix/TASK-20260813-ui-polish-inspector` cut off `main`.
- State: **awaiting plan approval — no implementation code written.**
- Next step: on approval, Phase A tests first (red), then Phase A implementation.
- Open questions: the four in the approval message — rail persistence scope, icon plate colour in
  light theme, whether the connections control should also appear for *connected* apps (planned:
  yes), and how far to take the "flagship" restyle of the gate.

### 2026-08-13 — Jeetu — session (plan approved, Phases A + B-timer)
- Done — **AC1/AC2** (`22d8bad`): `.brand` `line-height: 1` → `1.25` plus a padding/negative-margin
  pair on `.brand-word` that extends the clip box under the baseline without moving the lockup.
  Both `overflow` axes must share a value, so `overflow-y: visible` was not available. Verified in
  real Chromium: clip box 32px / padding 0 before, 44px / 3.84px after; screenshot shows the `g`
  tail whole. Desktop mounts the same `App`, so both clients are covered by the one change.
- Done — **AC3** (`c20776e`): committed `apps/desktop/scripts/generate-icons.mjs` (renders the
  canonical mark via Playwright's Chromium → `tauri icon`) and regenerated all six shipped icons.
  **Correction to the plan's root cause:** the canvas was opaque black throughout — this was a
  scale/position defect (mark at x 116..497 of 1024, gap 116 left vs 526 right, ~37% of the tile),
  not the transparency defect the pre-read suggested. My corner/edge tests passed on the OLD art
  and only the centring test went red, which is what surfaced the correction. The generator prunes
  the mobile/store matrix `tauri icon` emits but this desktop-only app never ships, so re-running
  is idempotent. `appIcon.test.ts` decodes PNGs inline (`node:zlib`, no new dependency).
- Done — **AC7 adapters half** (`0d32919`): `runAgentTurn` awaited `adapter.complete()` with no
  `try`/`catch`, so a rejection skipped the `round_trip` emit and left the entry opened by
  `round_trip_start` pending forever — the reported "timer keeps running as it moves to the next
  call". Rejections now convert to `ok:false` (abort → `CANCELLED`, not retryable) so the existing
  `!result.ok` branch still preserves partial text. Four tests, all seen RED first.
- Done — **AC7/AC8 render half** (`f3e0a22`): keyed `RoundTrip` by `entry.index` alone (the
  positional suffix changed identity whenever `evict()` shifted the array); added `startedAt` to
  the entry so `LiveTimer` measures the CALL, not its own mount — the rail's tab strip unmounts
  the subtree, which restarted a long call's display at 0. Mutation-checked: reverting to
  mount-relative timing renders `0ms` for a 90s call and the guard fails.
- State: suites green — adapters 124, server 126, desktop 101, playground 983. Items 1, 2 and 4
  are done end-to-end.
- Next step: AC11 (remove the frames view + update the `railTabs.test.tsx` byte-lock), then AC4–AC6
  (rail divider, toggle, wrap fix), then Phase C.
- Open questions: none blocking. The four approval questions were answered — global rail
  persistence, connections control shown whenever rows exist, restyle scoped to the three banners.

### 2026-08-13 — Jeetu — session (Phases B + C complete; all 11 ACs implemented)
- Done — **AC11** (`842ba55`): deleted `InspectorPanel.tsx`, the `ThinkPanel` frames section and
  prop, the `RunView` call-site arg, and `.inspector-list`/`.inspector-entry` CSS. Kept
  `inspector.ts` byte-for-byte — the `railTabs.test.tsx` byte-lock still passes untouched, because
  what it defends (two separate, value-blind reducers) is unaffected by dropping a view. Added a
  test that the FEED survives, since `inFlight`/`sawDbOp`/`readySeen` gate two unrelated features
  and the obvious follow-up cleanup is exactly the wrong move.
- Done — **AC4/AC6** (`1e689a2`): new `state/railLayout.ts` (clamped, persisted, global) and
  `ui/RailDivider.tsx`. `.rail`'s literal 340px became `var(--rail-width)`. Pointer events +
  `setPointerCapture`, plus an `is-resizing` class that disables pointer events on the app frame —
  capture does NOT cross into a cross-origin iframe, which is the classic splitter-over-iframe
  failure. Keyboard-operable (`role="separator"`, arrows/Home/End). Toggle defaults ON; only the
  literal string `'false'` hides it, so a corrupted key fails safe.
- Done — **AC9/AC10** (`cea9e4a`): connections button in `run-header`, gated on the app having
  rows (any status) and re-read on `connectionWizardRevisionStore` so a first connection reveals it
  without a reload; starters excluded (no persisted rows → empty wizard). New `.connection-note`
  calm surface for needs-connection, with an `is-error` variant keeping `--danger` for genuine
  rejection — same structure, different temperature. One existing assertion that pinned the old
  sentence verbatim was rewritten to assert its intent (provider named + status shown).
- **AC5 — scope corrected, and this is the one thing to know.** The plan blamed
  `overflow-wrap: anywhere` + a missing `min-width: 0` chain. I could not reproduce the
  one-character-per-line collapse in ANY constructed context: a browser harness at the rail's
  340px, at 820/780px viewports, and in the builder's `<details>` context all measured ~35 and ~96
  chars per line **before** any change. So the CSS shipped under AC5 is defensive hardening
  (both hazards are real, and they matter more now that the width is variable), **not** a
  reproduced fix, and the test comments say exactly that rather than claiming a locked defect.
  The real fix for the unreadable panel is AC4 — the user can now give the payload the width it
  needs. If the owner can reproduce the collapse, capture the app/payload and it gets its own task.
- **Live verification** (dev server + real Chromium, not just jsdom): wordmark clip box 44px with
  the `g` whole; rail 340 → **541px** by dragging the divider left 160px; toggle hides the rail
  (`.rail` count 0) and restores it at 541px; **541px survives a reload** (`snug:rail-width=541`).
  Screenshot confirms the frames section is gone, no horizontal scrollbar, and the header carries
  `export .sqlite` / `☀ light` / `◨ hide` together.
- State: **Gate 5 green — root `pnpm test` 21/21 tasks pass** (playground 1011, adapters 124,
  server 126, desktop 101). All 11 ACs implemented; every bug fix mutation-checked.
- Next step: owner review. Then Gate 6 — ADR-0024 for the rail decision + frames-view removal,
  lessons entry, `docs/code-map.md` regeneration, PR.
- Open questions: (1) can the owner reproduce the one-char-per-line collapse, and where? (2) the
  desktop icon needs eyeballing on a real dock/taskbar — `pnpm --filter desktop bundle` is
  unbuilt here.

### 2026-08-13 — Jeetu — session (owner screenshots; two of my findings were wrong)
Owner returned with a dock screenshot and two inspector screenshots. Both reports were correct
and both had been mis-diagnosed by me.

- **AC5 — the collapse is REAL and I probed the wrong element** (`dfd6751`). It is not the `<pre>`
  payload block; it is the round-trip **summary line**. `.llm-summary` (`flex: 1`) shares a flex
  row with `.llm-meta` (`flex-shrink: 0`), and the meta text — "1.9s · 2,393 in · 66 out · 0%
  cached" — measures ~260px. In a 340px rail the meta claims the row and refuses to yield, so the
  summary is squeezed to min-content, which `overflow-wrap: anywhere` permits to be **one glyph**.
  Measured before: **7px wide × 342px tall**. After: **235 × 18**.
  Fixed three ways together: the head now WRAPS (meta drops to its own line rather than starving
  the summary), the summary gets a real `flex-basis`, and `break-word` replaces `anywhere` so
  min-content can never fall to one character again.
  **Process lesson (promote at Gate 6):** my earlier "unreproducible" verdict came from asserting
  CSS *text* and from probing an element I assumed was at fault, in a harness that never rendered
  the failing one. jsdom returns 0×0 for every rect, so no unit test could have caught this. The
  new `e2e/inspector-layout.spec.ts` measures the rendered box at 280/340/520px rails and is
  mutation-checked — reverting the CSS fails with "the summary collapsed to ~1 characters per
  line". **A layout bug needs a layout test; a property assertion is not evidence.**
- **AC3 — "centred" was not what was asked for** (`dfd6751`). My first pass put the mark on a dark
  plate at 61% of the tile, copying `apple-touch-icon.svg` — where the plate is load-bearing
  because iOS squares off transparency. On a desktop dock that reads as a small logo adrift in a
  dark square. The mark is *already* a tile (a rounded square spanning units 2..30 of a 32
  viewBox), so it now scales to fill the canvas edge to edge, with the niche painted in the dark
  ground behind it rather than punched through to the wallpaper.
  **Test lesson:** the old centring assertion passed on BOTH compositions — symmetry is satisfied
  by any concentric mark — so it never measured the owner's actual requirement. Replaced with an
  edge-reach + ≥95% width-coverage assertion, mutation-checked against the plate version.
- Live re-verification at the owner's exact 340px rail: summary renders **32 chars/line, 18px
  tall**; icon fills the tile.
- State: suites green — 21/21 root tasks, desktop 105, playground 1011.
- Next step: owner re-check of the dock icon on real hardware, then Gate 6.

### 2026-08-13 — Jeetu — session (AC7, third and final path: index collisions)
Owner hit the stuck timer AGAIN on the running desktop app. The first two fixes were real but
neither was the cause of what he kept seeing. **Two more causes, both fixed** (`4882f13`):

1. **The app transport never reset the inspector.** `RunView` feeds TWO independent turn sources
   into ONE reducer: `useBuilderChat` (which resets via `onTurnStart`) and `createAppTransport`
   for the app's own turns — a Chess move — which was given `onLlmEvent` but **no `onTurnStart`**.
   Builder turns reset; app turns appended forever. This is the same class of wiring bug
   `appTransportRoundTrips.test.ts` was created for, one seam over.
2. **`settleEntry` matched the wrong entry.** `agent-turn.ts` numbers round trips from 0 per
   TURN, so accumulated entries collide on `index`. The plain `.find()` returned the **oldest**
   entry at that index — already settled — so the completion was spent re-settling it (silently
   overwriting its duration) while the newer entry stayed `pending: true` **forever, ticking**.
   Now prefers the oldest UNSETTLED entry, so N starts and N completions drain one-for-one.

The reducer change is the backstop; the `onTurnStart` wiring removes the accumulation that made
collisions likely. Both are needed — either alone leaves a reachable path.

Reproduced first as a failing reducer test (two entries at index 0, one stuck pending), all three
new guards mutation-checked, then verified against the **running desktop dev server** via its
`/@fs/` module graph: both collision shapes now yield `pending: 0` with durations `[10, 50]`
intact. Playground 1014, root 21/21.

**Lesson for Gate 6 (this is the third sighting of one symptom):** "the timer keeps running" had
THREE independent causes, and I twice declared it fixed after closing one. When a symptom has a
shared final surface (here: `pending: true` drives a ticker), enumerate every producer of that
state before claiming the fix — a green suite after closing one producer proves only that one
producer is closed. The honest test is the one that asks "what else can leave this state set?"

### 2026-08-14 — Jeetu — close-session (Gate 6)

- **Done, all 11 ACs across 6 owner-reported items.** 13 commits on
  `fix/TASK-20260813-ui-polish-inspector`. Wordmark descender (AC1/AC2), desktop icon (AC3),
  resizable + dismissible think rail (AC4/AC6), payload/summary readability (AC5), stuck timer
  (AC7/AC8 — three separate causes), connections door + calmer connection surfaces (AC9/AC10),
  frames view removed (AC11).
- **Three findings of mine were wrong and were corrected on owner evidence** — recorded here
  because the corrections are the durable part:
  1. AC3 "centred on a plate" was not what was asked; the logo had to BE the icon. My symmetry
     assertion passed on both compositions, so it never measured the requirement.
  2. AC5 was declared unreproducible from CSS-text assertions; the collapse was real and lived in
     the round-trip **summary line**, not the `<pre>` payload block I kept probing.
  3. AC7 was declared fixed twice before the actual cause (index collisions from an app transport
     that never reset) was found.
- **State:** working tree clean, branch green — root `pnpm test` 21/21 tasks (playground 1014,
  adapters 124, server 126, desktop 105). Every bug fix mutation-checked; the two layout/visual
  claims verified in real Chromium, and the timer fix verified against the running desktop dev
  server.
- **Next step (single):** merge the PR, then re-run `pnpm --filter desktop bundle` on real
  hardware and eyeball the dock icon.
- **Open questions:** none blocking. One unverified-by-me item remains: the desktop icon has been
  verified at the pixel level but never seen on a real dock/taskbar (no bundle built in this
  environment).
