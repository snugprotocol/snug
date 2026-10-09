// local-oauth.spec.ts — an OAuth popup COMPLETES on the local runner (TASK-20261003 K2,
// ADR-0072 §2; ADR-0068 D-B13/D-B14).
//
// The wizard's web path registers `${origin}/oauth/callback` as the redirect URI: a PATH.
// The provider sends the user's browser there, the process serves the kit page at that
// path — and under the kit's hash router that document rendered the HUB, so the code was
// never delivered and every sign-in parked on "waiting for the provider" for ever (found
// 2026-10-03). The boot's first branch is now that path: the callback page, alone.
//
// What this drives, exactly: a real popup, opened by the runner's page, to the fake IdP's
// authorize endpoint with a state SIGNED by `@snugprotocol/auth`'s own `signState` and a
// PKCE challenge; the IdP redirects to the runner's `/oauth/callback`; the opener — listening
// on the flow's BroadcastChannel as the wizard does — receives the delivery, and the state
// in it still verifies. The wizard's own state machine is not driven here (the runner pins
// a host brain, so the playground suite's scripted build is unreachable — `local.spec.ts`
// AC5 records why); what was broken was the document, and that is what is proven.
import { createServer, type Server } from 'node:net';

import { chromium, expect, test, type Browser } from '@playwright/test';
import { generatePkceVerifier, pkceChallenge, signState, verifyState } from '@snugprotocol/auth';

import { IDP_HOST, IDP_TLS_PORT, STUB_HOST, freePort, startFakeIdp, startLocalHost, type LocalHarness, type LocalHostOptions } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  // Its own browser: the IdP is self-signed, and that allowance must not leak into the
  // kit's own project (see local.spec.ts).
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

const withHost = async (fn: (harness: LocalHarness) => Promise<void>, options: LocalHostOptions = {}): Promise<void> => {
  const harness = await startLocalHost(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
};

const STATE_SECRET = 'e2e-flow-state-secret';

test('K2 — the popup lands on /oauth/callback, which renders the callback page ALONE, and the opener receives the delivery', async () => {
  const idp = await startFakeIdp();
  // The runner on ITS fixed port: the address a user registers with a provider.
  const fixed = await freePort();
  try {
    await withHost(
      async (harness) => {
        expect(harness.port, 'the runner bound the port it was told is its fixed one').toBe(fixed);
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(harness.url);
        await expect(page.getByTestId('brain-chip')).toBeVisible();
        const origin = `http://127.0.0.1:${harness.port}`;

        // Everything any OTHER document in this context asks for. Listened for on the
        // CONTEXT: a listener attached when the popup's page event fires has already missed
        // the popup's first requests.
        const popupRequests: string[] = [];
        context.on('request', (request) => {
          let from: unknown;
          try {
            from = request.frame().page();
          } catch {
            from = undefined; // a request with no frame (none are expected here)
          }
          if (from !== page) popupRequests.push(request.url());
        });

        // The flow, as the wizard starts one: a signed state naming the app and the flow,
        // and a PKCE pair.
        const flowId = 'flow-e2e-0001';
        const state = await signState({ appId: 'app-e2e', flowId, nonce: 'nonce-e2e', exp: Date.now() + 60_000 }, STATE_SECRET);
        const challenge = await pkceChallenge(generatePkceVerifier());

        // The opener listens on the flow's channel BEFORE the popup opens.
        await page.evaluate((id) => {
          (window as unknown as { __delivery: Promise<unknown> }).__delivery = new Promise((resolve) => {
            const channel = new BroadcastChannel(`snug-oauth-${id}`);
            channel.onmessage = (event) => {
              resolve(event.data);
              channel.close();
            };
          });
        }, flowId);

        const authorize =
          `https://${IDP_HOST}:${IDP_TLS_PORT}/authorize?response_type=code&client_id=e2e-client-id` +
          `&redirect_uri=${encodeURIComponent(`${origin}/oauth/callback`)}&state=${encodeURIComponent(state)}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`;
        const opening = context.waitForEvent('page');
        await page.evaluate((url) => void window.open(url, 'snug-oauth', 'popup,width=520,height=640'), authorize);
        const popup = await opening;

        // THE POINT: the delivery arrives. Under the hash router this promise never settled.
        const delivery = (await page.evaluate(() => (window as unknown as { __delivery: Promise<unknown> }).__delivery)) as { appId: string; flowId: string; code: string; state: string };
        expect(delivery).toEqual({ appId: 'app-e2e', flowId, code: 'fake-code-123', state });
        // …and the state that came back is the one that was signed: it verifies.
        expect(await verifyState(delivery.state, STATE_SECRET)).toMatchObject({ appId: 'app-e2e', flowId, nonce: 'nonce-e2e' });

        // The callback document did its one job and NOTHING else: it asked the runner for
        // the document, and never for /status, /events or the user's file. (It closes
        // itself, so this is read off its requests rather than off a page that may be gone.)
        await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
        const toRunner = popupRequests.filter((url) => url.startsWith(origin)).map((url) => new URL(url).pathname);
        expect(toRunner).toEqual(['/oauth/callback']);

        // The opener is untouched: still the hub, still talking to its runner.
        await expect(page.getByTestId('brain-chip')).toBeVisible();
        await context.close();
      },
      { certPaths: [idp.certPath], ports: [fixed, 0] },
    );
  } finally {
    await idp.stop();
  }
});

test('K2 — the callback document renders the callback page and no hub, even with a launch token on its address', async () => {
  // Opened directly (no popup, so it cannot close itself): what the document IS.
  await withHost(async (harness) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(new URL(request.url()).pathname));
    const state = await signState({ appId: 'app-e2e', flowId: 'flow-e2e-0002', nonce: 'n', exp: Date.now() + 60_000 }, STATE_SECRET);
    const token = new URL(harness.url).hash;
    await page.goto(`http://127.0.0.1:${harness.port}/oauth/callback?code=abc&state=${encodeURIComponent(state)}${token}`);
    await expect(page.getByText('sign-in complete — you can close this window.')).toBeVisible();
    await expect(page.locator('.shell')).toHaveCount(0);
    await expect(page.getByTestId('brain-chip')).toHaveCount(0);
    await expect(page.getByTestId('starter-tile')).toHaveCount(0);
    // No token claim (the fragment is still there, and nothing was stored), no data-plane request.
    expect(page.url()).toContain('#token=');
    expect(await page.evaluate(() => sessionStorage.getItem('snug-host-token'))).toBeNull();
    expect(requests).toEqual(['/oauth/callback']);

    // A link with no code says so, rather than rendering a hub that looks like success.
    await page.goto(`http://127.0.0.1:${harness.port}/oauth/callback`);
    await expect(page.getByText(/missing its code/)).toBeVisible();
    await context.close();
  });
});

/** A listener holding a port, so a runner told that port is its fixed one must fall back. */
const hold = (): Promise<{ port: number; server: Server }> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, server }));
  });

test('the sign-in offer follows the runner’s port: on its fixed port a provider’s redirect can come back; on a fallback it cannot, and the shelf says so', async () => {
  // capabilities.oauthRedirect is the runner's `/status` fact (ADR-0068 D-B13): the
  // registered redirect URI names the fixed port.
  const fixed = await freePort();
  await withHost(
    async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.getByTestId('host-passport').click();
      await expect(page.getByTestId('host-passport-row-sign-in')).toHaveAttribute('data-can', 'true');
      await expect(page.getByTestId('tile-blocked-reason').filter({ hasText: 'needs a provider sign-in' })).toHaveCount(0);
      await page.close();
    },
    { ports: [fixed, 0] },
  );

  const taken = await hold();
  try {
    await withHost(
      async (harness) => {
        expect(harness.port).not.toBe(taken.port);
        const page = await browser.newPage();
        await page.goto(harness.url);
        await page.getByTestId('host-passport').click();
        await expect(page.getByTestId('host-passport-row-sign-in')).toHaveAttribute('data-can', 'false');
        await expect(page.getByTestId('host-passport-row-sign-in')).toContainText('was already in use when Snug started');
        // Connections themselves are still offered — only the sign-in is not.
        await expect(page.getByTestId('host-passport-row-connections')).toHaveAttribute('data-can', 'true');
        await page.keyboard.press('Escape');
        // At least one starter signs the user in with its provider; each such tile says why it cannot run.
        const blocked = page.getByTestId('tile-blocked-reason').filter({ hasText: 'needs a provider sign-in' });
        expect(await blocked.count()).toBeGreaterThan(0);
        await page.close();
      },
      { ports: [taken.port, 0] },
    );
  } finally {
    await new Promise((resolve) => taken.server.close(resolve));
  }
});
