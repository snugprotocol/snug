// AL-02 D5/D7: IProject's host-freeze predicate ported as pure functions — the
// service-level outbound ceiling (N2b defense-in-depth) and the ⊆ check. Exact-host
// matching ONLY: no suffix tricks, empty allowlists fail closed.
import { describe, expect, it } from 'vitest';
import { isHostAllowed, isUrlWithinHosts, undeclaredHosts } from '../app-host-freeze.js';

describe('undeclaredHosts (⊆ check, ported)', () => {
  it('returns the submitted hosts missing from the declared set, case-insensitively', () => {
    expect(undeclaredHosts(['api.a.com', 'API.B.com'], ['api.a.com', 'api.b.com'])).toEqual([]);
    expect(undeclaredHosts(['api.a.com', 'evil.com'], ['api.a.com'])).toEqual(['evil.com']);
  });

  it('an empty declared set is fail-closed: everything submitted is undeclared', () => {
    expect(undeclaredHosts(['api.a.com'], [])).toEqual(['api.a.com']);
  });
});

describe('isHostAllowed / isUrlWithinHosts (the outbound ceiling)', () => {
  const frozen = ['accounts.spotify.com', 'api.spotify.com'];

  it('matches exact hosts case-insensitively', () => {
    expect(isHostAllowed('API.Spotify.com', frozen)).toBe(true);
    expect(isHostAllowed('api.spotify.com.evil.com', frozen)).toBe(false); // no suffix matching
    expect(isHostAllowed('spotify.com', frozen)).toBe(false); // no parent-domain matching
  });

  it('checks the URL hostname, never the string', () => {
    expect(isUrlWithinHosts('https://api.spotify.com/v1/me', frozen)).toBe(true);
    expect(isUrlWithinHosts('https://evil.com/?u=api.spotify.com', frozen)).toBe(false);
    expect(isUrlWithinHosts('https://evil.com/api.spotify.com', frozen)).toBe(false);
  });

  it('unparseable URLs and empty ceilings fail closed', () => {
    expect(isUrlWithinHosts('not a url', frozen)).toBe(false);
    expect(isUrlWithinHosts('https://api.spotify.com/x', [])).toBe(false);
  });
});
