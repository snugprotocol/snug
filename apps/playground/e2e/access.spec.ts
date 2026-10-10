// access.spec.ts — TASK-20261010-cross-app-access AC22: access between apps, end to end, in the
// real playground app (ADR-0075; the task file's Design → UX, D10, D12, D20).
//
// THE CAST. Three apps installed as `snug-app-bundle/1` documents through Settings (the
// schedule-flow precedent), so each lands with a `share:` install source and the consent sheet's
// provenance line reads "installed from a share link … · not built by you":
//   - Ledger  (e2e/fixtures/access-source.html) — its first open creates `transactions` and
//             `accounts` (the latter with an `api_key` column) through useAppDB and seeds rows;
//   - Pantry  (the same document with its one naming line rewritten) — a second candidate the
//             USER sees on the sheet and the reading app must never learn exists;
//   - Budget  (e2e/fixtures/access-reader.html) — the copy-exactly hooks block plus the rendered
//             87-cross-app-access helper; every ask is a button, and #status / #result / #view /
//             #changed / #log print what the host answered, as text.
//
// THE CLAUSES, one test each, SERIAL on ONE page because the state carries (the file is in OPFS
// of an ephemeral context, so every route change after the first `goto` is a click — never a
// reload; lessons 2026-08-03):
//   1. install the three bundles; Ledger's and Pantry's first open create their tables;
//   2. Budget's request → the strip → *review* → the consent sheet (provenance, the ranked
//      candidates with `transactions` pre-ticked and `api_key` *never shared*, the egress block,
//      the primary named for the default duration and armed only after 600 ms) → *allow while
//      it's open* → the outcome line → the view → `query` returns rows;
//   3. a day's access → the SOURCE's ⋈ sheet shows *what reads Ledger* (Budget) and the history
//      row "read transactions · 4 rows"; the "while it's open" access of clause 2 ended when
//      Budget's view closed, so it is not listed;
//   4. Settings → *access between apps* → *stop* → back in Budget the next `query` is
//      ACCESS_REVOKED;
//   5. *not now* → ACCESS_DECLINED, retryable;
//   6. a SELECT on the table the user did not tick fails by ABSENCE ("no such table"); the
//      WITH RECURSIVE bomb answers ACCESS_QUERY_FAILED within 3 s while the host chrome reacts;
//   7. a *stop* while Budget is OPEN rings it: `access-changed { grantId }` reaches the app, and
//      the read after it is ACCESS_REVOKED;
//   8. the reading app never saw the app list: nothing it received names Pantry or an app id;
//   9. 375 px: the owned-app header cluster with the ⋈, the strip and the consent sheet — no
//      horizontal overflow of the page or the sheet's card.
//
// WHY CLAUSE 4 AND CLAUSE 7 ARE SPLIT (a deviation from the one-grant reading of AC22, reported):
// Settings is a route, so opening it closes Budget's view — a *while it's open* access ends right
// there (grants.ts: the retract drops session grants), and an app whose view is closed has no
// frame to ring. So the Settings stop is proven on a persisted (*for a day*) access and its
// ACCESS_REVOKED is read after Budget reopens; the `access-changed` hint is proven on a stop made
// from host chrome while Budget is open (its own ⋈ sheet).
//
// THE CLOCK. `page.clock.install` BEFORE the first `goto` (time keeps flowing at real speed); the
// one duration this file needs to cross is the per-app ask window (`ACCESS_REQUEST_MIN_GAP_MS`,
// 10 s), crossed with `fastForward` before each ask after the first. The 600 ms arming is never
// slept on: the button is observed disabled when it appears and enabled after.
//
// Strings come from `access/copy.ts` itself (pinned in accessCopy.test.ts), never retyped.

import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { ACCESS_QUERY_TIMEOUT_MS, ACCESS_REQUEST_MIN_GAP_MS } from '@snugprotocol/protocol';

import {
  ACCESS_SHEET,
  CONSENT_SHEET,
  CONSENT_UI,
  EGRESS,
  GRANT_ACTS,
  PROVENANCE,
  SETTINGS_CARD,
  STRIP,
  STRIP_OUTCOME,
  allowLabel,
} from '../src/access/copy';
import { APP_URL, AWAITS_INTEGRATION, playgroundDir } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

const FIXTURES = path.join(playgroundDir(), 'e2e', 'fixtures');
const READER_HTML = fs.readFileSync(path.join(FIXTURES, 'access-reader.html'), 'utf8');
const SOURCE_HTML = fs.readFileSync(path.join(FIXTURES, 'access-source.html'), 'utf8');

/** The source fixture's ONE naming line, and the second source made from it. */
const LEDGER_LINE = "const SOURCE = { appId: 'e2e-access-ledger', displayName: 'Ledger', iconEmoji: '📒', iconColor: '#c9852b' };";
const PANTRY_LINE = "const SOURCE = { appId: 'e2e-access-pantry', displayName: 'Pantry', iconEmoji: '🥫', iconColor: '#7a9a3b' };";

const READER = 'Budget';
const SOURCE = 'Ledger';
const OTHER = 'Pantry';
const PURPOSE = 'to show spending by category';
/** Ledger's seeded `transactions` (access-source.html). */
const TRANSACTIONS = 4;

/** The ids the library assigned at install — filled by clause 1. */
const ids = { ledger: '', pantry: '', budget: '' };
/** The access ids Budget was answered — filled as the clauses run. */
const held = { day: '', bomb: '' };

// ------------------------------------------------------------------------------------ helpers

function bundle(input: { displayName: string; description: string; iconEmoji: string; iconColor: string; html: string }): string {
  const { html, ...app } = input;
  return JSON.stringify({
    format: 'snug-app-bundle/1',
    lineage: crypto.randomUUID(),
    sharedAt: new Date().toISOString(),
    app: { ...app, usesDb: true },
    html,
    connections: [], // nothing to connect: these apps never reach the network
  });
}

const appFrame = (page: Page): FrameLocator => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, 'the page body must never scroll horizontally').toBeLessThanOrEqual(1);
}

/** Receive a bundle through Settings and install it; answers the library id once the app is up. */
async function installBundle(page: Page, file: string, json: string, ready: string): Promise<string> {
  await page.getByRole('link', { name: 'settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.locator('[data-testid="add-shared-app"] input[type="file"]').setInputFiles({ name: file, mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(page).toHaveURL(/\/run\/shared--[0-9a-f]{64}/, { timeout: 20_000 });
  await page.getByTestId('shared-install').click();
  await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const appId = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(appFrame(page).locator('#status')).toHaveText(ready, { timeout: 30_000 });
  return appId;
}

/** Hub → the app's tile: a click, never a reload. */
async function openApp(page: Page, appId: string): Promise<FrameLocator> {
  await page.getByRole('link', { name: 'your apps' }).click();
  await expect(page).toHaveURL(new RegExp(`${APP_URL}/?$`));
  await page.locator(`a[href="/run/${appId}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/run/${appId}$`));
  const app = appFrame(page);
  await expect(app.locator('main')).toBeVisible({ timeout: 30_000 });
  return app;
}

/** The strip above Budget's frame — role=status, named by its title. */
const strip = (page: Page): Locator => page.getByRole('status').filter({ has: page.getByTestId('access-ask-title') });

/** The consent sheet: the dialog named by its title (the ⋈ sheet shares the testid, never the name). */
const consentSheet = (page: Page): Locator => page.getByRole('dialog', { name: CONSENT_SHEET.title(READER) });

/** A user act in Budget asks; the per-app window (10 s) is crossed on the clock first when it is not the first ask. */
async function ask(page: Page, app: FrameLocator, opts: { afterAnother: boolean }): Promise<void> {
  if (opts.afterAnother) await page.clock.fastForward(ACCESS_REQUEST_MIN_GAP_MS);
  await app.locator('#ask').click();
  await expect(app.locator('#status')).toHaveText('request: waiting');
  const shown = strip(page);
  await expect(shown, 'the ask is a strip above the app, never a modal').toBeVisible({ timeout: 15_000 });
  await expect(shown.getByTestId('access-ask-title')).toHaveText(STRIP.title(READER));
  await expect(shown.getByTestId('access-ask-says')).toContainText(STRIP.says(READER));
  await expect(shown.getByTestId('access-ask-quote')).toHaveText(STRIP.quote(PURPOSE));
  await expect(page.getByRole('dialog'), 'nothing opens until the user reviews').toHaveCount(0);
}

/**
 * *review* → the consent sheet. Before the click, an observer records the primary's state the
 * moment it first renders and the moment it arms — the 600 ms delay asserted, never slept on.
 */
async function review(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const w = window as unknown as { __arming?: { appearedAt?: number; disabledAtFirst?: boolean; enabledAt?: number } };
    const record: { appearedAt?: number; disabledAtFirst?: boolean; enabledAt?: number } = {};
    w.__arming = record;
    const check = (): void => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="access-allow"]');
      if (button === null) return;
      if (record.appearedAt === undefined) {
        record.appearedAt = performance.now();
        record.disabledAtFirst = button.disabled;
      }
      if (!button.disabled && record.enabledAt === undefined) {
        record.enabledAt = performance.now();
        observer.disconnect();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
  });
  await strip(page).getByTestId('access-ask-review').click();
  const sheet = consentSheet(page);
  await expect(sheet).toBeVisible({ timeout: 10_000 });
  return sheet;
}

/** The primary armed: disabled when it rendered, enabled ≥ ~600 ms later. */
async function expectArmedAfterDelay(page: Page, sheet: Locator): Promise<void> {
  const allow = sheet.getByTestId('access-allow');
  await expect(allow).toBeEnabled({ timeout: 5_000 });
  const arming = await page.evaluate(() => (window as unknown as { __arming?: { appearedAt?: number; disabledAtFirst?: boolean; enabledAt?: number } }).__arming);
  expect(arming?.disabledAtFirst, 'the primary is DISABLED when the sheet renders').toBe(true);
  expect(arming?.appearedAt).toBeDefined();
  expect(arming?.enabledAt).toBeDefined();
  // 600 ms of visibility (ACCESS_ARM_MS); a little slack for the observer's own scheduling.
  expect((arming!.enabledAt as number) - (arming!.appearedAt as number), 'armed only after the delay').toBeGreaterThanOrEqual(550);
}

/** The Budget view JSON (#view) as the host answered it. */
async function heldView(app: FrameLocator): Promise<Record<string, unknown>> {
  const text = (await app.locator('#view').textContent()) ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Everything the reading app was ever told on this page instance (#log: every access answer and
 * access-changed hint, plus the visible page): never the other candidate's name, never an app
 * id, and every view names ONE source — the one the user chose — with only what was ticked.
 */
async function expectReaderLearnedOnlyTheChosenSource(app: FrameLocator): Promise<{ frames: Record<string, unknown>[]; views: Record<string, unknown>[] }> {
  const log = (await app.locator('#log').textContent()) ?? '';
  const everything = (await app.locator('body').innerText()) + log;
  expect(everything, 'the app never learns the other candidate exists').not.toContain(OTHER);
  for (const id of [ids.ledger, ids.pantry, ids.budget]) expect(everything, 'no app id ever reaches the app').not.toContain(id);
  const frames = log
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const views = frames.flatMap((frame) => [
    ...(frame.grant !== undefined ? [frame.grant as Record<string, unknown>] : []),
    ...(Array.isArray(frame.grants) ? (frame.grants as Record<string, unknown>[]) : []),
  ]);
  for (const view of views) {
    expect(Object.keys(view).every((key) => ['id', 'access', 'source', 'tables', 'duration', 'expiresAt', 'unattended'].includes(key)), 'the view carries no other seat').toBe(true);
    expect(view.source).toEqual({ displayName: SOURCE, iconEmoji: '📒', iconColor: '#c9852b' });
    expect(view.tables).toEqual([{ name: 'transactions', columns: ['amount', 'category', 'date', 'note'] }]);
  }
  return { frames, views };
}

// ------------------------------------------------------------------------------------- the flow

test.describe('AC22 — access between apps, end to end (Playground)', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);
  test.describe.configure({ mode: 'serial' });

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.clock.install();
    await page.goto(`${APP_URL}/`);
    await expect(page.getByTestId('brain-chip')).toBeVisible({ timeout: 20_000 });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('1 · the three apps install as share-link bundles through Settings; each source’s first open creates its tables', async () => {
    test.setTimeout(180_000);
    expect(SOURCE_HTML.includes(LEDGER_LINE), 'the source fixture still has its one naming line').toBe(true);
    ids.ledger = await installBundle(
      page,
      'ledger.snug',
      bundle({ displayName: SOURCE, description: 'Keeps transactions and accounts.', iconEmoji: '📒', iconColor: '#c9852b', html: SOURCE_HTML }),
      'ready',
    );
    await expect(appFrame(page).locator('#counts')).toHaveText(`transactions: ${TRANSACTIONS} · accounts: 2`);
    ids.pantry = await installBundle(
      page,
      'pantry.snug',
      bundle({ displayName: OTHER, description: 'Keeps what is in the cupboard.', iconEmoji: '🥫', iconColor: '#7a9a3b', html: SOURCE_HTML.replace(LEDGER_LINE, PANTRY_LINE) }),
      'ready',
    );
    ids.budget = await installBundle(
      page,
      'budget.snug',
      bundle({ displayName: READER, description: 'Shows spending by category, from data another app keeps.', iconEmoji: '💸', iconColor: '#2f7de1', html: READER_HTML }),
      'ready',
    );
    expect(new Set([ids.ledger, ids.pantry, ids.budget]).size).toBe(3);
    // Nothing asked yet: Budget has no access state, so its header has no ⋈ (the ⚯ rule).
    await expect(page.getByTestId('access-app')).toHaveCount(0);
  });

  test('2 · request → the strip → review → the consent sheet → allow while it’s open → the query returns rows', async () => {
    test.setTimeout(90_000);
    const app = appFrame(page);
    await ask(page, app, { afterAnother: false });
    // A pending ask is access state: the ⋈ appears in the run header.
    await expect(page.getByRole('button', { name: ACCESS_SHEET.iconLabel, exact: true })).toBeVisible();

    const sheet = await review(page);
    // Who is asking: the LIBRARY name, and the provenance line the host derived from the install.
    await expect(sheet.getByTestId('access-sheet-title')).toHaveText(CONSENT_SHEET.title(READER));
    const shareLine = PROVENANCE.share('§').split('§').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    await expect(sheet.getByTestId('access-sheet-provenance')).toHaveText(new RegExp(`^${shareLine[0]}\\d{1,2} [A-Z][a-z]{2}(?: \\d{4})?${shareLine[1]}$`));
    await expect(sheet.getByTestId('access-sheet-provenance')).toContainText('not built by you');
    await expect(sheet.getByTestId('access-sheet-says')).toContainText(CONSENT_SHEET.says(READER));
    await expect(sheet.getByTestId('access-sheet-quote')).toHaveText(CONSENT_SHEET.quote(PURPOSE));
    // Initial focus on *not now* (a stray Enter is never an allow).
    await expect(sheet.getByTestId('access-not-now')).toBeFocused();

    // *from*: Ledger first and chosen, transactions pre-ticked by the hint; accounts not; api_key never shared.
    await expect(sheet.getByTestId('access-sources')).toBeVisible();
    await expect(sheet.getByTestId(`access-source-${ids.ledger}`)).toBeChecked();
    await expect(sheet.getByTestId(`access-source-row-${ids.ledger}`)).toContainText(SOURCE);
    await expect(sheet.getByTestId(`access-table-row-${ids.ledger}-transactions`)).toContainText(CONSENT_UI.tableRows('transactions', TRANSACTIONS));
    await expect(sheet.getByTestId(`access-table-${ids.ledger}-transactions`)).toBeChecked();
    await expect(sheet.getByTestId(`access-table-${ids.ledger}-accounts`)).not.toBeChecked();
    const apiKey = sheet.getByTestId(`access-chips-${ids.ledger}-accounts`).locator('[data-column="api_key"]');
    await expect(apiKey).toHaveAttribute('data-sensitive', 'true');
    await expect(apiKey).toContainText(CONSENT_SHEET.neverShared);
    for (const column of ['amount', 'category', 'date', 'note']) {
      await expect(sheet.getByTestId(`access-chips-${ids.ledger}-transactions`).locator(`[data-column="${column}"]`)).not.toHaveAttribute('data-sensitive', 'true');
    }
    // The USER sees the other candidate; the app never will (clause 8).
    await expect(sheet.getByTestId(`access-source-row-${ids.pantry}`)).toContainText(OTHER);
    await expect(sheet.getByTestId(`access-source-${ids.pantry}`)).not.toBeChecked();

    // *for how long*: the session is the default; the away box is not offered for it.
    await expect(sheet.getByTestId('access-durations')).toBeVisible();
    await expect(sheet.getByTestId('access-duration-session')).toBeChecked();
    await expect(sheet.getByTestId('access-away')).toHaveCount(0);

    // *where Budget can send what it reads*: its brain by name, every link it asks to open, the history line.
    await expect(sheet.getByTestId('access-egress-title')).toHaveText(CONSENT_SHEET.egressTitle(READER));
    const egress = sheet.getByTestId('access-egress');
    await expect(egress.locator('li[data-kind="brain"]')).toContainText('its AI — ');
    await expect(egress.locator('li[data-kind="open-url"]')).toHaveText(EGRESS.openUrl);
    await expect(egress.locator('li[data-kind="closing"]')).toHaveText(EGRESS.closing(SOURCE));

    // The primary names the choice and is armed only after 600 ms.
    const allow = sheet.getByTestId('access-allow');
    await expect(allow).toHaveText(allowLabel('session'));
    await expectArmedAfterDelay(page, sheet);
    await allow.click();
    await expect(consentSheet(page)).toHaveCount(0);

    const outcome = page.getByTestId('access-ask-outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'allowed');
    await expect(outcome).toHaveAttribute('role', 'status');
    await expect(outcome.getByTestId('access-ask-outcome-words')).toHaveText(STRIP_OUTCOME.allowed(READER, SOURCE, ['transactions'], 'session'));
    await expect(outcome.getByTestId('access-ask-undo')).toHaveText(STRIP_OUTCOME.undo);

    // What Budget learned: one source by name, the ticked table with its readable columns.
    await expect(app.locator('#status')).toHaveText('request: ok');
    await expect(app.locator('#result')).toHaveText(`from ${SOURCE} · tables: transactions · session`);
    const view = await heldView(app);
    expect(view.tables).toEqual([{ name: 'transactions', columns: ['amount', 'category', 'date', 'note'] }]);

    await app.locator('#query').click();
    await expect(app.locator('#status')).toHaveText('query: ok', { timeout: 10_000 });
    await expect(app.locator('#result')).toHaveText(`rows: ${TRANSACTIONS} · columns: amount, category`);
    expect((await expectReaderLearnedOnlyTheChosenSource(app)).views).toHaveLength(1);
  });

  test('3 · a day’s access: the source’s ⋈ sheet shows what reads Ledger and the history row of the read', async () => {
    test.setTimeout(90_000);
    const app = appFrame(page);
    await ask(page, app, { afterAnother: true });
    const sheet = await review(page);
    await sheet.getByTestId('access-duration-day').check();
    const allow = sheet.getByTestId('access-allow');
    await expect(allow).toHaveText(allowLabel('day'));
    await expect(sheet.getByTestId('access-away'), 'a persisted access offers the away box, unticked').not.toBeChecked();
    await expectArmedAfterDelay(page, sheet);
    await allow.click();
    await expect(page.getByTestId('access-ask-outcome').getByTestId('access-ask-outcome-words')).toHaveText(STRIP_OUTCOME.allowed(READER, SOURCE, ['transactions'], 'day'));
    await expect(app.locator('#result')).toHaveText(`from ${SOURCE} · tables: transactions · day`);
    held.day = String((await heldView(app)).id);
    await expect(app.locator('#held')).toHaveText(held.day);

    await app.locator('#query').click();
    await expect(app.locator('#status')).toHaveText('query: ok', { timeout: 10_000 });
    await expect(app.locator('#result')).toHaveText(`rows: ${TRANSACTIONS} · columns: amount, category`);
    expect((await expectReaderLearnedOnlyTheChosenSource(app)).views, 'the two allows this page instance heard').toHaveLength(2);

    // The source's side.
    await openApp(page, ids.ledger);
    const door = page.getByRole('button', { name: ACCESS_SHEET.iconLabel, exact: true });
    await expect(door).toBeVisible({ timeout: 10_000 });
    await expect(door).toHaveAttribute('aria-haspopup', 'dialog');
    await door.click();
    const own = page.getByRole('dialog', { name: ACCESS_SHEET.title(SOURCE) });
    await expect(own).toBeVisible();
    const readBy = own.getByTestId('access-read-by');
    await expect(readBy).toContainText(ACCESS_SHEET.readBy(SOURCE));
    // Only the day's access: the session access of clause 2 ended when Budget's view closed.
    const rows = readBy.getByTestId('access-row');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-access-id', held.day);
    await expect(rows.first()).toHaveAttribute('data-side', 'read-by');
    await expect(rows.first().getByTestId('access-row-sentence')).toHaveText(ACCESS_SHEET.row(READER, SOURCE, ['transactions']));
    await expect(rows.first().locator('[data-known="true"]')).toHaveText(SOURCE);
    await expect(rows.first().getByTestId('access-row-act')).toHaveAttribute('data-act', 'stop');

    const history = own.getByTestId('access-history');
    const reads = history.locator('[data-testid="access-history-row"][data-kind="read"]');
    await expect(reads.first()).toBeVisible();
    await expect(reads.first().getByTestId('access-history-who')).toHaveText(READER);
    await expect(reads.first().getByTestId('access-history-words')).toContainText(`read transactions · ${TRANSACTIONS} rows`);
    await expect(reads.first().getByTestId('access-history-words')).toContainText('while you were here');
    await expect(reads.first().getByTestId('access-history-asked').locator('code')).toHaveText('SELECT amount, category FROM transactions ORDER BY amount DESC');
    await own.getByTestId('access-sheet-close').click();
    await expect(own).toHaveCount(0);
  });

  test('4 · Settings → access between apps → stop: the next query is ACCESS_REVOKED', async () => {
    test.setTimeout(60_000);
    await page.getByRole('link', { name: 'settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    const card = page.getByTestId('access-settings-card');
    await card.scrollIntoViewIfNeeded();
    await expect(page.getByTestId('settings-section-access-between-apps')).toContainText(SETTINGS_CARD.title);
    const row = card.getByTestId('access-settings-rows').locator(`[data-testid="access-row"][data-access-id="${held.day}"]`);
    await expect(row).toHaveAttribute('data-side', 'every');
    await expect(row.getByTestId('access-row-sentence')).toHaveText(ACCESS_SHEET.row(READER, SOURCE, ['transactions']));
    const act = row.getByTestId('access-row-act');
    await expect(act).toHaveText(GRANT_ACTS.stop);
    await act.click();
    await expect(act).toHaveAttribute('data-act', 'remove');
    await expect(row.getByTestId('access-row-words')).toContainText('stopped');

    const app = await openApp(page, ids.budget);
    await expect(app.locator('#held'), 'Budget kept the id it was answered').toHaveText(held.day);
    await app.locator('#query').click();
    await expect(app.locator('#status')).toHaveText('query: ACCESS_REVOKED', { timeout: 10_000 });
    await expect(app.locator('#result')).toContainText('ACCESS_REVOKED · final');
  });

  test('5 · not now → ACCESS_DECLINED, retryable, nothing recorded', async () => {
    const app = appFrame(page);
    await ask(page, app, { afterAnother: true });
    await strip(page).getByTestId('access-ask-not-now').click();
    const outcome = page.getByTestId('access-ask-outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'not-now');
    await expect(outcome).toHaveText(STRIP_OUTCOME.notNow(READER));
    await expect(app.locator('#status')).toHaveText('request: ACCESS_DECLINED');
    await expect(app.locator('#result')).toContainText('ACCESS_DECLINED · retryable');
  });

  test('6 · a table the user did not tick is ABSENT; the WITH RECURSIVE bomb fails within 3 s while the page stays responsive', async () => {
    test.setTimeout(90_000);
    const app = appFrame(page);
    // Not now recorded nothing: the same ask reaches the user again.
    await ask(page, app, { afterAnother: true });
    const sheet = await review(page);
    await expect(sheet.getByTestId(`access-table-${ids.ledger}-accounts`)).not.toBeChecked();
    await sheet.getByTestId('access-duration-day').check();
    await expectArmedAfterDelay(page, sheet);
    await sheet.getByTestId('access-allow').click();
    await expect(app.locator('#status')).toHaveText('request: ok');
    held.bomb = String((await heldView(app)).id);
    await expect(app.locator('#held')).toHaveText(held.bomb);

    // accounts was never ticked: the scoped copy does not hold it at all.
    await app.locator('#query-accounts').click();
    await expect(app.locator('#status')).toHaveText('query: ACCESS_QUERY_FAILED', { timeout: 10_000 });
    await expect(app.locator('#result')).toContainText('no such table');
    await expect(app.locator('#result')).toContainText('accounts');

    // The bomb: the Worker's wall clock (2 s) stops it; the host chrome answers meanwhile.
    const themeToggle = page.locator('header.shell-header').getByRole('button', { name: /^switch to (dark|light) theme$/ });
    const before = await themeToggle.getAttribute('aria-label');
    const startedAt = Date.now();
    await app.locator('#bomb').click();
    await expect(app.locator('#status')).toHaveText('query: waiting');
    await themeToggle.click();
    await expect(themeToggle, 'the host chrome reacts while the read runs').not.toHaveAttribute('aria-label', before as string, { timeout: 1_000 });
    await expect(app.locator('#status'), 'the read was still running when the chrome reacted').toHaveText('query: waiting');
    // A floor on the wait: Playwright reads `timeout: 0` as NO timeout, so a loaded machine could
    // otherwise wait forever here; the 3 s claim is asserted on the measured wall time just below.
    await expect(app.locator('#status')).toHaveText('query: ACCESS_QUERY_FAILED', { timeout: Math.max(500, 3_000 - (Date.now() - startedAt)) });
    const elapsed = Date.now() - startedAt;
    expect(elapsed, 'a named error within 3 s').toBeLessThan(3_000);
    expect(elapsed, 'stopped by the host’s wall clock, not by an early refusal').toBeGreaterThanOrEqual(ACCESS_QUERY_TIMEOUT_MS - 250);
    await expect(app.locator('#result')).toContainText('took too long');
    await themeToggle.click();
    await expect(themeToggle).toHaveAttribute('aria-label', before as string);
  });

  test('7 · a stop while Budget is open rings it: access-changed with the access id, and the read after it is ACCESS_REVOKED', async () => {
    const app = appFrame(page);
    const door = page.getByRole('button', { name: ACCESS_SHEET.iconLabel, exact: true });
    await door.click();
    await expect(door).toHaveAttribute('aria-expanded', 'true');
    const own = page.getByRole('dialog', { name: ACCESS_SHEET.title(READER) });
    await expect(own).toBeVisible();
    const row = own.getByTestId('access-reads').locator(`[data-testid="access-row"][data-access-id="${held.bomb}"]`);
    await expect(row).toHaveAttribute('data-side', 'reads');
    await expect(row.locator('[data-known="true"]')).toHaveText(READER);
    await row.getByTestId('access-row-act').click();
    await expect(row.getByTestId('access-row-act')).toHaveAttribute('data-act', 'remove');
    await own.getByTestId('access-sheet-close').click();
    await expect(own).toHaveCount(0);

    await expect(app.locator('#changed')).toHaveText(`access-changed ${held.bomb}`);
    await expect(app.locator('#status')).toHaveText(`access-changed ${held.bomb}`);
    await app.locator('#requery').click();
    await expect(app.locator('#status')).toHaveText('query: ACCESS_REVOKED', { timeout: 10_000 });
  });

  test('8 · the reading app never saw the app list — only the one source the user chose, by name', async () => {
    const app = appFrame(page);
    await app.locator('#list').click();
    await expect(app.locator('#status')).toHaveText('list: ok');
    await expect(app.locator('#result')).toHaveText('holds: 0');

    // This page instance opened in clause 4 and was answered ONE allow since (clause 6); clauses 2
    // and 3 ran the same check on the instance that heard theirs.
    const { frames, views } = await expectReaderLearnedOnlyTheChosenSource(app);
    expect(views.length, 'the one allow this page instance heard').toBe(1);
    const changes = frames.filter((frame) => frame.type === 'snug:host-event');
    expect(changes).toEqual([expect.objectContaining({ event: 'access-changed', data: { grantId: held.bomb } })]);
  });

  test('9 · 375 px: the owned-app header with the ⋈, the strip and the consent sheet — no horizontal overflow', async () => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 375, height: 667 });
    const viewport = 375;
    const app = appFrame(page);
    const door = page.getByRole('button', { name: ACCESS_SHEET.iconLabel, exact: true });
    await expect(door).toBeVisible();
    const cluster = door.locator('..');
    const buttons = cluster.getByRole('button');
    for (let i = 0; i < (await buttons.count()); i += 1) {
      const box = await buttons.nth(i).boundingBox();
      if (box === null) continue;
      expect(box.x, 'a header control starts on screen').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'a header control ends on screen').toBeLessThanOrEqual(viewport + 1);
    }
    await expectNoHorizontalScroll(page);

    await ask(page, app, { afterAnother: true });
    await expectNoHorizontalScroll(page);
    const sheet = await review(page);
    const card = sheet.locator('.net-confirm-card');
    const box = await card.boundingBox();
    expect(box, 'the sheet has a card').not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.width, 'the sheet’s card fits the viewport').toBeLessThanOrEqual(viewport);
    const cardOverflow = await card.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(cardOverflow, 'the card never scrolls sideways').toBeLessThanOrEqual(1);
    await expectNoHorizontalScroll(page);
    await sheet.getByTestId('access-not-now').click();
    await expect(consentSheet(page)).toHaveCount(0);
    await expect(app.locator('#status')).toHaveText('request: ACCESS_DECLINED');
    await expectNoHorizontalScroll(page);
  });
});
