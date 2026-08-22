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
- Done: task file; branch cut.
- State: diagnosing the 375px overflow.
- Next step: measure the header at 375px.
