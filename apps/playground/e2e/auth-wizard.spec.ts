// auth-wizard.spec.ts — AL-04 AC11: the Dynamic Auth loop through the REAL app
// shell. Three scenarios, all entered through the chat directive card (N5 — the
// second mount, deliverable 2 of 3):
//   1. api_key: directive → spec_confirm review → approve → key → a scrubbed
//      connected fetch against AL-03's self-signed https stub.
//   2. PKCE popup: oauth2_auth_code against the local fake IdP — popup, hosted
//      callback route, BroadcastChannel-by-flowId, token exchange, connected.
//   3. poisoned directive: registry-provenance claim + evil endpoints for Spotify —
//      the wizard shows REGISTRY values only (B2/AC13, the host-side ladder).
// Secret probes ride scenario 1 (the wizard never echoes the key; the app sees ***).
//
// Deterministic replies come from the demo brain's `?demoauth=<variant>` seam
// (src/agent/demoAuth.ts) — the ?webllm=1 URL-flag precedent.
import { expect, test, type Page } from '@playwright/test';

const hasApp = Boolean(process.env.SNUG_E2E_HAS_APP);
const AWAITS = 'playground app not present yet — spec awaits integration';
const SECRET = 'e2e-secret-key-9999';

test.use({ ignoreHTTPSErrors: true });

/** Drive the demoauth chat: send the idea, wait for the artifact + directive card. */
async function buildWithDirective(page: Page, variant: string): Promise<void> {
  await page.goto(`/build?demoauth=${variant}`);
  const composer = page.getByRole('textbox', { name: 'describe your app' });
  await composer.fill('build my weather probe');
  await composer.press('Enter');
  await expect(page.getByTestId('artifact-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('auth-directive-card')).toBeVisible({ timeout: 20_000 });
}

function sheet(page: Page): ReturnType<Page['locator']> {
  return page.locator('.sheet');
}

test('api_key wizard end-to-end: directive card → spec_confirm → approve → key → scrubbed connected fetch', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithDirective(page, 'apikey');

  await page.getByTestId('auth-directive-card').getByRole('button', { name: /connect/i }).click();
  const wizard = sheet(page);
  await expect(wizard).toBeVisible();

  // Unknown provider ⇒ HOST-computed inference provenance ⇒ the forced field-by-field
  // review (AC3), with the full derived host list disclosed before approval (AC7).
  await expect(wizard).toContainText(/proposed by a model/i);
  await expect(wizard.getByTestId('wizard-hosts')).toContainText('stub.snug.test');

  await wizard.getByRole('button', { name: /approve connection/i }).click();

  // Credentials only AFTER approval (B1). The default api_key field collects the key.
  const keyField = wizard.getByLabel('API Key');
  await expect(keyField).toBeVisible();
  await keyField.fill(SECRET);
  await wizard.getByRole('button', { name: /save credentials/i }).click();
  await expect(wizard).toContainText(/connected — this app can now use the network/i);
  await wizard.getByRole('button', { name: /^done$/i }).click();

  // The wizard never echoes the key back into the page (AC10).
  expect(await page.content()).not.toContain(SECRET);

  // Run the app: its net-request goes through the REAL executor — injected at the
  // stub, scrubbed on the way back (the AL-03 wall, now behind a wizard-made row).
  await page.getByRole('link', { name: /run it/i }).click();
  await expect(page).toHaveURL(/\/run\//);
  const frame = page.frameLocator('iframe[sandbox="allow-scripts"]');
  await expect(frame.locator('#net-status')).toHaveText('ok:200', { timeout: 30_000 });
  const body = await frame.locator('#net-out').textContent();
  expect(body).toContain('"sawApiKey":"***"'); // the stub SAW the key (injection worked)
  expect(body).not.toContain(SECRET); // …and the app never did (scrub, C1)
  expect(await page.content()).not.toContain(SECRET);
});

test('PKCE popup flow: approve → client id → popup → hosted callback → BroadcastChannel → connected', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithDirective(page, 'oauth');

  await page.getByTestId('auth-directive-card').getByRole('button', { name: /connect/i }).click();
  const wizard = sheet(page);
  await expect(wizard).toContainText(/proposed by a model/i);
  // The proposal's endpoints are reviewable text in spec_confirm.
  await expect(wizard.getByLabel('token url')).toHaveValue('http://127.0.0.1:43121/token');
  await wizard.getByRole('button', { name: /approve connection/i }).click();

  await wizard.getByLabel('Client ID').fill('e2e-client-id');
  const popupPromise = page.context().waitForEvent('page');
  await wizard.getByRole('button', { name: /connect account/i }).click();

  // The popup rides the fake IdP's 302 back to the hosted /oauth/callback route.
  const popup = await popupPromise;
  await popup.waitForURL(/\/oauth\/callback/, { timeout: 15_000 });

  // Delivery over the flowId-named channel → held-copy binding → token exchange.
  await expect(wizard).toContainText(/connected — this app can now use the network/i, { timeout: 15_000 });
  expect(await page.content()).not.toContain('e2e-access-token-abc'); // tokens never render
});

test('poisoned directive: a registry-provenance claim with evil endpoints reviews as REGISTRY values (B2/AC13)', async ({ page }) => {
  test.skip(!hasApp, AWAITS);
  await buildWithDirective(page, 'poison');

  await page.getByTestId('auth-directive-card').getByRole('button', { name: /connect/i }).click();
  const wizard = sheet(page);
  await expect(wizard).toBeVisible();

  // Registry hit ⇒ the light path (host-verified), NOT the model-proposal framing —
  // and the ladder re-run discarded every directive hint: pinned Spotify values win.
  await expect(wizard).not.toContainText(/proposed by a model/i);
  await expect(wizard.getByTestId('wizard-hosts')).toContainText('accounts.spotify.com');
  await expect(wizard.getByTestId('wizard-hosts')).toContainText('api.spotify.com');
  const wizardText = await wizard.textContent();
  expect(wizardText).not.toContain('evil.example');
});
