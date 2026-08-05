// Integration layer over the db sync module (children 4/5 playground half):
// origin choice persists inside the user DB (self-describing when ported), export
// produces a real SQLite blob honoring the secrets-strip default, and import arms
// the F15 endpoint re-confirmation guard.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authStore } from '../state/auth.js';
import { endpointsNeedConfirmStore } from '../state/mode.js';
import { applyRemote, exportUserFile, importUserFile, setSyncOrigin, signOut, syncStatusStore } from '../state/sync.js';
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

// TASK-20260804-hub-polish AC21: a hub 412 with neither an etag header nor a body
// `revision` (the server's "If-Match sent, origin row gone" answer, reachable after a
// hub DB reset or a re-login under a new userId) must land the page in the DIVERGENCE
// resolver, not the red error state. Driven end to end through the real hub provider.
describe('hub 412 with no revision reaches the divergence resolver (AC21)', () => {
  beforeEach(() => {
    syncStatusStore.set({ origin: 'none', state: 'off' });
  });

  it('shows divergence — not an error — and names the empty origin in the detail', async () => {
    await installTestUserDb();
    document.cookie = 'snug_csrf=csrf-for-tests';
    const puts: RequestInit[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/userdb' && (init?.method ?? 'GET') === 'GET') {
        // The origin row is gone (hub DB wiped) — pull finds nothing…
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      if (url === '/userdb' && init?.method === 'PUT') {
        puts.push(init);
        // …but the sidecar still holds a revision, so the loop sends If-Match and the
        // server answers a bare 412: code/message, no etag header, no body revision.
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'REVISION_MISMATCH', message: 'no user DB exists yet' }), {
            status: 412,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    await setSyncOrigin('hub');

    const status = syncStatusStore.get();
    expect(status.state).toBe('divergence');
    expect(status.detail).toContain('origin');
    expect(puts).toHaveLength(1); // AC23: no silent retry after the conflict
    vi.restoreAllMocks();
  });

  /**
   * ADVERSARIAL-REVIEW FIX (2026-08-04). Phase B made the empty-origin case reachable
   * (before it threw SYNC_BAD_RESPONSE and never hit the resolver), which exposed a
   * pre-existing dead end: "use the origin copy" called applyRemote(), the loop emitted
   * {error, ORIGIN_EMPTY} because there is nothing to pull, and applyRemote() then
   * unconditionally wrote `idle` OVER that error. The banner vanished, nothing synced,
   * and the next 30s tick re-diverged with no explanation.
   *
   * The user is actively invited to press it: the detail says "the origin no longer has
   * the copy this device synced to", so taking the origin copy is the intuitive read.
   */
  it('"use the origin copy" against an empty origin surfaces the error instead of a silent no-op', async () => {
    await installTestUserDb();
    document.cookie = 'snug_csrf=csrf-for-tests';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/userdb' && (init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response(null, { status: 404 })); // origin holds nothing
      }
      if (url === '/userdb' && init?.method === 'PUT') {
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'REVISION_MISMATCH', message: 'no user DB exists yet' }), {
            status: 412,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('', { status: 404 }));
    });

    await setSyncOrigin('hub');
    expect(syncStatusStore.get().state).toBe('divergence');

    await applyRemote();

    // MUST NOT be 'idle': nothing was imported. Reverting the fix (unconditionally
    // setting idle) makes this go red — mutation-verified.
    expect(
      syncStatusStore.get().state,
      'applyRemote must not report idle when the origin held no image to apply',
    ).not.toBe('idle');
    vi.restoreAllMocks();
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
