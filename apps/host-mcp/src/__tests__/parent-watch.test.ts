// D-B22 — the copy stays honest.
//
// `parent-watch.ts` is copied from `apps/whatsapp-sidecar` rather than imported (that
// package is private, exports no subpath, and its barrel drags in `baileys`). A copy
// without a pin is a fork waiting to happen, so this compares the two files' BODIES
// byte-for-byte and fails the day either moves.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { watchParent } from '../parent-watch.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ORIGINAL = path.resolve(here, '../../../whatsapp-sidecar/src/parent-watch.ts');
const COPY = path.resolve(here, '../parent-watch.ts');

/** Everything after our provenance header — the part that must not drift. */
const bodyOf = (source: string): string => source.slice(source.indexOf('/**'));

describe('the copy matches its source', () => {
  it('is byte-identical to the sidecar’s, below the header', () => {
    expect(bodyOf(readFileSync(COPY, 'utf8'))).toBe(bodyOf(readFileSync(ORIGINAL, 'utf8')));
  });

  it('says where it came from and why', () => {
    const header = readFileSync(COPY, 'utf8').slice(0, readFileSync(COPY, 'utf8').indexOf('/**'));
    expect(header).toMatch(/whatsapp-sidecar/);
    expect(header).toMatch(/D-B22/);
  });
});

describe('the behaviour it carries', () => {
  it('fires when the ppid CHANGES — reparenting, not ppid === 1', async () => {
    vi.useFakeTimers();
    try {
      let ppid = 100;
      const onOrphaned = vi.fn();
      watchParent({ getPpid: () => ppid, intervalMs: 10, onOrphaned });
      await vi.advanceTimersByTimeAsync(50);
      expect(onOrphaned).not.toHaveBeenCalled();
      ppid = 4; // a subreaper adopted us — not necessarily 1
      await vi.advanceTimersByTimeAsync(50);
      expect(onOrphaned).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
