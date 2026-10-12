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
  type BrokeredWriteInput,
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
    // A namespace that never ran a statement exports 0 bytes (sql.js writes no page), which the
    // import's magic-header guard rightly answers BAD_IMPORT — so the donor runs one frame first.
    expectOk(await donor.handle('donor', execFrame(SCORES)));
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

describe('inTransaction — the driver’s transaction record, READ (code-fix D-FIX-1; E1-Q8 recovery)', () => {
  /**
   * A driver whose debounce never fires inside a row, over a memory backend whose `files` map is
   * the "no export happened" oracle: the driver exports only to persist (or for an export frame).
   */
  function quiet(): { driver: SnugDbDriver; files: Map<string, Uint8Array> } {
    const backend = createMemoryBackend();
    return { driver: createDbDriver({ backend, locateWasm, persistDebounceMs: 60_000 }), files: backend.files };
  }

  it('a namespace never opened answers false — and asking does not open it', async () => {
    const { driver: d, files } = quiet();
    expect(await d.inTransaction('never-opened')).toBe(false);
    expect(files.size).toBe(0);
    await d.close();
    expect(files.size).toBe(0); // close flushes every OPEN namespace — none was opened by the read
  });

  it('after a frame’s BEGIN → true, and the handle is untouched: no export happened, the app’s transaction is still open on it', async () => {
    const { driver: d, files } = quiet();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame("INSERT INTO scores (name, points) VALUES ('ada', 1)")));
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectOk(await d.handle(NS, execFrame("UPDATE scores SET points = 7 WHERE name = 'ada'")));
    expect(await d.inTransaction(NS)).toBe(true);
    expect(await d.inTransaction(NS)).toBe(true); // reading twice changes nothing
    expect(files.size).toBe(0); // nothing was exported to persist
    // The app's own transaction survived the read: its ROLLBACK still finds it and undoes its UPDATE.
    expectOk(await d.handle(NS, execFrame('ROLLBACK')));
    const after = await d.handle(NS, execFrame("SELECT points FROM scores WHERE name = 'ada'"));
    expectOk(after);
    expect(after.rows).toEqual([[1]]);
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('after COMMIT → false; after ROLLBACK → false', async () => {
    const { driver: d } = quiet();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await d.inTransaction(NS)).toBe(false);
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, execFrame('ROLLBACK')));
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('after an export frame → false: export() reopened the connection, and the record went with the transaction', async () => {
    const { driver: d } = quiet();
    expectOk(await d.handle(NS, execFrame(SCORES)));
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, exportFrame()));
    expect(await d.inTransaction(NS)).toBe(false);
    // The record tells the truth: the handle holds no transaction any more.
    expectError(await d.handle(NS, execFrame('COMMIT')), DB_ERROR_CODES.SQL_ERROR);
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('after a successful import → false', async () => {
    const { driver: d } = quiet();
    const donor = driver();
    expectOk(await donor.handle('donor', execFrame(SCORES)));
    const exported = await donor.handle('donor', exportFrame());
    expectOk(exported);
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, importFrame(exported.bytesBase64 as string)));
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('a COMMIT that fails "no transaction is active" clears a stale record (the handle ended the transaction behind the verbs)', async () => {
    const { driver: d } = quiet();
    expectOk(await d.handle(NS, execFrame('CREATE TABLE tags (k TEXT UNIQUE)')));
    expectOk(await d.handle(NS, execFrame("INSERT INTO tags (k) VALUES ('a')")));
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    // OR ROLLBACK on a constraint failure rolls the WHOLE transaction back inside a failed
    // statement — no transaction verb the record reads ran, so the record still says open.
    expectError(await d.handle(NS, execFrame("INSERT OR ROLLBACK INTO tags (k) VALUES ('a')")), DB_ERROR_CODES.SQL_ERROR);
    expect(await d.inTransaction(NS)).toBe(true);
    const commit = await d.handle(NS, execFrame('COMMIT'));
    expectError(commit, DB_ERROR_CODES.SQL_ERROR);
    if (!commit.ok) expect(commit.message).toMatch(/no transaction is active/i);
    expect(await d.inTransaction(NS)).toBe(false);
    expect(await isBusy(d)).toBe(false); // the seat is not stranded either
  });

  it('SAVEPOINT/RELEASE nest inside a BEGIN: BEGIN; SAVEPOINT a; RELEASE a → still true; COMMIT → false', async () => {
    const { driver: d } = quiet();
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectOk(await d.handle(NS, execFrame('SAVEPOINT a')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, execFrame('RELEASE a')));
    expect(await d.inTransaction(NS)).toBe(true);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('the closed driver answers false, never throws', async () => {
    const { driver: d } = quiet();
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expect(await d.inTransaction(NS)).toBe(true);
    await d.close();
    await expect(d.inTransaction(NS)).resolves.toBe(false);
  });
});

describe('brokeredWrite’s OWN variant — { own, caps, expectChanges }: the DML belts only, no facts, no capture, never undoable (D-PR3-8; E1-Q12)', () => {
  const AUDITED = [
    SCORES,
    'CREATE TABLE audit (what TEXT)',
    "CREATE TRIGGER scores_audit AFTER UPDATE ON scores BEGIN INSERT INTO audit (what) VALUES ('changed ' || new.name); END",
    "INSERT INTO scores (name, points) VALUES ('ada', 1), ('bo', 2)",
  ];

  async function seeded(statements: readonly string[] = AUDITED): Promise<{ driver: SnugDbDriver; events: NamespaceWriteEvent[] }> {
    const made = signalled();
    for (const sql of statements) expectOk(await made.driver.handle(NS, execFrame(sql)));
    made.events.length = 0;
    return made;
  }

  async function rows(d: SnugDbDriver, sql: string): Promise<unknown[][]> {
    const result = await d.handle(NS, execFrame(sql));
    expectOk(result);
    return result.rows ?? [];
  }

  const own = (statements: Array<{ sql: string; params?: unknown[] }>, expectChanges?: number[]): BrokeredWriteInput => ({
    own: statements,
    caps: BROKER_CAPS,
    ...(expectChanges === undefined ? {} : { expectChanges }),
  });

  it('a table WITH an app trigger applies (the strict facts would refuse it): the trigger’s audit row lands, undoable false, no capture object', async () => {
    const { driver: d } = await seeded();
    const result = await d.brokeredWrite(NS, own([{ sql: 'UPDATE scores SET points = ? WHERE name = ?', params: [50, 'ada'] }], [1]));
    expect(result).toEqual({ ok: true, steps: [], changes: [1], undoable: false });
    expect(await rows(d, "SELECT points FROM scores WHERE name = 'ada'")).toEqual([[50]]);
    expect(await rows(d, 'SELECT what FROM audit')).toEqual([['changed ada']]);
    expect(await rows(d, 'SELECT name FROM sqlite_temp_master')).toEqual([]);
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('a drifted count → ROLLBACK, answered with previewed and current; nothing changed, no signal', async () => {
    const { driver: d, events } = await seeded();
    const result = await d.brokeredWrite(NS, own([{ sql: 'UPDATE scores SET points = 9' }], [1]));
    expect(result).toMatchObject({ ok: false, reason: 'drifted', previewed: [1], current: [2], retryable: false });
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 1],
      ['bo', 2],
    ]);
    expect(await rows(d, 'SELECT what FROM audit')).toEqual([]);
    expect(events).toEqual([]);
  });

  it('two statements in one entry → refused (rule statement), and neither ran', async () => {
    const { driver: d, events } = await seeded();
    const result = await d.brokeredWrite(NS, own([{ sql: "UPDATE scores SET points = 5 WHERE name = 'ada'; UPDATE scores SET points = 6 WHERE name = 'bo'" }]));
    expect(result).toMatchObject({ ok: false, reason: 'refused', rule: 'statement', retryable: false });
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 1],
      ['bo', 2],
    ]);
    expect(events).toEqual([]);
  });

  it('a DDL is refused by the class belt (nonDataStatementReason) and never runs', async () => {
    const { driver: d, events } = await seeded();
    for (const sql of ['DROP TABLE scores', 'CREATE TABLE extra (a TEXT)', 'ALTER TABLE scores ADD COLUMN x TEXT']) {
      const result = await d.brokeredWrite(NS, own([{ sql }]));
      expect(result).toMatchObject({ ok: false, reason: 'refused', rule: 'statement', retryable: false });
    }
    expect(await rows(d, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).toEqual([['audit'], ['scores']]);
    expect(await rows(d, 'SELECT count(*) FROM pragma_table_info(\'scores\')')).toEqual([[2]]);
    expect(events).toEqual([]);
  });

  it('busy under the app’s open BEGIN (retryable), and the app’s transaction is left as it was', async () => {
    const { driver: d, events } = await seeded();
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectOk(await d.handle(NS, execFrame("UPDATE scores SET points = 7 WHERE name = 'ada'")));
    events.length = 0;
    const result = await d.brokeredWrite(NS, own([{ sql: "UPDATE scores SET points = 50 WHERE name = 'bo'" }], [1]));
    expect(result).toMatchObject({ ok: false, reason: 'busy', retryable: true });
    expect(events).toEqual([]);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 7],
      ['bo', 2],
    ]);
  });

  it('the brokered signal: the table from dmlTargetTable when every statement names the same one, changes the SUM; none when they differ', async () => {
    const { driver: d, events } = await seeded();
    const same = await d.brokeredWrite(
      NS,
      own(
        [
          { sql: "UPDATE scores SET points = 10 WHERE name = 'ada'" },
          { sql: 'INSERT INTO "scores" (name, points) VALUES (?, ?), (?, ?)', params: ['cy', 3, 'di', 4] },
        ],
        [1, 2],
      ),
    );
    expect(same).toMatchObject({ ok: true, changes: [1, 2], undoable: false });
    expect(events).toEqual([{ namespace: NS, kind: 'brokered', table: 'scores', changes: 3 }]);

    events.length = 0;
    const mixed = await d.brokeredWrite(NS, own([{ sql: "DELETE FROM scores WHERE name = 'di'" }, { sql: "INSERT INTO audit (what) VALUES ('by hand')" }]));
    expect(mixed).toMatchObject({ ok: true, changes: [1, 1] });
    expect(events).toEqual([{ namespace: NS, kind: 'brokered', changes: 2 }]);
  });
});

// TASK-20261010-host-broker PR-4 (contract v2 D-PR4-4; AC32b): the driver FORWARDS the capture
// variant of own mode — `{ own, capture: true, caps, expectChanges, requireUndo, admit }` — to the
// pure seat. The bare-{own} describe above stays exactly as written (F18); this is its own describe.
// The variant's type is read from the driver's own union, so it is `never` until it lands (tsc red).
type OwnCaptureWrite = Extract<BrokeredWriteInput, { own: unknown; capture: true }>;
type CapturedStep = { table: string; op: string; columns: string[]; rows: Array<{ rowid: number; before?: unknown[]; after?: unknown[] }> };

describe('brokeredWrite FORWARDS the capture variant of own mode (D-PR4-4)', () => {
  async function seeded(): Promise<{ driver: SnugDbDriver; events: NamespaceWriteEvent[] }> {
    const made = signalled();
    for (const sql of [SCORES, "INSERT INTO scores (name, points) VALUES ('ada', 1), ('bo', 2)"]) expectOk(await made.driver.handle(NS, execFrame(sql)));
    made.events.length = 0;
    return made;
  }

  async function rows(d: SnugDbDriver, sql: string): Promise<unknown[][]> {
    const result = await d.handle(NS, execFrame(sql));
    expectOk(result);
    return result.rows ?? [];
  }

  const capturing = (
    statements: Array<{ sql: string; params?: unknown[] }>,
    over: { expectChanges?: number[]; requireUndo?: boolean; admit?: (steps: readonly CapturedStep[]) => boolean } = {},
  ): OwnCaptureWrite =>
    ({ own: statements, capture: true, caps: BROKER_CAPS, requireUndo: true, admit: () => true, ...over }) as unknown as OwnCaptureWrite;

  it('captures through the seat: steps, undoable, the admit asked once — and the brokered signal raised with the table and the summed changes', async () => {
    const { driver: d, events } = await seeded();
    const asked: CapturedStep[][] = [];
    const result = await d.brokeredWrite(
      NS,
      capturing([{ sql: 'UPDATE scores SET points = ? WHERE name = ?', params: [50, 'ada'] }, { sql: "INSERT INTO scores (name, points) VALUES ('cy', 3)" }], {
        expectChanges: [1, 1],
        admit: (steps) => {
          asked.push(JSON.parse(JSON.stringify(steps)) as CapturedStep[]);
          return true;
        },
      }),
    );
    expect(result).toMatchObject({ ok: true, changes: [1, 1], undoable: true });
    if (!result.ok) return;
    expect(result.steps).toEqual([
      { table: 'scores', op: 'update', columns: ['points'], rows: [{ rowid: 1, before: [1], after: [50] }] },
      { table: 'scores', op: 'insert', columns: ['name', 'points'], rows: [{ rowid: 3, after: ['cy', 3] }] },
    ]);
    expect(asked).toEqual([result.steps]);
    expect(events).toEqual([{ namespace: NS, kind: 'brokered', table: 'scores', changes: 2 }]);
    expect(await rows(d, 'SELECT name FROM sqlite_temp_master')).toEqual([]);
    expect(await d.inTransaction(NS)).toBe(false);
  });

  it('admit false under requireUndo → cannot-undo (not retryable): nothing changed, no signal', async () => {
    const { driver: d, events } = await seeded();
    const result = await d.brokeredWrite(NS, capturing([{ sql: "UPDATE scores SET points = 9 WHERE name = 'ada'" }], { expectChanges: [1], admit: () => false }));
    expect(result).toMatchObject({ ok: false, reason: 'cannot-undo', retryable: false });
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 1],
      ['bo', 2],
    ]);
    expect(events).toEqual([]);
  });

  it('admit false WITHOUT requireUndo commits undoable false (the approval\'s path) and signals', async () => {
    const { driver: d, events } = await seeded();
    let asked = 0;
    const result = await d.brokeredWrite(
      NS,
      capturing([{ sql: "UPDATE scores SET points = 9 WHERE name = 'ada'" }], {
        expectChanges: [1],
        requireUndo: false,
        admit: () => {
          asked += 1;
          return false;
        },
      }),
    );
    expect(asked).toBe(1);
    expect(result).toMatchObject({ ok: true, changes: [1], undoable: false, steps: [] });
    expect(events).toEqual([{ namespace: NS, kind: 'brokered', table: 'scores', changes: 1 }]);
  });

  it('busy under the app’s open BEGIN (retryable) BEFORE the handle is touched — admit never asked, the app’s transaction intact', async () => {
    const { driver: d, events } = await seeded();
    expectOk(await d.handle(NS, execFrame('BEGIN')));
    expectOk(await d.handle(NS, execFrame("UPDATE scores SET points = 7 WHERE name = 'ada'")));
    events.length = 0;
    let asked = 0;
    const result = await d.brokeredWrite(
      NS,
      capturing([{ sql: "UPDATE scores SET points = 50 WHERE name = 'bo'" }], {
        admit: () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'busy', retryable: true });
    expect(asked).toBe(0);
    expect(events).toEqual([]);
    expectOk(await d.handle(NS, execFrame('COMMIT')));
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 7],
      ['bo', 2],
    ]);
  });

  it('an unplannable batch is refused by name (not retryable) and nothing ran — the capture variant never falls into a mixed batch', async () => {
    const { driver: d, events } = await seeded();
    const result = await d.brokeredWrite(
      NS,
      capturing([{ sql: "UPDATE scores SET points = 5 WHERE name = 'ada'" }, { sql: "UPDATE scores SET points = abs(-6) WHERE name = 'bo'" }]),
    );
    expect(result).toMatchObject({ ok: false, reason: 'refused', retryable: false });
    expect(await rows(d, 'SELECT name, points FROM scores ORDER BY rowid')).toEqual([
      ['ada', 1],
      ['bo', 2],
    ]);
    expect(events).toEqual([]);
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
