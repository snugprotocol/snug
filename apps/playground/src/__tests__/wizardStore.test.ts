// AL-04 — the singleton wizardStore (plan D5/D9): one wizard at a time, promise of a
// visible refusal on a second open (R2/M28), the HOST-side ladder re-run at the
// directive mount (B2/AC13 — mutations M15/M16), store-owned OAuth flow state +
// channel listener that survive view unmount (M9/M23), dismiss-confirm while a flow
// is in flight (M9), and the code-keyed error→CTA mapping (D7/N1 — M25/M26).
import { PROTOCOL_VERSION, NET_ERROR_CODES, type AuthWizardDirective } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetWizardStateForTests,
  __setWizardHooksForTests,
  applyInferenceResult,
  docsTripwire,
  forceCloseWizard,
  netErrorCta,
  openWizard,
  openWizardForNetError,
  requestCloseWizard,
  resolveWizardIntent,
  startOAuthFlow,
  wizardCloseConfirmStore,
  wizardFlowStatusStore,
  wizardNoteStore,
  wizardStore,
  type WizardChannelLike,
} from '../state/wizard.js';
import { installTestUserDb } from './userdbTestHelper.js';
import { getUserDb } from '../state/userdb.js';

const APP = 'app-wiz';

const directiveFor = (proposal: AuthWizardDirective['proposal'], display: Partial<AuthWizardDirective> = {}): AuthWizardDirective => ({
  v: PROTOCOL_VERSION,
  kind: 'auth_wizard',
  proposal,
  ...display,
});

/** A poisoned directive: claims registry provenance + full confidence for Spotify with evil endpoints. */
const poisonedSpotify = directiveFor(
  {
    providerName: 'Spotify',
    kindHint: 'oauth2_auth_code',
    endpoints: {
      authorizeUrl: 'https://accounts.evil.example/authorize',
      tokenUrl: 'https://accounts.evil.example/api/token',
    },
    declaredApiHosts: ['api.evil.example'],
  },
  { provenance: 'registry', confidence: 1.0 },
);

beforeEach(async () => {
  await installTestUserDb();
  __resetWizardStateForTests();
});
afterEach(() => {
  __resetWizardStateForTests();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('R2 — singleton wizard (mutation M28)', () => {
  it('a second openWizard while one is parked is REFUSED with a visible note; the first session survives', () => {
    expect(openWizard({ source: 'settings', appId: APP, mode: 'connect' })).toBe(true);
    const first = wizardStore.get();
    expect(first?.appId).toBe(APP);

    expect(openWizard({ source: 'settings', appId: 'app-other', mode: 'connect' })).toBe(false);
    expect(wizardStore.get()).toBe(first); // NOT silently replaced
    expect(wizardNoteStore.get()).toMatch(/already open/i);
  });

  it('card-open-then-settings-open: a directive open is refused the same way', () => {
    expect(openWizard({ source: 'settings', appId: APP, mode: 'connect' })).toBe(true);
    const refused = openWizard({
      source: 'directive',
      appId: 'app-other',
      directive: directiveFor({ providerName: 'Acme Weather', kindHint: 'api_key' }),
    });
    expect(refused).toBe(false);
    expect(wizardStore.get()?.appId).toBe(APP);
  });
});

describe('B2/AC13 — host-side ladder re-run at the directive mount', () => {
  it('wizard.directive-registry-claim-discarded — registry values win over poisoned directive hints (M15)', () => {
    const session = resolveWizardIntent(APP, poisonedSpotify);
    expect(session.provenance).toBe('registry');
    // The directive's endpoints/hints are DISCARDED: only identity survives the hit.
    expect(JSON.stringify(session.proposal)).not.toContain('evil.example');
    expect(session.proposal?.endpoints).toBeUndefined();
    expect(session.proposal?.declaredApiHosts).toBeUndefined();
    expect(session.proposal?.providerName).toBe('Spotify');
  });

  it('wizard.provenance-host-computed — a directive cannot claim its way onto the light path (M16)', () => {
    const claiming = directiveFor(
      { providerName: 'Totally Unknown Corp', kindHint: 'api_key', declaredApiHosts: ['api.unknown.example'] },
      { provenance: 'registry', confidence: 1.0 },
    );
    const session = resolveWizardIntent(APP, claiming);
    // Registry miss ⇒ HOST computes 'inference' — the claim is display-only.
    expect(session.provenance).toBe('inference');
    expect(session.directiveDisplay?.provenance).toBe('registry');
    expect(session.directiveDisplay?.confidence).toBe(1.0);
    // And the gate value is not the display value: confidence on the SESSION stays unset
    // until a real inference runs.
    expect(session.confidence).toBeUndefined();
  });

  it('an unknown-provider directive keeps its hints as reviewable inference-grade proposal', () => {
    const directive = directiveFor({ providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme.example'] });
    const session = resolveWizardIntent(APP, directive);
    expect(session.provenance).toBe('inference');
    expect(session.proposal?.declaredApiHosts).toEqual(['api.acme.example']);
  });
});

describe('M9/M23 — store-owned flow state + listener survive view unmount', () => {
  function fakeChannel(): WizardChannelLike & { post(data: unknown): void } {
    const channel: WizardChannelLike & { post(data: unknown): void } = {
      onmessage: null,
      close: vi.fn(),
      post(data: unknown) {
        channel.onmessage?.({ data });
      },
    };
    return channel;
  }

  async function seedApprovedOAuthRow(): Promise<void> {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Wiz App', html: '<p>x</p>' });
    db.putAuthSpec(APP, {
      kind: 'oauth2_auth_code',
      provider: { name: 'Fake IdP' },
      endpoints: { authorizeUrl: 'https://idp.example/authorize', tokenUrl: 'https://idp.example/token' },
      pkce: true,
      clientCreds: [
        { key: 'client_id', label: 'Client ID', type: 'text' },
        { key: 'client_secret', label: 'Client Secret', type: 'secret' },
      ],
      declaredApiHosts: ['api.fake-idp.example'],
    });
    db.approveAuthSpec(APP);
  }

  it('navigate-away-mid-flow: the BroadcastChannel listener is store-owned — a view unmount cannot kill it (M23)', async () => {
    await seedApprovedOAuthRow();
    const channel = fakeChannel();
    const channelFactory = vi.fn(() => channel);
    const handleCallback = vi.fn(async () => ({ appId: APP, flowId: 'ignored' }));
    __setWizardHooksForTests({
      channelFactory,
      openPopup: () => ({ closed: false }),
      service: {
        generateAuthUrl: async () => ({ authorizeUrl: 'https://idp.example/authorize?x=1', state: 's', flowId: 'flow-1' }),
        handleCallback,
      },
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await startOAuthFlow({ client_id: 'abc' });
    expect(channelFactory).toHaveBeenCalledWith('snug-oauth-flow-1'); // channel named by the flowId (D6)

    // No component holds the listener: nothing to unmount. Deliver after "navigation".
    channel.post({ appId: APP, flowId: 'flow-1', code: 'the-code', state: 'the-state' });
    await vi.waitFor(() => expect(handleCallback).toHaveBeenCalledTimes(1));
    // AC6: expectedFlowId comes from the STORE's held start result, never the payload.
    expect(handleCallback.mock.calls[0]![0]).toMatchObject({ expectedFlowId: 'flow-1', code: 'the-code' });
  });

  it('dismiss-confirm: closing while a flow is in flight demands confirmation (M9)', async () => {
    await seedApprovedOAuthRow();
    __setWizardHooksForTests({
      channelFactory: () => fakeChannel(),
      openPopup: () => ({ closed: false }),
      service: {
        generateAuthUrl: async () => ({ authorizeUrl: 'https://idp.example/a', state: 's', flowId: 'flow-2' }),
        handleCallback: vi.fn(async () => ({ appId: APP, flowId: 'flow-2' })),
      },
    });
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    await startOAuthFlow({ client_id: 'abc' });

    expect(requestCloseWizard()).toBe('needs_confirm');
    expect(wizardStore.get()).not.toBeNull(); // one stray Esc discards nothing
    expect(wizardCloseConfirmStore.get()).toBe(true);

    forceCloseWizard(); // the explicit "close anyway"
    expect(wizardStore.get()).toBeNull();
    expect(wizardFlowStatusStore.get().state).toBe('idle');
  });

  it('without a flow in flight, close is immediate', () => {
    openWizard({ source: 'settings', appId: APP, mode: 'connect' });
    expect(requestCloseWizard()).toBe('closed');
    expect(wizardStore.get()).toBeNull();
  });
});

describe('D7/N1 — code-keyed error→CTA mapping (M25/M26)', () => {
  it('ALL NET_AUTH_FAILED and NET_NOT_APPROVED map to the connect CTA — code alone, generic message irrelevant', () => {
    expect(netErrorCta(NET_ERROR_CODES.NET_AUTH_FAILED)).toBe('connect');
    expect(netErrorCta(NET_ERROR_CODES.NET_NOT_APPROVED)).toBe('connect');
    expect(netErrorCta(NET_ERROR_CODES.NET_IMPORTED_UNAPPROVED)).toBe('reapprove');
  });

  it('the mapping consults ONLY the code — openWizardForNetError opens for an auth code with any message (M26)', () => {
    expect(openWizardForNetError(APP, NET_ERROR_CODES.NET_AUTH_FAILED)).toBe(true);
    expect(wizardStore.get()?.mode).toBe('connect');
  });

  it('NET_HOST_BLOCKED / NET_SSRF_BLOCKED / NET_CONFIRM_DENIED NEVER open the wizard (M12/M25)', () => {
    for (const code of [
      NET_ERROR_CODES.NET_HOST_BLOCKED,
      NET_ERROR_CODES.NET_SSRF_BLOCKED,
      NET_ERROR_CODES.NET_CONFIRM_DENIED,
      NET_ERROR_CODES.NET_SCHEME_BLOCKED,
      NET_ERROR_CODES.NET_REDIRECT_BLOCKED,
      NET_ERROR_CODES.NET_SIZE_EXCEEDED,
      NET_ERROR_CODES.NET_FETCH_FAILED,
    ]) {
      expect(netErrorCta(code), code).toBeNull();
      expect(openWizardForNetError(APP, code), code).toBe(false);
      expect(wizardStore.get(), code).toBeNull();
    }
  });
});

describe('D10/M2 — the paste-box credential tripwire (M19)', () => {
  it('flags common key shapes and high-entropy tokens', () => {
    expect(docsTripwire('curl -H "Authorization: Bearer sk-live-abcdef1234567890"')).toBe(true);
    expect(docsTripwire('AKIAIOSFODNN7EXAMPLE7 is your access key id')).toBe(true);
    expect(docsTripwire('ghp_abcdefghijklmnop1234567890abcdef')).toBe(true);
    expect(docsTripwire('token: dGhpc0lzQVZlcnlMb25nSGlnaEVudHJvcHlUb2tlbjEyMzQ1Ng')).toBe(true);
  });

  it('leaves ordinary API documentation alone', () => {
    expect(docsTripwire('Pass your API key in the X-Api-Key header. Requests go to https://api.example.com/v2.')).toBe(false);
    expect(docsTripwire('OAuth 2.0 with PKCE is supported; scopes are space-separated.')).toBe(false);
  });
});

describe('M11 — a failed inference leaves the confirm EMPTY (applyInferenceResult)', () => {
  it('an error result wipes proposal/evidence/confidence and records only the typed message', () => {
    openWizard({
      source: 'directive',
      appId: APP,
      directive: directiveFor({ providerName: 'Acme Weather', kindHint: 'api_key', declaredApiHosts: ['api.acme.example'] }),
    });
    applyInferenceResult({ ok: false, provenance: 'user_docs', code: 'reply_invalid', message: 'the model reply failed the output contract' });
    const session = wizardStore.get();
    expect(session?.proposal).toBeUndefined(); // nothing prefilled
    expect(session?.evidence).toEqual([]);
    expect(session?.confidence).toBeUndefined();
    expect(session?.provenance).toBe('user_docs'); // still the forced-confirm grade
    expect(session?.reason).toMatch(/output contract/);
  });
});
