# TASK-20260822-mobile-e2e-reds: fix the six pre-existing e2e reds (375px overflow + stale badge assertions)

- **Status**: in-progress
- **Owner**: Jeetu
- **Risk tier**: medium (playground UI + e2e specs; no protocol/runner/auth)
- **Branch**: `fix/TASK-20260822-mobile-e2e-reds`
- **Packages touched**: `apps/playground` (CSS/e2e only)
- **Spec impact**: none
- **Related**: found by TASK-20260822-spec-10-final's `gate:local --all` (the first `--all`
  since #100 merged); next-steps 2026-08-22 entry; lesson 2026-08-18 (label→icon breaks
  locators in a lane CI does not run)

## Spec (what & why)

Six e2e specs fail identically on `main` at `f36ba68` — pre-launch blockers for the HN
walk. Two causes: **(a)** the header nav gained the `snugprotocol.org` WebsiteLink (#100)
and at 375px the page body scrolls horizontally by ~29px — a REAL mobile regression
(4 × `e2e/mobile.spec.ts`); **(b)** #100 deliberately shortened the desktop-only badge
text to `desktop` (long copy moved to `title`) and two `e2e/starters-connect.spec.ts`
assertions still expect `/desktop app/i` in the badge TEXT — stale assertions against a
correct product (hue + trade-copilot web-greying rows).

Commissioned by the owner in-session ("fix the mobile e2e reds") immediately after the
finding was reported — that directive is the plan approval for this narrow scope.

**Acceptance criteria:**
1. All 4 `mobile.spec.ts` 375px specs green — body never scrolls horizontally; fix is
   measured in a real browser (geometry lesson 2026-08-14), not asserted from CSS text.
2. Both AC8/AC9 starters-connect specs green — assertions migrated to the deliberate
   short badge text AND strengthened to pin the `title` copy (so the "why" cannot
   silently vanish), per the 2026-08-16 migrate-the-claim rule.
3. No desktop (≥desktop-width) visual regression: the nav renders as before at 1440px
   (existing siteLinks/websiteLink unit pins stay green).
4. Full playground e2e suite green (the leg that was red), plus playground unit suite.

**Out of scope**: any other e2e spec; the quarantined starters-connect rows
(`test.fail()` set stays as-is); website pages.

## Plan

1. Reproduce + measure: run one failing mobile spec, read the rendered header geometry
   (which element overflows at 375px).
2. CSS fix in `apps/playground` (likely the header nav needs wrap/compaction at small
   widths); verify by re-running the 4 mobile specs (they measure `scrollWidth` vs
   `innerWidth` — the honest signal).
3. Migrate the two badge assertions (short text + title pin).
4. Full e2e run + unit suite; screenshot at 375px and 1440px.
5. Gate 6: journal, lessons if any, next-steps prune, PR, merge, done-index.

## Decisions & surprises

- (running)

## Session journal (append-only, newest last)

### 2026-08-22 — Claude (Fable 5) — session
- Done: task file; branch cut. Diagnosis: the nav's five items (four text links + theme
  button) alone outgrow 375px (~450px at base sizes) — the brand's ellipsis cannot
  absorb it; the header simply had no narrow compaction of its own before #100 added the
  fifth item. Fix: inside the existing ≤760px block, compact `.nav-link` (padding
  space-3→space-2, text-s→text-xs) and zero the nav gap — deliberately NO wrap, because
  `.run-layout` hardcodes the single-row header's 61px resolved height. All 4 mobile
  specs green (measured: body scrollWidth ≤ innerWidth, the spec's own signal). Badge
  assertions MIGRATED per the claim rule: `toHaveText('desktop')` (fails on the
  pre-#100 "desktop app" text, so it pins the deliberate state) + a NEW
  `toHaveAttribute('title', /desktop app/i)` pin so the why-copy cannot silently vanish;
  both AC8/AC9 specs green. One more stale `dist/server.js` (09:53, from the morning's
  runs) held 8787 — verified by command line, killed; recurrence noted.
- State: **full e2e leg GREEN — 75 passed / 1 skipped, exit 0 pipefail-verified** (was
  69/6). Screenshots taken and reviewed: 375px one-row header, no overflow (the active
  pill wraps its label internally — that's what buys the fit, within the 44px
  min-height); 1440px byte-for-byte the pre-change layout (compaction scoped ≤760px).
  Unit suite running.
- Next step: unit green → Gate 6 (journal, next-steps prune, PR, merge, done-index).

### 2026-08-22 — Claude (Fable 5) — close
- Verification roll-up: **AC1** 4/4 mobile specs green (the specs measure scrollWidth vs
  innerWidth — the honest signal) · **AC2** both AC8/AC9 specs green; `toHaveText('desktop')`
  fails against the pre-#100 text so it pins the deliberate state, and the new `title`
  pin keeps the why-copy load-bearing · **AC3** 1440px screenshot identical layout
  (compaction scoped ≤760px); websiteLink/siteLinks unit pins green · **AC4** full e2e
  leg **75 passed / 1 skipped, exit 0 pipefail-verified** (was 69/6); playground unit
  first run 1481/1482 with the one failure NOT captured (my grep kept only totals —
  same-day pipe lesson applies), full re-run **1482/1482** — matches the documented
  contention-flake varying-set signature; recorded honestly rather than classified.
- Environment note: ANOTHER stale `dist/server.js` (09:53) held 8787 before the first
  run — third occurrence today; killed after command-line verification. If it recurs,
  consider `reuseExistingServer` posture or a pre-run port check in the e2e leg (left
  for a future task; config untouched here).
- No lessons beyond today's already-recorded two (the pipe lesson fired again; no new
  rule earned). No doc drift beyond next-steps (pruned).
- State: done pending merge.
- Next step: PR → merge → done-index → retire.
