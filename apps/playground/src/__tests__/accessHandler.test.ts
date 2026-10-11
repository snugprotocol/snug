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
  accessRequestHash,
  type AccessRequestFrame,
} from '@snugprotocol/protocol';

import { createAccessHandlerFor } from '../access/accessHandler.js';
import { NO_ACCESS_ASKS_KEY, pendingAccessStore, type ConsentDecision, type PendingAccessRequest } from '../access/consent.js';
import { startUserAsk } from '../access/userAsk.js';
import { ACCESS_APP_MESSAGES, ACCESS_SHEET } from '../access/copy.js';
import { __setAccessDepsForTests, accessRevisionStore, createGrantFromDecision, grantsForApp, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
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
