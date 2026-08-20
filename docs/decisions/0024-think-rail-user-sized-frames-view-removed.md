# 0024 — The think rail is user-sized and dismissible; the frame view is deleted while its feed lives on

- **Status:** accepted (2026-08-14, at the close of TASK-20260813-ui-polish-inspector).
- **Date:** 2026-08-13
- **Task:** TASK-20260813-ui-polish-inspector

## Context

Three owner reports about the "watch it think" rail arrived together, and they turned out
to share one root: the rail was **a fixed 340px, always present, showing two feeds**.

- Large payloads were unreadable. A full system prompt and pretty-printed JSON have to
  fit in ~280px of text column after padding, and the round-trip summary line collapsed
  outright — `.llm-summary` (`flex: 1`) shared a row with `.llm-meta` (`flex-shrink: 0`),
  whose ~260px of metrics claimed the row and squeezed the summary to a one-glyph
  min-content, rendering `claude-sonnet-5` as a 15-row vertical stack.
- The panel competed with the app for width with no way to yield, on any screen.
- The second feed — the **app↔host frame timeline** — was reported as meaningless. It is
  value-blind *by design* (a privacy guarantee: `inspector.ts` never captures payloads),
  so it rendered frame TYPES with no values: unusable as a debugging aid and
  uninformative as narrative.

A previous task (`TASK-20260804-observability-caching`, AC10/AC11) had deliberately
**merged** those two feeds into one rail tab and locked `run/inspector.ts` byte-for-byte
with a `git diff --exit-code` test, precisely so that a *visual* merge could never become
a *real* one. Removing the frame section means superseding that task's AC10 assertions —
which is why this is an ADR rather than a quiet edit.

## Decision

1. **The rail width is user-controlled and persisted.** `.rail`'s literal `340px` becomes
   `var(--rail-width)`, driven by `state/railLayout.ts` (clamped to `[280px, 70vw]`) and
   mirrored onto the document like the theme. A `RailDivider` (`role="separator"`) drags
   it; double-click restores the default.

   Three consequences that are part of the decision, not incidental:
   - **Global, not per-app.** The rail is a workspace preference like the theme. Someone
     who widens it to read a long prompt wants it wide for the next app too.
   - **The drag must disable pointer events on the app frame.** `setPointerCapture` does
     NOT cross into a cross-origin document, so without `.run-layout.is-resizing` the
     iframe swallows the pointer the moment the cursor leaves the 6px handle and the drag
     dies mid-screen. This is the classic splitter-over-iframe failure and it is
     load-bearing.
   - **Keyboard-operable.** A control that decides whether a panel is legible cannot be
     drag-only.

2. **The rail is dismissible, defaulting ON.** A header toggle hides it. "Watch it think"
   is the product's signature surface, so it is present unless explicitly dismissed, and
   **only the literal string `'false'` hides it** — a corrupted storage key must fail safe
   toward showing the feature, never toward hiding it.

3. **The app↔host frame VIEW is deleted; its FEED is retained.** `InspectorPanel.tsx`, the
   `ThinkPanel` section, and the `.inspector-entry` styles are gone. `run/inspector.ts`
   and its `onFrame` wiring stay **byte-for-byte unchanged**, because three unrelated
   features read that reducer's state:
   - `inspector.inFlight` drives the app-frame "thinking" pulse,
   - `inspector.sawDbOp` gates the `export .snug` button,
   - `readySeen` (set from the same `onFrame` hook) drives the header announce fallback.

   Deleting the feed alongside its view would silently kill all three. The obvious
   follow-up cleanup ("nothing renders this any more — remove it") is exactly the wrong
   move, so both ends of the wiring carry a comment saying so, and a test asserts the feed
   still folds frames.

4. **The prior AC10 assertions are superseded, not weakened.** `railTabs.test.tsx`'s
   section-order and both-sections-live assertions are rewritten for a one-section
   surface. What AC11 actually defended — two separate reducers, `inspector.ts`
   value-blind and byte-locked, neither importing the other — is **untouched and still
   enforced**, including the `git diff --exit-code` lock, which passes without
   modification because `inspector.ts` was never edited.

## Consequences

- The unreadable-panel complaint is fixed primarily by (1): the user can give a payload
  the width it needs. The CSS hardening shipped alongside it (`overflow-wrap: break-word`
  over `anywhere`, `min-width: 0` down the flex chain, a wrapping entry head) matters more
  now that the width is variable than it did at a fixed 340px.
- **A layout defect now requires a layout test.** jsdom returns 0×0 for every rect, so the
  original CSS-text assertions proved a declaration was present, never that a box fit —
  and that is exactly how the one-character collapse survived a full task. `e2e/
  inspector-layout.spec.ts` measures the rendered box at 280/340/520px rails. Any future
  width-sensitive claim about this surface belongs there, not in vitest.
- Mobile is unaffected: the rail is already a `Sheet` under 760px, and the divider is a
  desktop-only affordance.
- The `e2e/helpers.ts` selector contract (`role=button "open inspector"`,
  `aria-label "watch it think"`) is preserved, so the mobile specs are untouched.

## Alternatives considered

- **Keep the frame view behind a toggle.** Rejected: the objection was that the content is
  meaningless, not that it is in the way. A toggle preserves the maintenance cost and the
  screen real estate in the tab strip while fixing nothing.
- **Make the frame view show values.** Rejected outright — it would destroy the C1-adjacent
  privacy property that makes `inspector.ts` safe to keep wired, and that property is the
  entire reason the two reducers were kept separate in the first place.
- **Per-app rail width.** Rejected as surprising: the same panel would open at different
  widths depending on which app you happened to click, and there is no reason to believe
  the preference is app-specific.
- **Auto-fit the rail to its content.** Rejected: content size varies wildly between round
  trips, so the panel would resize under the user mid-read.
