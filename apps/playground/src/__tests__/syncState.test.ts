// Integration layer over the db sync module (children 4/5 playground half):
// origin choice persists inside the user DB (self-describing when ported), export
// produces a real SQLite blob honoring the secrets-strip default, and import arms
// the F15 endpoint re-confirmation guard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authStore } from '../state/auth.js';
import { endpointsNeedConfirmStore } from '../state/mode.js';
import { exportUserFile, importUserFile, setSyncOrigin, signOut, syncStatusStore } from '../state/sync.js';
import { installTestUserDb } from './userdbTestHelper.js';

const SQLITE_MAGIC = 'SQLite format 3';

describe('sync origin choice', () => {
  beforeEach(() => {
    syncStatusStore.set({ origin: 'none', state: 'off' });
  });

  it('persists the chosen origin into snug_sync (rides inside the portable file)', async () => {
    const db = await installTestUserDb();
    await setSyncOrigin('none');
    expect(db.getSyncConfig('origin')).toEqual({ kind: 'none' });
    expect(syncStatusStore.get()).toEqual({ origin: 'none', state: 'off' });
  });
});

describe('export / import UI layer', () => {
  beforeEach(() => {
    endpointsNeedConfirmStore.set(false);
  });

  it('exports a real .sqlite blob; secrets stay out by default and in on opt-in', async () => {
    const db = await installTestUserDb();
    db.setSecret('byok:anthropic', 'sk-ant-super-secret');
    const stripped = await exportUserFile(false);
    expect(stripped.type).toBe('application/x-sqlite3');
    const strippedText = new TextDecoder('latin1').decode(await stripped.arrayBuffer());
    expect(strippedText.startsWith(SQLITE_MAGIC)).toBe(true);
    expect(strippedText.includes('sk-ant-super-secret')).toBe(false);
    const full = await exportUserFile(true);
    const fullText = new TextDecoder('latin1').decode(await full.arrayBuffer());
    expect(fullText.includes('sk-ant-super-secret')).toBe(true);
  });

  it('import replaces local state AND arms the F15 endpoint confirmation', async () => {
    const source = await installTestUserDb();
    source.installApp({ displayName: 'Ported App', html: '<html>ported</html>' });
    const exported = await exportUserFile(false);

    const target = await installTestUserDb();
    expect(target.listApps()).toHaveLength(0);
    await importUserFile(exported);
    expect(target.listApps().map((a) => a.displayName)).toEqual(['Ported App']);
    expect(endpointsNeedConfirmStore.get()).toBe(true);
  });
});

describe('signOut rebuilds the sync loop AFTER logout (living-apps child 4, review F14)', () => {
  it('logs out (fresh auth probe) and re-inits sync from the DB config in order', async () => {
    await installTestUserDb();
    syncStatusStore.set({ origin: 'hub', state: 'idle' });
    const order: string[] = [];
    document.cookie = 'snug_csrf=stale-token';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      order.push(url);
      if (url === '/auth/logout') {
        document.cookie = 'snug_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        return new Response('', { status: 204 });
      }
      if (url === '/auth/me') return new Response('', { status: 401 });
      return new Response('', { status: 404 });
    });

    await signOut();

    // logout + auth re-probe happen BEFORE the loop rebuild reads sync config
    expect(order[0]).toBe('/auth/logout');
    expect(order[1]).toBe('/auth/me');
    expect(authStore.get()).toEqual({ state: 'anonymous' });
    // no origin configured in the fresh test DB → loop lands in 'off' (rebuilt, not stale 'idle')
    expect(syncStatusStore.get()).toEqual({ origin: 'none', state: 'off' });
    vi.restoreAllMocks();
  });
});
