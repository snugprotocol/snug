// share.spec.ts — TASK-20260904-app-sharing, the attachment journey in a real browser
// (ADR-0063). One user plays both parts: install a starter (the app becomes OWNED),
// share it as a `.snug` file from the run header, delete the copy, then receive the
// file through Settings' "add shared app" — the shelf card appears, the preview opens
// read-only with "run with AI" off, install lands the app with its connection declared
// on the `shared` provenance, and the wizard's review copy names a third-party author.
//
// SPA-navigation only (an ephemeral context's OPFS does not survive hard reloads —
// lessons 2026-08-03). Keyless default (byok + demo brain): the Weather starter's
// sample mode renders without a key, and the LLM is never called.

import fs from 'node:fs';

import { expect, test, type Page } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

const BENIGN = [
  /\.map['"]? violates the following Content Security Policy/i,
  /Failed to load resource.*\.map/i,
  /Failed to load resource.*40[14]/i,
];
const isBenign = (text: string): boolean => BENIGN.some((pattern) => pattern.test(text));

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !isBenign(message.text())) errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test.describe('share an app as a .snug attachment, receive it, install it', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('the whole journey', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchConsole(page);

    // 1. Install the Weather starter so the app is OWNED (the share control is owned-only).
    await page.goto('/');
    await page.getByRole('button', { name: 'open Should I?' }).click();
    await expect(page).toHaveURL(/\/run\/starter--weather/);
    await page.getByTestId('starter-install').click();
    await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}/, { timeout: 20_000 });
    const ownedUrl = page.url();

    // 2. The share control sits between connections and the theme toggle; open the sheet.
    const share = page.getByRole('button', { name: 'share', exact: true });
    await expect(share).toBeVisible({ timeout: 20_000 });
    const headerButtons = page.locator('.run-header button');
    const names = await headerButtons.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? el.textContent ?? ''));
    const shareIndex = names.findIndex((n) => n === 'share');
    const themeIndex = names.findIndex((n) => /switch to (light|dark) theme/.test(n));
    expect(shareIndex).toBeGreaterThan(-1);
    expect(themeIndex).toBe(shareIndex + 1);
    await share.click();
    const sheet = page.getByTestId('share-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('share-travels')).toContainText('OpenWeather');
    await expect(sheet.getByTestId('share-travels')).toContainText('never your keys');
    await expect(sheet.getByTestId('share-stays')).toContainText('your credentials');
    // The starter's authoring docs travel by default; the scan found nothing to warn about.
    await expect(sheet.getByTestId('share-docs')).toContainText(/vision/i);
    await expect(sheet.getByTestId('share-warnings')).toHaveCount(0);

    // 3. Download the .snug — a JSON bundle, never SQLite bytes.
    const downloadPromise = page.waitForEvent('download');
    await sheet.getByTestId('share-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.snug$/);
    const bundlePath = await download.path();
    const bundleText = fs.readFileSync(bundlePath, 'utf8');
    expect(bundleText.startsWith('{')).toBe(true);
    const bundle = JSON.parse(bundleText) as {
      format: string;
      lineage: string;
      connections: { slot: string; provider: { name: string }; fields?: unknown }[];
      docs?: { slug: string }[];
    };
    expect(bundle.format).toBe('snug-app-bundle/1');
    expect(bundle.connections.map((c) => c.provider.name)).toEqual(['OpenWeather']);
    // A registry provider travels as the BARE borrower — no authored prompt seats.
    expect(bundle.connections[0]?.fields).toBeUndefined();
    expect(bundle.docs?.map((d) => d.slug)).toContain('vision');
    expect(bundleText).not.toMatch(/allowed_hosts|approved_at|"status"/);
    await sheet.getByRole('button', { name: 'close share sheet' }).click();

    // 4. Become the recipient: delete the owned copy so the lineage is free to install.
    await page.getByRole('link', { name: 'your apps' }).click();
    await page.getByTestId('app-delete').first().click();
    await page.getByTestId('app-delete-confirm').click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(0, { timeout: 20_000 });

    // 5. Receive through Settings → "add shared app" → the preview opens.
    await page.getByRole('link', { name: 'settings' }).click();
    await page
      .locator('[data-testid="add-shared-app"] input[type="file"]')
      .setInputFiles({ name: 'should-i.snug', mimeType: 'application/json', buffer: Buffer.from(bundleText) });
    await expect(page).toHaveURL(/\/run\/shared--[0-9a-f]{64}/, { timeout: 20_000 });
    await expect(page.getByTestId('shared-preview-disclosure')).toContainText('nothing is saved until you install');
    await expect(page.getByTestId('shared-preview-disclosure')).toContainText('OpenWeather');
    const runWithAi = page.getByTestId('shared-run-with-ai');
    await expect(runWithAi).toHaveAttribute('aria-pressed', 'false');
    // The frame boots inside the C2 sandbox, read-only.
    await expect(page.locator('[data-testid="frame-wrap"] iframe[sandbox="allow-scripts"]')).toBeVisible({ timeout: 20_000 });
    // No chat tab, no share control, no connections door on a preview.
    await expect(page.getByRole('button', { name: 'share', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('manage-connections')).toHaveCount(0);
    // The docs tab shows the bundle's docs and the contract as text.
    await expect(page.getByTestId('shared-docs')).toBeVisible();
    await expect(page.getByTestId('shared-contract')).toBeVisible();

    // 6. The shelf card sits between "your apps" and "starter apps".
    await page.getByRole('link', { name: 'your apps' }).click();
    const titles = await page.locator('.section-title').allTextContents();
    expect(titles).toEqual(['your apps', 'shared with you', 'starter apps']);
    await expect(page.getByTestId('shared-badge')).toHaveText('shared');
    await page.getByTestId('shared-open-card').click();
    await expect(page).toHaveURL(/\/run\/shared--[0-9a-f]{64}/);

    // 7. Install: the app lands, the shelf row is gone, the connection is declared on `shared`.
    await page.getByTestId('shared-install').click();
    await expect(page).toHaveURL(/\/run\/[0-9a-f-]{36}/, { timeout: 20_000 });
    expect(page.url()).not.toBe(ownedUrl); // a fresh id — install mints, never reuses
    const door = page.getByTestId('manage-connections');
    await expect(door).toBeVisible({ timeout: 20_000 });
    await door.click();
    await expect(page.getByTestId('review-provenance')).toContainText('a shared app proposed this');
    await expect(page.getByTestId('review-provenance')).not.toContainText('pinned by Snug');
    // The wizard is modal — close it (Escape) before navigating.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('review-provenance')).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole('link', { name: 'your apps' }).click();
    await expect(page.locator('[data-testid="installed-tile"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="shared-tile"]')).toHaveCount(0);

    expect(errors, `unexpected console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
