// kit.spec.ts — the host kit on the REAL built page (TASK-20260905-host-kit P9): AC2 (one
// file at runtime, the storage disclosure, the named offline refusal, install-then-reload),
// AC3 (chess on the pinned demo brain; only jsDelivr /npm/ leaves; an imported local+BYOK
// file still runs on demo), AC4 (D15 + capability truth on the built page, the builder's
// positive pins), AC6 (honest flags read through frameLocator), AC7 (sandbox attribute +
// RUNNER_CSP byte-identical; connect-src enforced), AC8 (no sql-wasm request), AC10 (the
// screenshots). A green vitest run is not a rendered surface — this opens the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import {
  KIT_FILE_URL,
  KIT_URL,
  STARTER_LOAD_REFUSAL_PREFIX,
  buildProbeUserFile,
  installRoutePolicy,
  runnerCsp,
  startersIndex,
  watchConsole,
} from './helpers';

const frameElement = (page: Page): Locator => page.locator('[data-testid="frame-wrap"] iframe').first();
const appFrame = (page: Page): FrameLocator => page.frameLocator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]');
const INSTALLED_ROUTE = /#\/run\/(?!starter--)[0-9a-f-]{8,}/;
const noWasm = (all: string[]): string[] => all.filter((u) => /sql-wasm/i.test(u));

async function openStarter(page: Page, folder: string): Promise<void> {
  await page.getByRole('button', { name: `open ${folder.replace(/-/g, ' ')}` }).click();
  await expect(page).toHaveURL(new RegExp(`#/run/starter--${folder}`));
}

test.describe('the host kit served over http — the artifact shape', () => {
  test('AC2/AC3: boots to the hub on the demo brain; the shelf lists every starter from inline metadata; nothing leaves the page', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    const errors = watchConsole(page);
    await page.goto(KIT_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    const folders = Object.keys(startersIndex().starters);
    await expect(page.getByTestId('starter-tile')).toHaveCount(folders.length);
    // The three desktop-locked starters keep their badge (AC4).
    await expect(page.getByTestId('desktop-only-badge')).toHaveCount(3);
    expect(policy.blocked).toEqual([]);
    expect(policy.passed).toEqual([]);
    expect(policy.starters).toEqual([]);
    expect(noWasm(policy.all)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: 'test-results/kit-hub.png' });
  });

  test('AC4/AC5 on the built page: no brain/account/connections/sync/secrets controls; the builder stays; /download stays; the chip discloses only', async ({ page }) => {
    await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(`${KIT_URL}#/settings`);
    await expect(page.getByTestId('settings-section-your-file')).toBeVisible();
    for (const id of ['settings-section-brain', 'settings-section-account', 'settings-section-connections']) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
    await expect(page.locator('#origin-label')).toHaveCount(0);
    await expect(page.getByText('include secrets')).toHaveCount(0);
    await expect(page.locator('.settings-hero-sub')).toHaveText('your file, your apps — everything lives with you.');
    // AC2: the disclosure names the rung the probe found WORKING — OPFS over http.
    await expect(page.getByTestId('settings-section-your-file')).toContainText(
      'this copy of your file lives in this browser’s private storage for this page.',
    );

    // A5 — the builder stays, exactly as on web.
    await page.goto(`${KIT_URL}#/`);
    await expect(page.getByRole('link', { name: 'build' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'describe the app to build' })).toBeVisible();
    await page.goto(`${KIT_URL}#/build`);
    await expect(page.getByRole('textbox', { name: 'describe your app' })).toBeVisible();
    await page.goto(`${KIT_URL}#/download`);
    await expect(page.getByTestId('download-page')).toBeVisible();

    // The chip is disclosure only: the host demo copy, no settings door.
    await page.goto(`${KIT_URL}#/`);
    await page.getByTestId('brain-chip').click();
    await expect(page.getByTestId('brain-menu')).toContainText('no host brain wired yet');
    await expect(page.getByTestId('brain-menu-settings')).toHaveCount(0);
  });

  test('AC3/AC7/AC8: chess installed plays a move against the demo brain; only jsDelivr /npm/ leaves; no sql-wasm request; sandbox + CSP untouched', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    await page.goto(KIT_URL);
    await openStarter(page, 'chess');
    await page.getByTestId('starter-install').click();
    await expect(page).toHaveURL(INSTALLED_ROUTE, { timeout: 20_000 });

    const frame = frameElement(page);
    await expect(frame).toBeVisible({ timeout: 20_000 });
    // AC7: the literal sandbox and the byte-identical RUNNER_CSP meta ahead of any script.
    expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcdoc = (await frame.getAttribute('srcdoc')) ?? '';
    const RUNNER_CSP = await runnerCsp();
    const cspAt = srcdoc.indexOf(RUNNER_CSP);
    expect(cspAt).toBeGreaterThan(-1);
    expect(/<meta[^>]+http-equiv="Content-Security-Policy"/i.test(srcdoc.slice(0, cspAt))).toBe(true);
    expect(cspAt).toBeLessThan(srcdoc.indexOf('<script'));

    const app = appFrame(page);
    await expect(app.getByRole('grid', { name: 'chessboard' })).toBeVisible({ timeout: 30_000 });
    await app.getByRole('button', { name: /^e2 / }).click();
    await app.getByRole('button', { name: /^e4 / }).click();
    // The demo brain's reply is off-script by design → chess plays a legal move for it.
    await expect(app.getByText(/a legal move was played/)).toBeVisible({ timeout: 30_000 });
    await expect(app.getByRole('button', { name: /^e4 / })).not.toHaveAccessibleName(/empty$/);

    expect(policy.starters).toEqual(['chess.js']);
    expect(policy.blocked).toEqual([]);
    expect(policy.passed.length).toBeGreaterThan(0);
    expect(policy.passed.every((u) => u.startsWith('https://cdn.jsdelivr.net/npm/'))).toBe(true);
    expect(noWasm(policy.all)).toEqual([]);
    await page.screenshot({ path: 'test-results/kit-run.png' });
  });

  test('AC6/AC7/AC9: the probe app reads honest flags, its fetch is CSP-blocked, and an imported local+BYOK file still runs on the demo brain', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: true });
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(`${KIT_URL}#/settings`);
    const file = await buildProbeUserFile();
    await page
      .locator('label.file-btn', { hasText: 'import snug file' })
      .locator('input[type="file"]')
      .setInputFiles({ name: 'probe.snug', mimeType: 'application/octet-stream', buffer: file });

    await page.goto(`${KIT_URL}#/`);
    // The file says mode:local + a BYOK key; the platform brain seat outranks it (AC3).
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await page.getByTestId('installed-tile').filter({ hasText: 'caps probe' }).locator('a.tile-link').click();
    await expect(page).toHaveURL(INSTALLED_ROUTE);

    const app = appFrame(page);
    await expect(app.locator('#caps')).not.toBeEmpty({ timeout: 20_000 });
    const caps = JSON.parse((await app.locator('#caps').textContent()) ?? '{}') as Record<string, unknown>;
    expect(caps).toMatchObject({ streaming: true, db: true, auth: false, net: false });
    expect(typeof caps.openUrl).toBe('boolean');
    // AC7: the fetch never becomes a request — the frame's CSP refuses it first (S1's shape).
    await expect(app.locator('#fetch')).toHaveText(/^blocked:/, { timeout: 20_000 });
    await expect(app.locator('#csp')).toContainText('connect-src');
    // The pinned brain answered the probe turn.
    await expect(app.locator('#status')).toHaveText(/^(done|error)$/, { timeout: 30_000 });
    expect(policy.blocked).toEqual([]);
    expect(policy.passed).toEqual([]);
    expect(noWasm(policy.all)).toEqual([]);
  });

  test('AC2: installing a starter survives a hard reload (OPFS over http)', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-host-kit-profile-'));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await installRoutePolicy(page, { allowJsDelivr: true });
      await page.goto(KIT_URL);
      await openStarter(page, 'chess');
      await page.getByTestId('starter-install').click();
      await expect(page).toHaveURL(INSTALLED_ROUTE, { timeout: 20_000 });
      const appId = page.url().split('/').pop() ?? '';
      await expect(frameElement(page)).toBeVisible({ timeout: 20_000 });
      // The debounced write-back must land in OPFS before the navigation (fixed-name reads only).
      await page.waitForFunction(
        async (id) => {
          try {
            const root = await navigator.storage.getDirectory();
            const dir = await root.getDirectoryHandle('snug-userdb');
            for (const slot of ['user.sqlite.slot-a', 'user.sqlite.slot-b']) {
              try {
                const handle = await dir.getFileHandle(slot);
                const bytes = await (await handle.getFile()).arrayBuffer();
                if (new TextDecoder('latin1').decode(bytes).includes(id)) return true;
              } catch {
                /* slot absent */
              }
            }
            return false;
          } catch {
            return false;
          }
        },
        appId,
        { timeout: 20_000 },
      );
      // Chromium commits OPFS to its backing store lazily; give it a beat (the playground's
      // no-server spec learned this the hard way) before tearing the document down.
      await page.waitForTimeout(1500);
      await page.goto(`${KIT_URL}#/run/${appId}`);
      await expect(frameElement(page)).toBeVisible({ timeout: 20_000 });
    } finally {
      await context.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

test.describe('the host kit opened from file:// with every request aborted — the plain-file shape', () => {
  test('AC2: renders the hub, names the storage in use, and a starter click shows the named refusal — never a dead control', async ({ page }) => {
    const policy = await installRoutePolicy(page, { allowJsDelivr: false, allowStarters: false });
    const errors = watchConsole(page);
    await page.goto(KIT_FILE_URL);
    await expect(page.getByTestId('brain-chip')).toContainText('demo brain');
    await expect(page.getByTestId('starter-tile')).toHaveCount(Object.keys(startersIndex().starters).length);
    // file:// exposes OPFS and rejects it; the probe TRIED and moved on.
    await page.goto(`${KIT_FILE_URL}#/settings`);
    await expect(page.getByTestId('settings-section-your-file')).toContainText(
      /this copy of your file lives in (this browser’s IndexedDB for this page|memory only)/,
    );
    await page.goto(`${KIT_FILE_URL}#/`);
    await openStarter(page, 'chess');
    await expect(page.getByText(new RegExp(`^${STARTER_LOAD_REFUSAL_PREFIX}`))).toBeVisible({ timeout: 20_000 });
    expect(policy.blocked.length).toBeGreaterThanOrEqual(1);
    expect(policy.blocked.every((u) => /@snugprotocol\/starters@/.test(u))).toBe(true);
    expect(policy.passed).toEqual([]);
    expect(noWasm(policy.all)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
