// starters.spec.ts — TASK-20260806-starters-pillars AC4/AC5 (umbrella AL-08).
//
// One real-browser test per pillar starter: hub shelf → open READ-ONLY → the app
// boots inside the C2 sandbox → one meaningful interaction → no unexpected console
// errors. Everything runs on the keyless default (byok + demo brain): the three
// LLM-free starters never call the model at all (ADR-0011), and the two
// agent-as-brain starters receive the demo brain's canned off-schema reply — which
// is exactly their graceful-fallback path, so the fallback IS what these tests pin.
//
// SPA-navigation only (no mid-test page.goto reloads beyond the entry): an
// ephemeral context's OPFS does not survive hard reloads (lessons 2026-08-03).

import { expect, test, type Page, type FrameLocator } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

/** Same benign-console allowlist as owner-report.spec.ts, same reasons. */
const BENIGN = [
  /\.map['"]? violates the following Content Security Policy/i,
  /Failed to load resource.*\.map/i,
  /Failed to load resource.*40[14]/i,
];
const isBenign = (text: string): boolean => BENIGN.some((pattern) => pattern.test(text));

/** Collects unexpected console errors + page errors for the final assertion. */
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !isBenign(message.text())) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');

/** Hub → read-only starter route for `<folder>`, asserting no install happened. */
async function openStarter(page: Page, folder: string): Promise<FrameLocator> {
  await page.goto('/');
  await page.getByRole('button', { name: `open ${folder.replace(/-/g, ' ')}` }).click();
  await expect(page).toHaveURL(new RegExp(`/run/starter--${folder}`));
  return appFrame(page);
}

test.describe('pillar starters (AL-08) — open read-only, interact, stay clean', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('adventure quest — begin, choose, the local guide narrates under the demo brain', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'adventure-quest');

    // Read-only contract for a NEW starter (AC4): Install offered, nothing written.
    await expect(page.getByTestId('starter-install')).toBeVisible();

    await app.getByRole('button', { name: /begin/i }).click({ timeout: 20_000 });
    const firstChoice = app.getByTestId('quest-choice').first();
    await expect(firstChoice).toBeVisible({ timeout: 20_000 });
    await firstChoice.click();

    // The demo brain's reply is off-schema by design → the app says the local
    // guide took the turn (the chess "off-script" pattern), and the story advances.
    await expect(app.getByTestId('dm-note')).toBeVisible({ timeout: 20_000 });
    await expect(app.getByTestId('quest-choice').first()).toBeVisible();

    // Inventory/journey live in real SQL — the host chrome offers the export moment.
    await expect(page.getByRole('button', { name: 'export .sqlite' })).toBeVisible({ timeout: 20_000 });

    // AC4: browsing a starter never writes an app row.
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(0);

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('quiz me — pick a topic, the built-in bank steps in, answering advances the quiz', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'quiz-me');

    await app.getByRole('button', { name: /space/i }).click({ timeout: 20_000 });

    // Demo brain → off-schema → the built-in question bank runs the quiz, visibly.
    await expect(app.getByTestId('quiz-note')).toBeVisible({ timeout: 20_000 });
    await expect(app.getByText(/question 1 of 5/i)).toBeVisible();

    await app.getByTestId('quiz-answer').first().click();
    await expect(app.getByTestId('quiz-feedback')).toBeVisible();
    await app.getByRole('button', { name: /next/i }).click();
    await expect(app.getByText(/question 2 of 5/i)).toBeVisible();

    // Scores persist to real SQL.
    await expect(page.getByRole('button', { name: 'export .sqlite' })).toBeVisible({ timeout: 20_000 });

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('trivia night — two players pass one device, zero networking', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'trivia-night');

    const nameBox = app.getByRole('textbox', { name: /player name/i });
    await nameBox.fill('Maya', { timeout: 20_000 });
    await app.getByRole('button', { name: /add player/i }).click();
    await nameBox.fill('Leo');
    await app.getByRole('button', { name: /add player/i }).click();
    await app.getByRole('button', { name: /start/i }).click();

    // Pass-and-play: the interstitial hands the device to player 1…
    await expect(app.getByText(/pass the device to maya/i)).toBeVisible();
    await app.getByRole('button', { name: /ready/i }).click();
    await expect(app.getByTestId('tn-question')).toBeVisible();
    await app.getByTestId('tn-answer').first().click();
    await expect(app.getByTestId('tn-feedback')).toBeVisible();

    // …and after the turn it hands it to player 2. That IS the multiplayer feeling.
    await app.getByRole('button', { name: /pass it on/i }).click();
    await expect(app.getByText(/pass the device to leo/i)).toBeVisible();

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('trip planner — a dream place lands, a packing item checks off', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'trip-planner');

    await app.getByRole('textbox', { name: /add a dream place/i }).fill('Norway', { timeout: 20_000 });
    await app.getByRole('button', { name: /add place/i }).click();
    await expect(app.getByText('Norway')).toBeVisible();

    // The tab's accessible name starts with its emoji ("🎒 packing") — no ^ anchor.
    await app.getByRole('button', { name: /packing/i }).click();
    await app.getByRole('textbox', { name: /add something to pack/i }).fill('sunscreen');
    await app.getByRole('button', { name: /add item/i }).click();
    const check = app.getByRole('button', { name: /pack sunscreen/i });
    await check.click();
    await expect(check).toHaveAttribute('aria-pressed', 'true');

    // The whole plan is a real SQLite file the family owns.
    await expect(page.getByRole('button', { name: 'export .sqlite' })).toBeVisible({ timeout: 20_000 });

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('pocket ledger — money in, money out, the app keeps honest totals', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'pocket-ledger');

    await app.getByRole('textbox', { name: /what was it/i }).fill('lemonade stand', { timeout: 20_000 });
    await app.getByRole('textbox', { name: /how much/i }).fill('12.50');
    await app.getByRole('button', { name: /money in/i }).click();

    await app.getByRole('textbox', { name: /what was it/i }).fill('paper cups');
    await app.getByRole('textbox', { name: /how much/i }).fill('4');
    await app.getByRole('button', { name: /money out/i }).click();

    await expect(app.getByTestId('total-in')).toHaveText('$12.50');
    await expect(app.getByTestId('total-out')).toHaveText('$4.00');
    await expect(app.getByTestId('total-kept')).toHaveText('$8.50');

    // The export-your-books story: a real .sqlite leaves with the user.
    await expect(page.getByRole('button', { name: 'export .sqlite' })).toBeVisible({ timeout: 20_000 });

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
