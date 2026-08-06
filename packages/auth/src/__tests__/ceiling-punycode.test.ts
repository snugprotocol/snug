// AL-03 amendment B3, check-time half: the ceiling predicates normalize BOTH sides to
// punycode, so a pre-retrofit row whose frozen list stored a unicode host still gates
// correctly against real request hostnames (which `new URL()` always punycodes).
import { describe, expect, it } from 'vitest';
import { isHostAllowed, isUrlWithinHosts, undeclaredHosts } from '../app-host-freeze.js';

describe('B3 — punycode at check time on both sides', () => {
  it('a stored-unicode ceiling entry admits its xn-- request host', () => {
    expect(isHostAllowed('xn--mnchen-3ya.example', ['münchen.example'])).toBe(true);
    expect(isUrlWithinHosts('https://xn--mnchen-3ya.example/token', ['münchen.example'])).toBe(true);
  });

  it('a stored-xn-- ceiling entry admits the unicode form of the same host', () => {
    expect(isHostAllowed('münchen.example', ['xn--mnchen-3ya.example'])).toBe(true);
  });

  it('distinct IDN hosts stay distinct — normalization never widens', () => {
    expect(isHostAllowed('xn--bcher-kva.de', ['münchen.example'])).toBe(false);
    expect(isUrlWithinHosts('https://xn--bcher-kva.de/x', ['münchen.example'])).toBe(false);
  });

  it('undeclaredHosts treats unicode and punycode forms as the same host', () => {
    expect(undeclaredHosts(['xn--mnchen-3ya.example'], ['münchen.example'])).toEqual([]);
  });
});
