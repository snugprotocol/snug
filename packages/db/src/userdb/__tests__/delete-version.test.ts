// delete-version.test.ts — TASK-20260821-ui-polish AC3/AC4, the DB half.
//
// `deleteAppVersion` removes ONE stored version row. Its guards are the whole feature:
// pinned factory versions are what `resetToFactory` restores and what the ADR-0045
// starter-update vouch chain hashes against, and the currently-running version is what
// the iframe executes — deleting either would break a contract some other surface
// depends on. Owner decision 2026-08-21: ALL pins are protected, not just the newest.
//
// Guard order is pinned by tests because current == MAX(version) always (saveAppVersion
// lands current as the new maximum), so "too high" must read as UNKNOWN, not as current.

import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { USERDB_FILE, USERDB_TABLES } from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, USERDB_ERROR_CODES, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

/** Independent read of the persisted bytes — a state assertion, not a return value. */
async function persistedVersions(appId: string): Promise<number[]> {
  await db.flush();
  const bytes = await backend.load(USERDB_FILE);
  if (bytes === undefined) throw new Error('no user db bytes');
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const handle = new SQL.Database(bytes);
  const stmt = handle.prepare(
    `SELECT version FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? ORDER BY version`,
    [appId] as never,
  );
  const versions: number[] = [];
  try {
    while (stmt.step()) versions.push(Number((stmt.get() as unknown[])[0]));
  } finally {
    stmt.free();
  }
  return versions;
}

/** The thrown UserDbError's code, or 'DID_NOT_THROW'. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'DID_NOT_THROW';
  } catch (err) {
    return (err as { code?: string }).code ?? 'NO_CODE';
  }
}

/** v1 pinned (install), v2..v4 unpinned edits; current = 4. */
function seedApp(): string {
  const app = db.installApp({ displayName: 'chess', html: '<html>v1</html>' });
  db.saveAppVersion(app.appId, '<html>v2</html>', 'edit 2', undefined);
  db.saveAppVersion(app.appId, '<html>v3</html>', 'edit 3', undefined);
  db.saveAppVersion(app.appId, '<html>v4</html>', 'edit 4', undefined);
  return app.appId;
}

describe('deleteAppVersion — the delete (AC3)', () => {
  it('removes exactly the named row and leaves every other version intact', async () => {
    const appId = seedApp();

    db.deleteAppVersion(appId, 2);

    expect(await persistedVersions(appId)).toEqual([1, 3, 4]);
    // The survivors keep their bytes — the delete is a row removal, not a rewrite.
    expect(db.getAppHtml(appId, 3)).toBe('<html>v3</html>');
    expect(db.getAppHtml(appId, 4)).toBe('<html>v4</html>');
    expect(db.getApp(appId)?.currentVersion).toBe(4);
  });

  it('a deleted version is honestly gone: revert to it refuses NOT_FOUND', () => {
    const appId = seedApp();
    db.deleteAppVersion(appId, 3);
    expect(codeOf(() => db.revertApp(appId, 3))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    // And the app still runs — current untouched.
    expect(db.getApp(appId)?.currentVersion).toBe(4);
  });

  it('revert still works across the hole a delete leaves', () => {
    const appId = seedApp();
    db.deleteAppVersion(appId, 3);
    const reverted = db.revertApp(appId, 2);
    expect(reverted.version).toBe(5);
    expect(db.getAppHtml(appId)).toBe('<html>v2</html>');
  });
});

describe('deleteAppVersion — the guards (AC4)', () => {
  it('refuses a pinned factory version — every pin, not only the newest', () => {
    const appId = seedApp();
    // A starter update lands a SECOND pin (ADR-0045).
    db.saveAppVersion(appId, '<html>v5 factory</html>', 'starter update', undefined, { pinned: true });

    expect(codeOf(() => db.deleteAppVersion(appId, 1))).toBe(USERDB_ERROR_CODES.VERSION_PINNED);

    // Move current off v5 so the pin guard (not the current guard) is what answers.
    db.revertApp(appId, 3); // current -> 6
    expect(codeOf(() => db.deleteAppVersion(appId, 5))).toBe(USERDB_ERROR_CODES.VERSION_PINNED);

    // Nothing was deleted by the refusals.
    expect(db.getAppHtml(appId, 1)).toBe('<html>v1</html>');
    expect(db.getAppHtml(appId, 5)).toBe('<html>v5 factory</html>');
  });

  it('refuses the currently-running version', () => {
    const appId = seedApp();
    expect(codeOf(() => db.deleteAppVersion(appId, 4))).toBe(USERDB_ERROR_CODES.VERSION_CURRENT);
    expect(db.getAppHtml(appId, 4)).toBe('<html>v4</html>');
  });

  it('a version that is pinned AND current refuses as pinned', () => {
    const appId = db.installApp({ displayName: 'fresh', html: '<html>v1</html>' }).appId;
    // v1: pinned and current at once — the pin is the stronger (permanent) claim.
    expect(codeOf(() => db.deleteAppVersion(appId, 1))).toBe(USERDB_ERROR_CODES.VERSION_PINNED);
  });

  it('an unknown version — including one ABOVE current — is NOT_FOUND, never a current-guard hit', () => {
    const appId = seedApp();
    expect(codeOf(() => db.deleteAppVersion(appId, 99))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    // A version deleted once is unknown the second time.
    db.deleteAppVersion(appId, 2);
    expect(codeOf(() => db.deleteAppVersion(appId, 2))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
  });

  it('an unknown app is NOT_FOUND', () => {
    expect(codeOf(() => db.deleteAppVersion('nope', 1))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
  });

  it('never touches a sibling app’s rows', async () => {
    const a = seedApp();
    const b = db.installApp({ displayName: 'other', html: '<html>b1</html>' }).appId;
    db.saveAppVersion(b, '<html>b2</html>', 'edit', undefined);

    db.deleteAppVersion(a, 2);

    expect(await persistedVersions(b)).toEqual([1, 2]);
  });
});
