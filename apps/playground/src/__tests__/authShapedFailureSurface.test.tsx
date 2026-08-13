// authShapedFailureSurface.test.tsx — TASK-20260812-desktop-auth-awareness P3-host
// (AC5, ADR-0022 §4, P0 amendment 8): the playground half of the auth-shaped failure
// observer. The executor's deps-level seat is `(slot, status)`; THIS layer adds the
// appId it already holds (the host-assigned netAppId — never anything the app claimed)
// and lands the triple in a host-only store the RunView banner renders.
//
// WHAT IS PINNED HERE, and why at this altitude even though the executor's own suite
// already proves the firing rules: the wiring is the playground's — a handler that
// forgot to thread the seat, or threaded it into the wizard-probe deps too, would leave
// every auth-suite assertion green while the shipped surface stayed silent (the exact
// "silent 401" this task exists to kill) or grew a second banner channel the probe was
// designed not to have.
//
// C1 — no credential value, response body, or URL rides the observer or the store; the
// negative tests assert the store carries (appId, slot, status) and nothing else.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authConnectionCredentialSecretKey, authConnectionStateSecretKey } from '@snugprotocol/db';

import { installTestUserDb } from './userdbTestHelper.js';
import {
  authShapedFailureStore,
  createNetHandlerFor,
  dismissAuthShapedFailure,
  __resetNetStateForTests,
} from '../state/net.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardStore,
  connectionWizardSlotStore,
  openConnectionWizard,
  testConnection,
} from '../state/connectionWizard.js';
import { AuthRepairBanner } from '../run/AuthRepairBanner.js';
import { getUserDb } from '../state/userdb.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-auth-shaped';
const SLOT = 'example';

/** Fictional provider — no registry borrow, the row persists exactly as declared. */
const apiKeyRequirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
};

/** Keyless kind — the "no injected credential" negative. */
const noneRequirement = {
  slot: 'public',
  kind: 'none' as const,
  provider: { name: 'Public API' },
  declaredApiHosts: ['api.public.example'],
};

async function seedApprovedApp(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
  db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), 'stored-key-abc123');
  db.putDeclaredConnection(APP, SLOT, apiKeyRequirement, 'inference');
  db.approveConnection(APP, SLOT);
}

function frame(url: string, requestId = 'r1'): {
  v: 1;
  type: 'snug:net-request';
  requestId: string;
  instanceId: string;
  url: string;
  method: 'GET';
} {
  return { v: 1, type: 'snug:net-request', requestId, instanceId: 'ins-1', url, method: 'GET' };
}

beforeEach(async () => {
  __resetNetStateForTests();
  __resetConnectionWizardForTests();
  await installTestUserDb();
});
afterEach(() => {
  __resetNetStateForTests();
  __resetConnectionWizardForTests();
});

// ---------------------------------------------------------------------------
// The handler wiring: (slot, status) from the executor + the appId this layer holds
// ---------------------------------------------------------------------------

describe('createNetHandlerFor — the auth-shaped failure observer reaches the host store', () => {
  it('a credentialed 401 final result lands (appId, slot, 401) in the store — and the app result is UNCHANGED', async () => {
    await seedApprovedApp();
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    const result = await handler.handle(APP, frame('https://api.example.com/v1/data'));

    // The app contract is untouched: ok:true, status passed through as-is (ADR-0022 §4 —
    // apps legitimately read 401 bodies; the banner is ADDITIVE, never a remap).
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(authShapedFailureStore.get()).toEqual({ appId: APP, slot: SLOT, status: 401 });
  });

  it('a 403 lands too, with its own status', async () => {
    await seedApprovedApp();
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    });
    const result = await handler.handle(APP, frame('https://api.example.com/v1/data'));
    expect(result).toMatchObject({ ok: true, status: 403 });
    expect(authShapedFailureStore.get()).toEqual({ appId: APP, slot: SLOT, status: 403 });
  });

  it('NEGATIVE: a 200 fires nothing', async () => {
    await seedApprovedApp();
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
    });
    await handler.handle(APP, frame('https://api.example.com/v1/data'));
    expect(authShapedFailureStore.get()).toBeNull();
  });

  it('NEGATIVE: a 401 with NO injected credential (kind none) fires nothing', async () => {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
    db.putDeclaredConnection(APP, 'public', noneRequirement, 'inference');
    db.approveConnection(APP, 'public');
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    });
    const result = await handler.handle(APP, frame('https://api.public.example/v1/things'));
    expect(result).toMatchObject({ ok: true, status: 401 });
    expect(authShapedFailureStore.get()).toBeNull();
  });

  it('NEGATIVE: a 401 CURED by the OAuth refresh retry fires nothing (final-result rule at the shipped seam)', async () => {
    // Fictional OAuth provider (no registry borrow): stale access token → 401 →
    // transparent refresh → retry 200. The DELIVERED result is a 200, so the observer
    // must stay silent — the banner exists for failures the user must repair, not for
    // ones the executor already repaired.
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Net App', html: '<p>net</p>' });
    const oauthRequirement = {
      slot: 'melodine',
      kind: 'oauth2_auth_code' as const,
      provider: { name: 'Melodine' },
      endpoints: {
        authorizeUrl: 'https://accounts.melodine.example/authorize',
        tokenUrl: 'https://accounts.melodine.example/token',
        refreshUrl: 'https://accounts.melodine.example/token',
      },
      fields: [{ key: 'client_id', label: 'Client ID', type: 'text' as const }],
      declaredApiHosts: ['api.melodine.example'],
    };
    db.putDeclaredConnection(APP, 'melodine', oauthRequirement, 'inference');
    db.approveConnection(APP, 'melodine');
    db.setSecret(authConnectionCredentialSecretKey(APP, 'melodine', 'access_token'), 'stale-token-1');
    db.setSecret(authConnectionCredentialSecretKey(APP, 'melodine', 'refresh_token'), 'refresh-token-1');
    db.setSecret(authConnectionCredentialSecretKey(APP, 'melodine', 'client_id'), 'client-1');
    db.setSecret(
      authConnectionStateSecretKey(APP, 'melodine'),
      JSON.stringify({ status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 }),
    );

    let apiCalls = 0;
    const handler = createNetHandlerFor({
      fetchImpl: async (url) => {
        if (url.startsWith('https://accounts.melodine.example/token')) {
          return new Response(JSON.stringify({ access_token: 'refreshed-token-2', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        apiCalls += 1;
        return apiCalls === 1
          ? new Response('unauthorized', { status: 401 })
          : new Response('{"fine":true}', { status: 200 });
      },
    });
    const result = await handler.handle(APP, frame('https://api.melodine.example/v1/me'));
    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(authShapedFailureStore.get()).toBeNull();
  });

  it('NEGATIVE: the wizard probe never reaches the store — probe outcomes render in the wizard only', async () => {
    // The probe path (testConnection → connectedFetchDepsFor) must not thread the
    // observer at all, and the executor strips it besides (belt and braces, both real).
    await seedApprovedApp();
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    const outcome = await testConnection(async () => new Response('unauthorized', { status: 401 }));
    // No testRequest on this requirement → the probe refuses before any fetch — still a
    // valid pin that nothing landed. Drive the credentialed 401 shape too, via a
    // requirement that DOES declare a probe:
    expect(outcome.ok).toBe(false);
    expect(authShapedFailureStore.get()).toBeNull();
    __resetConnectionWizardForTests();

    const db = await getUserDb();
    db.putDeclaredConnection(
      APP,
      'probed',
      {
        ...apiKeyRequirement,
        slot: 'probed',
        // Its own host — a second row on api.example.com would make every request
        // ambiguous (NET_AMBIGUOUS_CONNECTION) instead of exercising the probe.
        declaredApiHosts: ['api.probed.example'],
        testRequest: { method: 'GET', pathAndQuery: '/v1/probe' },
      },
      'inference',
    );
    db.approveConnection(APP, 'probed');
    db.setSecret(authConnectionCredentialSecretKey(APP, 'probed', 'api_key'), 'probe-key-1');
    openConnectionWizard({ appId: APP, slot: 'probed', source: 'settings' });
    const probed = await testConnection(async () => new Response('unauthorized', { status: 401 }));
    expect(probed).toMatchObject({ ok: false, code: 'HTTP_401' });
    expect(authShapedFailureStore.get(), 'a probe 401 renders in the wizard, never as a banner').toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The banner: provider-named copy + the "check this connection" CTA
// ---------------------------------------------------------------------------

describe('AuthRepairBanner — renders the repair CTA on the failing (appId, slot)', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderBanner(appId: string): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AuthRepairBanner appId={appId} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
  });

  const text = (): string => container.textContent ?? '';
  const button = (name: RegExp): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => name.test(b.textContent ?? '')) as
      | HTMLButtonElement
      | undefined;

  it('renders nothing while no failure is stored', async () => {
    await seedApprovedApp();
    await renderBanner(APP);
    expect(text()).toBe('');
  });

  it('names the PROVIDER and the status, and offers "check this connection"', async () => {
    await seedApprovedApp();
    await renderBanner(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    // Provider name resolves from the row — the banner speaks the user's vocabulary,
    // not the executor's.
    //
    // Asserted as "names the provider" rather than by matching the sentence verbatim:
    // TASK-20260813 AC10 rewrote this copy (the old line was "Example rejected this
    // app's credentials") and a literal match makes every future wording change look
    // like a regression. What must hold is that the user learns WHICH provider and
    // WHAT status — the two facts they need to act.
    expect(text()).toContain('Example');
    expect(text()).toContain('401');
    expect(button(/check this connection/i)).toBeDefined();
  });

  it('the CTA opens the wizard on the EXACT failing (appId, slot) and dismisses the banner', async () => {
    await seedApprovedApp();
    await renderBanner(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    await act(async () => {
      button(/check this connection/i)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(connectionWizardStore.get()).toMatchObject({ appId: APP, slot: SLOT });
    expect(connectionWizardSlotStore.get()).toBe(SLOT);
    expect(authShapedFailureStore.get(), 'a real open clears the banner').toBeNull();
  });

  it('the CTA does NOT dismiss when the wizard refuses to open (another wizard already parked)', async () => {
    await seedApprovedApp();
    openConnectionWizard({ appId: 'app-other', slot: 'busy', source: 'settings' });
    await renderBanner(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    await act(async () => {
      button(/check this connection/i)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The boolean is the contract (the v3 Promise-truthiness trap, re-pinned here): a
    // refused open must leave the banner standing so the user still has a route back.
    expect(authShapedFailureStore.get()).not.toBeNull();
  });

  it('dismiss clears the store without opening anything', async () => {
    await seedApprovedApp();
    await renderBanner(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    await act(async () => {
      button(/dismiss/i)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(authShapedFailureStore.get()).toBeNull();
    expect(connectionWizardStore.get()).toBeNull();
  });

  it("NEGATIVE: a failure for a DIFFERENT app renders nothing in this app's view", async () => {
    await seedApprovedApp();
    await renderBanner('app-somebody-else');
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    expect(text()).toBe('');
  });

  it('dismissAuthShapedFailure is the reset the RunView dismiss button rides', async () => {
    authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 403 });
    dismissAuthShapedFailure();
    expect(authShapedFailureStore.get()).toBeNull();
  });
});
