/**
 * THE ACCESS TOKEN MUST SURVIVE A RESTART (owner report, 2026-08-17).
 *
 * THE INCIDENT: linking completed, the token was stored in `snug_secrets`, and the app then
 * got "the helper refused that key". Both sides were behaving correctly and disagreeing —
 * the store was `createMemoryStore`, so the token died with the process that minted it. The
 * helper is a spawn-supervised child that stops when the app closes and restarts on demand,
 * so "dies with the process" means "invalid the moment anything restarts it".
 *
 * The session keys already persist (`auth-state.ts`'s `createFileAuthState`). The token is the same
 * class of fact — a credential the user's connection depends on — and belongs beside them.
 */

import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStore } from '../store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createFileStore', () => {
  it('a token minted by one process is readable by the next', async () => {
    const first = createFileStore(dir);
    first.setToken('minted-once');

    // A SECOND store over the same directory is exactly what a restart is.
    const second = createFileStore(dir);
    expect(second.token()).toBe('minted-once');
  });

  it('still refuses to overwrite — one link, one token, across restarts too', () => {
    createFileStore(dir).setToken('first');
    const reopened = createFileStore(dir);
    reopened.setToken('second');
    expect(reopened.token(), 'the original token stands').toBe('first');
  });

  it('writes the token file with 0600 — it is a credential, not a config value', () => {
    createFileStore(dir).setToken('secret-value');
    const tokenFile = path.join(dir, 'access-token.json');
    expect(existsSync(tokenFile)).toBe(true);
    const { statSync } = require('node:fs') as typeof import('node:fs');
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it('reports no token on a fresh directory rather than throwing', () => {
    expect(createFileStore(path.join(dir, 'nothing-here')).token()).toBeUndefined();
  });

  it('survives a corrupt token file instead of wedging the helper', () => {
    // A truncated write (power loss mid-pairing) must not make the helper unstartable —
    // reporting "no token" sends the user back through linking, which works.
    const store = createFileStore(dir);
    store.setToken('good');
    require('node:fs').writeFileSync(path.join(dir, 'access-token.json'), '{ not json');
    expect(createFileStore(dir).token()).toBeUndefined();
  });
});
