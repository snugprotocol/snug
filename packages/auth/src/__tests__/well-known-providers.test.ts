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
    expect(spotify?.endpoints.authorizeUrl).toBe('https://accounts.spotify.com/authorize');
    expect(spotify?.endpoints.tokenUrl).toBe('https://accounts.spotify.com/api/token');
    expect(spotify?.pkce).toBe(true);
  });

  it('returns a Google entry with revoke URL', () => {
    expect(lookupWellKnownProvider('Google')?.endpoints.revokeUrl).toBe('https://oauth2.googleapis.com/revoke');
  });

  it('does not default scopes for ANY entry (no silent privilege widening)', () => {
    for (const entry of Object.values(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      expect(entry.scopes).toBeUndefined();
    }
  });

  it('EVERY entry carries a human-reviewed, non-empty apiHosts list (plan D2 — the branch points at data that exists)', () => {
    for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
      expect(entry.apiHosts.length, key).toBeGreaterThan(0);
      for (const host of entry.apiHosts) {
        expect(host, key).toMatch(/^[a-z0-9.-]+$/); // bare lowercase hostnames, never URLs
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
