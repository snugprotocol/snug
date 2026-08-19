// AL-02 D2/D6/D7: the pinned well-known-provider registry, ported near-verbatim and
// EXTENDED in this child with (a) a human-reviewed `apiHosts` list per provider (the
// ported registry carried only OAuth endpoints) and (b) per-provider consent params
// (`authorizeParams`) so Google-isms are applied only where the registry says so —
// never hardcoded in the OAuth service.
import { describe, expect, it } from 'vitest';
import { WELL_KNOWN_PROVIDERS_REGISTRY, lookupWellKnownProvider } from '../well-known-providers.js';

describe('lookupWellKnownProvider (lookup normalization)', () => {
  it('matches case-insensitively and strips non-alphanum', () => {
    expect(lookupWellKnownProvider('SPOTIFY')).toBeDefined();
    expect(lookupWellKnownProvider('Spotify')).toBeDefined();
    expect(lookupWellKnownProvider('Apple Music')).toBeDefined();
    expect(lookupWellKnownProvider('Google Drive')).toBeDefined();
  });

  it('returns undefined for unknown providers (the transformer then requires explicit endpoints)', () => {
    expect(lookupWellKnownProvider('Some Obscure SaaS')).toBeUndefined();
    expect(lookupWellKnownProvider('')).toBeUndefined();
  });
});

describe('registry entries', () => {
  it('returns the Spotify endpoints we depend on', () => {
    const spotify = lookupWellKnownProvider('Spotify');
    // `endpoints` is OPTIONAL on the type as of P0 (fold T-M1) so static-kind entries need
    // not invent OAuth URLs. Asserted defined FIRST: an optional chain alone would compare
    // undefined-to-a-string and fail loudly here, but the same pattern elsewhere goes
    // vacuous, so the premise is stated explicitly wherever the type is now nullable.
    expect(spotify?.endpoints, 'Spotify must carry OAuth endpoints').toBeDefined();
    expect(spotify!.endpoints!.authorizeUrl).toBe('https://accounts.spotify.com/authorize');
    expect(spotify!.endpoints!.tokenUrl).toBe('https://accounts.spotify.com/api/token');
    expect(spotify?.pkce).toBe(true);
  });

  it('returns a Google entry with revoke URL', () => {
    const google = lookupWellKnownProvider('Google');
    expect(google?.endpoints, 'Google must carry OAuth endpoints').toBeDefined();
    expect(google!.endpoints!.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
  });

  // MIGRATED 2026-08-15 (TASK-20260815-spotify-scopes-wizard-links, ADR-0028).
  //
  // WAS: "does not default scopes for ANY entry (no silent privilege widening)". The
  // harm that rule named — a scope the user never sees — is now prevented by rendering
  // (review screen + provider consent screen), not by absence: an entry whose API is
  // useless scope-less (Spotify: a scope-less token 403s the starter's own playlist
  // read) may pin a human-reviewed, ADR-recorded list. Everything NOT recorded in an
  // ADR still pins nothing, and that half of the old rule survives verbatim below.
  it('only ADR-0028-recorded entries pin scopes; every other entry still pins none', () => {
    // `gmail` joins 2026-08-19 (TASK-20260819-gmail-starter, ADR-0039) — the second pin.
    const ADR_0028_SCOPE_ENTRIES = new Set(['spotify', 'gmail']);
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      if (ADR_0028_SCOPE_ENTRIES.has(key)) {
        expect(entry.scopes, `${key}: an ADR-recorded scope pin must be a non-empty list`).toBeDefined();
        expect(entry.scopes!.length, key).toBeGreaterThan(0);
        for (const scope of entry.scopes!) {
          // Scope-shaped: no whitespace (the join is space-delimited) and no duplicates.
          expect(scope, key).toMatch(/^\S+$/);
        }
        expect(new Set(entry.scopes!).size, `${key}: duplicate scopes`).toBe(entry.scopes!.length);
      } else {
        expect(entry.scopes, `${key}: pinning scopes requires an ADR-0028 entry`).toBeUndefined();
      }
    }
  });

  // MIGRATED 2026-08-13 (TASK-20260812-desktop-auth-awareness P5, ADR-0023 Decision 1).
  //
  // WAS: "EVERY entry carries a human-reviewed, non-empty apiHosts list (plan D2 — the
  // branch points at data that exists)". That rule was correct for ten entries and
  // COLLIDES structurally with the eleventh: a Philips Hue bridge sits at an address the
  // USER's router assigned, so no human review could pin it and no honest value exists to
  // put in `apiHosts`. ADR-0023 replaces the rule with the fork below rather than
  // weakening it — every entry still declares exactly one host SOURCE, and an entry that
  // declares neither (or both) is still a failure. The old rule's real content — "a
  // pinned host list is non-empty and bare-hostname-shaped" — survives verbatim inside
  // branch (a), so nothing is LOST.
  it('EVERY entry declares exactly ONE host source: pinned apiHosts XOR lanHost (ADR-0023 Decision 1)', () => {
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      const pinned = entry.apiHosts !== undefined;
      const lan = entry.lanHost !== undefined;
      expect(
        pinned !== lan,
        `${key}: an entry must pin apiHosts OR declare a lanHost — never neither (no ceiling) and never both (two host sources)`,
      ).toBe(true);
      if (pinned) {
        // Branch (a) — the original rule, unchanged for the ten pinned-host entries.
        expect(entry.apiHosts!.length, key).toBeGreaterThan(0);
        for (const host of entry.apiHosts!) {
          expect(host, key).toMatch(/^[a-z0-9.-]+$/); // bare lowercase hostnames, never URLs
        }
      } else {
        // Branch (b) — a LAN entry declares the CLASS of address it will collect and the
        // label the wizard renders above the input, and it carries NO address: an entry
        // that pinned one would be pinning a value only the user can know.
        expect(entry.lanHost!.class, key).toBe('rfc1918-ipv4-literal');
        expect(entry.lanHost!.label.length, key).toBeGreaterThan(0);
      }
    }
  });

  it('lanHost is an ENTRY-level seat — no authOption may declare one (hosts are identity, never flow)', () => {
    // Same rule ADR-0020 states for `apiHosts`, restated for the seat that replaces it:
    // which hosts may receive a credential is a per-PROVIDER decision, and a flow choice
    // must never move it. Pinned structurally because the type alone cannot say it.
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      for (const option of entry.authOptions ?? []) {
        const raw = option as unknown as Record<string, unknown>;
        expect(raw['lanHost'], `${key}.${option.id}`).toBeUndefined();
        expect(raw['pairing'], `${key}.${option.id}: a pairing exchange belongs to the DEVICE`).toBeUndefined();
      }
    }
  });

  it('pins the reviewed apiHosts for the providers AL-03 injects against', () => {
    expect(lookupWellKnownProvider('Spotify')?.apiHosts).toEqual(['api.spotify.com']);
    expect(lookupWellKnownProvider('GitHub')?.apiHosts).toEqual(['api.github.com']);
    expect(lookupWellKnownProvider('Gmail')?.apiHosts).toEqual(['gmail.googleapis.com']);
    expect(lookupWellKnownProvider('Google Drive')?.apiHosts).toEqual(['www.googleapis.com']);
    expect(lookupWellKnownProvider('Slack')?.apiHosts).toEqual(['slack.com']);
    expect(lookupWellKnownProvider('Apple Music')?.apiHosts).toEqual(['api.music.apple.com']);
  });

  it('consent params are per-provider registry data: Google entries carry offline+consent, Spotify carries none', () => {
    for (const name of ['Google', 'Gmail', 'Google Drive']) {
      expect(lookupWellKnownProvider(name)?.authorizeParams).toEqual({
        access_type: 'offline',
        prompt: 'consent',
      });
    }
    expect(lookupWellKnownProvider('Spotify')?.authorizeParams).toBeUndefined();
    expect(lookupWellKnownProvider('GitHub')?.authorizeParams).toBeUndefined();
  });
});

describe('AL-04 D5 — registry registration walkthrough copy (M5: registry/user-entry are the ONLY sources)', () => {
  it('Spotify carries at least stub-grade registration instructions (AL-09 dependency)', () => {
    const registration = lookupWellKnownProvider('Spotify')?.registration;
    expect(registration?.consoleUrl).toBe('https://developer.spotify.com/dashboard');
    expect(registration?.instructions?.length ?? 0).toBeGreaterThan(0);
  });

  it('every registration block present in the registry is schema-shaped (consoleUrl URL, non-empty steps)', () => {
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      if (entry.registration === undefined) continue;
      if (entry.registration.consoleUrl !== undefined) {
        expect(() => new URL(entry.registration!.consoleUrl!), key).not.toThrow();
      }
      for (const step of entry.registration.instructions ?? []) {
        expect(step.length, key).toBeGreaterThan(0);
      }
    }
  });
});
