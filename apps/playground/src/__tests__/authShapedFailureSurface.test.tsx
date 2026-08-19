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
import { AuthRepairChip } from '../run/AuthRepairBanner.js';
import { ConnectionWizardSheet } from '../connections/ConnectionWizardSheet.js';
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
    // MIGRATED 2026-08-15 (TASK-20260815 AC4): the executor now forwards the provider's
    // own reason — a plain-text body becomes the detail.
    expect(authShapedFailureStore.get()).toEqual({ appId: APP, slot: SLOT, status: 401, detail: 'unauthorized' });
  });

  it('a 403 lands too, with its own status', async () => {
    await seedApprovedApp();
    const handler = createNetHandlerFor({
      fetchImpl: async () => new Response('forbidden', { status: 403 }),
    });
    const result = await handler.handle(APP, frame('https://api.example.com/v1/data'));
    expect(result).toMatchObject({ ok: true, status: 403 });
    expect(authShapedFailureStore.get()).toEqual({ appId: APP, slot: SLOT, status: 403, detail: 'forbidden' });
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
// The CHIP: the quiet run-surface trace of a live failure (TASK-20260819 D2)
// ---------------------------------------------------------------------------
//
// WHAT CHANGED AND WHY. Until 2026-08-19 this surface was a full-bleed maroon block
// rendered INSIDE the running app, carrying the whole diagnosis and two buttons. The
// owner's report: it displaced the app's own UI and read as an alarm even when the app
// was working. Owner decision D2 moves the diagnosis into the wizard (Step 0, the
// attention gate) and leaves here only a quiet chip in the run header — enough that a
// failure is never invisible, little enough that it is not an alarm.
//
// The CTA contract below is UNCHANGED from the banner era and deliberately so: the v3
// Promise-truthiness lesson (a refused open must not clear the only route back) is a
// property of the failure store, not of the surface that renders it.

describe('AuthRepairChip — the quiet run-surface trace of the failing (appId, slot)', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderChip(appId: string): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<AuthRepairChip appId={appId} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /**
   * Render the wizard sheet parked on the ATTENTION gate (Step 0) for a live failure.
   *
   * The three provider-detail assertions below used to render the banner directly. They
   * moved here rather than being deleted, because what they pin is unchanged and still
   * load-bearing: the provider's own sentence must reach the user, and it must reach them
   * as TEXT. Only the surface that shows it changed (owner decision D2).
   */
  async function renderAttentionStep(appId: string): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ConnectionWizardSheet />);
    });
    await act(async () => {
      await Promise.resolve();
    });
    const live = authShapedFailureStore.get();
    openConnectionWizard({
      appId,
      slot: SLOT,
      source: 'error_cta',
      ...(live !== null ? { failure: { status: live.status, ...(live.detail !== undefined ? { detail: live.detail } : {}) } } : {}),
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
    await renderChip(APP);
    expect(text()).toBe('');
  });

  it('AC8: names the PROVIDER and offers ONE way in — the diagnosis itself belongs to Step 0', async () => {
    await seedApprovedApp();
    await renderChip(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    // The provider name resolves from the ROW — this surface speaks the user's
    // vocabulary, not the executor's. Asserted as "names the provider" rather than by
    // matching a sentence: copy has been rewritten twice (TASK-20260813 AC10, and again
    // here), and a literal match makes every wording change look like a regression.
    expect(text()).toContain('Example');
    expect(button(/check this connection/i)).toBeDefined();
  });

  it('AC8: the chip is QUIET — no status code, no provider sentence, no dismiss (that is Step 0 now)', async () => {
    // The point of D2. A chip that reproduced the full diagnosis would be the maroon
    // block again in a smaller box; a chip carrying its own dismiss would let the user
    // silence a failure without ever seeing what it was.
    await seedApprovedApp();
    await renderChip(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 403, detail: 'Insufficient client scope' });
      await Promise.resolve();
    });
    expect(text(), 'the raw status belongs on the screen that explains it').not.toContain('403');
    expect(text()).not.toContain('Insufficient client scope');
    expect(button(/^dismiss$/i), 'dismissing happens where the diagnosis is read').toBeUndefined();
  });

  it("TASK-20260815 AC4 / TASK-20260819 AC6: Step 0 renders the provider's own reason", async () => {
    await seedApprovedApp();
    await renderAttentionStep(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 403, detail: 'Insufficient client scope' });
      await Promise.resolve();
    });
    const detail = container.querySelector('[data-testid="auth-repair-detail"]');
    expect(detail, 'the provider-says line must render when a detail exists').not.toBeNull();
    expect(detail!.textContent).toContain('Insufficient client scope');
    // The provider is named as the SOURCE of the sentence — this is their diagnosis,
    // not our guess.
    expect(detail!.textContent).toContain('Example');
  });

  it('TASK-20260815 AC4 NEGATIVE: no detail → no provider-says line (the guess copy stands alone)', async () => {
    await seedApprovedApp();
    await renderAttentionStep(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 403 });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="auth-repair-detail"]')).toBeNull();
    expect(text()).toContain('403');
  });

  it('TASK-20260815 AC4 NEGATIVE (C1-adjacent): detail renders as PLAIN TEXT — markup never becomes elements, URLs never become links', async () => {
    // Provider-authored text rendered in host chrome: the same hostile-copy rule the
    // registration steps carry (P3-AC5). React escapes by construction; this pins the
    // property so a future "make it prettier" cannot quietly add dangerouslySetInnerHTML
    // or a linkifier.
    const hostile = '<a href="https://evil.example/fix">click here to fix</a> or visit https://evil.example/fix now';
    await seedApprovedApp();
    await renderAttentionStep(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 403, detail: hostile });
      await Promise.resolve();
    });
    const detail = container.querySelector('[data-testid="auth-repair-detail"]')!;
    expect(detail.querySelector('a'), 'markup must never become an element').toBeNull();
    expect(detail.querySelector('img')).toBeNull();
    expect(detail.textContent, 'the hostile string renders VERBATIM as text').toContain('<a href=');
  });

  it('AC8/AC7: the CTA opens the wizard on the EXACT failing (appId, slot) and HANDS OFF the failure', async () => {
    await seedApprovedApp();
    await renderChip(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    await act(async () => {
      button(/check this connection/i)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(connectionWizardStore.get()).toMatchObject({ appId: APP, slot: SLOT });
    expect(connectionWizardSlotStore.get()).toBe(SLOT);
    // HANDED OFF, not merely dropped (decision D4): the session carries the copy Step 0
    // reads, and the store is cleared so two surfaces never own one failure.
    expect(connectionWizardStore.get()?.failure?.status).toBe(401);
    expect(authShapedFailureStore.get(), 'a real open clears the store').toBeNull();
  });

  it('the CTA does NOT dismiss when the wizard refuses to open (another wizard already parked)', async () => {
    await seedApprovedApp();
    openConnectionWizard({ appId: 'app-other', slot: 'busy', source: 'settings' });
    await renderChip(APP);
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

  it('AC10: the chip hides itself while the wizard is open on this app — never a double render', async () => {
    // Chip AND Step 0 rendering the same failure at once would be the plan review's
    // double-render finding: two surfaces claiming one fact, and a user who dismisses one
    // still staring at the other.
    await seedApprovedApp();
    await renderChip(APP);
    await act(async () => {
      authShapedFailureStore.set({ appId: APP, slot: SLOT, status: 401 });
      await Promise.resolve();
    });
    expect(text(), 'visible before the wizard opens').toContain('Example');

    await act(async () => {
      button(/check this connection/i)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(text(), 'the wizard owns the failure once it is open').toBe('');
  });

  it("NEGATIVE: a failure for a DIFFERENT app renders nothing in this app's view", async () => {
    await seedApprovedApp();
    await renderChip('app-somebody-else');
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
