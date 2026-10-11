// kit-access.spec.ts — access between apps on the REAL built page (TASK-20261010-cross-app-access
// AC23; ADR-0075 §6; D10). The unit suites prove the engine with an injected `WorkerLike`; this
// proves the ONE thing only the single-file build can: the read's Worker (Vite `?worker&inline`,
// a Blob URL at runtime) and the sql.js engine bytes it is handed both survive `inlineSingleFile`
// and answer a real query, in a real browser, served the way an artifact is.
//
//   1. #/settings on the built page renders the *access between apps* card.
//   2. Capability truth (ADR-0072 §4). The page carries no window handle onto its platform, so
//      the truth is read where an app reads it — `host-ready.capabilities.access`, rendered by
//      the helpers' probe app (`capsAppHtml`) installed through the kit's own *add shared app*
//      path — beside the Settings card and the page's own `new Worker(blob:)`. A second page
//      whose `Worker` throws before boot (an init script) is composed `access: false`: the probe
//      reads `access` false and the Settings card is absent.
//   3. The playground's two fixture apps (apps/playground/e2e/fixtures/access-reader.html and
//      access-source.html — read by path, never copied) installed through *add shared app*: the
//      source writes its row, the reader asks after a click, the strip renders, *review* → the
//      sheet → *allow* → the reader's `query` answers ONE row. The console carries no failed
//      worker or wasm load.
//   4. (TASK-20261010-host-broker PR-3, AC28) the same two walks as the playground's clauses 10 and
//      11, on the single file: the WRITE + UNDO walk (an ask carrying `access: 'write'`, the write
//      toggle offered at once, ONE UPDATE answered `changes: 1`, the source's ⋈ history shows the
//      change and *undo* puts the row back) and the REFRESH walk (the playground's
//      access-source-fetch.html as the fetching source: `fresh: true` and its counter moved, then
//      `recent`; the handler-less Ledger → ACCESS_REFRESH_FAILED once the 90 s bound is crossed on
//      the page clock). The kit boots the scheduler with the page (its scheduler seat), so the
//      refresh engine's gates pass.
//
// Scoped run (after `pnpm --filter host build`): `pnpm --filter host exec playwright test e2e/kit-access.spec.ts`
// — NOT `test:e2e -- <file>`: pnpm forwards the literal `--` and Playwright then runs the whole suite.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';

import { ACCESS_REQUEST_MIN_GAP_MS } from '@snugprotocol/protocol';

import { ACCESS_SHEET, CONSENT_SHEET, EGRESS, SETTINGS_CARD, STRIP, STRIP_OUTCOME, historyLine } from '../../playground/src/access/copy';
import { KIT_URL, capsAppHtml, installRoutePolicy, watchConsole } from './helpers';

const appFrame = (page: Page): FrameLocator => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
const OWNED_ROUTE = /#\/run\/(?!starter--|shared--)[0-9a-f-]{36}$/;

/** The playground's fixture apps, by path — read, never copied (AC22 owns them). */
const fixture = (file: string): string => fs.readFileSync(fileURLToPath(new URL(`../../playground/e2e/fixtures/${file}`, import.meta.url)), 'utf8');
/** The names the fixtures announce (each fixture's `useSnugApp` meta) — the bundle carries the same. */
const READER = 'Budget';
const SOURCE = 'Ledger';
/** The reader's *show spending* SELECT returns every seeded `transactions` row: the source seeds four (access-source.html TRANSACTIONS). */
const SEEDED_TRANSACTIONS = 4;
/** PR-3: the fetching source (access-source-fetch.html's `useSnugApp` meta). */
const BANK = 'Bank';
/** The reader fixture's #write statement (access-reader.html WRITE_SQL). */
const WRITE_SQL = "UPDATE transactions SET note = 'checked' WHERE category = 'music'";

/** The access card, by the heading its Section draws and the card's own testid. */
const accessSection = (page: Page) => page.getByTestId('settings-section-access-between-apps');

/** A `snug-app-bundle/1` document — the shape *add shared app* reads (schedule-flow.spec's). */
function bundle(displayName: string, html: string, lineage: string, iconEmoji = '🔗'): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: 'snug-app-bundle/1',
      lineage,
      sharedAt: '2026-10-10T15:00:00.000Z',
      app: { displayName, description: `${displayName} — kit access e2e`, iconEmoji, iconColor: '#3ba36f', usesDb: true },
      html,
      connections: [],
    }),
  );
}

/** Through the kit's own path: Settings → *add shared app* → the preview → *install*. Answers the owned app id. */
async function installShared(page: Page, name: string, file: Buffer): Promise<string> {
  await page.evaluate(() => {
    location.hash = '#/settings';
  });
  await expect(page.getByTestId('add-shared-app')).toBeVisible({ timeout: 20_000 });
  await page
    .locator('[data-testid="add-shared-app"] input[type="file"]')
    .setInputFiles({ name: `${name}.snug`, mimeType: 'application/json', buffer: file });
  await expect(page).toHaveURL(/#\/run\/shared--[0-9a-f]{64}/, { timeout: 20_000 });
  await page.getByTestId('shared-install').click();
  await expect(page).toHaveURL(OWNED_ROUTE, { timeout: 20_000 });
  return page.url().split('/').pop() as string;
}

/** The probe app's `host-ready.capabilities`, as the frame received them. */
async function frameCapabilities(page: Page): Promise<Record<string, unknown>> {
  const caps = appFrame(page).locator('#caps');
  await expect(caps).not.toBeEmpty({ timeout: 30_000 });
  return JSON.parse((await caps.textContent()) ?? '{}') as Record<string, unknown>;
}

/** Whether this page can construct a blob Worker — the same construction the kit's boot probe makes. */
async function pageBuildsBlobWorker(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    try {
      const url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
      try {
        new Worker(url).terminate();
        return true;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch {
      return false;
    }
  });
}

/**
 * The probe app's own designed refusal: it fetches https://example.com/probe so the frame's CSP
 * can be seen to block it (kit.spec AC7). Those two console lines are the probe working — any
 * OTHER error line is a defect.
 */
const notTheProbesOwnFetch = (errors: string[]): string[] => errors.filter((line) => !line.includes('https://example.com/probe'));

/** A console line that would mean the inlined worker or its engine bytes did not load. */
const WORKER_OR_WASM_FAILURE = /worker|wasm|webassembly|sql-wasm|blob:/i;

test.describe('AC23 — access between apps on the built kit page (served over loopback http)', () => {
  test('Settings shows the access card; a blob Worker constructs and the frame is told access: true', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(`${KIT_URL}#/settings`);

    const section = accessSection(page);
    await expect(section).toBeVisible({ timeout: 20_000 });
    await expect(section.getByRole('heading', { level: 2, name: SETTINGS_CARD.title })).toBeVisible();
    await expect(section.getByTestId('access-settings-card')).toBeVisible();
    await expect(section.getByTestId('access-settings-intro')).toHaveText(SETTINGS_CARD.intro);
    await expect(section.getByTestId('access-settings-empty')).toHaveText(SETTINGS_CARD.empty);
    await expect(section.getByRole('switch', { name: SETTINGS_CARD.neverAsk })).toBeVisible();

    // The precondition the flag is derived from, measured in this page.
    expect(await pageBuildsBlobWorker(page)).toBe(true);

    // The truth an app reads: an OWNED app's host-ready capabilities.
    await installShared(page, 'caps-probe', bundle('caps probe', capsAppHtml(), '7d1c0a52-1e0b-4c55-9f1e-0a6b5c4d3e21', '🔍'));
    const caps = await frameCapabilities(page);
    expect(caps.access, 'host-ready.capabilities.access on a page whose Worker constructs').toBe(true);

    expect(policy.blocked).toEqual([]);
    expect(notTheProbesOwnFetch(errors)).toEqual([]);
  });

  test('a page whose Worker cannot be constructed is composed access: false — no access card, and the frame is told false', async ({ page }) => {
    // Before ANY page script: every Worker construction throws, as under a `worker-src 'none'`
    // CSP or an embedder that strips Workers. The boot's one probe must see it.
    await page.addInitScript(() => {
      const refuse = function Worker(): never {
        throw new DOMException('workers are not allowed here', 'SecurityError');
      };
      Object.defineProperty(window, 'Worker', { value: refuse, configurable: true, writable: true });
    });
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(`${KIT_URL}#/settings`);

    // The negative twin of the case above: the precondition is gone in this page …
    expect(await pageBuildsBlobWorker(page)).toBe(false);
    // … so Settings has no access card (every access surface is gated on the flag) …
    await expect(page.getByTestId('settings-section-your-file')).toBeVisible({ timeout: 20_000 });
    await expect(accessSection(page)).toHaveCount(0);
    await expect(page.getByTestId('access-settings-card')).toHaveCount(0);

    // … and an owned app is told access is not offered.
    await installShared(page, 'caps-probe', bundle('caps probe', capsAppHtml(), '7d1c0a52-1e0b-4c55-9f1e-0a6b5c4d3e22', '🔍'));
    const caps = await frameCapabilities(page);
    expect(caps.access === true, `host-ready.capabilities.access must not be true here (got ${String(caps.access)})`).toBe(false);
    // The ⋈ header button is gated on the same flag.
    await expect(page.getByTestId('access-app')).toHaveCount(0);

    expect(policy.blocked).toEqual([]);
    expect(notTheProbesOwnFetch(errors)).toEqual([]);
  });

  test('the reader asks after a click, the strip renders, review → allow, and the inlined Worker answers the query on the single file', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    // EVERY console line, unfiltered: watchConsole's benign list hides `Failed to load resource`,
    // which is exactly what a blob worker or an engine fetch that did not load would print.
    const raw: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') raw.push(`${message.type()}: ${message.text()}`);
    });
    // Every Worker this page constructs — the read must be one of them (D10: never the main thread).
    const workers: string[] = [];
    page.on('worker', (worker) => workers.push(worker.url()));
    await page.goto(`${KIT_URL}#/settings`);
    await expect(accessSection(page)).toBeVisible({ timeout: 20_000 });

    // The source first: its first open creates `transactions` + `accounts` and seeds them.
    const sourceId = await installShared(page, 'ledger', bundle(SOURCE, fixture('access-source.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a11', '📒'));
    await expect(appFrame(page).locator('#status')).toHaveText('ready', { timeout: 30_000 });
    await expect(appFrame(page).locator('#counts')).toHaveText(`transactions: ${SEEDED_TRANSACTIONS} · accounts: 2`);

    const readerId = await installShared(page, 'budget', bundle(READER, fixture('access-reader.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a12', '💸'));
    const reader = appFrame(page);
    await expect(reader.getByRole('button', { name: "use another app's data" })).toBeVisible({ timeout: 30_000 });
    // Nothing asked on load: no strip until the user's click.
    await expect(page.getByTestId('access-ask')).toHaveCount(0);

    // The ask — a user act inside the app.
    await reader.getByRole('button', { name: "use another app's data" }).click();
    await expect(reader.locator('#status')).toHaveText('request: waiting');

    // The strip, above the app — never a modal.
    const strip = page.getByTestId('access-ask');
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await expect(strip).toHaveAttribute('data-app', readerId);
    await expect(strip.getByTestId('access-ask-title')).toHaveText(STRIP.title(READER));
    await expect(strip.getByTestId('access-ask-quote')).toHaveText(STRIP.quote('to show spending by category'));
    await page.screenshot({ path: 'test-results/kit-access-strip.png' });

    // *review* → the host's consent sheet (named by its title — the ⋈ sheet shares the testid).
    await strip.getByRole('button', { name: STRIP.review }).click();
    const sheet = page.getByRole('dialog', { name: STRIP.title(READER) });
    await expect(sheet).toBeVisible();
    // The source is the one the reader's hints matched; `transactions` is pre-ticked, `accounts` is not.
    await expect(sheet.getByTestId(`access-source-${sourceId}`)).toBeChecked();
    await expect(sheet.getByTestId(`access-table-${sourceId}-transactions`)).toBeChecked();
    await expect(sheet.getByTestId(`access-table-${sourceId}-accounts`)).not.toBeChecked();
    await expect(sheet.getByTestId('access-duration-session')).toBeChecked();
    await page.screenshot({ path: 'test-results/kit-access-sheet.png' });
    const allow = sheet.getByTestId('access-allow');
    await expect(allow).toBeEnabled({ timeout: 5_000 }); // armed after its 600 ms
    await allow.click();
    await expect(sheet).toBeHidden();

    // The reader learns what was allowed; the strip says it in words.
    await expect(reader.locator('#status')).toHaveText('request: ok', { timeout: 20_000 });
    await expect(reader.locator('#result')).toHaveText(`from ${SOURCE} · tables: transactions · session`);
    const outcome = page.getByTestId('access-ask-outcome');
    await expect(outcome).toHaveAttribute('data-outcome', 'allowed');
    await expect(outcome.getByTestId('access-ask-outcome-words')).toHaveText(STRIP_OUTCOME.allowed(READER, SOURCE, ['transactions'], 'session'));

    // THE READ. It runs in the inlined Worker on the engine bytes the single file carries.
    const workersBefore = workers.length;
    await reader.getByRole('button', { name: 'show spending' }).click();
    await expect(reader.locator('#status')).toHaveText('query: ok', { timeout: 20_000 });
    await expect(reader.locator('#result')).toHaveText(`rows: ${SEEDED_TRANSACTIONS} · columns: amount, category`);
    const readWorkers = workers.slice(workersBefore);
    expect(readWorkers.length, 'the read constructed its Worker').toBeGreaterThanOrEqual(1);
    expect(readWorkers.every((url) => url.startsWith('blob:')), `the read's Worker is the inlined one (a Blob URL), never a fetched script: ${readWorkers.join(', ')}`).toBe(true);
    // The scoping ran in that Worker too: a table the user did not tick is not there at all.
    await reader.getByRole('button', { name: 'read accounts' }).click();
    await expect(reader.locator('#status')).toHaveText('query: ACCESS_QUERY_FAILED', { timeout: 20_000 });

    // Nothing the read needed left the page or failed to load.
    expect(policy.blocked).toEqual([]);
    expect(policy.all.filter((url) => /sql-wasm|\.wasm(\?|$)/i.test(url)), 'no engine fetch — the bytes ride inline').toEqual([]);
    expect(raw.filter((line) => WORKER_OR_WASM_FAILURE.test(line)), 'no failed worker or wasm load').toEqual([]);
    expect(errors).toEqual([]);
  });

  // ------------------------------------------------------------------------------------------
  // TASK-20261010-host-broker PR-3 (AC28) — the write + undo walk and the refresh walk on the kit
  // ------------------------------------------------------------------------------------------

  /** A same-document hash write — never a reload (the file lives in this page's storage). */
  async function openOwned(page: Page, appId: string): Promise<FrameLocator> {
    await page.evaluate((id) => {
      location.hash = `#/run/${id}`;
    }, appId);
    const app = appFrame(page);
    await expect(app.locator('main')).toBeVisible({ timeout: 30_000 });
    return app;
  }

  /** The strip's *review* → the consent sheet named by `title`. */
  async function reviewAs(page: Page, title: string): Promise<Locator> {
    const strip = page.getByTestId('access-ask');
    await expect(strip).toBeVisible({ timeout: 20_000 });
    await strip.getByRole('button', { name: STRIP.review }).click();
    const sheet = page.getByRole('dialog', { name: title });
    await expect(sheet).toBeVisible();
    return sheet;
  }

  async function openMoreOptions(sheet: Locator): Promise<void> {
    const more = sheet.getByTestId('access-options-more');
    await expect(more).toBeVisible();
    const tag = await more.evaluate((el) => el.tagName);
    if (tag === 'DETAILS') {
      if ((await more.getAttribute('open')) === null) await more.locator('summary').first().click();
    } else {
      await more.click();
    }
  }

  test('PR-3 write + undo: an ask with access write, the toggle offered at once, one UPDATE changes one row, and *undo* on the source’s history puts it back', async ({ page }) => {
    test.setTimeout(180_000);
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/settings`);
    await expect(accessSection(page)).toBeVisible({ timeout: 20_000 });
    const sourceId = await installShared(page, 'ledger', bundle(SOURCE, fixture('access-source.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a21', '📒'));
    await expect(appFrame(page).locator('#status')).toHaveText('ready', { timeout: 30_000 });
    const readerId = await installShared(page, 'budget', bundle(READER, fixture('access-reader.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a22', '💸'));
    const reader = appFrame(page);
    await expect(reader.getByRole('button', { name: 'ask to read and change data' })).toBeVisible({ timeout: 30_000 });

    await reader.getByRole('button', { name: 'ask to read and change data' }).click();
    await expect(reader.locator('#status')).toHaveText('request: waiting');
    await expect(page.getByTestId('access-ask').getByTestId('access-ask-title')).toHaveText(STRIP.title(READER, true), { timeout: 20_000 });
    const sheet = await reviewAs(page, CONSENT_SHEET.title(READER, true));
    const toggle = sheet.getByTestId(`access-write-${sourceId}-transactions`);
    await expect(toggle, 'offered without a click for a write ask').toBeVisible();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(sheet).toContainText(CONSENT_SHEET.undoNote(SOURCE, 'transactions', READER));
    await expect(sheet.getByTestId('access-egress').locator('li[data-kind="closing"]')).toHaveText(EGRESS.closing(SOURCE, true));
    await sheet.getByTestId('access-duration-day').check();
    const allow = sheet.getByTestId('access-allow');
    await expect(allow).toBeEnabled({ timeout: 5_000 });
    await allow.click();
    await expect(sheet).toBeHidden();
    await expect(reader.locator('#status')).toHaveText('request: ok', { timeout: 20_000 });
    await expect(page.getByTestId('access-ask-outcome').getByTestId('access-ask-outcome-words')).toHaveText(
      STRIP_OUTCOME.allowed(READER, SOURCE, ['transactions'], 'day', ['transactions']),
    );

    await reader.getByRole('button', { name: 'show the music note' }).click();
    await expect(reader.locator('#peeked')).toHaveText('note: monthly plan', { timeout: 20_000 });
    await reader.getByRole('button', { name: 'mark the music row checked' }).click();
    await expect(reader.locator('#status')).toHaveText('write: ok', { timeout: 20_000 });
    await expect(reader.locator('#result')).toHaveText('changes: 1');
    await reader.getByRole('button', { name: 'show the music note' }).click();
    await expect(reader.locator('#peeked')).toHaveText('note: checked', { timeout: 20_000 });

    // The source's ⋈ history: the change, what it changed, and its undo.
    await openOwned(page, sourceId);
    await page.getByRole('button', { name: ACCESS_SHEET.iconLabel, exact: true }).click();
    const own = page.getByRole('dialog', { name: ACCESS_SHEET.title(SOURCE) });
    await expect(own).toBeVisible();
    const wrote = own.getByTestId('access-history').locator('[data-testid="access-history-row"][data-kind="wrote"]');
    await expect(wrote).toHaveCount(1);
    await expect(wrote.getByTestId('access-history-who')).toHaveText(READER);
    const now = await page.evaluate(() => Date.now());
    const line = historyLine({ at: new Date(now).toISOString(), kind: 'wrote', via: 'app', changes: 1, tables: ['transactions'] } as never, now, READER);
    await expect(wrote.getByTestId('access-history-words')).toContainText(line.split(' · ')[0] as string);
    await expect(wrote.getByTestId('access-history-asked').locator('summary')).toHaveText(ACCESS_SHEET.whatItChanged);
    await expect(wrote.getByTestId('access-history-asked').locator('code')).toHaveText(WRITE_SQL);
    await wrote.getByTestId('access-history-undo').click();
    const confirm = own.getByTestId('access-undo-confirm');
    await expect(confirm).toContainText(ACCESS_SHEET.undoArm('transactions', 1, SOURCE));
    await confirm.getByTestId('access-undo-yes').click();
    await expect(own.getByTestId('access-history-undo-outcome')).toHaveText(ACCESS_SHEET.undone, { timeout: 20_000 });
    await expect(own.getByTestId('access-history').locator('[data-testid="access-history-row"][data-kind="undone"]').getByTestId('access-history-who')).toHaveText('you');
    await own.getByTestId('access-sheet-close').click();

    const reopened = await openOwned(page, readerId);
    await reopened.getByRole('button', { name: 'show the music note' }).click();
    await expect(reopened.locator('#peeked')).toHaveText('note: monthly plan', { timeout: 20_000 });
    expect(policy.blocked).toEqual([]);
  });

  test('PR-3 refresh: fetch-first on the fetching source → fresh and its counter moved; again → recent; the handler-less Ledger → ACCESS_REFRESH_FAILED', async ({ page }) => {
    test.setTimeout(240_000);
    // The clock BEFORE goto (the schedule.spec pattern): the handler-less run's 90 s bound is crossed on it.
    await page.clock.install();
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/settings`);
    await expect(accessSection(page)).toBeVisible({ timeout: 20_000 });
    const ledgerId = await installShared(page, 'ledger', bundle(SOURCE, fixture('access-source.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a31', '📒'));
    await expect(appFrame(page).locator('#status')).toHaveText('ready', { timeout: 30_000 });
    const bankId = await installShared(page, 'bank', bundle(BANK, fixture('access-source-fetch.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a32', '🏦'));
    await expect(appFrame(page).locator('#status')).toHaveText('ready', { timeout: 30_000 });
    await expect(appFrame(page).locator('#counts')).toHaveText(`transactions: ${SEEDED_TRANSACTIONS} · accounts: 2 · fetches: 0`);
    await installShared(page, 'budget', bundle(READER, fixture('access-reader.html'), '0b6f2a4e-8d3c-4e1f-a2b5-6c7d8e9f0a33', '💸'));
    const reader = appFrame(page);
    await expect(reader.getByRole('button', { name: "use another app's data" })).toBeVisible({ timeout: 30_000 });

    // A read ask; Bank, its counter table, and *fetch new data before reading it*.
    await reader.getByRole('button', { name: "use another app's data" }).click();
    let sheet = await reviewAs(page, STRIP.title(READER));
    await sheet.getByTestId(`access-source-${bankId}`).check();
    await sheet.getByTestId(`access-table-${bankId}-fetches`).check();
    await openMoreOptions(sheet);
    await expect(sheet).toContainText(CONSENT_SHEET.fetchFirst(BANK));
    await sheet.getByTestId('access-refresh').check();
    await sheet.getByTestId('access-duration-day').check();
    await expect(sheet.getByTestId('access-allow')).toBeEnabled({ timeout: 5_000 });
    await sheet.getByTestId('access-allow').click();
    await expect(reader.locator('#status')).toHaveText('request: ok', { timeout: 20_000 });

    await reader.getByRole('button', { name: 'count the fetches' }).click();
    await expect(reader.locator('#peeked')).toHaveText('fetches: 0 · asked by null', { timeout: 20_000 });
    await reader.getByRole('button', { name: 'ask for fresh data' }).click();
    await expect(reader.locator('#status')).toHaveText('refresh: ok', { timeout: 90_000 });
    await expect(reader.locator('#result')).toHaveText('fresh: true');
    await reader.getByRole('button', { name: 'count the fetches' }).click();
    await expect(reader.locator('#peeked')).toHaveText(`fetches: 1 · asked by ${READER}`, { timeout: 20_000 });
    await reader.getByRole('button', { name: 'ask for fresh data' }).click();
    await expect(reader.locator('#status')).toHaveText('refresh: ok', { timeout: 20_000 });
    await expect(reader.locator('#result')).toHaveText('fresh: false · recent');

    // The handler-less Ledger.
    await page.clock.fastForward(ACCESS_REQUEST_MIN_GAP_MS);
    await reader.getByRole('button', { name: "use another app's data" }).click();
    sheet = await reviewAs(page, STRIP.title(READER));
    await sheet.getByTestId(`access-source-${ledgerId}`).check();
    await openMoreOptions(sheet);
    await sheet.getByTestId('access-refresh').check();
    await sheet.getByTestId('access-duration-day').check();
    await expect(sheet.getByTestId('access-allow')).toBeEnabled({ timeout: 5_000 });
    await sheet.getByTestId('access-allow').click();
    await expect(reader.locator('#status')).toHaveText('request: ok', { timeout: 20_000 });
    await reader.getByRole('button', { name: 'ask for fresh data' }).click();
    await expect(reader.locator('#status')).toHaveText('refresh: waiting');
    await expect
      .poll(
        async () => {
          await page.clock.fastForward(15_000);
          return reader.locator('#status').textContent();
        },
        { timeout: 90_000, intervals: [1_000] },
      )
      .toBe('refresh: ACCESS_REFRESH_FAILED');
    await expect(reader.locator('#result')).toContainText('ACCESS_REFRESH_FAILED · final');
    expect(policy.blocked).toEqual([]);
  });
});
