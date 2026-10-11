// scheduledDbDriver.test.ts — TASK-20261009-scheduled-run-open-app (Gate-5 review major): the
// hidden frame and the visible one share ONE sql.js connection per namespace, so a transaction
// spanning requests would interleave across the two instances (the visible copy's ROLLBACK
// swallowing the scheduled write, or the scheduled BEGIN failing inside the visible one's). The
// scheduled run's db binding refuses transaction control and a whole-database import by name;
// everything else passes through untouched.
import { DB_ERROR_CODES, type SnugDbDriver, type UserDb } from '@snugprotocol/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULED_DB_REFUSAL, scheduledDbDriver } from '../schedule/scheduledDbDriver.js';
import { installTestUserDb } from './userdbTestHelper.js';

let db: UserDb;
let appId: string;
const req = (over: Record<string, unknown>) => ({ v: 1, type: 'snug:db-request', requestId: 'r1', instanceId: 'i1', ...over }) as never;

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Weather', html: '<html>v1</html>' }).appId;
});

describe('scheduledDbDriver — the hidden frame never holds a transaction open on the shared connection', () => {
  it('refuses BEGIN / COMMIT / END / ROLLBACK / SAVEPOINT / RELEASE, in any case, after comments, or later in a multi-statement exec', async () => {
    const guarded = scheduledDbDriver(db.driver);
    for (const sql of ['BEGIN', 'begin transaction', 'BEGIN IMMEDIATE', 'COMMIT', 'END', 'ROLLBACK', 'rollback to sp1', 'SAVEPOINT sp1', 'RELEASE sp1', '/* x */ BEGIN', '-- c\nBEGIN', 'CREATE TABLE t (a); BEGIN']) {
      const out = await guarded.handle(appId, req({ op: 'exec', sql }));
      expect(out, sql).toEqual({ ok: false, code: DB_ERROR_CODES.FORBIDDEN_STATEMENT, message: SCHEDULED_DB_REFUSAL.transaction, retryable: false });
    }
  });

  it('refuses a whole-database import, which would swap the store out from under the open copy', async () => {
    const out = await scheduledDbDriver(db.driver).handle(appId, req({ op: 'import', bytesBase64: 'AAAA' }));
    expect(out).toEqual({ ok: false, code: DB_ERROR_CODES.FORBIDDEN_STATEMENT, message: SCHEDULED_DB_REFUSAL.import, retryable: false });
  });

  it('passes ordinary reads and writes, a CASE … END, kv and export through to the real driver', async () => {
    const guarded = scheduledDbDriver(db.driver);
    expect((await guarded.handle(appId, req({ op: 'exec', sql: 'CREATE TABLE t (a INTEGER)' }))).ok).toBe(true);
    expect((await guarded.handle(appId, req({ op: 'exec', sql: 'INSERT INTO t (a) VALUES (?)', params: [1] }))).ok).toBe(true);
    const read = await guarded.handle(appId, req({ op: 'exec', sql: "SELECT CASE WHEN a = 1 THEN 'one' END AS w, 'BEGIN' AS lit FROM t" }));
    expect(read).toMatchObject({ ok: true, rows: [['one', 'BEGIN']] });
    expect((await guarded.handle(appId, req({ op: 'kvSet', key: 'k', value: 1 }))).ok).toBe(true);
    expect(await guarded.handle(appId, req({ op: 'kvGet', key: 'k' }))).toMatchObject({ ok: true, value: 1 });
    expect((await guarded.handle(appId, req({ op: 'export' }))).ok).toBe(true);
    expect(guarded.persistence).toBe(db.driver.persistence);
    expect(await guarded.kvGet(appId, 'k')).toMatchObject({ ok: true, value: 1 });
  });
});

// TASK-20261010-host-broker PR-3 (contract v2 D-PR3-11; F15/SC9): the driver gains ONE synchronous
// seat onto a namespace's handle — `brokeredWrite`, the Write Broker's apply — and the hidden
// frame's binding CARRIES it but never opens it: a scheduled run is never a broker (a schedule's
// write is `ACCESS_UNATTENDED` at the policy, D-PR3-13), so the binding answers the driver's own
// `FORBIDDEN_STATEMENT`, not retryable, AS DATA (never a throw) and never forwards to the driver it
// wraps. The seat's input is the broker's plan batch; a LOCAL structural type stands in for
// `BrokeredWriteInput` and the method until `SnugDbDriver` declares them (Gate 5 replaces it).
describe('scheduledDbDriver — the brokered-write seat is refused as data, never forwarded (PR-3, D-PR3-11)', () => {
  type BrokeredSeat = { brokeredWrite(namespace: string, input: Record<string, unknown>): Promise<{ ok: boolean; code?: string; retryable?: boolean; message?: string }> };
  const input = {
    plans: [{ sql: 'UPDATE t SET a = 2 WHERE a = 1', op: 'update', table: 't', columns: ['a'], setColumns: ['a'], previewChanges: 1 }],
    caps: { maxChanges: 200, maxUndoBytes: 64 * 1024 },
    expectChanges: [1],
    requireUndo: true,
    capture: true,
  };

  it('answers { ok: false, code: FORBIDDEN_STATEMENT, retryable: false } and NEVER calls the inner driver’s seat', async () => {
    const forwarded = vi.fn(async () => ({ ok: true, steps: [], changes: [1], undoable: true }));
    const inner = { ...db.driver, handle: db.driver.handle.bind(db.driver), kvSet: db.driver.kvSet.bind(db.driver), kvGet: db.driver.kvGet.bind(db.driver), brokeredWrite: forwarded };
    const guarded = scheduledDbDriver(inner as unknown as SnugDbDriver) as unknown as BrokeredSeat;
    expect(typeof guarded.brokeredWrite, 'the binding carries the seat').toBe('function');
    const out = await guarded.brokeredWrite(appId, input);
    expect(out).toMatchObject({ ok: false, code: DB_ERROR_CODES.FORBIDDEN_STATEMENT, retryable: false });
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('the refusal changes nothing: the row the plan names is untouched', async () => {
    expect((await db.driver.handle(appId, req({ op: 'exec', sql: 'CREATE TABLE t (a INTEGER)' }))).ok).toBe(true);
    expect((await db.driver.handle(appId, req({ op: 'exec', sql: 'INSERT INTO t (a) VALUES (1)' }))).ok).toBe(true);
    const guarded = scheduledDbDriver(db.driver) as unknown as BrokeredSeat;
    expect((await guarded.brokeredWrite(appId, input)).ok).toBe(false);
    expect(await db.driver.handle(appId, req({ op: 'exec', sql: 'SELECT a FROM t' }))).toMatchObject({ ok: true, rows: [[1]] });
  });
});
