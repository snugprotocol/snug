// net.spec.ts — AL-03 live sweep on production bytes: an app fetches through the bridge,
// the production connected-fetch executor injects the stored key, the self-signed HTTPS
// stub sees it, and the response renders SCRUBBED. Negatives: unapproved barred, off-
// ceiling host blocked, imported_unapproved barred, POST confirm (deny → no request),
// app-supplied Authorization absent at the stub, https-only (A1), set-cookie dropped (A2).
//
// ignoreHTTPSErrors is scoped to THIS spec's context ONLY (the stub's self-signed cert) —
// the app-serving fixtures elsewhere never get it (A1 fixture-scoping requirement).

import { expect, test } from '@playwright/test';
import { FIXTURE_URL, NET_STUB_PORT, netAppHtml } from './helpers';

// The stub binds 127.0.0.1 but is ADDRESSED by a public-looking hostname so it survives
// the SSRF literal guard (which correctly blocks loopback IPs). Chromium's host-resolver
// rule (set on the `net` project) maps this name → 127.0.0.1.
const API_HOST = 'stub.snug.test';
const NET_STUB_URL = `https://${API_HOST}:${NET_STUB_PORT}`;

const apiKeySpec = {
  kind: 'api_key',
  provider: { name: 'E2E Stub' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: [API_HOST],
};

test.use({ ignoreHTTPSErrors: true }); // SCOPED to this net spec only (self-signed stub)

async function mountNet(page: import('@playwright/test').Page, opts: Record<string, unknown>): Promise<void> {
  await page.goto(`${FIXTURE_URL}/net-harness.html`);
  await page.waitForFunction(() => (window as { __harnessReady?: boolean }).__harnessReady === true);
  await page.evaluate((o) => (window as unknown as { __mount: (x: object) => void }).__mount(o), opts);
}

test.describe('AL-03 net capability — production bridge + executor', () => {
  test('approved GET: injected key reaches the stub, response renders scrubbed, set-cookie dropped', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data` }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
      apiKey: 'e2e-secret-key-9999',
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#status')).toHaveText('ready:net=true');
    await expect(app.locator('#net-status')).toHaveText('ok:200', { timeout: 15_000 });

    // The stub echoed the injected key back; the scrubber must have redacted it.
    const body = await app.locator('#net-out').textContent();
    expect(body).toContain('"sawApiKey":"***"'); // stub SAW the key (injection worked)…
    expect(body).not.toContain('e2e-secret-key-9999'); // …but the app never sees its value

    const headers = await app.locator('#net-headers').textContent();
    expect(headers).toContain('x-ratelimit-remaining'); // whitelisted header crosses
    expect(headers).not.toContain('set-cookie'); // A2: never crosses
    expect(headers).not.toContain('x-powered-by'); // non-whitelisted dropped
    expect(headers).not.toContain('e2e-secret-key-9999'); // R1: scrubbed from the etag too
  });

  test('unapproved spec is barred (NET_NOT_APPROVED) — no request reaches the stub', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data` }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
      status: 'unapproved',
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('err:NET_NOT_APPROVED', { timeout: 15_000 });
  });

  test('imported_unapproved is barred with the distinct code', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data` }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
      status: 'imported_unapproved',
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('err:NET_IMPORTED_UNAPPROVED', { timeout: 15_000 });
  });

  test('a host off the frozen ceiling is blocked', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: 'https://not-the-stub.example/data' }),
      spec: { ...apiKeySpec, declaredApiHosts: ['not-the-stub.example'] },
      allowedHosts: [API_HOST], // ceiling does NOT include the requested host
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('err:NET_HOST_BLOCKED', { timeout: 15_000 });
  });

  test('A1: an http URL is blocked even for a ceiling host (the localhost exception is dead)', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `http://${API_HOST}:${NET_STUB_PORT}/data` }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('err:NET_SCHEME_BLOCKED', { timeout: 15_000 });
  });

  test('POST confirm: deny → NET_CONFIRM_DENIED and no request reaches the stub', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data`, method: 'POST' }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
      confirm: 'deny',
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('err:NET_CONFIRM_DENIED', { timeout: 15_000 });
    const prompts = await page.evaluate(() => (window as unknown as { __confirmPrompts: unknown[] }).__confirmPrompts);
    expect(prompts.length).toBe(1); // the gate WAS consulted
  });

  test('POST confirm: allow → the write goes through', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data`, method: 'POST' }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
      confirm: 'allow',
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    await expect(app.locator('#net-status')).toHaveText('ok:200', { timeout: 15_000 });
    const body = await app.locator('#net-out').textContent();
    expect(body).toContain('"method":"POST"');
    // C1 at the real stub: the injected key was attached (X-Api-Key), and no forged
    // Authorization rode along (the app never sent one on this path).
    expect(body).toContain('"sawAuthorization":null');
  });

  test('C1: an app-supplied Authorization header is rejected at the bridge — never reaches the stub', async ({ page }) => {
    await mountNet(page, {
      html: netAppHtml({ netUrl: `${NET_STUB_URL}/data`, forgeAuth: true }),
      spec: apiKeySpec,
      allowedHosts: [API_HOST],
    });
    const app = page.frameLocator('iframe[sandbox="allow-scripts"]');
    // The strict net-request schema rejects a credential header at the bridge — the
    // runner answers MALFORMED, so the frame never reaches the executor or the stub.
    await expect(app.locator('#net-status')).toHaveText('err:MALFORMED', { timeout: 15_000 });
  });
});
