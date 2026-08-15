// TASK-20260815-spotify-scopes-wizard-links AC1/AC2 (ADR-0028) — RED-FIRST at Gate 3
// against a registry that pins no scopes anywhere and an emitter/substitution pair that
// never read the seat.
//
// ADR-0028 amends the standing "no default scopes" posture: a registry ENTRY may pin a
// human-reviewed scope list (entry-level ONLY — privilege breadth is brand identity,
// like display name and hosts; options never carry it). The seat rides every surface
// pinned seats ride: emitted by `requirementFromRegistryEntry`, REPLACED (never merged)
// by admission's registry substitution on every borrow hit, carried into the spec by
// `requirementToSpec`, and sent by `generateAuthUrl`. AC1's test runs that WHOLE chain
// at the production altitude (lesson 2026-08-05: test where the decision is made — a
// hand-built spec would pass against a broken emitter).
import { describe, expect, it } from 'vitest';
import type { ConnectionRequirement } from '@snugprotocol/protocol';
import {
  WELL_KNOWN_PROVIDERS_REGISTRY,
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
} from '../well-known-providers.js';
import { admitConnectionRequirement } from '../requirement-admission.js';
import { requirementToSpec } from '../connected-fetch.js';
import { OAuthService } from '../oauth-service.js';
import { UserDbCredentialStore } from '../credential-store.js';

// The ADR-0028 §4 set, verbatim and ORDERED (scopes are semantically ordered — the
// review screen and the consent screen render them in this order).
const SPOTIFY_SCOPES = [
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-private',
  'user-library-read',
  'user-top-read',
  'user-read-playback-state',
  'user-modify-playback-state',
];

/** The shipped starter manifest, byte-shaped (examples/spotify-party-dj/connection.json). */
const STARTER_DECLARATION: ConnectionRequirement = {
  slot: 'spotify',
  provider: {
    name: 'Spotify',
    docsUrl: 'https://developer.spotify.com/documentation/web-api',
  },
  kind: 'oauth2_auth_code',
  declaredApiHosts: ['api.spotify.com'],
};

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

describe('ADR-0028 — the Spotify entry pins its reviewed scope set', () => {
  it('pins exactly the ADR-0028 set, in its recorded order', () => {
    expect(lookupWellKnownProvider('Spotify')?.scopes).toEqual(SPOTIFY_SCOPES);
  });

  it('user-read-email stays deliberately excluded (no Snug surface needs the address)', () => {
    expect(lookupWellKnownProvider('Spotify')?.scopes).not.toContain('user-read-email');
  });
});

describe('ADR-0028 — the emitter emits scopes as an ENTRY-level seat', () => {
  it('emits the pinned set for Spotify, as a COPY (registry is a module singleton)', () => {
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    const requirement = requirementFromRegistryEntry(entry, 'Spotify', 'spotify');
    expect(requirement.scopes).toEqual(SPOTIFY_SCOPES);
    expect(requirement.scopes).not.toBe(entry.scopes);
  });

  it('emits NO scopes for entries that pin none (the posture survives for them)', () => {
    const google = WELL_KNOWN_PROVIDERS_REGISTRY['google']!;
    expect(requirementFromRegistryEntry(google, 'Google', 'google').scopes).toBeUndefined();
  });
});

describe('ADR-0028 — admission substitution owns the seat on every borrow hit', () => {
  it('a bare starter declaration under the Spotify brand receives the pinned scopes', () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok, 'the shipped manifest must stay admissible').toBe(true);
    if (admitted.ok) expect(admitted.requirement.scopes).toEqual(SPOTIFY_SCOPES);
  });

  it('REPLACES authored scopes under a scope-pinned brand — a borrower can neither widen nor narrow', () => {
    const authored: ConnectionRequirement = { ...STARTER_DECLARATION, scopes: ['user-read-email'] };
    const admitted = admitConnectionRequirement(authored, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) {
      expect(admitted.requirement.scopes).toEqual(SPOTIFY_SCOPES);
      expect(admitted.requirement.scopes).not.toContain('user-read-email');
    }
  });

  it('CHARACTERIZATION (ADR-0028 rule 5, pre-existing exposure): authored scopes SURVIVE under a non-scope-pinned brand', () => {
    // This pins today's behavior so the threat-model pass that revisits rule 5 (parked
    // beside borrowed-endpoints, next-steps 2026-08-12) inherits a test, not a guess.
    // AC3b is the mitigation: the widened ask renders in-wizard before any approval.
    const authored: ConnectionRequirement = {
      slot: 'google',
      provider: { name: 'Google' },
      kind: 'oauth2_auth_code',
      declaredApiHosts: ['www.googleapis.com'],
      scopes: ['https://mail.google.com/'],
    };
    const admitted = admitConnectionRequirement(authored, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) expect(admitted.requirement.scopes).toEqual(['https://mail.google.com/']);
  });

  it('substitution hands out COPIES — scopes and registration.instructions are never live registry references', () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    expect(admitted.requirement.scopes).not.toBe(entry.scopes);
    // The plan-review drive-by: registration was shallow-spread, leaving `instructions`
    // a live reference to the module singleton every later substitution reads.
    expect(admitted.requirement.registration?.instructions).not.toBe(entry.registration?.instructions);
  });

  it('is idempotent across the second admission pass (the production path admits twice)', () => {
    const first = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = admitConnectionRequirement(first.requirement, { channel: 'starter' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.requirement.scopes).toEqual(SPOTIFY_SCOPES);
  });
});

describe('AC1 — the WHOLE production chain: manifest → admission → spec → authorize URL', () => {
  it('the authorize URL carries scope= with exactly the pinned set, space-joined, in order', async () => {
    const admitted = admitConnectionRequirement(STARTER_DECLARATION, { channel: 'starter' });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    const spec = requirementToSpec(admitted.requirement);
    expect(spec, 'an oauth requirement must produce a spec').not.toBeNull();

    const service = new OAuthService({
      store: new UserDbCredentialStore(memoryQuartet()),
      redirectUriProvider: { redirectUri: () => 'http://127.0.0.1:41420/callback' },
      fetch: async () => new Response('{}', { status: 200 }),
    });
    const start = await service.generateAuthUrl({
      appId: 'app-spotify-starter',
      spec: spec!,
      clientCreds: { client_id: 'CID' },
    });
    const url = new URL(start.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
    expect(url.searchParams.get('scope')).toBe(SPOTIFY_SCOPES.join(' '));
    // PKCE stays active through the same chain — the scope seat must not displace it.
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
