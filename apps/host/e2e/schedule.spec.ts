// schedule.spec.ts — the scheduler on the REAL built page (TASK-20261009-scheduling-framework
// H3; ADR-0074 §5, §7). The unit suites prove the engine against fake clocks and fake windows;
// this proves the built kit page boots WITH it in a real browser, under a faked clock:
//
//   * served over loopback http by the static server (the file-class binding, OPFS, a lock
//     manager that works): the page boots clean with the scheduler joined to its boot chain;
//     the Schedule page's empty state carries the honesty line for THIS binding; a *Remind me*
//     due in two minutes fires while the page is open once the clock is fast-forwarded past it;
//     the "2-day jump" (fast-forward + a dispatched `visibilitychange`, which `clock` does not
//     raise by itself) surfaces the missed card for a one-off that fell due in between;
//     screenshots at 1280 and 375 in both themes;
//   * opened from file:// (the plain-file shape): the page boots with no uncaught error and the
//     honesty line is present. MEASURED 2026-10-09 (Playwright 1.62's Chromium): at file:// the
//     lock manager GRANTS `navigator.locks.request` — the file scheme is not an opaque origin
//     for it, whatever feasibility F4 assumed; the refusing manager `leader.ts` falls back from
//     is the `about:srcdoc` artifact frame's. So this leg does not pin which answer the manager
//     gives: it RECORDS it (a test annotation) and accepts the line with or without the sibling
//     tail, so the leader state the line is derived from is whatever the election found here.
//
// THE CLOCK. `page.clock.install` runs BEFORE `goto` (Playwright installs it as an init script,
// so it must precede the page's first script), from one fixed instant so "in 47 hours" means
// the same thing on every run. `fastForward` fires due timers at most once and raises NO DOM
// event — the ticker's `visibilitychange` path is exercised by dispatching the event ourselves.
// After the first `goto`, every route change is a same-document hash write (`go`), never a
// reload: a reload would re-run the init script and put the clock back at the boot instant.
//
// THE GUARDS. The Schedule page, its create bar, the nav item and the missed card are the UI
// siblings' (apps/playground/src/schedule/*.tsx, views/ScheduleView.tsx). Every step that
// needs one of them is guarded by a NAMED `test.skip` — the build this spec met may predate
// them — never by a silent pass. The boot legs (no console errors, nothing leaves the page)
// run unconditionally. The strings come from `schedule/copy.ts` itself (pinned byte-for-byte
// in `scheduleCopy.test.ts`), so a copy change cannot turn an assertion into a skip unnoticed.
//
// Run via `pnpm --filter host test:e2e -- schedule` (cwd = apps/host), after `pnpm --filter host build`.
import { expect, test, type Locator, type Page } from '@playwright/test';

import { CONSENT, EMPTY, MISSED_ACTIONS, hostHonesty, missedHeadline } from '../../playground/src/schedule/copy';
import { KIT_FILE_URL, KIT_URL, installRoutePolicy, watchConsole } from './helpers';

/** Friday 2026-10-09 08:00 Pacific — a weekday morning, so "in N hours" never crosses a DST edge. */
const BOOT_INSTANT = new Date('2026-10-09T15:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Who owns the surfaces a skip names. */
const UI_OWNER = 'the UI siblings (apps/playground/src/schedule/*.tsx, views/ScheduleView.tsx)';

/** The honesty line this binding must show: `file` → "this page"; OPFS over http → durable; a working lock manager → no sibling tail. */
const HONESTY_HTTP = hostHonesty({ kind: 'host', hostLabel: 'this page', wakeMode: 'page', storageRung: 'durable', canSeeSiblingTabs: true });
/**
 * At file:// the rung may be IndexedDB or memory (kit.spec pins both) and the lock manager may
 * grant or refuse (see the header) — the subject "this page" is the fact under test; the two
 * tails are whichever the page found. Every other wording is a failure.
 */
const HONESTY_FILE = new RegExp(
  (['durable', 'memory'] as const)
    .flatMap((storageRung) => [true, false].map((canSeeSiblingTabs) => hostHonesty({ kind: 'host', hostLabel: 'this page', wakeMode: 'page', storageRung, canSeeSiblingTabs })))
    .map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|'),
);
/** The two tails the http leg must NOT show: OPFS is durable, and a working lock manager sees siblings. */
const MEMORY_TAIL = 'this page keeps nothing after it closes';
const SIBLING_TAIL = 'other tabs can’t be seen from here';

test.use({ timezoneId: 'America/Los_Angeles' });

/** A same-document route change: the hash router follows, the clock's init script does not re-run. */
async function go(page: Page, hash: `#/${string}`): Promise<void> {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
}

/** Whether a sibling-owned surface is in this build: one short settle (Playwright's clock, not the page's faked one), then a count. */
async function present(locator: Locator): Promise<boolean> {
  await locator
    .first()
    .waitFor({ state: 'visible', timeout: 3_000 })
    .catch(() => undefined);
  return (await locator.count()) > 0;
}

/** Skip — by name — when the surface a step needs is not in the build under test. */
async function requireUi(locator: Locator, what: string): Promise<void> {
  test.skip(!(await present(locator)), `${what} is not in this build — owned by ${UI_OWNER}`);
}

const createBar = (page: Page): Locator => page.getByPlaceholder(EMPTY.createPlaceholder);
const emptyState = (page: Page): Locator => page.getByText(EMPTY.page);
/** The header item (U1): accessible name "schedule, N unread". */
const scheduleNav = (page: Page, unread?: number): Locator =>
  page.getByRole('link', { name: unread === undefined ? /^schedule(, \d+ unread)?$/ : new RegExp(`^schedule, ${unread} unread$`) });
/** The missed card (U4): `role="status"`, headed by `missedHeadline`. */
const missedCard = (page: Page): Locator => page.getByRole('status').filter({ hasText: /was missed while Snug was closed|were missed while Snug was closed/ });

/**
 * The create ladder (U2/U3, ADR-0074 §4): the sentence in the create bar → the prefilled editor
 * (the WHEN and the schedule's title come from the sentence; the reminder's own words are the
 * user's — `STEPS.needTitle` holds the save until they are given) → *schedule it* → the ONE
 * consent surface where something is spent → *schedule it*. Nothing but the user's act enables
 * the task, so the ladder is walked to its end and the enabled switch on the listed row is the proof.
 */
async function createThroughTheUi(page: Page, sentence: string, reminder: { title: string; body: string }): Promise<void> {
  const bar = createBar(page);
  await bar.fill(sentence);
  await bar.press('Enter');
  await expect(page.getByTestId('schedule-editor-view'), 'the create bar hands off to the editor route').toBeVisible({ timeout: 10_000 });
  await page.getByTestId('step-0-title').fill(reminder.title);
  await page.getByTestId('step-0-body').fill(reminder.body);
  const save = page.getByTestId('schedule-save');
  await expect(save, `the editor's act reads "${CONSENT.enable}"`).toHaveText(CONSENT.enable);
  await expect(save).toBeEnabled();
  await save.click();
  // The consent surface — what will run — stands between the act and the record only where
  // something is spent (an *Ask the AI* step) or the task arrived disabled with an import
  // (`ScheduleEditor.submit`); a reminder commits straight away. Either landing is walked.
  const consent = page.getByTestId('consent-enable');
  await expect(consent.or(page.getByTestId('schedule-page')).first(), 'the consent surface, or the page with the new row').toBeVisible({ timeout: 10_000 });
  if ((await consent.count()) > 0) await consent.click();
  await expect(page).toHaveURL(/#\/schedule$/, { timeout: 10_000 });
  await expect(page.getByTestId('schedule-switch').first(), 'the new schedule is listed, enabled').toBeChecked({ timeout: 10_000 });
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current !== theme) await page.getByRole('button', { name: `switch to ${theme} theme` }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

/** Fails naming the elements that run past the viewport's right edge — the fix is theirs to find quickly. */
async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  const { overflow, offenders } = await page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    const limit = el.clientWidth;
    const past = [...document.querySelectorAll<HTMLElement>('body *')]
      .map((node) => ({ node, right: node.getBoundingClientRect().right }))
      .filter(({ right }) => right > limit + 1)
      .sort((a, b) => b.right - a.right)
      .slice(0, 6)
      .map(({ node, right }) => `${node.tagName.toLowerCase()}${node.dataset.testid ? `[data-testid=${node.dataset.testid}]` : ''}${node.className && typeof node.className === 'string' ? `.${node.className.trim().split(/\s+/).join('.')}` : ''} right=${Math.round(right)}`);
    return { overflow: el.scrollWidth - limit, offenders: past };
  });
  expect(overflow, `${what}: the page must never scroll horizontally — past the right edge: ${offenders.join(' | ') || '(nothing measured)'}`).toBeLessThanOrEqual(1);
}

test.describe('H3 — the scheduler on the built page served over loopback http (the file-class binding)', () => {
  test('boots with the scheduler joined to its boot chain, under a faked clock: the hub renders, nothing leaves the page, no console errors', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await expect(page.getByTestId('starter-tile').first()).toBeVisible();
    // The clock the page sees is the faked one — the one every "due" is derived from.
    expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(BOOT_INSTANT.getTime());
    expect(await page.evaluate(() => Date.now())).toBeLessThan(BOOT_INSTANT.getTime() + HOUR_MS);
    // A minute of page time passes with no timer blowing up — the ticker armed and fired once.
    await page.clock.fastForward(MINUTE_MS);
    await page.waitForTimeout(200);
    expect(policy.blocked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the Schedule page: its empty state and the honesty line for this binding — "runs while this page is open", no memory tail, no sibling tail', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await go(page, '#/schedule');
    await requireUi(emptyState(page), 'the Schedule page (#/schedule) with its empty state');
    await expect(emptyState(page)).toBeVisible();
    await expect(page.getByText(HONESTY_HTTP), 'the honesty line').toBeVisible();
    await expect(page.getByText('this artifact'), 'never the artifact wording on a plain page').toHaveCount(0);
    await expect(page.getByText(MEMORY_TAIL), 'OPFS over http is durable').toHaveCount(0);
    await expect(page.getByText(SIBLING_TAIL), 'the lock manager works at an http origin').toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a due *Remind me* fires while the page is open: created in the create bar, due in 2 minutes; after a 3-minute fast-forward the result is counted unread', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await go(page, '#/schedule');
    await requireUi(createBar(page), 'the Schedule page’s create bar');
    await requireUi(scheduleNav(page), 'the header’s schedule item ("schedule, N unread")');
    await expect(scheduleNav(page, 0).or(page.getByRole('link', { name: /^schedule$/ })), 'nothing unread before the run').toHaveCount(1);

    await createThroughTheUi(page, 'remind me in 2 minutes', { title: 'stretch', body: 'stand up and stretch' });
    await expect(page.getByTestId('schedule-result')).toHaveCount(0);

    // Three minutes on: the minute timer fires once (late), reconcile finds the occurrence
    // inside the 15-minute grace, the queue runs the notify step, and the inbox result lands —
    // no notify seat on this binding, so the result IS the alert.
    await page.clock.fastForward(3 * MINUTE_MS);
    await expect(scheduleNav(page, 1), 'one result nobody opened yet').toBeVisible({ timeout: 15_000 });
    const result = page.getByTestId('schedule-result');
    await expect(result).toHaveCount(1);
    await expect(result).toHaveAttribute('data-status', 'ok');
    await expect(result).toHaveAttribute('data-unread', 'true');
    await expect(result).toContainText('stand up and stretch');
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/schedule-result-dark-1280.png', fullPage: true });
  });

  test('the 2-day jump: a one-off due in 47 hours is missed; after the jump and a dispatched visibilitychange the missed card appears', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await go(page, '#/schedule');
    await requireUi(createBar(page), 'the Schedule page’s create bar');

    // Due one hour before the jump lands: past the grace (missed, not late) and inside any
    // freshness window (never `stale`), and a one-off is ALWAYS asked (plan.ts) — so the card.
    await createThroughTheUi(page, 'remind me in 47 hours', { title: 'water the plants', body: 'the plants are thirsty' });
    await expect(missedCard(page)).toHaveCount(0);

    await page.clock.fastForward(2 * DAY_MS);
    // `fastForward` fires the timers; the DOM event is ours to raise.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    // The card is read on the Schedule page (where it always mounts; the hub yields to the
    // protection offer — one banner at a time). The create bar proved the UI is in this build,
    // so the card's absence here is a failure of the engine or the card, never a skip.
    const card = missedCard(page);
    await expect(card, 'the missed card (role="status")').toBeVisible({ timeout: 15_000 });
    await expect(card).toContainText(missedHeadline(1, 0));
    await expect(card).toHaveAttribute('aria-live', 'polite');
    await expect(card.getByRole('button', { name: MISSED_ACTIONS.runAll })).toBeVisible();
    await expect(card.getByRole('button', { name: MISSED_ACTIONS.skipAll })).toBeVisible();
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/schedule-missed-dark-1280.png', fullPage: true });
  });

  test.describe('screenshots: the Schedule page, both themes, 1280 and 375', () => {
    for (const width of [1280, 375] as const) {
      for (const theme of ['dark', 'light'] as const) {
        test(`${theme} at ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
          await page.clock.install({ time: BOOT_INSTANT });
          await installRoutePolicy(page, { allowJsDelivr: true });
          await page.goto(KIT_URL);
          await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
          await setTheme(page, theme);
          await go(page, '#/schedule');
          await requireUi(emptyState(page), 'the Schedule page (#/schedule)');
          await expect(page.getByText(HONESTY_HTTP)).toBeVisible();
          // The pictures first, the gate second: a red gate still leaves the pictures to look at.
          await page.screenshot({ path: `test-results/schedule-empty-${theme}-${width}.png`, fullPage: true });
          await expectNoHorizontalScroll(page, `schedule ${theme} ${width}`);
          await go(page, '#/');
          await page.screenshot({ path: `test-results/schedule-hub-${theme}-${width}.png`, fullPage: true });
          await expectNoHorizontalScroll(page, `hub ${theme} ${width}`);
        });
      }
    }
  });
});

test.describe('H3 — opened from file:// with every request aborted (the plain-file shape): the election at a file origin', () => {
  test('boots with the scheduler whatever the lock manager answers: no uncaught error, nothing fetched, the hub renders — and the answer is recorded', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    const policy = await installRoutePolicy(page, { allowJsDelivr: false, allowStarters: false });
    const errors = watchConsole(page);
    await page.goto(KIT_FILE_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await expect(page.getByTestId('starter-tile').first()).toBeVisible();
    // What the lock manager answers at THIS origin — measured, not assumed (see the header):
    // Chromium grants here; a manager that rejects is the `about:srcdoc` case. Either is an
    // answer `leader.ts` lands on the store; the record is for whoever reads the run.
    const locks = await page.evaluate(async () => {
      try {
        const got = await navigator.locks.request('snug-e2e-probe', { ifAvailable: true }, async (lock) => (lock === null ? 'null' : 'granted'));
        return `resolved:${got}`;
      } catch (error) {
        return `rejected:${(error as { name?: string }).name ?? 'unknown'}`;
      }
    });
    expect(locks).toMatch(/^(resolved:(granted|null)|rejected:[A-Za-z]+)$/);
    test.info().annotations.push({ type: 'navigator.locks at file://', description: locks });
    // Past the election's probe bound (2 s of page time) and a minute of ticking: still clean.
    await page.clock.fastForward(MINUTE_MS);
    await page.waitForTimeout(200);
    expect(policy.passed).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the honesty line names this page as the subject, with the storage and sibling tails the election and the probe found here', async ({ page }) => {
    await page.clock.install({ time: BOOT_INSTANT });
    await installRoutePolicy(page, { allowJsDelivr: false, allowStarters: false });
    const errors = watchConsole(page);
    await page.goto(KIT_FILE_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await go(page, '#/schedule');
    await requireUi(emptyState(page), 'the Schedule page (#/schedule)');
    // The election resolves within its probe bound (2 s of page time); the line is derived from the leader state.
    await page.clock.fastForward(5_000);
    await expect(page.getByText(HONESTY_FILE), 'the whole line is one of the four this binding can truthfully say').toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('this artifact')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
