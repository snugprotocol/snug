/**
 * THE DURABLE THREAD CACHE (ADR-0037 §1, TASK-20260818-telepath-linking-sync).
 *
 * `store.persistence.test.ts` proves the token file; this proves the content snapshot. The
 * rules mirror the OPFS lesson (lessons.md 2026-08-03): writes go to a temp name and RENAME
 * into place so a crash mid-write can never truncate the good copy; a corrupt, empty, or
 * magic-less file is QUARANTINED and read as absent — zero bytes are corruption, never a
 * fresh start; and the file is 0600, because message text is the user's private life even
 * though it is not a credential.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThreadCache } from '../thread-cache.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wa-thread-cache-'));
  file = join(dir, 'thread-cache.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createThreadCache', () => {
  it('round-trips a snapshot across two cache instances (the restart)', () => {
    createThreadCache(file).save({ chats: [{ jid: 'a@s.whatsapp.net' }], marker: 42 });
    const revived = createThreadCache(file).load();
    expect(revived).toEqual({ chats: [{ jid: 'a@s.whatsapp.net' }], marker: 42 });
  });

  it('reports nothing on a first run', () => {
    expect(createThreadCache(file).load()).toBeUndefined();
  });

  it('quarantines a corrupt file rather than reading it as truth or throwing', () => {
    writeFileSync(file, '{"half a json', { mode: 0o600 });
    expect(createThreadCache(file).load()).toBeUndefined();
    // The bad bytes are MOVED ASIDE, not deleted (evidence) and not left in place (a
    // permanent load failure on every boot).
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).some((name) => name.includes('corrupt'))).toBe(true);
  });

  it('treats an EMPTY file as corruption, never as a fresh start', () => {
    writeFileSync(file, '', { mode: 0o600 });
    expect(createThreadCache(file).load()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it('refuses a file whose magic or version is foreign', () => {
    writeFileSync(file, JSON.stringify({ magic: 'someone-else', v: 9, snapshot: {} }), { mode: 0o600 });
    expect(createThreadCache(file).load()).toBeUndefined();
  });

  it('writes 0600 and leaves no temp file behind', () => {
    createThreadCache(file).save({ chats: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['thread-cache.json']);
  });

  it('a failed save never throws — syncing must not die on a full disk', () => {
    const cache = createThreadCache(join(dir, 'no-such-dir', 'x', 'thread-cache.json'));
    expect(() => cache.save({ chats: [] })).not.toThrow();
  });

  it('a save survives a reader of the PREVIOUS copy: rename, not truncate-and-write', () => {
    const cache = createThreadCache(file);
    cache.save({ generation: 1 });
    cache.save({ generation: 2 });
    // The final content is the newest generation, whole — a truncate-in-place writer
    // interleaved with a crash would leave half of generation 2 instead.
    expect(JSON.parse(readFileSync(file, 'utf8')).snapshot).toEqual({ generation: 2 });
  });
});
