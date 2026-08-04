// Child-1 (TASK-20260803-userdb-v2, ADR-0010): per-app data as REAL namespaced tables.
// The materializer replaces the blob backend: at rest, rows live in `app_<token>__<name>`
// tables + a verbatim-DDL registry; at run, the app's objects are replayed into the
// app's own database (natural names). These tests lock the round-trip fidelity, the
// fail-closed name gate (C2 negative), transaction/cap discipline, and sync-hash
// stability the plan review demanded (F1–F8).
import { beforeEach, describe, expect, it } from 'vitest';
import initSqlJs, { type Database } from 'sql.js';
import { appDataToken, appRestTableName } from '@snugprotocol/protocol';
import { decodeBase64, execFrame, exportFrame, kvGetFrame, kvSetFrame, locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type AppPersistErrorEvent, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;
let persistErrors: AppPersistErrorEvent[];

async function open(maxBytes?: number): Promise<UserDb> {
  const result = await openUserDb({
    backend,
    locateWasm,
    persistDebounceMs: 1,
    onAppPersistError: (event) => persistErrors.push(event),
    ...(maxBytes !== undefined ? { maxBytes } : {}),
  });
  if (result.status !== 'ok') throw new Error(`open failed: ${result.status}`);
  return result.userDb;
}

/** Open exported user-DB bytes directly to inspect the at-rest layout. */
async function openRaw(bytes: Uint8Array): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  return new SQL.Database(bytes);
}

const restNames = (raw: Database): string[] => {
  const result = raw.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'app_*' ORDER BY name");
  return (result[0]?.values ?? []).map((row) => String(row[0]));
};

beforeEach(async () => {
  backend = createMemoryBackend();
  persistErrors = [];
  db = await open();
});

describe('at-rest layout (AC1)', () => {
  it('app tables land as app_<token>__<name> rows in the user DB after flush', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE trades (id INTEGER PRIMARY KEY, qty REAL)'));
    await db.driver.handle('app-1', execFrame('INSERT INTO trades (qty) VALUES (2.5)'));
    await db.flush();

    const raw = await openRaw(await db.exportUserDb({ includeSecrets: true }));
    const token = appDataToken('app-1');
    const rest = appRestTableName(token, 'trades');
    expect(restNames(raw)).toContain(rest);
    const rows = raw.exec(`SELECT qty FROM "${rest}"`);
    expect(rows[0]?.values).toEqual([[2.5]]);
    expect(raw.exec("SELECT name FROM sqlite_master WHERE name = 'snug_app_data'")).toEqual([]);
    raw.close();
  });

  it('registers the schema (verbatim natural DDL) in snug_app_schemas, excluding snug_kv', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE trades (id INTEGER PRIMARY KEY, qty REAL)'));
    await db.driver.handle('app-1', kvSetFrame('theme', 'dark'));
    await db.flush();

    const schema = db.getAppSchema('app-1');
    expect(schema).toBeDefined();
    const names = schema!.objects.map((o) => o.name);
    expect(names).toContain('trades');
    expect(names).not.toContain('snug_kv');
    const trades = schema!.objects.find((o) => o.name === 'trades')!;
    expect(trades.type).toBe('table');
    expect(trades.ddl).toBe('CREATE TABLE trades (id INTEGER PRIMARY KEY, qty REAL)');
  });

  it('marks uses_db on the app row once rest state exists (F12)', async () => {
    const app = db.installApp({ displayName: 'Portfolio', html: '<html/>' });
    expect(db.getApp(app.appId)?.usesDb).toBe(false);
    await db.driver.handle(app.appId, execFrame('CREATE TABLE t (v)'));
    await db.flush();
    expect(db.getApp(app.appId)?.usesDb).toBe(true);
  });
});

describe('round-trip fidelity (AC2 — the F2 suite)', () => {
  it('tables, indexes, triggers, views, AUTOINCREMENT continuity, blobs, and exotic DDL survive reopen', async () => {
    const ns = 'a7f3b2c1-0d4e-4f5a-8b6c-9d0e1f2a3b4c';
    const statements = [
      'CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, qty REAL DEFAULT 0)',
      'CREATE TABLE equities (symbol TEXT PRIMARY KEY, name TEXT, parent TEXT REFERENCES equities(symbol)) WITHOUT ROWID',
      'CREATE TABLE strict_t (a INTEGER, b TEXT) STRICT',
      'CREATE TABLE gen_t (price REAL, qty REAL, total REAL GENERATED ALWAYS AS (price * qty) STORED)',
      'CREATE TABLE blob_t (payload BLOB)',
      'CREATE INDEX idx_trades_symbol ON trades (symbol)',
      "CREATE VIEW v_totals AS SELECT symbol, SUM(qty) AS total FROM trades GROUP BY symbol",
      "CREATE TRIGGER trg_trades AFTER INSERT ON trades BEGIN UPDATE trades SET qty = qty WHERE id = NEW.id; END",
    ];
    for (const sql of statements) {
      const result = await db.driver.handle(ns, execFrame(sql));
      expect(result.ok, sql).toBe(true);
    }
    await db.driver.handle(ns, execFrame("INSERT INTO trades (symbol, qty) VALUES ('AAPL', 3)"));
    await db.driver.handle(ns, execFrame("INSERT INTO equities VALUES ('AAPL', 'Apple', NULL)"));
    await db.driver.handle(ns, execFrame('INSERT INTO gen_t (price, qty) VALUES (10, 4)'));
    await db.driver.handle(ns, execFrame("INSERT INTO blob_t VALUES (x'DEADBEEF')"));
    await db.flush();
    await db.close();

    const reopened = await open();
    // every object is back under its natural name
    const master = await reopened.driver.handle(ns, execFrame('SELECT type, name FROM sqlite_master ORDER BY name'));
    expect(master.ok).toBe(true);
    const objectNames = (master as { rows: unknown[][] }).rows.map((r) => String(r[1]));
    for (const name of ['trades', 'equities', 'strict_t', 'gen_t', 'blob_t', 'idx_trades_symbol', 'v_totals', 'trg_trades']) {
      expect(objectNames).toContain(name);
    }
    // data + generated column + blob fidelity
    const gen = await reopened.driver.handle(ns, execFrame('SELECT total FROM gen_t'));
    expect(gen).toMatchObject({ ok: true, rows: [[40]] });
    const blob = await reopened.driver.handle(ns, execFrame('SELECT payload FROM blob_t'));
    expect((blob as { rows: unknown[][] }).rows[0]?.[0]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    const view = await reopened.driver.handle(ns, execFrame('SELECT total FROM v_totals'));
    expect(view).toMatchObject({ ok: true, rows: [[3]] });
    // AUTOINCREMENT continuity: next id continues past the persisted counter (F2)
    await reopened.driver.handle(ns, execFrame("INSERT INTO trades (symbol, qty) VALUES ('MSFT', 1)"));
    const ids = await reopened.driver.handle(ns, execFrame('SELECT MAX(id) FROM trades'));
    expect(ids).toMatchObject({ ok: true, rows: [[2]] });
    await reopened.close();
  });

  it('AUTOINCREMENT never reuses ids of deleted rows across reopen (review B1)', async () => {
    const ns = 'seq-app';
    await db.driver.handle(ns, execFrame('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)'));
    for (const v of ['a', 'b', 'c']) {
      await db.driver.handle(ns, execFrame('INSERT INTO items (v) VALUES (?)', [v]));
    }
    // Deleting the MAX rows is the trap: max(id) inference would hand id 2 out again.
    await db.driver.handle(ns, execFrame('DELETE FROM items WHERE id >= 2'));
    await db.flush();
    await db.close();

    const reopened = await open();
    await reopened.driver.handle(ns, execFrame("INSERT INTO items (v) VALUES ('d')"));
    const next = await reopened.driver.handle(ns, execFrame('SELECT MAX(id) FROM items'));
    expect(next).toMatchObject({ ok: true, rows: [[4]] });
    // exactly ONE counter row — INSERT OR REPLACE used to append a duplicate
    const seqRows = await reopened.driver.handle(ns, execFrame("SELECT count(*) FROM sqlite_sequence WHERE name = 'items'"));
    expect(seqRows).toMatchObject({ ok: true, rows: [[1]] });
    await reopened.close();
  });

  it('kv round-trips through materialize/write-back/reopen (F7)', async () => {
    await db.driver.handle('app-kv', kvSetFrame('theme', { dark: true }));
    await db.flush();
    await db.close();
    const reopened = await open();
    const got = await reopened.driver.handle('app-kv', kvGetFrame('theme'));
    expect(got).toMatchObject({ ok: true, value: { dark: true } });
    await reopened.close();
  });

  it('deriveAppExport yields a standalone DB with natural names for any namespace shape (F1/F12)', async () => {
    await db.driver.handle('starter--chess', execFrame('CREATE TABLE moves (san TEXT)'));
    await db.driver.handle('starter--chess', execFrame("INSERT INTO moves VALUES ('e4')"));
    await db.flush();
    const bytes = await db.deriveAppExport('starter--chess');
    expect(bytes).toBeDefined();
    const raw = await openRaw(bytes!);
    expect(raw.exec('SELECT san FROM moves')[0]?.values).toEqual([['e4']]);
    expect(restNames(raw)).toEqual([]); // natural names only in a standalone export
    raw.close();
  });

  it('driver export frame matches deriveAppExport semantics', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    const viaFrame = await db.driver.handle('app-1', exportFrame());
    expect(viaFrame.ok).toBe(true);
    const raw = await openRaw(decodeBase64((viaFrame as { bytesBase64: string }).bytesBase64));
    expect(raw.exec("SELECT name FROM sqlite_master WHERE name = 't'")[0]?.values).toEqual([['t']]);
    raw.close();
  });
});

describe('isolation + injection negatives (AC1, C2)', () => {
  it('app A cannot reach app B tables in either name form', async () => {
    await db.driver.handle('app-a', execFrame('CREATE TABLE secrets_a (v TEXT)'));
    await db.driver.handle('app-b', execFrame('CREATE TABLE t (v TEXT)'));
    await db.flush();

    const natural = await db.driver.handle('app-b', execFrame('SELECT * FROM secrets_a'));
    expect(natural.ok).toBe(false);
    const rest = await db.driver.handle(
      'app-b',
      execFrame(`SELECT * FROM "${appRestTableName(appDataToken('app-a'), 'secrets_a')}"`),
    );
    expect(rest.ok).toBe(false);
  });

  it('a hostile quoted table name fails the write-back closed: secrets and other apps untouched (F3)', async () => {
    db.setSecret('byok', 'sk-sensitive');
    await db.driver.handle('victim', execFrame('CREATE TABLE safe (v TEXT)'));
    await db.driver.handle('victim', execFrame("INSERT INTO safe VALUES ('kept')"));
    await db.flush();

    const hostile = 'evil"; DROP TABLE snug_secrets;--';
    const created = await db.driver.handle('attacker', execFrame(`CREATE TABLE "${hostile.replace(/"/g, '""')}" (x)`));
    expect(created.ok).toBe(true); // legal INSIDE the sandbox runtime
    await db.flush(); // write-back must refuse to persist it

    expect(persistErrors.length).toBeGreaterThan(0);
    expect(persistErrors[0]!.namespace).toBe('attacker');
    expect(db.getSecret('byok')).toBe('sk-sensitive');
    const raw = await openRaw(await db.exportUserDb({ includeSecrets: true }));
    const tables = restNames(raw);
    expect(tables).toContain(appRestTableName(appDataToken('victim'), 'safe'));
    expect(tables.some((t) => t.includes('evil'))).toBe(false);
    expect(raw.exec("SELECT count(*) FROM snug_secrets")[0]?.values).toEqual([[1]]);
    raw.close();
  });

  it('reserved-prefix names (snug_/app_/sqlite_ forgeries) fail the write-back closed', async () => {
    for (const name of ['snug_evil', 'APP_deadbeef__x', 'Snug_kv2']) {
      const ns = `ns-${name}`;
      await db.driver.handle(ns, execFrame(`CREATE TABLE "${name}" (v)`));
      await db.flush();
      expect(persistErrors.some((e) => e.namespace === ns), name).toBe(true);
    }
    const raw = await openRaw(await db.exportUserDb({ includeSecrets: true }));
    expect(restNames(raw).filter((t) => t.toLowerCase().includes('evil'))).toEqual([]);
    raw.close();
  });

  it('a gate failure keeps the previous rest state for that app (fail-closed, not fail-empty)', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE good (v TEXT)'));
    await db.driver.handle('app-1', execFrame("INSERT INTO good VALUES ('v1')"));
    await db.flush();
    await db.driver.handle('app-1', execFrame('CREATE TABLE "bad name!" (x)'));
    await db.driver.handle('app-1', execFrame("INSERT INTO good VALUES ('v2')"));
    await db.flush(); // gate rejects; previous rest state must survive

    expect(persistErrors.some((e) => e.namespace === 'app-1')).toBe(true);
    const raw = await openRaw(await db.exportUserDb({ includeSecrets: true }));
    const rest = appRestTableName(appDataToken('app-1'), 'good');
    expect(raw.exec(`SELECT v FROM "${rest}"`)[0]?.values).toEqual([['v1']]);
    raw.close();
  });
});

describe('transaction + cap discipline (F4/F5)', () => {
  it('a write-back that would exceed the cap rolls back whole and surfaces TOO_LARGE', async () => {
    const small = await (async () => {
      await db.close();
      backend = createMemoryBackend();
      return open(256 * 1024);
    })();
    await small.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    await small.flush();
    const bigValue = 'x'.repeat(400 * 1024);
    const inserted = await small.driver.handle('app-1', execFrame('INSERT INTO t VALUES (?)', [bigValue]));
    expect(inserted.ok).toBe(true); // runtime accepts; the cap is enforced at write-back
    await small.flush();
    expect(persistErrors.some((e) => e.code === 'USERDB_TOO_LARGE')).toBe(true);
    const raw = await openRaw(await small.exportUserDb({ includeSecrets: true }));
    const rest = appRestTableName(appDataToken('app-1'), 't');
    expect(raw.exec(`SELECT count(*) FROM "${rest}"`)[0]?.values).toEqual([[0]]); // rolled back whole
    raw.close();
    await small.close();
  });
});

describe('sync-hash stability (F6)', () => {
  it('a read-only app session does not change the exported user-DB bytes', async () => {
    await db.driver.handle('app-1', execFrame('CREATE TABLE t (v TEXT)'));
    await db.driver.handle('app-1', execFrame("INSERT INTO t VALUES ('x')"));
    await db.flush();
    const before = await db.exportUserDb({ includeSecrets: true });

    await db.driver.handle('app-1', execFrame('SELECT v FROM t'));
    await db.driver.handle('app-1', execFrame('SELECT count(*) FROM t'));
    await db.flush();
    const after = await db.exportUserDb({ includeSecrets: true });
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
  });
});

describe('applyAppDdl — the hub-side DDL execution layer (AC1/AC3)', () => {
  it('applies LLM-proposed statements, registers the schema, and appends the audit', async () => {
    const app = db.installApp({ displayName: 'Portfolio', html: '<html/>' });
    await db.applyAppDdl(app.appId, [
      'CREATE TABLE financial (id INTEGER PRIMARY KEY, note TEXT)',
      'CREATE TABLE equities (symbol TEXT PRIMARY KEY, qty REAL)',
      'CREATE INDEX idx_equities_qty ON equities (qty)',
    ]);
    const schema = db.getAppSchema(app.appId);
    expect(schema!.objects.map((o) => o.name)).toEqual(['financial', 'equities', 'idx_equities_qty']);
    const audit = db.listAppMigrations(app.appId);
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({ seq: 1, ddl: 'CREATE TABLE financial (id INTEGER PRIMARY KEY, note TEXT)' });
    // and the data surface works through the ordinary driver
    const insert = await db.driver.handle(app.appId, execFrame("INSERT INTO equities VALUES ('AAPL', 2)"));
    expect(insert.ok).toBe(true);
  });

  it('is atomic: a failing statement mid-batch leaves runtime, registry, and audit untouched', async () => {
    const app = db.installApp({ displayName: 'P', html: '<html/>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE keep (v TEXT)']);
    await expect(
      db.applyAppDdl(app.appId, ['CREATE TABLE second (v TEXT)', 'CREATE BOGUS SYNTAX (']),
    ).rejects.toThrow();
    const schema = db.getAppSchema(app.appId);
    expect(schema!.objects.map((o) => o.name)).toEqual(['keep']);
    expect(db.listAppMigrations(app.appId)).toHaveLength(1);
    const gone = await db.driver.handle(app.appId, execFrame('SELECT * FROM second'));
    expect(gone.ok).toBe(false);
  });

  it('rejects statements that would create reserved/invalid names before anything persists', async () => {
    const app = db.installApp({ displayName: 'P', html: '<html/>' });
    await expect(db.applyAppDdl(app.appId, ['CREATE TABLE snug_evil (v TEXT)'])).rejects.toThrow();
    expect(db.getAppSchema(app.appId)).toBeUndefined();
    expect(db.listAppMigrations(app.appId)).toHaveLength(0);
  });
});
