// hostCopy.test.ts — TASK-20260905-host-kit AC2/AC5: the platform disclosure copy and the
// run view's failed-load copy, pinned byte-for-byte on every arm (pure functions).
import { describe, expect, it } from 'vitest';

import { storageDisclosure } from '../platform/copy.js';
import { missingAppCopy } from '../run/copy.js';

describe('storageDisclosure — names the rung that WORKED', () => {
  it('has one sentence per backend kind and nothing when the platform did not say', () => {
    expect(storageDisclosure('opfs')).toBe('this copy of your file lives in this browser’s private storage for this page.');
    expect(storageDisclosure('idb')).toBe('this copy of your file lives in this browser’s IndexedDB for this page.');
    expect(storageDisclosure('memory')).toBe(
      'this copy of your file lives in memory only — it is gone when the page closes, so export it to keep it.',
    );
    expect(storageDisclosure('file')).toBe('this copy of your file lives on this computer’s disk.');
    expect(storageDisclosure(undefined)).toBeUndefined();
  });
});

describe('missingAppCopy — a named failure becomes the lesson', () => {
  it('without a reason it is the library miss, byte-identical to before', () => {
    expect(missingAppCopy()).toEqual({
      title: 'app not found',
      lesson: 'it may live in the other mode — check settings, or build a new one.',
    });
  });
  it('with a reason the reason is what the user reads (the starter loader’s offline refusal)', () => {
    const reason = 'starters load from the network — this page is offline or the starters package is unreachable';
    expect(missingAppCopy(reason)).toEqual({ title: 'this app didn’t load', lesson: reason });
  });
});
