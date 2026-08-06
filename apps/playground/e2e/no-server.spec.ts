// no-server.spec.ts — umbrella AC2 (TASK-20260803-portable-hub): the hub client is
// static files and the hub backend is optional by construction. Two halves:
//
//   1. API-dead flow — every hub API route aborted: install a starter into the user
//      DB, run it in the sandbox. (Ephemeral context; Playwright interception and
//      vite dev coexist fine here.)
//   2. Reload persistence — a full hard reload restores the installed app from the
//      OPFS user DB. Runs in a PERSISTENT disk-backed profile: ephemeral-context OPFS
//      does not reliably survive cross-document navigations, and request interception
//      stalls vite module loading in persistent contexts — so this half records hub
//      API usage instead of aborting it, and asserts the flow needed none.
//
// Scope note (plan F3): the app runtime still loads React from the CDN allowlist, so
// this proves "no hub backend", not network-offline; the vendored-runtime variant is a
// queued next-step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { APP_URL, AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

test.describe('AC2 — serverless execution', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('install starter → run with every hub API route dead', async ({ page }) => {
    for (const route of ['/invoke*', '/artifacts*', '/artifacts/**', '/auth/**', '/userdb*']) {
      await page.route(route, (r) => r.abort('connectionrefused'));
    }
    await page.goto('/');
    // A starter now OPENS read-only first; Install lives in the run view, so owning a
    // copy is a deliberate two-step act (owner request, 2026-08-04).
    await page.getByRole('button', { name: /open chess/i }).click();
    await page.getByTestId('starter-install').click();
    await expect(page).toHaveURL(/\/run\//, { timeout: 20_000 });
    // The sandboxed frame renders the installed copy — no backend answered anything.
    await expect(page.getByTestId('frame-wrap').locator('iframe[sandbox="allow-scripts"]')).toBeVisible({
      timeout: 20_000,
    });
  });

  test('a hard reload restores the installed app from the OPFS user DB', async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snug-noserver-profile-'));
    const context = await chromium.launchPersistentContext(profileDir, { headless: true });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      // Record hub API usage — the flow must never DEPEND on a hub answer. (/auth and
      // /userdb are optional-feature probes that may 404; /invoke and /artifacts are
      // the load-bearing surfaces and must not be touched at all.)
      const loadBearingCalls: string[] = [];
      page.on('request', (request) => {
        const urlPath = new URL(request.url()).pathname;
        if (urlPath.startsWith('/invoke') || urlPath.startsWith('/artifacts')) loadBearingCalls.push(urlPath);
      });

      await page.goto(`${APP_URL}/`);
      // A starter now OPENS read-only first; Install lives in the run view, so owning a
    // copy is a deliberate two-step act (owner request, 2026-08-04).
    await page.getByRole('button', { name: /open chess/i }).click();
    await page.getByTestId('starter-install').click();
      // The INSTALLED copy's route, not the read-only starter view: /run/starter--chess
      // also matches a bare /\/run\// — under machine load the install navigation can
      // lag the click, and capturing the URL too early made the reload assertion look
      // for a link the hub never renders (starters are buttons). Same pattern as
      // owner-report.spec.ts. (Latent race surfaced 2026-08-06; OPFS persistence
      // itself was fine — the failure page showed the installed app present.)
      await expect(page).toHaveURL(/\/run\/(?!starter--)[0-9a-f-]{8,}/, { timeout: 20_000 });
      const runUrl = page.url();
      const appPath = new URL(runUrl).pathname;
      const appId = appPath.split('/').pop() ?? '';
      await expect(page.getByTestId('frame-wrap').locator('iframe[sandbox="allow-scripts"]')).toBeVisible({
        timeout: 20_000,
      });

      // Wait for the debounced write-back to actually land in OPFS before tearing the
      // page down (the driver's documented best-effort pagehide window) — direct
      // fixed-name reads only; directory iteration is unreliable during writes.
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
                /* slot absent — try the other */
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
      // The bytes above are renderer-visible; Chromium commits OPFS to its backing
      // store lazily, and a hard navigation immediately after the write can outrun
      // that commit (the same platform lag the debounce design documents). Give the
      // browser a beat before tearing the document down.
      await page.waitForTimeout(1500);

      // Full reload: the app must come back from the OPFS user DB, not from any server.
      // Assert the EXACT installed id under "your apps" — the starter card would also
      // match a loose text query.
      await page.goto(`${APP_URL}/`);
      await expect(page.locator(`a[href="${appPath}"]`)).toBeVisible({ timeout: 20_000 });

      // And the installed copy still runs at its own id.
      await page.goto(runUrl);
      await expect(page.getByTestId('frame-wrap').locator('iframe[sandbox="allow-scripts"]')).toBeVisible({
        timeout: 20_000,
      });

      expect(loadBearingCalls).toEqual([]);
    } finally {
      await context.close();
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});
