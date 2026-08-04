// Child-1 ACs 4,5 (TASK-20260803-userdb-core): the runner-facing DbDriver over blob-
// embedded per-app databases — existing per-app contract semantics, isolation across
// namespaces, standalone per-app export, and interleaved typed-CRUD + driver writes
// surviving a full persist/reopen cycle (single shared handle — F7).
import { beforeEach, describe, expect, it } from 'vitest';
import { USERDB_FILE } from '@snugprotocol/protocol';
import {
  decodeBase64,
  execFrame,
  exportFrame,
  hasSqliteMagic,
  kvGetFrame,
  kvSetFrame,
  locateWasm,
} from '../../__tests__/helpers.js';
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

describe('per-app driver contract over blobs (AC4)', () => {
  it('exec creates tables and queries rows per namespace', async () => {
    const create = await db.driver.handle('app-1', execFrame('CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT)'));
    expect(create.ok).toBe(true);
    await db.driver.handle('app-1', execFrame("INSERT INTO habits (name) VALUES ('swim')"));
    const rows = await db.driver.handle('app-1', execFrame('SELECT name FROM habits'));
    expect(rows).toMatchObject({ ok: true, rows: [['swim']], columns: ['name'] });
  });

  it('kvGet/kvSet round-trip per namespace', async () => {
    await db.driver.handle('app-1', kvSetFrame('theme', { dark: true }));
    const got = await db.driver.handle('app-1', kvGetFrame('theme'));
    expect(got).toMatchObject({ ok: true, value: { dark: true } });
    const other = await db.driver.handle('app-2', kvGetFrame('theme'));
    expect(other).toEqual({ ok: true }); // absent in the other namespace
  });

  it('namespaces are isolated: same table name, different data', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    await db.driver.handle('app-2', execFrame('CREATE TABLE t (v TEXT)'));
    await db.driver.handle('app-1', execFrame("INSERT INTO t VALUES ('one')"));
    await db.driver.handle('app-2', execFrame("INSERT INTO t VALUES ('two')"));
    const one = await db.driver.handle('app-1', execFrame('SELECT v FROM t'));
    const two = await db.driver.handle('app-2', execFrame('SELECT v FROM t'));
    expect(one).toMatchObject({ ok: true, rows: [['one']] });
    expect(two).toMatchObject({ ok: true, rows: [['two']] });
  });

  it('forbidden statements are still rejected (guardrails inherited)', async () => {
    const result = await db.driver.handle('app-1', execFrame("ATTACH DATABASE 'x' AS x"));
    expect(result).toMatchObject({ ok: false, code: 'DB_FORBIDDEN_STATEMENT' });
  });

  it('app data lands inside the single user DB file and survives reopen (v2: native app_* tables)', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    await db.flush();
    // reopen the persisted user DB from bytes: the blob must be there
    await db.close();
    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (reopened.status !== 'ok') throw new Error('reopen failed');
    const rows = await reopened.userDb.driver.handle('app-1', execFrame("SELECT name FROM sqlite_master WHERE name = 't'"));
    expect(rows).toMatchObject({ ok: true, rows: [['t']] });
    await reopened.userDb.close();
    expect(backend.files.has(USERDB_FILE)).toBe(true);
  });

  it('driver export returns a valid standalone SQLite file; deriveAppExport matches', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    const viaFrame = await db.driver.handle('app-1', exportFrame());
    expect(viaFrame.ok).toBe(true);
    if (!viaFrame.ok || viaFrame.bytesBase64 === undefined) throw new Error('no export bytes');
    expect(hasSqliteMagic(decodeBase64(viaFrame.bytesBase64))).toBe(true);
    const derived = await db.deriveAppExport('app-1');
    expect(derived).toBeDefined();
    expect(hasSqliteMagic(derived as Uint8Array)).toBe(true);
  });

  it('deriveAppExport is undefined for a namespace that never wrote', async () => {
    expect(await db.deriveAppExport('never-used')).toBeUndefined();
  });
});

describe('interleaved typed-CRUD and driver writes survive reopen (AC5, F7)', () => {
  it('both write paths persist through one pipeline', async () => {
    const app = db.installApp({ displayName: 'Habits', html: '<html>v1</html>' });
    await db.driver.handle(app.appId, execFrame('CREATE TABLE marks (day TEXT)'));
    db.saveAppVersion(app.appId, '<html>v2</html>');
    await db.driver.handle(app.appId, execFrame("INSERT INTO marks VALUES ('mon')"));
    db.setSetting('mode', 'byok');
    await db.flush();
    await db.close();

    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (reopened.status !== 'ok') throw new Error('reopen failed');
    const u = reopened.userDb;
    expect(u.getAppHtml(app.appId)).toBe('<html>v2</html>');
    expect(u.getSetting('mode')).toBe('byok');
    const marks = await u.driver.handle(app.appId, execFrame('SELECT day FROM marks'));
    expect(marks).toMatchObject({ ok: true, rows: [['mon']] });
    await u.close();
  });
});
