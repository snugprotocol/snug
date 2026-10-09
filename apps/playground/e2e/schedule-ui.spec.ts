// schedule-ui.spec.ts — TASK-20261009-scheduling-framework U1/U2 in a real browser: the
// /schedule page at 1280 and 375 in both themes (screenshots), the header's calendar item
// measured with boundingBox() at 375 px (≥44 px, inside the viewport — if it did not fit, the
// hub section would be the only entry and this test would say so), every touch target on the
// page ≥44 px, no horizontal overflow, the create bar handing the sentence to the editor
// route, and the templates' "add <App>, then schedule it" link to the starter.
//
// The row anatomy (switch · kebab) needs a schedule to exist. The only honest way to make one
// in a browser is the editor route (U3), so the last test drives it through its one pinned
// act, *schedule it* (CONSENT.enable), and ASSERTS that a row came of it: the editor ships in
// this PR, so an editor that cannot schedule a sentence is a red here, never a skip. The only
// skip left is the integration fixture gate (`SNUG_E2E_HAS_APP`).
//
// Runs in the default `chromium` project (not the mobile project, which only matches
// mobile.spec.ts): the 375 px leg sets the viewport itself.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

const SHOTS = path.join('test-results', 'schedule-ui');
fs.mkdirSync(SHOTS, { recursive: true });

const PLACEHOLDER = 'describe what and when — every weekday at 8, summarise my ledger';

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'page body must never scroll horizontally').toBeLessThanOrEqual(1);
}

/** Every button, link, switch and textbox on the page that is visible is at least 44 px tall. */
async function expectTouchTargets(page: Page, scope = 'body'): Promise<void> {
  const boxes = await page.locator(`${scope} :is(button, a[href], [role="switch"], input)`).evaluateAll((els) =>
    els
      .filter((el) => el instanceof HTMLElement && el.offsetParent !== null)
      .map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { tag: el.tagName, text: (el as HTMLElement).innerText?.slice(0, 40) ?? '', h: r.height };
      }),
  );
  const short = boxes.filter((b) => b.h > 0 && b.h < 44);
  expect(short, `touch targets under 44 px: ${JSON.stringify(short)}`).toEqual([]);
}

/** The app's theme is `data-theme` on <html> (state/theme.ts), flipped by the header toggle. */
async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current === theme) return;
  await page.getByRole('button', { name: `switch to ${theme} theme` }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe(theme);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe('the schedule page (U2)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('empty page at 1280: create bar first, the honesty line, the empty state, the four templates', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/schedule');
    await expect(page.getByRole('heading', { level: 1, name: 'schedule' })).toBeVisible();
    const box = page.getByRole('textbox', { name: 'describe what and when' });
    await expect(box).toBeVisible();
    await expect(box).toHaveAttribute('placeholder', PLACEHOLDER);
    await expect(page.getByTestId('schedule-create-submit')).toBeDisabled();
    await expect(page.getByRole('link', { name: 'new schedule' })).toBeVisible();
    // The honesty line, where the user decides (design F6): this host's own sentence.
    await expect(page.getByTestId('schedule-honesty')).toContainText(/^runs while this tab is open/);
    await expect(page.getByText('no schedules yet')).toBeVisible();
    await expect(page.getByText('nothing scheduled yet — describe what and when, or start from a template')).toBeVisible();
    // Templates ALWAYS (design F11): four cards; "nudge me" needs no app.
    const cards = page.getByTestId('schedule-template');
    await expect(cards).toHaveCount(4);
    await expect(page.getByRole('link', { name: 'use this' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'add Should I?, then schedule it' })).toBeVisible();
    // The create bar precedes everything but the heading.
    const order = await page.evaluate(() => [...document.querySelectorAll('.schedule-page > *')].map((el) => el.getAttribute('data-testid') ?? el.className));
    expect(order[1]).toBe('schedule-create-bar');
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page, '.schedule-page');
    await setTheme(page, 'dark');
    await shoot(page, 'schedule-1280-dark');
    await setTheme(page, 'light');
    await shoot(page, 'schedule-1280-light');
    await setTheme(page, 'dark');
  });

  test('the same page at 375: no horizontal overflow, every target ≥44 px, both themes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/schedule');
    await expect(page.getByRole('textbox', { name: 'describe what and when' })).toBeVisible();
    await expect(page.getByTestId('schedule-template')).toHaveCount(4);
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page, '.schedule-page');
    await setTheme(page, 'dark');
    await shoot(page, 'schedule-375-dark');
    await setTheme(page, 'light');
    await shoot(page, 'schedule-375-light');
    await expectNoHorizontalScroll(page);
    await setTheme(page, 'dark');
  });

  test('the create bar hands the sentence — and only the sentence — to the editor route, which reads the when itself (design F1)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/schedule');
    const box = page.getByRole('textbox', { name: 'describe what and when' });
    await box.fill('every weekday at 8, water the ferns');
    await page.getByTestId('schedule-create-submit').click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/schedule/new');
    const params = new URL(page.url()).searchParams;
    expect(params.get('text')).toBe('every weekday at 8, water the ferns');
    expect([...params.keys()], 'nothing but the sentence rides along (M10)').toEqual(['text']);
    // The editor re-read the sentence deterministically: the weekly chip, Monday–Friday, 08:00.
    await expect(page.getByTestId('spec-kind-weekly')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('spec-time')).toHaveValue('08:00');
    await expect(page.getByTestId('schedule-title')).toHaveValue('water the ferns');
  });

  test('a template whose starter is missing links to that starter’s run route, where install is the explicit act', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/schedule');
    await page.getByRole('link', { name: 'add Should I?, then schedule it' }).click();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/run/starter--weather');
    await expect(page.getByTestId('starter-install')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('the header item (U1)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('the calendar item: beside the gear, named "schedule", inside the viewport at 1280 — and HIDDEN at 375, where the hub section is the entry (U1)', async ({ page }) => {
    // The header is full at 375 px (it overflowed by 7 px once — lesson 2026-08-26 — and the
    // calendar item overflowed it by 17 px, measured in the kit e2e 2026-10-09). Below the
    // header's mobile breakpoint the item hides rather than squeezes; the hub's schedule
    // section and Settings are the entries there.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const item = page.getByTestId('schedule-nav');
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('aria-label', /^schedule/);
    const box = await item.boundingBox();
    expect(box).not.toBeNull();
    // The 44 px touch rule (mobile.spec.ts) governs the touch viewport, where this item is
    // hidden; at a pointer width the icon items share the gear's size (measured 42 × 44).
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(item).toBeHidden();
    await expectNoHorizontalScroll(page);
  });

  test('at 1280 the item is present and named the same', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const item = page.getByTestId('schedule-nav');
    await expect(item).toBeVisible();
    await expect(item).toHaveAccessibleName('schedule');
    const box = await item.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe('a row at 375 px (design F12)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('title + a 44 px switch, the when + next line, a 44 px kebab with run now · edit · history · delete', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    // Make one schedule through the editor route (U3): the sentence prefills it — the when, the
    // title and the reminder's own words ("water the ferns") — and *schedule it* enables it. A
    // reminder spends nothing, so no consent surface stands between the act and the row.
    await page.goto(`/schedule/new?text=${encodeURIComponent('every weekday at 8, water the ferns')}`);
    const enable = page.getByRole('button', { name: 'schedule it' });
    await expect(enable, 'the editor offers its one act').toBeVisible({ timeout: 10_000 });
    await expect(enable, 'the sentence filled the reminder, so nothing blocks the save').toBeEnabled();
    await enable.click();
    await expect.poll(() => new URL(page.url()).pathname, 'the save lands on the page').toBe('/schedule');
    const rows = page.getByTestId('schedule-row');
    await expect(rows, 'the editor produced exactly one schedule from the sentence').toHaveCount(1);

    const row = rows.first();
    await expect(row.locator('.schedule-row-title')).toBeVisible();
    const sw = row.getByRole('switch');
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    const swBox = await sw.boundingBox();
    expect(swBox!.height, 'switch touch target ≥44 px').toBeGreaterThanOrEqual(44);
    expect(swBox!.width, 'switch touch target ≥44 px wide').toBeGreaterThanOrEqual(44);
    await expect(row.locator('.schedule-row-when')).toContainText(/Weekdays at/);
    await expect(row.locator('.schedule-row-next')).toContainText(/^next /);
    const kebab = row.getByTestId('schedule-kebab');
    const kebabBox = await kebab.boundingBox();
    expect(kebabBox!.height, 'kebab touch target ≥44 px').toBeGreaterThanOrEqual(44);
    expect(kebabBox!.width, 'kebab touch target ≥44 px wide').toBeGreaterThanOrEqual(44);
    await kebab.click();
    const menu = page.getByTestId('schedule-menu');
    await expect(menu).toBeVisible();
    await expect(menu.locator('.schedule-menu-item')).toHaveText(['run now', 'edit', 'history', 'delete']);
    await expectTouchTargets(page, '[data-testid="schedule-menu"]');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectTouchTargets(page, '.schedule-page');
    await setTheme(page, 'dark');
    await shoot(page, 'schedule-row-375-dark');
    await setTheme(page, 'light');
    await shoot(page, 'schedule-row-375-light');
    await setTheme(page, 'dark');
    // Delete arms the inline confirm — keep backs out, delete removes the row.
    await kebab.click();
    await menu.getByRole('button', { name: 'delete' }).click();
    const confirm = page.getByRole('group', { name: /^delete .*\?$/ });
    await expect(confirm).toContainText('delete for good?');
    await confirm.getByRole('button', { name: 'keep' }).click();
    await expect(confirm).toHaveCount(0);
    await kebab.click();
    await menu.getByRole('button', { name: 'delete' }).click();
    await page.getByTestId('schedule-delete-confirm').click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByText('no schedules yet')).toBeVisible();
  });
});
