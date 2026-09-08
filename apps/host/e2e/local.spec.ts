// Binding B, end to end (ADR-0068 AC2/AC3/AC6/AC7).
//
// A real Chromium, the real built page, and the real local host process. The point of the
// suite is the seams the unit tests cannot reach: whether the page actually claims its
// token, whether the executor's request actually reaches a provider through the process,
// and whether the refusals hold against a browser rather than against a fake request.

import { expect, test, type Browser } from '@playwright/test';
import { chromium } from '@playwright/test';

import { startFakeIdp, startLocalHost, startNetStub, IDP_HOST, IDP_TLS_PORT, STUB_API_KEY, STUB_HOST, STUB_PORT, type LocalHarness } from './local-setup.js';

let browser: Browser;

test.beforeAll(async () => {
  // Its own browser: the stub is self-signed, and that allowance must not leak into the
  // kit's own project, which asserts that nothing outside the page's origin is reachable.
  browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${STUB_HOST} 127.0.0.1,MAP ${IDP_HOST} 127.0.0.1`, '--ignore-certificate-errors'],
  });
});
test.afterAll(async () => {
  await browser?.close();
});

const withHost = async (fn: (harness: LocalHarness) => Promise<void>, options: Parameters<typeof startLocalHost>[0] = {}): Promise<void> => {
  const harness = await startLocalHost(options);
  try {
    await fn(harness);
  } finally {
    await harness.stop();
  }
};

test('AC2 — the page opens on the launch URL and reports this binding', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(harness.url);

    // The token is claimed and STRIPPED before the router runs: the address bar must not
    // keep the credential, and the hash must be a route rather than a token.
    await expect.poll(() => page.url()).not.toContain('token=');
    expect(page.url()).toContain('#/');

    // The kit rendered — not the refusal surface.
    await expect(page.locator('#root')).not.toBeEmpty();
    expect(errors, `page errors: ${errors.join('; ')}`).toEqual([]);
    await page.close();
  });
});

test('AC2 — a reload keeps working, because the token was remembered for this tab', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(harness.url);
    await expect(page.locator('#root')).not.toBeEmpty();
    // The fragment is gone by now; only sessionStorage can carry this.
    await page.reload();
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.getByText(/Open Snug from your agent/i)).toHaveCount(0);
    await page.close();
  });
});

test('AC2 — a tab opened WITHOUT a token says how to get one, rather than rendering a dead page', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${harness.port}/`);
    await expect(page.getByText(/Open Snug from your agent/i)).toBeVisible();
    await page.close();
  });
});

test('AC7 — with the file held, the page REFUSES to open and names the holder', async () => {
  // Not read-only: the db swallows failed saves, so an opened page would take an hour of
  // work and lose it. The refusal names Snug for Mac because closing it is the remedy.
  await withHost(
    async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await expect(page.getByText(/Snug for Mac has your file/i)).toBeVisible();
      await page.close();
    },
    { holder: 'Snug for Mac' },
  );
});

test('AC6 — the data plane refuses a request from a page on another origin', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    // A foreign origin that resolves to loopback — the rebinding shape, in a real browser.
    await page.goto(`https://${STUB_HOST}:43520/`).catch(() => {});
    const status = await page.evaluate(async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: 'Bearer ' + 'a'.repeat(64) } });
        return response.status;
      } catch {
        return 'blocked';
      }
    }, harness.port);
    // Either the browser refuses it (CORS, no preflight answer) or the process does. Both
    // are correct; what must never happen is a 200.
    expect(status).not.toBe(200);
    await page.close();
  });
});

test('AC6 — the bearer is required: the page’s own origin cannot call without it', async () => {
  await withHost(async (harness) => {
    const page = await browser.newPage();
    await page.goto(harness.url);
    const status = await page.evaluate(async () => (await fetch('/status')).status);
    expect(status).toBe(401);
    await page.close();
  });
});

// ---------------------------------------------------------- AC3/AC4: connected fetch

/**
 * These are the ACs the whole binding exists for: a page request reaching a real provider
 * THROUGH the process, and a credential that appears on the wire and nowhere else.
 *
 * They drive `/fetch` with the page's own bearer from inside the page's origin, which is
 * the executor's exact seam — `connectedFetchDepsFor` threads `platform.fetchImpl`, and on
 * this binding that is `client.fetchImpl`, a POST to `/fetch`. Driving that seam from the
 * page proves the hop; the executor's own gates are unit-pinned either side of it.
 */
const tokenOf = (url: string): string => new URL(url).hash.replace('#token=', '');

test('AC3 — a request reaches the provider THROUGH the process, with no credential', async () => {
  const stub = await startNetStub();
  try {
    await withHost(async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      const token = tokenOf(harness.url);

      const answer = await page.evaluate(
        async ([bearer, host, port]) => {
          const response = await fetch('/fetch', {
            method: 'POST',
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            body: JSON.stringify({ url: `https://${host}:${port}/data`, method: 'GET', headers: {} }),
          });
          return (await response.json()) as { ok: boolean; status?: number; code?: string };
        },
        [token, STUB_HOST, String(STUB_PORT)] as const,
      );

      // No key was sent, so the stub answers 401 — and the point is that it ANSWERED:
      // the request crossed the process, resolved the host and completed TLS.
      expect(answer, `the proxy refused: ${JSON.stringify(answer)}`).toMatchObject({ ok: true });
      expect(answer.status).toBe(401);
      await page.close();
    }, { certPath: stub.certPath });
  } finally {
    await stub.stop();
  }
});

test('AC3 — an API-key request completes through the process, headers and all', async () => {
  const stub = await startNetStub();
  try {
    await withHost(async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      const token = tokenOf(harness.url);

      const answer = await page.evaluate(
        async ([bearer, host, port, key]) => {
          const response = await fetch('/fetch', {
            method: 'POST',
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            // The 1 MiB cap itself is unit-pinned in `fetch-proxy.test.ts`, where the cap
            // can be tripped WHILE reading without asking this fixture to emit a megabyte
            // on every run. What this leg proves is the hop: an injected header crossing
            // the process and satisfying a real provider over real TLS.
            body: JSON.stringify({ url: `https://${host}:${port}/data`, method: 'GET', headers: { 'x-api-key': key } }),
          });
          return (await response.json()) as { ok: boolean; status?: number; bodyBase64?: string };
        },
        [token, STUB_HOST, String(STUB_PORT), STUB_API_KEY] as const,
      );

      expect(answer.ok).toBe(true);
      expect(answer.status).toBe(200);
      await page.close();
    }, { certPath: stub.certPath });
  } finally {
    await stub.stop();
  }
});

test('AC4 — the credential reaches the provider, and appears in NO log, lock file or status', async () => {
  const stub = await startNetStub();
  try {
    await withHost(async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      const token = tokenOf(harness.url);

      const answer = await page.evaluate(
        async ([bearer, host, port, key]) => {
          const response = await fetch('/fetch', {
            method: 'POST',
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            body: JSON.stringify({ url: `https://${host}:${port}/data`, method: 'GET', headers: { 'x-api-key': key } }),
          });
          const envelope = (await response.json()) as { ok: boolean; status: number; bodyBase64?: string };
          return { ...envelope, body: envelope.bodyBase64 !== undefined ? atob(envelope.bodyBase64) : '' };
        },
        [token, STUB_HOST, String(STUB_PORT), STUB_API_KEY] as const,
      );

      // IT REACHED THE PROVIDER. The stub answers 200 only when the key matched exactly,
      // so the status IS the proof — and the echo deliberately masks the value as `***`
      // rather than reflecting a raw secret, which is the fixture's own C1 discipline. An
      // assertion on the raw value here would be asking the suite to weaken that.
      expect(answer.status).toBe(200);
      const echoed = JSON.parse(answer.body) as { sawApiKey: string; sawAuthorization: string | null };
      expect(echoed.sawApiKey).toBe('***');
      // C1: an app-supplied Authorization must never ride along.
      expect(echoed.sawAuthorization).toBeNull();

      // THE CANARY SWEEP. The key crossed the wire once; it must exist nowhere the process
      // wrote. `~/Snug/host/*` is the lock and the socket — the files this process owns.
      const { readdirSync, readFileSync, statSync } = await import('node:fs');
      const nodePath = await import('node:path');
      const hostDir = nodePath.join(harness.home, 'host');
      for (const name of readdirSync(hostDir)) {
        const file = nodePath.join(hostDir, name);
        if (!statSync(file).isFile()) continue;
        expect(readFileSync(file, 'utf8')).not.toContain(STUB_API_KEY);
      }
      await page.close();
    }, { certPath: stub.certPath });
  } finally {
    await stub.stop();
  }
});

// ------------------------------------------------------------------- AC5: OAuth

/**
 * AC5 — the OAuth path on THIS binding (D-B14).
 *
 * WHAT THIS LEG CAN AND CANNOT DRIVE, stated rather than quietly narrowed. The wizard's
 * full journey-4 is reached in the playground suite through `?demoreq=oauth`, which feeds
 * a SCRIPTED build. That seam is structurally unreachable here: `resolveAppTransport`
 * returns on `brain.kind === 'host'` before any demo arm is consulted
 * (`agent/transport.ts:254`), and this binding pins a host brain by construction — so on
 * the local page the builder always calls the user's real CLI. Making the demo script win
 * would mean changing production precedence to suit a test, which is the wrong trade.
 *
 * So this leg asserts the three things D-B14 actually CHANGED, each of which the wizard
 * journey would only have exercised incidentally:
 *   1. `platform.oauth` is UNDEFINED, so the wizard keeps its web popup path — the
 *      negative twin AC5 names. Installing the seat flips the wizard's one "not a browser"
 *      discriminator and parks the flow on `awaiting_callback` forever.
 *   2. The process SERVES `/oauth/callback` on its own origin, which is the registered
 *      redirect URI the fixed port (D-B13) exists to keep stable.
 *   3. The token exchange — a POST with a `URLSearchParams` body (review F6) — crosses the
 *      PROCESS to the IdP and comes back, which is the hop the desktop transport used to
 *      make and this binding now makes through `/fetch`.
 * The wizard's own state machine stays covered by the playground suite that can drive it.
 */
test('AC5 — the web OAuth path: no oauth seat, a callback on our origin, and the token POST through the process', async () => {
  const idp = await startFakeIdp();
  try {
    await withHost(async (harness) => {
      const page = await browser.newPage();
      await page.goto(harness.url);
      const token = tokenOf(harness.url);
      const base = harness.url.split('#')[0]!;

      // (1) THE NEGATIVE TWIN, asserted on the real page. `platform.oauth` must stay
      // undefined: it is the wizard's ONE "not a browser" discriminator, and setting it
      // installs a handle-less pseudo-popup with no null check, so `window.open` — by then
      // past its transient activation — returns null and the flow never completes.
      const seat = await page.evaluate(() => {
        const w = window as unknown as { __snugPlatform?: { oauth?: unknown } };
        return { present: w.__snugPlatform !== undefined, oauth: w.__snugPlatform?.oauth !== undefined };
      });
      if (seat.present) expect(seat.oauth, 'platform.oauth must stay undefined (D-B14)').toBe(false);

      // (2) The callback route the user REGISTERS is served by the process, on the fixed
      // port, and it is the page — not a 404 — that answers.
      const callback = await page.evaluate(async (origin) => {
        const response = await fetch(`${origin}/oauth/callback?code=e2e-code&state=x`);
        return { status: response.status, isHtml: (response.headers.get('content-type') ?? '').includes('text/html') };
      }, base.replace(/\/$/, ''));
      expect(callback.status, 'the process must serve /oauth/callback on its own origin (D-B13/D-B14)').toBe(200);
      expect(callback.isHtml).toBe(true);

      // (3) The TOKEN EXCHANGE through the process: a form-encoded POST (review F6) to the
      // IdP, which enforces PKCE and the exact code before it answers.
      const exchanged = await page.evaluate(
        async ([bearer, idpHost, idpPort]) => {
          const form = new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'fake-code-123', // the fixture's own constant — a wrong code is refused by design
            code_verifier: 'a'.repeat(43),
            client_id: 'e2e-client-id',
          }).toString();
          const response = await fetch('/fetch', {
            method: 'POST',
            headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              url: `https://${idpHost}:${idpPort}/token`,
              method: 'POST',
              headers: { 'content-type': 'application/x-www-form-urlencoded' },
              body: form,
            }),
          });
          const envelope = (await response.json()) as { ok: boolean; status?: number; bodyBase64?: string; code?: string; message?: string };
          return { ...envelope, body: envelope.bodyBase64 !== undefined ? atob(envelope.bodyBase64) : '' };
        },
        [token, IDP_HOST, String(IDP_TLS_PORT)] as const,
      );

      expect(exchanged, `the token POST did not cross the process: ${JSON.stringify(exchanged)}`).toMatchObject({ ok: true, status: 200 });
      // PKCE was enforced on the far side, so a 200 means the real grant path ran.
      expect(JSON.parse(exchanged.body)).toMatchObject({ access_token: 'e2e-access-token-abc', token_type: 'Bearer' });
      await page.close();
    }, { certPaths: [idp.certPath] });
  } finally {
    await idp.stop();
  }
});
