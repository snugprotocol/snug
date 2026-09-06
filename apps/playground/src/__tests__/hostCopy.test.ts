// hostCopy.test.ts — TASK-20260905-host-kit AC2/AC5: the platform disclosure copy and the
// run view's failed-load copy, pinned byte-for-byte on every arm (pure functions).
import { describe, expect, it } from 'vitest';

import { custodyDisclosure, storageDisclosure, tierLabel, tierSubstitutionNote } from '../platform/copy.js';
import { isNamedLoadRefusal, missingAppCopy } from '../run/copy.js';

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
  it('names the two artifact kinds (T4 AC4/AC5) — the switch is exhaustive', () => {
    expect(storageDisclosure('window-storage')).toBe(
      'this copy of your file lives in this chat’s page storage — this view only; the published link keeps its own.',
    );
    expect(storageDisclosure('artifact-html')).toBe(
      'the working copy of your file lives in this browser; the saved copy is the artifact page itself.',
    );
  });
});

describe('custodyDisclosure — the "your file" chip, one arm per binding × state (T4 AC7, D8)', () => {
  const clean = { dirty: false, readOnly: false } as const;
  it('a hosted artifact: Anthropic-hosted, saved on the act, a republish rewrites unless merged, export any time', () => {
    expect(custodyDisclosure('artifact', 'artifact-html', clean)).toEqual({
      label: 'your file: in this artifact',
      headline: 'in this artifact',
      body:
        'Anthropic-hosted, saved when you save it. a republish from Claude Code rewrites it unless the agent merges it (snug-embed does). export any time.',
    });
  });
  it('the state line: dirty, the two divergence directions, read-only — read-only outranks the rest', () => {
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, dirty: true }).status).toBe('unsaved changes — save to this artifact to keep them.');
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, divergence: 'newer' }).status).toBe('this browser’s copy is newer than the page’s saved copy.');
    expect(custodyDisclosure('artifact', 'artifact-html', { ...clean, divergence: 'older' }).status).toBe('the page’s saved copy is newer than this browser’s.');
    expect(custodyDisclosure('artifact', 'artifact-html', { dirty: true, readOnly: true, divergence: 'older' }).status).toBe('read-only view — export to keep a copy.');
    expect(custodyDisclosure('artifact', 'artifact-html', clean).status).toBeUndefined();
  });
  it('the static page, the chat view, and the plain-file rungs', () => {
    expect(custodyDisclosure('artifact-static', 'opfs', clean)).toMatchObject({ label: 'your file: not saved here', headline: 'a copy of the artifact page' });
    expect(custodyDisclosure('artifact-static', 'opfs', clean).body).toContain('export');
    expect(custodyDisclosure('artifact-chat', 'window-storage', clean)).toMatchObject({ label: 'your file: in this chat', headline: 'in this chat’s page storage' });
    expect(custodyDisclosure('artifact-chat', 'window-storage', clean).body).toContain('published link keeps its own');
    expect(custodyDisclosure('file', 'opfs', clean)).toMatchObject({ label: 'your file: in this browser', body: storageDisclosure('opfs') });
    expect(custodyDisclosure('local-host', 'idb', clean)).toMatchObject({ label: 'your file: in this browser', body: storageDisclosure('idb') });
    expect(custodyDisclosure('file', 'memory', clean)).toMatchObject({ label: 'your file: in memory', body: storageDisclosure('memory') });
  });
  it('S2 — a memory-only WORKING copy under an artifact says the tab holds it, on every arm, and never without the flag', () => {
    const memory = { ...clean, workingCopy: 'memory' as const };
    for (const binding of ['artifact', 'artifact-static', 'artifact-chat'] as const) {
      expect(custodyDisclosure(binding, 'memory', memory).body).toContain('in memory only — close it unsaved and the changes are gone');
      expect(custodyDisclosure(binding, 'artifact-html', clean).body).not.toContain('in memory only');
    }
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

describe('isNamedLoadRefusal — the only failure the run view quotes', () => {
  it('matches the loader\'s named error by NAME and nothing else', () => {
    expect(isNamedLoadRefusal(Object.assign(new Error('starters load from the network'), { name: 'StarterLoadError' }))).toBe(true);
    expect(isNamedLoadRefusal(new Error('database disk image is malformed'))).toBe(false);
    expect(isNamedLoadRefusal('starters load from the network')).toBe(false);
  });
});

describe('the thinking-level copy (TASK-20260906 AC4/AC5, ADR-0067) — the contract’s own terms, every arm pinned', () => {
  const seat = { viewerDefault: 'default' as const };
  it('labels each tier by what it does and marks the viewer’s default; an unavailable tier names what answered instead', () => {
    const none = { unavailable: {} };
    expect(tierLabel('quick', seat, none)).toBe('quick — answers at once, no thinking first');
    expect(tierLabel('default', seat, none)).toBe('default — thinks first (the viewer’s default)');
    expect(tierLabel('complex', seat, none)).toBe('complex — thinks longest, for hard reasoning');
    expect(tierLabel('complex', seat, { unavailable: { complex: 'default' } })).toBe('complex — not on this plan, answered on default');
    // The marker follows the seat, not a constant: a contract whose default moved is labelled right.
    expect(tierLabel('quick', { viewerDefault: 'quick' }, none)).toBe('quick — answers at once, no thinking first (the viewer’s default)');
  });
  it('the substitution note derives from the recorded pair; nothing recorded → no note', () => {
    expect(tierSubstitutionNote(undefined)).toBeUndefined();
    expect(tierSubstitutionNote({ asked: 'complex', answered: 'default' })).toBe('asked for complex — this view answered on default (the viewer’s plan)');
  });
});
