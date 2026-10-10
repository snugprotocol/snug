// schedule-flow.spec.ts — TASK-20261009-scheduling-framework A8: a scheduled *Run [app]* against
// the net stub, in the real playground app under a faked clock (ADR-0074 §3 the kv handshake,
// §5 catch-up, §6 the unattended posture).
//
//   1. A GET run: the fixture app (e2e/fixtures/schedule-app.html — the copy-exactly hooks block
//      plus the KB's schedule listener) is installed from a `.snug` bundle through Settings, its
//      declared connection to the stub is approved in the wizard, a *run Schedule App* schedule
//      with input {fetch:true} is created every hour through the editor, the clock jumps past the
//      hour, and the result row reads *done* with the app's own summary of the scrubbed GET.
//   2. A POST run: the same, with {post:true}. The scheduled gate refuses the mutating call
//      while nobody is present, so the run lands as *needs you* with its one act, *run now and
//      review* — and the stub's key never shows.
//   3. 48 hourly misses: the system time jumps 48½ hours with no timer fired, a dispatched
//      `visibilitychange` wakes the reconcile, and the missed card carries ONE pending row that
//      reads "missed 48 times → runs once".
//   4. ADR-0077 (TASK-20261010-host-broker PR-1): with the app OPEN at due time the run is
//      delegated to the visible frame — no hidden copy ever mounts — and reads *done*; a POST in
//      such a run opens the scheduled dialog, *don’t send* makes it *needs you*.
//
// WHAT ARRIVES WITH THE SIBLINGS, ASSERTED NOT SKIPPED. The *run <app>* step kind in the editor
// (W3: `STEPS.run(appName)` as an enabled option, `STEPS.runInput` as the input field) and the
// hidden-frame handshake (W1: `ScheduledRunHost`, the host-side kv, the refusing gate) ship in
// PR-B; until they do this spec fails honestly at the step kind, never skips. The only skip is
// the integration gate every app-dependent spec shares (`SNUG_E2E_HAS_APP`). The strings come
// from `schedule/copy*.ts` themselves (pinned in `scheduleCopy.test.ts`), never retyped.
//
// THE CLOCK (the host kit's schedule.spec pattern): `page.clock.install` BEFORE `goto`, from one
// fixed Friday-morning instant; `fastForward` fires due timers and raises no DOM event, so the
// reconcile on wake is exercised by dispatching `visibilitychange` ourselves; every route change
// after the first `goto` is a click or a link, never a reload (a reload re-runs the init script
// and OPFS in an ephemeral context does not survive it — lessons 2026-08-03).
//
// THE STUB. `stub.snug.test` → 127.0.0.1 and the self-signed-cert allowance are scoped to THIS
// file (`test.use` below, the `net` / `connection-wizard` projects' exact arguments) because the
// GET at the heart of test 1 must reach the real stub through the real executor; the playwright
// config's `chromium` project collects this spec, so the allowance travels with the file rather
// than widening a shared project.

import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { CONSENT, MISSED_ACTIONS, RESULT_STATUS_WORD, missedHeadline, missedRow, needsYou, stepLabel } from '../src/schedule/copy';
// The ADR-0077 sentences arrive with PR-1's copy; read through the namespace so a missing one is a
// red at its assertion, never a link error that takes the whole file down.
import * as scheduleCopy from '../src/schedule/copy';
import { RUN_HEADER_SCHEDULE, STEPS } from '../src/schedule/copy.editor';
import { scheduledRefusalVerb } from '../src/schedule/scheduledConfirmGate';
import { AWAITS_INTEGRATION, NET_STUB_PORT, playgroundDir } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

/** The stub, by the name the resolver rule maps (the SSRF guard refuses loopback literals). */
const API_HOST = 'stub.snug.test';
/** The key the stub requires (net-stub.mjs) — a canary: it must never show in the page. */
const STUB_KEY = 'e2e-secret-key-9999';

/** Friday 2026-10-09 08:00 Pacific — a weekday morning, so "in N hours" never crosses a DST edge. */
const BOOT_INSTANT = new Date('2026-10-09T15:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const APP_NAME = 'Schedule App';
const FIXTURE = path.join(playgroundDir(), 'e2e', 'fixtures', 'schedule-app.html');

test.use({
  timezoneId: 'America/Los_Angeles',
  ignoreHTTPSErrors: true, // the stub's self-signed cert — this file only
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${API_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  },
});

/**
 * The fixture as a `snug-app-bundle/1` document with its ONE declared connection: an api_key
 * requirement on the stub's host, the exact shape net.spec's harness feeds the executor. The
 * recipient (this test) approves it in the wizard and types the stub's key; the bundle itself
 * carries no credential (C1), and the strict parse would refuse one.
 */
function fixtureBundle(): string {
  return JSON.stringify({
    format: 'snug-app-bundle/1',
    lineage: '2b7f3b1e-4c6d-4f0e-9a1b-5c2d3e4f6a70',
    sharedAt: BOOT_INSTANT.toISOString(),
    app: {
      displayName: APP_NAME,
      description: 'Answers scheduled runs with one connected GET or POST against the e2e stub.',
      iconEmoji: '⏰',
      iconColor: '#3ba36f',
      usesDb: true,
    },
    html: fs.readFileSync(FIXTURE, 'utf8'),
    connections: [
      {
        slot: 'stub',
        kind: 'api_key',
        provider: { name: 'E2E Stub' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
        request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
        declaredApiHosts: [API_HOST],
      },
    ],
  });
}

/** A surface a sibling ships must be here — named, so a red says which one is missing. */
async function expectShipped(locator: Locator, what: string): Promise<void> {
  await expect(locator.first(), `${what} — asserted, never skipped`).toBeVisible({ timeout: 10_000 });
}

/** Boot under the faked clock, receive the fixture through Settings, install it; answers the installed app's id. */
async function installFixture(page: Page): Promise<string> {
  await page.clock.install({ time: BOOT_INSTANT });
  await page.goto('/');
  await expect(page.getByTestId('brain-chip')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('link', { name: 'settings' }).click();
  await page
    .locator('[data-testid="add-shared-app"] input[type="file"]')
    .setInputFiles({ name: 'schedule-app.snug', mimeType: 'application/json', buffer: Buffer.from(fixtureBundle()) });
  await expect(page).toHaveURL(/\/run\/shared--[0-9a-f]{64}/, { timeout: 20_000 });
  await page.getByTestId('shared-install').click();
  await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  const appId = new URL(page.url()).pathname.split('/').pop() as string;
  // The app boots in the C2 sandbox and announces; its visible open reads "ready".
  await expect(page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]').locator('#status')).toHaveText('ready', { timeout: 30_000 });
  return appId;
}

/** Approve the bundle's declared connection and type the stub's key — the real wizard, the real executor behind it. */
async function connectStub(page: Page): Promise<void> {
  await page.getByTestId('manage-connections').click();
  const wizard = page.locator('[data-testid="connection-wizard"]');
  await expect(wizard).toBeVisible();
  await expect(wizard.getByTestId('review-provenance')).toContainText('a shared app proposed this');
  await expect(wizard.getByTestId('review-hosts')).toContainText(API_HOST);
  await wizard.getByRole('button', { name: /approve this connection/i }).click();
  // No `registration` seat ⇒ straight to credentials.
  await wizard.getByLabel('API key').fill(STUB_KEY);
  await wizard.getByRole('button', { name: /save my credentials/i }).click();
  await expect(wizard).toContainText(/connected/i);
  await wizard.getByRole('button', { name: /^done$/i }).click();
  await expect(wizard).toBeHidden();
  expect(await page.content(), 'C1: the typed key is nowhere in the page').not.toContain(STUB_KEY);
}

/**
 * The create ladder for a *run <app>* schedule (ADR-0074 §4): the run header's schedule action
 * → the sheet's *more options* → the editor prefilled with this app → the step kind *run <app>*
 * with its input → every hour → *schedule it* → the ONE consent surface (an app run spends the
 * network, so it stands between the act and the record) → *schedule it* → the enabled row.
 */
async function createHourlyRun(page: Page, input: Record<string, unknown>, title: string): Promise<void> {
  await page.getByRole('button', { name: RUN_HEADER_SCHEDULE.label, exact: true }).click();
  await expect(page.getByTestId('schedule-sheet')).toBeVisible();
  await page.getByTestId('sheet-more-options').click();
  await expect(page).toHaveURL(/\/schedule\/new\?/);
  await expectShipped(page.getByTestId('schedule-editor-view'), 'the editor route');

  // The step kind — the editor lists the KIND first (`stepLabel('app-run')`, "run this app") and
  // takes the app in the next select; both are asserted, never skipped.
  const kind = page.getByTestId('step-0-kind');
  await expectShipped(kind, 'the step-kind select');
  const runOption = kind.locator('option[value="app-run"]');
  await expect(runOption, 'the run step kind ships with PR-B\'s Run [app]').toHaveCount(1);
  await expect(runOption, 'the run step is pickable, not the PR-A placeholder').toBeEnabled();
  await expect(runOption).toHaveText(stepLabel('app-run'));
  await kind.selectOption('app-run');
  const step = page.getByTestId('step-0');
  await expect(step).toHaveAttribute('data-kind', 'app-run');
  const appSelect = step.getByTestId('step-0-app');
  await expect(appSelect, 'the app select for a run step').toHaveCount(1);
  await appSelect.selectOption({ label: APP_NAME });
  await step.getByLabel(STEPS.runInput).fill(JSON.stringify(input));

  // Every hour, on the hour; the catch-up choice an app run defaults to (`ask`), made explicit.
  await page.getByTestId('spec-kind-every').click();
  await page.getByTestId('spec-every-n').fill('1');
  await page.getByTestId('spec-every-unit').selectOption('hours');
  await page.getByTestId('schedule-title').fill(title);
  await page.getByTestId('missed-ask').check();

  const save = page.getByTestId('schedule-save');
  await expect(save, `the editor's act reads "${CONSENT.enable}"`).toHaveText(CONSENT.enable);
  await expect(save).toBeEnabled();
  await save.click();
  // The consent surface shows WHAT WILL RUN — the app, its input, the host it may call — before the first enable (U8).
  const consent = page.getByTestId('enable-consent');
  await expect(consent, 'an app run spends the network, so consent stands between the act and the record').toBeVisible({ timeout: 10_000 });
  await expect(consent).toContainText(APP_NAME);
  await expect(consent.getByTestId('consent-hosts-0')).toContainText(API_HOST);
  await consent.getByTestId('consent-enable').click();
  await expect(page).toHaveURL(/\/schedule$/, { timeout: 10_000 });
  await expect(page.getByTestId('schedule-switch').first(), 'the new schedule is listed, enabled').toBeChecked({ timeout: 10_000 });
  await expect(page.getByTestId('schedule-row').first()).toContainText(title);
}

/** The Schedule page (the header item is visible at the desktop viewport). */
async function openSchedulePage(page: Page): Promise<void> {
  if (!/\/schedule$/.test(new URL(page.url()).pathname)) await page.getByTestId('schedule-nav').click();
  await expect(page).toHaveURL(/\/schedule$/);
}

test.describe('A8 — a scheduled Run [app] against the net stub', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('a GET run: the hour arrives, the hidden app fetches through the real executor, and the result reads done with the app’s scrubbed summary', async ({ page }) => {
    test.setTimeout(150_000);
    await installFixture(page);
    await connectStub(page);
    await createHourlyRun(page, { fetch: true }, 'fetch the stub');

    // 08:00 → 09:01: the ticker fires once, the 09:00 occurrence is due within grace, the queue runs it.
    await page.clock.fastForward(HOUR_MS + MINUTE_MS);
    await openSchedulePage(page);
    const row = page.getByTestId('schedule-result').first();
    await expect(row, 'a result row lands once the hidden frame answered').toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute('data-status', 'ok', { timeout: 60_000 });
    await expect(row).toContainText(RESULT_STATUS_WORD.ok);
    await expect(row).toContainText(APP_NAME);
    // The app's own summary of the GET: the stub echoed the injected key and the host SCRUBBED it.
    await expect(row).toContainText('GET 200 /data — the stub saw key ***');
    expect(await page.content(), 'C1: the key never reaches the page, the result or the summary').not.toContain(STUB_KEY);
    await expect(page.getByTestId('schedule-result')).toHaveCount(1);
  });

  test('a POST run: the scheduled gate refuses the write unattended — the run is needs you with its one act, run now and review', async ({ page }) => {
    test.setTimeout(150_000);
    await installFixture(page);
    await connectStub(page);
    await createHourlyRun(page, { post: true }, 'post the digest');

    await page.clock.fastForward(HOUR_MS + MINUTE_MS);
    await openSchedulePage(page);
    const row = page.getByTestId('schedule-result').first();
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute('data-status', 'needs-you', { timeout: 60_000 });
    await expect(row).toContainText(RESULT_STATUS_WORD['needs-you']);
    await expect(row).toContainText(APP_NAME);
    const act = row.getByTestId('result-needs-you-act');
    const oneAct = needsYou(APP_NAME, 'post').action;
    expect(oneAct, 'needsYou names its one act').toBeDefined();
    await expect(act, 'the one act on a needs-you result').toHaveText(oneAct as string);
    expect(await page.content()).not.toContain(STUB_KEY);
    // The act opens the app visibly, where the ordinary gate would ask.
    await act.click();
    await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}$/);
  });

  test('48 hourly misses while Snug was closed: the stale ones are skipped by the freshness window, the fresh one is offered — one pending row, "missed once"', async ({ page }) => {
    test.setTimeout(150_000);
    await installFixture(page);
    await connectStub(page); // the consent names the approved host; a declared-only row says "none"
    await createHourlyRun(page, { fetch: true }, 'hourly stub check');

    // The jump: no timer fires (`setSystemTime` keeps them armed where they were), so the 48
    // occurrences from 09:00 today to 08:00 the day after next all fall into the gap; the last
    // one is 30 minutes old — past the 15-minute grace, so it is MISSED, not late, and within
    // the hourly schedule's freshness window, so it is offered rather than skipped (§5).
    await page.clock.setSystemTime(new Date(BOOT_INSTANT.getTime() + 48 * HOUR_MS + 30 * MINUTE_MS));
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await openSchedulePage(page);
    const card = page.getByTestId('missed-card');
    await expect(card, 'the missed card reads the persisted pending row').toBeVisible({ timeout: 20_000 });
    await expect(card).toHaveAttribute('data-pending', '1');
    await expect(card.getByTestId('missed-headline')).toContainText(missedHeadline(1, 0));
    await card.getByTestId('missed-details').click();
    const rows = card.getByTestId('missed-row');
    await expect(rows, 'collapsed per schedule to ONE candidate').toHaveCount(1);
    // Q12's freshness window: an hourly schedule's window is one period, so the 47 older misses
    // are auto-skipped (history lines, never a card) and the ONE fresh miss is offered — "missed
    // once", not 48 — which is the rule that keeps a weekend away from producing stale cards.
    await expect(rows.first()).toContainText(missedRow('every hour', 1).split(' · ')[1] as string); // "missed once"
    await expect(card.getByTestId('missed-run-all')).toHaveText(MISSED_ACTIONS.runAll);
    await expect(card.getByTestId('missed-skip-all')).toHaveText(MISSED_ACTIONS.skipAll);
    // Nothing ran: a pending candidate lives on the missed card, never in the results feed
    // (the feed lists finished results only), so the feed stays empty until the user acts.
    const results = page.getByTestId('schedule-result');
    await expect(results).toHaveCount(0);
  });
});

// ADR-0077 — ONE INSTANCE PER APP. With the app open at due time, the run is DELEGATED to the
// visible frame: the hidden host never mounts a second copy beside it. "Never" is sampled, not
// proven: the hidden frame is polled every 100 ms from the clock jump until the open app has
// answered AND at least 3 s have passed (today's hidden mount appears within milliseconds of the
// due tick). The app stays on screen until it answered, so no handover is in play.
const HIDDEN_FRAME = '[data-testid="scheduled-run-host"] iframe';
const liveFrame = (page: Page) => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');

/** Back to the installed app by clicks (never a reload — see THE CLOCK above); answers when it is ready. */
async function openAppFromHub(page: Page, appId: string): Promise<void> {
  await page.getByRole('link', { name: 'your apps' }).click();
  await page.getByTestId('installed-tile').filter({ hasText: APP_NAME }).getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/run/${appId}$`), { timeout: 20_000 });
  await expect(liveFrame(page).locator('#status')).toHaveText('ready', { timeout: 30_000 });
}

/** Sample the hidden host until `done()` holds and `atLeastMs` passed; any hidden iframe is a red. */
async function expectNoHiddenCopy(page: Page, done: () => Promise<boolean>, atLeastMs = 3_000, capMs = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    expect(await page.locator(HIDDEN_FRAME).count(), 'one instance per app: no hidden copy beside the open one (ADR-0077)').toBe(0);
    const elapsed = Date.now() - started;
    if (elapsed >= atLeastMs && (await done())) return;
    expect(elapsed, 'the open app answered the delegated run').toBeLessThan(capMs);
    await page.waitForTimeout(100);
  }
}

test.describe('ADR-0077 — a due run with the app OPEN is delegated to it, never a second hidden copy', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('the app open at due time: no hidden frame ever mounts, the open app answers the run, and the result reads done', async ({ page }) => {
    test.setTimeout(150_000);
    const appId = await installFixture(page);
    await connectStub(page);
    await createHourlyRun(page, { fetch: true }, 'fetch while open');
    await openAppFromHub(page, appId);

    await page.clock.fastForward(HOUR_MS + MINUTE_MS);
    const answered = liveFrame(page).locator('#runs li');
    await expectNoHiddenCopy(page, async () => (await answered.count()) === 1);
    await expect(answered).toHaveAttribute('data-ok', 'true');
    await expect(answered).toContainText('GET 200 /data — the stub saw key ***');

    await openSchedulePage(page);
    const row = page.getByTestId('schedule-result').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
    await expect(row).toContainText(RESULT_STATUS_WORD.ok);
    await expect(row).toContainText('GET 200 /data — the stub saw key ***');
    expect(await page.content(), 'C1').not.toContain(STUB_KEY);
  });

  test('a POST in a delegated run opens the scheduled dialog (no remember box); “don’t send” → needs you, the declined sentence — and still no hidden copy', async ({ page }) => {
    test.setTimeout(150_000);
    const appId = await installFixture(page);
    await connectStub(page);
    await createHourlyRun(page, { post: true }, 'post while open');
    await openAppFromHub(page, appId);

    await page.clock.fastForward(HOUR_MS + MINUTE_MS);
    const dialog = page.getByRole('dialog', { name: 'confirm network request' });
    await expectNoHiddenCopy(page, () => dialog.isVisible());
    const ask = scheduleCopy.DELEGATED_CONFIRM;
    expect(ask, 'DELEGATED_CONFIRM ships with PR-1’s copy').toBeDefined();
    await expect(dialog).toContainText(ask.title);
    await expect(dialog).toContainText('post while open'); // the schedule is named in the body
    await expect(dialog).toContainText(`https://${API_HOST}:${NET_STUB_PORT}/data`); // the URL, verbatim (R-8)
    await expect(dialog.getByRole('checkbox'), 'a scheduled ask never remembers').toHaveCount(0);
    await dialog.getByRole('button', { name: ask.deny }).click();
    await expect(dialog).toBeHidden();

    const answered = liveFrame(page).locator('#runs li');
    await expectNoHiddenCopy(page, async () => (await answered.count()) === 1, 1_000);
    await expect(answered).toHaveAttribute('data-ok', 'false');

    await openSchedulePage(page);
    const row = page.getByTestId('schedule-result').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toHaveAttribute('data-status', 'needs-you', { timeout: 30_000 });
    await expect(row).toContainText(scheduleCopy.needsYouDeclined(APP_NAME, scheduledRefusalVerb({ host: API_HOST, method: 'POST' })).text);
    expect(await page.content(), 'C1').not.toContain(STUB_KEY);
  });
});
