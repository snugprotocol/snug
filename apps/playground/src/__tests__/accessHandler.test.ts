// accessHandler.test.ts — the access engine's runner seam, op by op (TASK-20261010-cross-app-
// access AC11 `request`, AC12 `query`, AC13 `list`/`release`; ADR-0075 §3–§9; D5, D6, D7, D10,
// D14, D19, D23, D25).
//
// `createAccessHandlerFor(appId, { attended, generation })` is what the run view composes for an
// OWNED app; the runner calls `handle(accessAppId, frame)` with the HOST-assigned id. Every
// limit keys on that id and the frame GENERATION — never the app-rolled `instanceId`, which a
// re-announce changes at will. `request` parks a pending ask (the strip) and HOLDS the promise
// until the user's act on the consent sheet resolves it; `query` reads a scoped copy of the
// source in a Worker (injected here: the INLINE one runs the real worker responder on node
// sql.js; fakes answer crafted rows, or never) and logs every read on the SOURCE.
//
// Mutation checks (run by hand, each red then restored):
//  - key the ask limiter / pending on `frame.instanceId` instead of the generation → the
//    re-announce row reds;
//  - drop the column-keyed mask (scan bare cells) → the mask row reds;
//  - skip the worker terminate on timeout → scopedReadWorker.test.ts reds (the C1/C2 row there);
//  - answer with the frame-free `accessAppId` argument ignored → the host-assigned-id row reds;
//  - move the per-minute limiter back below the hidden-frame refusal → the hidden rate-limit row reds;
//  - drop the per-grant dedupe of the `refused` line → the history-survives row reds;
//  - drop the post-gather "is the frame still there" re-check → both mid-gather rows red;
//  - let a hidden frame own a session grant again (match on generation alone) → the session rows red.
//
// PR-3 (TASK-20261010-host-broker; contract v2 D-PR3-4/13/14/15/20/21; §24.5 MUSTs 18–24): the
// three new ops end to end through the same handler, inline workers and real in-memory user db —
// `write` (changes only on the wire; the `wrote` line and the undo entry written BEFORE the answer;
// the doorbells; every refusal in the reader's words from copy.ts; busy from the driver's flag;
// attendance required; a stop while the plan runs wins; the per-reader cap; the shared minute),
// `refresh` (the service's answer passed through; the tick; the engine's first gate) and `discover`
// (the class, nothing recorded, the per-reader cache, the ask's presence rule). Red by design until
// the wire (I-W), the db (I-D), the engine (I-E1/I-E2) and the sentences (I-U) land; every module
// or export that does not exist yet is reached through a namespace or a variable specifier, and
// every missing TYPE is a local structural one the implementation lane replaces at Gate 5.
// Mutation checks (to run by hand once I-E1 lands, each red then restored):
//  - append the `wrote` line after resolving (a deferred append) → the "before the answer" row reds;
//  - ring `access-source-changed` without `except: readerAppId` → the "never the writer" row reds;
//  - skip `stillWritable` after the plan → the stop-while-planning row reds;
//  - key the discover cache on the app set instead of the reader → the cache row reds;
//  - count writes in their own minute → the shared-minute row reds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { AccessHandlerResult } from '@snugprotocol/runner';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_LOG_COALESCE_MS,
  ACCESS_LOG_SQL_MAX_CHARS,
  ACCESS_QUERY_RATE_PER_MINUTE,
  ACCESS_REQUEST_MIN_GAP_MS,
  ACCESS_SCOPED_CACHE_MS,
  ACCESS_SOURCE_MAX_BYTES,
  ACCESS_TIMEOUT_STRIKES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SIDECAR_SYMBOLIC_HOST,
  ACCESS_DISCOVER_CACHE_MS,
  ACCESS_SOURCE_CHANGED_EVENT,
  ACCESS_UNDO_MAX_ENTRIES,
  ACCESS_UNDO_TTL_MS,
  DATA_CHANGED_EVENT,
  accessRequestHash,
  type AccessLogEntry,
  type AccessRequestFrame,
} from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { NO_ACCESS_ASKS_KEY, pendingAccessStore, type ConsentDecision, type PendingAccessRequest } from '../access/consent.js';
import { startUserAsk } from '../access/userAsk.js';
import { ACCESS_APP_MESSAGES, ACCESS_SHEET, type WriteRefusalRule } from '../access/copy.js';
import { __setAccessDepsForTests, accessRevisionStore, createGrantFromDecision, grantsForApp, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
import { revokeAccess, type CreateGrantInput, type TableChoice } from '../access/grants.js';
import { __setAccessServiceForTests } from '../access/service.js';
import { provenanceLine } from '../access/provenance.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { collectSources } from '../access/consent.js';
import { registerAppHost } from '../state/appHosts.js';
// TASK-20261010-host-broker PR-1, Gate-5 fold F-10 — the delegated run's window.
import { beginDelegatedRun, clearTouchedGeneration, endDelegatedRun } from '../schedule/runPlacement.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

const T0 = Date.parse('2026-10-10T09:00:00.000Z');
const DAY = 86_400_000;
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let clock: { now: number };
let seq = 0;
let rings: Array<{ appId: string; event: string; data: unknown }>;
let unregister: Array<() => void>;

// ------------------------------------------------------------------------------------- frames

type RequestFields = Omit<Extract<AccessRequestFrame, { op: 'request' }>, 'v' | 'type' | 'requestId' | 'instanceId' | 'op'>;
const base = (instanceId = 'inst-1') => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `req-${++seq}`, instanceId }) as const;
const askFrame = (fields: Partial<RequestFields> = {}, instanceId?: string): AccessRequestFrame => ({
  ...base(instanceId),
  op: 'request',
  purpose: 'to show spending by category',
  hints: { tables: ['transactions'], words: ['spending'] },
  ...fields,
});
const queryFrame = (grantId: string, sql: string, params?: Array<string | number | null>): AccessRequestFrame => ({
  ...base(),
  op: 'query',
  grantId,
  sql,
  ...(params !== undefined ? { params } : {}),
});
const listFrame = (): AccessRequestFrame => ({ ...base(), op: 'list' });
const releaseFrame = (grantId: string): AccessRequestFrame => ({ ...base(), op: 'release', grantId });

const refusal = (code: string, message: string, retryable: boolean): AccessHandlerResult => ({ ok: false, code, message, retryable });

// ------------------------------------------------------------------------------------- workers

function inlineWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        void respond(msg).then((answer) => {
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        });
      },
      terminate() {},
    };
    return worker;
  };
}

/** Answers every job with the given engine result (rows the real engine would have withheld, for the mask). */
function answeringWorkers(result: () => unknown): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        if (typeof msg === 'object' && msg !== null && 'id' in msg) {
          const id = (msg as { id: number }).id;
          setTimeout(() => worker.onmessage?.({ data: { id, result: result() } }), 0);
        }
      },
      terminate() {},
    };
    return worker;
  };
}

function useInlineWorker(): void {
  configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
}

// ------------------------------------------------------------------------------------- setup

async function seed(appId: string, ddl: string[], inserts: string[]): Promise<void> {
  await db.applyAppDdl(appId, ddl);
  for (const sql of inserts) {
    await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${++seq}`, instanceId: 'seed', op: 'exec', sql });
  }
}

async function pendingFor(appId: string): Promise<PendingAccessRequest> {
  await expect.poll(() => pendingAccessStore.get()[appId], { timeout: 3000 }).toBeDefined();
  return pendingAccessStore.get()[appId]!;
}

/** Ask, wait for the strip's pending, act on it, and return the held answer. */
async function askAndDecide(handler: ReturnType<typeof createAccessHandlerFor>, frame: AccessRequestFrame, decide: (pending: PendingAccessRequest) => ConsentDecision): Promise<AccessHandlerResult> {
  const answer = handler.handle(budget, frame);
  const pending = await pendingFor(budget);
  void pending.resolve(decide(pending));
  return answer;
}

const allowLedger = (duration: 'session' | 'day' | 'week' | 'always', over: Partial<Extract<ConsentDecision, { kind: 'allow' }>> = {}) => (): ConsentDecision => ({
  kind: 'allow',
  sourceAppId: ledger,
  tables: ['transactions'],
  duration,
  unattended: false,
  ...over,
});

async function grantFor(
  over: { reader?: string; source?: string; duration?: 'session' | 'day' | 'week' | 'always'; generation?: number; unattended?: boolean; tables?: string[] } = {},
): Promise<AnyAccessGrant> {
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
    purpose: 'to show spending by category',
    provenance: 'app',
    generation: over.generation ?? 0,
    now: clock.now,
  });
}

const kindsOf = (sourceId: string) => db.listAccessLog(sourceId).map((entry) => entry.kind);
const isHeld = async (promise: Promise<unknown>): Promise<boolean> => {
  const marker = Symbol('held');
  return (await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(marker), 30))])) === marker;
};

beforeEach(async () => {
  resetAccessSession();
  resetScopedReadForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  clock = { now: T0 };
  rings = [];
  unregister = [];
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => clock.now });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', iconEmoji: '📒', iconColor: '#336699', html: '<!doctype html><title>l</title>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
  await seed(
    ledger,
    ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT, api_key TEXT)', 'CREATE TABLE accounts (name TEXT, balance INTEGER)'],
    ["INSERT INTO transactions (amount, category, api_key) VALUES (450, 'food', 'k-one'), (500, 'rent', 'k-two')", "INSERT INTO accounts VALUES ('main', 9000)"],
  );
  await seed(pantry, ['CREATE TABLE items (name TEXT, qty INTEGER)'], ["INSERT INTO items VALUES ('rice', 2)"]);
  useInlineWorker();
});

afterEach(() => {
  for (const off of unregister) off();
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  localStorage.removeItem(NO_ACCESS_ASKS_KEY);
  vi.restoreAllMocks();
});

// =========================================================================================
// AC11 — request
// =========================================================================================

describe('AC11 request — the ask becomes a strip, and the answer waits for the user', () => {
  it('parks ONE pending named by the LIBRARY row with the host-derived provenance line, ranked candidates and a preselection — and HOLDS the promise', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 3 });
    const answer = handler.handle(budget, askFrame());
    const pending = await pendingFor(budget);
    expect(pending).toMatchObject({
      readerAppId: budget,
      readerName: 'Budget',
      readerProvenance: provenanceLine(db.getApp(budget)!, { collides: false, now: clock.now }),
      generation: 3,
      purpose: 'to show spending by category',
      provenance: 'app',
      preselect: { appId: ledger, tables: ['transactions'] },
    });
    expect(pending.candidates.matched[0]?.appId).toBe(ledger);
    expect(pending.candidates.excluded).toContainEqual({ appId: budget, displayName: 'Budget', reason: 'reader' });
    expect(pending.egressFor({ unattended: false, sourceName: 'Ledger' }).length).toBeGreaterThan(0);
    expect(await isHeld(answer), 'the promise is held until the user acts').toBe(true);
    void pending.resolve({ kind: 'not-now' });
    await answer;
  });

  it('allow “while it’s open” → a MEMORY grant bound to the generation, a granted line on the source, the revision bumped, and the view the reader learns', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const revision = accessRevisionStore.get();
    const answer = await askAndDecide(handler, askFrame(), allowLedger('session'));
    expect(answer).toEqual({
      ok: true,
      op: 'request',
      grant: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        access: 'read',
        source: { displayName: 'Ledger', iconEmoji: '📒', iconColor: '#336699' },
        tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'] }],
        duration: 'session',
        unattended: false,
      },
    });
    expect(db.listAccessGrants(), 'a session grant never touches the file').toEqual([]);
    expect(kindsOf(ledger)).toEqual(['granted']);
    expect(accessRevisionStore.get()).toBeGreaterThan(revision);
    expect(pendingAccessStore.get()).toEqual({});
  });

  it('allow for a day → a PERSISTED grant (provenance app, the reader’s version, NON-sensitive columns as disclosed) and an expiresAt in the view', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await askAndDecide(handler, askFrame(), allowLedger('day'));
    const [grant] = db.listAccessGrants();
    expect(grant).toMatchObject({ readerAppId: budget, sourceAppId: ledger, provenance: 'app', readerVersion: 1, unattended: false, status: 'active', purpose: 'to show spending by category' });
    expect(grant?.scope.tables).toEqual([{ name: 'transactions', columns: ['id', 'amount', 'category'] }]);
    expect(answer).toMatchObject({ ok: true, op: 'request', grant: { id: grant?.id, duration: 'day', expiresAt: new Date(T0 + DAY).toISOString() } });
  });

  it('allow until I stop it, also while I’m away → persisted, unattended, no expiry', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await askAndDecide(handler, askFrame(), allowLedger('always', { unattended: true }));
    expect(db.listAccessGrants()[0]).toMatchObject({ duration: { kind: 'always' }, unattended: true });
    expect(answer).toMatchObject({ ok: true, grant: { duration: 'always', unattended: true } });
    expect(answer.ok && answer.op === 'request' ? answer.grant.expiresAt : 'x').toBeUndefined();
  });

  it('an allow naming a source that was never offered (the asking app itself, an unknown app) or no table writes nothing and answers a host error', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    for (const decision of [allowLedger('day', { sourceAppId: budget }), allowLedger('day', { sourceAppId: UNKNOWN_ID }), allowLedger('day', { tables: [] }), allowLedger('day', { tables: ['nope'] })]) {
      const answer = await askAndDecide(handler, askFrame(), decision);
      expect(answer).toMatchObject({ ok: false, code: 'HOST_ERROR', retryable: true });
      clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    }
    expect(db.listAccessGrants()).toEqual([]);
    expect(db.listAccessLog(ledger)).toEqual([]);
  });

  it('ONE pending per (app, generation): a second ask from the same generation → ACCESS_PENDING (retryable)', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const first = handler.handle(budget, askFrame());
    await pendingFor(budget);
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    expect(await handler.handle(budget, askFrame({ purpose: 'again' }))).toEqual(refusal('ACCESS_PENDING', ACCESS_APP_MESSAGES.pending, true));
    expect(pendingAccessStore.get()[budget]?.purpose).toBe('to show spending by category');
    resetAccessSession();
    await first;
  });

  it('≤ 1 ask per 10 s per app → ACCESS_RATE_LIMITED (retryable)', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await askAndDecide(handler, askFrame(), () => ({ kind: 'not-now' }))).toMatchObject({ code: 'ACCESS_DECLINED' });
    clock.now += ACCESS_REQUEST_MIN_GAP_MS - 1;
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.askRateLimited, true));
    clock.now += 1;
    expect(await askAndDecide(handler, askFrame(), () => ({ kind: 'not-now' }))).toMatchObject({ code: 'ACCESS_DECLINED' });
  });

  it('a reader that RE-ANNOUNCES (a fresh instanceId each time) has at most one pending and is rate-limited by APP — a new generation cannot reset the window either', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const first = handler.handle(budget, askFrame({}, 'inst-a'));
    await pendingFor(budget);
    for (const instanceId of ['inst-b', 'inst-c', 'inst-d']) {
      expect(await handler.handle(budget, askFrame({}, instanceId))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.askRateLimited, true));
    }
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    expect(await handler.handle(budget, askFrame({}, 'inst-e'))).toEqual(refusal('ACCESS_PENDING', ACCESS_APP_MESSAGES.pending, true));
    expect(Object.keys(pendingAccessStore.get())).toEqual([budget]);
    clock.now += 1;
    const remounted = createAccessHandlerFor(budget, { attended: true, generation: 1 });
    expect(await first, 'a remounted frame ends the dead frame’s ask').toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(await remounted.handle(budget, askFrame({}, 'inst-f')), 'inside the window, whatever the generation').toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.askRateLimited, true));
    expect(pendingAccessStore.get()).toEqual({});
  });

  it('a NEW generation after the gap replaces the older generation’s pending — the older ask is dismissed (retryable, nothing recorded)', async () => {
    const first = createAccessHandlerFor(budget, { attended: true, generation: 0 }).handle(budget, askFrame());
    await pendingFor(budget);
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const second = createAccessHandlerFor(budget, { attended: true, generation: 1 }).handle(budget, askFrame({ purpose: 'after a remount' }));
    expect(await first).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect((await pendingFor(budget)).generation).toBe(1);
    expect(db.listAccessDeclines(budget)).toEqual([]);
    resetAccessSession();
    await second;
  });

  it('a recorded decline for the ask’s semantic hash → ACCESS_DECLINED (not retryable) and NO strip — a reworded purpose is the same ask', async () => {
    const frame = askFrame();
    db.addAccessDecline(budget, accessRequestHash(frame.op === 'request' ? frame : {}), { purpose: 'earlier', hints: { tables: ['transactions'], words: ['spending'] }, at: new Date(T0).toISOString() });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, askFrame({ purpose: 'a different wording', hints: { tables: ['TRANSACTIONS'], words: ['spending'] } }))).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.declined, false));
    expect(pendingAccessStore.get()).toEqual({});
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const other = handler.handle(budget, askFrame({ hints: { tables: ['items'] } }));
    expect((await pendingFor(budget)).purpose, 'a different ask is a new ask').toBe('to show spending by category');
    resetAccessSession();
    await other;
  });

  it('a muted reader → ACCESS_DECLINED (not retryable), no strip; the per-browser switch answers every app the same way', async () => {
    db.setAccessMuted(budget, true);
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.muted, false));
    db.setAccessMuted(budget, false);
    localStorage.setItem(NO_ACCESS_ASKS_KEY, '1');
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.askingOff, false));
    expect(pendingAccessStore.get()).toEqual({});
    expect(db.isAccessMuted(budget), 'the switch is a browser flag, not a row').toBe(false);
  });

  it('NO eligible source → ACCESS_NO_SOURCES: no strip, nothing recorded', async () => {
    await db.deleteApp(ledger);
    await db.deleteApp(pantry);
    db.installApp({ displayName: 'Empty', html: '<!doctype html><title>e</title>' });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_NO_SOURCES', ACCESS_APP_MESSAGES.noSources, false));
    expect(pendingAccessStore.get()).toEqual({});
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
  });

  it('an unattended (hidden) frame’s ask → ACCESS_UNATTENDED (retryable): nothing recorded, no strip, and no rate-limit hit', async () => {
    const hidden = createAccessHandlerFor(budget, { attended: false });
    expect(await hidden.handle(budget, askFrame())).toEqual(refusal('ACCESS_UNATTENDED', ACCESS_APP_MESSAGES.unattended, true));
    expect(pendingAccessStore.get()).toEqual({});
    const visible = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = visible.handle(budget, askFrame());
    expect((await pendingFor(budget)).generation, 'the hidden ask spent no window').toBe(0);
    resetAccessSession();
    await answer;
  });

  it('not now → ACCESS_DECLINED retryable; nothing recorded', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await askAndDecide(handler, askFrame(), () => ({ kind: 'not-now' }))).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
    expect(db.listAccessGrants()).toEqual([]);
    expect(db.listAccessLog(ledger)).toEqual([]);
  });

  it('don’t allow → records the ask’s hash with its purpose and hints; the same ask never re-prompts', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const frame = askFrame();
    expect(await askAndDecide(handler, frame, () => ({ kind: 'dont-allow' }))).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.declined, false));
    expect(db.listAccessDeclines(budget)).toEqual([
      { hash: accessRequestHash(frame.op === 'request' ? frame : {}), purpose: 'to show spending by category', hints: { tables: ['transactions'], words: ['spending'] }, at: new Date(T0).toISOString() },
    ]);
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    expect(await handler.handle(budget, askFrame({ purpose: 'please' }))).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.declined, false));
    expect(pendingAccessStore.get()).toEqual({});
  });

  it('stop asking → mutes the reader (not retryable)', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await askAndDecide(handler, askFrame(), () => ({ kind: 'stop-asking' }))).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.muted, false));
    expect(db.isAccessMuted(budget)).toBe(true);
    expect(db.listAccessDeclines(budget)).toEqual([]);
  });

  it('a frame retract (the reader closes) or a session reset dismisses the pending: ACCESS_DECLINED retryable, nothing recorded', async () => {
    unregister.push(registerAppHost(budget, () => {}));
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = handler.handle(budget, askFrame());
    await pendingFor(budget);
    unregister.pop()?.();
    expect(await answer).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(pendingAccessStore.get()).toEqual({});

    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const again = handler.handle(budget, askFrame());
    await pendingFor(budget);
    resetAccessSession(budget);
    expect(await again).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
  });

  it('a frame retract WHILE the candidates are gathered parks NOTHING (ACCESS_DECLINED retryable, nothing recorded) — and the same id’s next frame, at generation 0 again, is not blocked by a dead ask', async () => {
    unregister.push(registerAppHost(budget, () => {}));
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const describeReal = db.describeAppData.bind(db);
    const gathered = vi.spyOn(db, 'describeAppData').mockImplementation(async (id: string) => {
      await gate;
      return describeReal(id);
    });
    const answer = handler.handle(budget, askFrame());
    await expect.poll(() => gathered.mock.calls.length).toBeGreaterThan(0);
    unregister.pop()?.(); // the reader's view closes mid-gather
    release();
    // Awaited directly: a genuinely held answer is caught by the test timeout and names this row (W6 finding 30).
    expect(await answer).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(pendingAccessStore.get()).toEqual({});
    expect(db.listAccessDeclines(budget)).toEqual([]);
    expect(db.isAccessMuted(budget)).toBe(false);
    gathered.mockRestore();

    // The same app mounts again — RunView's epoch restarts at 0 — and its own ask reaches the strip.
    unregister.push(registerAppHost(budget, () => {}));
    const fresh = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const again = fresh.handle(budget, askFrame());
    const pending = await pendingFor(budget);
    void pending.resolve({ kind: 'not-now' });
    expect(await again).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
  });

  it('a NEWER frame generation composed while the candidates are gathered: the older frame’s ask parks nothing', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const describeReal = db.describeAppData.bind(db);
    const gathered = vi.spyOn(db, 'describeAppData').mockImplementation(async (id: string) => {
      await gate;
      return describeReal(id);
    });
    const answer = handler.handle(budget, askFrame());
    await expect.poll(() => gathered.mock.calls.length).toBeGreaterThan(0);
    createAccessHandlerFor(budget, { attended: true, generation: 1 }); // a remount
    release();
    // Awaited directly: a genuinely held answer is caught by the test timeout and names this row (W6 finding 30).
    expect(await answer).toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.notNow, true));
    expect(pendingAccessStore.get()).toEqual({});
  });

  // W6 finding 29 — the user's own ask is never replaced by an app's, in either order.
  it('a pending ask the USER started survives an app’s ask — either order — which is answered ACCESS_PENDING (retryable)', async () => {
    // Order 1: the user asks from host chrome while the app is closed (generation -1), then the app opens and asks.
    await startUserAsk(budget);
    const users = pendingAccessStore.get()[budget]!;
    expect(users).toMatchObject({ provenance: 'user', generation: -1 });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_PENDING', ACCESS_APP_MESSAGES.pending, true));
    expect(pendingAccessStore.get()[budget]).toBe(users);
    expect(users.purpose).toBe(ACCESS_SHEET.userPurpose('Budget'));
    void users.resolve({ kind: 'not-now' });

    // Order 2: the app is open (generation 0), the user asks, then the app asks.
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    await startUserAsk(budget);
    const second = pendingAccessStore.get()[budget]!;
    expect(second.provenance).toBe('user');
    expect(await handler.handle(budget, askFrame())).toEqual(refusal('ACCESS_PENDING', ACCESS_APP_MESSAGES.pending, true));
    expect(pendingAccessStore.get()[budget]).toBe(second);
  });

  // W6 finding 9 — D36 on the APP path: an allow of a renewing ask under the default *while it's
  // open* writes a new session grant and STOPS the renewed one, exactly like the host-chrome path.
  it('an app ask that RENEWS a paused access, allowed for the session: exactly one live access for the pair; the old one stopped with a revoked line', async () => {
    const { suspendAccess } = await import('../access/grants.js');
    const old = await grantFor({ duration: 'week' });
    await suspendAccess(db, old.id, 'reader-updated', new Date(clock.now).toISOString());
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await askAndDecide(handler, askFrame({ renew: old.id }), allowLedger('session'));
    expect(answer).toMatchObject({ ok: true, op: 'request', grant: { duration: 'session' } });
    await expect.poll(() => db.getAccessGrant(old.id)?.status).toBe('revoked');
    const reads = grantsForApp(db, budget, clock.now).reads;
    expect(reads.filter((row) => row.live)).toHaveLength(1);
    expect(reads.filter((row) => row.live)[0]).toMatchObject({ session: true });
    expect(reads.some((row) => row.grant.status === 'suspended'), 'no paused row lingers beside its successor').toBe(false);
    expect(kindsOf(ledger)).toContain('revoked');
  });

  it('the HOST-assigned id is the identity: a call under any other accessAppId is not this reader’s and is refused like an unknown grant', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const grant = await grantFor();
    expect(await handler.handle(pantry, askFrame())).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(await handler.handle(pantry, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(pendingAccessStore.get()).toEqual({});
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT amount FROM transactions ORDER BY amount'))).toMatchObject({ ok: true, rows: [[450], [500]] });
  });
});

// =========================================================================================
// AC12 — query
// =========================================================================================

describe('AC12 query — one read-only SELECT on a scoped copy, logged on the source', () => {
  it('a live grant reads its rows; the read is logged on the SOURCE (sql, rows, attended); reads and lastReadAt bump', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    clock.now += 5_000;
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT amount, category FROM transactions WHERE amount > ? ORDER BY amount', [100]))).toEqual({
      ok: true,
      op: 'query',
      columns: ['amount', 'category'],
      rows: [
        [450, 'food'],
        [500, 'rent'],
      ],
    });
    expect(db.listAccessLog(ledger)[0]).toEqual({
      at: new Date(clock.now).toISOString(),
      kind: 'read',
      grantId: grant.id,
      readerAppId: budget,
      readerName: 'Budget',
      tables: ['transactions'],
      sql: 'SELECT amount, category FROM transactions WHERE amount > ? ORDER BY amount',
      rows: 2,
      attended: true,
    });
    expect(db.getAccessGrant(grant.id)).toMatchObject({ reads: 1, lastReadAt: new Date(clock.now).toISOString() });
  });

  it('a table outside the grant is ABSENT: the read fails by absence, never by a name check', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await handler.handle(budget, queryFrame(grant.id, 'SELECT * FROM accounts'));
    expect(answer).toMatchObject({ ok: false, code: 'ACCESS_QUERY_FAILED', retryable: false });
    expect(answer.ok ? '' : answer.message).toContain('no such table');
  });

  it('the history keeps the statement’s first 200 characters — and OMITS the seat when the FULL statement is credential-shaped', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const long = `SELECT amount FROM transactions WHERE ${'amount > 0 AND '.repeat(30)}amount > 0`;
    await handler.handle(budget, queryFrame(grant.id, long));
    expect(db.listAccessLog(ledger)[0]?.sql).toBe(long.slice(0, ACCESS_LOG_SQL_MAX_CHARS));
    // The key STRADDLES the cut: the 200-character prefix alone holds too little of it for the walk to
    // recognise, so a writer that walked only the cut text would persist a partial key.
    const keyed = `SELECT amount FROM transactions WHERE ${'amount > 0 AND '.repeat(9)}category <> 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'`;
    expect(keyed.indexOf('sk-ant')).toBeLessThan(ACCESS_LOG_SQL_MAX_CHARS);
    expect(keyed.indexOf('sk-ant') + 20).toBeGreaterThan(ACCESS_LOG_SQL_MAX_CHARS);
    await handler.handle(budget, queryFrame(grant.id, keyed));
    const [entry] = db.listAccessLog(ledger);
    expect(entry).toMatchObject({ kind: 'read', grantId: grant.id, rows: 2 });
    expect(entry?.sql).toBeUndefined();
  });

  it('the scoped bytes are cached per grant for 10 s — one export inside the window, a fresh one after', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const exported = vi.spyOn(db, 'exportAppRuntime');
    await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'));
    clock.now += ACCESS_SCOPED_CACHE_MS - 1;
    await handler.handle(budget, queryFrame(grant.id, 'SELECT 2'));
    expect(exported).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await handler.handle(budget, queryFrame(grant.id, 'SELECT 3'));
    expect(exported).toHaveBeenCalledTimes(2);
  });

  it('a source over 16 MiB is refused: ACCESS_QUERY_FAILED “too large to share this way”', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    vi.spyOn(db, 'exportAppRuntime').mockResolvedValue(new Uint8Array(ACCESS_SOURCE_MAX_BYTES + 1));
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.tooLarge, false));
  });

  it('a read that outruns the wall clock → ACCESS_QUERY_FAILED “took too long”; three CONSECUTIVE timeouts suspend the grant reader-misbehaved and log it (a success resets the count)', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    // A worker that never answers stands in for an unbounded `WITH RECURSIVE` (vitest has no
    // thread to run one on — run inline it would hang this suite, which is the whole point of D10).
    const silent = (): void =>
      configureScopedRead({ createWorker: () => ({ onmessage: null, onerror: null, postMessage() {}, terminate() {} }), wasm: { wasmUrl: locateWasm() }, timeoutMs: 15, now: () => clock.now });
    const slow = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT count(*) FROM r';
    silent();
    for (let i = 0; i < ACCESS_TIMEOUT_STRIKES - 1; i++) {
      expect(await handler.handle(budget, queryFrame(grant.id, slow))).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.tookTooLong, false));
    }
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'active', timeouts: ACCESS_TIMEOUT_STRIKES - 1 });
    resetScopedReadForTests();
    useInlineWorker();
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toMatchObject({ ok: true });
    expect(db.getAccessGrant(grant.id)?.timeouts, 'a read that answers resets the count').toBe(0);
    resetScopedReadForTests();
    silent();
    for (let i = 0; i < ACCESS_TIMEOUT_STRIKES - 1; i++) await handler.handle(budget, queryFrame(grant.id, slow));
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'active' });
    expect(await handler.handle(budget, queryFrame(grant.id, slow))).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.tookTooLong, false));
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'reader-misbehaved' });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'suspended', reason: 'reader-misbehaved' });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.paused, false));
  });

  it('an expired grant → ACCESS_EXPIRED and ONE expired line however often it is asked', async () => {
    const grant = await grantFor({ duration: 'day' });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    clock.now += DAY;
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_EXPIRED', ACCESS_APP_MESSAGES.expired, false));
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_EXPIRED', ACCESS_APP_MESSAGES.expired, false));
    expect(kindsOf(ledger).filter((kind) => kind === 'expired')).toHaveLength(1);
  });

  it('a stopped or paused grant → ACCESS_REVOKED', async () => {
    const stopped = await grantFor();
    const paused = await grantFor({ duration: 'week' });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const { revokeAccess, suspendAccess } = await import('../access/grants.js');
    await revokeAccess(stopped.id);
    await suspendAccess(db, paused.id, 'imported', new Date(clock.now).toISOString());
    expect(await handler.handle(budget, queryFrame(stopped.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(await handler.handle(budget, queryFrame(paused.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.paused, false));
  });

  // W6 finding 8 — the default duration: a stopped SESSION grant answers ACCESS_REVOKED, like a
  // stopped persisted one (AC12/AC22, spec §23.4), never the "ask first" of an unknown id.
  it('a stopped SESSION grant → ACCESS_REVOKED for its own generation — through the host’s stop and the reader’s release alike', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const { revokeAccess } = await import('../access/grants.js');
    const stopped = await grantFor({ duration: 'session', generation: 0 });
    expect(await handler.handle(budget, queryFrame(stopped.id, 'SELECT count(*) FROM transactions'))).toMatchObject({ ok: true });
    await revokeAccess(stopped.id);
    const afterStop = await handler.handle(budget, queryFrame(stopped.id, 'SELECT 1'));
    expect(afterStop).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(JSON.stringify(afterStop)).not.toBe(JSON.stringify(await handler.handle(budget, queryFrame(UNKNOWN_ID, 'SELECT 1'))));

    clock.now += 61_000;
    const released = await grantFor({ duration: 'session', generation: 0 });
    expect(await handler.handle(budget, releaseFrame(released.id))).toEqual({ ok: true, op: 'release' });
    expect(await handler.handle(budget, queryFrame(released.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(await handler.handle(budget, releaseFrame(released.id)), 'released twice: nothing left to give back').toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));

    // The sheets and list show neither (a stopped session access has nothing to renew or remove) …
    expect(grantsForApp(db, budget, clock.now).reads).toEqual([]);
    expect(await handler.handle(budget, listFrame())).toEqual({ ok: true, op: 'list', grants: [] });
    // … and the tombstone dies with its frame: the next generation knows nothing of it.
    const next = createAccessHandlerFor(budget, { attended: true, generation: 1 });
    expect(await next.handle(budget, queryFrame(stopped.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
  });

  it('another reader’s grant and an unknown id answer BYTE-IDENTICALLY ACCESS_NOT_GRANTED', async () => {
    const theirs = await grantFor({ reader: pantry });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const foreign = await handler.handle(budget, queryFrame(theirs.id, 'SELECT 1'));
    const unknown = await handler.handle(budget, queryFrame(UNKNOWN_ID, 'SELECT 1'));
    const junk = await handler.handle(budget, queryFrame('not-a-grant', 'SELECT 1'));
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    expect(JSON.stringify(junk)).toBe(JSON.stringify(unknown));
    expect(unknown).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(kindsOf(ledger)).toEqual(['granted']);
  });

  it('a session grant from another frame generation → ACCESS_NOT_GRANTED; its own generation reads', async () => {
    // Usable while away, so only the GENERATION can refuse it here: another frame (a hidden scheduled
    // run, a remount) never inherits a grant that lives "while it's open".
    const session = await grantFor({ duration: 'session', generation: 0, unattended: true });
    const hidden = createAccessHandlerFor(budget, { attended: false });
    expect(await hidden.handle(budget, queryFrame(session.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(await hidden.handle(budget, releaseFrame(session.id))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(kindsOf(ledger), 'not this frame’s grant: nothing logged').toEqual(['granted']);
    const own = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await own.handle(budget, queryFrame(session.id, 'SELECT count(*) FROM transactions'))).toMatchObject({ ok: true, rows: [[2]] });
    expect(grantsForApp(db, budget, clock.now).reads[0]?.grant).toMatchObject({ reads: 1 });
  });

  it('a hidden frame on a grant WITHOUT also-while-away → ACCESS_NOT_GRANTED and a refused line; WITH it the read runs and is logged away', async () => {
    const attendedOnly = await grantFor();
    const away = await grantFor({ duration: 'week', unattended: true });
    const hidden = createAccessHandlerFor(budget, { attended: false });
    expect(await hidden.handle(budget, queryFrame(attendedOnly.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'refused', grantId: attendedOnly.id, attended: false });
    expect(await hidden.handle(budget, queryFrame(away.id, 'SELECT count(*) FROM transactions'))).toMatchObject({ ok: true, rows: [[2]] });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'read', grantId: away.id, attended: false });
  });

  it('a HIDDEN frame is rate-limited like any other — every query op counts, refused or unknown: the 61st in a minute → ACCESS_RATE_LIMITED', async () => {
    const attendedOnly = await grantFor();
    const hidden = createAccessHandlerFor(budget, { attended: false });
    for (let i = 0; i < ACCESS_QUERY_RATE_PER_MINUTE - 1; i++) {
      expect(await hidden.handle(budget, queryFrame(attendedOnly.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    }
    expect(await hidden.handle(budget, queryFrame(UNKNOWN_ID, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(await hidden.handle(budget, queryFrame(attendedOnly.id, 'SELECT 1'))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
    expect(await hidden.handle(budget, queryFrame(UNKNOWN_ID, 'SELECT 1'))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
  });

  it('a hidden reader cannot wipe the source’s history: a prior read survives 250 refused calls — ONE refused line per access per minute', async () => {
    const attendedOnly = await grantFor();
    const visible = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await visible.handle(budget, queryFrame(attendedOnly.id, 'SELECT amount FROM transactions'))).toMatchObject({ ok: true });
    const hidden = createAccessHandlerFor(budget, { attended: false });
    for (let i = 0; i < 250; i++) {
      clock.now += 10;
      await hidden.handle(budget, queryFrame(attendedOnly.id, 'SELECT 1'));
    }
    expect(kindsOf(ledger)).toEqual(['refused', 'read', 'granted']);
    // a minute on, one more refused line — and still the read
    clock.now += ACCESS_LOG_COALESCE_MS;
    expect(await hidden.handle(budget, queryFrame(attendedOnly.id, 'SELECT 1'))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(kindsOf(ledger)).toEqual(['refused', 'refused', 'read', 'granted']);
  });

  it('a hidden frame NEVER reads a session (“while it’s open”) grant — not even ticked also-while-away, not even while the view is open, whatever its generation', async () => {
    for (const generation of [0, 1]) {
      resetAccessSession();
      const visible = createAccessHandlerFor(budget, { attended: true, generation });
      const session = await grantFor({ duration: 'session', generation, unattended: true });
      expect(await visible.handle(budget, queryFrame(session.id, 'SELECT count(*) FROM transactions'))).toMatchObject({ ok: true, rows: [[2]] });
      const before = kindsOf(ledger);
      const hidden = createAccessHandlerFor(budget, { attended: false });
      expect(await hidden.handle(budget, queryFrame(session.id, 'SELECT count(*) FROM transactions')), `generation ${generation}`).toEqual(
        refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false),
      );
      const listed = await hidden.handle(budget, listFrame());
      expect(listed.ok && listed.op === 'list' ? listed.grants.map((view) => view.id) : ['?']).toEqual([]);
      expect(kindsOf(ledger), 'not the hidden frame’s access: nothing logged').toEqual(before);
    }
  });

  it('a source that holds a WhatsApp fact at query time suspends the grant source-restricted and answers ACCESS_REVOKED — nothing is exported', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    db.putDeclaredConnection(ledger, 'whatsapp', { slot: 'whatsapp', provider: { name: 'WhatsApp' }, kind: 'linked_device', declaredApiHosts: [SIDECAR_SYMBOLIC_HOST] } as Parameters<UserDb['putDeclaredConnection']>[2], 'starter');
    const exported = vi.spyOn(db, 'exportAppRuntime');
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.paused, false));
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'source-restricted' });
    expect(exported).not.toHaveBeenCalled();
  });

  it('a change to a granted table’s columns suspends the grant source-changed and answers ACCESS_REVOKED', async () => {
    const grant = await grantFor();
    await db.applyAppDdl(ledger, ['ALTER TABLE transactions ADD COLUMN note TEXT']);
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT amount FROM transactions'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.sourceChanged, false));
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'source-changed' });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'suspended', reason: 'source-changed' });
  });

  it('anything but one read-only SELECT → ACCESS_QUERY_REFUSED with NO export', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const exported = vi.spyOn(db, 'exportAppRuntime');
    for (const sql of ['DELETE FROM transactions', 'PRAGMA query_only = 0; SELECT 1', 'SELECT 1; SELECT 2', "ATTACH 'x' AS y"]) {
      expect(await handler.handle(budget, queryFrame(grant.id, sql))).toEqual(refusal('ACCESS_QUERY_REFUSED', ACCESS_APP_MESSAGES.queryRefused, false));
    }
    expect(exported).not.toHaveBeenCalled();
    expect(kindsOf(ledger)).toEqual(['granted']);
  });

  it('more than 60 queries a minute per app → ACCESS_RATE_LIMITED (retryable); the next minute reads again', async () => {
    const grant = await grantFor();
    configureScopedRead({ createWorker: answeringWorkers(() => ({ ok: true, columns: ['n'], rows: [[1]] })), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    for (let i = 0; i < ACCESS_QUERY_RATE_PER_MINUTE; i++) expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toMatchObject({ ok: true });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
    clock.now += 60_000;
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toMatchObject({ ok: true });
  });

  it('an engine error → ACCESS_QUERY_FAILED; an engine refusal → ACCESS_QUERY_REFUSED', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    // W6 finding 12: a scoping failure is a TYPED reason — its message names a source object and
    // never reaches the app, whatever its wording; an ordinary SQL error's message does.
    configureScopedRead({ createWorker: answeringWorkers(() => ({ ok: false, reason: 'copy-failed', message: 'the scoped copy still contains "accounts"' })), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1')), 'an internal fail-closed message never reaches the app').toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.queryFailed, false));
    resetScopedReadForTests();
    configureScopedRead({ createWorker: answeringWorkers(() => ({ ok: false, reason: 'failed', message: 'no such column: nope' })), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT nope FROM transactions'))).toEqual(
      refusal('ACCESS_QUERY_FAILED', `${ACCESS_APP_MESSAGES.queryFailed}: no such column: nope`, false),
    );
    resetScopedReadForTests();
    configureScopedRead({ createWorker: answeringWorkers(() => ({ ok: false, reason: 'refused', message: 'forbidden statement: load_extension' })), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT load_extension(1)'))).toEqual(refusal('ACCESS_QUERY_REFUSED', ACCESS_APP_MESSAGES.queryRefused, false));
  });

  it('where no Worker can be constructed → ACCESS_QUERY_FAILED “this host cannot run cross-app reads”', async () => {
    const grant = await grantFor();
    resetScopedReadForTests();
    vi.stubGlobal('Worker', undefined);
    configureScopedRead({ wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.noWorker, false));
    vi.unstubAllGlobals();
  });

  it('rows are scanned keyed by COLUMN NAME: a credential-shaped cell crosses as ***, and every cell under a credential-named column is masked whatever its entropy', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    configureScopedRead({
      createWorker: answeringWorkers(() => ({
        ok: true,
        columns: ['note', 'password', 'amount', 'harmless'],
        rows: [
          ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', 'hunter2', 450, 'Bearer abc.def'],
          ['lunch', null, 500, 'fine'],
        ],
      })),
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT note, api AS password, amount, x AS harmless FROM transactions'))).toEqual({
      ok: true,
      op: 'query',
      columns: ['note', 'password', 'amount', 'harmless'],
      rows: [
        ['***', '***', 450, '***'],
        ['lunch', '***', 500, 'fine'],
      ],
    });
  });

  // W6 finding 1 — end to end through the real worker: the value mask is on the COPY, so a
  // transform in the reader's own statement cannot carry a credential-shaped cell past it.
  it('a credential-shaped VALUE under a neutral column crosses masked even through a transform in the reader’s statement', async () => {
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    await db.driver.handle(ledger, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${++seq}`, instanceId: 'seed', op: 'exec', sql: `INSERT INTO transactions (amount, category) VALUES (1, '${key}')` });
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    for (const sql of ["SELECT ' ' || category AS v FROM transactions", 'SELECT hex(category) FROM transactions', 'SELECT substr(category, 4) FROM transactions', 'SELECT category FROM transactions']) {
      clock.now += 1;
      const answer = await handler.handle(budget, queryFrame(grant.id, sql));
      expect(answer, sql).toMatchObject({ ok: true });
      expect(JSON.stringify(answer), sql).not.toMatch(/sk-ant-api03|abcdefghijklmnop|736B2D616E74/i);
    }
  });

  // W6 finding 7 — a read queued behind another is re-checked against its grant when it dequeues.
  it('a read QUEUED behind a slow one never reaches the worker once its grant is stopped meanwhile: ACCESS_REVOKED', async () => {
    const grant = await grantFor();
    const { revokeAccess } = await import('../access/grants.js');
    const jobs: unknown[] = [];
    configureScopedRead({
      createWorker: () => ({
        onmessage: null,
        onerror: null,
        postMessage(msg) {
          if (typeof msg === 'object' && msg !== null && 'id' in msg) jobs.push(msg);
        },
        terminate() {},
      }),
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
      timeoutMs: 600,
    });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const slow = handler.handle(budget, queryFrame(grant.id, 'SELECT 1'));
    const queued = handler.handle(budget, queryFrame(grant.id, 'SELECT 2'));
    await expect.poll(() => jobs.length).toBe(1);
    await revokeAccess(grant.id);
    expect(await slow).toEqual(refusal('ACCESS_QUERY_FAILED', ACCESS_APP_MESSAGES.tookTooLong, false));
    expect(await queued).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(jobs, 'the queued read was never posted').toHaveLength(1);
  });

  it('a stop that lands WHILE the read runs wins: no rows leave, nothing is logged as read, and the grant is never written back active', async () => {
    const grant = await grantFor();
    const { revokeAccess } = await import('../access/grants.js');
    configureScopedRead({
      createWorker: () => {
        const worker: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg) {
            if (typeof msg !== 'object' || msg === null || !('id' in msg)) return;
            const id = (msg as { id: number }).id;
            void revokeAccess(grant.id).then(() => worker.onmessage?.({ data: { id, result: { ok: true, columns: ['n'], rows: [[1]] } } }));
          },
          terminate() {},
        };
        return worker;
      },
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1 AS n'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'revoked', reads: 0 });
    expect(kindsOf(ledger)).toEqual(['revoked', 'granted']);
  });

  it('truncation passes through in band', async () => {
    const grant = await grantFor();
    configureScopedRead({ createWorker: answeringWorkers(() => ({ ok: true, columns: ['n'], rows: [[1]], truncated: true, totalRows: 900 })), wasm: { wasmUrl: locateWasm() }, now: () => clock.now });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1'))).toEqual({ ok: true, op: 'query', columns: ['n'], rows: [[1]], truncated: true, totalRows: 900 });
  });
});

// =========================================================================================
// AC13 — list / release
// =========================================================================================

describe('the user’s own creation act — *let Budget read another app…*', () => {
  it('parks a USER ask carrying the host’s purpose — never the act’s label as if Budget had said it — and an allow writes that purpose on the record', async () => {
    await startUserAsk(budget);
    const pending = pendingAccessStore.get()[budget]!;
    expect(pending).toMatchObject({ provenance: 'user', purpose: ACCESS_SHEET.userPurpose('Budget') });
    expect(pending.purpose).not.toBe(ACCESS_SHEET.create('Budget'));
    expect(await pending.resolve({ kind: 'allow', sourceAppId: ledger, tables: ['transactions'], duration: 'day', unattended: false })).toMatchObject({ kind: 'allowed' });
    expect(db.listAccessGrants()).toEqual([expect.objectContaining({ provenance: 'user', purpose: ACCESS_SHEET.userPurpose('Budget') })]);
  });
});

describe('AC13 list and release', () => {
  it('list answers only THIS reader’s LIVE grants as views — never another reader’s, a stopped one, an expired one or another generation’s session grant', async () => {
    const day = await grantFor({ duration: 'day' });
    const session = await grantFor({ duration: 'session', generation: 0, source: pantry, tables: ['items'] });
    await grantFor({ duration: 'session', generation: 1 });
    await grantFor({ reader: pantry });
    const stopped = await grantFor({ duration: 'week' });
    const { revokeAccess } = await import('../access/grants.js');
    await revokeAccess(stopped.id);
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const answer = await handler.handle(budget, listFrame());
    expect(answer.ok && answer.op === 'list' ? answer.grants.map((view) => view.id).sort() : []).toEqual([day.id, session.id].sort());
    expect(answer).toMatchObject({
      ok: true,
      op: 'list',
      grants: expect.arrayContaining([
        { id: day.id, access: 'read', source: { displayName: 'Ledger', iconEmoji: '📒', iconColor: '#336699' }, tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'] }], duration: 'day', expiresAt: new Date(T0 + DAY).toISOString(), unattended: false },
        { id: session.id, access: 'read', source: { displayName: 'Pantry' }, tables: [{ name: 'items', columns: ['name', 'qty'] }], duration: 'session', unattended: false },
      ]),
    });
    clock.now += DAY;
    const later = await handler.handle(budget, listFrame());
    expect(later.ok && later.op === 'list' ? later.grants.map((view) => view.id) : []).toEqual([session.id]);
  });

  // W6 finding 10 — a grant that outlived its source's library row (a delete outside the library
  // seam, an inconsistent file) is never answered as a view with no name — the reader's own parser
  // would refuse it and the call would never settle.
  it('a session grant whose SOURCE row is gone is left out of list — every view the reader gets names its source', async () => {
    const session = await grantFor({ duration: 'session', generation: 0 });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, listFrame())).toMatchObject({ ok: true, grants: [{ id: session.id, source: { displayName: 'Ledger' } }] });
    await db.deleteApp(ledger); // directly — not through the library seam that resets the session
    const answer = await handler.handle(budget, listFrame());
    expect(answer).toEqual({ ok: true, op: 'list', grants: [] });
    expect(JSON.stringify(answer)).not.toContain('"displayName":""');
  });

  it('a hidden frame lists only the grants it may use while you are away', async () => {
    await grantFor({ duration: 'day' });
    const away = await grantFor({ duration: 'week', unattended: true });
    const hidden = createAccessHandlerFor(budget, { attended: false });
    const answer = await hidden.handle(budget, listFrame());
    expect(answer.ok && answer.op === 'list' ? answer.grants.map((view) => view.id) : []).toEqual([away.id]);
  });

  // Gate-5 fold F-10 (maintainability MINOR): during a delegated run (D-PR1-8) `query` refuses a session
  // grant, so `list` must not advertise one — it filters on the same "someone is there" test.
  it('F-10: while a delegated run is in flight `list` leaves out the SESSION grant (it lists the one allowed *also while I’m away*); after the run the session grant is listed again', async () => {
    const session = await grantFor({ duration: 'session', generation: 0 });
    const away = await grantFor({ duration: 'week', unattended: true, source: pantry, tables: ['items'] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const ids = (answer: AccessHandlerResult): string[] => (answer.ok && answer.op === 'list' ? answer.grants.map((view) => view.id).sort() : ['?']);
    expect(ids(await handler.handle(budget, listFrame()))).toEqual([session.id, away.id].sort());

    expect(beginDelegatedRun({ appId: budget, appName: 'Budget', runId: 'run-f10', taskId: 't1', title: 'Morning sums', generation: 0 }).ok).toBe(true);
    try {
      expect(ids(await handler.handle(budget, listFrame())), 'never advertise a grant `query` would refuse').toEqual([away.id]);
    } finally {
      endDelegatedRun(budget, 'run-f10');
      clearTouchedGeneration(budget, 0);
    }
    expect(ids(await handler.handle(budget, listFrame()))).toEqual([session.id, away.id].sort());
  });

  it('release gives back the reader’s OWN grant (revoked, a released line on the source, the reader rung); another reader’s or an unknown id → ACCESS_NOT_GRANTED', async () => {
    unregister.push(registerAppHost(budget, (event, data) => rings.push({ appId: budget, event, data })));
    const mine = await grantFor();
    const theirs = await grantFor({ reader: pantry });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, releaseFrame(theirs.id))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(await handler.handle(budget, releaseFrame(UNKNOWN_ID))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(db.getAccessGrant(theirs.id)).toMatchObject({ status: 'active' });
    expect(await handler.handle(budget, releaseFrame(mine.id))).toEqual({ ok: true, op: 'release' });
    expect(db.getAccessGrant(mine.id)).toMatchObject({ status: 'revoked' });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'released', grantId: mine.id });
    expect(rings).toEqual([{ appId: budget, event: ACCESS_CHANGED_EVENT, data: { grantId: mine.id } }]);
    expect(await handler.handle(budget, queryFrame(mine.id, 'SELECT 1'))).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
  });

  it('release of another generation’s session grant → ACCESS_NOT_GRANTED', async () => {
    const session = await grantFor({ duration: 'session', generation: 1 });
    const handler = createAccessHandlerFor(budget, { attended: false });
    expect(await handler.handle(budget, releaseFrame(session.id))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
  });
});

// =========================================================================================
// PR-3 — write · refresh · discover (contract v2 D-PR3-13/14/15/20/21; §24.5 MUSTs 18–24)
// =========================================================================================

// The wire's, copy's, the db's and the engine's PR-3 names — the real exports (the pins lane swapped
// the Gate-3 local widenings and structural types for them).

/** The words every write refusal starts with — read from copy.ts (two rules' sentences share them), never retyped. */
const writeRefusedPrefix = (): string => {
  const a = ACCESS_APP_MESSAGES.writeRefused('table');
  const b = ACCESS_APP_MESSAGES.writeRefused('column');
  let n = 0;
  while (n < a.length && a[n] === b[n]) n += 1;
  return a.slice(0, n);
};

/** One table of the v2 decision (D-PR3-23) — grants.ts's `TableChoice`. */
type DecisionTableV2 = TableChoice;

/** The log entry v2 (D-PR3-6) — the protocol's `AccessLogEntry` carries the new seats. */
type LogEntryV2 = AccessLogEntry;

/** The undo journal (D-PR3-7) — the UserDb's own accessor. */
type UndoAccessors = Pick<UserDb, 'listAccessUndo'>;
const undoJournal = (): UndoAccessors => db;

/** `access/writeBroker.ts` (I-E1) — still loaded through a variable specifier (the Gate-3 isolation); its type is the module's own. */
type WriteBrokerModule = typeof import('../access/writeBroker.js');
const WRITE_BROKER_MODULE = '../access/writeBroker.js';
const writeBroker = (): Promise<WriteBrokerModule> => import(/* @vite-ignore */ WRITE_BROKER_MODULE) as Promise<WriteBrokerModule>;

// The three new frames — members of the protocol's request union since I-W (the Gate-3 casts dropped).
const writeFrame = (grantId: string, sql: string, params?: Array<string | number | null>): AccessRequestFrame => ({ ...base(), op: 'write', grantId, sql, ...(params !== undefined ? { params } : {}) });
const refreshFrame = (grantId: string): AccessRequestFrame => ({ ...base(), op: 'refresh', grantId });
const discoverFrame = (): AccessRequestFrame => ({ ...base(), op: 'discover', hints: { tables: ['transactions'], words: ['spending'] } });

/** A v2 grant (write / kv / refresh), made through THE writer behind the user's allow. */
async function writeGrantFor(over: {
  reader?: string;
  source?: string;
  tables: DecisionTableV2[];
  duration?: 'session' | 'day' | 'week' | 'always';
  unattended?: boolean;
  generation?: number;
  refresh?: boolean;
}): Promise<AnyAccessGrant> {
  const reader = over.reader ?? budget;
  const ranked = await collectSources(db, reader);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === (over.source ?? ledger));
  if (source === undefined) throw new Error('no such candidate');
  const input: CreateGrantInput = {
    readerAppId: reader,
    source,
    tables: over.tables,
    duration: over.duration ?? 'day',
    unattended: over.unattended ?? false,
    ...(over.refresh === true ? { refresh: true } : {}),
    purpose: 'to show spending by category',
    provenance: 'app' as const,
    generation: over.generation ?? 0,
    now: clock.now,
  };
  return createGrantFromDecision(db, input);
}

const WRITE_TRANSACTIONS: DecisionTableV2 = { name: 'transactions', withheld: [], write: true };
const READ_ACCOUNTS: DecisionTableV2 = { name: 'accounts', withheld: [], write: false };
const WRITE_ACCOUNTS: DecisionTableV2 = { name: 'accounts', withheld: [], write: true };

/** A credential-shaped value (a known provider prefix, start-anchored). */
const SECRET = 'sk-live1234567890abcdefghijklmn';

async function rowsOf(appId: string, sql: string): Promise<unknown> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `read-${++seq}`, instanceId: 'check', op: 'exec', sql });
  return result.ok ? result.rows : result;
}

async function execOn(appId: string, sql: string): Promise<void> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `exec-${++seq}`, instanceId: 'frame', op: 'exec', sql });
  if (!result.ok) throw new Error(`exec failed: ${JSON.stringify(result)}`);
}

const wroteLines = (sourceId: string): LogEntryV2[] => (db.listAccessLog(sourceId) as LogEntryV2[]).filter((entry) => (entry.kind as string) === 'wrote');

const isPlanWriteJob = (msg: unknown): boolean => typeof msg === 'object' && msg !== null && (msg as { kind?: unknown }).kind === 'plan-write';

describe('PR-3 write — one plain statement on a table the user let it change, journaled, undoable (D-PR3-14/15; §24.5 MUSTs 18–22)', () => {
  it('a write under a write grant answers { ok, op: write, changes } and NOTHING else; the source’s history has the wrote line (via app, authority permission, changes, undoId, the table, the statement) and the undo entry its structured rows — both written BEFORE the answer', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS, READ_ACCOUNTS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const sql = "UPDATE transactions SET category = 'groceries' WHERE id = 1";
    let atSettle: { line: LogEntryV2 | undefined; entries: number } | undefined;
    const answer = await handler.handle(budget, writeFrame(grant.id, sql)).then((settled) => {
      // The mutation test: read the file the instant the answer settles.
      atSettle = { line: wroteLines(ledger)[0], entries: undoJournal().listAccessUndo(ledger).length };
      return settled;
    });

    expect(answer, 'changes only — no undo id on the wire (DS16)').toEqual({ ok: true, op: 'write', changes: 1 });
    expect(atSettle?.line, 'the wrote line exists when the answer settles').toBeDefined();
    expect(atSettle?.entries, 'the undo entry exists when the answer settles').toBe(1);
    expect(await rowsOf(ledger, 'SELECT category FROM transactions WHERE id = 1')).toEqual([['groceries']]);

    const [entry] = undoJournal().listAccessUndo(ledger);
    expect(entry).toMatchObject({
      authority: 'permission',
      via: 'app',
      grantId: grant.id,
      readerAppId: budget,
      readerName: 'Budget',
      steps: [{ table: 'transactions', op: 'update', columns: ['category'], rows: [{ rowid: 1, before: ['food'], after: ['groceries'] }] }],
    });
    expect(entry?.undoneAt).toBeUndefined();
    expect(Date.parse(entry!.expiresAt) - Date.parse(entry!.at), 'kept seven days').toBe(7 * DAY);
    expect(ACCESS_UNDO_TTL_MS).toBe(7 * DAY);
    expect(wroteLines(ledger)).toHaveLength(1);
    expect(db.listAccessLog(ledger)[0]).toMatchObject({
      kind: 'wrote',
      grantId: grant.id,
      readerAppId: budget,
      readerName: 'Budget',
      via: 'app',
      authority: 'permission',
      changes: 1,
      undoId: entry!.id,
      tables: ['transactions'],
      sql,
    });
  });

  it('data-changed rings the target’s live frame with { table }; access-source-changed rings every OTHER live reader with { grantId } — never the writer; no event carries a row, a value, a name or a count (D-PR3-20 (c))', async () => {
    // A source seeded with ONE row-modifying exec, so the doorbell's coalescing window has no trailing ring to add.
    const journal = db.installApp({ displayName: 'Journal', html: '<!doctype html><title>j</title>' }).appId;
    await seed(journal, ['CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT, amount INTEGER)'], ["INSERT INTO entries (title, amount) VALUES ('tea', 3), ('cake', 5)"]);
    const mine = await writeGrantFor({ source: journal, tables: [{ name: 'entries', withheld: [], write: true }] });
    const theirs = await grantFor({ reader: pantry, source: journal, tables: ['entries'] });
    for (const appId of [journal, budget, pantry]) unregister.push(registerAppHost(appId, (event, data) => rings.push({ appId, event, data })));
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });

    expect(await handler.handle(budget, writeFrame(mine.id, "UPDATE entries SET amount = 4 WHERE title = 'tea'"))).toEqual({ ok: true, op: 'write', changes: 1 });

    const doorbells = rings.filter((ring) => ring.event === DATA_CHANGED_EVENT || ring.event === ACCESS_SOURCE_CHANGED_EVENT);
    expect(DATA_CHANGED_EVENT).toBe('data-changed');
    expect(ACCESS_SOURCE_CHANGED_EVENT).toBe('access-source-changed');
    expect(doorbells.filter((ring) => ring.event === DATA_CHANGED_EVENT)).toEqual([{ appId: journal, event: DATA_CHANGED_EVENT, data: { table: 'entries' } }]);
    expect(doorbells).toContainEqual({ appId: pantry, event: ACCESS_SOURCE_CHANGED_EVENT, data: { grantId: theirs.id } });
    expect(doorbells.filter((ring) => ring.appId === budget), 'never the writer').toEqual([]);
    for (const ring of doorbells) {
      expect(Object.keys(ring.data as object), 'ids only').toEqual([ring.event === DATA_CHANGED_EVENT ? 'table' : 'grantId']);
    }
  });

  it('a write to a table the access does not let it change → ACCESS_NOT_GRANTED “read-only for that table” — nothing changes, no line, no entry', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS, READ_ACCOUNTS] });
    const readOnly = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, writeFrame(grant.id, "UPDATE accounts SET balance = 1 WHERE name = 'main'"))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.writeNotGranted, false));
    expect(await handler.handle(budget, writeFrame(readOnly.id, "UPDATE transactions SET category = 'x' WHERE id = 1"))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.writeNotGranted, false));
    expect(await rowsOf(ledger, 'SELECT balance FROM accounts')).toEqual([[9000]]);
    expect(await rowsOf(ledger, 'SELECT category FROM transactions WHERE id = 1')).toEqual([['food']]);
    expect(kindsOf(ledger)).toEqual(['granted', 'granted']);
    expect(undoJournal().listAccessUndo(ledger)).toEqual([]);
  });

  it('another reader’s grant and an unknown id answer a write BYTE-IDENTICALLY ACCESS_NOT_GRANTED “ask first”', async () => {
    const theirs = await writeGrantFor({ reader: pantry, tables: [WRITE_TRANSACTIONS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const sql = "UPDATE transactions SET category = 'x' WHERE id = 1";
    expect(await handler.handle(budget, writeFrame(theirs.id, sql))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(await handler.handle(budget, writeFrame(UNKNOWN_ID, sql))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.notGranted, false));
    expect(wroteLines(ledger)).toEqual([]);
  });
});

describe('PR-3 write — every refusal is ACCESS_WRITE_REFUSED in the reader’s words, decided from the schema and the scope (D-PR3-9/12/24; §24.5 MUSTs 19–21)', () => {
  beforeEach(async () => {
    // Ledger grows the tables the rules need: a column holding a credential-shaped value (masked on
    // the copy), a computed column, a table carrying a trigger; and 200 more accounts (201 in all).
    await db.applyAppDdl(ledger, [
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)',
      'CREATE TABLE totals (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, total INTEGER GENERATED ALWAYS AS (a + b))',
      'CREATE TABLE audited (id INTEGER PRIMARY KEY, v TEXT)',
    ]);
    await execOn(ledger, `INSERT INTO notes (id, body) VALUES (1, '${SECRET}'), (2, 'plain')`);
    await execOn(ledger, 'INSERT INTO totals (id, a, b) VALUES (1, 2, 5)');
    await execOn(ledger, "INSERT INTO audited (id, v) VALUES (1, 'a')");
    await execOn(ledger, 'CREATE TRIGGER audited_touch AFTER UPDATE ON audited BEGIN SELECT 1; END');
    await execOn(ledger, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200) INSERT INTO accounts (name, balance) SELECT 'n' || x, x FROM c");
  });

  /** Every table the cases touch, as rows — the oracle for "nothing changed". */
  const snapshot = async (): Promise<string> =>
    JSON.stringify(await Promise.all(['transactions', 'accounts', 'notes', 'totals', 'audited'].map((table) => rowsOf(ledger, `SELECT * FROM ${table} ORDER BY rowid`))));

  const writeOn = (name: string, withheld: string[] = []): DecisionTableV2[] => [{ name, withheld, write: true }];

  const CASES: ReadonlyArray<{ name: string; tables: DecisionTableV2[]; sql: string; params?: Array<string | number | null>; rule?: WriteRefusalRule }> = [
    { name: 'two statements', tables: writeOn('transactions'), sql: "UPDATE transactions SET category = 'a' WHERE id = 1; UPDATE transactions SET category = 'b' WHERE id = 2" },
    { name: 'a function in SET', tables: writeOn('transactions'), sql: "UPDATE transactions SET category = upper('a') WHERE id = 1" },
    { name: 'an UPDATE with no WHERE', tables: writeOn('transactions'), sql: "UPDATE transactions SET category = 'a'", rule: 'no-where' },
    { name: 'a DELETE with no WHERE (on a fully shared table)', tables: writeOn('accounts'), sql: 'DELETE FROM accounts', rule: 'no-where' },
    { name: 'a withheld column in WHERE', tables: writeOn('transactions', ['category']), sql: "UPDATE transactions SET amount = 1 WHERE category = 'food'", rule: 'column' },
    { name: 'a credential-named column in SET (AC19 negative)', tables: writeOn('transactions'), sql: "UPDATE transactions SET api_key = 'x' WHERE id = 1", rule: 'column' },
    { name: 'a column the copy masked a cell in', tables: writeOn('notes'), sql: "UPDATE notes SET body = 'hello' WHERE id = 2", rule: 'column' },
    { name: 'a generated column', tables: writeOn('totals'), sql: 'UPDATE totals SET a = 1 WHERE total > 5', rule: 'computed' },
    { name: 'a credential-shaped literal', tables: writeOn('transactions'), sql: `UPDATE transactions SET category = '${SECRET}' WHERE id = 1`, rule: 'value' },
    { name: 'a credential-shaped bound value', tables: writeOn('transactions'), sql: 'UPDATE transactions SET category = ? WHERE id = 1', params: [SECRET], rule: 'value' },
    { name: '201 rows', tables: writeOn('accounts'), sql: 'UPDATE accounts SET balance = 0 WHERE balance >= 0', rule: 'too-many' },
    { name: 'a table carrying a trigger', tables: writeOn('audited'), sql: "UPDATE audited SET v = 'b' WHERE id = 1", rule: 'table' },
    { name: 'a DELETE on a partly shared table (a credential-named column is never granted)', tables: writeOn('transactions'), sql: 'DELETE FROM transactions WHERE id = 1', rule: 'table' },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name} → ACCESS_WRITE_REFUSED${testCase.rule !== undefined ? ` “${testCase.rule}”` : ' (the statement’s own shape)'} — nothing changes, no line, no entry`, async () => {
      const grant = await writeGrantFor({ tables: testCase.tables });
      const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
      const before = await snapshot();
      const answer = await handler.handle(budget, writeFrame(grant.id, testCase.sql, testCase.params));
      if (testCase.rule !== undefined) {
        expect(answer).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused(testCase.rule), false));
      } else {
        expect(answer).toMatchObject({ ok: false, code: 'ACCESS_WRITE_REFUSED', retryable: false });
        const prefix = writeRefusedPrefix();
        expect(prefix.length).toBeGreaterThan(0);
        expect(answer.ok ? '' : answer.message).toMatch(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
      expect(await snapshot(), 'nothing changed').toBe(before);
      expect(wroteLines(ledger)).toEqual([]);
      expect(undoJournal().listAccessUndo(ledger)).toEqual([]);
    });
  }
});

describe('PR-3 write — busy, attendance, a stop that lands meanwhile, the per-reader cap, the shared minute (D-PR3-11/13/15; §24.5 MUSTs 18, 21)', () => {
  it('the target in the middle of a change (its frame’s BEGIN, the driver’s flag) → ACCESS_BUSY “try again” (retryable): no line, no entry', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    await execOn(ledger, 'BEGIN');
    expect(await handler.handle(budget, writeFrame(grant.id, "UPDATE transactions SET category = 'groceries' WHERE id = 1"))).toEqual(refusal('ACCESS_BUSY', ACCESS_APP_MESSAGES.busy, true));
    expect(wroteLines(ledger)).toEqual([]);
    expect(undoJournal().listAccessUndo(ledger)).toEqual([]);
  });

  it('nobody present → ACCESS_UNATTENDED (retryable) — the hidden frame, and the visible one during a delegated run — even for an access allowed also while I’m away; nothing recorded; after the run the write goes through', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS], duration: 'always', unattended: true });
    const sql = "UPDATE transactions SET category = 'groceries' WHERE id = 1";
    const hidden = createAccessHandlerFor(budget, { attended: false });
    expect(await hidden.handle(budget, writeFrame(grant.id, sql))).toEqual(refusal('ACCESS_UNATTENDED', ACCESS_APP_MESSAGES.unattended, true));
    const visible = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(beginDelegatedRun({ appId: budget, appName: 'Budget', runId: 'run-w', taskId: 't-w', title: 'Morning sums', generation: 0 }).ok).toBe(true);
    try {
      expect(await visible.handle(budget, writeFrame(grant.id, sql))).toEqual(refusal('ACCESS_UNATTENDED', ACCESS_APP_MESSAGES.unattended, true));
    } finally {
      endDelegatedRun(budget, 'run-w');
      clearTouchedGeneration(budget, 0);
    }
    expect(kindsOf(ledger), 'no refused line, no wrote line').toEqual(['granted']);
    expect(await rowsOf(ledger, 'SELECT category FROM transactions WHERE id = 1')).toEqual([['food']]);
    expect(await visible.handle(budget, writeFrame(grant.id, sql))).toEqual({ ok: true, op: 'write', changes: 1 });
  });

  it('revokeAccess while the plan job is in flight wins: ACCESS_REVOKED, the target unchanged, no wrote line, no entry', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS] });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let planJobs = 0;
    configureScopedRead({
      createWorker: () => {
        const respond = createScopedReadResponder();
        const worker: WorkerLike = {
          onmessage: null,
          onerror: null,
          postMessage(msg) {
            void (async () => {
              if (isPlanWriteJob(msg)) {
                planJobs += 1;
                await held;
              }
              const answer = await respond(msg);
              if (answer !== undefined) worker.onmessage?.({ data: answer });
            })();
          },
          terminate() {},
        };
        return worker;
      },
      wasm: { wasmUrl: locateWasm() },
      now: () => clock.now,
    });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const pending = handler.handle(budget, writeFrame(grant.id, "UPDATE transactions SET category = 'groceries' WHERE id = 1"));
    await expect.poll(() => planJobs, { timeout: 3000 }).toBe(1);
    await revokeAccess(grant.id);
    release();
    expect(await pending).toEqual(refusal('ACCESS_REVOKED', ACCESS_APP_MESSAGES.revoked, false));
    expect(await rowsOf(ledger, 'SELECT category FROM transactions WHERE id = 1')).toEqual([['food']]);
    expect(kindsOf(ledger)).toEqual(['revoked', 'granted']);
    expect(undoJournal().listAccessUndo(ledger)).toEqual([]);
  });

  it('the 21st live change of one reader on one target is refused “too many changes are waiting to be undone” — and the first is still undoable; once undone, the next write goes through', async () => {
    expect(ACCESS_UNDO_MAX_ENTRIES).toBe(20);
    const grant = await writeGrantFor({ tables: [WRITE_ACCOUNTS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    for (let i = 0; i < 20; i += 1) {
      expect(await handler.handle(budget, writeFrame(grant.id, `INSERT INTO accounts (name, balance) VALUES ('n${i}', ${i})`)), `write ${i + 1}`).toEqual({ ok: true, op: 'write', changes: 1 });
    }
    expect(await handler.handle(budget, writeFrame(grant.id, "INSERT INTO accounts (name, balance) VALUES ('n20', 20)"))).toEqual(refusal('ACCESS_WRITE_REFUSED', ACCESS_APP_MESSAGES.writeRefused('waiting'), false));
    expect(await rowsOf(ledger, 'SELECT count(*) FROM accounts')).toEqual([[21]]);
    expect(undoJournal().listAccessUndo(ledger, budget)).toHaveLength(20);

    const first = wroteLines(ledger).at(-1)!; // newest first: the oldest write is last
    expect(undoJournal().listAccessUndo(ledger, budget).map((entry) => entry.id)).toContain(first.undoId);
    const { undoBrokeredWrite } = await writeBroker();
    expect(await undoBrokeredWrite(db, ledger, first.undoId!, { via: 'user' })).toMatchObject({ ok: true });
    expect(await rowsOf(ledger, "SELECT count(*) FROM accounts WHERE name = 'n0'")).toEqual([[0]]);
    expect(await handler.handle(budget, writeFrame(grant.id, "INSERT INTO accounts (name, balance) VALUES ('n20', 20)"))).toEqual({ ok: true, op: 'write', changes: 1 });
  });

  it('a write counts in the per-app minute it shares with reads — every op, refused or not: after 60 ops the 61st write → ACCESS_RATE_LIMITED (retryable); the next minute writes again', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS, READ_ACCOUNTS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const refusedWrite = writeFrame(grant.id, "UPDATE accounts SET balance = 1 WHERE name = 'main'");
    const goodWrite = (n: number) => writeFrame(grant.id, `UPDATE transactions SET amount = ${n} WHERE id = 1`);
    for (let i = 0; i < ACCESS_QUERY_RATE_PER_MINUTE; i += 1) {
      expect(await handler.handle(budget, refusedWrite)).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.writeNotGranted, false));
    }
    expect(await handler.handle(budget, goodWrite(1))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
    expect(await handler.handle(budget, queryFrame(grant.id, 'SELECT 1')), 'the read shares the window').toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
    clock.now += 60_000;
    expect(await handler.handle(budget, goodWrite(2))).toEqual({ ok: true, op: 'write', changes: 1 });
  });

  it('reads and writes fill ONE window: 30 refused reads and 30 refused writes, then the 61st op — a write — is rate-limited', async () => {
    const grant = await writeGrantFor({ tables: [WRITE_TRANSACTIONS, READ_ACCOUNTS] });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    for (let i = 0; i < ACCESS_QUERY_RATE_PER_MINUTE / 2; i += 1) {
      expect(await handler.handle(budget, queryFrame(grant.id, 'DELETE FROM transactions'))).toMatchObject({ ok: false, code: 'ACCESS_QUERY_REFUSED' });
      expect(await handler.handle(budget, writeFrame(grant.id, "UPDATE accounts SET balance = 1 WHERE name = 'main'"))).toMatchObject({ ok: false, code: 'ACCESS_NOT_GRANTED' });
    }
    expect(await handler.handle(budget, writeFrame(grant.id, "UPDATE transactions SET amount = 1 WHERE id = 1"))).toEqual(refusal('ACCESS_RATE_LIMITED', ACCESS_APP_MESSAGES.queryRateLimited, true));
    expect(wroteLines(ledger)).toEqual([]);
  });
});

describe('PR-3 request — the ask may say write (D-PR3-4)', () => {
  it('an ask that carries access: write parks the pending with wantsWrite; one without it does not', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    const asking = handler.handle(budget, askFrame({ access: 'write' } as unknown as Partial<RequestFields>));
    const pending = (await pendingFor(budget)) as PendingAccessRequest & { wantsWrite?: boolean };
    expect(pending.wantsWrite).toBe(true);
    void pending.resolve({ kind: 'not-now' });
    await asking;
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const plain = handler.handle(budget, askFrame());
    const second = (await pendingFor(budget)) as PendingAccessRequest & { wantsWrite?: boolean };
    expect(second.wantsWrite ?? false).toBe(false);
    void second.resolve({ kind: 'not-now' });
    await plain;
  });

  it('a declined READ ask does not decline a later WRITE ask with the same purpose and hints — the access is part of the ask’s meaning', async () => {
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await askAndDecide(handler, askFrame(), () => ({ kind: 'dont-allow' }))).toMatchObject({ ok: false, code: 'ACCESS_DECLINED', retryable: false });
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    expect(await handler.handle(budget, askFrame()), 'the same read ask is declined').toEqual(refusal('ACCESS_DECLINED', ACCESS_APP_MESSAGES.declined, false));
    clock.now += ACCESS_REQUEST_MIN_GAP_MS;
    const writeAsk = handler.handle(budget, askFrame({ access: 'write' } as unknown as Partial<RequestFields>));
    const pending = await pendingFor(budget);
    void pending.resolve({ kind: 'not-now' });
    await writeAsk;
  });
});

describe('PR-3 refresh — the frame’s op reaches the service; the tick decides (D-PR3-13/14/17)', () => {
  it('refresh → the service’s refresh with the frame as caller and the grant id; its three answers pass through verbatim (fresh · recent · failed)', async () => {
    const grant = await grantFor(); // the service is overridden: the handler's mapping is under test, not the tick
    const answers: AccessHandlerResult[] = [
      { ok: true, op: 'refresh', fresh: true } as unknown as AccessHandlerResult,
      { ok: true, op: 'refresh', fresh: false, reason: 'recent' } as unknown as AccessHandlerResult,
      refusal('ACCESS_REFRESH_FAILED', ACCESS_APP_MESSAGES.refreshNoHandler, false),
    ];
    const calls: unknown[] = [];
    let next = 0;
    __setAccessServiceForTests({
      refresh: async (caller: unknown, input: unknown) => {
        calls.push([caller, input]);
        return answers[next++];
      },
    } as unknown as Parameters<typeof __setAccessServiceForTests>[0]);
    try {
      const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
      for (const expected of answers) expect(await handler.handle(budget, refreshFrame(grant.id))).toEqual(expected);
    } finally {
      __setAccessServiceForTests();
    }
    expect(calls).toEqual(Array.from({ length: 3 }, () => [{ kind: 'frame', appId: budget, generation: 0, present: true }, { grantId: grant.id }]));
  });

  it('refresh under an access without *may ask for new data* → ACCESS_NOT_GRANTED “does not allow asking for new data”; nothing run, nothing recorded', async () => {
    const grant = await grantFor();
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, refreshFrame(grant.id))).toEqual(refusal('ACCESS_NOT_GRANTED', ACCESS_APP_MESSAGES.refreshNotGranted, false));
    expect(kindsOf(ledger)).toEqual(['granted']);
  });

  it('with the tick, the real engine meets its first gate in a file whose scheduler never started → ACCESS_REFRESH_FAILED “schedules are off” (not retryable), nothing run, no line', async () => {
    const grant = await writeGrantFor({ tables: [{ name: 'transactions', withheld: [], write: false }], refresh: true });
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, refreshFrame(grant.id))).toEqual(refusal('ACCESS_REFRESH_FAILED', ACCESS_APP_MESSAGES.refreshOff, false));
    expect(kindsOf(ledger)).toEqual(['granted']);
  });
});

describe('PR-3 discover — a class, never a list; nothing recorded; cached per reader for a minute (D-PR3-21; AC23)', () => {
  it('answers several · one · none from the installed sources, and records NOTHING — no history line, no pending, no ask spent (the user’s click that follows parks)', async () => {
    expect(ACCESS_DISCOVER_CACHE_MS).toBe(60_000);
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'several' });
    expect(db.listAccessLog(ledger)).toEqual([]);
    expect(db.listAccessLog(pantry)).toEqual([]);
    expect(pendingAccessStore.get()).toEqual({});
    const ask = handler.handle(budget, askFrame());
    void (await pendingFor(budget)).resolve({ kind: 'not-now' });
    await ask;

    clock.now += 60_000;
    await db.deleteApp(pantry);
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'one' });
    clock.now += 60_000;
    await db.deleteApp(ledger);
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'none' });
  });

  it('a second discover within the minute is answered from the per-reader cache — no gather (describeAppData is not called again); another reader gathers its own; after the minute it gathers again', async () => {
    const gather = vi.spyOn(db, 'describeAppData');
    const handler = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'several' });
    const gathered = gather.mock.calls.length;
    expect(gathered).toBeGreaterThan(0);
    clock.now += 60_000 - 1;
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'several' });
    expect(gather.mock.calls.length, 'served from the cache').toBe(gathered);
    const other = createAccessHandlerFor(pantry, { attended: true, generation: 0 });
    expect(await other.handle(pantry, discoverFrame())).toMatchObject({ ok: true, op: 'discover' });
    expect(gather.mock.calls.length, 'another reader gathers its own').toBeGreaterThan(gathered);
    const afterOther = gather.mock.calls.length;
    clock.now += 1;
    expect(await handler.handle(budget, discoverFrame())).toEqual({ ok: true, op: 'discover', candidates: 'several' });
    expect(gather.mock.calls.length, 'the minute is over').toBeGreaterThan(afterOther);
  });

  it('nobody present → ACCESS_UNATTENDED (the ask’s presence rule): the hidden frame, and the visible one during a delegated run — nothing gathered', async () => {
    const gather = vi.spyOn(db, 'describeAppData');
    const hidden = createAccessHandlerFor(budget, { attended: false });
    expect(await hidden.handle(budget, discoverFrame())).toEqual(refusal('ACCESS_UNATTENDED', ACCESS_APP_MESSAGES.unattended, true));
    const visible = createAccessHandlerFor(budget, { attended: true, generation: 0 });
    expect(beginDelegatedRun({ appId: budget, appName: 'Budget', runId: 'run-d', taskId: 't-d', title: 'Morning sums', generation: 0 }).ok).toBe(true);
    try {
      expect(await visible.handle(budget, discoverFrame())).toEqual(refusal('ACCESS_UNATTENDED', ACCESS_APP_MESSAGES.unattended, true));
    } finally {
      endDelegatedRun(budget, 'run-d');
      clearTouchedGeneration(budget, 0);
    }
    expect(gather).not.toHaveBeenCalled();
  });
});
