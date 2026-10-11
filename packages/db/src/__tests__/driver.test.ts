// DbDriver contract tests (task ACs 3, 4, 6, 7): sql.js exec/kv/export/import per
// namespace, errors as DbDriverResult data (the driver NEVER throws), and the
// protocol size caps (5 MiB artifacts, 8 MiB db frame class).
import type { DbDriver } from '@snugprotocol/runner';
import { LIMITS } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';
import {
  DB_ERROR_CODES,
  USERDB_ERROR_CODES,
  createDbDriver,
  createMemoryBackend,
  openUserDb,
  type BrokeredPlan,
  type NamespaceWriteEvent,
  type SnugDbDriver,
} from '../index.js';
import {
  decodeBase64,
  encodeBase64,
  execFrame,
  exportFrame,
  hasSqliteMagic,
  importFrame,
  kvGetFrame,
  kvSetFrame,
  locateWasm,
} from './helpers.js';

const NS = 'test-app';

function driver(): SnugDbDriver {
  return createDbDriver({ backend: createMemoryBackend(), locateWasm });
}

function expectOk(result: Awaited<ReturnType<DbDriver['handle']>>): asserts result is {
  ok: true;
  rows?: unknown[][];
  columns?: string[];
  value?: unknown;
  bytesBase64?: string;
} {
  expect(result).toMatchObject({ ok: true });
}

function expectError(result: Awaited<ReturnType<DbDriver['handle']>>, code: string): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(typeof result.message).toBe('string');
  expect(typeof result.retryable).toBe('boolean');
}

describe('createDbDriver — the runner DbDriver seam', () => {
  it('is assignable to the runner DbDriver interface', () => {
    const d: DbDriver = driver();
    expect(typeof d.handle).toBe('function');
  });

  it('exec returns {rows: unknown[][], columns: string[]} exactly — the KB-documented shape (AC-7)', async () => {
    const d = driver();
    const ddl = await d.handle(NS, execFrame('CREATE TABLE scores (name TEXT, points INTEGER)'));
    expectOk(ddl);
    expect(ddl.rows).toEqual([]);
    expect(ddl.columns).toEqual([]);

    await d.handle(NS, execFrame('INSERT INTO scores (name, points) VALUES (?, ?)', ['ada', 42]));
    const select = await d.handle(NS, execFrame('SELECT name, points FROM scores'));
    expectOk(select);
    expect(select.columns).toEqual(['name', 'points']);
    expect(select.rows).toEqual([['ada', 42]]);
    // the success result carries ONLY top-level DbDriverResult fields
    expect(Object.keys(select).sort()).toEqual(['columns', 'ok', 'rows']);
  });

  it('binds params including null and roundtrips them (AC-3)', async () => {
    const d = driver();
    await d.handle(NS, execFrame('CREATE TABLE t (a, b, c)'));
    const insert = await d.handle(NS, execFrame('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', [1.5, 'two', null]));
    expectOk(insert);
    const select = await d.handle(NS, execFrame('SELECT a, b, c FROM t'));
    expectOk(select);
    expect(select.rows).toEqual([[1.5, 'two', null]]);
  });

  it('SQL errors come back as ok:false typed results — the driver never throws (AC-7)', async () => {
    const d = driver();
    const bad = await d.handle(NS, execFrame('SELECT * FROM missing_table'));
    expectError(bad, DB_ERROR_CODES.SQL_ERROR);
    const syntax = await d.handle(NS, execFrame('NOT EVEN SQL'));
    expectError(syntax, DB_ERROR_CODES.SQL_ERROR);
  });

  it('rejects multi-statement SQL without executing the first statement', async () => {
    const d = driver();
    const multi = await d.handle(NS, execFrame('CREATE TABLE a (x); CREATE TABLE b (y)'));
    expectError(multi, DB_ERROR_CODES.MULTI_STATEMENT);
    // neither statement ran
    const probe = await d.handle(NS, execFrame('INSERT INTO a (x) VALUES (1)'));
    expectError(probe, DB_ERROR_CODES.SQL_ERROR);
  });

  it('accepts a single statement with a trailing semicolon and trailing comments', async () => {
    const d = driver();
    expectOk(await d.handle(NS, execFrame('SELECT 1;')));
    expectOk(await d.handle(NS, execFrame('SELECT 1; -- done')));
    expectOk(await d.handle(NS, execFrame('SELECT 1; /* block */')));
  });

  it('kvSet/kvGet roundtrip JSON values in the snug_kv table of the SAME namespace db', async () => {
    const d = driver();
    const stored = { board: [1, 2, 3], nested: { on: true } };
    expectOk(await d.handle(NS, kvSetFrame('game-state', stored)));
    const got = await d.handle(NS, kvGetFrame('game-state'));
    expectOk(got);
    expect(got.value).toEqual(stored);
    // kv lives inside the regular sqlite file, visible to SQL
    const table = await d.handle(NS, execFrame("SELECT key FROM snug_kv WHERE key = 'game-state'"));
    expectOk(table);
    expect(table.rows).toEqual([['game-state']]);
  });

  it('kvGet for a missing key succeeds with no value (hooks treat null/undefined as absent)', async () => {
    const d = driver();
    const got = await d.handle(NS, kvGetFrame('never-set'));
    expectOk(got);
    expect(got.value).toBeUndefined();
  });

  it('kvSet overwrites an existing key', async () => {
    const d = driver();
    expectOk(await d.handle(NS, kvSetFrame('k', 1)));
    expectOk(await d.handle(NS, kvSetFrame('k', 2)));
    const got = await d.handle(NS, kvGetFrame('k'));
    expectOk(got);
    expect(got.value).toBe(2);
  });

  it('full round-trip: DDL+DML → kv → export (magic bytes) → import into a FRESH driver → identical results (AC-3, umbrella AC-5)', async () => {
    const d = driver();
    await d.handle(NS, execFrame('CREATE TABLE moves (turn INTEGER, san TEXT)'));
    await d.handle(NS, execFrame('INSERT INTO moves (turn, san) VALUES (?, ?)', [1, 'e4']));
    await d.handle(NS, execFrame('INSERT INTO moves (turn, san) VALUES (?, ?)', [2, 'e5']));
    expectOk(await d.handle(NS, kvSetFrame('meta', { title: 'test game' })));

    const exported = await d.handle(NS, exportFrame());
    expectOk(exported);
    expect(typeof exported.bytesBase64).toBe('string');
    const bytes = decodeBase64(exported.bytesBase64 as string);
    expect(hasSqliteMagic(bytes)).toBe(true); // openable in DB Browser for SQLite

    const fresh = driver();
    expectOk(await fresh.handle('other-ns', importFrame(exported.bytesBase64 as string)));
    const rows = await fresh.handle('other-ns', execFrame('SELECT turn, san FROM moves ORDER BY turn'));
    expectOk(rows);
    expect(rows.rows).toEqual([
      [1, 'e4'],
      [2, 'e5'],
    ]);
    const meta = await fresh.handle('other-ns', kvGetFrame('meta'));
    expectOk(meta);
    expect(meta.value).toEqual({ title: 'test game' });
  });

  it('import REPLACES the namespace db', async () => {
    const d = driver();
    await d.handle(NS, execFrame('CREATE TABLE t (x)'));
    await d.handle(NS, execFrame('INSERT INTO t (x) VALUES (1)'));
    const snapshot = await d.handle(NS, exportFrame());
    expectOk(snapshot);
    await d.handle(NS, execFrame('INSERT INTO t (x) VALUES (2)'));
    expectOk(await d.handle(NS, importFrame(snapshot.bytesBase64 as string)));
    const rows = await d.handle(NS, execFrame('SELECT count(*) FROM t'));
    expectOk(rows);
    expect(rows.rows).toEqual([[1]]);
  });

  it('two namespaces cannot see each other tables or kv (AC-4)', async () => {
    const d = driver();
    await d.handle('ns-a', execFrame('CREATE TABLE secret (x)'));
    await d.handle('ns-a', execFrame('INSERT INTO secret (x) VALUES (1)'));
    expectOk(await d.handle('ns-a', kvSetFrame('token-ish', 'private')));

    const leakTable = await d.handle('ns-b', execFrame('SELECT * FROM secret'));
    expectError(leakTable, DB_ERROR_CODES.SQL_ERROR);
    const leakKv = await d.handle('ns-b', kvGetFrame('token-ish'));
    expectOk(leakKv);
    expect(leakKv.value).toBeUndefined();
  });

  it('export beyond 5 MiB fails with a typed size error (AC-6)', async () => {
    const d = driver();
    await d.handle(NS, execFrame('CREATE TABLE blobs (data BLOB)'));
    const insert = await d.handle(NS, execFrame(`INSERT INTO blobs (data) VALUES (zeroblob(${LIMITS.MAX_ARTIFACT_BYTES + 1024 * 1024}))`));
    expectOk(insert);
    const exported = await d.handle(NS, exportFrame());
    expectError(exported, DB_ERROR_CODES.TOO_LARGE);
  });

  it('import rejects bytes without the SQLite magic header (AC-6)', async () => {
    const d = driver();
    const junk = new TextEncoder().encode('this is definitely not a sqlite file, padded to be long enough.');
    const result = await d.handle(NS, importFrame(encodeBase64(junk)));
    expectError(result, DB_ERROR_CODES.BAD_IMPORT);
  });

  it('import rejects magic-prefixed garbage that sql.js cannot open', async () => {
    const d = driver();
    const bytes = new Uint8Array(4096);
    const magic = 'SQLite format 3';
    for (let i = 0; i < magic.length; i++) bytes[i] = magic.charCodeAt(i);
    bytes[magic.length] = 0;
    for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
    const result = await d.handle(NS, importFrame(encodeBase64(bytes)));
    expectError(result, DB_ERROR_CODES.BAD_IMPORT);
    // and the namespace still works afterwards
    expectOk(await d.handle(NS, execFrame('SELECT 1')));
  });

  it('import rejects invalid base64', async () => {
    const d = driver();
    const result = await d.handle(NS, importFrame('%%%not-base64%%%'));
    expectError(result, DB_ERROR_CODES.BAD_IMPORT);
  });

  it('import beyond 5 MiB fails with a typed size error before touching the db (AC-6)', async () => {
    const d = driver();
    await d.handle(NS, execFrame('CREATE TABLE keep (x)'));
    const oversize = new Uint8Array(LIMITS.MAX_ARTIFACT_BYTES + 1);
    const magic = 'SQLite format 3';
    for (let i = 0; i < magic.length; i++) oversize[i] = magic.charCodeAt(i);
    const result = await d.handle(NS, importFrame(encodeBase64(oversize)));
    expectError(result, DB_ERROR_CODES.TOO_LARGE);
    expectOk(await d.handle(NS, execFrame('SELECT count(*) FROM keep')));
  });

  it('exec results that cannot fit the 8 MiB db frame class fail typed instead of oversizing the frame (AC-6)', async () => {
    const d = driver();
    const big = 'x'.repeat(LIMITS.MAX_DB_FRAME_BYTES + 1024);
    const result = await d.handle(NS, execFrame('SELECT ? AS big', [big]));
    expectError(result, DB_ERROR_CODES.TOO_LARGE);
  });

  it('rejects ATTACH statements with DB_FORBIDDEN_STATEMENT (Gate-5 finding 3)', async () => {
    const d = driver();
    expectError(await d.handle(NS, execFrame("ATTACH DATABASE 'other.db' AS other")), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    // case-insensitive, and leading comments do not hide it
    expectError(await d.handle(NS, execFrame("attach database 'x' as y")), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    expectError(
      await d.handle(NS, execFrame("/* innocent */ ATTACH DATABASE 'x' AS y")),
      DB_ERROR_CODES.FORBIDDEN_STATEMENT,
    );
  });

  it('rejects PRAGMA writable_schema but keeps other PRAGMAs working', async () => {
    const d = driver();
    expectError(await d.handle(NS, execFrame('PRAGMA writable_schema = ON')), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    expectError(await d.handle(NS, execFrame('pragma writable_schema')), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    const allowed = await d.handle(NS, execFrame('PRAGMA user_version'));
    expectOk(allowed);
    expect(allowed.rows).toEqual([[0]]);
  });

  it('rejects load_extension() calls with DB_FORBIDDEN_STATEMENT', async () => {
    const d = driver();
    expectError(await d.handle(NS, execFrame("SELECT load_extension('evil')")), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    expectError(await d.handle(NS, execFrame("SELECT LOAD_EXTENSION ('evil')")), DB_ERROR_CODES.FORBIDDEN_STATEMENT);
    // and the namespace still works afterwards
    expectOk(await d.handle(NS, execFrame('SELECT 1')));
  });

  it('a malformed frame (unknown op) is answered as an error, never thrown', async () => {
    const d = driver();
    const bogus = { v: 1, type: 'snug:db-request', requestId: 'r', instanceId: 'i', op: 'truncate' };
    const result = await d.handle(NS, bogus as never);
    expect(result.ok).toBe(false);
  });
});

describe('evict (TASK-20260803-hub-ops — app delete, R1)', () => {
  it('discards pending writes instead of persisting them', async () => {
    const backend = createMemoryBackend();
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 5 });
    expectOk(await d.handle(NS, kvSetFrame('doomed', 'value')));

    // Evict BEFORE the debounce fires: the pending bytes must never reach the backend.
    // This is the whole point — persisting here would resurrect a deleted app.
    await d.evict(NS);
    await new Promise((resolve) => setTimeout(resolve, 25));
    // An explicit flush AFTER eviction must not write the evicted namespace either —
    // this is the assertion that actually pins the guarantee, since a cancelled timer
    // alone would make the debounce path pass for the wrong reason.
    await d.flush();

    expect([...backend.files.keys()]).toHaveLength(0);
  });

  it('leaves other namespaces persisting normally', async () => {
    const backend = createMemoryBackend();
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 1 });
    expectOk(await d.handle('doomed-app', kvSetFrame('a', 1)));
    expectOk(await d.handle('kept-app', kvSetFrame('b', 2)));

    await d.evict('doomed-app');
    await d.flush();

    const files = [...backend.files.keys()];
    expect(files.some((f) => f.includes('kept-app'))).toBe(true);
    expect(files.some((f) => f.includes('doomed-app'))).toBe(false);
  });

  it('re-opens the namespace from the backend after eviction', async () => {
    const backend = createMemoryBackend();
    const d = createDbDriver({ backend, locateWasm, persistDebounceMs: 1 });
    expectOk(await d.handle(NS, kvSetFrame('kept', 'persisted')));
    await d.flush(); // this one DOES reach the backend

    await d.evict(NS);

    // A fresh handle re-materializes from the backend rather than staying dead.
    const read = await d.handle(NS, kvGetFrame('kept'));
    expectOk(read);
    expect(read.value).toBe('persisted');
  });

  it('is a no-op for a namespace that was never opened', async () => {
    const d = driver();
    await expect(d.evict('never-touched')).resolves.toBeUndefined();
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-3 (contract v2 D-PR3-11 / D-PR3-20; AC19, AC24) — the driver's two
// new seats.
//
// THE WRITE SIGNAL (`CreateDbDriverOptions.onNamespaceWrite`, and `subscribeWrites` on the driver):
// raised IN `handle()` — for a frame's exec that answered ok AND is row-modifying AND changed > 0 rows
// (`kind: 'exec'`, the table from `dmlTargetTable`), a frame's kvSet (`'kv'`), an import (`'import'`),
// and a brokered write (`'brokered'`). Never from a read, a DDL statement, a statement that changed
// nothing, `markDirty`, or the HOST's own kv seat (the `snug:schedule:<runId>` handshake and its clear
// ring nothing). The doorbell is built on it; ids only.
//
// THE SEAT (`brokeredWrite(namespace, { plans, caps, expectChanges?, requireUndo, capture })`): the
// ONLY way onto a namespace's handle for a brokered write — SYNCHRONOUS under it (no frame request
// interleaves). The driver keeps a per-namespace `inTransaction` flag from the verbs `runExec` ran
// successfully (BEGIN/SAVEPOINT set it; COMMIT/END/ROLLBACK clear it; an import clears it) and answers
// `busy` (retryable) from the flag BEFORE touching the handle. The user db's FACADE forwards it with the
// tombstone and `noteNamespace` rules, and keeps ITS listener set across `importUserDb`'s inner swap.
//
// Written before the seats existed (Gate 3). `NamespaceWriteEvent` and `BrokeredPlan` are the
// real exports (swapped in by the implementation lane); the result shape and the seat cast stay
// LOCAL on purpose: `isBusy` reads `result.reason` on the loose union without narrowing, which
// the real `BrokeredWriteResult` (a `code` variant beside the `reason` ones) does not admit.
// =========================================================================================

/* Local structural types — the loose result union and the seat cast (see above). */
interface BrokeredWriteInputV {
  plans: BrokeredPlan[];
  caps: { maxChanges: number; maxUndoBytes: number };
  expectChanges?: number[];
  requireUndo: boolean;
  capture: boolean;
}
type BrokeredWriteResultV =
  | { ok: true; steps: unknown[]; changes: number[]; undoable: boolean }
  | { ok: false; reason?: string; code?: string; message: string; retryable: boolean };
interface WriteSeats {
  brokeredWrite(namespace: string, input: BrokeredWriteInputV): Promise<BrokeredWriteResultV>;
  subscribeWrites(listener: (event: NamespaceWriteEvent) => void): () => void;
}
const seats = (d: SnugDbDriver): WriteSeats => d as unknown as WriteSeats;

/** A driver whose option-level listener records every write signal. */
function signalled(): { driver: SnugDbDriver; events: NamespaceWriteEvent[] } {
  const events: NamespaceWriteEvent[] = [];
  const options = { backend: createMemoryBackend(), locateWasm, onNamespaceWrite: (event: NamespaceWriteEvent) => events.push(event) };
  return { driver: createDbDriver(options), events };
}

const SCORES = 'CREATE TABLE scores (name TEXT, points INTEGER)';
const BROKER_CAPS = { maxChanges: 200, maxUndoBytes: 64 * 1024 };

/** One brokered UPDATE of Ada's points, as the Worker would have planned it. */
const adaTo = (points: number, previewChanges = 1): BrokeredWriteInputV => ({
  plans: [
    {
      sql: `UPDATE scores SET points = ${points} WHERE name = 'ada'`,
      op: 'update',
      table: 'scores',
      columns: ['name', 'points'],
      setColumns: ['points'],
      previewChanges,
    },
  ],
  caps: BROKER_CAPS,
  expectChanges: [previewChanges],
  requireUndo: true,
  capture: true,
});

/** A plan on a table that does not exist: the apply's own facts would refuse it — only the FLAG can answer busy first. */
const ghostWrite: BrokeredWriteInputV = {
  plans: [{ sql: "UPDATE ghost SET a = 'x' WHERE a = 'y'", op: 'update', table: 'ghost', columns: ['a'], setColumns: ['a'], previewChanges: 1 }],
  caps: BROKER_CAPS,
  expectChanges: [1],
  requireUndo: true,
  capture: true,
};

async function isBusy(d: SnugDbDriver, namespace = NS): Promise<boolean> {
  const result = await seats(d).brokeredWrite(namespace, ghostWrite);
  if (result.ok) throw new Error('a write on a missing table cannot succeed');
  if (result.reason === 'busy') {
    expect(result.retryable).toBe(true);
    return true;
  }
  return false;
}

describe('the write signal — onNamespaceWrite, raised in handle() (D-PR3-20 a; AC24)', () => {
  it('a frame’s exec that changed rows rings { namespace, kind: exec, table } — INSERT, UPDATE and DELETE, quoted or not', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expect(events).toEqual([]); // DDL rings nothing
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1), ('bo', 2)")));
    expectOk(await d.handle(NS, execFrame("UPDATE \"scores\" SET points = 5 WHERE name = 'ada'")));
    expectOk(await d.handle(NS, execFrame("/* tidy */ DELETE FROM scores WHERE name = 'bo'")));
    expect(events).toHaveLength(3);
    for (const event of events) expect(event).toMatchObject({ namespace: NS, kind: 'exec', table: 'scores' });
    if (events[0]!.changes !== undefined) expect(events.map((event) => event.changes)).toEqual([2, 1, 1]);
  });

  it('NOT for a SELECT, a DDL statement, a statement that changed nothing, or a statement that failed', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame('SELECT * FROM scores')));
    expectOk(await d.handle(NS, execFrame("UPDATE scores SET points = 9 WHERE name = 'nobody'")));
    expectOk(await d.handle(NS, execFrame('DELETE FROM scores WHERE 0')));
    expectOk(await d.handle(NS, execFrame('CREATE INDEX scores_by_name ON scores (name)')));
    expectError(await d.handle(NS, execFrame("INSERT INTO missing (x) VALUES ('y')")), DB_ERROR_CODES.SQL_ERROR);
    expect(events).toEqual([]);
  });

  it('the count is never sticky: an INSERT, then a SELECT, rings once', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    expectOk(await d.handle(NS, execFrame('SELECT count(*) FROM scores')));
    expect(events).toHaveLength(1);
  });

  it('a frame’s kvSet rings { kind: kv }; an import rings { kind: import }', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.handle(NS, kvSetFrame('theme', 'dark')));
    expect(events).toEqual([expect.objectContaining({ namespace: NS, kind: 'kv' })]);

    const source = driver();
    expectOk(await source.handle('donor', execFrame(SCORES)));
    const exported = await source.handle('donor', exportFrame());
    expectOk(exported);
    expectOk(await d.handle(NS, importFrame(exported.bytesBase64 as string)));
    expect(events.at(-1)).toMatchObject({ namespace: NS, kind: 'import' });
    expect(events).toHaveLength(2);
  });

  it('NOT the HOST’s kv seat: the snug:schedule:<runId> handshake and its clear ring nothing — nor a kvGet or an export', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.kvSet(NS, 'snug:schedule:x', { taskId: 't1', runId: 'x', input: {} }));
    expectOk(await d.kvGet(NS, 'snug:schedule:x'));
    expectOk(await d.kvSet(NS, 'snug:schedule:x', null));
    expectOk(await d.handle(NS, kvGetFrame('snug:schedule:x')));
    expectOk(await d.handle(NS, exportFrame()));
    expect(events).toEqual([]);
  });

  it('subscribeWrites: a listener hears what the option hears, and the function it returns unsubscribes', async () => {
    const { driver: d, events } = signalled();
    const heard: NamespaceWriteEvent[] = [];
    const off = seats(d).subscribeWrites((event) => heard.push(event));
    expect(typeof off).toBe('function');
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    expect(heard).toEqual(events);
    expect(heard).toHaveLength(1);
    off();
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('bo', 2)")));
    expect(heard).toHaveLength(1);
    expect(events).toHaveLength(2);
  });

  it('a brokered write rings ONCE, { kind: brokered, table } — and a refused one rings nothing', async () => {
    const { driver: d, events } = signalled();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    events.length = 0;

    const drifted = await seats(d).brokeredWrite(NS, adaTo(50, 3));
    expect(drifted).toMatchObject({ ok: false, reason: 'drifted' });
    expect(events).toEqual([]);

    const result = await seats(d).brokeredWrite(NS, adaTo(50));
    expect(result).toMatchObject({ ok: true, changes: [1], undoable: true });
    expect(events).toEqual([expect.objectContaining({ namespace: NS, kind: 'brokered', table: 'scores' })]);
    const after = await d.handle(NS, execFrame("SELECT points FROM scores WHERE name = 'ada'"));
    expectOk(after);
    expect(after.rows).toEqual([[50]]);
  });
});

describe('the per-namespace inTransaction flag — brokeredWrite answers busy from it, BEFORE touching the handle (D-PR3-11)', () => {
  it('BEGIN sets it, COMMIT clears it; BEGIN … ROLLBACK and BEGIN IMMEDIATE … END too', async () => {
    const d = driver();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expect(await isBusy(d)).toBe(false);
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await isBusy(d)).toBe(false);
    expectOk(await d.handle(NS, execFrame('BEGIN TRANSACTION')));
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, execFrame('ROLLBACK')));
    expect(await isBusy(d)).toBe(false);
    expectOk(await d.handle(NS, execFrame('begin immediate')));
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, execFrame('END')));
    expect(await isBusy(d)).toBe(false);
  });

  it('a SAVEPOINT outside a transaction sets it; ROLLBACK clears it', async () => {
    const d = driver();
    expectOk(await d.handle(NS, execFrame('SAVEPOINT sp')));
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, execFrame('ROLLBACK')));
    expect(await isBusy(d)).toBe(false);
  });

  it('a FAILED nested BEGIN leaves it set; the COMMIT that follows clears it', async () => {
    const d = driver();
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectError(await d.handle(NS, execFrame('BEGIN')), DB_ERROR_CODES.SQL_ERROR);
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await isBusy(d)).toBe(false);
  });

  it('an import clears it (the handle it guarded is gone)', async () => {
    const d = driver();
    const donor = driver();
    const exported = await donor.handle('donor', exportFrame());
    expectOk(exported);
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await isBusy(d)).toBe(true);
    expectOk(await d.handle(NS, importFrame(exported.bytesBase64 as string)));
    expect(await isBusy(d)).toBe(false);
  });

  it('it is per namespace: one app mid-transaction never makes another busy', async () => {
    const d = driver();
    expectOk(await d.handle('ns-a', execFrame('BEGIN')));
    expect(await isBusy(d, 'ns-a')).toBe(true);
    expect(await isBusy(d, 'ns-b')).toBe(false);
  });

  it('busy changes nothing: the app’s open transaction and its rows are as they were', async () => {
    const d = driver();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectOk(await d.handle(NS, execFrame("UPDATE scores SET points = 7 WHERE name = 'ada'")));
    expect(await seats(d).brokeredWrite(NS, adaTo(50))).toMatchObject({ ok: false, reason: 'busy', retryable: true });
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    const after = await d.handle(NS, execFrame("SELECT points FROM scores WHERE name = 'ada'"));
    expectOk(after);
    expect(after.rows).toEqual([[7]]);
  });

  it('a closed driver answers as data — the seat never throws', async () => {
    const d = driver();
    await d.close();
    const result = await seats(d).brokeredWrite(NS, adaTo(50));
    expect(result.ok).toBe(false);
  });
});

describe('brokeredWrite and subscribeWrites through the user db’s facade (D-PR3-11 / D-PR3-20)', () => {
  async function userDb(backend = createMemoryBackend()) {
    const opened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error('open failed');
    return opened.userDb;
  }

  it('forwards a live app’s write and keys its write-back (it survives a flush and a re-open); a DELETED app is refused NOT_FOUND as data', async () => {
    const backend = createMemoryBackend();
    const db = await userDb(backend);
    const app = db.installApp({ displayName: 'Scores', html: '<html>scores</html>' });
    expectOk(await db.driver.handle(app.appId, execFrame(SCORES)));
    expectOk(await db.driver.handle(app.appId, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    expect(await seats(db.driver).brokeredWrite(app.appId, adaTo(50))).toMatchObject({ ok: true, changes: [1] });

    await db.flush();
    const reopened = await userDb(backend);
    const read = await reopened.driver.handle(app.appId, execFrame("SELECT points FROM scores WHERE name = 'ada'"));
    expectOk(read);
    expect(read.rows).toEqual([[50]]);
    await reopened.close();

    await db.deleteApp(app.appId);
    const refused = await seats(db.driver).brokeredWrite(app.appId, adaTo(60));
    expect(refused).toMatchObject({ ok: false, code: USERDB_ERROR_CODES.NOT_FOUND, retryable: false });
    await db.close();
  });

  it('the facade’s subscribeWrites keeps its listeners across importUserDb’s inner-driver swap', async () => {
    const db = await userDb();
    const app = db.installApp({ displayName: 'Notes', html: '<html>notes</html>' });
    expectOk(await db.driver.handle(app.appId, execFrame('CREATE TABLE notes (body TEXT)')));
    const heard: NamespaceWriteEvent[] = [];
    seats(db.driver).subscribeWrites((event) => heard.push(event));

    const bytes = await db.exportUserDb({ includeSecrets: true });
    await db.importUserDb(bytes, { trustedOrigin: true });

    expectOk(await db.driver.handle(app.appId, execFrame("INSERT INTO notes (body) VALUES ('after the swap')")));
    expect(heard).toContainEqual(expect.objectContaining({ namespace: app.appId, kind: 'exec', table: 'notes' }));
    await db.close();
  });
});
