// AL-04 AC6/B1/D6 — the popup flow against the REAL OAuthService (fake fetch, fake
// popup, fake channel — no window.open, no wire): held-flowId callback binding,
// forged-flowId rejection, channel-named-by-flowId, the popup-closed backstop, and
// `generateAuthUrl` unreachable pre-approval (mutations M7-table/M13).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UserDbCredentialStore, signState } from '@snugprotocol/auth';

import {
  __resetWizardStateForTests,
  __setWizardHooksForTests,
  openWizard,
  startOAuthFlow,
  wizardFlowStatusStore,
  type WizardChannelLike,
  type WizardPopupLike,
} from '../state/wizard.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'app-oauth';

const oauthSpec = {
  kind: 'oauth2_auth_code' as const,
  provider: { name: 'Fake IdP' },
  endpoints: {
    authorizeUrl: 'https://idp.example/authorize',
    tokenUrl: 'https://idp.example/token',
  },
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' as const },
    { key: 'client_secret', label: 'Client Secret', type: 'secret' as const },
  ],
  declaredApiHosts: ['api.fake-idp.example'],
};

interface FakeChannel extends WizardChannelLike {
  name: string;
  post(data: unknown): void;
  closeCalls: number;
}

function fakeChannelFactory(created: FakeChannel[]): (name: string) => WizardChannelLike {
  return (name) => {
    const channel: FakeChannel = {
      name,
      onmessage: null,
      closeCalls: 0,
      close() {
        channel.closeCalls += 1;
      },
      post(data: unknown) {
        channel.onmessage?.({ data });
      },
    };
    created.push(channel);
    return channel;
  };
}

/** A token-endpoint fetch that answers a valid token grant. */
const tokenFetch = vi.fn(async () =>
  new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }),
);

async function seedApproved(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
  db.putAuthSpec(APP, oauthSpec);
  db.approveAuthSpec(APP);
}

beforeEach(async () => {
  await installTestUserDb();
  __resetWizardStateForTests();
  tokenFetch.mockClear();
});
afterEach(() => {
  __resetWizardStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AC6/D6 — the real service flow, end to end offline', () => {
  it('happy path: popup URL carries the signed state; the delivery completes with the HELD flowId', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    const opened: string[] = [];
    __setWizardHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: (url) => {
        opened.push(url);
        return { closed: false };
      },
      fetchImpl: tokenFetch,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await startOAuthFlow({ client_id: 'cid-1' });

    expect(opened).toHaveLength(1);
    const authorizeUrl = new URL(opened[0]!);
    expect(authorizeUrl.origin).toBe('https://idp.example');
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // The channel is named by the flowId the INITIATOR holds (D6).
    expect(channels).toHaveLength(1);
    const flowId = channels[0]!.name.replace('snug-oauth-', '');
    expect(channels[0]!.name).toBe(`snug-oauth-${flowId}`);
    expect(wizardFlowStatusStore.get()).toMatchObject({ state: 'awaiting_callback', flowId });

    channels[0]!.post({ appId: APP, flowId, code: 'auth-code-1', state });
    await vi.waitFor(() => expect(wizardFlowStatusStore.get().state).toBe('connected'));

    // The exchange hit the TOKEN endpoint through the ceiling-checked postForm.
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(tokenFetch.mock.calls[0]![0]).toBe('https://idp.example/token');
    // Tokens persisted through the store — local-first custody (ADR-0014).
    const store = new UserDbCredentialStore(await getUserDb());
    expect(await store.getCredential(APP, 'access_token')).toBe('at-1');
  });

  it('forged flowId: a delivery whose SIGNED state names a different flow → flow_mismatch, no exchange', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    __setWizardHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: () => ({ closed: false }),
      fetchImpl: tokenFetch,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await startOAuthFlow({ client_id: 'cid-1' });

    // Forge: a VALIDLY-SIGNED state (same HMAC key) for a DIFFERENT flowId — the
    // exact tautology AC6 exists to kill: binding must come from the held copy.
    const db = await getUserDb();
    const secret = await new UserDbCredentialStore(db).getOrCreateStateHmacKey();
    const forged = await signState({ appId: APP, flowId: 'evil-flow', nonce: 'n1', exp: Date.now() + 600_000 }, secret);

    channels[0]!.post({ appId: APP, flowId: 'evil-flow', code: 'stolen-code', state: forged });
    await vi.waitFor(() => expect(wizardFlowStatusStore.get().state).toBe('error'));
    expect((wizardFlowStatusStore.get() as { message: string }).message).toContain('flow_mismatch');
    expect(tokenFetch).not.toHaveBeenCalled(); // the credential POST never happened
    expect(channels[0]!.closeCalls).toBeGreaterThan(0); // flow torn down, fail closed
  });

  it('popup-closed backstop: a closed window with no delivery surfaces "try again" (~500ms poll)', async () => {
    await seedApproved();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const popup: WizardPopupLike = { closed: false };
    __setWizardHooksForTests({
      channelFactory: fakeChannelFactory([]),
      openPopup: () => popup,
      fetchImpl: tokenFetch,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await startOAuthFlow({ client_id: 'cid-1' });

    popup.closed = true;
    vi.advanceTimersByTime(600);
    expect(wizardFlowStatusStore.get()).toMatchObject({ state: 'error' });
    expect((wizardFlowStatusStore.get() as { message: string }).message).toMatch(/closed — try again/i);
  });
});

describe('B1 — generateAuthUrl is unreachable pre-approval (M13)', () => {
  it('an unapproved row: no popup, no service call, a typed spec_not_approved rejection', async () => {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
    db.putAuthSpec(APP, oauthSpec); // NOT approved
    const generateAuthUrl = vi.fn();
    const openPopup = vi.fn(() => ({ closed: false }));
    __setWizardHooksForTests({
      service: { generateAuthUrl, handleCallback: vi.fn() } as never,
      openPopup,
      channelFactory: fakeChannelFactory([]),
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await expect(startOAuthFlow({ client_id: 'cid-1' })).rejects.toMatchObject({ code: 'spec_not_approved' });
    expect(generateAuthUrl).not.toHaveBeenCalled();
    expect(openPopup).not.toHaveBeenCalled();
  });
});

describe('popup-blocker escape (D6): a pre-opened gesture popup is NAVIGATED, never re-opened', () => {
  // A blank popup the CLICK HANDLER opened synchronously — with a `navigate` seam,
  // exactly the shape `openBlankOAuthPopup` returns.
  function fakePreOpened(): WizardPopupLike & { navigated: string[]; closeCalls: number } {
    const p = {
      closed: false,
      navigated: [] as string[],
      closeCalls: 0,
      navigate(url: string) {
        p.navigated.push(url);
      },
      close() {
        p.closeCalls += 1;
      },
    };
    return p;
  }

  it('the pre-opened popup is navigated to the authorize URL; window.open (openPopup) is NEVER called for the URL', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    // If the code falls back to opening a NEW popup with the URL, this spy trips —
    // that is the pre-fix behavior a real blocker would kill.
    const openPopup = vi.fn(() => ({ closed: false }));
    __setWizardHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup,
      fetchImpl: tokenFetch,
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });

    const popup = fakePreOpened();
    await startOAuthFlow({ client_id: 'cid-1' }, popup);

    // The gesture-opened window was navigated — the URL never came from a post-await open.
    expect(popup.navigated).toHaveLength(1);
    expect(new URL(popup.navigated[0]!).origin).toBe('https://idp.example');
    expect(openPopup).not.toHaveBeenCalled();
    expect(wizardFlowStatusStore.get()).toMatchObject({ state: 'awaiting_callback' });
  });

  it('the flow aborts at the B1 approval gate: the pre-opened popup is CLOSED, never orphaned', async () => {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
    db.putAuthSpec(APP, oauthSpec); // NOT approved — the gate throws
    __setWizardHooksForTests({ channelFactory: fakeChannelFactory([]), fetchImpl: tokenFetch });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });

    const popup = fakePreOpened();
    await expect(startOAuthFlow({ client_id: 'cid-1' }, popup)).rejects.toMatchObject({ code: 'spec_not_approved' });
    expect(popup.navigated).toHaveLength(0); // never navigated
    expect(popup.closeCalls).toBeGreaterThan(0); // the blank window was closed, not left open
  });
});
