// AC8 — a hand-in arriving while the page is already running.

import { describe, expect, it, vi } from 'vitest';

import { applyHandInEvent, describeLocalHandIn } from '../local/handinEvents.js';

vi.mock('../handin.js', () => ({
  handInFromPage: vi.fn(async (_db, blocks, options) => ({
    installed: options?.binding === 'local-host' ? ['app-1'] : [],
    updated: [],
    pending: [],
    skipped: [],
    refused: [],
    blocks,
    options,
  })),
}));

const bundle = { lineage: '0123abcd-4567-89ab-cdef-0123456789ab', app: { displayName: 'Chess' } };

describe('applying a delivered bundle', () => {
  it('applies it and tells the surfaces, so the hub does not show a stale shelf', async () => {
    const onLibraryChanged = vi.fn();
    const onNote = vi.fn();
    await applyHandInEvent({ bundle }, { getDb: async () => ({}) as never, onLibraryChanged, onNote });
    expect(onLibraryChanged).toHaveBeenCalled();
    expect(onNote).toHaveBeenCalledWith(expect.stringMatching(/added an app/));
  });

  it('passes the local-host binding, so the connections refusal reads for THIS binding', async () => {
    const { handInFromPage } = await import('../handin.js');
    await applyHandInEvent({ bundle }, { getDb: async () => ({}) as never, onLibraryChanged: vi.fn(), onNote: vi.fn() });
    expect(vi.mocked(handInFromPage).mock.calls.at(-1)?.[2]).toEqual({ binding: 'local-host' });
  });

  it('reads the lineage from the BUNDLE, not from the envelope', async () => {
    const { handInFromPage } = await import('../handin.js');
    await applyHandInEvent({ bundle }, { getDb: async () => ({}) as never, onLibraryChanged: vi.fn(), onNote: vi.fn() });
    expect(vi.mocked(handInFromPage).mock.calls.at(-1)?.[1]?.[0]?.lineage).toBe(bundle.lineage);
  });

  it('refreshes the library even when nothing applied — a stale shelf is the failure mode', async () => {
    const onLibraryChanged = vi.fn();
    await applyHandInEvent({ bundle: 'not json' }, { getDb: async () => ({}) as never, onLibraryChanged, onNote: vi.fn() });
    expect(onLibraryChanged).toHaveBeenCalled();
  });
});

describe('the note the user reads', () => {
  it('says nothing when nothing happened', () => {
    expect(describeLocalHandIn({ installed: [], updated: [], pending: [], skipped: [], refused: [] } as never)).toBeUndefined();
  });

  it('carries a refusal’s own reason rather than a generic failure', () => {
    const note = describeLocalHandIn({ installed: [], updated: [], pending: [], skipped: [], refused: [{ lineage: 'x', reason: 'connect it yourself in Snug' }] } as never);
    expect(note).toContain('connect it yourself');
  });
});
