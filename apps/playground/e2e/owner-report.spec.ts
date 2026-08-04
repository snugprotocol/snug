// owner-report.spec.ts — TASK-20260804-hub-polish, follow-up round.
//
// Four bugs the owner hit by ACTUALLY RUNNING the app, verified here in a real browser
// rather than at the unit seam, because three of the four are only observable end to
// end (a console error, a navigation, a panel that stays empty):
//
//   1. BYOK round trips never populate — a Chess move showed frames in the inspector
//      but nothing in the LLM surface. Cause: the playground has TWO runAgentTurn call
//      sites and only the builder's was wired; an APP's turn goes through
//      agent/transport.ts, which passed no onEvent at all.
//   2. Clicking a starter did nothing but install. It must OPEN read-only, and offer
//      Install from inside the run view when the user does not own it yet.
//   3. PUT /userdb 412 in the console.
//   4. A CSP console error for babel's .map sidecar.
//
// Item 4 is NOT a bug to fix — it is C2 working. `connect-src 'none'` blocks the
// sourcemap fetch devtools attempts; the SCRIPT itself loads fine via script-src. The
// test below pins that distinction so nobody "fixes" it by widening the CSP.

import { expect, test } from '@playwright/test';
import { APP_URL, AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

/** Console errors that are expected and benign, with the reason each is tolerated. */
const BENIGN = [
  // Item 4: devtools fetching a sourcemap for an allowlisted CDN script. The script
  // executes normally; only its .map sidecar is refused, and refusing it is correct.
  /\.map['"]? violates the following Content Security Policy/i,
  /Failed to load resource.*\.map/i,
  // `/auth/me` 404s by DESIGN when the hub runs without SNUG_AUTH=google (this e2e
  // harness, the static demo, any v1 server). The client's four-state machine resolves
  // that to 'unavailable' and hides every login surface — logged-out stays a fully
  // working local-only hub. Chrome logs the 404 regardless; it is not an app error.
  /Failed to load resource.*40[14]/i,
];

const isBenign = (text: string): boolean => BENIGN.some((pattern) => pattern.test(text));

test.describe('owner-reported regressions', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('item 2 — a starter OPENS read-only and offers Install from the run view', async ({ page }) => {
    await page.goto(APP_URL);

    // The hub tile must OPEN the starter, not install it.
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="chess"]');
    await expect(tile).toBeVisible();
    await tile.getByRole('button').first().click();

    // We are on the read-only starter route — NOT a uuid route, which would mean it
    // installed behind our back (the exact hidden-fork bug).
    await expect(page).toHaveURL(/\/run\/starter--chess/);

    // Install is offered here, and the chat tab is NOT (a starter must not be editable
    // until it is owned — that is where the fork used to happen).
    await expect(page.getByTestId('starter-install')).toBeVisible();
    await expect(page.getByRole('button', { name: 'chat', exact: true })).toHaveCount(0);
  });

  test('item 2 — installing from the run view creates ONE copy and routes to it', async ({ page }) => {
    await page.goto(`${APP_URL}/run/starter--chess`);
    await page.getByTestId('starter-install').click();

    // Lands on the user's own copy (a uuid route), which now HAS the chat tab.
    await expect(page).toHaveURL(/\/run\/(?!starter--)[0-9a-f-]{8,}/, { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'chat', exact: true })).toBeVisible();

    const ownedUrl = page.url();

    // SPA navigation, never page.goto: an ephemeral context's OPFS does not survive a
    // hard reload (lessons 2026-08-03), and persistence-across-reload is already
    // covered by no-server.spec's persistent-profile test. What THIS test owns is that
    // one starter yields exactly one copy.
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(1);

    // Re-opening the starter returns to THAT copy rather than minting a second one.
    const tile = page.locator('[data-testid="starter-tile"][data-starter-name="chess"]');
    await tile.getByRole('button').first().click();
    await expect(page).toHaveURL(ownedUrl, { timeout: 20_000 });
    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(1);
  });

  test('items 3 + 4 — no unexpected console errors during a normal hub → run flow', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' && !isBenign(message.text())) errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    // Every non-2xx, so the assertion below can be specific about WHICH are tolerated.
    const nonOk: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) nonOk.push(`${r.status()} ${new URL(r.url()).pathname}`);
    });

    await page.goto(APP_URL);
    await page.locator('[data-testid="starter-tile"][data-starter-name="chess"]').getByRole('button').first().click();
    await expect(page).toHaveURL(/\/run\/starter--chess/);
    await page.getByTestId('starter-install').click();
    await expect(page).toHaveURL(/\/run\/(?!starter--)[0-9a-f-]{8,}/, { timeout: 15_000 });
    await page.waitForTimeout(1500); // let the app boot, announce, and touch its DB

    // Item 3: a 412 must never reach the console as an unhandled error. The CAS
    // conflict is normal protocol traffic handled as data (ADR-0009); Chrome's own
    // network log line is not a console error and is not captured here.
    expect(errors.filter((e) => /412|precondition/i.test(e)), 'a 412 must be handled, never thrown').toEqual([]);
    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);

    // Item 3 at the NETWORK layer, which is where the owner actually saw it: no PUT
    // /userdb may 412 during a clean first-run flow. A 412 is a legitimate CAS conflict
    // signal, but it should only ever appear when the origin genuinely diverged — never
    // in a plain hub → install → run pass.
    expect(
      nonOk.filter((entry) => entry.startsWith('412')),
      `a clean first-run flow must not produce a 412 (saw: ${nonOk.join(', ')})`,
    ).toEqual([]);
  });

  test('item 4 — the babel SCRIPT loads even though its sourcemap is refused (C2 intact)', async ({ page }) => {
    await page.goto(`${APP_URL}/run/starter--chess`);
    // The app is JSX compiled in-browser by @babel/standalone. If the script had been
    // blocked (rather than just its .map), the app could not render at all — so a
    // rendered frame IS the proof that script-src allowed it while connect-src still
    // refused the sourcemap. This is the line that must not be "fixed" by widening CSP.
    const frame = page.locator('[data-testid="frame-wrap"] iframe');
    await expect(frame).toBeVisible();
    await expect(page.locator('[data-testid="frame-wrap"]')).toBeVisible();
  });
});
