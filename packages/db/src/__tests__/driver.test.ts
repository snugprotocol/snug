// DbDriver contract tests (task ACs 3, 4, 6, 7): sql.js exec/kv/export/import per
// namespace, errors as DbDriverResult data (the driver NEVER throws), and the
// protocol size caps (5 MiB artifacts, 8 MiB db frame class).
import type { DbDriver } from '@snugprotocol/runner';
import { LIMITS } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';
import { DB_ERROR_CODES, createDbDriver, createMemoryBackend, type SnugDbDriver } from '../index.js';
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
