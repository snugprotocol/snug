/**
 * TASK-20261010-cross-app-access AC6 — `scopedScratchRead` (ADR-0075 §6, D4, D23).
 *
 * The read another app is granted runs ONE read-only SELECT on a SCOPED SCRATCH COPY of the
 * source's runtime bytes: every trigger, then every view, then every table outside the grant
 * and `snug_kv` is physically DROPPED, `PRAGMA query_only` is set, the recorded columns are
 * checked for drift, and the statement passes `isReadOnlySelect` THEN
 * `forbiddenStatementReason` before it runs. A non-granted table is therefore ABSENT — the
 * tests assert "no such table", never a name guard — and the input bytes are never touched.
 *
 * Mutation checks (each was run by hand — remove the step, see the named row red, restore):
 *  - skip the non-granted table drop → "a table outside the grant is ABSENT …" reds;
 *  - skip the trigger drop → "every trigger is gone …" reds;
 *  - skip `PRAGMA query_only` → "PRAGMA query_only is ON …" reds;
 *  - measure bytes as characters → "the byte cap is measured in UTF-8 BYTES …" reds;
 *  - skip the drift check → the three drift rows red;
 *  - skip the credential-column scrub → "a credential-named column … crosses as ***" reds;
 *  - drift through `table_info` (hides generated columns) → the two GENERATED drift rows red;
 *  - move the withhold before the trigger drop → "triggers are dropped BEFORE the credential
 *    withhold …" reds (W6 finding 26);
 *  - skip the value mask on the copy → the "transform … carries nothing out" row reds (W6 finding 1);
 *  - answer a scoping failure as `failed` → the two `copy-failed` rows red (W6 finding 12).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ACCESS_MAX_RESULT_BYTES,
  ACCESS_MAX_ROWS,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessResponseSchema,
  frameWithinLimits,
  utf8ByteLength,
  type Frame,
} from '@snugprotocol/protocol';

import { scopedScratchRead, type ScopedReadResult } from '../scoped-read.js';
import { locateWasm } from './helpers.js';

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: locateWasm });
});

/** Build a source runtime's bytes the way an app's own SQL would have shaped them. */
function sourceBytes(statements: readonly string[]): Uint8Array {
  const db = new SQL.Database();
  try {
    for (const statement of statements) db.run(statement);
    return db.export();
  } finally {
    db.close();
  }
}

/** The Ledger fixture: a granted table, a credential-bearing sibling, a secret, a view, triggers and the kv. */
const LEDGER = [
  'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, note TEXT)',
  "INSERT INTO transactions (id, amount, category, note) VALUES (1, 450, 'food', 'coffee'), (2, 120000, 'home', 'rent'), (3, 500, 'food', 'tea')",
  'CREATE TABLE accounts (name TEXT, balance INTEGER, api_key TEXT)',
  "INSERT INTO accounts (name, balance, api_key) VALUES ('checking', 100, 'hunter2')",
  'CREATE TABLE secrets (value TEXT)',
  "INSERT INTO secrets (value) VALUES ('the diary')",
  'CREATE INDEX secrets_by_value ON secrets (value)',
  'CREATE VIEW all_secrets AS SELECT value FROM secrets',
  'CREATE VIEW food AS SELECT * FROM transactions WHERE category = \'food\'',
  // A trigger ON A GRANTED TABLE whose body names a table the scope drops — it would survive
  // a table drop (SQLite does not validate trigger bodies), and its DDL text names the secret.
  "CREATE TRIGGER copy_to_secrets AFTER INSERT ON transactions BEGIN INSERT INTO secrets (value) VALUES ('leaked ' || NEW.note); END",
  "CREATE TRIGGER on_secrets AFTER DELETE ON secrets BEGIN SELECT 1; END",
  'CREATE TABLE snug_kv (key TEXT PRIMARY KEY, value TEXT)',
  "INSERT INTO snug_kv (key, value) VALUES ('pin', '\"1234\"')",
];

const GRANT_TRANSACTIONS = { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category', 'note'] }] } as const;
const CAPS = { maxRows: ACCESS_MAX_ROWS, maxBytes: ACCESS_MAX_RESULT_BYTES } as const;

function read(bytes: Uint8Array, sql: string, scope: Parameters<typeof scopedScratchRead>[2] = GRANT_TRANSACTIONS, params?: unknown[]): ScopedReadResult {
  return scopedScratchRead(SQL, bytes, scope, { sql, ...(params !== undefined ? { params } : {}) }, CAPS);
}

function rowsOf(result: ScopedReadResult): unknown[][] {
  if (!result.ok) throw new Error(`expected rows, got ${result.reason}: ${result.message}`);
  return result.rows;
}

/**
 * A spy over the engine: every SQL text the scratch handle is asked to run, and every close.
 * Lets a row prove "no statement run" without reaching into the implementation.
 */
function spyEngine(): { engine: SqlJsStatic; seen: string[]; opened: number; closed: () => number } {
  const seen: string[] = [];
  let opened = 0;
  let closed = 0;
  const Real = SQL.Database;
  class SpyDatabase extends Real {
    constructor(data?: ArrayLike<number> | Buffer | null) {
      super(data);
      opened += 1;
    }
    override run(sql: string, params?: Parameters<InstanceType<typeof Real>['run']>[1]) {
      seen.push(sql);
      return super.run(sql, params);
    }
    override exec(sql: string, params?: Parameters<InstanceType<typeof Real>['exec']>[1]) {
      seen.push(sql);
      return super.exec(sql, params);
    }
    override prepare(sql: string, params?: Parameters<InstanceType<typeof Real>['prepare']>[1]) {
      seen.push(sql);
      return super.prepare(sql, params);
    }
    override iterateStatements(sql: string) {
      seen.push(sql);
      return super.iterateStatements(sql);
    }
    override close() {
      closed += 1;
      return super.close();
    }
  }
  const engine = { ...SQL, Database: SpyDatabase } as unknown as SqlJsStatic;
  return { engine, seen, get opened() { return opened; }, closed: () => closed };
}

describe('scopedScratchRead — the granted table answers (the passing twin of every refusal)', () => {
  it('a SELECT on a granted table answers its columns and rows', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT id, amount, category FROM transactions ORDER BY id');
    expect(result).toEqual({
      ok: true,
      columns: ['id', 'amount', 'category'],
      rows: [
        [1, 450, 'food'],
        [2, 120000, 'home'],
        [3, 500, 'food'],
      ],
    });
  });

  it('binds parameters — the reader never string-concatenates values', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT note FROM transactions WHERE category = ? ORDER BY id', GRANT_TRANSACTIONS, ['food']);
    expect(rowsOf(result)).toEqual([['coffee'], ['tea']]);
  });

  it('a WITH … SELECT is a read too', () => {
    const result = read(sourceBytes(LEDGER), 'WITH f AS (SELECT amount FROM transactions WHERE category = \'food\') SELECT SUM(amount) AS total FROM f');
    expect(rowsOf(result)).toEqual([[950]]);
  });

  it('a granted table named in another case is still the granted table (SQLite identifiers are case-insensitive)', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT COUNT(*) FROM transactions', { tables: [{ name: 'Transactions', columns: ['id', 'amount', 'category', 'note'] }] });
    expect(rowsOf(result)).toEqual([[3]]);
  });
});

describe('scopedScratchRead — physical absence (drop triggers FIRST, then views, then tables + snug_kv)', () => {
  it('a table outside the grant is ABSENT: a SELECT on it fails with "no such table"', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT value FROM secrets');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('failed');
    expect(result.message).toMatch(/no such table: secrets/);
  });

  it('a sibling table holding a credential column is absent too when it is not granted', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT api_key FROM accounts');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no such table: accounts/);
  });

  it('snug_kv is absent — the app’s own kv is never shareable', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT value FROM snug_kv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no such table: snug_kv/);
  });

  it('every view is gone — one over a dropped table and one over the granted table alike', () => {
    for (const view of ['all_secrets', 'food']) {
      const result = read(sourceBytes(LEDGER), `SELECT * FROM ${view}`);
      expect(result.ok, view).toBe(false);
      if (result.ok) continue;
      expect(result.message).toMatch(new RegExp(`no such table: ${view}`));
    }
  });

  it('every trigger is gone — including one ON the granted table whose body names a dropped table', () => {
    const result = read(sourceBytes(LEDGER), "SELECT type, name FROM sqlite_master WHERE type IN ('trigger', 'view') ORDER BY name");
    expect(rowsOf(result)).toEqual([]);
  });

  it('the schema the reader can see holds the granted table and nothing else — no name, index or DDL of a dropped object', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT type, name, sql FROM sqlite_master ORDER BY name');
    const rows = rowsOf(result);
    expect(rows.map((row) => row[1])).toEqual(['transactions']);
    expect(JSON.stringify(rows)).not.toMatch(/secret|accounts|snug_kv|diary/);
  });

  it('ANALYZE statistics about dropped tables are gone (sqlite_stat1 names indexes and counts rows)', () => {
    const bytes = sourceBytes([...LEDGER, 'ANALYZE']);
    const result = read(bytes, "SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_stat%'");
    expect(rowsOf(result)).toEqual([]);
  });

  it('free-page residue is unreachable in this build: no dbstat, no sqlite_dbpage (documented, not VACUUMed)', () => {
    for (const table of ['dbstat', 'sqlite_dbpage']) {
      const result = read(sourceBytes(LEDGER), `SELECT * FROM ${table}`);
      expect(result.ok, table).toBe(false);
      if (result.ok) continue;
      expect(result.message).toMatch(new RegExp(`no such table: ${table}`));
    }
  });

  // Review finding 4 — a DISCLOSED residual, pinned so the header's sentence stays true: the
  // granted table's own constraint text may NAME a non-granted table (one table name, one
  // column name), and the free-list count says how many pages dropped objects held. No row
  // content of the named table is reachable.
  it('DISCLOSED residual: a REFERENCES clause on the granted table names its target — whose rows stay ABSENT', () => {
    const bytes = sourceBytes([
      'CREATE TABLE accounts (id INTEGER PRIMARY KEY, api_key TEXT)',
      "INSERT INTO accounts (id, api_key) VALUES (1, 'hunter2')",
      'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER, account_id INTEGER REFERENCES accounts(id))',
      'INSERT INTO transactions (id, amount, account_id) VALUES (1, 450, 1)',
    ]);
    const scope = { tables: [{ name: 'transactions', columns: ['id', 'amount', 'account_id'] }] };
    expect(rowsOf(read(bytes, `SELECT "table", "to" FROM pragma_foreign_key_list('transactions')`, scope))).toEqual([['accounts', 'id']]);
    for (const sql of ['SELECT * FROM accounts', 'SELECT * FROM main.accounts', 'SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account_id']) {
      const result = read(bytes, sql, scope);
      expect(result.ok, sql).toBe(false);
      if (!result.ok) expect(result.message, sql).toMatch(/no such table/);
    }
  });

  it('PRAGMA query_only is ON for the statement (read through the table-valued pragma, which the guards admit)', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT query_only FROM pragma_query_only');
    expect(rowsOf(result)).toEqual([[1]]);
  });

  it('a credential-named column of a granted table is never in scope — and an alias cannot carry its value out: it crosses as ***', () => {
    const scope = { tables: [{ name: 'accounts', columns: ['name', 'balance'] }] };
    const result = read(sourceBytes(LEDGER), 'SELECT name, api_key AS harmless, api_key FROM accounts', scope);
    expect(rowsOf(result)).toEqual([['checking', '***', '***']]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('the withheld column survives NOT NULL, UNIQUE and a generated copy of it — the scrub never leaks and never refuses', () => {
    const bytes = sourceBytes([
      'CREATE TABLE keys (label TEXT, password TEXT NOT NULL UNIQUE, shadow TEXT GENERATED ALWAYS AS (password) VIRTUAL)',
      "INSERT INTO keys (label, password) VALUES ('a', 'pw-one'), ('b', 'pw-two')",
    ]);
    // `shadow` is generated from the withheld column but is not credential-NAMED, so the sheet
    // discloses it (table_xinfo) and the scope records it; it crosses recomputed from the mask.
    const result = read(bytes, 'SELECT label, password, shadow FROM keys ORDER BY label', { tables: [{ name: 'keys', columns: ['label', 'shadow'] }] });
    const rows = rowsOf(result);
    expect(rows.map((row) => row[0])).toEqual(['a', 'b']);
    expect(JSON.stringify(rows)).not.toMatch(/pw-one|pw-two/);
  });
  // W6 finding 26 — the ORDER, not only the end state: the withhold UPDATE runs on a copy whose
  // triggers are already gone. A trigger on a GRANTED table that fires on an UPDATE of the
  // credential column would otherwise copy the secret into a column the reader may read.
  it('triggers are dropped BEFORE the credential withhold: an UPDATE trigger cannot copy the secret into a readable column', () => {
    const bytes = sourceBytes([
      'CREATE TABLE accounts (name TEXT, balance INTEGER, api_key TEXT)',
      "INSERT INTO accounts (name, balance, api_key) VALUES ('checking', 100, 'hunter2')",
      'CREATE TRIGGER leak AFTER UPDATE OF api_key ON accounts BEGIN UPDATE accounts SET name = OLD.api_key; END',
    ]);
    const result = read(bytes, 'SELECT name, api_key FROM accounts', { tables: [{ name: 'accounts', columns: ['name', 'balance'] }] });
    expect(rowsOf(result)).toEqual([['checking', '***']]);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});

// W6 finding 1 — the VALUE mask lives on the copy, where the reader's SQL cannot reach behind it:
// a credential-shaped value under a NEUTRAL column is overwritten before the statement runs, so
// no transform in the reader's own statement (a prefix, hex, substr, a cast) carries it out.
describe('scopedScratchRead — a credential-shaped VALUE under a neutral column is masked on the copy', () => {
  const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const SETTINGS = [
    'CREATE TABLE settings (name TEXT, value TEXT)',
    `INSERT INTO settings (name, value) VALUES ('anthropic', '${KEY}'), ('session', 'Bearer ${JWT}'), ('theme', 'dark')`,
  ];
  const GRANT_SETTINGS = { tables: [{ name: 'settings', columns: ['name', 'value'] }] };
  const leaks = (result: ScopedReadResult): boolean => /sk-ant-api03|eyJhbGci|abcdefghijklmnop|Bearer/.test(JSON.stringify(result));

  it('a direct read answers *** for the credential cells and the ordinary cell as it is', () => {
    const result = read(sourceBytes(SETTINGS), 'SELECT name, value FROM settings ORDER BY name', GRANT_SETTINGS);
    expect(rowsOf(result)).toEqual([['anthropic', '***'], ['session', '***'], ['theme', 'dark']]);
  });

  it('a transform in the reader\'s statement carries nothing out — prefix, hex, substr, cast, replace, unicode walk', () => {
    const bytes = sourceBytes(SETTINGS);
    for (const sql of [
      "SELECT ' ' || value AS v FROM settings",
      'SELECT hex(value) FROM settings',
      'SELECT substr(value, 4) FROM settings',
      'SELECT CAST(value AS BLOB) FROM settings',
      "SELECT replace(value, 'sk-', 'xx-') FROM settings",
      'SELECT group_concat(unicode(substr(value, 8, 1))) FROM settings',
      'SELECT lower(value), upper(value) FROM settings',
    ]) {
      const result = read(bytes, sql, GRANT_SETTINGS);
      expect(result.ok, sql).toBe(true);
      expect(leaks(result), sql).toBe(false);
      // hex/unicode of the KEY's distinctive tail would read as these:
      expect(JSON.stringify(result), sql).not.toMatch(/616263646566|736B2D616E74/i);
    }
  });

  it('a credential stored as a BLOB is masked too (a CAST would otherwise read it as text)', () => {
    const db = new SQL.Database();
    let bytes: Uint8Array;
    try {
      db.run('CREATE TABLE blobs (label TEXT, body BLOB)');
      db.run('INSERT INTO blobs (label, body) VALUES (?, ?)', ['k', new TextEncoder().encode(KEY)]);
      bytes = db.export();
    } finally {
      db.close();
    }
    const result = read(bytes, "SELECT label, CAST(body AS TEXT), ' ' || CAST(body AS TEXT) FROM blobs", { tables: [{ name: 'blobs', columns: ['label', 'body'] }] });
    expect(result.ok).toBe(true);
    expect(leaks(result)).toBe(false);
  });

  it('two different credentials under a UNIQUE NOT NULL column are both masked — the constraint never makes the mask refuse', () => {
    const bytes = sourceBytes([
      'CREATE TABLE vault (label TEXT, body TEXT NOT NULL UNIQUE)',
      `INSERT INTO vault (label, body) VALUES ('a', '${KEY}'), ('b', 'Bearer ${JWT}'), ('c', 'plain')`,
    ]);
    const result = read(bytes, "SELECT label, '>' || body FROM vault ORDER BY label", { tables: [{ name: 'vault', columns: ['label', 'body'] }] });
    expect(result.ok).toBe(true);
    expect(leaks(result)).toBe(false);
    expect(rowsOf(result)[2]).toEqual(['c', '>plain']);
  });

  it('a GENERATED column derived from a masked neutral column recomputes from the mask', () => {
    const bytes = sourceBytes([
      'CREATE TABLE s (name TEXT, value TEXT, shout TEXT GENERATED ALWAYS AS (upper(value)) VIRTUAL)',
      `INSERT INTO s (name, value) VALUES ('k', '${KEY}')`,
    ]);
    const result = read(bytes, "SELECT ' ' || shout FROM s", { tables: [{ name: 's', columns: ['name', 'value', 'shout'] }] });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SK-ANT-API03/);
  });

  it('a GENERATED column that BUILDS a credential the copy cannot overwrite fails the read closed, as a scoping failure', () => {
    const bytes = sourceBytes([
      "CREATE TABLE s (name TEXT, tail TEXT, built TEXT GENERATED ALWAYS AS ('sk-ant-api03-' || tail) VIRTUAL)",
      "INSERT INTO s (name, tail) VALUES ('k', 'abcdefghijklmnopqrstuvwxyz0123')",
    ]);
    const result = read(bytes, "SELECT ' ' || built FROM s", { tables: [{ name: 's', columns: ['name', 'tail', 'built'] }] });
    expect(result).toMatchObject({ ok: false, reason: 'copy-failed' });
    expect(JSON.stringify(result)).not.toMatch(/sk-ant-api03-abcdef/);
  });
});

// W6 finding 12 — the engine's fail-closed scoping failures are a TYPED arm, so the host never
// parses prose to learn that a message names an object of the source.
describe('scopedScratchRead — a scoping failure is its own reason, never "failed"', () => {
  it('a credential column no value can be written to (STRICT BLOB NOT NULL) answers copy-failed — and nothing is run', () => {
    const spy = spyEngine();
    const bytes = sourceBytes([
      'CREATE TABLE k (label TEXT, api_key BLOB NOT NULL) STRICT',
      "INSERT INTO k (label, api_key) VALUES ('a', X'68756E74657232')",
    ]);
    const statement = 'SELECT label FROM k';
    const result = scopedScratchRead(spy.engine, bytes, { tables: [{ name: 'k', columns: ['label'] }] }, { sql: statement }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'copy-failed' });
    expect(spy.seen).not.toContain(statement);
  });

  it('an ordinary SQL error is still "failed" (the twin)', () => {
    expect(read(sourceBytes(LEDGER), 'SELECT nope FROM transactions')).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('scopedScratchRead — the two guards, in order (isReadOnlySelect THEN forbiddenStatementReason)', () => {
  it('`PRAGMA query_only = 0; SELECT 1` is refused by the FIRST guard and never reaches the engine', () => {
    const spy = spyEngine();
    const statement = 'PRAGMA query_only = 0; SELECT 1';
    const result = scopedScratchRead(spy.engine, sourceBytes(LEDGER), GRANT_TRANSACTIONS, { sql: statement }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    if (!result.ok) expect(result.message).toMatch(/one read-only SELECT/);
    expect(spy.seen).not.toContain(statement);
  });

  it('PRAGMA, ATTACH, DETACH, multi-statement text and a CTE write are each refused by the first guard', () => {
    for (const statement of [
      'PRAGMA writable_schema = 1',
      "ATTACH DATABASE 'x.db' AS x",
      'DETACH DATABASE main',
      'SELECT 1; SELECT 2',
      'SELECT 1; PRAGMA query_only = 0',
      'WITH doomed AS (SELECT id FROM transactions) DELETE FROM transactions WHERE id IN (SELECT id FROM doomed)',
      "SELECT * FROM transactions WHERE note = 'x' AND 1 IN (SELECT 1) ; ATTACH 'y' AS y",
    ]) {
      const spy = spyEngine();
      const result = scopedScratchRead(spy.engine, sourceBytes(LEDGER), GRANT_TRANSACTIONS, { sql: statement }, CAPS);
      expect(result, statement).toMatchObject({ ok: false, reason: 'refused' });
      if (!result.ok) expect(result.message, statement).toMatch(/one read-only SELECT/);
      expect(spy.seen, statement).not.toContain(statement);
    }
  });

  it('a statement that passes the first guard is still refused by the SECOND (load_extension) — and never runs', () => {
    const spy = spyEngine();
    const statement = "SELECT load_extension('evil')";
    const result = scopedScratchRead(spy.engine, sourceBytes(LEDGER), GRANT_TRANSACTIONS, { sql: statement }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    if (!result.ok) expect(result.message).toMatch(/load_extension\(\) is not allowed/);
    expect(spy.seen).not.toContain(statement);
  });

  it('a write is refused and the input bytes are byte-identical afterwards — on a refusal and on a read alike', () => {
    const bytes = sourceBytes(LEDGER);
    const before = bytes.slice();
    for (const statement of ["INSERT INTO transactions (amount) VALUES (1)", "UPDATE transactions SET note = 'x'", 'DROP TABLE transactions']) {
      const result = read(bytes, statement);
      expect(result, statement).toMatchObject({ ok: false, reason: 'refused' });
    }
    expect(read(bytes, 'SELECT COUNT(*) FROM transactions').ok).toBe(true);
    expect(bytes).toEqual(before);
    // And a later read of the same bytes still sees every table of the source: the drops happened on the copy.
    expect(rowsOf(read(bytes, 'SELECT COUNT(*) FROM secrets', { tables: [{ name: 'secrets', columns: ['value'] }] }))).toEqual([[1]]);
  });
});

describe('scopedScratchRead — row and byte caps (truncated / totalRows exactly as scratchRun reports them)', () => {
  function manyRows(count: number, text: (i: number) => string): Uint8Array {
    const db = new SQL.Database();
    try {
      db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
      const insert = db.prepare('INSERT INTO items (id, label) VALUES (?, ?)');
      try {
        for (let i = 1; i <= count; i += 1) insert.run([i, text(i)]);
      } finally {
        insert.free();
      }
      return db.export();
    } finally {
      db.close();
    }
  }
  const ITEMS = { tables: [{ name: 'items', columns: ['id', 'label'] }] };

  it(`caps rows at ${ACCESS_MAX_ROWS} and says so, with the honest total`, () => {
    const result = read(manyRows(ACCESS_MAX_ROWS + 100, (i) => `row ${i}`), 'SELECT id, label FROM items ORDER BY id', ITEMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(ACCESS_MAX_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.totalRows).toBe(ACCESS_MAX_ROWS + 100);
  });

  it('a result that fits carries neither truncated nor totalRows', () => {
    const result = read(manyRows(10, (i) => `row ${i}`), 'SELECT id FROM items', ITEMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(10);
    expect('truncated' in result).toBe(false);
    expect('totalRows' in result).toBe(false);
  });

  it('the byte cap is measured in UTF-8 BYTES: a CJK row set at the cap still crosses frameWithinLimits', () => {
    // 1000 CJK characters = 3000 UTF-8 bytes but only 1000 UTF-16 units: a character-count
    // measure would keep three times the bytes the cap allows and overflow the frame class.
    const cjk = '漢'.repeat(1000);
    const result = read(manyRows(400, () => cjk), 'SELECT id, label FROM items ORDER BY id', ITEMS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.totalRows).toBe(400);
    const kept = result.rows.reduce((sum, row) => sum + utf8ByteLength(JSON.stringify(row)), 0);
    expect(kept).toBeLessThanOrEqual(ACCESS_MAX_RESULT_BYTES);
    // One more row would have crossed the cap — the cap is filled, not under-used.
    expect(kept + utf8ByteLength(JSON.stringify(result.rows[0]))).toBeGreaterThan(ACCESS_MAX_RESULT_BYTES);
    const frame = accessResponseSchema.parse({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'req-1',
      ok: true,
      op: 'query',
      columns: result.columns,
      rows: result.rows,
      truncated: result.truncated,
      totalRows: result.totalRows,
    }) as Frame;
    expect(frameWithinLimits(frame)).toBe(true);
  });
});

describe('scopedScratchRead — column drift is REPORTED and the statement is not run', () => {
  it('a recorded column the source no longer has → drift.removed, nothing run', () => {
    const spy = spyEngine();
    const statement = 'SELECT id FROM transactions';
    const scope = { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category', 'note', 'memo'] }] };
    const result = scopedScratchRead(spy.engine, sourceBytes(LEDGER), scope, { sql: statement }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'drift', drift: { added: [], removed: ['transactions.memo'] } });
    expect(spy.seen).not.toContain(statement);
  });

  it('a column the source GAINED → drift.added, nothing run', () => {
    const spy = spyEngine();
    const statement = 'SELECT id FROM transactions';
    const bytes = sourceBytes([...LEDGER, 'ALTER TABLE transactions ADD COLUMN tag TEXT']);
    const result = scopedScratchRead(spy.engine, bytes, GRANT_TRANSACTIONS, { sql: statement }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'drift', drift: { added: ['transactions.tag'], removed: [] } });
    expect(spy.seen).not.toContain(statement);
  });

  it('a granted table that no longer exists is drift: every recorded column removed', () => {
    const scope = { tables: [{ name: 'budgets', columns: ['month', 'limit_cents'] }] };
    const result = read(sourceBytes(LEDGER), 'SELECT 1', scope);
    expect(result).toMatchObject({ ok: false, reason: 'drift', drift: { added: [], removed: ['budgets.month', 'budgets.limit_cents'] } });
  });

  // Review finding 3: generated columns are columns of the copy — a SELECT answers them — so
  // the drift check sees them (`table_xinfo`, hidden 2/3), symmetric with describeAppData.
  const GENERATED = [
    'CREATE TABLE t (name TEXT, password TEXT, shadow TEXT GENERATED ALWAYS AS (password) STORED, name_copy TEXT GENERATED ALWAYS AS (name) VIRTUAL)',
    "INSERT INTO t (name, password) VALUES ('a', 'pw-one')",
  ];

  it('a GENERATED column (stored or virtual) the scope does not record is drift.added — it is never read undisclosed', () => {
    const result = read(sourceBytes(GENERATED), 'SELECT name, name_copy FROM t', { tables: [{ name: 't', columns: ['name'] }] });
    expect(result).toMatchObject({ ok: false, reason: 'drift', drift: { added: ['t.shadow', 't.name_copy'], removed: [] } });
  });

  it('a scope that records the generated columns reads without drift — the generated copy of a withheld column crosses as the mask', () => {
    const result = read(sourceBytes(GENERATED), 'SELECT name, shadow, name_copy FROM t', { tables: [{ name: 't', columns: ['name', 'shadow', 'name_copy'] }] });
    expect(rowsOf(result)).toEqual([['a', '***', 'a']]);
  });

  it('a credential-named column the source gained is NOT drift (D23 — it was never shareable) and the read answers', () => {
    const bytes = sourceBytes([...LEDGER, 'ALTER TABLE transactions ADD COLUMN api_key TEXT']);
    const result = read(bytes, 'SELECT id FROM transactions ORDER BY id');
    expect(rowsOf(result)).toEqual([[1], [2], [3]]);
  });
});

describe('scopedScratchRead — errors are data, and the scratch is always closed', () => {
  it('a SQL error answers { ok: false, reason: "failed", message }', () => {
    const result = read(sourceBytes(LEDGER), 'SELECT nope FROM transactions');
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    if (!result.ok) expect(result.message).toMatch(/no such column: nope/);
  });

  it('bytes that are not a database answer "failed", never a throw', () => {
    const result = read(new TextEncoder().encode('not a database at all, just text'), 'SELECT 1');
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
  });

  it('opens ONE fresh scratch per call and closes it on every path — read, refusal, drift, failure', () => {
    const cases: Array<[string, Parameters<typeof scopedScratchRead>[2]]> = [
      ['SELECT id FROM transactions', GRANT_TRANSACTIONS],
      ['DELETE FROM transactions', GRANT_TRANSACTIONS],
      ['SELECT id FROM transactions', { tables: [{ name: 'transactions', columns: ['id'] }] }],
      ['SELECT nope FROM transactions', GRANT_TRANSACTIONS],
    ];
    for (const [statement, scope] of cases) {
      const spy = spyEngine();
      scopedScratchRead(spy.engine, sourceBytes(LEDGER), scope, { sql: statement }, CAPS);
      expect(spy.opened, statement).toBe(1);
      expect(spy.closed(), statement).toBe(1);
    }
  });
});

describe('one per-statement runner (scratchRun and scopedScratchRead share it)', () => {
  const source = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

  it('both callers import the shared runner, and neither steps a statement itself', () => {
    const userdb = source('../userdb/userdb.ts');
    const scoped = source('../scoped-read.ts');
    for (const [name, text] of [
      ['userdb.ts', userdb],
      ['scoped-read.ts', scoped],
    ] as const) {
      expect(text, name).toMatch(/import \{[^}]*\brunScratchStatement\b[^}]*\} from '\.\/(?:userdb\/)?scratch-statement\.js'/);
      expect(text, name).not.toMatch(/iterateStatements\(/);
    }
  });
});
