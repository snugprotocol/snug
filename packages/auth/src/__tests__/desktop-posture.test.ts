// desktop-posture.test.ts — TASK-20260812-desktop-hub-scaffold, P1 (registry desktop
// redirect postures; plan decision 1 + P0 amendment 2).
//
// The desktop shell cannot use the web's `${origin}/oauth/callback` redirect: each
// provider dictates which desktop redirect transport it accepts (RFC 8252's ladder),
// and provider capability differences are REVIEWED REGISTRY DATA in this repo — the
// registry is the authority, the wizard only renders what it says. These tests pin
// three distinct things:
//
//  1. COMPLETENESS — every OAuth-capable flow (entry default or chosen option) resolves
//     to a posture. A missing posture is not a soft default: it is the wizard having
//     nothing to render and failing MID-FLOW instead of refusing honestly up front
//     (AC6's whole point).
//
//  2. THE SECURITY RULE (P0 amendment 2) — a loopback-class posture REQUIRES PKCE at
//     the flow seat that owns the flow. On a shared machine, any local process can race
//     the loopback redirect and deliver its OWN authorization code with the VALID state
//     (the state is public in the authorize URL, visible in argv/`ps`). The only thing
//     that makes the injected code worthless is the provider binding the code to the
//     initiator's PKCE verifier. `pkce:false` + loopback is therefore an UNDEFENDABLE
//     combination and must be unrepresentable in shipped data. `undefined` passes — the
//     transformer defaults PKCE to true.
//
//  3. HONEST DISCLOSURE SEATS — `browserCallable` is entry-level tri-state: true/false
//     are documented facts, ABSENT means unknown and must stay absent (the wizard
//     discloses "unknown", never "works in a browser"). An invented `true` re-creates
//     the opaque "Failed to fetch" the 2026-08-12 BYOK CORS advisory exists to prevent.
//
// Values are pinned as an EXACT table (repo lesson: exact sets, never counts) AND the
// security rule runs generically over the whole registry, so a future entry cannot
// slip a bad combo past the pinned table.

import { describe, expect, it } from 'vitest';

import type { DesktopRedirectPosture, WellKnownAuthOption, WellKnownOauthProvider } from '../well-known-providers.js';
import { resolveDesktopPosture, WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

const POSTURES: readonly DesktopRedirectPosture[] = [
  'loopback',
  'loopback-fixed-port',
  'custom-scheme',
  'https-bridge',
  'device-flow',
];

const LOOPBACK_POSTURES: readonly DesktopRedirectPosture[] = ['loopback', 'loopback-fixed-port'];

/**
 * Every OAuth-capable FLOW in the registry: the entry itself when its kind is
 * `oauth2_auth_code` (the default option), plus each `oauth2_auth_code` option.
 * Mirrors `requirementFromRegistryEntry`'s `flow = option ?? entry` seat exactly —
 * the posture must exist wherever a real OAuth flow can be chosen.
 */
function oauthFlows(): Array<{
  key: string;
  flowId: string;
  entry: WellKnownOauthProvider;
  option?: WellKnownAuthOption;
}> {
  const flows: Array<{ key: string; flowId: string; entry: WellKnownOauthProvider; option?: WellKnownAuthOption }> =
    [];
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    if (entry.kind === 'oauth2_auth_code') flows.push({ key, flowId: `${key} (default)`, entry });
    for (const option of entry.authOptions ?? []) {
      if (option.kind === 'oauth2_auth_code') flows.push({ key, flowId: `${key}.${option.id}`, entry, option });
    }
  }
  return flows;
}

describe('desktop postures — every OAuth-capable flow resolves to one (completeness)', () => {
  it('the registry actually contains OAuth flows (guard against a vacuous suite)', () => {
    // Without this, an accidental registry rename would green every loop below by
    // iterating nothing — same vacuity trap the static-kind suite documents.
    expect(oauthFlows().length).toBeGreaterThanOrEqual(6);
  });

  for (const { flowId, entry, option } of oauthFlows()) {
    it(`${flowId}: resolves to a desktop redirect posture — no posture means a mid-flow failure, not an honest refusal`, () => {
      expect(resolveDesktopPosture(entry, option)).toBeDefined();
    });
  }
});

describe('desktop postures — THE SECURITY RULE: loopback-class posture requires PKCE at the flow seat', () => {
  // Generic over the registry, not the pinned table: a future entry/option edit that
  // authors `pkce:false` beside a loopback posture must fail HERE, in this package,
  // before any shell code renders a walkthrough for an undefendable flow.
  for (const { flowId, entry, option } of oauthFlows()) {
    it(`${flowId}: never pairs a loopback posture with pkce:false (auth-code injection is otherwise undefendable)`, () => {
      const posture = resolveDesktopPosture(entry, option);
      if (posture === undefined || !LOOPBACK_POSTURES.includes(posture)) return;
      // The flow seat that owns the flow — same `option ?? entry` rule the one emitter
      // uses. `undefined` is fine: the transformer defaults PKCE to true.
      const flowPkce = (option ?? entry).pkce;
      expect(
        flowPkce,
        `${flowId}: a local process can race the loopback redirect with its own code and the VALID state; only provider-side PKCE binding defeats it`,
      ).not.toBe(false);
    });
  }
});

describe('desktop postures — values stay within the union (runtime, against future data edits)', () => {
  // The union is compile-time, but registry data is edited by hand and a cast or a
  // widened seat would sail past tsc; assert over the live objects.
  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    it(`${key}: entry and option posture seats hold only known postures; browserCallable stays entry-level`, () => {
      if (entry.desktopRedirectPosture !== undefined) {
        expect(POSTURES).toContain(entry.desktopRedirectPosture);
      }
      if (entry.browserCallable !== undefined) {
        expect(typeof entry.browserCallable).toBe('boolean');
      }
      for (const option of entry.authOptions ?? []) {
        if (option.desktopRedirectPosture !== undefined) {
          expect(POSTURES).toContain(option.desktopRedirectPosture);
        }
        // Entry-level only: which hosts/browsers can call a provider is a per-provider
        // fact, never a per-flow one (same rule as apiHosts/identity on options).
        expect(option).not.toHaveProperty('browserCallable');
      }
    });
  }
});

describe('desktop postures — resolveDesktopPosture precedence (option over entry)', () => {
  const entryWith = (posture?: DesktopRedirectPosture): WellKnownOauthProvider => ({
    kind: 'oauth2_auth_code',
    apiHosts: ['api.example.com'],
    ...(posture !== undefined ? { desktopRedirectPosture: posture } : {}),
  });
  const optionWith = (posture?: DesktopRedirectPosture): WellKnownAuthOption => ({
    id: 'alt',
    label: 'Alt',
    kind: 'oauth2_auth_code',
    ...(posture !== undefined ? { desktopRedirectPosture: posture } : {}),
  });

  it('option posture overrides the entry posture (flow seat per ADR-0020)', () => {
    expect(resolveDesktopPosture(entryWith('loopback'), optionWith('device-flow'))).toBe('device-flow');
  });

  it('an option without its own posture inherits the entry posture', () => {
    expect(resolveDesktopPosture(entryWith('https-bridge'), optionWith(undefined))).toBe('https-bridge');
  });

  it('no option: the entry posture is the answer', () => {
    expect(resolveDesktopPosture(entryWith('loopback'))).toBe('loopback');
  });

  it('neither seat authored: undefined — the wizard must treat this as "no desktop OAuth", never guess', () => {
    expect(resolveDesktopPosture(entryWith(undefined), optionWith(undefined))).toBeUndefined();
  });
});

describe('desktop postures — the authored values are EXACTLY the verified table', () => {
  // Each value was verified against the provider's live documentation on 2026-08-12
  // (source URLs cited beside each registry seat). Pinned as an exact table so a
  // "harmless" data edit has to face the citation it contradicts.
  const ENTRY_POSTURES: ReadonlyArray<{ key: string; posture: DesktopRedirectPosture }> = [
    // Spotify: 127.0.0.1:PORT loopback permitted, `localhost` banned, EXACT match.
    { key: 'spotify', posture: 'loopback-fixed-port' },
    // Google family: any-port loopback for desktop clients (RFC 8252 §7.3).
    { key: 'google', posture: 'loopback' },
    { key: 'gmail', posture: 'loopback' },
    { key: 'googledrive', posture: 'loopback' },
    // Slack: https-only redirect URLs — loopback http is unregistrable.
    { key: 'slack', posture: 'https-bridge' },
    // Apple Music: no OAuth redirect at all (MusicKit popup in a secure browser
    // context) — the refusing posture, never an optimistic loopback.
    { key: 'applemusic', posture: 'https-bridge' },
  ];

  for (const { key, posture } of ENTRY_POSTURES) {
    it(`${key}: entry posture is '${posture}'`, () => {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before its posture can be asserted`).toBeDefined();
      expect(entry?.desktopRedirectPosture).toBe(posture);
    });
  }

  it('github (bearer_token default): NO entry posture — the default flow is not OAuth', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['github'];
    expect(entry).toBeDefined();
    expect(entry?.desktopRedirectPosture).toBeUndefined();
  });

  it("github.oauth_app: 'device-flow' — pkce:false makes every loopback posture undefendable; the shell has no device flow yet, so the wizard refuses honestly and steers to the PAT default (intended)", () => {
    const option = WELL_KNOWN_PROVIDERS_REGISTRY['github']?.authOptions?.find((candidate) => candidate.id === 'oauth_app');
    expect(option).toBeDefined();
    expect(option?.desktopRedirectPosture).toBe('device-flow');
  });

  it("coinbase.oauth: 'https-bridge' — loopback-literal support is undocumented; ambiguity resolves to the refusing posture", () => {
    const option = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.authOptions?.find((candidate) => candidate.id === 'oauth');
    expect(option).toBeDefined();
    expect(option?.desktopRedirectPosture).toBe('https-bridge');
  });

  it('static-kind entries (no OAuth flow anywhere) carry no posture: coinbase/openweather/coingecko/hue defaults', () => {
    // `hue` MIGRATED in 2026-08-13 (P5): a LAN device runs no OAuth redirect of any
    // kind, so `undefined` is the correct answer and the posture-completeness suite
    // treats it exactly like the other static kinds — no new posture literal was needed.
    for (const key of ['coinbase', 'openweather', 'coingecko', 'hue']) {
      expect(WELL_KNOWN_PROVIDERS_REGISTRY[key]?.desktopRedirectPosture).toBeUndefined();
    }
  });
});

describe('desktop postures — browserCallable is a documented fact or ABSENT, never a guess', () => {
  const BROWSER_CALLABLE: ReadonlyArray<{ key: string; value: boolean }> = [
    // Documented CORS-friendly APIs (citations beside the registry seats).
    { key: 'github', value: true },
    { key: 'coingecko', value: true },
    { key: 'openweather', value: true },
    // The 2026-08-12 advisory's motivating case: Coinbase blocks browser calls.
    { key: 'coinbase', value: false },
    // MIGRATED 2026-08-13 (P5, ADR-0023): the Hue bridge serves a private-CA (or
    // self-signed) certificate on a private IP and sends no CORS headers — a browser
    // page cannot reach it and has no per-host trust escape. `false` here is a
    // DOCUMENTED fact, not a guess, and it is what the wizard discloses before anything
    // is collected. This is the entry that makes the +1 in this table load-bearing.
    { key: 'hue', value: false },
    // ADR-0032 (TASK-20260816): the WhatsApp helper listens on a UNIX-DOMAIN SOCKET. A
    // browser tab cannot open one at all — this is not a CORS or certificate question but
    // an absence of any reachable transport, which makes `false` the most documented
    // value in this table. The wizard discloses it before anything is collected.
    { key: 'whatsapp', value: false },
  ];

  for (const { key, value } of BROWSER_CALLABLE) {
    it(`${key}: browserCallable is ${value}`, () => {
      const entry = WELL_KNOWN_PROVIDERS_REGISTRY[key];
      expect(entry, `${key} must exist before its disclosure can be asserted`).toBeDefined();
      expect(entry?.browserCallable).toBe(value);
    });
  }

  it('every other entry leaves browserCallable ABSENT — unknown is disclosed as unknown', () => {
    const documented = new Set(BROWSER_CALLABLE.map((row) => row.key));
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      if (documented.has(key)) continue;
      expect(entry.browserCallable, `${key}: absent means unknown; an invented value becomes a false wizard promise`).toBeUndefined();
    }
  });
});
