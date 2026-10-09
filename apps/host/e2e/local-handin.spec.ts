// local-handin.spec.ts — a LIVE hand-in behaves, and a stopped runner is said
// (TASK-20261003 K6/K7, ADR-0072 §3).
//
// Binding B's hand-in used to dispatch three DOM events nobody listened to: the app was in
// the user's file and not on the hub until a reload, its note never reached the user, a
// running app kept showing the version from before, and the tool told its agent "handed to
// the open runner" whatever the page then did. And a runner that stopped left a page that
// kept taking edits it could no longer save.
//
// Every leg here is the real path: the agent's tool call over the process's stdio → the
// process's event → the page's ONE hand-in core → the outcome back over the bearer route →
// the tool's answer.
import { createRequire } from 'node:module';
import path from 'node:path';

import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';

import { DB_BLOCK_FORMAT, upsertBundleBlock, writeDbBlock } from '../../../scripts/lib/page-blocks.mjs';
import { KIT_URL } from './helpers';
import { IDP_HOST, KIT_PAGE, STUB_HOST, startLocalHost, type LocalHarness, type LocalHostOptions } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

const withHost = async (fn: (harness: LocalHarness) => Promise<void>, options: LocalHostOptions = {}): Promise<void> => {
  const harness = await startLocalHost(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
};

const LINEAGE = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const appHtml = (version: string): string => `<!doctype html><html><head><title>Pomodoro</title></head><body><h1 id="version">timer ${version}</h1></body></html>`;
const bundle = (version: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 'snug-app-bundle/1',
  lineage: LINEAGE,
  sharedAt: '2026-10-03T00:00:00.000Z',
  app: { displayName: 'Pomodoro', usesDb: false },
  html: appHtml(version),
  connections: [],
  ...extra,
});

const installedTiles = (page: Page) => page.getByTestId('installed-tile');
const appFrame = (page: Page) => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');

async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${what}: the page must never scroll horizontally`).toBeLessThanOrEqual(1);
}

/** A REAL hit-test: the element under the centre of `target` is `target` itself (or inside it). */
async function expectTappable(target: Locator, what: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const hit = await target.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const under = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return under !== null && (under === el || el.contains(under));
  });
  expect(hit, `${what} must be the thing a finger lands on`).toBe(true);
}

/** The hub is up and its first library read has settled ("nothing here yet" is the empty shelf). */
async function openHub(page: Page, harness: LocalHarness): Promise<void> {
  await page.goto(harness.url);
  await expect(page.getByText('nothing here yet')).toBeVisible({ timeout: 20_000 });
}

test('K6 — an app handed in while the hub is open appears IN PLACE, its note reaches the user, and the tool answers with what happened', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openHub(page, harness);
    // A mark a reload would wipe: "in place" means the document is the same one.
    await page.evaluate(() => void ((window as unknown as { __mark: number }).__mark = 1));

    const answer = await harness.tool('snug_hand_in', { bundle: bundle('v1') });
    expect(answer).toEqual({ text: 'installed "Pomodoro" in the open runner', isError: false });

    await expect(installedTiles(page)).toHaveCount(1);
    await expect(installedTiles(page).first()).toContainText('Pomodoro');
    expect(await page.evaluate(() => (window as unknown as { __mark?: number }).__mark), 'the page did not reload').toBe(1);
    // The note — the same sentence Binding A's boot puts on this chip.
    await page.getByTestId('your-file-chip').click();
    await expect(page.getByTestId('your-file-note')).toContainText('installed by your agent: Pomodoro');
    await page.keyboard.press('Escape');

    // The SAME bundle again: nothing changes, and the tool says so rather than "installed".
    expect(await harness.tool('snug_hand_in', { bundle: bundle('v1') })).toEqual({ text: '"Pomodoro" is already current in the open runner — nothing changed', isError: false });
    await expect(installedTiles(page)).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});

/** A box in CSS pixels; a missing one is a failure with a name, not a null to trip over later. */
async function boxOf(target: Locator, what: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${what} has no box — it is not rendered`);
  return box;
}

// Both widths the design is accepted at (S6): the rail beside the stage, and a phone.
for (const viewport of [{ width: 1280, height: 900 }, { width: 375, height: 812 }] as const) {
  test(`K6 — v2 handed in while v1 is OPEN (${viewport.width}px): the run view offers "your agent updated this app" WITHOUT moving the app, keeps v1 on screen, and reload runs v2`, async () => {
    await withHost(async (harness) => {
      const page = await browser.newPage({ viewport });
      await openHub(page, harness);
      await harness.tool('snug_hand_in', { bundle: bundle('v1') });
      await installedTiles(page).first().locator('a.tile-link').click();
      await expect(appFrame(page).locator('#version')).toHaveText('timer v1', { timeout: 20_000 });
      await expect(page.getByTestId('agent-updated')).toHaveCount(0);
      const frameWrap = page.getByTestId('frame-wrap');
      const before = await boxOf(frameWrap, 'the app’s frame before the hand-in');
      await expectNoHorizontalScroll(page, 'the run view before the hand-in');

      // The agent updates the app while the user is inside it. An unedited copy takes it.
      expect(await harness.tool('snug_hand_in', { bundle: bundle('v2') })).toEqual({ text: 'updated "Pomodoro" to v2 in the open runner', isError: false });

      const offer = page.getByTestId('agent-updated');
      await expect(offer).toContainText('your agent updated this app');
      // Offered, not done: the frame under the user is still the one they were in.
      await expect(appFrame(page).locator('#version')).toHaveText('timer v1');

      // …AND IT IS STILL WHERE IT WAS. The offer was first rendered as a sibling of the stage
      // in the layout's flex row: measured 2026-10-03, a 583 px column that squeezed the app
      // from 826 px to 243 px at 1280, and at 375 covered the viewport, left the frame 2 px
      // wide off-screen and made the page scroll 204 px sideways — while every assertion on
      // the frame's TEXT stayed green. The reveal animation is waited out, so the boxes read
      // below are the resting ones.
      await offer.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
      const note = await boxOf(offer, 'the offer');
      const after = await boxOf(frameWrap, 'the app’s frame under the offer');
      expect(Math.abs(after.width - before.width), `the frame keeps its width (${before.width} → ${after.width})`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.x - before.x), `the frame keeps its place (${before.x} → ${after.x})`).toBeLessThanOrEqual(1);
      // A strip ABOVE the frame, inside the frame's own column: it costs height, never width.
      expect(note.y + note.height, 'the offer ends above the frame').toBeLessThanOrEqual(after.y + 1);
      expect(note.x, 'the offer starts inside the frame’s column').toBeGreaterThanOrEqual(before.x - 1);
      expect(note.x + note.width, 'the offer ends inside the frame’s column').toBeLessThanOrEqual(before.x + before.width + 1);
      expect(after.height, `the app keeps most of its height (${before.height} → ${after.height})`).toBeGreaterThanOrEqual(before.height * 0.6);
      await expectNoHorizontalScroll(page, 'the run view with the offer up');
      // The one act is under the finger (or the pointer) that reaches for it.
      await expectTappable(page.getByTestId('agent-updated-reload'), 'the reload button');

      await page.getByTestId('agent-updated-reload').click();
      await expect(appFrame(page).locator('#version')).toHaveText('timer v2', { timeout: 20_000 });
      await expect(page.getByTestId('agent-updated')).toHaveCount(0);
      // The strip gave back what it took.
      const restored = await boxOf(frameWrap, 'the app’s frame after the reload');
      expect(Math.abs(restored.width - before.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(restored.height - before.height)).toBeLessThanOrEqual(1);
      // C2, on the reloaded frame as on the first: the sandbox is exactly allow-scripts.
      expect(await page.locator('[data-testid="frame-wrap"] iframe').first().getAttribute('sandbox')).toBe('allow-scripts');
      await page.close();
    });
  });
}

test('K6 — an app the user DELETED comes back when the agent hands it in again (an explicit hand-in clears the tombstone)', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await openHub(page, harness);
    await harness.tool('snug_hand_in', { bundle: bundle('v1') });
    await expect(installedTiles(page)).toHaveCount(1);

    await page.getByTestId('app-delete').click();
    await page.getByTestId('app-delete-confirm').click();
    await expect(installedTiles(page)).toHaveCount(0);

    // The very bundle that was deleted. Riding a page (Binding A) it would stay deleted.
    expect(await harness.tool('snug_hand_in', { bundle: bundle('v1') })).toEqual({ text: 'installed "Pomodoro" in the open runner', isError: false });
    await expect(installedTiles(page)).toHaveCount(1);
    await page.close();
  });
});

test('K6 — with NO page open the tool says so, rather than claiming a delivery', async () => {
  await withHost(async (harness) => {
    expect(await harness.tool('snug_hand_in', { bundle: bundle('v1') })).toEqual({ text: 'no Snug page is open — call snug_open first, then hand the app in', isError: true });
  });
});

test('K6 — the user’s file cannot be opened: the tool hears "refused" and why, inside its own wait — never "not confirmed"', async () => {
  // The page's user db does not reject when the file cannot open; it never settles, and the
  // App shows its recovery surface. The hand-in used to wait on it without a bound, so the
  // tool's 5 s ran out and the agent was told "sent — not confirmed" about a broken file.
  const require = createRequire(import.meta.url);
  const fs = require('node:fs') as typeof import('node:fs');
  await withHost(async (harness) => {
    // Torn bytes where the user's file lives — inside THIS harness's temp home (a fresh
    // mkdtemp), and the write is refused by name if `home` is ever anything else.
    expect(path.basename(harness.home), 'the home under test is the harness’s own temp directory').toMatch(/^snug-e2e-/);
    const file = path.join(harness.home, 'user.snug');
    fs.writeFileSync(file, 'not a snug file');

    const page = await browser.newPage();
    await page.goto(harness.url);
    await expect(page.getByTestId('userdb-load-failed')).toBeVisible({ timeout: 20_000 });

    expect(await harness.tool('snug_hand_in', { bundle: bundle('v1') })).toEqual({
      text: 'refused: your Snug file could not be opened (it did not open in time)',
      isError: true,
    });
    // Nothing was written over the file that could not be read.
    expect(fs.readFileSync(file, 'utf8')).toBe('not a snug file');
    await page.close();
  });
});

test('K6 — under the runner the page reads NO embedded bundle block and NO snug-db block: it installs nothing and opens the runner’s file', async () => {
  // The page the runner serves is the same file the artifact route hands apps in to. A copy
  // carrying an embedded app and a saved user file must not bring either into the user's
  // REAL file just by being served from here.
  const require = createRequire(import.meta.url);
  const fs = require('node:fs') as typeof import('node:fs');
  const kit = fs.readFileSync(KIT_PAGE, 'utf8');
  const embedded = upsertBundleBlock(kit, LINEAGE, JSON.stringify(bundle('embedded')));
  const page_ = writeDbBlock(embedded, { manifest: { format: DB_BLOCK_FORMAT, bytes: 3, sha256: 'a'.repeat(64), saved: 9, savedAt: '2026-10-03T00:00:00.000Z' }, base64: 'AQID' });

  await withHost(
    async (harness) => {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openHub(page, harness);
      // The page really carries both blocks…
      expect(await page.evaluate(() => ({ bundles: document.querySelectorAll('script[type="application/snug-app-bundle+json"]').length, db: document.getElementById('snug-db') !== null }))).toEqual({ bundles: 1, db: true });
      // …and nothing came of either: no app, no "installed by your agent" note, no artifact custody.
      await expect(installedTiles(page)).toHaveCount(0);
      await expect(page.getByTestId('your-file-chip')).toContainText('on this Mac');
      await page.getByTestId('your-file-chip').click();
      await expect(page.getByTestId('your-file-note')).toHaveCount(0);
      // The runner's file is what was opened: nothing has been written into the home but its own state.
      expect(fs.existsSync(path.join(harness.home, 'host', 'lock.json'))).toBe(true);
      expect(errors).toEqual([]);
      await page.close();

      // THE POSITIVE TWIN: the SAME bytes, served by a static server (no runner), DO hand
      // the embedded app in — so the blocks are real and it is the binding that ignored them.
      const twin = await browser.newPage();
      await twin.route(KIT_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: page_ }));
      await twin.goto(KIT_URL);
      await expect(twin.getByTestId('installed-tile')).toHaveCount(1, { timeout: 20_000 });
      await expect(twin.getByTestId('installed-tile').first()).toContainText('Pomodoro');
      await twin.close();
    },
    { page: page_ },
  );
});

// ------------------------------------------------------------------------------- K7

test('K7 — the runner is stopped while the page is open: the page SAYS so and the hub is gone — no edit can be made that would not be saved', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await openHub(page, harness);
    await harness.tool('snug_hand_in', { bundle: bundle('v1') });
    await expect(installedTiles(page)).toHaveCount(1);

    // The runner goes the polite way (SIGTERM → its `shutdown` event → the drain).
    await harness.stop();

    await expect(page.getByTestId('local-refusal-stopped')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('The Snug runner stopped')).toBeVisible();
    await expect(page.getByText(/Reopen Snug from your agent/)).toBeVisible();
    // No shell, no shelf, no rename, no delete: nothing left to edit.
    await expect(page.locator('.shell')).toHaveCount(0);
    await expect(installedTiles(page)).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await page.close();
  });
});

test('K7 — the runner DIES without a word (SIGKILL): the lost event stream does not come back, and within its short bound the page says so', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await openHub(page, harness);
    await harness.kill();
    // The bound is 4 s of trying to re-open the stream (EVENTS_RECONNECT_BOUND_MS).
    await expect(page.getByTestId('local-refusal-stopped')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.shell')).toHaveCount(0);
    await page.close();
  });
});
