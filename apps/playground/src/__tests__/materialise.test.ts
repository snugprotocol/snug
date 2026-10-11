// materialise.test.ts — the Access Service's two new acts and the alias rules (TASK-20261010-host-
// broker PR-2: AC10; contract v2 D-PR2-3 session grants per door · D-PR2-4 attendance per door ·
// D-PR2-6 the dump · D-PR2-7 dump without a line, ONE `read` line per grant before rows reach a
// brain · D-PR2-8 aliases de-collided against the reader's FULL object names · D-PR2-18 never throws).
//
// THROUGH `accessService()` — the one engine — over the real user db (`__setAccessDepsForTests`), the
// real grants and the INLINE worker (the real worker responder, `scopedScratchDump` on node sql.js):
//   - `materialise(caller)` dumps every LIVE grant the caller owns and may read — through the Worker —
//     aliases its tables `<alias>__<table>`, and writes NO history line (the DDL block is the
//     `list`-class disclosure);
//   - `recordRead(caller, set, { grantIds, sql? })` writes ONE `read` line per named grant — the
//     posture, every granted table, the rows handed over, the statement as the history keeps it —
//     after re-checking the grant, and BEFORE it answers (the caller hands the tables out only for
//     the ids it answers `recorded`);
//   - a grant-level failure is a SKIP with a reason, never a throw, never a strike.
//
// Written before the module existed (Gate 3): `access/service.ts`, `access/materialise.ts` and
// `access/limits.ts` were reached through variable-specifier imports and the contract's shapes were
// written out here; now imported directly — the real exports are the types (PR-2 Gate-5 M-10).
//
// Mutation checks (to run by hand once D2b lands, each red then restored):
//  - write the read line after `recordRead` answers (a deferred append) → the "BEFORE it answers" row reds;
//  - skip the post-dump re-check → the revoke-while-the-worker-answers rows red;
//  - compare generations with `===` alone in `ownsGrant` → the unbound row reds;
//  - drop the set budget (per-table caps only) → the too-large row reds;
//  - de-collide against the registry only → the runtime-table and view rows red;
//  - count a strike on a dump timeout → the timeout row reds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { ACCESS_LOG_SQL_MAX_CHARS, ACCESS_SCOPED_CACHE_MS, FRAME_TYPES, PROTOCOL_VERSION, type AccessLogEntry } from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { NO_ACCESS_ASKS_KEY, collectSources, pendingAccessStore } from '../access/consent.js';
import {
  __setAccessDepsForTests,
  createGrantFromDecision,
  findAccessGrant,
  grantsForApp,
  readerGeneration,
  resetAccessSession,
  revokeAccess,
  suspendAccess,
  type AnyAccessGrant,
} from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import * as limits from '../access/limits.js';
import { ACCESS_MATERIALISE_MAX_BYTES, ACCESS_MATERIALISE_TIMEOUT_MS } from '../access/limits.js';
import { aliasFor, namesTable, takenNamesFor, toAttach } from '../access/materialise.js';
import { stillReadable, type AccessCaller } from '../access/policy.js';
import { EMPTY_MATERIALISED_SET, accessService, type MaterialisedSet } from '../access/service.js';
import { startUserAsk } from '../access/userAsk.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

// =========================================================================================
// The world
// =========================================================================================

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const DAY = 86_400_000;
const iso = (at: number): string => new Date(at).toISOString();

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let clock: { now: number };
let posted: unknown[];
let seq = 0;

const chatClosed = (): AccessCaller => ({ kind: 'chat', appId: budget, threadId: 'thread-1' });
const chatAt = (liveGeneration: number): AccessCaller => ({ kind: 'chat', appId: budget, threadId: 'thread-1', liveGeneration });
/** The chat as the door builds it: the reader's live generation at the call. */
const chatNow = (): AccessCaller => {
  const liveGeneration = readerGeneration(budget);
  return { kind: 'chat', appId: budget, threadId: 'thread-1', ...(liveGeneration !== undefined ? { liveGeneration } : {}) };
};
const scheduled = (): AccessCaller => ({ kind: 'schedule', appId: budget, taskId: 'task-1', runId: 'run-1' });

/** The inline worker — the real responder — recording every message it is posted; `before` runs before a dump job is answered. */
function inlineWorkers(before?: (msg: unknown) => Promise<void>): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        posted.push(msg);
        void (async () => {
          if (before !== undefined && isDump(msg)) await before(msg);
          const answer = await respond(msg);
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        })();
      },
      terminate() {},
    };
    return worker;
  };
}

/** A worker that never answers (the dump's clock). */
function silentWorkers(): () => WorkerLike {
  return () => ({
    onmessage: null,
    onerror: null,
    postMessage(msg: unknown) {
      posted.push(msg);
    },
    terminate() {},
  });
}

const isDump = (msg: unknown): boolean => typeof msg === 'object' && msg !== null && (msg as { kind?: unknown }).kind === 'dump';
const dumpJobs = (): unknown[] => posted.filter(isDump);

async function exec(appId: string, sql: string): Promise<void> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${++seq}`, instanceId: 'seed', op: 'exec', sql });
  if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result)}`);
}

async function seed(appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) await exec(appId, sql);
}

async function grantFor(over: { reader?: string; source?: string; tables?: string[]; duration?: 'session' | 'day' | 'week' | 'always'; unattended?: boolean; generation?: number } = {}): Promise<AnyAccessGrant> {
  const reader = over.reader ?? budget;
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === (over.source ?? ledger));
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, {
    readerAppId: reader,
    source,
    tables: over.tables ?? ['transactions'],
    duration: over.duration ?? 'day',
    unattended: over.unattended ?? false,
    purpose: 'to compare spending',
    provenance: 'user',
    ...(over.generation !== undefined ? { generation: over.generation } : {}),
    now: clock.now,
  });
}

/** The default *while it's open* allowed from host chrome while Budget's view is NOT mounted — UNBOUND. */
async function unboundSessionGrant(): Promise<string> {
  expect(readerGeneration(budget)).toBeUndefined();
  await startUserAsk(budget);
  const pending = pendingAccessStore.get()[budget];
  if (pending === undefined) throw new Error('the user ask parked nothing');
  const outcome = await pending.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'session', unattended: false });
  if (outcome.kind !== 'allowed') throw new Error(outcome.kind);
  expect(findAccessGrant(db, outcome.grantId)).toMatchObject({ session: true, generation: undefined });
  return outcome.grantId;
}

const kindsOf = (sourceId: string): string[] => db.listAccessLog(sourceId).map((entry) => entry.kind);
const namesOf = (set: MaterialisedSet): string[] => set.tables.map((table) => table.name);
const sortRows = (rows: unknown[][]): unknown[][] => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  clock = { now: T0 };
  posted = [];
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seed(
    ledger,
    ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)'],
    ["INSERT INTO transactions (amount, category, api_key) VALUES (450, 'food', 'k-one'), (500, 'rent', 'k-two')", "INSERT INTO accounts VALUES ('main', 9000)"],
  );
  await seed(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
  configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
});

afterEach(() => {
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// =========================================================================================
// The limits (contract v2 access/limits.ts)
// =========================================================================================

describe('access/limits.ts — the in-host caps (PR-3 moves them to protocol Appendix B)', () => {
  it('5,000 rows and 2 MiB per table, 8 MiB per set, a 5 s clock per dump', async () => {
    expect({ ...limits }).toMatchObject({
      ACCESS_MATERIALISE_MAX_ROWS: 5_000,
      ACCESS_MATERIALISE_MAX_BYTES: 2 * 1024 * 1024,
      ACCESS_MATERIALISE_MAX_SET_BYTES: 8 * 1024 * 1024,
      ACCESS_MATERIALISE_TIMEOUT_MS: 5_000,
    });
  });
});

// =========================================================================================
// materialise — the chat door
// =========================================================================================

describe('materialise(chat) — every live grant the chat owns, aliased, through the Worker, and NO history line (AC10, D-PR2-7)', () => {
  it('the chat gets each live grant’s tables as <alias>__<table>: the scope’s columns, the allow-listed types, the masked rows, the duration', async () => {
    const day = await grantFor({ duration: 'day' });
    const always = await grantFor({ source: pantry, tables: ['items'], duration: 'always', unattended: true });
    const set = await accessService().materialise(chatClosed());

    expect(set.skipped).toEqual([]);
    const byName = new Map(set.tables.map((table) => [table.name, table]));
    expect([...byName.keys()].sort()).toEqual(['ledger__transactions', 'pantry__items']);
    const transactions = byName.get('ledger__transactions')!;
    expect(transactions).toMatchObject({
      grantId: day.id,
      sourceAppId: ledger,
      sourceName: 'Ledger',
      alias: 'ledger',
      table: 'transactions',
      columns: ['id', 'amount', 'category'],
      types: ['INTEGER', 'INTEGER', 'TEXT'],
      truncated: false,
      duration: 'day',
      expiresAt: iso(T0 + DAY),
    });
    expect(sortRows(transactions.rows)).toEqual([
      [1, 450, 'food'],
      [2, 500, 'rent'],
    ]);
    const items = byName.get('pantry__items')!;
    expect(items).toMatchObject({ grantId: always.id, sourceName: 'Pantry', alias: 'pantry', table: 'items', columns: ['name', 'qty'], types: ['TEXT', 'INTEGER'], rows: [['rice', 2]], duration: 'always' });
    expect(items.expiresAt).toBeUndefined();
    expect(JSON.stringify(set), 'a credential-named column never crosses').not.toMatch(/api_key|k-one|k-two/);
  });

  it('the rows come THROUGH the Worker (one dump job per grant) — and nothing is written: no line on any source, no read counted', async () => {
    const day = await grantFor({ duration: 'day' });
    await grantFor({ source: pantry, tables: ['items'], duration: 'week' });
    await accessService().materialise(chatClosed());
    expect(dumpJobs()).toHaveLength(2);
    expect(kindsOf(ledger)).toEqual(['granted']);
    expect(kindsOf(pantry)).toEqual(['granted']);
    expect(db.getAccessGrant(day.id)).toMatchObject({ reads: 0 });
    expect(db.getAccessGrant(day.id)?.lastReadAt).toBeUndefined();
  });

  it('readOnlyTables is every materialised name, sorted', async () => {
    await grantFor({ source: pantry, tables: ['items'] });
    await grantFor({ tables: ['transactions', 'accounts'] });
    const set = await accessService().materialise(chatClosed());
    expect(set.readOnlyTables).toEqual(['ledger__accounts', 'ledger__transactions', 'pantry__items']);
  });

  it('only LIVE grants of THIS reader: another reader’s, a stopped, a paused and an expired one are simply absent — no skip, no line', async () => {
    await grantFor({ reader: pantry, tables: ['transactions'] });
    const stopped = await grantFor({ duration: 'week' });
    await revokeAccess(stopped.id);
    const paused = await grantFor({ duration: 'week', source: pantry, tables: ['items'] });
    await suspendAccess(db, paused.id, 'imported', iso(clock.now));
    await grantFor({ duration: 'day', tables: ['accounts'] });
    clock.now += DAY;
    const set = await accessService().materialise(chatClosed());
    expect(set).toEqual({ tables: [], skipped: [], readOnlyTables: [] });
    expect(kindsOf(ledger).filter((kind) => kind === 'refused' || kind === 'read')).toEqual([]);
  });
});

describe('D-PR2-3 materialise — session grants per door', () => {
  it('an UNBOUND session grant is materialised by NO chat caller — closed, or claiming any generation — and IS once the frame binds it and the chat passes that generation', async () => {
    const id = await unboundSessionGrant();
    const svc = accessService();
    for (const caller of [chatClosed(), chatAt(0), chatAt(3)]) {
      const set = await svc.materialise(caller);
      expect(set.tables, JSON.stringify(caller)).toEqual([]);
      expect(set.skipped, 'not owned is simply absent').toEqual([]);
    }
    createAccessHandlerFor(budget, { attended: true, generation: 2 }); // the run view composes: the grant binds to 2
    const bound = await svc.materialise(chatNow());
    expect(bound.tables).toEqual([expect.objectContaining({ grantId: id, name: 'ledger__transactions', duration: 'session' })]);
    expect(bound.tables[0]?.expiresAt).toBeUndefined();
  });

  it('a session grant whose generation is not the chat’s live one is absent; at its own generation it is there', async () => {
    createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const session = await grantFor({ duration: 'session', generation: 0 });
    const svc = accessService();
    expect((await svc.materialise(chatAt(1))).tables).toEqual([]);
    expect((await svc.materialise(chatClosed())).tables).toEqual([]);
    expect((await svc.materialise(chatAt(0))).tables.map((table) => table.grantId)).toEqual([session.id]);
  });
});

describe('D-PR2-4 materialise(schedule) — only persisted grants allowed *also while I’m away*, read with no one present', () => {
  it('the schedule gets the away grant only — not one without the box, not a session grant even with it — and skips the others SILENTLY', async () => {
    createAccessHandlerFor(budget, { attended: true, generation: 0 });
    await grantFor({ duration: 'day', unattended: false });
    await grantFor({ duration: 'session', generation: 0, unattended: true, tables: ['accounts'] });
    const away = await grantFor({ source: pantry, tables: ['items'], duration: 'always', unattended: true });
    const set = await accessService().materialise(scheduled());
    expect(set.tables.map((table) => [table.grantId, table.name])).toEqual([[away.id, 'pantry__items']]);
    expect(set.skipped).toEqual([]);
    expect(kindsOf(ledger), 'a schedule skip writes no line').toEqual(['granted', 'granted']);
  });

  it('its read line says attended: false and carries no statement', async () => {
    const away = await grantFor({ source: pantry, tables: ['items'], duration: 'always', unattended: true });
    const svc = accessService();
    const set = await svc.materialise(scheduled());
    expect(await svc.recordRead(scheduled(), set, { grantIds: [away.id] })).toEqual({ recorded: [away.id], refused: [] });
    const line = db.listAccessLog(pantry)[0];
    expect(line).toMatchObject({ kind: 'read', grantId: away.id, readerAppId: budget, readerName: 'Budget', tables: ['items'], rows: 1, attended: false });
    expect(line?.sql).toBeUndefined();
  });
});

// =========================================================================================
// recordRead — the line BEFORE rows reach a brain
// =========================================================================================

describe('D-PR2-7 recordRead — ONE read line per named grant, written before it answers', () => {
  it('writes the line at once — attended true for the chat, EVERY granted table, the rows handed over, the statement — and counts the read', async () => {
    const both = await grantFor({ tables: ['transactions', 'accounts'] });
    await grantFor({ source: pantry, tables: ['items'] });
    const svc = accessService();
    const set = await svc.materialise(chatClosed());
    clock.now += 5_000;
    const sql = 'SELECT t.amount, a.balance FROM ledger__transactions t, ledger__accounts a';
    const outcome = await svc.recordRead(chatClosed(), set, { grantIds: [both.id], sql });
    // Read at the very moment the call answers: a line written AFTER the answer (deferred) is red here.
    const line = db.listAccessLog(ledger)[0] as AccessLogEntry | undefined;
    expect(outcome).toEqual({ recorded: [both.id], refused: [] });
    expect(line).toMatchObject({ at: iso(clock.now), kind: 'read', grantId: both.id, readerAppId: budget, readerName: 'Budget', rows: 3, sql, attended: true });
    expect([...(line?.tables ?? [])].sort()).toEqual(['accounts', 'transactions']);
    expect(kindsOf(pantry), 'a grant not named is not recorded').toEqual(['granted']);
    expect(db.getAccessGrant(both.id)).toMatchObject({ reads: 1, lastReadAt: iso(clock.now) });
  });

  it('the statement is kept as the history keeps it: cut at ACCESS_LOG_SQL_MAX_CHARS; a credential-shaped one leaves the seat out', async () => {
    const grant = await grantFor();
    const svc = accessService();
    const set = await svc.materialise(chatClosed());
    const long = `SELECT * FROM ledger__transactions WHERE category IN (${Array.from({ length: 80 }, (_, i) => `'c${i}'`).join(', ')})`;
    await svc.recordRead(chatClosed(), set, { grantIds: [grant.id], sql: long });
    expect(db.listAccessLog(ledger)[0]?.sql).toBe(long.slice(0, ACCESS_LOG_SQL_MAX_CHARS));
    clock.now += 61_000;
    const smuggling = "SELECT * FROM ledger__transactions WHERE category = 'sk-Ab3dEf9hIjKl2MnOpQr5StUvWxYz01234567aBcD'";
    expect(await svc.recordRead(chatClosed(), set, { grantIds: [grant.id], sql: smuggling })).toEqual({ recorded: [grant.id], refused: [] });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'read', grantId: grant.id });
    expect(db.listAccessLog(ledger)[0]?.sql).toBeUndefined();
  });

  it('a line the history refuses → that grant is refused `failed`, its read is not counted, and toAttach of the recorded ids holds none of its tables', async () => {
    const refusedGrant = await grantFor();
    const fine = await grantFor({ source: pantry, tables: ['items'] });
    const svc = accessService();
    const set = await svc.materialise(chatClosed());
    const real = db.appendAccessLog.bind(db);
    vi.spyOn(db, 'appendAccessLog').mockImplementation((sourceAppId, entry) => {
      if (entry.kind === 'read' && entry.grantId === refusedGrant.id) throw new Error('the history is full');
      return real(sourceAppId, entry);
    });
    const outcome = await svc.recordRead(chatClosed(), set, { grantIds: [refusedGrant.id, fine.id], sql: 'SELECT 1 FROM ledger__transactions, pantry__items' });
    expect(outcome.recorded).toEqual([fine.id]);
    expect(outcome.refused).toEqual([{ grantId: refusedGrant.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'failed' }]);
    expect(db.getAccessGrant(refusedGrant.id)).toMatchObject({ reads: 0 });
    expect(toAttach(set, outcome.recorded).map((table) => table.name)).toEqual(['pantry__items']);
  });

  it('a grant stopped, paused or expired AFTER the dump and before recordRead → `ended`: no line, no read counted', async () => {
    const stopped = await grantFor({ duration: 'always' });
    const paused = await grantFor({ duration: 'always', source: pantry, tables: ['items'] });
    const expiring = await grantFor({ duration: 'day', tables: ['accounts'] });
    const svc = accessService();
    const set = await svc.materialise(chatClosed());
    expect(set.tables).toHaveLength(3);
    await revokeAccess(stopped.id);
    await suspendAccess(db, paused.id, 'imported', iso(clock.now));
    clock.now += DAY;
    const outcome = await svc.recordRead(chatClosed(), set, { grantIds: [stopped.id, paused.id, expiring.id] });
    expect(outcome.recorded).toEqual([]);
    expect(outcome.refused.map((skip) => `${skip.grantId}:${skip.reason}`).sort()).toEqual([`${stopped.id}:ended`, `${paused.id}:ended`, `${expiring.id}:ended`].sort());
    expect(kindsOf(ledger).filter((kind) => kind === 'read')).toEqual([]);
    expect(kindsOf(pantry).filter((kind) => kind === 'read')).toEqual([]);
    for (const id of [stopped.id, paused.id, expiring.id]) expect(db.getAccessGrant(id)).toMatchObject({ reads: 0 });
  });
});

// =========================================================================================
// Skips — never a throw, never a strike
// =========================================================================================

describe('D-PR2-6 / D-PR2-18 materialise — every grant-level failure is a skip with a reason', () => {
  it('a stop that lands WHILE the worker answers the dump → skipped `ended`: none of its rows, no line, no read counted', async () => {
    const stopped = await grantFor({ duration: 'always' });
    const kept = await grantFor({ source: pantry, tables: ['items'], duration: 'always' });
    configureScopedRead({
      createWorker: inlineWorkers(async (msg) => {
        if ((msg as { scope?: { tables?: Array<{ name: string }> } }).scope?.tables?.[0]?.name === 'transactions') await revokeAccess(stopped.id);
      }),
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    const set = await accessService().materialise(chatClosed());
    expect(set.tables.map((table) => table.grantId)).toEqual([kept.id]);
    expect(set.skipped).toEqual([{ grantId: stopped.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'ended' }]);
    expect(kindsOf(ledger)).toEqual(['revoked', 'granted']);
    expect(db.getAccessGrant(stopped.id)).toMatchObject({ reads: 0 });
  });

  it('a pause that lands while the worker answers → skipped `ended` too', async () => {
    const paused = await grantFor({ duration: 'always' });
    configureScopedRead({
      createWorker: inlineWorkers(async () => {
        await suspendAccess(db, paused.id, 'imported', iso(clock.now));
      }),
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    const set = await accessService().materialise(chatClosed());
    expect(set.tables).toEqual([]);
    expect(set.skipped).toEqual([{ grantId: paused.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'ended' }]);
  });

  it('drift pauses the grant `source-changed` (one suspended line) and skips it `drift`', async () => {
    const grant = await grantFor();
    await db.applyAppDdl(ledger, ['ALTER TABLE transactions ADD COLUMN note TEXT']);
    const set = await accessService().materialise(chatClosed());
    expect(set.tables).toEqual([]);
    expect(set.skipped).toEqual([{ grantId: grant.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'drift' }]);
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'source-changed' });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'suspended', grantId: grant.id, reason: 'source-changed' });
  });

  it('a dump that outruns its clock skips the grant `timeout` with NO strike — the SQL is the host’s', async () => {
    const grant = await grantFor({ duration: 'always' });
    const svc = accessService();
    configureScopedRead({ createWorker: silentWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let set: MaterialisedSet | undefined;
    void svc.materialise(chatClosed()).then((answer) => {
      set = answer;
    });
    for (let step = 0; step < 40 && set === undefined; step += 1) await vi.advanceTimersByTimeAsync(ACCESS_MATERIALISE_TIMEOUT_MS / 10);
    vi.useRealTimers();
    expect(set).toEqual({ tables: [], skipped: [{ grantId: grant.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'timeout' }], readOnlyTables: [] });
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'active', timeouts: 0 });
  });

  it('where no Worker can be constructed EVERY grant is skipped `unavailable`', async () => {
    const one = await grantFor();
    const two = await grantFor({ source: pantry, tables: ['items'] });
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ createWorker: undefined, wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const set = await accessService().materialise(chatClosed());
    expect(set.tables).toEqual([]);
    expect([...set.skipped].sort((a, b) => a.grantId.localeCompare(b.grantId))).toEqual(
      [
        { grantId: one.id, sourceAppId: ledger, sourceName: 'Ledger', reason: 'unavailable' },
        { grantId: two.id, sourceAppId: pantry, sourceName: 'Pantry', reason: 'unavailable' },
      ].sort((a, b) => a.grantId.localeCompare(b.grantId)),
    );
  });

  it(
    'three grants of 4 MiB each → the first two fill the 8 MiB set, the third (in grant order) is skipped `too-large`',
    async () => {
      // Each table: 2,048 rows whose JSON is exactly 1,024 UTF-8 bytes — 2 MiB, at the per-table cap. The
      // cell is 170 U+0001 characters: 1 byte each in the file (an app's runtime exports at most 5 MiB),
      // 6 each in JSON (`\u0001`), so ["…"] weighs 2 + 2 + 170 × 6 = 1,024.
      const rowsPerTable = ACCESS_MATERIALISE_MAX_BYTES / 1024;
      const fill = `WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < ${rowsPerTable}) SELECT replace(hex(zeroblob(170)), '00', char(1)) FROM r`;
      const sources: string[] = [];
      for (const name of ['Alpha', 'Bravo', 'Charlie']) {
        const appId = db.installApp({ displayName: name, html: `<!doctype html><title>${name}</title>` }).appId;
        await seed(appId, ['CREATE TABLE big_a (v TEXT)', 'CREATE TABLE big_b (v TEXT)'], [`INSERT INTO big_a (v) ${fill}`, `INSERT INTO big_b (v) ${fill}`]);
        sources.push(appId);
      }
      for (const source of sources) await grantFor({ source, tables: ['big_a', 'big_b'], duration: 'always' });
      const order = grantsForApp(db, budget, clock.now).reads.filter((row) => row.live).map((row) => row.grant.id);
      expect(order).toHaveLength(3);

      const set = await accessService().materialise(chatClosed());
      expect(set.skipped).toEqual([expect.objectContaining({ grantId: order[2], reason: 'too-large' })]);
      expect([...new Set(set.tables.map((table) => table.grantId))]).toEqual([order[0], order[1]]);
      for (const table of set.tables) {
        expect(table.rows, table.name).toHaveLength(rowsPerTable);
        expect(table.truncated, table.name).toBe(false);
      }
    },
    120_000,
  );

  it('a service-level failure answers the EMPTY set with ONE skip naming the reader — never a throw', async () => {
    await grantFor();
    vi.spyOn(db, 'listAccessGrants').mockImplementation(() => {
      throw new Error('the file is unreadable');
    });
    const set = await accessService().materialise(chatClosed());
    expect(set.tables).toEqual([]);
    expect(set.readOnlyTables).toEqual([]);
    expect(set.skipped).toEqual([expect.objectContaining({ sourceName: 'Budget', reason: 'failed' })]);
  });

  it('EMPTY_MATERIALISED_SET is the set with nothing in it', async () => {
    expect(EMPTY_MATERIALISED_SET).toEqual({ tables: [], skipped: [], readOnlyTables: [] });
  });
});

// M-4 (PR-2 Gate-5): with nothing to materialise, the reader's names are never read — no flush, no
// runtime export, no registry read on a data-lane turn whose reader holds no live grant.
describe('materialise with no live grants reads nothing of the reader', () => {
  it('a chat caller with no live grants never calls listAppObjectNames, describeAppData or getAppSchema — and answers the empty set', async () => {
    const stopped = await grantFor({ duration: 'week' });
    await revokeAccess(stopped.id);
    const methods = (['listAppObjectNames', 'describeAppData', 'getAppSchema'] as const).filter((name) => typeof (db as unknown as Record<string, unknown>)[name] === 'function');
    expect(methods).toEqual(expect.arrayContaining(['describeAppData', 'getAppSchema']));
    const spies = methods.map((name) => [name, vi.spyOn(db as unknown as Record<string, (...args: unknown[]) => unknown>, name)] as const);
    const set = await accessService().materialise(chatClosed());
    expect(set).toEqual({ tables: [], skipped: [], readOnlyTables: [] });
    for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
    expect(dumpJobs()).toEqual([]);
  });

  it('the schedule caller too: no away grant → no read of the reader’s names', async () => {
    await grantFor({ duration: 'day', unattended: false });
    const methods = (['listAppObjectNames', 'describeAppData', 'getAppSchema'] as const).filter((name) => typeof (db as unknown as Record<string, unknown>)[name] === 'function');
    const spies = methods.map((name) => [name, vi.spyOn(db as unknown as Record<string, (...args: unknown[]) => unknown>, name)] as const);
    const set = await accessService().materialise(scheduled());
    expect(set.tables).toEqual([]);
    for (const [name, spy] of spies) expect(spy, name).not.toHaveBeenCalled();
  });
});

// M-2 (PR-2 Gate-5): `stillReadable` — the ONE spelling of "still this caller's, active and
// unexpired" the read's dequeue re-check, recordRead and the post-dump re-check share.
describe('policy.stillReadable — find → owned → active → unexpired, or undefined', () => {
  const find = (id: string) => findAccessGrant(db, id);

  it('a live grant of this caller → the found grant itself', async () => {
    const grant = await grantFor({ duration: 'day' });
    const found = findAccessGrant(db, grant.id);
    expect(found).toBeDefined();
    expect(stillReadable(() => found, chatClosed(), grant.id, clock.now)).toBe(found);
    expect(stillReadable(find, chatClosed(), grant.id, clock.now)).toEqual(found);
    expect(stillReadable(find, scheduled(), grant.id, clock.now), 'ownership is the caller’s, attendance is not this rule’s').toEqual(found);
  });

  it('an absent grant → undefined', () => {
    expect(stillReadable(find, chatClosed(), 'no-such-grant', clock.now)).toBeUndefined();
  });

  it('another reader’s grant → undefined (not owned)', async () => {
    const theirs = await grantFor({ reader: pantry, tables: ['transactions'] });
    expect(stillReadable(find, chatClosed(), theirs.id, clock.now)).toBeUndefined();
  });

  it('an UNBOUND session grant → undefined for every chat (not owned)', async () => {
    const id = await unboundSessionGrant();
    for (const caller of [chatClosed(), chatAt(0), chatAt(3)]) expect(stillReadable(find, caller, id, clock.now), JSON.stringify(caller)).toBeUndefined();
  });

  it('a revoked grant → undefined', async () => {
    const grant = await grantFor({ duration: 'always' });
    await revokeAccess(grant.id);
    expect(stillReadable(find, chatClosed(), grant.id, clock.now)).toBeUndefined();
  });

  it('a suspended grant → undefined', async () => {
    const grant = await grantFor({ duration: 'always' });
    await suspendAccess(db, grant.id, 'imported', iso(clock.now));
    expect(stillReadable(find, chatClosed(), grant.id, clock.now)).toBeUndefined();
  });

  it('an expired grant → undefined at its expiry; the instant before, the found', async () => {
    const grant = await grantFor({ duration: 'day' });
    expect(stillReadable(find, chatClosed(), grant.id, T0 + DAY - 1)).toEqual(findAccessGrant(db, grant.id));
    expect(stillReadable(find, chatClosed(), grant.id, T0 + DAY)).toBeUndefined();
  });
});

describe('the 10 s cache — the rows of a grant are dumped once per window', () => {
  it('a second materialise inside ACCESS_SCOPED_CACHE_MS posts no dump and serves the same rows; after the window it dumps again', async () => {
    await grantFor({ duration: 'always' });
    const svc = accessService();
    const first = await svc.materialise(chatClosed());
    expect(dumpJobs()).toHaveLength(1);
    clock.now += ACCESS_SCOPED_CACHE_MS - 1;
    const second = await svc.materialise(chatClosed());
    expect(dumpJobs()).toHaveLength(1);
    expect(second.tables.map((table) => table.rows)).toEqual(first.tables.map((table) => table.rows));
    clock.now += 1;
    await svc.materialise(chatClosed());
    expect(dumpJobs()).toHaveLength(2);
  });
});

// =========================================================================================
// D-PR2-8 aliases, de-collided against the reader's FULL object names
// =========================================================================================

describe('D-PR2-8 aliasFor — the slug', () => {
  it('lower-case; every run of anything but [a-z0-9] becomes one _; trimmed', async () => {
    expect(aliasFor('Ledger', ['transactions'], new Set())).toBe('ledger');
    expect(aliasFor('My Budget — 2026!', ['t'], new Set())).toBe('my_budget_2026');
    expect(aliasFor('  Meal--Plan  ', ['t'], new Set())).toBe('meal_plan');
    expect(aliasFor('Ünïcode Café', ['t'], new Set())).toBe('n_code_caf');
  });

  it('at most 32 characters', async () => {
    expect(aliasFor('A'.repeat(40), ['t'], new Set())).toBe('a'.repeat(32));
  });

  it('prefixed app_ when it does not start with a letter', async () => {
    expect(aliasFor('2026 Plans', ['t'], new Set())).toBe('app_2026_plans');
  });

  it('2, 3, … appended when ANY <slug>__<table> of the granted tables is taken — and only then', async () => {
    expect(aliasFor('Ledger', ['transactions'], new Set(['ledger__transactions']))).toBe('ledger2');
    expect(aliasFor('Ledger', ['transactions'], new Set(['ledger__transactions', 'ledger2__transactions']))).toBe('ledger3');
    expect(aliasFor('Ledger', ['transactions', 'accounts'], new Set(['ledger__accounts']))).toBe('ledger2');
    expect(aliasFor('Ledger', ['transactions'], new Set(['ledger', 'ledger__accounts'])), 'the bare slug is not a full name').toBe('ledger');
  });
});

describe('D-PR2-8 takenNamesFor + materialise — the reader’s own names are never shadowed', () => {
  it('the reader’s own registry TABLE named ledger__transactions → the alias moves to ledger2', async () => {
    await db.applyAppDdl(budget, ['CREATE TABLE ledger__transactions (id INTEGER)']);
    await grantFor();
    const set = await accessService().materialise(chatClosed());
    expect(namesOf(set)).toEqual(['ledger2__transactions']);
    expect(set.tables[0]?.alias).toBe('ledger2');
  });

  it('a VIEW of that name → ledger2', async () => {
    await db.applyAppDdl(budget, ['CREATE TABLE own (id INTEGER)', 'CREATE VIEW ledger__transactions AS SELECT id FROM own']);
    await grantFor();
    expect(namesOf(await accessService().materialise(chatClosed()))).toEqual(['ledger2__transactions']);
  });

  it('a table the app’s CODE created at runtime (in the runtime bytes, not the registry) → ledger2', async () => {
    await exec(budget, 'CREATE TABLE ledger__transactions (id INTEGER)');
    expect(JSON.stringify(db.getAppSchema(budget) ?? {})).not.toContain('ledger__transactions');
    expect(await takenNamesFor(db, budget)).toContain('ledger__transactions');
    await grantFor();
    expect(namesOf(await accessService().materialise(chatClosed()))).toEqual(['ledger2__transactions']);
  });

  // SEC-3 (PR-2 Gate-5): the reader's own CODE may create a view, an index or a trigger of the alias
  // name at runtime — not in the registry, not a table. takenNamesFor reads every runtime object
  // name (`listAppObjectNames`), so the alias moves and the scratch attach never has to refuse it.
  for (const [kind, ddl] of [
    ['VIEW', 'CREATE VIEW ledger__transactions AS SELECT id FROM own'],
    ['INDEX', 'CREATE INDEX ledger__transactions ON own (id)'],
    ['TRIGGER', 'CREATE TRIGGER ledger__transactions AFTER INSERT ON own BEGIN SELECT 1; END'],
  ] as const) {
    it(`a runtime-created ${kind} named ledger__transactions → ledger2, and the attach takes the set without refusing`, async () => {
      await exec(budget, 'CREATE TABLE own (id INTEGER)');
      await exec(budget, ddl);
      expect(JSON.stringify(db.getAppSchema(budget) ?? {})).not.toContain('ledger__transactions');
      expect(await takenNamesFor(db, budget)).toContain('ledger__transactions');
      await grantFor();
      const set = await accessService().materialise(chatClosed());
      expect(namesOf(set)).toEqual(['ledger2__transactions']);
      expect(set.tables[0]?.alias).toBe('ledger2');
      const run = await db.scratchRun(budget, [{ sql: 'SELECT count(*) FROM ledger2__transactions' }], { attach: toAttach(set) });
      expect(run.statements[0]?.error).toBeUndefined();
      expect(run.statements[0]?.rows).toEqual([[2]]);
    });
  }

  it('takenNamesFor answers every runtime object name lower-cased — a runtime Ledger__Transactions VIEW is taken as ledger__transactions', async () => {
    await exec(budget, 'CREATE TABLE own (id INTEGER)');
    await exec(budget, 'CREATE VIEW Ledger__Transactions AS SELECT id FROM own');
    const taken = await takenNamesFor(db, budget);
    expect(taken).toContain('ledger__transactions');
    expect(taken).toContain('own');
    expect(taken).not.toContain('Ledger__Transactions');
  });

  it('a case-only collision (Ledger__Transactions) → ledger2', async () => {
    await db.applyAppDdl(budget, ['CREATE TABLE Ledger__Transactions (id INTEGER)']);
    await grantFor();
    expect(namesOf(await accessService().materialise(chatClosed()))).toEqual(['ledger2__transactions']);
  });

  it('a second source of the same name → ledger and ledger2 (every earlier alias’s full names are taken)', async () => {
    const twin = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l2</title>' }).appId;
    await seed(twin, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)'], ['INSERT INTO transactions (amount) VALUES (7)']);
    await grantFor();
    await grantFor({ source: twin });
    const set = await accessService().materialise(chatClosed());
    expect(namesOf(set).sort()).toEqual(['ledger2__transactions', 'ledger__transactions']);
    expect(new Set(set.tables.map((table) => table.alias)).size).toBe(2);
  });

  it('snug_kv is taken; a source called SQLite never yields a sqlite_* name (SQLite reserves them)', async () => {
    expect(await takenNamesFor(db, budget)).toContain('snug_kv');
    const reserved = db.installApp({ displayName: 'SQLite', html: '<!doctype html><title>s</title>' }).appId;
    await seed(reserved, ['CREATE TABLE notes (body TEXT)'], ["INSERT INTO notes VALUES ('hi')"]);
    await grantFor({ source: reserved, tables: ['notes'] });
    const set = await accessService().materialise(chatClosed());
    expect(set.tables).toHaveLength(1);
    expect(set.tables[0]!.name.toLowerCase().startsWith('sqlite_')).toBe(false);
  });
});

// =========================================================================================
// toAttach and namesTable
// =========================================================================================

describe('toAttach — what the scratch copy is handed', () => {
  it('every table as { name, columns, rows } — or only the named grants’ tables', async () => {
    const mine = await grantFor({ tables: ['transactions', 'accounts'] });
    await grantFor({ source: pantry, tables: ['items'] });
    const set = await accessService().materialise(chatClosed());
    expect(toAttach(set).map((table) => table.name).sort()).toEqual(['ledger__accounts', 'ledger__transactions', 'pantry__items']);
    const only = toAttach(set, [mine.id]);
    expect(only.map((table) => table.name).sort()).toEqual(['ledger__accounts', 'ledger__transactions']);
    const accounts = only.find((table) => table.name === 'ledger__accounts')!;
    expect(accounts).toEqual({ name: 'ledger__accounts', columns: ['name', 'balance'], rows: [['main', 9000]] });
  });
});

describe('D-PR2-10 namesTable — the whole-identifier match', () => {
  const NAME = 'ledger__transactions';
  it('true for the name bare, "quoted", `quoted`, [bracketed], in any case, qualified by a column, and — conservatively — inside a string literal', async () => {
    for (const sql of [
      'SELECT * FROM ledger__transactions',
      'SELECT * FROM "ledger__transactions"',
      'SELECT * FROM `ledger__transactions`',
      'SELECT * FROM [ledger__transactions]',
      'SELECT * FROM LEDGER__Transactions',
      'SELECT ledger__transactions.amount FROM ledger__transactions',
      'SELECT e.label FROM envelopes e JOIN ledger__transactions t ON t.id = e.id',
      "SELECT 'ledger__transactions'",
      'INSERT INTO own SELECT amount FROM ledger__transactions',
    ]) {
      expect(namesTable(sql, NAME), sql).toBe(true);
    }
  });

  it('false for a longer identifier that merely contains it, and for a query that names it nowhere', async () => {
    for (const sql of [
      'SELECT * FROM ledger__transactions_archive',
      'SELECT * FROM my_ledger__transactions',
      'SELECT * FROM ledger__transactions2',
      'SELECT * FROM envelopes',
      'SELECT * FROM ledger__accounts',
    ]) {
      expect(namesTable(sql, NAME), sql).toBe(false);
    }
  });
});
