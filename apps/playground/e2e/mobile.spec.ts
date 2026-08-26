// mobile.spec.ts — 375px viewport smoke (design brief: fully usable at 375px, touch
// targets ≥44px, no horizontal body scroll). Runs only in the mobile-chromium project
// (see playwright.config.ts); skips until the app shell (workstream A) lands —
// selector contract in e2e/helpers.ts.
//
// TASK-20260821 item 5 (AC5): the run view's bottom-sheet modal is replaced by an
// EITHER/OR full-view toggle — app view ⇄ "watch it think", never both. Claim
// disposition for the old spec (plan review round 1, finding 13 — nothing silently
// LOST):
//
//   MIGRATED — rail tabs keep their text as their ACCESSIBLE NAME after the AC12
//              iconification: asserted inside the full think view.
//   MIGRATED — uninstalled-starter tab gating (no 'chat' tab per AC18; `.seg button`
//              count 1): asserted inside the full think view.
//   MIGRATED — ≥44px touch target: asserted on the new app ⇄ think toggle button.
//   MIGRATED — expectNoHorizontalScroll: asserted in BOTH view states.
//   OBSOLETE — the role=dialog "watch it think" assertions: the Sheet mount in
//              RunView.tsx is deleted (the think surface is a full VIEW, not a
//              modal); the spec now asserts NO dialog remains in the run path.
//   NEW      — default is the app view on every mount (iframe visible, no think
//              surface); toggling shows the think view FULL-WIDTH with the iframe
//              actually hidden (Playwright visibility — geometry, per lessons
//              2026-08-14, not class names); toggling back restores the app.

import { expect, test, type Page } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'page body must never scroll horizontally at 375px').toBeLessThanOrEqual(1);
}

test.describe('375px viewport', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('hub renders with the always-visible create bar, no horizontal overflow', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('textbox', { name: 'describe the app to build' })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('the brain chip survives compaction: present, named, and the header still fits (ADR-0059)', async ({ page }) => {
    await page.goto('/build');
    const chip = page.getByTestId('brain-chip');
    await expect(chip).toBeVisible();
    // The demo label is the one label that must NOT compact away — hiding the words
    // would hide exactly the disclosure the chip exists for. At this width it is the
    // SHORT form ("demo"): the full label overflowed the 375px header by 7px, and the
    // swap is the deliberate fix (toContainText reads innerText, so the hidden full
    // span cannot satisfy this).
    await expect(chip).toContainText('demo');
    await expect(chip.locator('.brain-chip-label-full')).toBeHidden();
    await expect(chip.locator('.brain-chip-label-short')).toBeVisible();
    // The accessible name carries the full state at every width (lessons 2026-08-18:
    // on-screen text is an API; aria-label is the name the e2e contract pins).
    await expect(chip).toHaveAttribute('aria-label', 'what’s thinking: demo brain — scripted, no AI service');
    // …and the first-contact callout is up on this route too, so this asserts the
    // whole disclosure surface inside the 375px budget at once.
    await expect(page.getByTestId('demo-brain-callout')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });

  test('builder composer is usable: type, ≥44px touch targets', async ({ page }) => {
    await page.goto('/build');
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await expect(composer).toBeVisible();
    await composer.fill('build me tic-tac-toe');
    await expect(composer).toHaveValue('build me tic-tac-toe');
    // The build affordance itself must be a real touch target (brief: ≥44px).
    const build = page.getByRole('button', { name: 'build' });
    await expect(build).toBeEnabled();
    const box = await build.boundingBox();
    expect(box, 'build button must have a bounding box').not.toBeNull();
    expect(box!.height, 'build button touch target ≥44px').toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
  });

  test('run view mounts on the APP view: iframe visible, no think surface, honest toggle', async ({ page }) => {
    // A starter app: runs with no server round and no mock-script consumption.
    await page.goto('/run/starter--chess');

    // NEW: the default is ALWAYS the app view — the app's iframe is genuinely
    // visible (geometry, not class names) and no think surface renders at all.
    await expect(page.locator('[data-testid="frame-wrap"] iframe')).toBeVisible();
    await expect(page.getByTestId('mobile-think')).toHaveCount(0);
    // At 375px the desktop side rail must not appear either…
    await expect(page.locator('aside.rail')).toHaveCount(0);
    // …and (OBSOLETE Sheet claim, inverted) no dialog exists in the run path.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // MIGRATED: the ≥44px touch-target claim now lands on the app ⇄ think toggle,
    // which reads as an unpressed toggle mirroring the desktop label convention.
    const toggle = page.getByTestId('mobile-view-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAccessibleName('show watch it think');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox, 'toggle must have a bounding box').not.toBeNull();
    expect(toggleBox!.height, 'view toggle touch target ≥44px').toBeGreaterThanOrEqual(44);

    await expectNoHorizontalScroll(page);
  });

  test('toggling shows watch-it-think FULL-WIDTH, hides the app, and toggles back', async ({ page }) => {
    await page.goto('/run/starter--chess');
    const iframe = page.locator('[data-testid="frame-wrap"] iframe');
    await expect(iframe).toBeVisible();

    const toggle = page.getByTestId('mobile-view-toggle');
    await toggle.tap();

    // NEW: the think view replaces the app — the iframe is ACTUALLY hidden
    // (Playwright visibility is geometry-backed; a stray class would not pass here)
    // while the think surface takes the full width of the 375px viewport.
    await expect(iframe).toBeHidden();
    const think = page.getByTestId('mobile-think');
    await expect(think).toBeVisible();
    const thinkBox = await think.boundingBox();
    expect(thinkBox, 'think view must have a bounding box').not.toBeNull();
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    expect(thinkBox!.width, 'think view must be full-width').toBeGreaterThanOrEqual(viewport!.width * 0.95);
    // The toggle stays reachable and turns honest: pressed, offering the way back.
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAccessibleName('hide watch it think');
    // OBSOLETE Sheet claim, inverted: a full view, never a modal.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // MIGRATED: rail tabs are reachable in the think view, and still carry their text
    // as the ACCESSIBLE NAME after AC12 replaced the visible labels with icons — this
    // getByRole lookup is what proves the icons did not cost us the name.
    await expect(think.getByRole('button', { name: 'inspector' })).toBeVisible();
    // MIGRATED, NOT 'chat': an UNINSTALLED starter has no chat tab (AC18). Editing a
    // starter used to fork a hidden app under a random uuid, so the chat surface is
    // gated until the user installs their own copy. `docs`/`versions` are likewise
    // installed-app-only, leaving `inspector` as the one tab a starter shows —
    // hence the count assertion rather than a second name lookup.
    await expect(think.getByRole('button', { name: 'chat' })).toHaveCount(0);
    await expect(think.locator('.seg button')).toHaveCount(1);
    await expectNoHorizontalScroll(page);

    // NEW: toggling back restores the app view in full.
    await toggle.tap();
    await expect(iframe).toBeVisible();
    await expect(page.getByTestId('mobile-think')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expectNoHorizontalScroll(page);
  });
});

// TASK-20260823 (owner report): a real phone in LANDSCAPE (~850px) and an iPad in
// portrait (768–834px) fell OUTSIDE the 760px breakpoint and got the desktop split
// view — a 340px rail beside a squeezed app, on glass. The either/or band for the
// RUN view is now ≤1000px (lockstep with app.css, pinned by
// mobileThinkBreakpoint.test.ts); iPad landscape (1024+) keeps the genuine split.
test.describe('820px viewport (phone landscape / tablet portrait) — either/or, never split', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);
  test.use({ viewport: { width: 820, height: 500 } });

  test('run view: no desktop rail, app view default, toggle present and honest', async ({ page }) => {
    await page.goto('/run/starter--chess');

    // Never a split at this width: the desktop side rail must not exist…
    await expect(page.locator('aside.rail')).toHaveCount(0);
    // …the app view is the default (think hidden until asked for)…
    await expect(page.locator('[data-testid="frame-wrap"] iframe')).toBeVisible();
    await expect(page.getByTestId('mobile-think')).toHaveCount(0);
    // …and the either/or toggle is the control on offer.
    const toggle = page.getByTestId('mobile-view-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Toggling swaps the WHOLE view: think full-width, iframe genuinely hidden,
    // toggle still visible in the think state (the way back).
    await toggle.click();
    await expect(page.locator('[data-testid="frame-wrap"] iframe')).toBeHidden();
    const think = page.getByTestId('mobile-think');
    await expect(think).toBeVisible();
    const thinkBox = await think.boundingBox();
    expect(thinkBox).not.toBeNull();
    const viewport = page.viewportSize();
    expect(thinkBox!.width, 'think view must be full-width — never a split').toBeGreaterThanOrEqual(
      viewport!.width * 0.9,
    );
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // And back.
    await toggle.click();
    await expect(page.locator('[data-testid="frame-wrap"] iframe')).toBeVisible();
    await expect(page.getByTestId('mobile-think')).toHaveCount(0);
  });
});
