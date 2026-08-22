// web-surface-seats.test.ts — TASK-20260822-gmail-dual-mode (ADR-0049).
//
// The registry gains two ENTRY-level seats that describe the WEB surface:
//
//   webRedirectPosture: 'origin-callback' — the provider's client registration can
//     accept the connecting web origin's `/oauth/callback` as an exact Authorized
//     redirect URI (a Google "Web application" client, in gmail's case).
//   webRegistration — the web-surface console walkthrough the wizard's register screen
//     renders INSTEAD of the entry's (desktop) walkthrough when the runtime has no
//     desktop OAuth capability.
//
// Both are RENDER-TIME registry data in exactly the class ADR-0021 §1 defines for
// `desktopRedirectPosture`: resolved at wizard render time via the registry lookup,
// NEVER emitted into a `ConnectionRequirement`, never persisted. That non-emission is
// what keeps this change protocol-free and drift-free — admission re-substitution of an
// approved gmail row stays byte-identical, so the drift gate answers 'none'.
//
// Why NOT a `WellKnownAuthOption` (the rejected first design, ADR-0049 alternatives):
// options are discriminated BY KIND (`matchedRegistryOption`), and a web flow shares
// `oauth2_auth_code` with the entry — a same-kind option is invisible to every
// option-matching consumer, inherits the entry's loopback posture through
// `resolveDesktopPosture`'s `?? entry` fallback, and seeds the chat AuthChoiceCard on
// every surface. Entry-level seats dissolve all of that by construction.

import { describe, expect, it } from 'vitest';
import type { Oauth2AuthCodeSpec } from '@snugprotocol/protocol';
import { UserDbCredentialStore } from '../credential-store.js';
import { OAuthService } from '../oauth-service.js';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
} from '../well-known-providers.js';

// ------------------------------------------------------------ registry seats

const WEB_POSTURES = ['origin-callback'] as const;

describe('web-surface seats — gmail declares the Web-application path (ADR-0049 §1/§4)', () => {
  const gmail = WELL_KNOWN_PROVIDERS_REGISTRY['gmail'];

  it("gmail: webRedirectPosture is 'origin-callback'", () => {
    expect(gmail).toBeDefined();
    expect(gmail?.webRedirectPosture).toBe('origin-callback');
  });

  it('gmail: browserCallable is true — the Gmail REST API is CORS-open (probed 2026-08-21)', () => {
    // The exact-table half of this fact lives in desktop-posture.test.ts's
    // BROWSER_CALLABLE table; this assertion keeps the two suites honest together.
    expect(gmail?.browserCallable).toBe(true);
  });

  it('gmail: webRegistration is a complete wizard-grade walkthrough for the WEB client type', () => {
    const registration = gmail?.webRegistration;
    expect(registration).toBeDefined();
    expect(registration?.consoleUrl).toMatch(/^https:\/\//);
    const steps = registration?.instructions ?? [];
    expect(steps.length).toBeGreaterThanOrEqual(5);
    const all = steps.join('\n');
    // The client type is the whole point of the second walkthrough.
    expect(all).toContain('"Web application"');
    // The user must paste the wizard-displayed exact redirect URI into the client.
    expect(all.toLowerCase()).toContain('redirect uri');
    // Provider traps disclosed, not discovered (Spotify precedent; same two traps as
    // the desktop walkthrough — they are properties of the Google project, not of the
    // client type):
    expect(all).toContain('unverified');
    expect(all).toContain('7 days');
    expect(all).toContain('Publish app');
    // ADR-0049 §4: one active client pair per app+slot — a web sign-in replaces a
    // desktop sign-in held in the SAME portable file. Disclosed here, pinned below.
    expect(all.toLowerCase()).toContain('replaces');
  });

  it('gmail: the web walkthrough never asks the user to skip the secret — the Web client secret is REQUIRED', () => {
    // Guard against copy drift toward the Spotify "leave the client secret alone"
    // phrasing: Google refuses a Web-application code exchange without the secret even
    // with PKCE (research verdict 2026-08-21, next-steps).
    const all = (gmail?.webRegistration?.instructions ?? []).join('\n');
    expect(all).toContain('Client secret');
  });
});

describe('web-surface seats — structural rules over the whole registry', () => {
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    it(`${key}: web seats are coherent, oauth-only, and entry-level`, () => {
      // webRegistration without webRedirectPosture is a walkthrough for a transport the
      // registry never vouched for — refuse the combination structurally.
      if (entry.webRegistration !== undefined) {
        expect(entry.webRedirectPosture, `${key}: webRegistration requires webRedirectPosture`).toBeDefined();
      }
      if (entry.webRedirectPosture !== undefined) {
        expect(WEB_POSTURES).toContain(entry.webRedirectPosture);
        // The seat describes an OAuth redirect; a static-kind entry has no redirect at all.
        expect(entry.kind, `${key}: webRedirectPosture is only meaningful on an OAuth entry`).toBe(
          'oauth2_auth_code',
        );
        // A web posture without a web walkthrough would leave the register screen
        // rendering DESKTOP instructions for a client type they do not describe.
        expect(entry.webRegistration, `${key}: webRedirectPosture requires webRegistration`).toBeDefined();
      }
      // ENTRY-level only, same rule (and same reason) as browserCallable/apiHosts: the
      // rejected option-vehicle design is structurally banned, not just unadopted.
      for (const option of entry.authOptions ?? []) {
        expect(option).not.toHaveProperty('webRedirectPosture');
        expect(option).not.toHaveProperty('webRegistration');
      }
    });
  }
});

// -------------------------------------------------- never a requirement seat

describe('web-surface seats — NEVER emitted into a ConnectionRequirement (ADR-0021 §1)', () => {
  it('the gmail requirement carries neither web seat — and the entry genuinely has both, so this is not vacuous', () => {
    const entry = lookupWellKnownProvider('gmail');
    expect(entry).toBeDefined();
    // Non-vacuity: the seats exist on the entry...
    expect(entry?.webRedirectPosture).toBeDefined();
    expect(entry?.webRegistration).toBeDefined();
    // ...and the emitter must not copy them: the requirement is the PERSISTED,
    // approved shape, and a surface fact resolved at render time must never be frozen
    // into a portable file (that is finding 3 of the plan review, closed structurally).
    const requirement = requirementFromRegistryEntry(entry!, 'gmail', 'primary');
    expect(requirement).not.toHaveProperty('webRedirectPosture');
    expect(requirement).not.toHaveProperty('webRegistration');
    // The DESKTOP registration still rides — today's behavior, unchanged.
    expect(requirement.registration?.instructions?.join('\n')).toContain('"Desktop app"');
  });
});

// ------------------------------------------- dual-surface credential custody

const APP = 'app-gmail';

function memoryQuartet(): {
  getSecret(key: string): string | undefined;
  setSecret(key: string, value: string): void;
  deleteSecret(key: string): void;
  listSecretKeys(): string[];
} {
  const map = new Map<string, string>();
  return {
    getSecret: (key) => map.get(key),
    setSecret: (key, value) => void map.set(key, value),
    deleteSecret: (key) => void map.delete(key),
    listSecretKeys: () => [...map.keys()].sort(),
  };
}

const gmailEntry = WELL_KNOWN_PROVIDERS_REGISTRY['gmail']!;

/** The gmail spec as the wizard would mint it — endpoints/scopes from the entry. */
const gmailSpec: Oauth2AuthCodeSpec = {
  kind: 'oauth2_auth_code',
  provider: { name: 'Gmail' },
  endpoints: { ...gmailEntry.endpoints! },
  scopes: [...(gmailEntry.scopes ?? [])],
  pkce: true,
  clientCreds: [
    { key: 'client_id', label: 'Client ID', type: 'text' },
    { key: 'client_secret', label: 'Client secret', type: 'secret' },
  ],
  declaredApiHosts: [...(gmailEntry.apiHosts ?? [])],
};

const GMAIL_ALLOWED = ['accounts.google.com', 'oauth2.googleapis.com', 'gmail.googleapis.com'];

describe('dual-surface custody — one active client pair per app+slot (ADR-0049 §4, review finding 6)', () => {
  it('starting a NEW flow with different pasted creds OVERWRITES the stored pair while the old refresh_token remains', async () => {
    // This pins the ACCEPTED model, not a defect: a user who registered a Desktop-app
    // client and a Web-application client (two registrations, per the task interview)
    // holds ONE storage cell per app+slot. An ABANDONED start on the second surface
    // leaves the first surface's refresh_token beside the second's client pair — the
    // next refresh fails until a sign-in completes. The web walkthrough discloses it
    // (asserted above: 'replaces'); this test makes the mechanism visible so a future
    // per-surface-cell design has a red assertion to flip rather than a surprise.
    const store = new UserDbCredentialStore(memoryQuartet());
    const service = new OAuthService({
      store,
      redirectUriProvider: { redirectUri: () => 'https://play.example/oauth/callback' },
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    } as never);

    // Surface A (desktop) connected: client pair A + its refresh token.
    await store.setCredential(APP, 'client_id', 'desktop-client-id.apps.googleusercontent.com');
    await store.setCredential(APP, 'client_secret', 'GOCSPX-desktop-secret');
    await store.setCredential(APP, 'refresh_token', 'RT-from-desktop-client');
    await store.setConnectionState(APP, { status: 'connected', obtainedAt: Date.now(), expiresIn: 3600 });

    // Surface B (web) starts — and is then abandoned before the callback.
    await service.generateAuthUrl({
      appId: APP,
      spec: gmailSpec,
      clientCreds: {
        client_id: 'web-client-id.apps.googleusercontent.com',
        client_secret: 'GOCSPX-web-secret',
      },
    });

    expect(await store.getCredential(APP, 'client_id')).toBe('web-client-id.apps.googleusercontent.com');
    expect(await store.getCredential(APP, 'client_secret')).toBe('GOCSPX-web-secret');
    // The old token survives the overwrite — mismatched with the new pair, which is
    // exactly the state the walkthrough's disclosure describes.
    expect(await store.getCredential(APP, 'refresh_token')).toBe('RT-from-desktop-client');
  });
});

// ------------------------------------------------- the web exchange, C1-tight

describe('the web code exchange — client_secret rides ONLY the form body, and never rides back out (C1)', () => {
  // The secret deliberately contains characters whose wire spelling differs under the
  // form serializer (URLSearchParams encodes ' ' as '+', and '+'/'/'/'=' as percent
  // escapes). Lesson 2026-08-21: a fixture that cannot EXPRESS the leak is zero
  // coverage wearing a green tick — and the serializer must be the one that writes the
  // request (URLSearchParams), NOT encodeURIComponent (they disagree on space).
  const WEB_SECRET = 'GOCSPX-web secret+with/tricky=chars==';
  const wireSecret = new URLSearchParams({ v: WEB_SECRET }).toString().slice(2);

  it('precondition: the fixture secret really has two spellings', () => {
    expect(wireSecret).not.toBe(WEB_SECRET);
  });

  async function runExchange(errorBody?: string): Promise<{
    thrown: string;
    lastError: string;
    tokenCall: { url: string; body: URLSearchParams } | undefined;
    authorizeUrl: string;
  }> {
    const store = new UserDbCredentialStore(memoryQuartet());
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const service = new OAuthService({
      store,
      // The web seam: both legs derive the SAME origin-literal callback.
      redirectUriProvider: { redirectUri: () => 'https://play.example/oauth/callback' },
      fetch: (input: string, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body ?? ''));
        calls.push({ url: input, body });
        if (errorBody !== undefined) {
          return Promise.resolve(new Response(errorBody, { status: 400 }));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'A', refresh_token: 'R', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        );
      },
    } as never);

    const startResult = await service.generateAuthUrl({
      appId: APP,
      spec: gmailSpec,
      clientCreds: { client_id: 'web-client-id.apps.googleusercontent.com', client_secret: WEB_SECRET },
    });

    let thrown = '';
    try {
      await service.handleCallback({
        appId: APP,
        code: 'AUTH_CODE_FROM_GOOGLE',
        state: startResult.state,
        expectedFlowId: startResult.flowId,
        spec: gmailSpec,
        allowedHosts: GMAIL_ALLOWED,
      });
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    const connection = await store.getConnectionState(APP);
    return {
      thrown,
      lastError: connection?.lastError ?? '',
      tokenCall: calls.find((call) => call.body.get('grant_type') === 'authorization_code'),
      authorizeUrl: startResult.authorizeUrl,
    };
  }

  it('sends the secret in the exchange form body to the token endpoint — the web path needs no service change', async () => {
    const { tokenCall, authorizeUrl } = await runExchange();
    expect(tokenCall, 'the exchange must reach the token endpoint').toBeDefined();
    expect(tokenCall?.url).toBe(gmailEntry.endpoints!.tokenUrl);
    expect(tokenCall?.body.get('client_secret')).toBe(WEB_SECRET);
    expect(tokenCall?.body.get('redirect_uri')).toBe('https://play.example/oauth/callback');
    // The authorize leg derived the SAME redirect — byte-identity across legs is the
    // provider's matching rule, and the one seam is what guarantees it.
    expect(authorizeUrl).toContain(new URLSearchParams({ v: 'https://play.example/oauth/callback' }).toString().slice(2));
    // The secret never rides the authorize URL — that URL opens in a popup/browser bar.
    expect(authorizeUrl).not.toContain(wireSecret);
    expect(authorizeUrl).not.toContain(WEB_SECRET);
  });

  it('a token endpoint that ECHOES the wire-encoded secret leaks neither spelling — thrown message AND persisted lastError', async () => {
    const { thrown, lastError } = await runExchange(
      JSON.stringify({ error: 'invalid_client', error_description: `bad client secret ${wireSecret}` }),
    );
    // The surfaced strings are the ones that ride to the iframe and the LLM
    // (NET_AUTH_FAILED prose; lesson 2026-08-20: assert the field that would carry the
    // leak, not only the one that carries the verdict).
    expect(thrown).not.toContain(WEB_SECRET);
    expect(thrown).not.toContain(wireSecret);
    expect(lastError).not.toContain(WEB_SECRET);
    expect(lastError).not.toContain(wireSecret);
    // Not vacuous: the failure still surfaces as a diagnosis.
    expect(thrown.length).toBeGreaterThan(0);
    expect(thrown).toContain('bad client secret');
  });
});
