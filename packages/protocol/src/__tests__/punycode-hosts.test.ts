// AL-03 amendment B3 — punycode, concretely. AL-02's merge review found the asymmetry:
// declared hosts were normalized lowercase+trim but NOT punycoded, while URL-derived
// hosts (via `new URL().hostname`) come out punycoded — a unicode declared host could
// never match a real request host (fail-closed, but the displayed frozen list lied for
// IDN hosts). The retrofit: `normalizeAuthHost` performs IDNA toASCII (the URL trick),
// so `deriveAuthAllowedHosts` STORES punycode for all new approvals AND every check-time
// comparison (hostSetEquals, the auth package's ceiling predicates) normalizes BOTH
// sides — pre-existing stored unicode entries still match.
import { describe, expect, it } from 'vitest';
import { deriveAuthAllowedHosts, hostSetEquals, normalizeAuthHost, type AuthSpec } from '../auth-schema.js';

describe('B3 — normalizeAuthHost punycodes (IDNA toASCII via the URL trick)', () => {
  it('converts a unicode hostname to its xn-- form', () => {
    expect(normalizeAuthHost('münchen.example')).toBe('xn--mnchen-3ya.example');
    expect(normalizeAuthHost('bücher.de')).toBe('xn--bcher-kva.de');
  });

  it('IDN round-trip: a real xn-- host and its unicode form normalize identically', () => {
    expect(normalizeAuthHost('xn--mnchen-3ya.example')).toBe(normalizeAuthHost('MÜNCHEN.example'));
  });

  it('keeps plain ASCII hosts lowercase+trimmed, unchanged otherwise', () => {
    expect(normalizeAuthHost('  API.Spotify.COM ')).toBe('api.spotify.com');
    expect(normalizeAuthHost('xn--bcher-kva.de')).toBe('xn--bcher-kva.de');
  });

  it('fails closed on host strings smuggling more than a hostname (path/port/creds/query)', () => {
    // These fall back to the trimmed lowercase form, which can never equal a real
    // URL-derived hostname — membership checks fail closed, as before the retrofit.
    for (const smuggled of ['evil.com/path', 'evil.com:8080', 'user@evil.com', 'evil.com?q=1', 'evil.com#f']) {
      const normalized = normalizeAuthHost(smuggled);
      expect(normalized).toBe(smuggled.toLowerCase());
      expect(normalized).not.toBe('evil.com');
    }
  });

  it('never throws on malformed input', () => {
    for (const bad of ['', ' ', '..', '::1', 'ex ample.com', '%zz']) {
      expect(() => normalizeAuthHost(bad)).not.toThrow();
    }
  });
});

describe('B3 — deriveAuthAllowedHosts stores punycode for new approvals', () => {
  const spec: AuthSpec = {
    kind: 'api_key',
    provider: { name: 'IDN Provider' },
    fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
    declaredApiHosts: ['api.münchen.example', 'plain.example.com'],
  };

  it('unicode declared hosts land in the union as xn-- (matching URL-derived hosts)', () => {
    expect(deriveAuthAllowedHosts(spec)).toEqual(['api.xn--mnchen-3ya.example', 'plain.example.com'].sort());
  });

  it('stored-unicode entries still compare equal to their punycoded recompute (pre-retrofit rows survive)', () => {
    // A pre-existing frozen row that stored the unicode form must not trip the freeze
    // check nor fail ceiling membership: both sides normalize at check time.
    expect(hostSetEquals(['api.münchen.example', 'plain.example.com'], deriveAuthAllowedHosts(spec))).toBe(true);
  });
});
