/**
 * TASK-20261010-host-broker PR-3 (contract v2 D-PR3-9 / D-PR3-10 / D-PR3-12; AC19) — the PURE half of
 * the Write Broker, `packages/db/src/brokered-write.ts`: parse, facts, plan, apply, undo.
 *
 * One plain DML only — `INSERT INTO t (cols) VALUES …`, `UPDATE t SET c = <value> … WHERE <terms>`,
 * `DELETE FROM t WHERE <terms>` — whose values are literals or placeholders and whose WHERE is
 * simple comparisons on columns joined by AND/OR/NOT; any other token is refused BY NAME. The table
 * rules (`tableFacts`) are decided from the SCHEMA, never from a row's value, and run at BOTH seats:
 * on the raw copy when the Worker plans, and AGAIN on the live handle when the driver applies. The
 * plan dry-runs on a scoped copy built `forPlan` (no `query_only`, `ignore_check_constraints` reset)
 * and answers counts only — no row, no value. The apply is SYNCHRONOUS on a real handle:
 * `BEGIN IMMEDIATE`, a TEMP trigger capture under per-apply names, the statement, the checks,
 * `COMMIT` — a `committed` flag and a ROLLBACK in `finally`. The undo is BUILT from the captured
 * rows (never from statement text), guarded by the values the write left, and fails whole.
 *
 * Written BEFORE the module existed (Gate 3). The module is loaded through a VARIABLE specifier so a
 * missing module reds each row on its own (docs/lessons.md 2026-10-11): a literal dynamic import of
 * a missing module fails the whole file at transform time. The types were LOCAL STRUCTURAL copies of
 * the contract's ("Module contracts (the wire) → packages/db"); the implementation lane swapped them
 * for the module's own exports (type-only imports, erased at transform time).
 *
 * Mutation checks (to run by hand once the module lands — remove the rule, see the named row red):
 *  - admit a function call / CASE / arithmetic → the matching "refused BY NAME" rows red;
 *  - drop the TEMP-trigger check (sqlite_temp_master) → "a TEMP trigger on the table …" reds;
 *  - run the column rule after the dry run → the "BEFORE any dry run" rows red (the spy sees the statement);
 *  - keep `ignore_check_constraints = 1` on the plan copy → "a CHECK the write would break fails the dry run" reds;
 *  - ROLLBACK in `finally` even when BEGIN IMMEDIATE failed → "busy … the outer transaction is left as it was" reds;
 *  - drop the capture objects only on success → "the per-apply temp names … gone after every path" reds;
 *  - drop the `after` guard from the undo → "a row changed since → the WHOLE undo rolls back" reds.
 */

import { ACCESS_PARAM_STRING_MAX_CHARS } from '@snugprotocol/protocol';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { BrokeredApplyInput, BrokeredApplyResult, BrokeredCaps, BrokeredOp, BrokeredParseResult, BrokeredPlan, BrokeredPlanResult, ParsedDml, UndoRow, UndoStep } from '../brokered-write.js';
import { scopedScratchRead, type ScopedReadScope } from '../scoped-read.js';
import { locateWasm } from './helpers.js';

// ------------------------------------------------------------------ the contract's shapes

/** The module's own types — type-only, erased, so the variable specifier below still isolates a missing module. */
type BrokeredWriteModule = typeof import('../brokered-write.js');
/** One granted table as the scope spells it. */
type ScopeTable = ScopedReadScope['tables'][number];

/** The module, through a VARIABLE specifier: a missing module reds each row, never the file. */
const MODULE = '../brokered-write.js';
let loading: Promise<BrokeredWriteModule> | undefined;
function brokered(): Promise<BrokeredWriteModule> {
  loading ??= import(/* @vite-ignore */ MODULE) as Promise<BrokeredWriteModule>;
  return loading;
}

// --------------------------------------------------------------------------------- fixtures

let SQL: SqlJsStatic;

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: locateWasm });
});

/** A LIVE handle shaped the way an app's own SQL would have shaped it. */
function handle(statements: readonly string[]): Database {
  const db = new SQL.Database();
  for (const statement of statements) db.run(statement);
  return db;
}

/** The same shape as bytes — what the Worker plans on. */
function bytesOf(statements: readonly string[]): Uint8Array {
  const db = handle(statements);
  try {
    return db.export();
  } finally {
    db.close();
  }
}

function all(db: Database, sql: string): unknown[][] {
  return db.exec(sql)[0]?.values ?? [];
}

/** Every row of a table with its rowid, in rowid order — the "nothing changed" oracle. */
function dump(db: Database, table: string): unknown[][] {
  try {
    return all(db, `SELECT rowid, * FROM "${table}" ORDER BY rowid`);
  } catch {
    return all(db, `SELECT * FROM "${table}" ORDER BY 1`); // a WITHOUT ROWID table has no rowid
  }
}

/** Every TEMP object on the handle (the capture's table and trigger must never outlive an apply). */
const tempObjects = (db: Database): string[] => all(db, 'SELECT name FROM sqlite_temp_master').map((row) => String(row[0]));

/** Whether the handle is inside a transaction: a BEGIN fails "within a transaction". */
function openTransaction(db: Database): boolean {
  try {
    db.run('BEGIN');
  } catch {
    return true;
  }
  db.run('ROLLBACK');
  return false;
}

/**
 * A watch over ONE handle: every SQL text it is asked to run/exec/prepare/iterate, and an injected
 * failure for the texts a predicate picks (the "a step throws mid-apply" probe).
 */
function watch(db: Database): { seen: string[]; failWhen: (test: ((sql: string) => boolean) | undefined) => void } {
  const seen: string[] = [];
  let fail: ((sql: string) => boolean) | undefined;
  const target = db as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of ['run', 'exec', 'prepare', 'iterateStatements'] as const) {
    const original = target[method]!.bind(db);
    target[method] = (sql: unknown, ...rest: unknown[]) => {
      seen.push(String(sql));
      if (fail?.(String(sql)) === true) throw new Error('injected failure');
      return original(sql, ...rest);
    };
  }
  return { seen, failWhen: (test) => (fail = test) };
}

/**
 * A spy over the ENGINE the planner is handed: every SQL text any handle it opens is asked to run.
 * Proves "refused BEFORE any dry run" without reaching into the implementation (the scoped-read
 * suite's technique).
 */
function spyEngine(): { engine: SqlJsStatic; seen: string[] } {
  const seen: string[] = [];
  const Real = SQL.Database;
  class SpyDatabase extends Real {
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
  }
  return { engine: { ...SQL, Database: SpyDatabase } as unknown as SqlJsStatic, seen };
}

const LEDGER = [
  'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, note TEXT)',
  "INSERT INTO transactions (id, amount, category, note) VALUES (1, 450, 'food', 'coffee'), (2, 120000, 'home', 'rent'), (3, 500, 'food', 'tea')",
  'CREATE TABLE accounts (name TEXT, balance INTEGER, api_key TEXT)',
  "INSERT INTO accounts (name, balance, api_key) VALUES ('checking', 100, 'hunter2')",
];
const TX_COLUMNS = ['id', 'amount', 'category', 'note'];
const WRITE_TX: ScopedReadScope = { tables: [{ name: 'transactions', columns: TX_COLUMNS, write: true }] };
/** The contract's caps: ACCESS_WRITE_MAX_ROWS (200) and ACCESS_UNDO_MAX_BYTES (64 KiB) — passed in, as the engine passes them. */
const CAPS: BrokeredCaps = { maxChanges: 200, maxUndoBytes: 64 * 1024 };

const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

/** A plan as the Worker hands it to the seat — `columns` the granted columns of the table. */
const txPlan = (sql: string, op: BrokeredOp, extra: Partial<BrokeredPlan> = {}): BrokeredPlan => ({
  sql,
  op,
  table: 'transactions',
  columns: [...TX_COLUMNS],
  previewChanges: 0,
  ...extra,
});

const forward = (plans: readonly BrokeredPlan[], over: Partial<Extract<BrokeredApplyInput, { plans: unknown }>> = {}): BrokeredApplyInput => ({
  plans,
  caps: CAPS,
  requireUndo: true,
  capture: true,
  ...over,
});

/** The captured rows in rowid order — the capture's own order is the trigger's, not a contract. */
const byRowid = (steps: readonly UndoStep[]): UndoStep[] => steps.map((step) => ({ ...step, rows: [...step.rows].sort((a, b) => a.rowid - b.rowid) }));

function okApply(result: BrokeredApplyResult): Extract<BrokeredApplyResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected an applied batch, got ${result.reason}: ${result.message}`);
  return result;
}

function okPlan(result: BrokeredPlanResult): BrokeredPlan {
  if (!result.ok) throw new Error(`expected a plan, got ${result.reason}: ${result.message}`);
  return result.plan;
}

function okParse(result: BrokeredParseResult): ParsedDml {
  if (!result.ok) throw new Error(`expected a parse, got refused: ${result.message}`);
  return result.parsed;
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

// =========================================================================== parseBrokeredStatement

describe('parseBrokeredStatement — the admitted shapes and what they answer', () => {
  it('an UPDATE with literal values: op, table, every NAMED column, the SET columns in SET order, the literals', async () => {
    const { parseBrokeredStatement } = await brokered();
    const sql = "UPDATE transactions SET note = 'lunch', category = 'food' WHERE category = 'cafe'";
    const parsed = okParse(parseBrokeredStatement(sql));
    expect(parsed.op).toBe('update');
    expect(parsed.table).toBe('transactions');
    expect(parsed.setColumns).toEqual(['note', 'category']);
    expect(sorted(parsed.columns)).toEqual(['category', 'note']);
    expect(parsed.literals).toEqual(['lunch', 'food', 'cafe']);
    expect(parsed.placeholders).toBe(0);
    expect(parsed.sql).toBe(sql);
    expect(parsed.insertColumns).toBeUndefined();
  });

  it('an INSERT with its REQUIRED column list and several rows of values: insertColumns in list order', async () => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(parseBrokeredStatement("INSERT INTO transactions (id, amount, note) VALUES (7, 12, 'gum'), (?, ?, ?)"));
    expect(parsed.op).toBe('insert');
    expect(parsed.table).toBe('transactions');
    expect(parsed.insertColumns).toEqual(['id', 'amount', 'note']);
    expect(sorted(parsed.columns)).toEqual(['amount', 'id', 'note']);
    expect(parsed.literals).toContain('gum');
    expect(parsed.placeholders).toBe(3);
    expect(parsed.setColumns).toBeUndefined();
  });

  it('a DELETE whose WHERE uses every admitted term — comparisons, IN (…), IS [NOT] NULL, LIKE — joined by AND/OR/NOT with parentheses', async () => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(
      parseBrokeredStatement(
        "DELETE FROM transactions WHERE (category IN ('food', 'cafe', ?) OR note IS NULL) AND NOT (amount >= 100 OR amount < 5) " +
          "AND id <> 3 AND id != 4 AND note LIKE 'c%' AND category IS NOT NULL AND amount <= 9 AND amount > 1 AND id = 2",
      ),
    );
    expect(parsed.op).toBe('delete');
    expect(parsed.table).toBe('transactions');
    expect(sorted(parsed.columns)).toEqual(['amount', 'category', 'id', 'note']);
    expect(parsed.literals).toEqual(expect.arrayContaining(['food', 'cafe', 'c%']));
    expect(parsed.placeholders).toBe(1);
  });

  it.each([['?'], ['?1'], [':note'], ['@note'], ['$note']])('a %s placeholder is a value (counted)', async (placeholder) => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(parseBrokeredStatement(`UPDATE transactions SET note = ${placeholder} WHERE id = 1`));
    expect(parsed.placeholders).toBe(1);
    expect(parsed.setColumns).toEqual(['note']);
  });

  it('three anonymous placeholders count three', async () => {
    const { parseBrokeredStatement } = await brokered();
    expect(okParse(parseBrokeredStatement('UPDATE transactions SET note = ?, category = ? WHERE id = ?')).placeholders).toBe(3);
  });

  it('quoted, bracketed and backtick identifiers are answered UNQUOTED (a doubled quote unescaped)', async () => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(parseBrokeredStatement('UPDATE "transactions" SET [note] = \'x\', `category` = \'y\' WHERE "id" = 1'));
    expect(parsed.table).toBe('transactions');
    expect(parsed.setColumns).toEqual(['note', 'category']);
    expect(sorted(parsed.columns)).toEqual(['category', 'id', 'note']);

    const odd = okParse(parseBrokeredStatement('UPDATE "my""table" SET "a""b" = 1 WHERE id = 2'));
    expect(odd.table).toBe('my"table');
    expect(odd.setColumns).toEqual(['a"b']);
  });

  it('comments, NULL and a trailing semicolon are admitted; a doubled quote inside a string literal unescapes', async () => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(parseBrokeredStatement("/* tidy */ UPDATE transactions SET note = NULL, category = 'it''s' -- a comment\n WHERE id = 1; -- done"));
    expect(parsed.setColumns).toEqual(['note', 'category']);
    expect(parsed.literals).toContain("it's");
  });

  it('SQL words inside a string literal are a literal, never a token', async () => {
    const { parseBrokeredStatement } = await brokered();
    const parsed = okParse(parseBrokeredStatement("UPDATE transactions SET note = 'SELECT lower(x) CASE; DROP TABLE t' WHERE id = 1"));
    expect(parsed.literals).toContain('SELECT lower(x) CASE; DROP TABLE t');
  });
});

describe('parseBrokeredStatement — every other shape is REFUSED, by name', () => {
  // [label, sql, what the message names (when the refusal is a token)]
  const REFUSED: Array<[string, string, RegExp | undefined]> = [
    ['a function call in SET', "UPDATE transactions SET note = lower('X') WHERE id = 1", /lower/i],
    ['a function call in WHERE', 'DELETE FROM transactions WHERE length(note) > 3', /length/i],
    ['CASE', "UPDATE transactions SET note = CASE WHEN id = 1 THEN 'a' ELSE 'b' END WHERE id = 1", /case/i],
    ['arithmetic in SET', 'UPDATE transactions SET amount = 1 + 1 WHERE id = 1', /\+/],
    ['arithmetic in WHERE', 'DELETE FROM transactions WHERE id = 2 * 1', /\*/],
    ['concatenation', "UPDATE transactions SET note = 'a' || 'b' WHERE id = 1", /\|\|/],
    ['a column as a value', 'UPDATE transactions SET note = category WHERE id = 1', undefined],
    ['a column compared to a column', 'DELETE FROM transactions WHERE amount = id', undefined],
    ['a literal compared to a literal (always true)', 'DELETE FROM transactions WHERE id = 1 OR 1 = 1', undefined],
    ['a WHERE that is a bare literal', 'DELETE FROM transactions WHERE 1', undefined],
    ['a t.col qualifier in WHERE', 'DELETE FROM transactions WHERE transactions.id = 1', undefined],
    ['a t.col qualifier in SET', "UPDATE transactions SET transactions.note = 'x' WHERE id = 1", undefined],
    ['a schema qualifier', "UPDATE main.transactions SET note = 'x' WHERE id = 1", undefined],
    ['a subquery', 'DELETE FROM transactions WHERE id IN (SELECT rowid FROM accounts)', /select/i],
    ['EXISTS', 'DELETE FROM transactions WHERE EXISTS (SELECT 1)', /exists|select/i],
    ['RETURNING', "UPDATE transactions SET note = 'x' WHERE id = 1 RETURNING note", /returning/i],
    ['ON CONFLICT', "INSERT INTO transactions (id, amount, note) VALUES (1, 1, 'x') ON CONFLICT DO NOTHING", /\bon\b|conflict/i],
    ['INSERT OR REPLACE', "INSERT OR REPLACE INTO transactions (id, amount, note) VALUES (1, 1, 'x')", /\bor\b|replace/i],
    ['INSERT OR IGNORE', "INSERT OR IGNORE INTO transactions (id, amount, note) VALUES (1, 1, 'x')", /\bor\b|ignore/i],
    ['UPDATE OR REPLACE', "UPDATE OR REPLACE transactions SET note = 'x' WHERE id = 1", /\bor\b|replace/i],
    ['REPLACE INTO', "REPLACE INTO transactions (id, amount, note) VALUES (1, 1, 'x')", /replace/i],
    ['an UPDATE without WHERE', "UPDATE transactions SET note = 'x'", /where/i],
    ['a DELETE without WHERE', 'DELETE FROM transactions', /where/i],
    ['an INSERT without a column list', "INSERT INTO transactions VALUES (9, 1, 'a', 'b')", undefined],
    ['DEFAULT VALUES', 'INSERT INTO transactions DEFAULT VALUES', /default/i],
    ['INSERT … SELECT', 'INSERT INTO transactions (id) SELECT rowid FROM accounts', /select/i],
    ['UPDATE … FROM', "UPDATE transactions SET note = 'x' FROM accounts WHERE id = 1", /from/i],
    ['two statements', "UPDATE transactions SET note = 'x' WHERE id = 1; DELETE FROM transactions WHERE id = 2", undefined],
    ['WITH', "WITH x AS (SELECT 1) UPDATE transactions SET note = 'x' WHERE id = 1", /with/i],
    ['ORDER BY', 'DELETE FROM transactions WHERE id > 0 ORDER BY id', /order/i],
    ['LIMIT', 'DELETE FROM transactions WHERE id > 0 LIMIT 1', /limit/i],
    ['BETWEEN (not an admitted term)', 'DELETE FROM transactions WHERE id BETWEEN 1 AND 2', /between/i],
    ['GLOB (not an admitted term)', "DELETE FROM transactions WHERE note GLOB 'c*'", /glob/i],
    ['a SELECT', 'SELECT * FROM transactions', undefined],
    ['DDL', 'DROP TABLE transactions', undefined],
    ['a PRAGMA', 'PRAGMA foreign_keys = OFF', undefined],
    ['an unterminated string', "UPDATE transactions SET note = 'x WHERE id = 1", undefined],
    ['nothing at all', '   -- only a comment', undefined],
  ];

  it.each(REFUSED)('%s → refused', async (_label, sql, names) => {
    const { parseBrokeredStatement } = await brokered();
    const result = parseBrokeredStatement(sql);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('refused');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    if (names !== undefined) expect(result.message).toMatch(names);
  });
});

// ==================================================================================== dmlTargetTable

describe('dmlTargetTable — the first identifier after the DML verb, comment-stripped and unquoted (the write signal’s table)', () => {
  it.each([
    ["INSERT INTO scores (name) VALUES ('ada')", 'scores'],
    ["INSERT OR REPLACE INTO \"scores\" (name) VALUES ('ada')", 'scores'],
    ["REPLACE INTO [scores] (name) VALUES ('ada')", 'scores'],
    ["UPDATE scores SET name = 'x' WHERE 1", 'scores'],
    ["UPDATE OR IGNORE `scores` SET name = 'x'", 'scores'],
    ['DELETE FROM scores WHERE points < 0', 'scores'],
    ['/* tidy */ delete from Scores', 'Scores'],
    ['-- a note\nINSERT INTO scores (name) VALUES (1)', 'scores'],
    ['UPDATE "my""table" SET a = 1', 'my"table'],
  ])('%s → %s', async (sql, table) => {
    const { dmlTargetTable } = await brokered();
    expect(dmlTargetTable(sql)).toBe(table);
  });

  it.each([['SELECT * FROM scores'], ['CREATE TABLE scores (name TEXT)'], ['WITH x AS (SELECT 1) DELETE FROM scores'], ['PRAGMA user_version'], ['']])(
    '%s → undefined (it cannot tell)',
    async (sql) => {
      const { dmlTargetTable } = await brokered();
      expect(dmlTargetTable(sql)).toBeUndefined();
    },
  );
});

// ======================================================================================= tableFacts

describe('tableFacts — the table rules, from the schema and the scope (never from a row)', () => {
  it('an ordinary table answers its columns with the generated flag (table_xinfo)', async () => {
    const { tableFacts } = await brokered();
    const db = handle(['CREATE TABLE g (id INTEGER PRIMARY KEY, note TEXT, shout TEXT GENERATED ALWAYS AS (upper(note)) VIRTUAL)']);
    expect(tableFacts(db, 'g', { columns: ['id', 'note', 'shout'] }, 'update')).toEqual({
      ok: true,
      columns: [
        { name: 'id', generated: false },
        { name: 'note', generated: false },
        { name: 'shout', generated: true },
      ],
    });
    db.close();
  });

  it('a table that does not exist, or a view, is refused', async () => {
    const { tableFacts } = await brokered();
    const db = handle([...LEDGER, "CREATE VIEW food AS SELECT * FROM transactions WHERE category = 'food'"]);
    expect(tableFacts(db, 'budgets', { columns: ['id'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'food', { columns: TX_COLUMNS }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    db.close();
  });

  it('an app trigger ON the table is refused; a trigger on ANOTHER table is not', async () => {
    const { tableFacts } = await brokered();
    const onIt = handle([...LEDGER, 'CREATE TRIGGER audit AFTER UPDATE ON transactions BEGIN SELECT 1; END']);
    expect(tableFacts(onIt, 'transactions', { columns: TX_COLUMNS }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    onIt.close();
    const elsewhere = handle([...LEDGER, 'CREATE TRIGGER audit AFTER UPDATE ON accounts BEGIN SELECT 1; END']);
    expect(tableFacts(elsewhere, 'transactions', { columns: TX_COLUMNS }, 'update')).toMatchObject({ ok: true });
    elsewhere.close();
  });

  it('a TEMP trigger on the table (sqlite_temp_master — it lives only on the live handle) is refused', async () => {
    const { tableFacts } = await brokered();
    const db = handle([...LEDGER, 'CREATE TEMP TRIGGER sneaky BEFORE DELETE ON transactions BEGIN SELECT 1; END']);
    expect(tableFacts(db, 'transactions', { columns: TX_COLUMNS }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    db.close();
  });

  it('a virtual table (fts4 — this build has no fts5) and its shadow table are refused', async () => {
    const { tableFacts } = await brokered();
    const db = handle(['CREATE VIRTUAL TABLE docs USING fts4(body)', "INSERT INTO docs (body) VALUES ('hello')"]);
    expect(tableFacts(db, 'docs', { columns: ['body'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'docs_content', { columns: ['docid', 'c0body'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    db.close();
  });

  it('a WITHOUT ROWID table is refused (pragma_table_list.wr)', async () => {
    const { tableFacts } = await brokered();
    const db = handle(['CREATE TABLE w (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID']);
    expect(tableFacts(db, 'w', { columns: ['k', 'v'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    db.close();
  });

  it('ON CONFLICT REPLACE anywhere in the CREATE text is refused (any case, any spacing); ON CONFLICT ABORT is not', async () => {
    const { tableFacts } = await brokered();
    for (const ddl of [
      'CREATE TABLE r (id INTEGER PRIMARY KEY, note TEXT UNIQUE ON CONFLICT REPLACE)',
      'CREATE TABLE r (id INTEGER PRIMARY KEY on   conflict\n replace, note TEXT)',
      'CREATE TABLE r (id INTEGER PRIMARY KEY, note TEXT, UNIQUE (note) ON CONFLICT REPLACE)',
    ]) {
      const db = handle([ddl]);
      expect(tableFacts(db, 'r', { columns: ['id', 'note'] }, 'update'), ddl).toMatchObject({ ok: false, reason: 'refused' });
      db.close();
    }
    const abort = handle(['CREATE TABLE r (id INTEGER PRIMARY KEY, note TEXT UNIQUE ON CONFLICT ABORT)']);
    expect(tableFacts(abort, 'r', { columns: ['id', 'note'] }, 'update')).toMatchObject({ ok: true });
    abort.close();
  });

  it('a CHECK is refused when the table has a column outside the scope — and admitted when every column is shared', async () => {
    const { tableFacts } = await brokered();
    const db = handle(['CREATE TABLE budget (id INTEGER PRIMARY KEY, amount INTEGER CHECK (amount >= 0), memo TEXT)']);
    expect(tableFacts(db, 'budget', { columns: ['id', 'amount'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'budget', { columns: ['id', 'amount', 'memo'] }, 'update')).toMatchObject({ ok: true });
    db.close();
    // A credential-named column is never in a scope, so its table's CHECK is always refused.
    const keyed = handle(['CREATE TABLE keyed (id INTEGER PRIMARY KEY, amount INTEGER, api_key TEXT, CHECK (amount > 0))']);
    expect(tableFacts(keyed, 'keyed', { columns: ['id', 'amount'] }, 'update')).toMatchObject({ ok: false, reason: 'refused' });
    keyed.close();
  });

  it('foreign_keys ON: a table some child names with a CASCADE / SET NULL action is refused; foreign_keys OFF, or NO ACTION, is admitted', async () => {
    const { tableFacts } = await brokered();
    const PARENT = [
      'CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO owners (id, name) VALUES (1, 'ada')",
    ];
    for (const action of ['ON DELETE CASCADE', 'ON UPDATE SET NULL']) {
      const db = handle([...PARENT, `CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owners(id) ${action})`]);
      db.run('PRAGMA foreign_keys = ON');
      expect(tableFacts(db, 'owners', { columns: ['id', 'name'] }, 'update'), action).toMatchObject({ ok: false, reason: 'refused' });
      db.run('PRAGMA foreign_keys = OFF');
      expect(tableFacts(db, 'owners', { columns: ['id', 'name'] }, 'update'), action).toMatchObject({ ok: true });
      db.close();
    }
    const plain = handle([...PARENT, 'CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owners(id))']);
    plain.run('PRAGMA foreign_keys = ON');
    expect(tableFacts(plain, 'owners', { columns: ['id', 'name'] }, 'update')).toMatchObject({ ok: true });
    plain.close();
  });

  // Gate-5 SEC-6: a CHILD's insert or update fails by the parent key's existence — a one-bit oracle on
  // a table the reader was not granted — so under foreign_keys = 1 a table holding a foreign key is refused.
  it('foreign_keys ON: a CHILD table (a non-empty pragma_foreign_key_list — even a plain NO ACTION key) is refused `table`, for every op; foreign_keys OFF, the same table is admitted', async () => {
    const { tableFacts } = await brokered();
    const db = handle([
      'CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO owners (id, name) VALUES (1, 'ada')",
      'CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owners(id))',
      'INSERT INTO pets (id, owner) VALUES (1, 1)',
    ]);
    expect(all(db, "SELECT count(*) FROM pragma_foreign_key_list('pets')")).toEqual([[1]]);
    db.run('PRAGMA foreign_keys = 1');
    for (const op of ['insert', 'update', 'delete'] as const) {
      expect(tableFacts(db, 'pets', { columns: ['id', 'owner'] }, op), op).toMatchObject({ ok: false, reason: 'refused', rule: 'table' });
    }
    db.run('PRAGMA foreign_keys = 0');
    for (const op of ['insert', 'update', 'delete'] as const) {
      expect(tableFacts(db, 'pets', { columns: ['id', 'owner'] }, op), op).toMatchObject({ ok: true });
    }
    db.close();
  });

  it('a DELETE needs EVERY live column in the scope: one withheld, a credential-named or a generated column refuses it — the UPDATE on the same table is admitted', async () => {
    const { tableFacts } = await brokered();
    const db = handle([
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, memo TEXT)',
      'CREATE TABLE keyed (id INTEGER PRIMARY KEY, body TEXT, api_key TEXT)',
      'CREATE TABLE gen (id INTEGER PRIMARY KEY, body TEXT, shout TEXT GENERATED ALWAYS AS (upper(body)) VIRTUAL)',
    ]);
    expect(tableFacts(db, 'notes', { columns: ['id', 'body'] }, 'delete')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'notes', { columns: ['id', 'body'] }, 'update')).toMatchObject({ ok: true });
    expect(tableFacts(db, 'keyed', { columns: ['id', 'body'] }, 'delete')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'keyed', { columns: ['id', 'body'] }, 'update')).toMatchObject({ ok: true });
    // A generated column may be LISTED for reads (D-PR3-2) — a DELETE is still refused.
    expect(tableFacts(db, 'gen', { columns: ['id', 'body', 'shout'] }, 'delete')).toMatchObject({ ok: false, reason: 'refused' });
    expect(tableFacts(db, 'notes', { columns: ['id', 'body', 'memo'] }, 'delete')).toMatchObject({ ok: true });
    db.close();
  });
});

// The SAME refusals at BOTH seats: the Worker's plan (tableFacts on the RAW copy) answers early,
// the driver's apply (tableFacts AGAIN on the live handle) is the rule (F3/S13).
describe('tableFacts at BOTH seats — the plan on the raw copy, the apply on the live handle', () => {
  // [label, the source's statements, the scope's table, the statement, its op]
  const BOTH: Array<[string, string[], ScopeTable, string, BrokeredOp]> = [
    [
      'an app trigger on the table',
      ["CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)", "INSERT INTO t (id, note) VALUES (1, 'a')", 'CREATE TRIGGER t_audit AFTER UPDATE ON t BEGIN SELECT 1; END'],
      { name: 't', columns: ['id', 'note'], write: true },
      "UPDATE t SET note = 'x' WHERE id = 1",
      'update',
    ],
    [
      'a virtual table',
      ['CREATE VIRTUAL TABLE t USING fts4(note)', "INSERT INTO t (note) VALUES ('a')"],
      { name: 't', columns: ['note'], write: true },
      "UPDATE t SET note = 'x' WHERE note = 'a'",
      'update',
    ],
    [
      'a WITHOUT ROWID table',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT) WITHOUT ROWID', "INSERT INTO t (id, note) VALUES (1, 'a')"],
      { name: 't', columns: ['id', 'note'], write: true },
      "UPDATE t SET note = 'x' WHERE id = 1",
      'update',
    ],
    [
      'ON CONFLICT REPLACE',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT UNIQUE ON CONFLICT REPLACE)', "INSERT INTO t (id, note) VALUES (1, 'a')"],
      { name: 't', columns: ['id', 'note'], write: true },
      "UPDATE t SET note = 'x' WHERE id = 1",
      'update',
    ],
    [
      'a CHECK with an unshared column',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, memo TEXT, CHECK (length(note) < 100))', "INSERT INTO t (id, note, memo) VALUES (1, 'a', 'm')"],
      { name: 't', columns: ['id', 'note'], withheld: ['memo'], write: true },
      "UPDATE t SET note = 'x' WHERE id = 1",
      'update',
    ],
    [
      'a DELETE on a table with one withheld column',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, memo TEXT)', "INSERT INTO t (id, note, memo) VALUES (1, 'a', 'm')"],
      { name: 't', columns: ['id', 'note'], withheld: ['memo'], write: true },
      'DELETE FROM t WHERE id = 1',
      'delete',
    ],
    [
      'a DELETE on a table with a credential-named column',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, api_key TEXT)', "INSERT INTO t (id, note, api_key) VALUES (1, 'a', 'k')"],
      { name: 't', columns: ['id', 'note'], write: true },
      'DELETE FROM t WHERE id = 1',
      'delete',
    ],
    [
      'a DELETE on a table with a generated column',
      ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT, shout TEXT GENERATED ALWAYS AS (upper(note)) VIRTUAL)', "INSERT INTO t (id, note) VALUES (1, 'a')"],
      { name: 't', columns: ['id', 'note', 'shout'], write: true },
      'DELETE FROM t WHERE id = 1',
      'delete',
    ],
  ];

  it.each(BOTH)('%s — the PLAN refuses it on the raw copy before the statement runs', async (_label, statements, table, sql) => {
    const { planBrokeredWrite } = await brokered();
    const spy = spyEngine();
    const result = planBrokeredWrite(spy.engine, bytesOf(statements), { tables: [table] }, { sql }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(spy.seen).not.toContain(sql);
  });

  it.each(BOTH)('%s — the APPLY refuses it again on the live handle, and nothing changes', async (_label, statements, table, sql, op) => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(statements);
    const before = dump(db, 't');
    const result = applyBrokeredBatch(db, forward([{ sql, op, table: 't', columns: [...table.columns], previewChanges: 1 }], { expectChanges: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(dump(db, 't')).toEqual(before);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('the passing twin: the same table without the rule plans a count and applies it, at both seats', async () => {
    const { planBrokeredWrite, applyBrokeredBatch } = await brokered();
    const statements = ['CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT)', "INSERT INTO t (id, note) VALUES (1, 'a'), (2, 'b')"];
    const sql = 'DELETE FROM t WHERE id = 1';
    const plan = okPlan(planBrokeredWrite(SQL, bytesOf(statements), { tables: [{ name: 't', columns: ['id', 'note'], write: true }] }, { sql }, CAPS));
    expect(plan.previewChanges).toBe(1);
    const db = handle(statements);
    expect(okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [1] }))).changes).toEqual([1]);
    expect(dump(db, 't')).toEqual([[2, 2, 'b']]);
    db.close();
  });

  it('a TEMP trigger and a foreign-key action exist only on the LIVE handle: the apply refuses them there', async () => {
    const { applyBrokeredBatch } = await brokered();
    const temp = handle([...LEDGER, 'CREATE TEMP TRIGGER sneaky AFTER UPDATE ON transactions BEGIN SELECT 1; END']);
    const before = dump(temp, 'transactions');
    const plan = txPlan("UPDATE transactions SET note = 'x' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 });
    expect(applyBrokeredBatch(temp, forward([plan], { expectChanges: [1] }))).toMatchObject({ ok: false, reason: 'refused' });
    expect(dump(temp, 'transactions')).toEqual(before);
    temp.close();

    const fk = handle([
      'CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO owners (id, name) VALUES (1, 'ada'), (2, 'bo')",
      'CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owners(id) ON DELETE CASCADE)',
      'INSERT INTO pets (id, owner) VALUES (1, 1)',
    ]);
    const deleteOwner: BrokeredPlan = { sql: 'DELETE FROM owners WHERE id = 1', op: 'delete', table: 'owners', columns: ['id', 'name'], previewChanges: 1 };
    fk.run('PRAGMA foreign_keys = ON');
    expect(applyBrokeredBatch(fk, forward([deleteOwner], { expectChanges: [1] }))).toMatchObject({ ok: false, reason: 'refused' });
    expect(dump(fk, 'pets')).toEqual([[1, 1, 1]]);
    fk.run('PRAGMA foreign_keys = OFF');
    expect(okApply(applyBrokeredBatch(fk, forward([deleteOwner], { expectChanges: [1] }))).changes).toEqual([1]);
    fk.close();
  });

  it('Gate-5 SEC-6 at the live seat: an INSERT into a foreign-key CHILD is refused `table` under foreign_keys = 1 before any row moves — the passing twin with foreign_keys off applies', async () => {
    const { applyBrokeredBatch } = await brokered();
    const child = handle([
      'CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO owners (id, name) VALUES (1, 'ada')",
      'CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES owners(id))',
    ]);
    const probe: BrokeredPlan = { sql: 'INSERT INTO pets (id, owner) VALUES (5, 2)', op: 'insert', table: 'pets', columns: ['id', 'owner'], insertColumns: ['id', 'owner'], previewChanges: 1 };
    child.run('PRAGMA foreign_keys = 1');
    expect(applyBrokeredBatch(child, forward([probe], { expectChanges: [1] }))).toMatchObject({ ok: false, reason: 'refused', rule: 'table' });
    expect(dump(child, 'pets')).toEqual([]);
    expect(openTransaction(child)).toBe(false);
    expect(tempObjects(child)).toEqual([]);
    child.run('PRAGMA foreign_keys = 0');
    expect(okApply(applyBrokeredBatch(child, forward([probe], { expectChanges: [1] }))).changes).toEqual([1]);
    child.close();
  });
});

// ================================================================================ planBrokeredWrite

describe('planBrokeredWrite — the grant: the table must be in scope WITH write', () => {
  it('a table outside the scope, or granted read-only, is not-granted — and nothing runs', async () => {
    const { planBrokeredWrite } = await brokered();
    const readOnly: ScopedReadScope = { tables: [{ name: 'transactions', columns: TX_COLUMNS }] };
    for (const [scope, sql] of [
      [readOnly, "UPDATE transactions SET note = 'x' WHERE id = 1"],
      [WRITE_TX, "UPDATE accounts SET balance = 0 WHERE name = 'checking'"],
    ] as const) {
      const spy = spyEngine();
      expect(planBrokeredWrite(spy.engine, bytesOf(LEDGER), scope, { sql }, CAPS), sql).toMatchObject({ ok: false, reason: 'not-granted' });
      expect(spy.seen).not.toContain(sql);
    }
  });

  it('a statement the parser refuses is refused before any copy is scoped', async () => {
    const { planBrokeredWrite } = await brokered();
    const sql = "UPDATE transactions SET note = lower('X') WHERE id = 1";
    const spy = spyEngine();
    expect(planBrokeredWrite(spy.engine, bytesOf(LEDGER), WRITE_TX, { sql }, CAPS)).toMatchObject({ ok: false, reason: 'refused' });
    expect(spy.seen).not.toContain(sql);
  });
});

describe('planBrokeredWrite — the column rule: withheld, credential-named, generated, masked — each refused BY NAME, BEFORE any dry run', () => {
  const WITHHELD = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT, memo TEXT)', "INSERT INTO notes (id, body, memo) VALUES (1, 'a', 'private')"];
  const NOTES: ScopedReadScope = { tables: [{ name: 'notes', columns: ['id', 'body'], withheld: ['memo'], write: true }] };
  const ACCOUNTS: ScopedReadScope = { tables: [{ name: 'accounts', columns: ['name', 'balance'], write: true }] };
  const GENERATED = ['CREATE TABLE gen (id INTEGER PRIMARY KEY, body TEXT, shout TEXT GENERATED ALWAYS AS (upper(body)) VIRTUAL)', "INSERT INTO gen (id, body) VALUES (1, 'a')"];
  const GEN: ScopedReadScope = { tables: [{ name: 'gen', columns: ['id', 'body', 'shout'], write: true }] };
  const MASKED = ['CREATE TABLE settings (name TEXT, value TEXT)', `INSERT INTO settings (name, value) VALUES ('anthropic', '${KEY}'), ('theme', 'dark')`];
  const SETTINGS: ScopedReadScope = { tables: [{ name: 'settings', columns: ['name', 'value'], write: true }] };

  // [label, source, scope, statement, the column the refusal names]
  const COLUMN_RULE: Array<[string, string[], ScopedReadScope, string, string]> = [
    ['a withheld column in WHERE', WITHHELD, NOTES, "UPDATE notes SET body = 'x' WHERE memo = 'private'", 'memo'],
    ['a withheld column in SET', WITHHELD, NOTES, "UPDATE notes SET memo = 'x' WHERE id = 1", 'memo'],
    ['a withheld column in the INSERT list', WITHHELD, NOTES, "INSERT INTO notes (id, body, memo) VALUES (2, 'b', 'x')", 'memo'],
    // `changes` as the oracle: a LIKE on a credential column would tell the reader its prefix.
    ['a credential-named column in WHERE', LEDGER, ACCOUNTS, "UPDATE accounts SET balance = 0 WHERE api_key LIKE 'sk-a%'", 'api_key'],
    ['a credential-named column in SET (AC19 negative)', LEDGER, ACCOUNTS, "UPDATE accounts SET api_key = 'x' WHERE name = 'checking'", 'api_key'],
    ['a credential-named column in the INSERT list', LEDGER, ACCOUNTS, "INSERT INTO accounts (name, api_key) VALUES ('n', 'k')", 'api_key'],
    // A generated column recomputes over NULLed inputs on the copy — naming it is an oracle too.
    ['a generated column in WHERE (listed in columns for reads)', GENERATED, GEN, "UPDATE gen SET body = 'x' WHERE shout = 'A'", 'shout'],
    ['a generated column in SET', GENERATED, GEN, "UPDATE gen SET shout = 'x' WHERE id = 1", 'shout'],
    ['a generated column in the INSERT list', GENERATED, GEN, "INSERT INTO gen (id, shout) VALUES (2, 'x')", 'shout'],
    // A masked value: the copy overwrote a cell under this column — naming it is an oracle on the mask.
    ['a column the copy MASKED a cell in, in SET', MASKED, SETTINGS, "UPDATE settings SET value = 'light' WHERE name = 'theme'", 'value'],
    ['a column the copy MASKED a cell in, in WHERE', MASKED, SETTINGS, "DELETE FROM settings WHERE value = 'dark'", 'value'],
    ['a column the table does not have in the scope at all', LEDGER, WRITE_TX, "UPDATE transactions SET ghost = 'x' WHERE id = 1", 'ghost'],
  ];

  it.each(COLUMN_RULE)('%s → refused, naming it, and the statement never runs', async (_label, source, scope, sql, column) => {
    const { planBrokeredWrite } = await brokered();
    const spy = spyEngine();
    const result = planBrokeredWrite(spy.engine, bytesOf(source), scope, { sql }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    if (!result.ok) expect(result.message).toContain(column);
    expect(spy.seen).not.toContain(sql);
  });

  it('the masked twin: the same table holding no credential-shaped value plans the write', async () => {
    const { planBrokeredWrite } = await brokered();
    const clean = ['CREATE TABLE settings (name TEXT, value TEXT)', "INSERT INTO settings (name, value) VALUES ('font', 'serif'), ('theme', 'dark')"];
    const plan = okPlan(planBrokeredWrite(SQL, bytesOf(clean), SETTINGS, { sql: "UPDATE settings SET value = 'light' WHERE name = 'theme'" }, CAPS));
    expect(plan.previewChanges).toBe(1);
  });
});

describe('planBrokeredWrite — a credential-shaped VALUE never enters a write', () => {
  it.each([
    ['a literal in SET', `UPDATE transactions SET note = '${KEY}' WHERE id = 1`, undefined],
    ['a literal in WHERE', `DELETE FROM transactions WHERE note = 'Bearer ${JWT}'`, undefined],
    ['a literal in VALUES', `INSERT INTO transactions (id, amount, note) VALUES (9, 1, '${JWT}')`, undefined],
    ['a bound parameter', 'UPDATE transactions SET note = ? WHERE id = 1', [KEY]],
    ['a bound parameter in WHERE', 'DELETE FROM transactions WHERE note = ?', [`Bearer ${JWT}`]],
  ] as const)('%s → refused, and the statement never runs', async (_label, sql, params) => {
    const { planBrokeredWrite } = await brokered();
    const spy = spyEngine();
    const result = planBrokeredWrite(spy.engine, bytesOf(LEDGER), WRITE_TX, { sql, ...(params !== undefined ? { params } : {}) }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(spy.seen).not.toContain(sql);
    expect(JSON.stringify(result)).not.toMatch(/sk-ant-api03|eyJhbGci/);
  });
});

describe('planBrokeredWrite — the dry run on a scoped copy built forPlan', () => {
  it('a READ copy refuses a write; the PLAN copy counts it (no query_only on a plan copy)', async () => {
    const { planBrokeredWrite } = await brokered();
    const sql = "UPDATE transactions SET note = 'snack' WHERE category = 'food'";
    const read = scopedScratchRead(SQL, bytesOf(LEDGER), { tables: [{ name: 'transactions', columns: TX_COLUMNS }] }, { sql }, { maxRows: 500, maxBytes: 196_608 });
    expect(read).toMatchObject({ ok: false, reason: 'refused' });
    expect(okPlan(planBrokeredWrite(SQL, bytesOf(LEDGER), WRITE_TX, { sql }, CAPS)).previewChanges).toBe(2);
  });

  it('ignore_check_constraints is RESET on the plan copy: a CHECK the write would break fails the dry run (the twin counts)', async () => {
    const { planBrokeredWrite } = await brokered();
    const source = ['CREATE TABLE chk (id INTEGER PRIMARY KEY, amount INTEGER CHECK (amount < 100))', 'INSERT INTO chk (id, amount) VALUES (1, 5)'];
    const scope: ScopedReadScope = { tables: [{ name: 'chk', columns: ['id', 'amount'], write: true }] };
    expect(planBrokeredWrite(SQL, bytesOf(source), scope, { sql: 'UPDATE chk SET amount = 500 WHERE id = 1' }, CAPS)).toMatchObject({ ok: false, reason: 'failed' });
    expect(okPlan(planBrokeredWrite(SQL, bytesOf(source), scope, { sql: 'UPDATE chk SET amount = 7 WHERE id = 1' }, CAPS)).previewChanges).toBe(1);
  });

  it('a SQL error in the dry run is failed (a NOT NULL the INSERT leaves empty)', async () => {
    const { planBrokeredWrite } = await brokered();
    expect(planBrokeredWrite(SQL, bytesOf(LEDGER), WRITE_TX, { sql: "INSERT INTO transactions (id, note) VALUES (9, 'x')" }, CAPS)).toMatchObject({
      ok: false,
      reason: 'failed',
    });
  });

  it('drift — a recorded column the source no longer has — is refused as drift, nothing run', async () => {
    const { planBrokeredWrite } = await brokered();
    const sql = "UPDATE transactions SET note = 'x' WHERE id = 1";
    const spy = spyEngine();
    const scope: ScopedReadScope = { tables: [{ name: 'transactions', columns: [...TX_COLUMNS, 'memo'], write: true }] };
    const result = planBrokeredWrite(spy.engine, bytesOf(LEDGER), scope, { sql }, CAPS);
    expect(result).toMatchObject({ ok: false, reason: 'drift', drift: { added: [], removed: ['transactions.memo'] } });
    expect(spy.seen).not.toContain(sql);
  });

  it(`too-many: ${CAPS.maxChanges + 1} rows is refused; ${CAPS.maxChanges} rows plans`, async () => {
    const { planBrokeredWrite } = await brokered();
    const source = (n: number): string[] => [
      'CREATE TABLE big (id INTEGER PRIMARY KEY, note TEXT)',
      `INSERT INTO big (id, note) VALUES ${Array.from({ length: n }, (_, i) => `(${i + 1}, 'n')`).join(', ')}`,
    ];
    const scope: ScopedReadScope = { tables: [{ name: 'big', columns: ['id', 'note'], write: true }] };
    const sql = "UPDATE big SET note = 'x' WHERE id > 0";
    expect(planBrokeredWrite(SQL, bytesOf(source(CAPS.maxChanges + 1)), scope, { sql }, CAPS)).toMatchObject({ ok: false, reason: 'too-many' });
    expect(okPlan(planBrokeredWrite(SQL, bytesOf(source(CAPS.maxChanges)), scope, { sql }, CAPS)).previewChanges).toBe(CAPS.maxChanges);
  });

  it('too-large: captured rows past maxUndoBytes are refused at plan', async () => {
    const { planBrokeredWrite } = await brokered();
    const sql = "UPDATE transactions SET note = 'x' WHERE id > 0";
    expect(planBrokeredWrite(SQL, bytesOf(LEDGER), WRITE_TX, { sql }, { ...CAPS, maxUndoBytes: 16 })).toMatchObject({ ok: false, reason: 'too-large' });
    expect(okPlan(planBrokeredWrite(SQL, bytesOf(LEDGER), WRITE_TX, { sql }, CAPS)).previewChanges).toBe(3);
  });

  it('the plan is counts and the statement — NO row and no value leaves; previewChanges is exact per op; the bytes are untouched', async () => {
    const { planBrokeredWrite } = await brokered();
    const bytes = bytesOf(LEDGER);
    const before = bytes.slice();
    const update = okPlan(planBrokeredWrite(SQL, bytes, WRITE_TX, { sql: "UPDATE transactions SET note = ?, category = 'snacks' WHERE category = 'food'", params: ['treat'] }, CAPS));
    expect(update).toMatchObject({ op: 'update', table: 'transactions', setColumns: ['note', 'category'], previewChanges: 2, params: ['treat'] });
    const insert = okPlan(planBrokeredWrite(SQL, bytes, WRITE_TX, { sql: "INSERT INTO transactions (id, amount, note) VALUES (7, 1, 'a'), (8, 2, 'b')" }, CAPS));
    expect(insert).toMatchObject({ op: 'insert', insertColumns: ['id', 'amount', 'note'], previewChanges: 2 });
    const del = okPlan(planBrokeredWrite(SQL, bytes, WRITE_TX, { sql: "DELETE FROM transactions WHERE category = 'home'" }, CAPS));
    expect(del).toMatchObject({ op: 'delete', previewChanges: 1 });
    for (const plan of [update, insert, del]) {
      expect(Object.keys(plan).every((key) => ['sql', 'params', 'op', 'table', 'columns', 'setColumns', 'insertColumns', 'previewChanges'].includes(key))).toBe(true);
      expect(JSON.stringify(plan)).not.toMatch(/coffee|rent|tea|120000/);
    }
    expect(bytes).toEqual(before);
  });
});

// ============================================================================== applyBrokeredBatch

describe('applyBrokeredBatch — commits on the live handle and captures the statement’s OWN rows exactly', () => {
  it('an UPDATE: per row the rowid, BEFORE and AFTER over the SET columns in SET order', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const plan = txPlan("UPDATE transactions SET note = 'snack', category = 'treat' WHERE category = 'food'", 'update', { setColumns: ['note', 'category'], previewChanges: 2 });
    const result = okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [2] })));
    expect(result.changes).toEqual([2]);
    expect(result.undoable).toBe(true);
    expect(byRowid(result.steps)).toEqual([
      {
        table: 'transactions',
        op: 'update',
        columns: ['note', 'category'],
        rows: [
          { rowid: 1, before: ['coffee', 'food'], after: ['snack', 'treat'] },
          { rowid: 3, before: ['tea', 'food'], after: ['snack', 'treat'] },
        ],
      },
    ]);
    expect(dump(db, 'transactions')).toEqual([
      [1, 1, 450, 'treat', 'snack'],
      [2, 2, 120000, 'home', 'rent'],
      [3, 3, 500, 'treat', 'snack'],
    ]);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('a DELETE: the WHOLE row (every non-generated column, in table order) under its rowid', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const result = okApply(applyBrokeredBatch(db, forward([txPlan('DELETE FROM transactions WHERE id = 2', 'delete', { previewChanges: 1 })], { expectChanges: [1] })));
    expect(result.steps).toEqual([{ table: 'transactions', op: 'delete', columns: TX_COLUMNS, rows: [{ rowid: 2, before: [2, 120000, 'home', 'rent'] }] }]);
    expect(dump(db, 'transactions').map((row) => row[0])).toEqual([1, 3]);
    db.close();
  });

  it('an INSERT: the NEW rowids — an explicit INTEGER PRIMARY KEY value included — with AFTER over the INSERT list', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const plan = txPlan("INSERT INTO transactions (id, amount, note) VALUES (77, 5, 'gum'), (NULL, ?, ?)", 'insert', {
      params: [6, 'mint'],
      insertColumns: ['id', 'amount', 'note'],
      previewChanges: 2,
    });
    const result = okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [2] })));
    expect(byRowid(result.steps)).toEqual([
      {
        table: 'transactions',
        op: 'insert',
        columns: ['id', 'amount', 'note'],
        rows: [
          { rowid: 77, after: [77, 5, 'gum'] },
          { rowid: 78, after: [78, 6, 'mint'] },
        ],
      },
    ]);
    db.close();
  });

  it('an INSERT into a table without an INTEGER PRIMARY KEY captures the implicit rowid', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(['CREATE TABLE notes (body TEXT)', "INSERT INTO notes (body) VALUES ('a')"]);
    const plan: BrokeredPlan = { sql: "INSERT INTO notes (body) VALUES ('b')", op: 'insert', table: 'notes', columns: ['body'], insertColumns: ['body'], previewChanges: 1 };
    expect(okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [1] }))).steps).toEqual([
      { table: 'notes', op: 'insert', columns: ['body'], rows: [{ rowid: 2, after: ['b'] }] },
    ]);
    db.close();
  });

  it('a column named rowid or r never collides with the capture (positional capture columns, F18)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(['CREATE TABLE odd (id INTEGER PRIMARY KEY, r TEXT, snug_rowid TEXT)', "INSERT INTO odd (id, r, snug_rowid) VALUES (1, 'a', 'b')"]);
    const plan: BrokeredPlan = { sql: "UPDATE odd SET r = 'x', snug_rowid = 'y' WHERE id = 1", op: 'update', table: 'odd', columns: ['id', 'r', 'snug_rowid'], setColumns: ['r', 'snug_rowid'], previewChanges: 1 };
    expect(okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [1] }))).steps).toEqual([
      { table: 'odd', op: 'update', columns: ['r', 'snug_rowid'], rows: [{ rowid: 1, before: ['a', 'b'], after: ['x', 'y'] }] },
    ]);
    db.close();
  });

  it('several plans apply as ONE transaction: changes per plan, one step per plan', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const plans = [
      txPlan("UPDATE transactions SET note = 'x' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 }),
      txPlan('DELETE FROM transactions WHERE id = 2', 'delete', { previewChanges: 1 }),
    ];
    const result = okApply(applyBrokeredBatch(db, forward(plans, { expectChanges: [1, 1] })));
    expect(result.changes).toEqual([1, 1]);
    expect(result.steps.map((step) => step.op)).toEqual(['update', 'delete']);
    db.close();
  });
});

describe('applyBrokeredBatch — every refusal ROLLS BACK: nothing changed, no open transaction, no temp object', () => {
  it('busy: a nested BEGIN — and the outer transaction is left exactly as it was (the apply never rolls back what it did not begin)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    db.run('BEGIN');
    db.run("UPDATE transactions SET note = 'outer' WHERE id = 1");
    const result = applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'x' WHERE id = 2", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'busy' });
    expect(() => db.run('COMMIT')).not.toThrow(); // the outer transaction was still open
    expect(all(db, 'SELECT note FROM transactions ORDER BY id')).toEqual([['outer'], ['rent'], ['tea']]);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('drifted: expectChanges ≠ the changes — ROLLBACK, nothing changed', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    const plan = txPlan("UPDATE transactions SET note = 'x' WHERE category = 'food'", 'update', { setColumns: ['note'], previewChanges: 5 });
    expect(applyBrokeredBatch(db, forward([plan], { expectChanges: [5] }))).toMatchObject({ ok: false, reason: 'drifted' });
    expect(dump(db, 'transactions')).toEqual(before);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('drifted in the SECOND plan rolls back the first as well (the batch is atomic)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    const plans = [
      txPlan("UPDATE transactions SET note = 'x' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 }),
      txPlan('DELETE FROM transactions WHERE id = 2', 'delete', { previewChanges: 9 }),
    ];
    expect(applyBrokeredBatch(db, forward(plans, { expectChanges: [1, 9] }))).toMatchObject({ ok: false, reason: 'drifted' });
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it('too-many: more rows than maxChanges — ROLLBACK, nothing changed', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    const plan = txPlan("UPDATE transactions SET note = 'x' WHERE id > 0", 'update', { setColumns: ['note'], previewChanges: 3 });
    expect(applyBrokeredBatch(db, forward([plan], { caps: { ...CAPS, maxChanges: 2 } }))).toMatchObject({ ok: false, reason: 'too-many' });
    expect(dump(db, 'transactions')).toEqual(before);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('too-large: requireUndo → ROLLBACK; without requireUndo the write commits with NO undo', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    const plan = txPlan("UPDATE transactions SET note = 'x' WHERE id > 0", 'update', { setColumns: ['note'], previewChanges: 3 });
    const tiny = { ...CAPS, maxUndoBytes: 16 };
    expect(applyBrokeredBatch(db, forward([plan], { caps: tiny, expectChanges: [3] }))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(dump(db, 'transactions')).toEqual(before);

    const loose = okApply(applyBrokeredBatch(db, forward([plan], { caps: tiny, expectChanges: [3], requireUndo: false })));
    expect(loose.undoable).toBe(false);
    expect(loose.steps.flatMap((step) => step.rows)).toEqual([]);
    expect(all(db, 'SELECT DISTINCT note FROM transactions')).toEqual([['x']]);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('unsafe: a credential-shaped value in a captured cell (judged under its column) → requireUndo ROLLS BACK; without it, no undo and the value never reaches the answer', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle([...LEDGER, `UPDATE transactions SET note = '${KEY}' WHERE id = 1`]);
    const before = dump(db, 'transactions');
    const plan = txPlan("UPDATE transactions SET note = 'clean' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 });
    const strict = applyBrokeredBatch(db, forward([plan], { expectChanges: [1] }));
    expect(strict).toMatchObject({ ok: false, reason: 'unsafe' });
    expect(dump(db, 'transactions')).toEqual(before);
    expect(JSON.stringify(strict)).not.toContain('sk-ant-api03');

    const loose = okApply(applyBrokeredBatch(db, forward([plan], { expectChanges: [1], requireUndo: false })));
    expect(loose.undoable).toBe(false);
    expect(JSON.stringify(loose)).not.toContain('sk-ant-api03');
    expect(all(db, 'SELECT note FROM transactions WHERE id = 1')).toEqual([['clean']]);
    db.close();
  });

  it(`the journal's text bound IS the protocol's: a captured text of exactly ACCESS_PARAM_STRING_MAX_CHARS (${ACCESS_PARAM_STRING_MAX_CHARS}) is journalable; one char longer is too-large`, async () => {
    // The module spells its bound locally (the Worker's bundle carries no schema — D-PR3-28); this
    // row is the pin that the two numbers stay equal, judged where the bound bites: the strict apply.
    const { applyBrokeredBatch } = await brokered();
    const plan = txPlan("UPDATE transactions SET note = 'short' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 });

    const atBound = 'a'.repeat(ACCESS_PARAM_STRING_MAX_CHARS);
    const fits = handle([...LEDGER, `UPDATE transactions SET note = '${atBound}' WHERE id = 1`]);
    const kept = okApply(applyBrokeredBatch(fits, forward([plan], { expectChanges: [1] })));
    expect(kept.undoable).toBe(true);
    expect(kept.steps).toEqual([{ table: 'transactions', op: 'update', columns: ['note'], rows: [{ rowid: 1, before: [atBound], after: ['short'] }] }]);
    fits.close();

    const overBound = 'a'.repeat(ACCESS_PARAM_STRING_MAX_CHARS + 1);
    const over = handle([...LEDGER, `UPDATE transactions SET note = '${overBound}' WHERE id = 1`]);
    const before = dump(over, 'transactions');
    expect(applyBrokeredBatch(over, forward([plan], { expectChanges: [1] }))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(dump(over, 'transactions')).toEqual(before);
    expect(openTransaction(over)).toBe(false);
    expect(tempObjects(over)).toEqual([]);
    over.close();
  });

  it('forbiddenStatementReason is the belt on every plan’s sql: a forbidden statement is refused and never run', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const spy = watch(db);
    const sql = "ATTACH DATABASE 'elsewhere.db' AS elsewhere";
    const result = applyBrokeredBatch(db, forward([txPlan(sql, 'update', { setColumns: ['note'], previewChanges: 0 })], { expectChanges: [0] }));
    expect(result.ok).toBe(false);
    expect(spy.seen).not.toContain(sql);
    expect(all(db, 'PRAGMA database_list').map((row) => row[1])).not.toContain('elsewhere');
    db.close();
  });
});

describe('applyBrokeredBatch — the capture objects: per-apply names, never IF NOT EXISTS, gone after EVERY path', () => {
  it('snug_undo_rows_<hex8> and snug_undo_trigger_<hex8>, a fresh name per apply, created without IF NOT EXISTS', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const spy = watch(db);
    okApply(applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'a' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] })));
    okApply(applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'b' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] })));
    const text = spy.seen.join('\n');
    const tables = [...new Set([...text.matchAll(/snug_undo_rows_([0-9a-f]{8})\b/g)].map((m) => m[1]))];
    const triggers = [...new Set([...text.matchAll(/snug_undo_trigger_([0-9a-f]{8})\b/g)].map((m) => m[1]))];
    expect(tables).toHaveLength(2);
    expect(triggers).toHaveLength(2);
    for (const create of spy.seen.filter((sql) => /CREATE\s+TEMP/i.test(sql))) expect(create).not.toMatch(/IF\s+NOT\s+EXISTS/i);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('an injected throw at the statement answers failed — no open transaction (BEGIN succeeds), no temp object, nothing changed', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    const spy = watch(db);
    spy.failWhen((sql) => sql.includes("SET note = 'boom'"));
    const result = applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'boom' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] }));
    spy.failWhen(undefined);
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(() => db.run('BEGIN')).not.toThrow();
    db.run('ROLLBACK');
    expect(tempObjects(db)).toEqual([]);
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it('an injected throw AFTER the statement ran (reading the count) rolls the statement back too', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    (db as unknown as { getRowsModified: () => number }).getRowsModified = () => {
      throw new Error('injected failure');
    };
    const result = applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'boom' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it('requireUndo false + capture false (own mode): applies, undoable false, and NO capture object is ever created', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const spy = watch(db);
    const result = okApply(
      applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'x' WHERE category = 'food'", 'update', { setColumns: ['note'], previewChanges: 2 })], {
        expectChanges: [2],
        requireUndo: false,
        capture: false,
      })),
    );
    expect(result.changes).toEqual([2]);
    expect(result.undoable).toBe(false);
    expect(result.steps.flatMap((step) => step.rows)).toEqual([]);
    expect(spy.seen.filter((sql) => /CREATE\s+TEMP/i.test(sql))).toEqual([]);
    expect(all(db, "SELECT count(*) FROM transactions WHERE note = 'x'")).toEqual([[2]]);
    db.close();
  });
});

// Gate-5 W-1: a write that captured no row has nothing to put back — not undoable, no step.
describe('applyBrokeredBatch — a write matching NO row commits a zero count and is NOT undoable (Gate-5 W-1)', () => {
  it.each([
    ['an UPDATE', () => txPlan("UPDATE transactions SET note = 'x' WHERE id = 99", 'update', { setColumns: ['note'] })],
    ['a DELETE', () => txPlan('DELETE FROM transactions WHERE id = 99', 'delete')],
  ] as const)('%s matching no row: { ok, changes: [0], undoable: false, steps: [] } — nothing changed, nothing left open', async (_label, plan) => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'transactions');
    expect(applyBrokeredBatch(db, forward([plan()], { expectChanges: [0] }))).toEqual({ ok: true, steps: [], changes: [0], undoable: false });
    expect(dump(db, 'transactions')).toEqual(before);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('the passing twin: the same UPDATE matching one row is undoable with its one step', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const result = okApply(applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'x' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] })));
    expect(result).toMatchObject({ changes: [1], undoable: true });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]!.rows).toHaveLength(1);
    db.close();
  });
});

// ======================================================================================= the undo

describe('buildUndoStatement — built from the STRUCTURE: identifiers quoted, every value a bound parameter, guarded by AFTER', () => {
  it('an UPDATE-undo: SET = before, WHERE rowid and every column IS its after value', async () => {
    const { buildUndoStatement } = await brokered();
    const built = buildUndoStatement(
      { table: 'transactions', op: 'update', columns: ['note', 'category'], rows: [] },
      { rowid: 1, before: ['coffee', 'food'], after: ['snack', 'treat'] },
    );
    expect(built.sql).toMatch(/^\s*UPDATE\s+"transactions"\s+SET\s+"note"\s*=\s*\?\s*,\s*"category"\s*=\s*\?\s+WHERE\s+"?rowid"?\s*=\s*\?/i);
    expect(built.sql).toMatch(/"note"\s+IS\s+\?/i);
    expect(built.sql).toMatch(/"category"\s+IS\s+\?/i);
    expect(built.params).toEqual(['coffee', 'food', 1, 'snack', 'treat']);
    expect(built.sql).not.toMatch(/coffee|snack|food|treat/);
  });

  it('an INSERT-undo: DELETE the rowid only while every inserted column still IS its after value', async () => {
    const { buildUndoStatement } = await brokered();
    const built = buildUndoStatement({ table: 'transactions', op: 'insert', columns: ['id', 'amount', 'note'], rows: [] }, { rowid: 77, after: [77, 5, 'gum'] });
    expect(built.sql).toMatch(/^\s*DELETE\s+FROM\s+"transactions"\s+WHERE\s+"?rowid"?\s*=\s*\?/i);
    expect(built.sql).toMatch(/"note"\s+IS\s+\?/i);
    expect(built.params).toEqual([77, 77, 5, 'gum']);
  });

  it('a DELETE-undo: INSERT the whole row back under its rowid', async () => {
    const { buildUndoStatement } = await brokered();
    const built = buildUndoStatement({ table: 'transactions', op: 'delete', columns: TX_COLUMNS, rows: [] }, { rowid: 2, before: [2, 120000, 'home', 'rent'] });
    expect(built.sql).toMatch(/^\s*INSERT\s+INTO\s+"transactions"\s*\(\s*"?rowid"?\s*,\s*"id"\s*,\s*"amount"\s*,\s*"category"\s*,\s*"note"\s*\)\s*VALUES\s*\(\s*\?\s*,\s*\?\s*,\s*\?\s*,\s*\?\s*,\s*\?\s*\)/i);
    expect(built.params).toEqual([2, 2, 120000, 'home', 'rent']);
  });

  // Moved here from apps/playground's writeBroker.test.ts with the Gate-5 W-5 fold (the db index no
  // longer exports the builder; the host reaches it only through the driver's seat).
  it('a planted entry’s values ride ONLY as bound parameters: a value shaped like SQL is never in the built text, only in its params', async () => {
    const { buildUndoStatement } = await brokered();
    const evil = "x'; DROP TABLE entries; --";
    const step: UndoStep = { table: 'entries', op: 'insert', columns: ['title'], rows: [{ rowid: 1, after: [evil] }] };
    const built = buildUndoStatement(step, step.rows[0]!);
    expect(built.sql).not.toContain(evil);
    expect(built.sql).not.toMatch(/DROP/i);
    expect(built.params).toContain(evil);
  });

  it('a hostile column or table name is ONLY a quoted identifier — nothing it says runs', async () => {
    const { buildUndoStatement } = await brokered();
    const hostile = 'x"; DROP TABLE transactions; --';
    const db = handle([...LEDGER, `CREATE TABLE odd (id INTEGER PRIMARY KEY, "${hostile.replace(/"/g, '""')}" TEXT)`, `INSERT INTO odd (id, "${hostile.replace(/"/g, '""')}") VALUES (1, 'b')`]);
    const built = buildUndoStatement({ table: 'odd', op: 'update', columns: [hostile], rows: [] }, { rowid: 1, before: ['a'], after: ['b'] });
    db.run(built.sql, built.params as never);
    expect(all(db, 'SELECT count(*) FROM transactions')).toEqual([[3]]);
    expect(all(db, 'SELECT * FROM odd')).toEqual([[1, 'a']]);
    db.close();
  });
});

describe('applyBrokeredBatch({ undo }) — the inverse, applied atomically through the same seat; it fails WHOLE', () => {
  it('an UPDATE undone restores the BEFORE values; the undo itself captures nothing (undoable false, no temp object created)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const original = dump(db, 'transactions');
    const written = okApply(
      applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'snack' WHERE category = 'food'", 'update', { setColumns: ['note'], previewChanges: 2 })], { expectChanges: [2] })),
    );
    const spy = watch(db);
    const undone = okApply(applyBrokeredBatch(db, { undo: written.steps, caps: CAPS }));
    expect(undone.undoable).toBe(false);
    expect(undone.changes.reduce((sum, n) => sum + n, 0)).toBe(2);
    expect(spy.seen.filter((sql) => /CREATE\s+TEMP/i.test(sql))).toEqual([]);
    expect(dump(db, 'transactions')).toEqual(original);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('a row changed since the write → the WHOLE undo rolls back (drifted): the untouched row is NOT restored either', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const written = okApply(
      applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'snack' WHERE category = 'food'", 'update', { setColumns: ['note'], previewChanges: 2 })], { expectChanges: [2] })),
    );
    db.run("UPDATE transactions SET note = 'changed by Ledger' WHERE id = 3");
    const after = dump(db, 'transactions');
    expect(applyBrokeredBatch(db, { undo: written.steps, caps: CAPS })).toMatchObject({ ok: false, reason: 'drifted' });
    expect(dump(db, 'transactions')).toEqual(after);
    expect(openTransaction(db)).toBe(false);
    db.close();
  });

  it('a DELETE undone puts the whole rows back under their rowids', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const original = dump(db, 'transactions');
    const written = okApply(applyBrokeredBatch(db, forward([txPlan('DELETE FROM transactions WHERE id IN (2, 3)', 'delete', { previewChanges: 2 })], { expectChanges: [2] })));
    okApply(applyBrokeredBatch(db, { undo: written.steps, caps: CAPS }));
    expect(dump(db, 'transactions')).toEqual(original);
    db.close();
  });

  it('a reused rowid fails the DELETE-undo WHOLE: the other deleted row stays deleted and the new row is intact', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const written = okApply(applyBrokeredBatch(db, forward([txPlan('DELETE FROM transactions WHERE id IN (2, 3)', 'delete', { previewChanges: 2 })], { expectChanges: [2] })));
    db.run("INSERT INTO transactions (id, amount, category, note) VALUES (2, 1, 'new', 'reused')");
    const after = dump(db, 'transactions');
    const result = applyBrokeredBatch(db, { undo: written.steps, caps: CAPS });
    expect(result.ok).toBe(false);
    expect(dump(db, 'transactions')).toEqual(after);
    expect(openTransaction(db)).toBe(false);
    db.close();
  });

  it('an INSERT undone deletes exactly the inserted rows; one changed since fails the undo whole', async () => {
    const { applyBrokeredBatch } = await brokered();
    const insert = (): BrokeredPlan =>
      txPlan("INSERT INTO transactions (id, amount, note) VALUES (7, 1, 'a'), (8, 2, 'b')", 'insert', { insertColumns: ['id', 'amount', 'note'], previewChanges: 2 });

    const clean = handle(LEDGER);
    const original = dump(clean, 'transactions');
    const written = okApply(applyBrokeredBatch(clean, forward([insert()], { expectChanges: [2] })));
    okApply(applyBrokeredBatch(clean, { undo: written.steps, caps: CAPS }));
    expect(dump(clean, 'transactions')).toEqual(original);
    clean.close();

    const touched = handle(LEDGER);
    const again = okApply(applyBrokeredBatch(touched, forward([insert()], { expectChanges: [2] })));
    touched.run("UPDATE transactions SET note = 'edited' WHERE id = 8");
    const after = dump(touched, 'transactions');
    expect(applyBrokeredBatch(touched, { undo: again.steps, caps: CAPS })).toMatchObject({ ok: false });
    expect(dump(touched, 'transactions')).toEqual(after);
    touched.close();
  });

  it('busy: an undo meets a nested BEGIN like a write does', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const written = okApply(
      applyBrokeredBatch(db, forward([txPlan("UPDATE transactions SET note = 'snack' WHERE id = 1", 'update', { setColumns: ['note'], previewChanges: 1 })], { expectChanges: [1] })),
    );
    db.run('BEGIN');
    expect(applyBrokeredBatch(db, { undo: written.steps, caps: CAPS })).toMatchObject({ ok: false, reason: 'busy' });
    expect(() => db.run('COMMIT')).not.toThrow();
    expect(all(db, 'SELECT note FROM transactions WHERE id = 1')).toEqual([['snack']]);
    db.close();
  });

  it('forbiddenStatementReason is the belt on every BUILT undo statement: a column whose name carries load_extension( refuses the undo, nothing changed', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(['CREATE TABLE odd (id INTEGER PRIMARY KEY, "load_extension(" TEXT)', 'INSERT INTO odd (id, "load_extension(") VALUES (1, \'b\')']);
    const step: UndoStep = { table: 'odd', op: 'update', columns: ['load_extension('], rows: [{ rowid: 1, before: ['a'], after: ['b'] }] };
    expect(applyBrokeredBatch(db, { undo: [step], caps: CAPS }).ok).toBe(false);
    expect(all(db, 'SELECT * FROM odd')).toEqual([[1, 'b']]);
    db.close();
  });

  // Gate-5 SEC-4: a genuine entry never NAMES a credential column — a step that does was planted, and
  // its inverse would write under that column. Refused at phase 1, before any transaction.
  it('a planted step naming a credential-shaped column (api_key) on an otherwise shared table is refused `column` at phase 1 — nothing written, no transaction, even beside a genuine step', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(LEDGER);
    const before = dump(db, 'accounts');
    const txBefore = dump(db, 'transactions');
    const spy = watch(db);
    const planted: UndoStep[][] = [
      [{ table: 'accounts', op: 'update', columns: ['api_key'], rows: [{ rowid: 1, before: ['planted'], after: ['hunter2'] }] }],
      [{ table: 'accounts', op: 'update', columns: ['balance', 'api_key'], rows: [{ rowid: 1, before: [0, 'planted'], after: [100, 'hunter2'] }] }],
      [{ table: 'accounts', op: 'insert', columns: ['name', 'API_KEY'], rows: [{ rowid: 1, after: ['checking', 'hunter2'] }] }],
      [
        { table: 'transactions', op: 'update', columns: ['note'], rows: [{ rowid: 1, before: ['latte'], after: ['coffee'] }] },
        { table: 'accounts', op: 'update', columns: ['api_key'], rows: [{ rowid: 1, before: ['planted'], after: ['hunter2'] }] },
      ],
    ];
    for (const steps of planted) {
      expect(applyBrokeredBatch(db, { undo: steps }), JSON.stringify(steps.map((step) => step.columns))).toMatchObject({ ok: false, reason: 'refused', rule: 'column' });
    }
    expect(spy.seen.filter((sql) => /^\s*(BEGIN|UPDATE|INSERT|DELETE)\b/i.test(sql)), 'refused before any transaction or statement').toEqual([]);
    expect(dump(db, 'accounts')).toEqual(before);
    expect(dump(db, 'transactions')).toEqual(txBefore);
    expect(openTransaction(db)).toBe(false);
    // The passing twin: the same table's shared column undoes.
    expect(okApply(applyBrokeredBatch(db, { undo: [{ table: 'accounts', op: 'update', columns: ['balance'], rows: [{ rowid: 1, before: [7], after: [100] }] }] })).changes).toEqual([1]);
    expect(all(db, 'SELECT balance, api_key FROM accounts')).toEqual([[7, 'hunter2']]);
    db.close();
  });
});

// =========================================================================== PR-4: the CAPTURE variant of own mode

/*
 * TASK-20261010-host-broker PR-4 (contract v2 D-PR4-4; AC32b) — ONE own-write seat that captures:
 * `{ own, capture: true, caps, expectChanges, requireUndo, admit }`. The app's own change, run
 * under the SHAPE rules (`tableShape`) and an OWN column rule — never `tableFacts`, whose CHECK and
 * DELETE-coverage rules are reader oracles — with the capture objects, so the user can undo it.
 *  - plannability is decided for the WHOLE batch before any transaction (the literal grammar, the
 *    shape, the own column rule) — never a mixed batch;
 *  - `sum(changes) ≤ caps.maxChanges` over the WHOLE call, checked after each statement;
 *  - `admit(steps)` is asked after the last statement and BEFORE `COMMIT`: false under
 *    `requireUndo: true` rolls back `cannot-undo`; under `requireUndo: false` commits `undoable: false`;
 *  - refusal words are OWN-mode words (nothing about "another app" or "shared").
 * The type of the variant is read from the module (`Extract<…>`), so until it exists the helper
 * below is `never` and the package's tsc test config reds on it (a contract reason).
 */

type OwnCaptureInput = Extract<BrokeredApplyInput, { own: unknown; capture: true }>;
type Admit = (steps: readonly UndoStep[]) => boolean;

const OWN_TABLES = [
  ...LEDGER,
  // A CHECK on a table holding a credential-named column: tableFacts would refuse it (a column outside a scope); tableShape admits it.
  'CREATE TABLE budgets (id INTEGER PRIMARY KEY, cap INTEGER CHECK (cap >= 0), api_key TEXT)',
  "INSERT INTO budgets (id, cap, api_key) VALUES (1, 10, 'hunter2')",
  // A generated column: a DELETE captures every NON-generated column (tableFacts would refuse the DELETE outright).
  'CREATE TABLE sized (id INTEGER PRIMARY KEY, body TEXT, size INTEGER GENERATED ALWAYS AS (length(body)) VIRTUAL)',
  "INSERT INTO sized (id, body) VALUES (1, 'abc'), (2, 'de')",
  // The shape rules still hold — a trigger, WITHOUT ROWID, ON CONFLICT REPLACE.
  'CREATE TABLE audit (what TEXT)',
  'CREATE TABLE logged (id INTEGER PRIMARY KEY, v TEXT)',
  "INSERT INTO logged (id, v) VALUES (1, 'a')",
  "CREATE TRIGGER logged_audit AFTER UPDATE ON logged BEGIN INSERT INTO audit (what) VALUES ('x'); END",
  'CREATE TABLE keyed (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
  "INSERT INTO keyed (k, v) VALUES ('a', 'b')",
  'CREATE TABLE replaced (id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT)',
  "INSERT INTO replaced (id, v) VALUES (1, 'a')",
];

/** The capture variant as the engine hands it. */
const capture = (own: Array<{ sql: string; params?: unknown[] }>, over: Partial<Record<string, unknown>> = {}): OwnCaptureInput =>
  ({ own, capture: true, caps: CAPS, requireUndo: true, admit: () => true, ...over }) as unknown as OwnCaptureInput;

/** An admit that records every call and what the handle looked like when it was asked. */
function admitSpy(db: Database, verdict: boolean | Admit = true): { admit: Admit; calls: UndoStep[][]; inTransaction: boolean[]; notes: unknown[][][] } {
  const calls: UndoStep[][] = [];
  const inTransaction: boolean[] = [];
  const notes: unknown[][][] = [];
  const admit: Admit = (steps) => {
    calls.push(JSON.parse(JSON.stringify(steps)) as UndoStep[]);
    inTransaction.push(openTransaction(db));
    notes.push(all(db, 'SELECT id, note FROM transactions ORDER BY id'));
    return typeof verdict === 'function' ? verdict(steps) : verdict;
  };
  return { admit, calls, inTransaction, notes };
}

/** The own-mode words: nothing about another app or a share (the reader's oracle words). */
const READER_WORDS = /another app|isn.t shared|shared/i;

describe('PR-4 — the capture variant: whole-batch, captured, admitted before COMMIT (D-PR4-4)', () => {
  it('an UPDATE and an INSERT in ONE call: changes per statement, one captured step each, undoable — admit asked ONCE, after the last statement, inside the open transaction', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const spy = admitSpy(db);
    const result = okApply(
      applyBrokeredBatch(
        db,
        capture(
          [{ sql: "UPDATE transactions SET note = 'latte' WHERE id = 1" }, { sql: 'INSERT INTO transactions (id, amount, note) VALUES (?, ?, ?)', params: [9, 12, 'gum'] }],
          { expectChanges: [1, 1], admit: spy.admit },
        ),
      ),
    );
    expect(result.changes).toEqual([1, 1]);
    expect(result.undoable).toBe(true);
    expect(byRowid(result.steps)).toEqual([
      { table: 'transactions', op: 'update', columns: ['note'], rows: [{ rowid: 1, before: ['coffee'], after: ['latte'] }] },
      { table: 'transactions', op: 'insert', columns: ['id', 'amount', 'note'], rows: [{ rowid: 9, after: [9, 12, 'gum'] }] },
    ]);
    expect(spy.calls).toHaveLength(1);
    expect(byRowid(spy.calls[0]!)).toEqual(byRowid(result.steps));
    expect(spy.inTransaction).toEqual([true]); // asked BEFORE COMMIT
    expect(spy.notes[0]).toContainEqual([9, 'gum']); // … and after the LAST statement
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    expect(all(db, 'SELECT note FROM transactions WHERE id IN (1, 9) ORDER BY id')).toEqual([['latte'], ['gum']]);
    db.close();
  });

  it('a DELETE captures the WHOLE row under its rowid — every non-generated column (tableShape, not tableFacts: a generated column does not refuse it)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const result = okApply(applyBrokeredBatch(db, capture([{ sql: 'DELETE FROM sized WHERE id = 1' }], { expectChanges: [1] })));
    expect(result.steps).toEqual([{ table: 'sized', op: 'delete', columns: ['id', 'body'], rows: [{ rowid: 1, before: [1, 'abc'] }] }]);
    expect(result.undoable).toBe(true);
    expect(all(db, 'SELECT id FROM sized')).toEqual([[2]]);
    db.close();
  });

  it('a CHECK on a table with a credential-named column is NOT refused (the reader-oracle rule is not an own rule): an UPDATE of a plain column captures', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const result = okApply(applyBrokeredBatch(db, capture([{ sql: 'UPDATE budgets SET cap = 20 WHERE id = 1' }], { expectChanges: [1] })));
    expect(result.steps).toEqual([{ table: 'budgets', op: 'update', columns: ['cap'], rows: [{ rowid: 1, before: [10], after: [20] }] }]);
    db.close();
  });

  it('the own column rule: an UPDATE or INSERT naming a credential-named column, or a DELETE on a table holding one, is UNPLANNABLE — refused by name, nothing run', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'accounts');
    const spy = watch(db);
    for (const sql of [
      "UPDATE accounts SET api_key = 'x' WHERE name = 'checking'",
      "UPDATE accounts SET balance = 1, API_KEY = 'x' WHERE name = 'checking'",
      "INSERT INTO accounts (name, api_key) VALUES ('savings', 'x')",
      "DELETE FROM accounts WHERE name = 'checking'",
    ]) {
      const result = applyBrokeredBatch(db, capture([{ sql }], { requireUndo: true }));
      expect(result, sql).toMatchObject({ ok: false, reason: 'refused' });
      if (!result.ok && /^(UPDATE|INSERT)/.test(sql)) expect((result as { rule?: string }).rule, sql).toBe('column');
      if (!result.ok) expect(result.message, sql).not.toMatch(READER_WORDS);
    }
    expect(spy.seen.filter((sql) => /^\s*(BEGIN|UPDATE|INSERT|DELETE)\b/i.test(sql)), 'refused before any transaction or statement').toEqual([]);
    expect(dump(db, 'accounts')).toEqual(before);
    // The passing twin: the same table's plain column.
    expect(okApply(applyBrokeredBatch(db, capture([{ sql: "UPDATE accounts SET balance = 7 WHERE name = 'checking'" }], { expectChanges: [1] }))).steps).toEqual([
      { table: 'accounts', op: 'update', columns: ['balance'], rows: [{ rowid: 1, before: [100], after: [7] }] },
    ]);
    db.close();
  });

  it('the shape rules still hold — a triggered, a WITHOUT ROWID and an ON CONFLICT REPLACE table are unplannable `table`, in own-mode words', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    for (const sql of ["UPDATE logged SET v = 'b' WHERE id = 1", "UPDATE keyed SET v = 'c' WHERE k = 'a'", "UPDATE replaced SET v = 'b' WHERE id = 1"]) {
      const result = applyBrokeredBatch(db, capture([{ sql }]));
      expect(result, sql).toMatchObject({ ok: false, reason: 'refused', rule: 'table' });
      if (!result.ok) expect(result.message, sql).not.toMatch(READER_WORDS);
    }
    expect(all(db, 'SELECT v FROM logged')).toEqual([['a']]);
    expect(all(db, 'SELECT count(*) FROM audit')).toEqual([[0]]);
    db.close();
  });

  it('the literal grammar decides capturability: a function, arithmetic, a conflict clause or no WHERE is unplannable by its parser rule', async () => {
    const { applyBrokeredBatch, parseBrokeredStatement } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'transactions');
    for (const sql of [
      "UPDATE transactions SET note = lower('X') WHERE id = 1",
      'UPDATE transactions SET amount = amount + 1 WHERE id = 1',
      "INSERT OR REPLACE INTO transactions (id, amount, note) VALUES (1, 1, 'x')",
      "UPDATE transactions SET note = 'x'",
      'DELETE FROM transactions',
    ]) {
      const parsed = parseBrokeredStatement(sql);
      expect(parsed.ok, sql).toBe(false);
      const result = applyBrokeredBatch(db, capture([{ sql }]));
      expect(result, sql).toMatchObject({ ok: false, reason: 'refused', rule: parsed.ok ? 'statement' : parsed.rule });
    }
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it.each([true, false])('plannability is WHOLE-BATCH (requireUndo %s): a plannable statement beside an unplannable one is refused BEFORE any transaction — the plannable one never runs, admit is never asked', async (requireUndo) => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'transactions');
    const spy = admitSpy(db);
    const seen = watch(db);
    const result = applyBrokeredBatch(
      db,
      capture([{ sql: "UPDATE transactions SET note = 'latte' WHERE id = 1" }, { sql: "UPDATE transactions SET note = upper('x') WHERE id = 2" }], { requireUndo, admit: spy.admit }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'refused' });
    expect(seen.seen.filter((sql) => /^\s*(BEGIN|UPDATE|INSERT|DELETE)\b/i.test(sql))).toEqual([]);
    expect(spy.calls).toEqual([]);
    expect(dump(db, 'transactions')).toEqual(before);
    expect(openTransaction(db)).toBe(false);
    db.close();
  });

  it('sum(changes) ≤ caps.maxChanges over the WHOLE call: 2 + 2 under a cap of 3 is too-many and rolls back BOTH; 2 + 1 passes', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle([...OWN_TABLES, "INSERT INTO transactions (id, amount, category, note) VALUES (4, 1, 'home', 'a'), (5, 2, 'home', 'b')"]);
    const before = dump(db, 'transactions');
    const caps: BrokeredCaps = { maxChanges: 3, maxUndoBytes: CAPS.maxUndoBytes };
    const over = applyBrokeredBatch(
      db,
      capture([{ sql: "UPDATE transactions SET note = 'f' WHERE category = 'food'" }, { sql: "UPDATE transactions SET note = 'h' WHERE id IN (4, 5)" }], { caps }),
    );
    expect(over).toMatchObject({ ok: false, reason: 'too-many' });
    expect(dump(db, 'transactions')).toEqual(before);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    const within = okApply(
      applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'f' WHERE category = 'food'" }, { sql: "UPDATE transactions SET note = 'h' WHERE id = 4" }], { caps })),
    );
    expect(within.changes).toEqual([2, 1]);
    db.close();
  });

  it('admit false under requireUndo: true → ROLLBACK, `cannot-undo`: nothing changed, no open transaction, no temp object', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'transactions');
    const spy = admitSpy(db, false);
    const result = applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'latte' WHERE id = 1" }], { requireUndo: true, admit: spy.admit, expectChanges: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'cannot-undo' });
    expect(spy.calls).toHaveLength(1);
    expect(spy.notes[0]).toContainEqual([1, 'latte']); // the statement HAD run when admit was asked …
    expect(dump(db, 'transactions')).toEqual(before); // … and the rollback took it back
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('admit false under requireUndo: false → COMMITS with NO undo (undoable: false, no steps) — an approval is never refused for its journal', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const spy = admitSpy(db, false);
    const result = okApply(applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'latte' WHERE id = 1" }], { requireUndo: false, admit: spy.admit, expectChanges: [1] })));
    expect(spy.calls).toHaveLength(1); // it WAS captured and asked — the answer, not a skipped capture, made it uncaptured
    expect(spy.inTransaction).toEqual([true]);
    expect(result).toMatchObject({ changes: [1], undoable: false, steps: [] });
    expect(all(db, 'SELECT note FROM transactions WHERE id = 1')).toEqual([['latte']]);
    expect(openTransaction(db)).toBe(false);
    expect(tempObjects(db)).toEqual([]);
    db.close();
  });

  it('an approval\'s Infinity cap is never refused for its size: 250 rows commit; the admit the engine passes refuses > 200 rows a step, so it commits undoable: false', async () => {
    const { applyBrokeredBatch } = await brokered();
    const rows = Array.from({ length: 250 }, (_, i) => `(${100 + i}, 1, 'bulk', 'n')`).join(', ');
    const db = handle([...OWN_TABLES, `INSERT INTO transactions (id, amount, category, note) VALUES ${rows}`]);
    const asked: number[] = [];
    const admit: Admit = (steps) => {
      asked.push(...steps.map((step) => step.rows.length));
      return steps.every((step) => step.rows.length <= 200);
    };
    const result = okApply(
      applyBrokeredBatch(
        db,
        capture([{ sql: "UPDATE transactions SET note = 'm' WHERE category = 'bulk'" }], { caps: { maxChanges: Number.POSITIVE_INFINITY, maxUndoBytes: Number.POSITIVE_INFINITY }, requireUndo: false, admit }),
      ),
    );
    expect(result.changes).toEqual([250]);
    expect(asked).toEqual([250]); // captured whole, judged by admit — never too-many
    expect(result.undoable).toBe(false);
    expect(all(db, "SELECT count(*) FROM transactions WHERE note = 'm'")).toEqual([[250]]);
    db.close();
  });

  it('the drift halt holds in the capture variant: a count the engine did not expect rolls back the whole call, `drifted` with both counts', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'transactions');
    const result = applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'x' WHERE category = 'food'" }], { expectChanges: [1] }));
    expect(result).toMatchObject({ ok: false, reason: 'drifted', previewed: [1], current: [2] });
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it('busy: the app\'s nested BEGIN — the capture variant never touches the app\'s transaction', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    db.run('BEGIN');
    db.run("UPDATE transactions SET note = 'mine' WHERE id = 2");
    const result = applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'x' WHERE id = 1" }]));
    expect(result).toMatchObject({ ok: false, reason: 'busy' });
    expect(openTransaction(db)).toBe(true);
    db.run('COMMIT');
    expect(all(db, 'SELECT id, note FROM transactions WHERE id IN (1, 2) ORDER BY id')).toEqual([
      [1, 'coffee'],
      [2, 'mine'],
    ]);
    db.close();
  });

  it('the captured steps undo through the same seat: the { undo } of an own capture puts the rows back', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const before = dump(db, 'transactions');
    const applied = okApply(applyBrokeredBatch(db, capture([{ sql: "UPDATE transactions SET note = 'x' WHERE category = 'food'" }, { sql: 'DELETE FROM transactions WHERE id = 2' }])));
    expect(applied.undoable).toBe(true);
    okApply(applyBrokeredBatch(db, { undo: [...applied.steps].reverse() }));
    expect(dump(db, 'transactions')).toEqual(before);
    db.close();
  });

  it('the BARE { own } path is unchanged beside it: a triggered table still applies there, uncaptured (the approval\'s path for an unplannable batch)', async () => {
    const { applyBrokeredBatch } = await brokered();
    const db = handle(OWN_TABLES);
    const spy = watch(db);
    const result = applyBrokeredBatch(db, { own: [{ sql: "UPDATE logged SET v = 'b' WHERE id = 1" }], expectChanges: [1] });
    expect(result).toEqual({ ok: true, steps: [], changes: [1], undoable: false });
    expect(spy.seen.filter((sql) => /CREATE\s+TEMP/i.test(sql))).toEqual([]);
    expect(all(db, 'SELECT count(*) FROM audit')).toEqual([[1]]);
    db.close();
  });
});

describe('PR-4 — ownCapturable(sql): a pure predicate over the literal grammar (D-PR4-4; W-5\'s surface otherwise unchanged)', () => {
  const STATEMENTS = [
    "UPDATE transactions SET note = 'x' WHERE id = 1",
    'UPDATE transactions SET note = ? WHERE id = ?',
    "INSERT INTO transactions (id, amount, note) VALUES (9, 1, 'gum')",
    'DELETE FROM transactions WHERE id IN (1, 2)',
    "UPDATE transactions SET note = lower('X') WHERE id = 1",
    'UPDATE transactions SET amount = amount + 1 WHERE id = 1',
    "INSERT OR REPLACE INTO transactions (id, amount, note) VALUES (1, 1, 'x')",
    "INSERT INTO transactions (id, amount, note) VALUES (1, 1, 'x') ON CONFLICT DO NOTHING",
    "UPDATE transactions SET note = 'x'",
    'DELETE FROM transactions',
    'INSERT INTO transactions (id) SELECT rowid FROM accounts',
    "UPDATE transactions SET note = 'x' WHERE id = 1; DELETE FROM transactions WHERE id = 2",
  ];

  it('agrees with the parser on every statement: {ok: true} exactly when it parses, else {ok: false, rule} with the parser\'s rule', async () => {
    const { ownCapturable, parseBrokeredStatement } = await brokered();
    for (const sql of STATEMENTS) {
      const parsed = parseBrokeredStatement(sql);
      expect(ownCapturable(sql), sql).toEqual(parsed.ok ? { ok: true } : { ok: false, rule: parsed.rule });
    }
  });

  it('the literal-valued shapes are capturable; a function, arithmetic, a conflict clause or a missing WHERE is not', async () => {
    const { ownCapturable } = await brokered();
    expect(ownCapturable("UPDATE transactions SET note = 'x' WHERE id = 1")).toEqual({ ok: true });
    for (const sql of ["UPDATE transactions SET note = lower('X') WHERE id = 1", 'UPDATE transactions SET amount = amount + 1 WHERE id = 1', "INSERT OR REPLACE INTO t (a) VALUES (1)", "UPDATE t SET a = 1"]) {
      expect(ownCapturable(sql).ok, sql).toBe(false);
    }
  });

  it('is exported from the package index (a named predicate the engine and the proposal gate call)', async () => {
    const index = (await import('../index.js')) as Record<string, unknown>;
    expect(typeof index.ownCapturable).toBe('function');
  });
});
