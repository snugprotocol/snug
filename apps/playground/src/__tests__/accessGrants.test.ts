// accessGrants.test.ts — revocation, release, suspension, expiry and the session seams from the
// HOST side (TASK-20261010-cross-app-access AC14, minus the update fan-out which is W3a-B2's;
// ADR-0075 §3, §9; D5, D25).
//
// Rows: revokeAccess → `revoked` + `revokedAt` (a suspended grant's reason cleared — D25), a
// `revoked` history line on the SOURCE, `access-changed { grantId }` rung on the reader's LIVE
// frame, the revision bumped — for a persisted grant and a session (memory) grant; releaseAccess
// gives back only the reader's own grant; suspendAccess writes the suspended row and its reason,
// logs it, rings, and answers false when the grant is not live; expiry is DERIVED and marked
// ONCE; grantsForApp lists both directions, persisted and session, with derived duration and
// expiry; resetAccessSession drops memory grants, limiters, pending asks and the scoped cache —
// for one app or every app; suspendIfSourceRestricted is the connection-approve/import seam;
// a session grant dies with its reader's frame (retract, or a newer generation).
//
// The real memory user db; the engine's clock is its injected seam.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_QUERY_RATE_PER_MINUTE,
  ACCESS_REQUEST_MIN_GAP_MS,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SIDECAR_SYMBOLIC_HOST,
  type AccessRequestFrame,
} from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { collectSources, pendingAccessStore } from '../access/consent.js';
import {
  __setAccessDepsForTests,
  accessRevisionStore,
  createGrantFromDecision,
  grantsForApp,
  markExpiredOnce,
  noteReaderGeneration,
  queryRateLimited,
  releaseAccess,
  resetAccessSession,
  revokeAccess,
  ringReader,
  suspendAccess,
  suspendIfSourceRestricted,
  type AnyAccessGrant,
} from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, scopedRead } from '../access/scopedRead.js';
import { __resetAppHostsForTest, registerAppHost } from '../state/appHosts.js';
import { installTestUserDb } from './userdbTestHelper.js';

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const DAY = 86_400_000;

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let clock: { now: number };
let rings: Array<{ appId: string; event: string; data: unknown }>;
let unregister: Array<() => void>;

async function seedSource(appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) {
    await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${Math.random()}`, instanceId: 'seed', op: 'exec', sql });
  }
}

function listen(appId: string): void {
  unregister.push(registerAppHost(appId, (event, data) => rings.push({ appId, event, data })));
}

async function allow(
  over: { reader?: string; source?: string; duration?: 'session' | 'day' | 'week' | 'always'; generation?: number; unattended?: boolean; tables?: string[]; renew?: string } = {},
): Promise<AnyAccessGrant> {
  const reader = over.reader ?? budget;
  const sourceId = over.source ?? ledger;
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === sourceId);
  if (source === undefined) throw new Error('no such candidate');
  return createGrantFromDecision(db, {
    readerAppId: reader,
    source,
    tables: over.tables ?? ['transactions'],
    duration: over.duration ?? 'day',
    unattended: over.unattended ?? false,
    purpose: 'to show spending by category',
    provenance: 'app',
    ...('generation' in over ? (over.generation !== undefined ? { generation: over.generation } : {}) : { generation: 0 }),
    now: clock.now,
    ...(over.renew !== undefined ? { renew: over.renew } : {}),
  });
}

const kindsOf = (sourceId: string) => db.listAccessLog(sourceId).map((entry) => entry.kind);
let askSeq = 0;
const askFrame = (): AccessRequestFrame => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `ask-${++askSeq}`, instanceId: 'i1', op: 'request', purpose: 'to show spending' });

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  clock = { now: T0 };
  rings = [];
  unregister = [];
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seedSource(
    ledger,
    ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)'],
    ["INSERT INTO transactions (amount, category, api_key) VALUES (450, 'food', 'k1'), (500, 'rent', 'k2')", "INSERT INTO accounts VALUES ('main', 9000)"],
  );
  await seedSource(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
});

afterEach(() => {
  for (const off of unregister) off();
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
});

describe('createGrantFromDecision — the one writer behind the user’s allow', () => {
  it('a day grant persists with the chosen tables and their NON-sensitive columns, the reader’s version, a granted line on the source, and a revision bump', async () => {
    const revision = accessRevisionStore.get();
    const grant = await allow({ duration: 'day' });
    expect(db.getAccessGrant(grant.id)).toEqual(grant);
    expect(grant).toMatchObject({
      readerAppId: budget,
      sourceAppId: ledger,
      access: 'read',
      status: 'active',
      provenance: 'app',
      unattended: false,
      readerVersion: db.getApp(budget)?.currentVersion,
      scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'] }] },
      duration: { kind: 'until', at: new Date(T0 + DAY).toISOString() },
      reads: 0,
      timeouts: 0,
    });
    expect(grant.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(db.listAccessLog(ledger)).toEqual([
      { at: new Date(T0).toISOString(), kind: 'granted', grantId: grant.id, readerAppId: budget, readerName: 'Budget', tables: ['transactions'] },
    ]);
    expect(accessRevisionStore.get()).toBeGreaterThan(revision);
  });

  it('a session grant is a MEMORY grant — never in the file, same shape, logged granted all the same', async () => {
    const grant = await allow({ duration: 'session', generation: 4 });
    expect(grant.duration).toEqual({ kind: 'session' });
    expect(db.listAccessGrants()).toEqual([]);
    expect(kindsOf(ledger)).toEqual(['granted']);
    expect(grantsForApp(db, budget, clock.now).reads.map((row) => [row.grant.id, row.session, row.generation, row.duration])).toEqual([[grant.id, true, 4, 'session']]);
  });

  it('refuses a table the source does not offer, and a choice with no table — nothing is written', async () => {
    await expect(allow({ tables: ['ledger_secrets'] })).rejects.toThrow();
    await expect(allow({ tables: [] })).rejects.toThrow();
    expect(db.listAccessGrants()).toEqual([]);
    expect(db.listAccessLog(ledger)).toEqual([]);
  });

  it('renewing a SUSPENDED grant re-activates it in place and clears its reason (D25); a REVOKED one is never re-armed — a new grant is written', async () => {
    const grant = await allow({ duration: 'week' });
    expect(await suspendAccess(db, grant.id, 'reader-updated', new Date(clock.now).toISOString())).toBe(true);
    const again = await allow({ duration: 'week', renew: grant.id });
    expect(again.id).toBe(grant.id);
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'active' });
    expect(db.getAccessGrant(grant.id)?.suspendedReason).toBeUndefined();
    await revokeAccess(grant.id);
    const fresh = await allow({ duration: 'week', renew: grant.id });
    expect(fresh.id).not.toBe(grant.id);
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'revoked' });
  });
});

describe('revokeAccess — the host’s stop', () => {
  it('a persisted grant becomes revoked with revokedAt (a suspended reason cleared), logs revoked on the source, rings the reader’s live frame and bumps the revision', async () => {
    listen(budget);
    const grant = await allow();
    await suspendAccess(db, grant.id, 'source-changed', new Date(clock.now).toISOString());
    rings = [];
    clock.now += 60_000;
    const revision = accessRevisionStore.get();
    await revokeAccess(grant.id);
    const stored = db.getAccessGrant(grant.id);
    expect(stored).toMatchObject({ status: 'revoked', revokedAt: new Date(clock.now).toISOString() });
    expect(stored?.suspendedReason).toBeUndefined();
    expect(kindsOf(ledger)[0]).toBe('revoked');
    expect(rings).toEqual([{ appId: budget, event: ACCESS_CHANGED_EVENT, data: { grantId: grant.id } }]);
    expect(accessRevisionStore.get()).toBeGreaterThan(revision);
  });

  it('a session grant is dropped from memory, logged revoked, and rung', async () => {
    listen(budget);
    const grant = await allow({ duration: 'session' });
    await revokeAccess(grant.id);
    expect(grantsForApp(db, budget, clock.now).reads).toEqual([]);
    expect(kindsOf(ledger)).toEqual(['revoked', 'granted']);
    expect(rings).toEqual([{ appId: budget, event: ACCESS_CHANGED_EVENT, data: { grantId: grant.id } }]);
  });

  it('an unknown or already-revoked grant changes nothing', async () => {
    const grant = await allow();
    await revokeAccess(grant.id);
    const before = db.listAccessLog(ledger);
    await revokeAccess(grant.id);
    await revokeAccess('00000000-0000-4000-8000-000000000000');
    expect(db.listAccessLog(ledger)).toEqual(before);
  });
});

describe('releaseAccess — the reader gives its own grant back', () => {
  it('its own grant → revoked, a released line, a ring; another app’s grant → not-granted and nothing changes', async () => {
    listen(budget);
    const mine = await allow();
    const theirs = await allow({ reader: pantry });
    expect(await releaseAccess(budget, theirs.id)).toBe('not-granted');
    expect(db.getAccessGrant(theirs.id)).toMatchObject({ status: 'active' });
    expect(await releaseAccess(budget, mine.id)).toBe('released');
    expect(db.getAccessGrant(mine.id)).toMatchObject({ status: 'revoked' });
    expect(kindsOf(ledger)[0]).toBe('released');
    expect(rings).toEqual([{ appId: budget, event: ACCESS_CHANGED_EVENT, data: { grantId: mine.id } }]);
    expect(await releaseAccess(budget, mine.id), 'a stopped grant cannot be released twice').toBe('not-granted');
  });
});

describe('suspendAccess', () => {
  it('writes the suspended row with its reason, logs it with the reason, rings the reader; false (and nothing written) when the grant is not live', async () => {
    listen(budget);
    const grant = await allow();
    const at = new Date(clock.now).toISOString();
    expect(await suspendAccess(db, grant.id, 'reader-misbehaved', at)).toBe(true);
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'reader-misbehaved', updatedAt: at });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'suspended', grantId: grant.id, reason: 'reader-misbehaved', readerName: 'Budget' });
    expect(rings).toHaveLength(1);
    expect(await suspendAccess(db, grant.id, 'source-changed', at), 'already paused').toBe(false);
    await revokeAccess(grant.id);
    expect(await suspendAccess(db, grant.id, 'source-changed', at), 'stopped').toBe(false);
    expect(await suspendAccess(db, '00000000-0000-4000-8000-000000000000', 'source-changed', at), 'unknown').toBe(false);
    expect(kindsOf(ledger).filter((kind) => kind === 'suspended')).toHaveLength(1);
  });
});

describe('expiry — derived at read, marked once', () => {
  it('a day grant reads expired after its day; markExpiredOnce writes ONE expired line however often it is asked', async () => {
    const grant = await allow({ duration: 'day' });
    expect(markExpiredOnce(db, grant, clock.now)).toBe(false);
    clock.now += DAY;
    const [row] = grantsForApp(db, budget, clock.now).reads;
    expect(row).toMatchObject({ expired: true, live: false, duration: 'day', expiresAt: new Date(T0 + DAY).toISOString() });
    expect(db.getAccessGrant(grant.id)?.status, 'expired is never stored').toBe('active');
    expect(markExpiredOnce(db, grant, clock.now)).toBe(true);
    expect(markExpiredOnce(db, grant, clock.now)).toBe(false);
    expect(kindsOf(ledger).filter((kind) => kind === 'expired')).toHaveLength(1);
  });
});

describe('grantsForApp — both directions, persisted and session', () => {
  it('lists what the app reads and what reads it, with the parties’ library names and the derived duration', async () => {
    const week = await allow({ duration: 'week' });
    const always = await allow({ duration: 'always', reader: pantry });
    const session = await allow({ duration: 'session', source: pantry, tables: ['items'], generation: 2 });
    const forBudget = grantsForApp(db, budget, clock.now);
    expect(forBudget.reads.map((row) => [row.grant.id, row.duration, row.readerName, row.sourceName, row.session])).toEqual(
      expect.arrayContaining([
        [week.id, 'week', 'Budget', 'Ledger', false],
        [session.id, 'session', 'Budget', 'Pantry', true],
      ]),
    );
    expect(forBudget.reads).toHaveLength(2);
    expect(forBudget.readBy).toEqual([]);
    const forLedger = grantsForApp(db, ledger, clock.now);
    expect(forLedger.reads).toEqual([]);
    expect(forLedger.readBy.map((row) => [row.grant.id, row.duration])).toEqual(expect.arrayContaining([[week.id, 'week'], [always.id, 'always']]));
    expect(forLedger.readBy.find((row) => row.grant.id === always.id)?.expiresAt).toBeUndefined();
  });
});

describe('ringReader', () => {
  it('rings access-changed with the id only into the reader’s live frame, and is silent (never a throw) when the reader is not open', () => {
    expect(() => ringReader(budget, 'x')).not.toThrow();
    listen(budget);
    ringReader(budget, 'g-1');
    expect(rings).toEqual([{ appId: budget, event: ACCESS_CHANGED_EVENT, data: { grantId: 'g-1' } }]);
  });
});

describe('the session seams', () => {
  it('a session grant dies when its reader’s frame closes (the live host retracts)', async () => {
    listen(budget);
    await allow({ duration: 'session' });
    expect(grantsForApp(db, budget, clock.now).reads).toHaveLength(1);
    unregister.pop()?.();
    expect(grantsForApp(db, budget, clock.now).reads).toEqual([]);
  });

  it('the retract listeners are armed on USE, not at module load: a suite that resets the app-host registry (either order with resetAccessSession) still sees a session grant and an app ask end with the frame', async () => {
    for (const order of ['hosts-then-session', 'session-then-hosts'] as const) {
      if (order === 'hosts-then-session') {
        __resetAppHostsForTest();
        resetAccessSession();
      } else {
        resetAccessSession();
        __resetAppHostsForTest();
      }
      listen(budget);
      await allow({ duration: 'session' });
      expect(grantsForApp(db, budget, clock.now).reads, order).toHaveLength(1);
      unregister.pop()?.();
      expect(grantsForApp(db, budget, clock.now).reads, order).toEqual([]);

      // …and the app's pending ask, parked through a handler, is dismissed by the same retract.
      __resetAppHostsForTest();
      listen(budget);
      const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
      clock.now += ACCESS_REQUEST_MIN_GAP_MS;
      const answer = handler.handle(budget, askFrame());
      await expect.poll(() => pendingAccessStore.get()[budget], { timeout: 3000 }).toBeDefined();
      unregister.pop()?.();
      expect(await answer, order).toMatchObject({ ok: false, code: 'ACCESS_DECLINED', retryable: true });
      expect(pendingAccessStore.get(), order).toEqual({});
    }
  });

  it('a newer frame generation of the reader ends the older generation’s session grants; a grant made from host chrome while the reader was closed binds to the next frame', async () => {
    await allow({ duration: 'session', generation: 1 });
    noteReaderGeneration(budget, 2);
    expect(grantsForApp(db, budget, clock.now).reads).toEqual([]);
    const unbound = await allow({ duration: 'session', reader: pantry, generation: undefined });
    expect(grantsForApp(db, pantry, clock.now).reads.map((row) => [row.grant.id, row.generation])).toEqual([[unbound.id, undefined]]);
    noteReaderGeneration(pantry, 5);
    expect(grantsForApp(db, pantry, clock.now).reads.map((row) => [row.grant.id, row.generation])).toEqual([[unbound.id, 5]]);
  });

  it('resetAccessSession() drops every memory grant, the limiters, every pending ask (dismissed — nothing recorded) and the scoped cache', async () => {
    const session = await allow({ duration: 'session' });
    const persisted = await allow({ duration: 'day', reader: pantry });
    for (let i = 0; i < ACCESS_QUERY_RATE_PER_MINUTE; i++) queryRateLimited(budget, clock.now);
    expect(queryRateLimited(budget, clock.now)).toBe(true);

    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const frame: AccessRequestFrame = { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: 'r1', instanceId: 'i1', op: 'request', purpose: 'to show spending' };
    const answer = handler.handle(budget, frame);
    await expect.poll(() => pendingAccessStore.get()[budget]).toBeDefined();

    const fetched: string[] = [];
    configureScopedRead({
      createWorker: () => {
        const worker = {
          onmessage: null as ((ev: { data: unknown }) => void) | null,
          onerror: null,
          postMessage(msg: unknown) {
            if (typeof msg === 'object' && msg !== null && 'id' in msg) {
              const id = (msg as { id: number }).id;
              setTimeout(() => worker.onmessage?.({ data: { id, result: { ok: true, columns: [], rows: [] } } }), 0);
            }
          },
          terminate() {},
        };
        return worker;
      },
      wasm: { wasmUrl: 'x' },
      now: () => clock.now,
    });
    const read = () => scopedRead({ grantId: persisted.id, bytes: () => (fetched.push('x'), Promise.resolve(new Uint8Array())), scope: { tables: [] }, statement: { sql: 'SELECT 1' }, caps: { maxRows: 1, maxBytes: 1 } });
    await read();
    await read();
    expect(fetched).toHaveLength(1);

    resetAccessSession();

    expect(await answer).toEqual({ ok: false, code: 'ACCESS_DECLINED', message: expect.any(String), retryable: true });
    expect(pendingAccessStore.get()).toEqual({});
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
    expect(grantsForApp(db, budget, clock.now).reads.map((row) => row.grant.id)).not.toContain(session.id);
    expect(db.getAccessGrant(persisted.id), 'a persisted grant survives a session reset').toBeDefined();
    expect(queryRateLimited(budget, clock.now), 'the query limiter is forgotten').toBe(false);
    await read();
    expect(fetched, 'the scoped cache is dropped').toHaveLength(2);
    clock.now += 1;
    const second = handler.handle(budget, { ...frame, requestId: 'r2' });
    // the ask limiter is forgotten: a second ask parks at once
    await expect.poll(() => pendingAccessStore.get()[budget]).toBeDefined();
    resetAccessSession();
    expect(await second).toMatchObject({ ok: false, code: 'ACCESS_DECLINED', retryable: true });
  });

  it('resetAccessSession(appId) drops only that app’s memory grants (as reader or source) and pending ask', async () => {
    const budgetSession = await allow({ duration: 'session' });
    const pantrySession = await allow({ duration: 'session', reader: pantry });
    resetAccessSession(budget);
    expect(grantsForApp(db, budget, clock.now).reads).toEqual([]);
    expect(grantsForApp(db, pantry, clock.now).reads.map((row) => row.grant.id)).toEqual([pantrySession.id]);
    expect(budgetSession.id).not.toBe(pantrySession.id);
    resetAccessSession(ledger);
    expect(grantsForApp(db, pantry, clock.now).reads, 'the source’s reset drops grants that read it').toEqual([]);
  });

  it('the ask limiter is the protocol’s 10 s gap', () => {
    expect(ACCESS_REQUEST_MIN_GAP_MS).toBe(10_000);
  });
});

describe('suspendIfSourceRestricted — the connection-approve / import seam', () => {
  it('a source that now holds a WhatsApp fact suspends every live grant that reads it (persisted and session) source-restricted; other sources are untouched', async () => {
    listen(budget);
    const persisted = await allow({ duration: 'day' });
    const session = await allow({ duration: 'session', reader: pantry });
    const other = await allow({ duration: 'day', source: pantry, tables: ['items'] });
    const at = new Date(clock.now).toISOString();
    expect(await suspendIfSourceRestricted(db, ledger, at), 'no fact yet').toBe(0);
    db.putDeclaredConnection(ledger, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2], 'starter');
    expect(await suspendIfSourceRestricted(db, ledger, at)).toBe(2);
    expect(db.getAccessGrant(persisted.id)).toMatchObject({ status: 'suspended', suspendedReason: 'source-restricted' });
    expect(grantsForApp(db, pantry, clock.now).reads.find((row) => row.grant.id === session.id)?.grant).toMatchObject({ status: 'suspended', suspendedReason: 'source-restricted' });
    expect(db.getAccessGrant(other.id)).toMatchObject({ status: 'active' });
    expect(rings.map((ring) => ring.data)).toEqual([{ grantId: persisted.id }]);
    expect(await suspendIfSourceRestricted(db, ledger, at), 'already paused').toBe(0);
  });
});
