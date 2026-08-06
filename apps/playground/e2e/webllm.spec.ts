// webllm.spec.ts — AL-07 (TASK-20260806-webllm-spike) real-browser gates:
//
//   AC1  flag off  → ZERO webllm surface (no banner, no settings card, mode picker
//                    unchanged at exactly three choices).
//   AC3  flag on + WebGPU absent → the pinned fallback banner, and the demo brain
//                    still completes a build (fallback keeps the product alive).
//
// WebGPU absence is FORCED via an init script that hides `navigator.gpu` before any
// app code runs — the spec must not depend on what this machine's Chromium happens to
// support. The real-model spec at the bottom is skip-by-default: it downloads
// GB-scale weights and needs working WebGPU, which CI cannot afford.

import { expect, test } from '@playwright/test';
import { AWAITS_INTEGRATION } from './helpers';

const hasApp = process.env.SNUG_E2E_HAS_APP === '1';

/** Pinned copy — must match state/webllm.ts WEBLLM_FALLBACK_BANNER verbatim. */
const FALLBACK_BANNER = 'this browser can’t run local models — showing the demo brain';

test.describe('AL-07 AC1 — flag off means zero webllm surface', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test('no webllm element anywhere; the mode picker still offers exactly three choices', async ({ page }) => {
    await page.goto('/settings');
    const modeGroup = page.getByRole('group', { name: 'where the agent runs' });
    await expect(modeGroup).toBeVisible();
    await expect(modeGroup.getByRole('button')).toHaveCount(3);
    // The selector contract: every webllm surface carries a webllm- test id prefix.
    await expect(page.locator('[data-testid^="webllm-"]')).toHaveCount(0);

    await page.goto('/build');
    await expect(page.getByRole('textbox', { name: 'describe your app' })).toBeVisible();
    await expect(page.locator('[data-testid^="webllm-"]')).toHaveCount(0);
  });
});

test.describe('AL-07 AC3 — flag on without WebGPU falls back to the demo brain', () => {
  test.skip(!hasApp, AWAITS_INTEGRATION);

  test.beforeEach(async ({ page }) => {
    // Hide WebGPU before any app code runs, whatever this Chromium supports.
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
  });

  test('shows the pinned fallback banner and the settings card explains it', async ({ page }) => {
    await page.goto('/settings?webllm=1');
    await expect(page.getByTestId('webllm-fallback-banner')).toHaveText(FALLBACK_BANNER);
    await expect(page.getByTestId('webllm-experimental-card')).toContainText(FALLBACK_BANNER);
    // The mode picker is NOT extended by the experiment.
    await expect(page.getByRole('group', { name: 'where the agent runs' }).getByRole('button')).toHaveCount(3);
  });

  test('the demo brain still completes a build under the flag (fallback keeps building alive)', async ({ page }) => {
    await page.goto('/build?webllm=1');
    await expect(page.getByTestId('webllm-fallback-banner')).toHaveText(FALLBACK_BANNER);

    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('build me tic-tac-toe');
    await composer.press('Enter');

    // The demo chat script: KB-consult line streams, then the artifact card lands.
    await expect(page.getByText(/check the app template/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('AL-07 bonus — real in-browser generation (skip-by-default)', () => {
  // DELIBERATELY SKIPPED IN CI: first run downloads multi-GB weights from the web-llm
  // CDN into browser storage and needs real WebGPU (headed Chromium on Apple Silicon
  // works; CI runners generally do not). Flip SNUG_E2E_WEBLLM_REAL=1 to run locally.
  test.skip(process.env.SNUG_E2E_WEBLLM_REAL !== '1', 'real model load: GB download + WebGPU — run locally with SNUG_E2E_WEBLLM_REAL=1');

  test('a webllm builder turn produces a streamed reply from the real engine', async ({ page }) => {
    test.setTimeout(30 * 60_000); // cold download + shader compile can take many minutes
    await page.goto('/build?webllm=1');
    await expect(page.getByTestId('webllm-active-note')).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'describe your app' });
    await composer.fill('reply with the single word: ready');
    await composer.press('Enter');
    // Any non-empty agent bubble proves an end-to-end generation (ChatLog renders
    // agent messages as .msg-agent).
    await expect(page.locator('.msg-agent').first()).toContainText(/\S/, { timeout: 25 * 60_000 });
  });
});
