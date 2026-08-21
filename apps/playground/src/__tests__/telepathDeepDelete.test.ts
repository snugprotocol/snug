// TASK-20260821-ui-polish AC5/AC6 — the Telepath deep delete, playground half.
//
// Deleting the app that holds the LAST sidecar-ceiling connection is the user saying
// "forget my WhatsApp": the DB cascade (data, docs, credentials, identity directory) is
// packages/db's job, and everything OUTSIDE the user DB — the helper's session keys, the
// minted token, the thread cache under ~/Snug — is this trigger's. Owner decision
// 2026-08-21: full device unlink; a reinstall requires a fresh QR scan.
//
// The negatives live in the SAME suite as the positive (plan review finding 15): a
// non-sidecar delete fires nothing, and — the orphanhood rule, finding 5 — a sidecar
// delete while a SECOND app still holds a sidecar fact fires nothing, because unlinking
// would cut that app off mid-flight. The db-level identity-directory wipe follows the
// same last-holder rule (`wipeSidecarIdentityDirectoryIfOrphaned`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';
import type { UserDb } from '@snugprotocol/db';
import type { SnugPlatform } from '../platform/platform.js';

function desktopPlatform(seats: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    ...seats,
  };
}

/** A connection row as the predicate reads it — appId + the frozen ceiling. */
function row(appId: string, hosts: string[]): { appId: string; allowedHosts: string[] } {
  return { appId, allowedHosts: hosts };
}

function fakeDb(rows: Array<{ appId: string; allowedHosts: string[] }>): {
  db: UserDb;
  deleteApp: ReturnType<typeof vi.fn>;
} {
  const deleteApp = vi.fn(async () => {});
  const db = {
    deleteApp,
    listConnections: vi.fn(() => rows),
  } as unknown as UserDb;
  return { db, deleteApp };
}

beforeEach(() => {
  vi.resetModules();
});

async function libraryOver(db: UserDb) {
  const { createUserDbLibrary } = await import('../state/library.js');
  return createUserDbLibrary(async () => db);
}

describe('deleting the LAST sidecar app unlinks the device (AC5)', () => {
  it('runs the DB cascade FIRST, then start → /session/forget → ctl(forget)', async () => {
    const order: string[] = [];
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async (action) => {
          order.push(`ctl:${action}`);
          return { running: true, nonce: 'n' };
        },
        sidecarWizardFetch: async (method, path) => {
          order.push(`wizard:${method} ${path}`);
          return { status: 200, body: '{"ok":true}' };
        },
      }),
    );
    const { db, deleteApp } = fakeDb([
      row('telepath-app', [SIDECAR_SYMBOLIC_HOST]),
      row('other-app', ['api.spotify.com']),
    ]);
    deleteApp.mockImplementation(async () => order.push('db:deleteApp'));

    const library = await libraryOver(db);
    await library.delete('telepath-app');

    // The cascade commits before any helper call: the helper path is best-effort and must
    // never be able to fail the user-DB delete. `ctl:start` precedes the forget route
    // (the logout needs a live helper), and `ctl:forget` is the disk backstop last.
    expect(order).toEqual(['db:deleteApp', 'ctl:start', 'wizard:POST /session/forget', 'ctl:forget']);
  });

  it('still runs the ctl(forget) disk backstop when the helper cannot start', async () => {
    const order: string[] = [];
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async (action) => {
          order.push(`ctl:${action}`);
          if (action === 'start') throw new Error('node too old');
          return { running: false };
        },
        sidecarWizardFetch: async () => {
          order.push('wizard:reached');
          return { status: 200, body: '{}' };
        },
      }),
    );
    const { db } = fakeDb([row('telepath-app', [SIDECAR_SYMBOLIC_HOST])]);

    const library = await libraryOver(db);
    await expect(library.delete('telepath-app')).resolves.toBeUndefined();

    // No wizard call (the helper never came up), but the session store still leaves disk.
    expect(order).toEqual(['ctl:start', 'ctl:forget']);
  });
});

describe('the unlink does NOT fire when it must not (AC6)', () => {
  it('a delete of an app with no sidecar fact touches no seam', async () => {
    const calls: string[] = [];
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async (action) => {
          calls.push(`ctl:${action}`);
          return { running: true };
        },
        sidecarWizardFetch: async (method, path) => {
          calls.push(`wizard:${method} ${path}`);
          return { status: 200, body: '{}' };
        },
      }),
    );
    const { db, deleteApp } = fakeDb([
      row('plain-app', ['api.spotify.com']),
      row('telepath-app', [SIDECAR_SYMBOLIC_HOST]),
    ]);

    const library = await libraryOver(db);
    await library.delete('plain-app');

    expect(deleteApp).toHaveBeenCalledWith('plain-app');
    expect(calls).toEqual([]);
  });

  it('a sidecar delete while a SECOND app still holds a sidecar fact fires nothing', async () => {
    // Unlinking here would cut the surviving app off mid-flight — the db-level identity
    // wipe follows the same orphanhood rule, and the two must not disagree.
    const calls: string[] = [];
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform(
      desktopPlatform({
        sidecarCtl: async (action) => {
          calls.push(`ctl:${action}`);
          return { running: true };
        },
        sidecarWizardFetch: async () => {
          calls.push('wizard:reached');
          return { status: 200, body: '{}' };
        },
      }),
    );
    const { db } = fakeDb([
      row('telepath-app', [SIDECAR_SYMBOLIC_HOST]),
      row('second-telepath', [SIDECAR_SYMBOLIC_HOST]),
    ]);

    const library = await libraryOver(db);
    await library.delete('telepath-app');

    expect(calls).toEqual([]);
  });

  it('on web (no sidecar seams) a sidecar-fact delete still resolves cleanly', async () => {
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform({ kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } });
    const { db, deleteApp } = fakeDb([row('telepath-app', [SIDECAR_SYMBOLIC_HOST])]);

    const library = await libraryOver(db);
    await expect(library.delete('telepath-app')).resolves.toBeUndefined();
    expect(deleteApp).toHaveBeenCalledWith('telepath-app');
  });
});
