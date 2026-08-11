// connectionOauthFlow.test.ts — P3 fold: the OAuth `connect` step, REINSTATED on the v4
// slot-keyed store.
//
// WHAT WAS BROKEN, and why this file exists. P3's cutover deleted the v3 wizard store —
// and with it a complete, hardened three-legged OAuth flow — and replaced the connect
// screen with a static paragraph reading "a sign-in window will open". Nothing opened one.
// No popup, no token exchange, no forward affordance of any kind: the screen was a terminal
// dead end, and any user building a Spotify/Google app was stranded mid-wizard. The suite
// stayed green because the only test that reached the screen asserted
// `connectionWizardStepStore.get() === 'connect'` and stopped there — a step name is not a
// behavior, and 27/27 passed over a flow that could not complete.
//
// SO THIS FILE ASSERTS THE FLOW, NOT THE STEP. It drives the REAL `OAuthService` offline
// (fake fetch, fake popup, fake channel — no window.open, no wire) through the v4 store,
// and it is a faithful port of the v3 suite's coverage rather than a fresh minimum:
// held-flowId callback binding, forged-flowId rejection, channel-named-by-flowId, the
// popup-closed backstop, the popup-blocked error carrying its authorize URL, the
// double-start teardown race, and the B1 wall (no popup and no service call before the
// row is approved). Those cases were paid for by real defects; a rebuild that dropped them
// would be a rebuild that reintroduces them.
//
// WHAT CHANGED FROM v3: the flow is built from the APPROVED CONNECTION ROW's frozen
// ceiling (`allowedHosts` on `snug_connections`) rather than v3's app-keyed SpecScope. The
// popup lifecycle is untouched by that move, which is exactly why it could be ported
// rather than redesigned.
//
// C1 — no credential VALUE is ever handed to a screen here. Client credentials go from the
// credentials step straight to `snug_secrets`; the flow reads them back through
// `UserDbCredentialStore` inside the service and never returns one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlotScopedCredentialStore, UserDbCredentialStore, signState } from '@snugprotocol/auth';

import {
  __resetConnectionWizardForTests,
  __setConnectionOAuthHooksForTests,
  closeConnectionWizard,
  connectionFlowStatusStore,
  connectionWizardStepStore,
  openConnectionWizard,
  startConnectionOAuthFlow,
  type ConnectionChannelLike,
  type ConnectionPopupLike,
} from '../state/connectionWizard.js';
import { getUserDb } from '../state/userdb.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'app-p3-oauth';
const SLOT = 'fake-idp';

/**
 * An OAuth requirement in v4 dialect. The client_id is a PUBLIC value and the only field
 * the user pastes for a PKCE public client — which is why the connect step exists at all:
 * a static kind is finished the moment its secrets land, but this one still needs the
 * browser round trip that turns a client id into a token.
 */
const oauthRequirement = {
  slot: SLOT,
  provider: { name: 'Fake IdP' },
  kind: 'oauth2_auth_code',
  endpoints: {
    authorizeUrl: 'https://idp.example/authorize',
    tokenUrl: 'https://idp.example/token',
  },
  pkce: true,
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
  declaredApiHosts: ['api.fake-idp.example'],
} as const satisfies Record<string, unknown>;

interface FakeChannel extends ConnectionChannelLike {
  name: string;
  post(data: unknown): void;
  closeCalls: number;
}

function fakeChannelFactory(created: FakeChannel[]): (name: string) => ConnectionChannelLike {
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

/** A token endpoint that answers a valid grant. Never a real wire. */
const tokenFetch = vi.fn(
  async () =>
    new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
);

/** Seed an APPROVED v4 row — the B1 precondition the flow is built on. */
async function seedApproved(): Promise<void> {
  const db = await getUserDb();
  db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, SLOT, oauthRequirement, 'registry' as never);
  db.approveConnection(APP, SLOT);
}

beforeEach(async () => {
  await installTestUserDb();
  __resetConnectionWizardForTests();
  tokenFetch.mockClear();
});

afterEach(() => {
  __resetConnectionWizardForTests();
  __setConnectionOAuthHooksForTests({});
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P3 fold — the three-legged flow completes end to end, offline', () => {
  it('opens a popup at the authorize URL, and the HELD flowId completes the exchange', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    const opened: string[] = [];
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: (url) => {
        opened.push(url);
        return { closed: false };
      },
      fetchImpl: tokenFetch,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await startConnectionOAuthFlow({ client_id: 'cid-1' });

    // (a) A POPUP IS ACTUALLY OPENED, at the minted authorize URL. This is the assertion
    // the dead-end screen could not make: nothing opened at all.
    expect(opened, 'the connect step must open a sign-in window').toHaveLength(1);
    const authorizeUrl = new URL(opened[0]!);
    expect(authorizeUrl.origin).toBe('https://idp.example');
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    // The channel is named by the flowId the INITIATOR holds — the payload can never
    // teach it, which is what makes the binding below meaningful.
    expect(channels).toHaveLength(1);
    const flowId = channels[0]!.name.replace('snug-oauth-', '');
    expect(connectionFlowStatusStore.get()).toMatchObject({ state: 'awaiting_callback', flowId });

    // (b) A DELIVERED CALLBACK ADVANCES TO `done`.
    channels[0]!.post({ appId: APP, flowId, code: 'auth-code-1', state });
    await vi.waitFor(() => expect(connectionFlowStatusStore.get().state).toBe('connected'));
    expect(connectionWizardStepStore.get()).toBe('done');

    // The exchange hit the TOKEN endpoint through the ceiling-checked postForm, and the
    // token landed in the user's own file — local-first custody (ADR-0014).
    expect(tokenFetch).toHaveBeenCalledTimes(1);
    expect(tokenFetch.mock.calls[0]![0]).toBe('https://idp.example/token');
    // SLOT-SCOPED, and asserted through the same wrapper production uses. The token must
    // land under `auth:<appId>:<slot>:access_token` — a token written at the v3 app-keyed
    // path would be read by every slot of this app, which is one provider serving another.
    const slotStore = new SlotScopedCredentialStore(new UserDbCredentialStore(await getUserDb()), SLOT);
    expect(await slotStore.getCredential(APP, 'access_token')).toBe('at-1');
    // And NOT at the unslotted v3 key — the negative half, or the assertion above would
    // pass on a store that simply ignored the slot.
    expect(await new UserDbCredentialStore(await getUserDb()).getCredential(APP, 'access_token')).toBeUndefined();
  });

  it('forged flowId: a VALIDLY-SIGNED state naming another flow is refused, and nothing is exchanged', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: () => ({ closed: false }),
      fetchImpl: tokenFetch,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await startConnectionOAuthFlow({ client_id: 'cid-1' });

    // The tautology this kills: a forged state can be signed with the SAME key and still
    // must not bind, because binding comes from the initiator's HELD copy — never from
    // anything the delivery carries.
    const db = await getUserDb();
    const secret = await new UserDbCredentialStore(db).getOrCreateStateHmacKey();
    const forged = await signState(
      { appId: APP, flowId: 'evil-flow', nonce: 'n1', exp: Date.now() + 600_000 },
      secret,
    );

    channels[0]!.post({ appId: APP, flowId: 'evil-flow', code: 'stolen-code', state: forged });
    await vi.waitFor(() => expect(connectionFlowStatusStore.get().state).toBe('error'));
    expect((connectionFlowStatusStore.get() as { message: string }).message).toContain('flow_mismatch');
    expect(tokenFetch, 'the credential POST must never happen on a mismatched flow').not.toHaveBeenCalled();
    expect(channels[0]!.closeCalls).toBeGreaterThan(0); // torn down — fail closed
  });

  it('popup-closed backstop: a window closed without finishing surfaces "try again"', async () => {
    await seedApproved();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const popup: ConnectionPopupLike = { closed: false };
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory([]),
      openPopup: () => popup,
      fetchImpl: tokenFetch,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await startConnectionOAuthFlow({ client_id: 'cid-1' });

    // BroadcastChannel delivery has no failure signal, so a user who closes the window is
    // otherwise left watching "waiting for sign-in…" forever.
    popup.closed = true;
    vi.advanceTimersByTime(600);
    expect(connectionFlowStatusStore.get()).toMatchObject({ state: 'error' });
    expect((connectionFlowStatusStore.get() as { message: string }).message).toMatch(/closed/i);
  });
});

describe('P3 fold — (c) a BLOCKED popup is a visible error, never a parked wait', () => {
  it('surfaces the error state carrying the authorize URL so the UI can offer a fallback', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: () => null, // the popup blocker
      fetchImpl: tokenFetch,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await startConnectionOAuthFlow({ client_id: 'cid-1' });

    const status = connectionFlowStatusStore.get();
    // NOT awaiting_callback: nothing is coming, and a spinner that never resolves is the
    // cruelest possible ending for a non-technical user.
    expect(status.state).toBe('error');
    expect((status as { message: string }).message).toMatch(/popup|blocked/i);
    expect((status as { authorizeUrl?: string }).authorizeUrl).toContain('https://idp.example');
    expect(channels[0]!.closeCalls).toBeGreaterThan(0); // no flow installed, nothing leaked
  });
});

describe('P3 fold — B1: the flow is unreachable before the row is approved', () => {
  it('a DECLARED row: no popup, no service call, a refusal', async () => {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
    db.putDeclaredConnection(APP, SLOT, oauthRequirement, 'registry' as never); // NOT approved
    const openPopup = vi.fn(() => ({ closed: false }));
    __setConnectionOAuthHooksForTests({ channelFactory: fakeChannelFactory([]), openPopup, fetchImpl: tokenFetch });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });

    await expect(startConnectionOAuthFlow({ client_id: 'cid-1' })).rejects.toThrow(/approve/i);
    expect(openPopup, 'no sign-in window may open against an unfrozen ceiling').not.toHaveBeenCalled();
    expect(tokenFetch).not.toHaveBeenCalled();
  });

  it('a REVOKED row is refused too — a tombstone is not an approval', async () => {
    await seedApproved();
    const db = await getUserDb();
    db.revokeConnection(APP, SLOT);
    const openPopup = vi.fn(() => ({ closed: false }));
    __setConnectionOAuthHooksForTests({ channelFactory: fakeChannelFactory([]), openPopup, fetchImpl: tokenFetch });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });

    await expect(startConnectionOAuthFlow({ client_id: 'cid-1' })).rejects.toThrow();
    expect(openPopup).not.toHaveBeenCalled();
  });
});

describe('P3 fold — lifecycle: a restart tears the previous flow down FIRST', () => {
  it('two rapid starts: the stale channel closes, and the LIVE flow survives the stale popup closing', async () => {
    await seedApproved();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const channels: FakeChannel[] = [];
    const popups: Array<{ closed: boolean }> = [];
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup: () => {
        const popup = { closed: false };
        popups.push(popup);
        return popup;
      },
      fetchImpl: tokenFetch,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    // The double-click race: both starts in flight before either installs its flow.
    await Promise.all([startConnectionOAuthFlow({ client_id: 'cid-1' }), startConnectionOAuthFlow({ client_id: 'cid-1' })]);

    expect(channels).toHaveLength(2);
    expect(channels[0]!.closeCalls).toBeGreaterThan(0); // the stale flow was torn down…
    expect(channels[1]!.closeCalls).toBe(0); // …and the live one was not

    // A leaked poll from the stale flow would fire on the stale popup closing and kill the
    // LIVE flow — the v3 defect this guard was written for, ported rather than re-earned.
    popups[0]!.closed = true;
    vi.advanceTimersByTime(1200);
    expect(connectionFlowStatusStore.get().state).toBe('awaiting_callback');
    expect(channels[1]!.closeCalls).toBe(0);
  });

  it('a wizard closed mid-mint never resurrects: no navigate, no channel, status idle', async () => {
    await seedApproved();
    const channels: FakeChannel[] = [];
    const openPopup = vi.fn(() => ({ closed: false }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    __setConnectionOAuthHooksForTests({
      channelFactory: fakeChannelFactory(channels),
      openPopup,
      service: {
        generateAuthUrl: async () => {
          await gate;
          return { authorizeUrl: 'https://idp.example/authorize?g=1', state: 's', flowId: 'flow-z' };
        },
        handleCallback: vi.fn(),
      } as never,
    });
    openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });

    const preOpened = {
      closed: false,
      closeCalls: 0,
      navigate: vi.fn(),
      close(): void {
        preOpened.closeCalls += 1;
      },
    };
    const inflight = startConnectionOAuthFlow({ client_id: 'cid-1' }, preOpened);
    closeConnectionWizard();
    release();
    await inflight;

    // A completed mint must never land a popup over a wizard the user already dismissed.
    expect(preOpened.navigate).not.toHaveBeenCalled();
    expect(preOpened.closeCalls, 'the gesture-opened blank window must not be orphaned').toBeGreaterThan(0);
    expect(openPopup).not.toHaveBeenCalled();
    expect(channels).toHaveLength(0);
    expect(connectionFlowStatusStore.get().state).toBe('idle');
  });
});
