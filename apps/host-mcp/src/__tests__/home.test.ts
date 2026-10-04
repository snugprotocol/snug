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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureDirectory, resolveHome, RealHomeRefusedError } from '../home.js';

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

  it('with no env handed in it reads the process’s own two variables — by name, never the whole environment', () => {
    // The release gate counts whole-environment reads in the shipped bundle and allows ONE,
    // the brain registry's (ADR-0071 §3). This one must stay two named reads.
    const before = { SNUG_HOME: process.env.SNUG_HOME, HOME: process.env.HOME };
    try {
      process.env.SNUG_HOME = '/tmp/iso-from-the-process';
      expect(resolveHome()).toBe('/tmp/iso-from-the-process');
      delete process.env.SNUG_HOME;
      process.env.HOME = REAL;
      expect(() => resolveHome()).toThrow(RealHomeRefusedError);
      expect(resolveHome({ allowRealHome: true })).toBe(`${REAL}/Snug`);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    const source = readFileSync(path.join(__dirname, '..', 'home.ts'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(source.match(/process\.env(?!\.[A-Z_]+\b)/g) ?? []).toEqual([]);
  });

  it('refuses rather than inventing a relative home when HOME itself is absent', () => {
    // The old code fell back to `'.'`, which turns a missing HOME into a `./Snug` written
    // wherever the process happened to be started — a surprise store, not a safe one.
    expect(() => resolveHome({ env: {} })).toThrow(RealHomeRefusedError);
    expect(() => resolveHome({ env: {}, allowRealHome: true })).toThrow(/HOME/);
  });
});

describe('ensureDirectory — two windows opening at once both make the home', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'snug-home-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const eexist = (): Error => Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });

  it('creates the directory and its parents', () => {
    const dir = path.join(root, 'Snug', 'host', 'brain');
    ensureDirectory(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    // …and again, with it there, is not an error.
    expect(() => ensureDirectory(dir)).not.toThrow();
  });

  it('an EEXIST from a mkdir that LOST THE RACE is success — the directory is there, which is what was wanted', () => {
    // Seen 2 rounds in 80 on the built bundle: the other process created a component a
    // moment earlier, and the agent was told "Snug cannot use its folder (EEXIST)".
    const dir = path.join(root, 'Snug', 'host', 'brain');
    expect(() =>
      ensureDirectory(dir, (target) => {
        mkdirSync(target, { recursive: true }); // the other process got there first
        throw eexist();
      }),
    ).not.toThrow();
  });

  it('an EEXIST with a FILE in the way is still an error — that folder cannot be used', () => {
    const dir = path.join(root, 'Snug');
    writeFileSync(dir, 'a file where the home should be');
    expect(() =>
      ensureDirectory(dir, () => {
        throw eexist();
      }),
    ).toThrow(/EEXIST/);
    // And with the real mkdir, whatever it calls it:
    expect(() => ensureDirectory(dir)).toThrow();
  });

  it('every other failure is thrown as it is', () => {
    writeFileSync(path.join(root, 'blocker'), 'x');
    expect(() => ensureDirectory(path.join(root, 'blocker', 'Snug'))).toThrow(/ENOTDIR/);
  });
});
