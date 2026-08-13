// Desktop OAuth lifecycle + the loopback⇒PKCE flow gate (TASK-20260812 whole-surface
// review findings A/B/C). These are the three MAJOR defects the fresh-context review
// confirmed, each with an independent refuter:
//
//   A — `platformOauth.cancel()` was reachable ONLY through `teardownFlow`'s
//       activeFlow-guarded body, but `redirectUriFor` binds/records BEFORE any
//       activeFlow exists (register-screen render, and generateAuthUrl's own call).
//       Every exit in that window leaked the platform's pending flow into the NEXT
//       wizard session.
//   B — the teardown immediately before `activeFlow = …` is a GLOBAL desktop cancel:
//       two overlapping starts kill each other's channel and listener, and the wizard
//       parks on 'awaiting_callback' forever.
//   C — the loopback⇒PKCE rule was a REGISTRY structural test only, so an unknown
//       provider (registry default posture 'loopback') carrying `pkce: false` ran a
//       loopback flow with no PKCE — the auth-code-injection attack ADR-0021 §2 calls
//       undefendable without provider-side challenge binding.
//
// Platform is set-once per module registry, so each case takes a fresh one.
import { describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

const APP = 'app-desktop-lifecycle';
const SLOT = 'fake-idp';

/** Unknown-to-the-registry provider — resolves to the ephemeral 'loopback' default. */
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

/** The SAME unknown provider, but asking to skip PKCE — finding C's exact shape. */
const noPkceRequirement = {
  ...oauthRequirement,
  pkce: false,
} as const satisfies Record<string, unknown>;

interface FakeChannel {
  flowId: string;
  onmessage: ((event: { data: unknown }) => void) | null;
  closed: boolean;
  /** The platform dropped this channel from its map — a real callback can no longer reach it. */
  orphaned: boolean;
  close(): void;
  post(data: unknown): void;
}

interface FakeDesktop {
  platform: SnugPlatform;
  opened: string[];
  channels: FakeChannel[];
  cancelCalls: Array<string | undefined>;
  redirectUriFor: ReturnType<typeof vi.fn>;
  /** Resolve gate for openExternal, so a second start can interleave mid-open. */
  holdOpen(): () => void;
}

function fakeDesktop(): FakeDesktop {
  const opened: string[] = [];
  const channels: FakeChannel[] = [];
  const cancelCalls: Array<string | undefined> = [];
  let gate: Promise<void> | null = null;

  const redirectUriFor = vi.fn(async () => 'http://127.0.0.1:41420/callback');

  const platform: SnugPlatform = {
    kind: 'desktop',
    fetchImpl: async () =>
      new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    oauth: {
      redirectUriFor,
      openExternal: async (url) => {
        // One-shot: only the NEXT openExternal after holdOpen() is held, so a test can
        // pin one call inside the opener while a second start runs to completion.
        const held = gate;
        gate = null;
        if (held !== null) await held;
        opened.push(url);
      },
      channelFor: (flowId) => {
        const channel: FakeChannel = {
          flowId,
          onmessage: null,
          closed: false,
          orphaned: false,
          close() {
            channel.closed = true;
          },
          post(data: unknown) {
            // An orphaned channel is unreachable from the listener — the real platform
            // looks the flowId up in its map, and a cleared map delivers to nobody.
            if (channel.orphaned || channel.closed) return;
            channel.onmessage?.({ data });
          },
        };
        channels.push(channel);
        return channel;
      },
      /**
       * FAITHFUL to platform-desktop.ts: a cancel with no flowId is GLOBAL — it clears
       * the whole channel map and stops the live listener. Modelling that is the whole
       * point of finding B: a global cancel fired from the second start's teardown is
       * what kills the flow that just won.
       */
      cancel: async (flowId?: string) => {
        cancelCalls.push(flowId);
        if (flowId === undefined) {
          for (const channel of channels) channel.orphaned = true;
        } else {
          const one = channels.find((channel) => channel.flowId === flowId);
          if (one !== undefined) one.orphaned = true;
        }
      },
    },
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };

  return {
    platform,
    opened,
    channels,
    cancelCalls,
    redirectUriFor,
    holdOpen() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
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

// ---------------------------------------------------------------------------
// FINDING A — the platform's pending flow must never outlive a wizard session
// ---------------------------------------------------------------------------

describe('finding A — teardown cancels the PLATFORM flow even when no activeFlow exists', () => {
  it('forceCloseWizard after a register-screen redirectUriFor still cancels the platform (no leak into the next session)', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    // What the register screen does: ask for the display URI. On an ephemeral posture
    // this BINDS a real listener in the platform — with no activeFlow anywhere yet.
    await desktop.platform.oauth!.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });

    // The user closes the wizard without ever starting the flow. Count the cancels the
    // CLOSE itself causes — cancel is idempotent and other lifecycle points call it too,
    // so a delta is the honest measurement, not an absolute total.
    const before = desktop.cancelCalls.length;
    wizard.forceCloseWizard();

    expect(
      desktop.cancelCalls.length - before,
      'the platform bound a listener before any activeFlow existed — closing must cancel it',
    ).toBeGreaterThan(0);
    expect(desktop.cancelCalls.at(-1), 'a dismissal is a GLOBAL teardown, not flow-scoped').toBeUndefined();
  });

  it('cancelConnectionOAuthFlow with no activeFlow still cancels the platform', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await desktop.platform.oauth!.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    const before = desktop.cancelCalls.length;
    wizard.cancelConnectionOAuthFlow();

    expect(desktop.cancelCalls.length - before).toBeGreaterThan(0);
  });

  it('a failed openExternal cancels the platform flow rather than stranding a bound listener', async () => {
    const desktop = fakeDesktop();
    const failing: SnugPlatform = {
      ...desktop.platform,
      oauth: {
        ...desktop.platform.oauth!,
        openExternal: async () => {
          throw new Error('no browser');
        },
      },
    };
    const { db, wizard } = await fresh(failing);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });

    expect(wizard.connectionFlowStatusStore.get().state).toBe('error');
    // The failing start knows its own flowId, so its cleanup is FLOW-SCOPED — it must not
    // reach past its own flow (finding B's rule applied to finding A's fix).
    expect(
      desktop.cancelCalls.some((flowId) => typeof flowId === 'string'),
      'openExternal threw AFTER the listener bound — the flow must be cancelled, not left listening',
    ).toBe(true);
  });

  it('a session closed mid-start (the stale bail after openExternal) cancels the platform flow', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    const release = desktop.holdOpen();
    const started = wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    // Let the mint finish so the start is genuinely PARKED INSIDE the OS opener — that is
    // the window the review named: the listener is bound and the flowId exists, but no
    // activeFlow has been assigned yet.
    await vi.waitFor(() => expect(desktop.channels).toHaveLength(1));

    // The user dismisses the wizard while the opener is still resolving.
    const before = desktop.cancelCalls.length;
    wizard.forceCloseWizard();
    release();
    await started;

    expect(wizard.connectionFlowStatusStore.get().state).not.toBe('awaiting_callback');
    // The dismissal's own global cancel plus the start's flow-scoped bail: either way the
    // listener the platform bound must not survive a session that no longer exists.
    expect(desktop.cancelCalls.length - before, 'the stale bail must not strand the bound listener').toBeGreaterThan(0);
    expect(
      desktop.cancelCalls.slice(before).some((flowId) => typeof flowId === 'string'),
      'the bail knows its own flowId, so its cleanup is flow-scoped',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FINDING B — two overlapping starts must not kill each other
// ---------------------------------------------------------------------------

describe('finding B — a double-start leaves exactly one LIVE flow, never zero', () => {
  it('two overlapping startConnectionOAuthFlow calls end with a deliverable flow', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });

    // The user double-clicks "sign in": the button stays live across the mint +
    // openExternal window, so both calls observe activeFlow === null at entry.
    // The gate makes the OVERLAP deterministic — call 1 is held inside openExternal
    // while call 2 runs to completion and installs its flow, then call 1 resumes and
    // reaches its own pre-assignment teardown. That is the exact ordering the review
    // named: a GLOBAL desktop cancel there wipes the flow that just won.
    const release1 = desktop.holdOpen();
    const first = wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    await Promise.resolve();
    const second = wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });
    await second;
    release1();
    await first;

    const status = wizard.connectionFlowStatusStore.get();
    expect(status.state).toBe('awaiting_callback');
    const flowId = (status as { flowId: string }).flowId;

    // The surviving flow's channel must still be subscribed — pre-fix the global
    // cancel cleared the platform's channel map and the wizard hung forever.
    const live = desktop.channels.find((channel) => channel.flowId === flowId);
    expect(live, 'the winning flow must still have a channel').toBeDefined();
    expect(live!.closed, 'the winning flow’s channel must not have been closed').toBe(false);
    expect(
      live!.orphaned,
      'a GLOBAL platform cancel from the loser’s teardown must not orphan the winner’s channel',
    ).toBe(false);

    // And a real delivery on that flow must complete the exchange.
    const authorizeUrl = desktop.opened.map((url) => new URL(url)).find((url) => url.searchParams.get('state') !== null);
    expect(authorizeUrl).toBeDefined();
    const matching = desktop.opened
      .map((url) => new URL(url))
      .find((url) => {
        const state = url.searchParams.get('state');
        if (state === null) return false;
        try {
          const payload = JSON.parse(atob(state.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
            flowId?: string;
          };
          return payload.flowId === flowId;
        } catch {
          return false;
        }
      });
    expect(matching, 'the surviving flow’s authorize URL must have been opened').toBeDefined();
    live!.post({ appId: APP, flowId, code: 'auth-code-1', state: matching!.searchParams.get('state')! });
    await vi.waitFor(() => expect(wizard.connectionFlowStatusStore.get().state).toBe('connected'));
  });
});

// ---------------------------------------------------------------------------
// FINDING C — loopback ⇒ PKCE, enforced at the FLOW gate (not just the registry)
// ---------------------------------------------------------------------------

describe('finding C — a loopback flow with pkce:false is refused before anything binds', () => {
  it('desktopOAuthRefusalFor refuses an unknown provider that declares pkce:false', async () => {
    const desktop = fakeDesktop();
    const { wizard } = await fresh(desktop.platform);

    const refusal = wizard.desktopOAuthRefusalFor(noPkceRequirement as never);
    expect(refusal, 'loopback + pkce:false is the undefendable auth-code-injection shape').toBeDefined();
    expect(refusal!.providerName).toBe('Fake IdP');
    // Honest plain-language copy — the reason is the SKIPPED SECURITY STEP, not a posture.
    expect(refusal!.reason).toBe('pkce-required');
  });

  it('the flow gate refuses BEFORE a listener binds or a credential is stored', async () => {
    const desktop = fakeDesktop();
    const { db, wizard } = await fresh(desktop.platform);
    seedApproved(db, noPkceRequirement as unknown as Record<string, unknown>);

    wizard.openConnectionWizard({ appId: APP, slot: SLOT, source: 'settings' });
    await wizard.startConnectionOAuthFlow({ client_id: 'cid-1' });

    expect(wizard.connectionFlowStatusStore.get().state).toBe('refused');
    expect(desktop.redirectUriFor, 'no listener may bind for a refused flow').not.toHaveBeenCalled();
    expect(desktop.opened, 'no browser may open for a refused flow').toHaveLength(0);
  });

  it('pkce undefined (the S256 default) and pkce:true both proceed', async () => {
    {
      const desktop = fakeDesktop();
      const { wizard } = await fresh(desktop.platform);
      expect(wizard.desktopOAuthRefusalFor(oauthRequirement as never)).toBeUndefined();
    }
    {
      const desktop = fakeDesktop();
      const { wizard } = await fresh(desktop.platform);
      const { pkce: _pkce, ...withoutPkce } = oauthRequirement;
      expect(wizard.desktopOAuthRefusalFor(withoutPkce as never)).toBeUndefined();
    }
  });

  it('web is untouched — the popup path handles pkce:false exactly as before', async () => {
    const { wizard } = await fresh();
    expect(wizard.desktopOAuthRefusalFor(noPkceRequirement as never)).toBeUndefined();
  });
});
