// import-cache-coherence.test.ts — TASK-20260805-doctrines-devex AC4/AC5.
//
// `importUserDb` replaces the WHOLE world (file-is-truth: the user DB is the single
// source of truth in every mode), so every session cache keyed on the old handle must
// be reset to describe the new one. The hub-ops reviewer flagged the reset as partial
// (`lastSavedHash` cleared, `namespaceByFile` not) — same cache-coherence family as the
// F1/R1 resurrection bug. The publicly observable member of that family is the
// `deletedApps` tombstone: restoring a backup taken BEFORE a deleteApp left the
// restored app bricked — listed by listApps(), yet refusing every db frame.
//
// AC5 locks the asymmetry the fix must keep: tombstones survive an import whose file
// does NOT contain the deleted app. Clearing them wholesale would re-open the R1
// orphan path (a still-running iframe of a deleted app re-creating app_<token>__*
// tables in a file that has no matching snug_apps row).

import { beforeEach, describe, expect, it } from 'vitest';

import { execFrame, locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

/** Install an app with one native table and one row, flushed into the user-DB file. */
async function seedApp(displayName: string): Promise<string> {
  const { appId } = db.installApp({ displayName, html: '<html>v1</html>', usesDb: true });
  await db.applyAppDdl(appId, ['CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, result TEXT)']);
  const write = await db.driver.handle(appId, execFrame(`INSERT INTO games (result) VALUES ('win')`));
  expect(write.ok).toBe(true);
  await db.flush();
  return appId;
}

describe('importUserDb — session-cache coherence (the F1/R1 family)', () => {
  it('restoring a backup taken before deleteApp revives the app: frames served, data back (AC4)', async () => {
    const appId = await seedApp('chess');
    const backup = await db.exportUserDb();

    await db.deleteApp(appId);
    // Sanity: the tombstone is live before the import.
    const whileDeleted = await db.driver.handle(appId, execFrame('SELECT result FROM games'));
    expect(whileDeleted.ok).toBe(false);

    await db.importUserDb(backup);

    // The imported file contains the app — file-is-truth says it is alive again.
    expect(db.getApp(appId)).toBeDefined();
    expect(db.listApps().map((a) => a.appId)).toContain(appId);

    // The decision altitude: the driver facade must SERVE the restored app, and the
    // materializer must rebuild its runtime from the restored rest tables — not from
    // any pre-import session state.
    const read = await db.driver.handle(appId, execFrame('SELECT result FROM games ORDER BY id'));
    expect(read.ok, `restored app must accept frames again, got: ${JSON.stringify(read)}`).toBe(true);
    if (read.ok) expect(read.rows).toEqual([['win']]);
  });

  it('keeps the tombstone when the imported file does NOT contain the deleted app (AC5)', async () => {
    // Backup taken BEFORE the app exists — a world that never knew it.
    const preInstallBackup = await db.exportUserDb();

    const appId = await seedApp('checkers');
    await db.deleteApp(appId);

    await db.importUserDb(preInstallBackup);

    expect(db.getApp(appId)).toBeUndefined();
    // Terminal delete survives: a still-running iframe's frame must stay refused, or
    // it would write orphaned app_<token>__* tables into a file with no app row.
    const afterImport = await db.driver.handle(appId, execFrame('SELECT 1'));
    expect(afterImport.ok, 'frames for an app absent from the imported file must stay refused').toBe(false);
  });
});
