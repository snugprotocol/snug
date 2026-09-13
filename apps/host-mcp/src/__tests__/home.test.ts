// The real-home guard (D-B34).
//
// WHY THIS EXISTS. On 2026-09-07 a `/userdb` oversize-body test wrote 2 MiB of zeros over
// the owner's REAL `~/Snug/user.snug`, destroying two weeks of data that no backup held.
// The test was wrong, but the defect it exposed is not the test's: `createRunner` and
// `createLoopbackServer` both DEFAULTED to the live home, so any test, script or stray
// import that forgot to pass one reached the user's actual file by doing nothing at all.
//
// Isolating each test is half a fix and the wrong half — it fixes the tests that exist,
// not the next one written. The other half is here: reaching a real home must take an
// EXPLICIT act, so that forgetting can only ever produce a refusal, never a write.

import { describe, expect, it } from 'vitest';

import { resolveHome, RealHomeRefusedError } from '../home.js';

const REAL = '/Users/someone';

describe('resolveHome', () => {
  it('refuses the real home when nothing asked for it — the 2026-09-07 data loss, by construction', () => {
    // The exact shape of the incident: no SNUG_HOME, no opt-in, just a default.
    expect(() => resolveHome({ env: { HOME: REAL } })).toThrow(RealHomeRefusedError);
  });

  it('names the remedy in the refusal, because a guard nobody can get past is a bug report', () => {
    let message = '';
    try {
      resolveHome({ env: { HOME: REAL } });
    } catch (error) {
      message = (error as Error).message;
    }
    // The two ways out, both named. A developer who hits this must not have to read source.
    expect(message).toContain('SNUG_HOME');
    expect(message).toContain('allowRealHome');
  });

  it('takes SNUG_HOME verbatim — the isolation seam every test already uses', () => {
    expect(resolveHome({ env: { HOME: REAL, SNUG_HOME: '/tmp/iso' } })).toBe('/tmp/iso');
  });

  it('allows the real home ONLY on an explicit opt-in — how the shipped process runs', () => {
    expect(resolveHome({ env: { HOME: REAL }, allowRealHome: true })).toBe(`${REAL}/Snug`);
  });

  it('prefers SNUG_HOME even when the real home is allowed, so a host can still be isolated', () => {
    expect(resolveHome({ env: { HOME: REAL, SNUG_HOME: '/tmp/iso' }, allowRealHome: true })).toBe('/tmp/iso');
  });

  it('refuses rather than inventing a relative home when HOME itself is absent', () => {
    // The old code fell back to `'.'`, which turns a missing HOME into a `./Snug` written
    // wherever the process happened to be started — a surprise store, not a safe one.
    expect(() => resolveHome({ env: {} })).toThrow(RealHomeRefusedError);
    expect(() => resolveHome({ env: {}, allowRealHome: true })).toThrow(/HOME/);
  });
});
