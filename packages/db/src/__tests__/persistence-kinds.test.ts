// persistence-kinds.test.ts — TASK-20260905-binding-a-artifacts AC4/AC5: `PersistenceKind`
// gains `'window-storage'` (the chat artifact's page storage) and `'artifact-html'` (the
// hosted artifact's record over the browser bucket). An APPEND, never a version bump
// (lesson 2026-09-04): both `persistence` getters report the new kinds as themselves, and
// `'memory'` still reads `'none'`.

import { describe, expect, it } from 'vitest';

import { createMemoryBackend, type PersistenceBackend, type PersistenceKind } from '../persistence.js';
import { openUserDb } from '../userdb/userdb.js';
import { locateWasm } from './helpers.js';

function backendOfKind(kind: PersistenceKind): PersistenceBackend {
  const files = new Map<string, Uint8Array>();
  return {
    kind,
    async load(file) {
      return files.get(file);
    },
    async save(file, bytes) {
      files.set(file, bytes.slice());
    },
  };
}

describe('the two artifact kinds are reported as themselves', () => {
  it.each(['window-storage', 'artifact-html'] as const)('%s', async (kind) => {
    const result = await openUserDb({ backend: backendOfKind(kind), locateWasm, persistDebounceMs: 1 });
    if (result.status !== 'ok') throw new Error('open failed');
    expect(result.userDb.persistence).toBe(kind);
    expect(result.userDb.driver.persistence).toBe(kind);
    await result.userDb.close();
  });

  it('memory still reads `none` (the positive twin)', async () => {
    const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (result.status !== 'ok') throw new Error('open failed');
    expect(result.userDb.persistence).toBe('none');
    await result.userDb.close();
  });
});
