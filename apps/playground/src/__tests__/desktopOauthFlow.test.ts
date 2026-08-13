// Desktop OAuth wiring at the FLOW (TASK-20260812 W2a; ADR-0021 Decisions 3/5, P0
// amendments 6/7). When the platform declares an `oauth` transport, the flow swaps the
// popup seam for the system browser (RFC 8252 — the webview never navigates to a
// provider), sources the redirect URI and delivery channel from the SAME platform
// surface the register screen displays, refuses unsupported postures BEFORE any
// credential step, and drops the popup-closed poll (an OS browser window has no handle
// to poll — the flow TTL and the explicit cancel are the abandonment story).
//
// Platform is set-once, so each case takes a fresh module registry.
import { describe, expect, it, vi } from 'vitest';

import { lookupWellKnownProvider, requirementFromRegistryEntry } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

const APP = 'app-desktop-oauth';
const SLOT = 'fake-idp';

/** Unknown-to-the-registry provider — the ephemeral-loopback DEFAULT posture. */
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

interface FakePlatformChannel {
  flowId: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  closeCalls: number;
  close(): void;
  post(data: unknown): void;
}

interface FakeDesktop {
  platform: SnugPlatform;
  opened: string[];
  channels: FakePlatformChannel[];
  redirectUriFor: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  fetchCalls: Array<{ url: string; init: RequestInit }>;
}

function fakeDesktop(redirectUri = 'http://127.0.0.1:41420/callback'): FakeDesktop {
  const opened: string[] = [];
  const channels: FakePlatformChannel[] = [];
  const fetchCalls: FakeDesktop['fetchCalls'] = [];
  const redirectUriFor = vi.fn(async () => redirectUri);
  const cancel = vi.fn(async () => undefined);
  const platform: SnugPlatform = {
    kind: 'desktop',
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    oauth: {
      redirectUriFor,
      openExternal: async (url) => {
        opened.push(url);
      },
      channelFor: (flowId) => {
        const channel: FakePlatformChannel = {
          flowId,
          onmessage: null,
          closeCalls: 0,
          close() {
            channel.closeCalls += 1;
          },
          post(data: unknown) {
            channel.onmessage?.({ data });
          },
        };
        channels.push(channel);
        return channel;
      },
      cancel,
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
  return { platform, opened, channels, redirectUriFor, cancel, fetchCalls };
}

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
}

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  return { db, wizard };
}

function seedApproved(db: UserDb, requirement: Record<string, unknown> = oauthRequirement, slot = SLOT): void {
  db.installApp({ appId: APP, displayName: 'OAuth App', html: '<p>x</p>' });
  db.putDeclaredConnection(APP, slot, requirement, 'registry' as never);
  db.approveConnection(APP, slot);
}

describe('desktop OAuth — the system browser carries the sign-in (Decision 3)', () => {
  it('openExternal gets the authorize URL, the platform supplies redirect URI + channel, and the exchange rides the platform fetch', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);
    const windowOpen = vi.spyOn(window, 'open');

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });

    // The OS opener carries the URL; the webview never navigates and no popup opens.
    expect(desktop.opened).toHaveLength(1);
    expect(windowOpen, 'RFC 8252 — the webview must never open a provider window').not.toHaveBeenCalled();

    // The redirect URI came from the ONE platform source, with the resolved posture —
    // an unknown provider defaults to the ephemeral loopback posture.
    expect(desktop.redirectUriFor).toHaveBeenCalledWith({ provider: 'Fake IdP', posture: 'loopback' });
    const authorizeUrl = new URL(desktop.opened[0]!);
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:41420/callback');

    // The delivery channel is the platform's, keyed by the HELD flowId.
    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('awaiting_callback');
    const flowId = (status as { flowId: string }).flowId;
    expect(desktop.channels).toHaveLength(1);
    expect(desktop.channels[0]!.flowId).toBe(flowId);

    // Deliver the callback → the token POST goes through the PLATFORM fetch (amendment 6),
    // with the redirect_uri byte-identical to the authorize half.
    const state = authorizeUrl.searchParams.get('state')!;
    desktop.channels[0]!.post({ appId: APP, flowId, code: 'auth-code-1', state });
    await vi.waitFor(() => expect(wizard.connectionFlowStatusStore.get().state).toBe('connected'));
    expect(desktop.fetchCalls).toHaveLength(1);
    expect(desktop.fetchCalls[0]!.url).toBe('https://idp.example/token');
    const body = new URLSearchParams(String(desktop.fetchCalls[0]!.init.body));
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:41420/callback');

    windowOpen.mockRestore();
  });

  it('the popup-closed poll is BYPASSED for the handle-less pseudo-popup — waiting survives arbitrary time', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    expect(wizard.connectionFlowStatusStore.get().state).toBe('awaiting_callback');

    // The web poll errors within 500ms of a closed popup; the pseudo-popup has no window
    // to observe, so NOTHING may time the wait out except the flow TTL / explicit cancel.
    vi.advanceTimersByTime(60_000);
    expect(wizard.connectionFlowStatusStore.get().state).toBe('awaiting_callback');
    vi.useRealTimers();
  });

  it('cancelConnectionOAuthFlow tears the flow down: channel closed, platform cancel called, status idle', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    expect(wizard.connectionFlowStatusStore.get().state).toBe('awaiting_callback');

    wizard.cancelConnectionOAuthFlow();

    expect(wizard.connectionFlowStatusStore.get().state).toBe('idle');
    expect(desktop.channels[0]!.closeCalls).toBeGreaterThan(0);
    expect(desktop.cancel, 'the desktop listener must be torn down with the flow').toHaveBeenCalled();
  });
});

describe('desktop OAuth — unsupported postures refuse BEFORE any credential step (Decision 5, AC6)', () => {
  it('a device-flow posture (GitHub OAuth app) sets a typed refusal and never opens anything', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    const github = lookupWellKnownProvider('GitHub')!;
    const oauthOption = (github.authOptions ?? []).find((option) => option.kind === 'oauth2_auth_code')!;
    const requirement = requirementFromRegistryEntry(github, 'GitHub', 'github', oauthOption);
    seedApproved(db, requirement as unknown as Record<string, unknown>, 'github');

    wizard.openConnectionWizard({ appId: APP, slot: 'github', source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1', client_secret: 'cs-1' });

    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('refused');
    const refusal = (status as { refusal: { providerName: string; posture: string; alternativeLabels: string[] } })
      .refusal;
    expect(refusal.providerName).toBe('GitHub');
    expect(refusal.posture).toBe('device-flow');
    // The steer: the registry's OTHER way in that DOES work here.
    expect(refusal.alternativeLabels.join(' ')).toMatch(/personal access token/i);

    expect(desktop.opened, 'no browser may open for a refused posture').toHaveLength(0);
    expect(desktop.redirectUriFor).not.toHaveBeenCalled();
    expect(desktop.fetchCalls, 'no credential POST may follow a refusal').toHaveLength(0);
  });

  it('desktopOAuthRefusalFor: https-bridge refuses on desktop, unknown providers default to loopback, web never refuses', async () => {
    const slackRequirement = {
      slot: 'slack',
      provider: { name: 'Slack' },
      kind: 'oauth2_auth_code',
      endpoints: { authorizeUrl: 'https://slack.com/oauth/v2/authorize', tokenUrl: 'https://slack.com/api/oauth.v2.access' },
      declaredApiHosts: ['slack.com'],
    };

    {
      const desktop = fakeDesktop();
      const { wizard } = await fresh(desktop.platform);
      const refusal = wizard.desktopOAuthRefusalFor(slackRequirement as never);
      expect(refusal).toMatchObject({ providerName: 'Slack', posture: 'https-bridge' });
      // Unknown provider → ephemeral loopback (RFC 8252 §7.3) → no refusal.
      expect(wizard.desktopOAuthRefusalFor(oauthRequirement as never)).toBeUndefined();
      // A static kind never refuses — postures are OAuth-only.
      expect(
        wizard.desktopOAuthRefusalFor({
          slot: 's',
          provider: { name: 'Slack' },
          kind: 'api_key',
          declaredApiHosts: ['slack.com'],
        } as never),
      ).toBeUndefined();
    }

    {
      // Web platform: the popup path handles every posture — no refusal, ever.
      const { wizard } = await fresh();
      expect(wizard.desktopOAuthRefusalFor(slackRequirement as never)).toBeUndefined();
    }
  });
});

describe('desktop OAuth — openExternal failures render DIFFERENTIATED copy (TASK-20260812-desktop-auth-awareness AC3)', () => {
  // The Spotify field defect: EVERY desktop sign-in died in openExternal (bare opener
  // capability → plugin ForbiddenUrl) and the wizard's bare `catch {}` rebranded the
  // cause as a browser failure. Three distinct failures now render three distinct
  // messages, and the flow always tears down (listener must not outlive the error).
  async function failingOpen(message: string): Promise<{ wizard: Harness['wizard']; desktop: FakeDesktop }> {
    const desktop = fakeDesktop();
    desktop.platform.oauth!.openExternal = async () => {
      throw new Error(message);
    };
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);
    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    return { wizard, desktop };
  }

  it('a port-collision rejection surfaces the transport message VERBATIM (it is user-actionable)', async () => {
    const collision =
      'could not open the sign-in listener on port 41420 — another program may be using it (EADDRINUSE)';
    const { wizard, desktop } = await failingOpen(collision);
    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('error');
    expect((status as { message: string }).message).toBe(collision);
    expect(desktop.cancel, 'the flow must tear down on an open failure').toHaveBeenCalled();
  });

  it('an opener-permission denial names Snug as the culprit, not the browser', async () => {
    const { wizard } = await failingOpen(
      'Not allowed to open url https://accounts.spotify.com/authorize?client_id=cid-1',
    );
    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('error');
    const message = (status as { message: string }).message;
    expect(message).toContain('Snug was blocked from opening your browser');
    expect(message, 'the misleading browser copy must be gone for this cause').not.toContain(
      'could not open your browser',
    );
  });

  it('a genuine browser failure keeps the browser copy and appends the underlying cause', async () => {
    const { wizard } = await failingOpen('xdg-open exited with status 4');
    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('error');
    const message = (status as { message: string }).message;
    expect(message).toContain('could not open your browser for the sign-in — try again');
    expect(message, 'the cause must no longer be swallowed').toContain('xdg-open exited with status 4');
  });
});

describe('desktop OAuth — the test hooks still win over the platform (test seam precedence)', () => {
  it('hooks.fetchImpl carries the exchange even when the platform has a fetch', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);
    const hookFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ access_token: 'at-hook', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    wizard.__setConnectionOAuthHooksForTests({ fetchImpl: hookFetch });

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('awaiting_callback');
    const flowId = (status as { flowId: string }).flowId;
    const state = new URL(desktop.opened[0]!).searchParams.get('state')!;
    desktop.channels[0]!.post({ appId: APP, flowId, code: 'c1', state });
    await vi.waitFor(() => expect(wizard.connectionFlowStatusStore.get().state).toBe('connected'));

    expect(hookFetch).toHaveBeenCalledTimes(1);
    expect(desktop.fetchCalls).toHaveLength(0);
  });
});
