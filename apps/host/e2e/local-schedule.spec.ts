// local-schedule.spec.ts — the scheduler on the RUNNER's page, through the real process
// (TASK-20261009-scheduling-framework H4; ADR-0074 §5, §7; ADR-0068).
//
// `schedule.spec.ts` proves the engine on the built page served by a static server. This is the
// same page served by the real local host process, where three things are only true here:
//
//   * the file a result is written into is the RUNNER's (`~/Snug/user.snug` under SNUG_HOME),
//     reached through `/userdb` with the page's bearer — so a result that fires on this page is
//     read back out of that file, in Node, with the real db package;
//   * the runner can STOP while a run is in flight. The page then says so (K7's refusal surface)
//     and takes no further edits — which means the `interrupted` outcome cannot be saved from
//     that page: writes are refused the moment the runner's `shutdown` arrives. The run was
//     CLAIMED (`running`, saved before anything executed — §5), so the next open of the same
//     file sweeps the stale claim at boot and the result reads `interrupted` (`stale claim`).
//     That is the leg: stop mid-run → the page says the runner stopped → the file, opened under a
//     fresh runner, shows the run as interrupted;
//   * a scheduled *Run [app]* runs the app's own code in the hidden frame (A1–A8) against an app
//     the agent handed in over the process's stdio. That leg is written against the AC's labels
//     and GUARDED BY ASSERTIONS, never a skip: until the hidden frame ships, the *run [app]* step
//     kind is a disabled option and the leg is red by name.
//
// THE CLOCK is installed before `goto` and ticks in real time once installed (debounced saves
// still happen); `fastForward` fires the due timer. THE HOLD: a long *Ask the AI* step is made
// long by holding the page's `/v1/chat/completions` request in Playwright's route — the think is
// in flight from the page's side, which is the only side the stop is about.
//
// Run via `pnpm --filter host test:e2e -- --project=local-host local-schedule` (cwd = apps/host),
// after `pnpm --filter host build` and `pnpm --filter host-mcp build`.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { createMemoryBackend, openUserDb } from '@snugprotocol/db';

import { CONSENT, EMPTY } from '../../playground/src/schedule/copy';
import { RUNNER_STOPPED_MESSAGE } from '../src/local/client';
import { IDP_HOST, STUB_HOST, startLocalHost, type LocalHarness, type LocalHostOptions } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

/** Friday 2026-10-09 08:00 Pacific — the instant `schedule.spec.ts` boots at, so "in 2 minutes" means the same here. */
const BOOT_INSTANT = new Date('2026-10-09T15:00:00.000Z');
const MINUTE_MS = 60_000;
const TIMEZONE = 'America/Los_Angeles';

/** The runner's own file under its home (`apps/host-mcp/src/runner.ts`), the name the page's backend asks `/userdb/` for. */
const USER_FILE = 'user.snug';

/**
 * A brain that ANSWERS, so a scheduled *Ask the AI* step is sent rather than refused by name
 * (the demo brain refuses a scheduled think — `appThink.ts`). The reply never matters here:
 * the think is held in the browser, or the runner is gone before it could land.
 */
const ANSWERING_BRAIN: LocalHostOptions = {
  brain: 'ready',
  brainModel: 'claude-sonnet-5-e2e-resolved',
  models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true }],
};

const LINEAGE = '7a1c2e3f-4b5d-4c6e-8f90-1a2b3c4d5e6f';

/**
 * The fixture app the agent hands in: it announces, and it answers a `schedule-run` host-event
 * with a `schedule-result` app-event (A3's handshake, by the AC's names — `{ taskId, runId }` in,
 * `{ runId, ok, summary }` back). Hand-rolled frames, CDN-free: the page is the thing under test.
 */
const DIGEST_SUMMARY = 'digest ran on schedule: 3 new items';
const digestHtml = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Digest</title></head>
<body><h1 id="state">idle</h1>
<script>
(function () {
  var V = 1;
  function set(text) { document.getElementById('state').textContent = text; }
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || d.v !== V) return;
    if (d.type === 'snug:host-ready') {
      parent.postMessage({ v: V, type: 'snug:app-announce', appId: 'digest', displayName: 'Digest',
        description: 'schedule fixture', iconEmoji: '\\ud83d\\udcf0', iconColor: '#e8853b' }, '*');
      set('ready');
      return;
    }
    if (d.type === 'snug:host-event' && d.event === 'schedule-run') {
      var data = d.data || {};
      parent.postMessage({ v: V, type: 'snug:app-event', event: 'schedule-result',
        data: { runId: data.runId, taskId: data.taskId, ok: true, summary: ${JSON.stringify(DIGEST_SUMMARY)} } }, '*');
      set('ran');
    }
  });
})();
</script></body></html>`;

const digestBundle = (): Record<string, unknown> => ({
  format: 'snug-app-bundle/1',
  lineage: LINEAGE,
  sharedAt: '2026-10-09T00:00:00.000Z',
  app: { displayName: 'Digest', usesDb: true },
  html: digestHtml(),
  connections: [],
});

/** The statuses of every run row in a user file's bytes — read with the real db package, in Node. */
async function runStatuses(bytes: Buffer): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const backend = createMemoryBackend();
  backend.files.set(USER_FILE, new Uint8Array(bytes));
  const opened = await openUserDb({ backend, file: USER_FILE, locateWasm: () => require.resolve('sql.js/dist/sql-wasm.wasm'), persistDebounceMs: 1 });
  if (opened.status !== 'ok') throw new Error(`the runner's file did not open in Node: ${opened.status}`);
  try {
    return Object.values(opened.userDb.listAllScheduleRuns()).flatMap((runs) => runs.map((run) => run.status));
  } finally {
    await opened.userDb.close();
  }
}

const fileOf = (harness: LocalHarness): string => path.join(harness.home, USER_FILE);

/** A same-document route change: the hash router follows, the clock's init script does not re-run. */
async function go(page: Page, hash: `#/${string}`): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** A surface this task ships must be visible here — named, so a red says which one is missing. */
async function expectUi(locator: Locator, what: string): Promise<void> {
  await expect(locator.first(), `${what} ships in this task and must be in the build under test`).toBeVisible({ timeout: 10_000 });
}

const createBar = (page: Page): Locator => page.getByPlaceholder(EMPTY.createPlaceholder);
const results = (page: Page, status: string): Locator => page.locator(`[data-testid="schedule-result"][data-status="${status}"]`);

/** A page on the runner, under the faked clock, landed on the hub. */
async function openRunnerPage(harness: LocalHarness, errors: string[]): Promise<Page> {
  const page = await browser.newPage({ timezoneId: TIMEZONE });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  await page.clock.install({ time: BOOT_INSTANT });
  await page.goto(harness.url);
  await expect(page.getByText('nothing here yet'), 'the hub, with its first library read settled').toBeVisible({ timeout: 20_000 });
  return page;
}

/** The create bar → the editor, prefilled from the sentence; the caller fills the steps. */
async function openEditorFromSentence(page: Page, sentence: string): Promise<void> {
  await go(page, '#/schedule');
  await expectUi(createBar(page), 'the Schedule page’s create bar');
  await expect(page.getByText(/^runs while this page is open/), 'the honesty line names the runner’s page as its subject').toBeVisible();
  const bar = createBar(page);
  await bar.fill(sentence);
  await bar.press('Enter');
  await expect(page.getByTestId('schedule-editor-view'), 'the create bar hands off to the editor route').toBeVisible({ timeout: 10_000 });
}

/**
 * The end of the create ladder (U2/U3): *schedule it* → the consent surface where something
 * is spent (an *Ask the AI* or *Run [app]* step) → *schedule it* → the listed row, enabled.
 */
async function saveAndEnable(page: Page): Promise<void> {
  const save = page.getByTestId('schedule-save');
  await expect(save, `the editor's act reads "${CONSENT.enable}"`).toHaveText(CONSENT.enable);
  await expect(save).toBeEnabled();
  await save.click();
  const consent = page.getByTestId('consent-enable');
  await expect(consent.or(page.getByTestId('schedule-page')).first(), 'the consent surface, or the page with the new row').toBeVisible({ timeout: 10_000 });
  if ((await consent.count()) > 0) await consent.click();
  await expect(page).toHaveURL(/#\/schedule$/, { timeout: 10_000 });
  await expect(page.getByTestId('schedule-switch').first(), 'the new schedule is listed, enabled').toBeChecked({ timeout: 10_000 });
}

test.describe('H4 — the scheduler on the runner’s page, through the real process', () => {
  test('a due *Remind me* fires on the runner’s page: the result is counted, and it is READ BACK out of the runner’s file in Node', async () => {
    const harness = await startLocalHost();
    try {
      const errors: string[] = [];
      const page = await openRunnerPage(harness, errors);
      await openEditorFromSentence(page, 'remind me in 2 minutes');
      await page.getByTestId('step-0-title').fill('stretch');
      await page.getByTestId('step-0-body').fill('stand up and stretch');
      await saveAndEnable(page);
      await expect(page.getByTestId('schedule-result')).toHaveCount(0);

      // Three minutes on: the timer fires once (late, inside the grace), the queue runs the
      // notify step, the inbox result lands — no notify seat on this binding, so the result IS
      // the alert.
      await page.clock.fastForward(3 * MINUTE_MS);
      await expect(results(page, 'ok'), 'the result row').toHaveCount(1, { timeout: 15_000 });
      await expect(results(page, 'ok')).toHaveAttribute('data-unread', 'true');
      await expect(results(page, 'ok')).toContainText('stand up and stretch');

      // THE PROCESS LEG: the row is in the RUNNER's file, not only on the screen. The save is
      // debounced, so the file is polled; the read is the real db package over the real bytes.
      await expect
        .poll(async () => (fs.existsSync(fileOf(harness)) ? runStatuses(fs.readFileSync(fileOf(harness))) : []), {
          message: 'the ok run row must reach the runner’s file',
          timeout: 20_000,
        })
        .toContain('ok');
      expect(errors).toEqual([]);
      await page.close();
    } finally {
      await harness.stop();
    }
  });

  test('the runner STOPS while an *Ask the AI* step is in flight: the page says the runner stopped, and the file — opened under a fresh runner — reads the run as interrupted', async () => {
    const first = await startLocalHost(ANSWERING_BRAIN);
    let bytesAtStop: Buffer | undefined;
    try {
      const errors: string[] = [];
      const page = await openRunnerPage(first, errors);

      // THE HOLD: the think leaves the page and never comes back — a long step, from the
      // page's side, which is the only side a stop is about.
      let thinksHeld = 0;
      await page.route('**/v1/chat/completions', () => {
        thinksHeld += 1;
      });

      // The app the step asks about, handed in by the agent over the process's stdio.
      expect(await first.tool('snug_hand_in', { bundle: digestBundle() })).toEqual({ text: 'installed "Digest" in the open runner', isError: false });
      await expect(page.getByTestId('installed-tile')).toHaveCount(1);

      await openEditorFromSentence(page, 'in 2 minutes');
      await page.getByTestId('schedule-title').fill('digest check');
      const kind = page.getByTestId('step-0-kind');
      await expectUi(kind, 'the step kind control');
      await kind.selectOption('app-think');
      await page.getByTestId('step-0-app').selectOption({ label: 'Digest' });
      await page.getByTestId('step-0-prompt').fill('what changed since yesterday?');
      await saveAndEnable(page);

      // Due, claimed, sent — and held.
      await page.clock.fastForward(3 * MINUTE_MS);
      await expect(page.getByTestId('schedule-running-chip'), 'the running chip while the think is in flight').toBeVisible({ timeout: 15_000 });
      await expect.poll(() => thinksHeld, { message: 'the think must have left the page for the runner', timeout: 15_000 }).toBeGreaterThanOrEqual(1);

      // THE CLAIM REACHED THE FILE before anything executed (§5): `running`, saved by the runner.
      await expect
        .poll(async () => (fs.existsSync(fileOf(first)) ? runStatuses(fs.readFileSync(fileOf(first))) : []), {
          message: 'the running claim must reach the runner’s file before the stop',
          timeout: 20_000,
        })
        .toContain('running');
      bytesAtStop = fs.readFileSync(fileOf(first));
      expect(errors).toEqual([]);

      // THE STOP, the polite way (SIGTERM → the runner's `shutdown` event → the drain) — mid-run.
      await first.stop();

      // The page says so, in the words the client module pins, and takes no further edits.
      await expect(page.getByTestId('local-refusal-stopped')).toBeVisible({ timeout: 10_000 });
      const [stoppedHeadline] = RUNNER_STOPPED_MESSAGE.split(' — ');
      await expect(page.getByText(new RegExp(stoppedHeadline!, 'i')), `the page reads "${stoppedHeadline}"`).toBeVisible();
      await expect(page.getByText(/reopen Snug from your agent/i)).toBeVisible();
      await expect(page.locator('.shell')).toHaveCount(0);
      await expect(page.getByTestId('schedule-running-chip')).toHaveCount(0);
      await page.close();
    } finally {
      await first.stop();
    }

    // THE SAME FILE under a FRESH runner: the claim that page could not finish is stale, and the
    // boot sweep (`sweepStaleClaims`) records it interrupted. The clock is past the think bound
    // (5 min) so the claim is older than its bound; the one-off is behind the watermark, so
    // nothing re-plans it (an occurrence with a row in any status is deduped).
    expect(bytesAtStop, 'the file bytes read before the stop').toBeDefined();
    const second = await startLocalHost(ANSWERING_BRAIN);
    try {
      fs.writeFileSync(fileOf(second), bytesAtStop!);
      const errors: string[] = [];
      const page = await browser.newPage({ timezoneId: TIMEZONE });
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      await page.route('**/v1/chat/completions', () => undefined);
      await page.clock.install({ time: new Date(BOOT_INSTANT.getTime() + 15 * MINUTE_MS) });
      await page.goto(second.url);
      await expect(page.getByTestId('installed-tile'), 'the file carried over: the handed-in app is here').toHaveCount(1, { timeout: 20_000 });
      await go(page, '#/schedule');
      await expect(results(page, 'interrupted'), 'the stopped run reads interrupted').toHaveCount(1, { timeout: 15_000 });
      await expect(results(page, 'running')).toHaveCount(0);
      await expect(results(page, 'ok')).toHaveCount(0);
      await results(page, 'interrupted').locator('a').first().click();
      await expect(page.getByTestId('schedule-result-interrupted'), 'the result page names the interruption').toBeVisible({ timeout: 10_000 });
      expect(errors).toEqual([]);
      await page.close();
    } finally {
      await second.stop();
    }
  });

  test('a scheduled *Run [app]* through the real process: the handed-in app answers its schedule-run in the hidden frame and the result reads done', async () => {
    // THE HIDDEN FRAME (A1–A8) ships in this task: every surface it needs is asserted, never
    // skipped — a build without it is red by name here, not quietly green.
    const harness = await startLocalHost();
    try {
      const errors: string[] = [];
      const page = await openRunnerPage(harness, errors);
      expect(await harness.tool('snug_hand_in', { bundle: digestBundle() })).toEqual({ text: 'installed "Digest" in the open runner', isError: false });
      await expect(page.getByTestId('installed-tile')).toHaveCount(1);

      await openEditorFromSentence(page, 'in 2 minutes');
      await page.getByTestId('schedule-title').fill('morning digest');
      const kind = page.getByTestId('step-0-kind');
      await expectUi(kind, 'the step kind control');
      const runOption = kind.locator('option[value="app-run"]');
      await expect(runOption, 'the *run [app]* step kind (PR-B A1–A3) must be PICKABLE in the build under test — today it is the disabled "later release" option').toBeEnabled({ timeout: 2_000 });
      await kind.selectOption('app-run');
      await page.getByTestId('step-0-app').selectOption({ label: 'Digest' });
      await saveAndEnable(page);

      // Due → the hidden frame mounts the app, writes the kv handshake, raises `schedule-run`;
      // the fixture answers `schedule-result`; the run reads done with the app's summary.
      await page.clock.fastForward(3 * MINUTE_MS);
      await expect(results(page, 'ok'), 'the *Run [app]* result').toHaveCount(1, { timeout: 20_000 });
      await expect(results(page, 'ok')).toContainText(DIGEST_SUMMARY);
      await expect(results(page, 'no-handler'), 'never "not supported": the fixture answers the handshake').toHaveCount(0);
      await expect
        .poll(async () => (fs.existsSync(fileOf(harness)) ? runStatuses(fs.readFileSync(fileOf(harness))) : []), {
          message: 'the ok run row must reach the runner’s file',
          timeout: 20_000,
        })
        .toContain('ok');
      expect(errors).toEqual([]);
      await page.close();
    } finally {
      await harness.stop();
    }
  });
});
