// local-brains.spec.ts — the brain switcher on the REAL built page, against the REAL local
// host process with FAKE brain drivers (TASK-20261003 R4 — B2, B3, B6, B8; ADR-0071).
//
// What the unit suites cannot reach: that the choice a user makes on the chip is the brain
// the PROCESS answers on (`x-snug-brain`), that a brain the process reports as not ready
// really cannot be picked with a pointer, that the demo brain answers when none is ready,
// that "check again" picks a fixed brain up with no reload — and S6, the design acceptance
// jsdom cannot give: 375 px with no sideways scroll and a real hit-test, the keyboard, a
// visible focus ring, reduced motion, a screenshot of every state in both themes.
//
// The brains are the test build's fakes (`SNUG_MCP_TEST_BRAINS`): this suite reaches no real
// CLI and spends nobody's subscription. A fake with a `reply` answers; one without refuses.
//
// Run via `pnpm --filter host test:e2e` (cwd = apps/host), after `pnpm --filter host-mcp
// build` and `pnpm --filter host build`.
import fs from 'node:fs';
import path from 'node:path';

import { chromium, expect, test, type Browser, type BrowserContextOptions, type Locator, type Page } from '@playwright/test';

import { CLAUDE_LEVELS, CLAUDE_REMEDY, IDP_HOST, STUB_HOST, startLocalHost, type FakeBrain, type LocalHarness } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

/** A JSON object, as a real model answers an app that declares a response schema; chess treats it as off-script and plays a legal move for it. */
const REPLY = JSON.stringify({ message: 'pinned reply' });

const CLAUDE: FakeBrain = {
  id: 'claude',
  name: 'Claude',
  via: 'your Claude Code CLI',
  state: 'ready',
  verified: true,
  streaming: true,
  efforts: CLAUDE_LEVELS,
  models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: CLAUDE_LEVELS }],
  reply: REPLY,
};
/** Ready, and UNVERIFIED — as the real Codex driver is until a logged-in walk is journaled (B6). */
const CODEX: FakeBrain = {
  id: 'codex',
  name: 'Codex',
  via: 'your Codex CLI',
  state: 'ready',
  verified: false,
  streaming: false,
  efforts: ['minimal', 'low', 'medium', 'high'],
  models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'high'] }],
  reply: REPLY,
};
const CODEX_REMEDY = 'Your Codex CLI is not logged in — run `codex login`, then check again.';
const CHOICE_KEY = 'snug-host:brain-choice';

interface Think {
  /** What the page asked for. */
  brain: unknown;
  prefs: unknown;
  model: unknown;
  hasEffort: boolean;
  /** What the process says answered. */
  answeredBy: string | undefined;
  status: number;
}

/** Every think the page sends to the runner's shim, with the brain the runner says answered. */
function watchThinks(page: Page): Think[] {
  const thinks: Think[] = [];
  page.on('response', (response) => {
    if (!response.url().endsWith('/v1/chat/completions')) return;
    const body = JSON.parse(response.request().postData() ?? '{}') as Record<string, unknown>;
    thinks.push({ brain: body.brain, prefs: body.prefs, model: body.model, hasEffort: 'effort' in body, answeredBy: response.headers()['x-snug-brain'], status: response.status() });
  });
  return thinks;
}

/** Open Chess as a starter and install it; returns the app frame. The starter script is served from the repo (jsDelivr is not reachable here). */
async function openChess(page: Page) {
  const chess = path.resolve(process.cwd(), 'starters-pkg/chess.js');
  await page.route('**/@snugprotocol/starters@*/chess.js', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'access-control-allow-origin': '*' }, body: fs.readFileSync(chess) }));
  await page.getByRole('button', { name: 'open chess' }).click();
  await page.getByTestId('starter-install').click();
  const app = page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
  await expect(app.getByRole('grid', { name: 'chessboard' })).toBeVisible({ timeout: 30_000 });
  return app;
}

/** One move by the user, which makes the app think. */
async function move(app: ReturnType<Page['frameLocator']>, from: string, to: string): Promise<void> {
  await app.getByRole('button', { name: new RegExp(`^${from} `) }).click();
  await app.getByRole('button', { name: new RegExp(`^${to} `) }).click();
}

async function withPage(
  brains: readonly FakeBrain[],
  fn: (page: Page, harness: LocalHarness, errors: string[]) => Promise<void>,
  context: BrowserContextOptions = {},
): Promise<void> {
  const harness = await startLocalHost({ brains });
  const browserContext = await browser.newContext(context);
  try {
    const page = await browserContext.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url);
    await fn(page, harness, errors);
    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
  } finally {
    await browserContext.close();
    await harness.stop();
  }
}

const chipOf = (page: Page): Locator => page.getByTestId('brain-chip');
const row = (page: Page, id: string): Locator => page.getByTestId(`brain-option-${id}`);
const storedChoice = (page: Page): Promise<unknown> => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as unknown, CHOICE_KEY);

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

/** The focus ring is the theme's: a 2px solid outline (tokens.css `:focus-visible`). */
async function expectFocusRing(ringed: Locator, what: string): Promise<void> {
  const ring = await ringed.evaluate((el) => {
    const style = getComputedStyle(el);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(ring.style, `${what} shows a focus ring`).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);
}

/**
 * The dock at REST. It slides and fades in over 170 ms (`brain-dock-in`: 4px, opacity 0 → 1),
 * so for its first frames a box read off it is a moving target (measured: y 74.2 → 77 over
 * 120 ms) and a screenshot shows the page through it. Its OWN animations only — the
 * spinner's turn inside it never finishes.
 */
async function dockAtRest(page: Page): Promise<void> {
  await page.getByTestId('brain-menu').evaluate((menu) => Promise.all(menu.getAnimations().map((animation) => animation.finished)));
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  const current = await page.evaluate(() => document.documentElement.dataset.theme);
  if (current !== theme) await page.getByRole('button', { name: `switch to ${theme} theme` }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

test('B3/B8 — two brains: auto answers on Claude; pinning Codex answers on CODEX, the chip says experimental, and the pin is kept for this machine', async () => {
  await withPage([CLAUDE, CODEX], async (page) => {
    const thinks = watchThinks(page);
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'host', { timeout: 20_000 });
    await expect(chip.locator('.brain-chip-label')).toHaveText('Claude · your CLI');
    await expect(chip).toHaveAttribute('data-experimental', 'false');

    // AUTO. The choice is auto; the answer is Claude — two marks, two rows.
    await chip.click();
    await expect(page.getByTestId('brain-dock-now')).toContainText('Claude · your CLI');
    await expect(page.getByTestId('brain-switch-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('brain-switch-auto')).toContainText('answers on Claude');
    await expect(row(page, 'claude')).toHaveAttribute('data-answering', 'true');
    await expect(row(page, 'claude')).toHaveAttribute('aria-pressed', 'false');
    // The unverified brain is listed, labelled, and is NOT what auto shows.
    await expect(row(page, 'codex')).toContainText('experimental — not yet verified on this machine');
    await expect(row(page, 'codex')).toContainText('its tools are switched off by flags and a tripwire');
    await expect(page.getByTestId('brain-switch-auto')).not.toContainText('Codex');
    await page.keyboard.press('Escape');

    const app = await openChess(page);
    await move(app, 'e2', 'e4');
    await expect(app.getByText(/a legal move was played/), 'the think must come BACK').toBeVisible({ timeout: 30_000 });
    await expect(app.getByRole('status').first()).toHaveText(/your move/);
    expect(thinks).toHaveLength(1);
    expect(thinks[0]).toMatchObject({ brain: 'auto', answeredBy: 'claude', status: 200 });

    // What ANSWERED is named — the fake reports `<id>-fake` as the model that ran.
    await chip.click();
    await expect(page.getByTestId('brain-menu-active')).toContainText('claude-fake');

    // PIN CODEX — by its own row, the only way an unverified brain is ever chosen.
    await row(page, 'codex').click();
    await expect(row(page, 'codex')).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, 'codex')).toHaveAttribute('data-answering', 'true');
    await expect(row(page, 'claude')).toHaveAttribute('data-answering', 'false');
    await expect(page.getByTestId('brain-switch-auto')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('brain-dock-now')).toContainText('Codex · your CLI');
    // The controls are Codex's now, in Codex's own words: four levels (and the default), its one model.
    await expect(page.locator('[data-testid="brain-menu-effort"] option')).toHaveText(['default', 'minimal', 'low', 'medium', 'high']);
    await expect(page.locator('[data-testid="brain-menu-model-select"] option')).toHaveText(['Codex’s default', 'GPT-5.5']);
    // Nothing Claude answered on is claimed for Codex.
    await expect(page.getByTestId('brain-menu-active')).not.toContainText('claude-fake');
    await page.getByTestId('brain-level-high').click();
    await expect(page.getByTestId('brain-menu-effort')).toHaveValue('high');
    await page.keyboard.press('Escape');

    // The chip says so, in words.
    await expect(chip).toHaveAttribute('data-experimental', 'true');
    await expect(chip.locator('.brain-chip-label')).toHaveText('Codex · your CLI');
    await expect(page.getByTestId('brain-chip-experimental')).toHaveText('experimental');
    await expect(page.getByTestId('brain-chip-effort')).toHaveText('thinking · high');
    await expect(chip).toHaveAttribute('aria-label', /experimental — not yet verified on this machine/);

    await move(app, 'd2', 'd4');
    await expect.poll(() => thinks.length, { timeout: 30_000 }).toBe(2);
    // THE POINT: the process answered on the brain the user picked — and says so itself.
    expect(thinks[1]).toMatchObject({ brain: 'codex', answeredBy: 'codex', status: 200, prefs: { codex: { effort: 'high' } } });
    // The top-level model/effort are Claude's single-brain form: for Codex, the placeholder and no level.
    expect(thinks[1]).toMatchObject({ model: 'claude', hasEffort: false });
    await expect(app.getByRole('status').first()).toHaveText(/your move/, { timeout: 30_000 });
    await chip.click();
    await expect(page.getByTestId('brain-menu-active')).toContainText('codex-fake');
    await page.keyboard.press('Escape');

    // Per machine, per brain, versioned — and never in the user file.
    expect(await storedChoice(page)).toEqual({ v: 2, choice: 'codex', prefs: { codex: { effort: 'high' } } });
    await page.reload();
    await expect(chipOf(page).locator('.brain-chip-label'), 'the pin survives a reload').toHaveText('Codex · your CLI', { timeout: 20_000 });
    await expect(chipOf(page)).toHaveAttribute('data-experimental', 'true');
  });
});

test('B3/B8 — a brain that is not ready is LISTED with its remedy and cannot be pinned — by pointer or by keyboard', async () => {
  await withPage([CLAUDE, { ...CODEX, state: 'logged-out', detail: CODEX_REMEDY }], async (page) => {
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'host', { timeout: 20_000 });
    await chip.click();

    const codex = row(page, 'codex');
    await expect(codex).toHaveAttribute('aria-disabled', 'true');
    await expect(codex).toHaveAttribute('data-mark', 'attention');
    await expect(codex.locator('.brain-row-state')).toHaveText('needs attention');
    const remedy = page.getByTestId('brain-remedy-codex');
    await expect(remedy).toBeVisible();
    await expect(remedy).toHaveText('Your Codex CLI is not logged in — run codex login, then check again.');
    await expect(remedy.locator('code')).toHaveText(['codex login']);

    // A REAL pointer click on it (force: Playwright itself refuses to click an aria-disabled control).
    await codex.click({ force: true });
    // …and the keyboard: it takes focus — the remedy is reachable — and Enter does nothing.
    await codex.focus();
    await expect(codex).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');

    await expect(page.getByTestId('brain-switch-auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(codex).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, 'claude')).toHaveAttribute('data-answering', 'true');
    expect(await storedChoice(page), 'no dead pin was stored').toBeNull();
  });
});

test('B3/D4 — every brain not ready: the DEMO brain answers, the chip says why, and the popover gives each brain’s remedy — never "nothing to configure"', async () => {
  const brains: FakeBrain[] = [
    { ...CLAUDE, state: 'logged-out', detail: CLAUDE_REMEDY['logged-out']! },
    { ...CODEX, state: 'absent', detail: 'No `codex` CLI found on this machine. Install Codex, then run `codex login`, and check again.' },
  ];
  await withPage(brains, async (page) => {
    const thinks = watchThinks(page);
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'demo', { timeout: 20_000 });
    await expect(page.getByTestId('brain-chip-why')).toHaveText('Claude · not logged in');

    await chip.click();
    await expect(page.getByTestId('brain-dock-now')).toContainText('the demo brain');
    await expect(page.getByTestId('brain-dock-standin')).toContainText('Claude · not logged in.');
    await expect(page.getByTestId('brain-remedy-claude')).toBeVisible();
    await expect(page.getByTestId('brain-remedy-claude').locator('code')).toHaveText(['claude', '/login']);
    await expect(page.getByTestId('brain-remedy-codex')).toBeVisible();
    await expect(row(page, 'codex')).toHaveAttribute('data-mark', 'absent');
    await expect(row(page, 'codex').locator('.brain-row-state')).toHaveText('not installed');
    for (const id of ['claude', 'codex']) await expect(row(page, id)).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('brain-menu')).not.toContainText(/nothing to configure|no host brain wired/);
    // No brain answers, so there is nothing to set a model or a level ON.
    await expect(page.getByTestId('brain-dock-controls')).toHaveCount(0);
    // The passport's "thinks" row reads the same fact.
    await page.keyboard.press('Escape');
    await page.getByTestId('host-passport').click();
    await expect(page.getByTestId('host-passport-row-thinks')).toHaveAttribute('data-can', 'false');
    await expect(page.getByTestId('host-passport-row-thinks')).toContainText('Claude · not logged in');
    await expect(page.getByTestId('host-passport-row-thinks').locator('code')).toHaveText(['claude', '/login']);
    await page.keyboard.press('Escape');

    const app = await openChess(page);
    await move(app, 'e2', 'e4');
    await expect(app.getByText(/a legal move was played/), 'the think must be answered — by the demo brain').toBeVisible({ timeout: 30_000 });
    expect(thinks, 'nothing is sent to a brain that is known not ready').toEqual([]);
  });
});

test('B8 — "check again": a brain the user fixed is picked up with NO reload', async () => {
  // The fake is logged out at the first look and ready from the next (`afterRecheck`) — a
  // user who ran `/login` in a terminal while this page stayed open.
  //
  // The runner looks at its brains at most once per floor (30 s) and OWES an ask made inside
  // it, so the fresh status may be most of that floor away: the bound below is the floor
  // plus a probe, not a guess.
  test.setTimeout(120_000);
  await withPage([{ ...CLAUDE, state: 'logged-out', detail: CLAUDE_REMEDY['logged-out']!, afterRecheck: { state: 'ready' } }], async (page) => {
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'demo', { timeout: 20_000 });
    // A value only THIS document holds: a reload would lose it.
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });
    const rechecks: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/brain/recheck')) rechecks.push(request.method());
    });

    await chip.click();
    const again = page.getByTestId('brain-recheck');
    await expect(again).toHaveText('check again');
    // "It did not move when pressed" must be said of the dock at rest, not of its slide in.
    await dockAtRest(page);
    const before = await again.boundingBox();
    await again.click();
    // Progress is shown, and the button does not move or resize while it is.
    await expect(again).toHaveText('checking…');
    await expect(again).toHaveAttribute('aria-busy', 'true');
    expect(await again.boundingBox()).toEqual(before);
    await expect.poll(() => rechecks, { message: 'the press asks the runner' }).toContain('POST');

    await expect(chip, 'the fixed brain is picked up').toHaveAttribute('data-brain', 'host', { timeout: 60_000 });
    await expect(chip.locator('.brain-chip-label')).toHaveText('Claude · your CLI');
    await expect(again).toHaveText('check again');
    await expect(row(page, 'claude')).toHaveAttribute('data-answering', 'true');
    await expect(page.getByTestId('brain-remedy-claude')).toHaveCount(0);
    await expect(page.getByTestId('brain-dock-standin')).toHaveCount(0);
    // The popover stayed open through it, and the page was never reloaded.
    await expect(page.getByTestId('brain-menu')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  });
});

test.describe('S6 — the dock at 375 px', () => {
  /** Three rows, one of each kind: answering, ready-but-experimental, not installed (with a remedy). */
  const THREE: FakeBrain[] = [
    CLAUDE,
    CODEX,
    { id: 'hermes', name: 'Hermes', via: 'your Hermes gateway', state: 'absent', detail: 'No Hermes gateway was found — start it with `hermes gateway`, then check again.', verified: true },
  ];
  const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, hasTouch: true };

  test('fits the screen with a gutter each side, nothing scrolls sideways, and a brain row is what a finger lands on', async () => {
    await withPage(THREE, async (page) => {
      const chip = chipOf(page);
      await expect(chip).toHaveAttribute('data-brain', 'host', { timeout: 20_000 });
      await expectNoHorizontalScroll(page, 'the hub at 375px');
      await expectTappable(chip, 'the brain chip');
      await chip.tap();

      const menu = page.getByTestId('brain-menu');
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x, 'left gutter').toBeGreaterThanOrEqual(8);
      expect(box!.x + box!.width, 'right gutter').toBeLessThanOrEqual(375 - 8);
      await expectNoHorizontalScroll(page, 'the hub with the dock open');
      // Nothing inside the popover is wider than it — a long remedy wraps, a command does not push.
      expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the dock’s own content fits').toBe(true);

      // Every row is a tap target of its own, at least 40px tall.
      for (const id of ['claude', 'codex', 'hermes']) {
        await expectTappable(row(page, id), `the ${id} row`);
        expect((await row(page, id).boundingBox())!.height, `the ${id} row is a tap target`).toBeGreaterThanOrEqual(40);
      }
      await expectTappable(page.getByTestId('brain-switch-auto'), 'auto');
      await expectTappable(page.getByTestId('brain-recheck'), 'check again');
      await expect(page.getByTestId('brain-remedy-hermes')).toBeVisible();

      // A real tap (coordinates + hit-testing) on a brain row pins it.
      await row(page, 'codex').tap();
      await expect(row(page, 'codex')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('brain-dock-now')).toContainText('Codex · your CLI');
      await expectNoHorizontalScroll(page, 'the dock on Codex');

      // The thinking level: every level is one tap, and the row fits.
      for (const level of ['default', 'minimal', 'low', 'medium', 'high']) await expectTappable(page.getByTestId(`brain-level-${level}`), `the "${level}" level`);
      await page.getByTestId('brain-level-medium').tap();
      await expect(page.getByTestId('brain-menu-effort')).toHaveValue('medium');
      await expect(page.getByTestId('brain-level-medium')).toHaveAttribute('data-selected', 'true');

      // Back on Claude there are six segments (the default and five) — the longest row there is.
      await page.getByTestId('brain-switch-auto').tap();
      await expect(page.locator('.brain-dock-segment')).toHaveCount(6);
      const segments = await page.locator('.brain-dock-segment').evaluateAll((els) => els.map((el) => ({ fits: el.scrollWidth <= el.clientWidth + 1, height: el.getBoundingClientRect().height })));
      expect(segments.every((segment) => segment.fits), 'no level’s word is clipped').toBe(true);
      await expectNoHorizontalScroll(page, 'the dock with six levels');
      expect(await menu.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }, PHONE);
  });

  test('the demo brain standing in: the compact chip still says "demo", and the popover gives the reason and the remedy', async () => {
    await withPage([{ ...CLAUDE, state: 'logged-out', detail: CLAUDE_REMEDY['logged-out']! }, CODEX], async (page) => {
      const chip = chipOf(page);
      await expect(chip).toHaveAttribute('data-brain', 'demo', { timeout: 20_000 });
      // The 375px header has no room for the reason; it is in the chip's name and the popover.
      await expect(chip.locator('.brain-chip-label-short')).toBeVisible();
      await expect(page.getByTestId('brain-chip-why')).toBeHidden();
      await expect(chip).toHaveAttribute('aria-label', 'what’s thinking: demo brain — Claude · not logged in');
      await expectNoHorizontalScroll(page, 'the hub, demo brain, 375px');
      await chip.tap();
      await expect(page.getByTestId('brain-dock-standin')).toBeVisible();
      await expect(page.getByTestId('brain-remedy-claude')).toBeVisible();
      await expectNoHorizontalScroll(page, 'the dock, demo brain, 375px');
      // The ready alternative is one tap away — the user's tap.
      await expectTappable(row(page, 'codex'), 'the ready alternative');
      await row(page, 'codex').tap();
      await expect(chip).toHaveAttribute('data-brain', 'host');
    }, PHONE);
  });
});

test('S6 — the keyboard: Tab order follows reading order, every stop shows a focus ring, Escape closes and returns focus', async () => {
  await withPage([CLAUDE, { ...CODEX, state: 'logged-out', detail: CODEX_REMEDY }], async (page) => {
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'host', { timeout: 20_000 });
    await chip.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('brain-menu')).toBeVisible();

    for (const id of ['brain-recheck', 'brain-switch-auto', 'brain-option-claude', 'brain-option-codex', 'brain-menu-model-select']) {
      await page.keyboard.press('Tab');
      await expect(page.getByTestId(id), `Tab reaches ${id}`).toBeFocused();
      await expectFocusRing(page.getByTestId(id), id);
    }
    // The thinking level: the real control takes focus, and the row of segments wears its ring.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('brain-menu-effort')).toBeFocused();
    await expectFocusRing(page.locator('.brain-dock-segments'), 'the thinking-level row');

    // A ready brain is pinned from the keyboard…
    await page.getByTestId('brain-option-claude').focus();
    await page.keyboard.press('Enter');
    await expect(row(page, 'claude')).toHaveAttribute('aria-pressed', 'true');
    // …and Escape closes the popover and hands focus back to the chip.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('brain-menu')).toHaveCount(0);
    await expect(chip).toBeFocused();
  });
});

test('S6 — reduced motion is honoured: the popover does not animate in, and "checking…" does not spin', async () => {
  await withPage([CLAUDE, CODEX], async (page) => {
    const chip = chipOf(page);
    await expect(chip).toHaveAttribute('data-brain', 'host', { timeout: 20_000 });
    await chip.click();
    expect(await page.getByTestId('brain-menu').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
    await page.getByTestId('brain-recheck').click();
    await expect(page.getByTestId('brain-recheck')).toHaveAttribute('aria-busy', 'true');
    expect(await page.locator('.brain-dock-spin').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  }, { reducedMotion: 'reduce' });
});

test.describe('S6 — screenshots: the dock in each state, both themes, 1280 and 375', () => {
  const STATES: Record<string, FakeBrain[]> = {
    answering: [CLAUDE, { ...CODEX, state: 'logged-out', detail: CODEX_REMEDY }],
    'standing-in': [{ ...CLAUDE, state: 'logged-out', detail: CLAUDE_REMEDY['logged-out']! }, CODEX],
  };
  for (const width of [1280, 375] as const) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${theme} at ${width}px`, async () => {
        for (const [name, brains] of Object.entries(STATES)) {
          await withPage(brains, async (page) => {
            await setTheme(page, theme);
            await expect(chipOf(page)).toHaveAttribute('data-brain', name === 'answering' ? 'host' : 'demo', { timeout: 20_000 });
            await page.screenshot({ path: `test-results/brain-dock-${name}-chip-${theme}-${width}.png` });
            await chipOf(page).click();
            await expect(page.getByTestId('brain-menu')).toBeVisible();
            await expectNoHorizontalScroll(page, `${name} ${theme} ${width}`);
            // A shot taken mid-fade shows the hub's headline through the dock, which reads as a design fault it is not.
            await dockAtRest(page);
            await page.screenshot({ path: `test-results/brain-dock-${name}-${theme}-${width}.png` });
            if (name === 'standing-in') {
              // …and the experimental brain, picked: the third state worth a look.
              await row(page, 'codex').click();
              await expect(page.getByTestId('brain-dock-controls')).toBeVisible();
              await page.screenshot({ path: `test-results/brain-dock-experimental-${theme}-${width}.png` });
            }
          }, { viewport: { width, height: width === 375 ? 812 : 900 } });
        }
      });
    }
  }
});
