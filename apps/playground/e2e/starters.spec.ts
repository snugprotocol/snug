// starters.spec.ts — TASK-20260806-starters-pillars AC4/AC5 (umbrella AL-08).
//
// One real-browser test per keeper starter journey: hub shelf → open READ-ONLY → the
// app boots inside the C2 sandbox → one meaningful interaction → no unexpected console
// errors. Everything runs on the keyless default (byok + demo brain): the LLM-free
// starter (flying-pig) never calls the model at all (ADR-0011), and the two
// agent-as-brain starters (adventure-quest, quiz-me) receive the demo brain's canned
// off-schema reply — which is exactly their graceful-fallback path, so the fallback IS
// what these tests pin. (trip-planner and pocket-ledger left the shelf in
// TASK-20260815-starter-apps-rebuild — see the note where their journeys stood;
// trivia-night was removed permanently in TASK-20260821-hardening-polish — see the
// classification note where its journey stood.)
//
// SPA-navigation only (no mid-test page.goto reloads beyond the entry): an
// ephemeral context's OPFS does not survive hard reloads (lessons 2026-08-03).

import fs from 'node:fs';

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
    await expect(page.getByRole('button', { name: 'export .snug' })).toBeVisible({ timeout: 20_000 });

    // AC4: browsing a starter never writes an app row.
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(0);

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('quiz me — type a topic, press Enter, the built-in bank steps in, answering advances the quiz', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'quiz-me');

    // Enter on the free-topic input is part of the contract (review fix 4) — the topic
    // chips share the same startQuiz handler, so this covers both entry points.
    const topicBox = app.getByRole('textbox', { name: /your own quiz topic/i });
    await topicBox.fill('dinosaurs', { timeout: 20_000 });
    await topicBox.press('Enter');

    // Demo brain → off-schema → the built-in question bank runs the quiz, visibly.
    await expect(app.getByTestId('quiz-note')).toBeVisible({ timeout: 20_000 });
    await expect(app.getByText(/question 1 of 5/i)).toBeVisible();

    await app.getByTestId('quiz-answer').first().click();
    await expect(app.getByTestId('quiz-feedback')).toBeVisible();
    await app.getByRole('button', { name: /next/i }).click();
    await expect(app.getByText(/question 2 of 5/i)).toBeVisible();

    // Scores persist to real SQL.
    await expect(page.getByRole('button', { name: 'export .snug' })).toBeVisible({ timeout: 20_000 });

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // Claim classification for the removed trivia-night journey (TASK-20260821, per the
  // docs/lessons.md 2026-08-10 rule): the pass-and-play interstitial claims were
  // OBSOLETE with their subject (no successor app has that surface); the generic
  // LLM-free-starter journey claim (open read-only, interact, zero networking, clean
  // console) is MIGRATED to flying-pig below; the deterministic-SQL-write claims that
  // rode the roster textbox are MIGRATED to quiz-me in the two guard tests further down.
  test('flying pig — the arcade starts and runs with zero networking', async ({ page }) => {
    const errors = watchConsole(page);
    const app = await openStarter(page, 'flying-pig');

    // Read-only contract for a NEW starter (AC4): Install offered, nothing written.
    await expect(page.getByTestId('starter-install')).toBeVisible();

    // force: the start button carries an INFINITE bounce animation (app.html `.start-btn`),
    // so Playwright's stability check can never settle — the button is genuinely clickable.
    await app.getByRole('button', { name: /let's play/i }).click({ force: true, timeout: 20_000 });

    // The game screen is live: the score badge renders (canvas games expose little
    // accessible structure — the badge is the stable in-game chrome).
    await expect(app.locator('.score-badge')).toBeVisible({ timeout: 20_000 });

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // OBSOLETE (TASK-20260815-starter-apps-rebuild, per docs/lessons.md 2026-08-10): the
  // `trip-planner` and `pocket-ledger` per-app journeys were removed WITH their subjects —
  // both folders left the shelf in the re-curation, with no successor app (the connected
  // five are covered by starters-connect.spec.ts, not by this file's LLM-free/demo-brain
  // journeys). The generic shelf properties those two tests also happened to exercise
  // (read-only open, install offered, export affordance, zero-trace browsing) are all
  // still asserted below against the surviving keepers.

  // ── Adversarial-review finding 1: browsing must leave ZERO trace in the user file ──
  //
  // The defect in one sentence: playing an UNINSTALLED starter materialized orphaned
  // `app_x<hex("starter--…")>__*` tables into the user DB, which rode in every export
  // with no `snug_apps` row. Per the guard-test lesson (2026-08-04), the assertion is
  // the OUTCOME at the BYTE level — the exported file's DDL — never "no app row"
  // (an orphaned table has no app row and still ships the user's export to strangers).

  /** `app_x` + utf8-hex("starter--") — the prefix every starter-namespace table carries. */
  const STARTER_TABLE_MARK = 'app_x737461727465722d2d';

  /** Runs quiz-me's whole five-question round — the INSERT lands only when the quiz
   * FINISHES (the app writes the score exactly once, at `see my score`), so a full
   * round is the cheapest interaction that provably writes SQL in the starter's
   * namespace. Deterministic under the demo brain: the off-schema reply routes to the
   * built-in five-question bank. Ends back on the topics screen, where the
   * `your last quizzes` history card renders straight from a SELECT. */
  async function completeQuiz(app: FrameLocator, topic: string): Promise<void> {
    const topicBox = app.getByRole('textbox', { name: /your own quiz topic/i });
    await topicBox.fill(topic, { timeout: 20_000 });
    await topicBox.press('Enter');
    await expect(app.getByText(/question 1 of 5/i)).toBeVisible({ timeout: 20_000 });
    for (let i = 0; i < 5; i += 1) {
      await app.getByTestId('quiz-answer').first().click();
      await expect(app.getByTestId('quiz-feedback')).toBeVisible();
      await app.getByRole('button', { name: i < 4 ? /next question/i : /see my score/i }).click();
    }
    await app.getByRole('button', { name: /another topic/i }).click();
  }

  test('browsing an uninstalled starter writes NOTHING into the exported user file', async ({ page }) => {
    const app = await openStarter(page, 'quiz-me');

    // A REAL interaction that lands a SQL INSERT in the starter's namespace.
    await completeQuiz(app, 'ghosts');
    await expect(app.locator('.hist-topic').first()).toHaveText('ghosts');

    // Export the WHOLE user file and inspect the bytes: no starter-namespace DDL.
    await page.getByRole('link', { name: 'settings' }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'export snug file' }).click();
    const download = await downloadPromise;
    const path = await download.path();
    const bytes = fs.readFileSync(path);
    expect(
      bytes.toString('latin1').includes(STARTER_TABLE_MARK),
      'the exported user file must contain NO starter-namespace tables',
    ).toBe(false);
  });

  test('install after browsing: the try-out data vanishes, the OWNED copy persists in the user file', async ({ page }) => {
    const app = await openStarter(page, 'quiz-me');
    await completeQuiz(app, 'ghosts');
    await expect(app.locator('.hist-topic').first()).toHaveText('ghosts');

    // Install → the owned copy starts FRESH: trying is not owning (documented semantic).
    await page.getByTestId('starter-install').click();
    await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const owned = appFrame(page);
    await expect(owned.getByRole('textbox', { name: /your own quiz topic/i })).toBeVisible({ timeout: 20_000 });
    await expect(owned.getByText(/no scores yet/i)).toBeVisible();
    await expect(owned.locator('.hist-row')).toHaveCount(0);

    // Data written in the OWNED copy lands in the user file: survives leaving and returning.
    await completeQuiz(owned, 'volcanoes');
    await expect(owned.locator('.hist-topic').first()).toHaveText('volcanoes');
    const ownedUrl = page.url();
    await page.getByRole('link', { name: 'your apps' }).click();
    await page.getByRole('button', { name: 'open quiz me' }).click();
    await expect(page).toHaveURL(ownedUrl, { timeout: 20_000 });
    await expect(appFrame(page).locator('.hist-topic').first()).toHaveText('volcanoes', { timeout: 20_000 });
  });
});
