// fetchFirst.test.ts — TASK-20261010-host-broker PR-5 (AC39b; contract v2 D-PR5-18; P1, SC7, F6,
// S14). RED-FIRST: `access/fetchFirst.ts` does not exist yet, nor `service.refreshFor`, nor the
// engine's options form.
//
// WHAT IT IS. The host doors' *fetch new data first* — the chat's toggle and the scheduler's tick —
// in ONE function: `fetchFirst(db, deps, caller: chat | schedule, {signal, run?: {spent, deadline}})
// → {asked: FetchedSource[], calls}`. It lists the caller's ADMITTED grants carrying `refresh` (a
// schedule's attendance needs `unattended`), dedupes by source, caps at REFRESH_FIRST_MAX_SOURCES (2 —
// the rest `skipped`), and runs each SEQUENTIALLY through `service.refreshFor(caller, grantId,
// {deps, signal, run?})` — NEVER `refreshSource` directly (a spy pins it). In-run mode (the
// scheduler's `run`): the ceiling counts `run.spent()` plus the earlier sources' calls, nothing is
// folded into the day, and the calls come back. A door JOINS a refresh already in flight; a joiner's
// stop abandons only its own wait (`stopped`) and leaves the shared run going; the one-instance
// rule (busy) reads `failed`. The words live ONCE in `access/copy.ts` `FETCH_FIRST` (pinned here).
//
// THE SHAPES THIS FILE ASSUMES (v2.1 questions T-D Q4–Q6): `service.refreshFor` answers
// `{outcome: RefreshOutcome, calls}`; `FetchedSource.outcome` maps `fresh: true` → 'fresh',
// `reason: 'recent'` → 'recent', the door's own abort → 'stopped', any refusal or failure (busy
// included) → 'failed', past the cap or past the deadline → 'skipped'; `FETCH_FIRST.recent`/
// `askedRecently` take the time ALREADY WORDED (e.g. '4 min ago').
import { ACCESS_ERROR_CODES, REFRESH_FIRST_MAX_SOURCES, SCHEDULE_DAILY_CEILINGS, accessGrantSchema, type AccessGrant } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ACCESS_APP_MESSAGES, FETCH_FIRST } from '../access/copy.js';
import { fetchFirst } from '../access/fetchFirst.js';
import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import * as refreshModule from '../access/refresh.js';
import { accessService } from '../access/service.js';
import type { SnugPlatform } from '../platform/platform.js';
import * as appRun from '../schedule/appRun.js';
import type { AppRunDeps, HiddenMount } from '../schedule/appRun.js';
import { createStore } from '../state/store.js';
import { installTestUserDb } from './userdbTestHelper.js';

const SEAT: SnugPlatform = {
  kind: 'web',
  scheduler: { wakeMode: 'page', hostLabel: 'this tab' },
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
};

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let notes: string;

interface Calls {
  ai: number;
  net: number;
}
type RefreshOutcome = Awaited<ReturnType<typeof refreshModule.refreshSource>>;
type RefreshForAnswer = { outcome: RefreshOutcome; calls: Calls };

const chat = () => ({ kind: 'chat' as const, appId: budget, threadId: 'thread-1' });
const scheduleCaller = () => ({ kind: 'schedule' as const, appId: budget, taskId: 'task-1', runId: 'run-1' });

function grant(sourceAppId: string, over: Partial<AccessGrant> & { refresh?: boolean } = {}): AccessGrant {
  const at = new Date().toISOString();
  const { refresh = true, ...rest } = over as Partial<AccessGrant> & { refresh?: boolean };
  const row = accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId: budget,
    sourceAppId,
    scope: { tables: [{ name: 'transactions', columns: ['id', 'amount'] }] },
    access: 'read',
    purpose: 'to show spending',
    duration: { kind: 'always' },
    unattended: true,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: at,
    updatedAt: at,
    reads: 0,
    timeouts: 0,
    ...(refresh ? { refresh: true } : {}),
    ...(rest.status === 'revoked' ? { revokedAt: at } : {}),
    ...rest,
  });
  db.putAccessGrant(row);
  return row;
}

function schedulesOn(daily: Partial<Calls> = {}): void {
  const at = new Date().toISOString();
  db.setSchedulerState({ watermark: at, globalPause: false, daily: { date: at.slice(0, 10), ai: daily.ai ?? 0, net: daily.net ?? 0 } });
}

/** Seams the stubbed `refreshFor` never touches — the real-engine rows pass `liveDeps()` instead. */
const inertDeps = (): AppRunDeps => ({ ...appRun.blockedAppRunDeps(), resultTimeoutMs: 90_000 });

/** A composition whose every source is "open": the engine places each on its live frame — `dispatchLive` is spied in those rows. */
function liveDeps(): AppRunDeps {
  return {
    platform: () => SEAT,
    runtimeFor: () => {
      throw new Error('no runtime of ours: the dispatch is spied');
    },
    mounts: createStore<HiddenMount | undefined>(undefined),
    live: {
      has: () => true,
      notify: () => true,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
      awaitReady: () => Promise.resolve(true),
      generation: () => 1,
    },
    announceTimeoutMs: 2_000,
    resultTimeoutMs: 5_000,
  };
}

const FRESH = (calls: Calls = { ai: 0, net: 0 }): RefreshForAnswer => ({ outcome: { ok: true, op: 'refresh', fresh: true }, calls });
const RECENT = (): RefreshForAnswer => ({ outcome: { ok: true, op: 'refresh', fresh: false, reason: 'recent' }, calls: { ai: 0, net: 0 } });
const BUSY = (): RefreshForAnswer => ({ outcome: { ok: false, code: ACCESS_ERROR_CODES.ACCESS_BUSY, message: ACCESS_APP_MESSAGES.busy, retryable: true }, calls: { ai: 0, net: 0 } });
const FAILED = (): RefreshForAnswer => ({
  outcome: { ok: false, code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, message: ACCESS_APP_MESSAGES.refreshFailed('timeout'), retryable: false },
  calls: { ai: 0, net: 1 },
});

type RefreshForFn = (caller: unknown, grantId: string, opts: { deps: AppRunDeps; signal: AbortSignal; run?: unknown }) => Promise<RefreshForAnswer>;

/** The service's host-only verb, stubbed on the ONE facade — so a call that bypassed it is visible. */
function stubRefreshFor(impl: RefreshForFn) {
  const service = accessService() as unknown as { refreshFor: RefreshForFn };
  return vi.spyOn(service, 'refreshFor').mockImplementation(impl);
}

const outcomes = (asked: ReadonlyArray<{ outcome: string }>): string[] => asked.map((entry) => entry.outcome);

beforeEach(async () => {
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.now() });
  budget = db.installApp({ displayName: 'Budget', html: '<html>budget</html>' }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
  notes = db.installApp({ displayName: 'Notes', html: '<html>notes</html>' }).appId;
  refreshModule.__resetRefreshForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  refreshModule.__resetRefreshForTests();
  resetAccessSession();
  __setAccessDepsForTests();
});

describe('D-PR5-18 through the ONE service — never the engine directly (P1, SC7)', () => {
  it('each source is asked through service.refreshFor(caller, grantId, {deps, signal}); refreshSource is NEVER called by fetchFirst itself', async () => {
    const engine = vi.spyOn(refreshModule, 'refreshSource');
    const g = grant(ledger);
    const refreshFor = stubRefreshFor(async () => FRESH({ ai: 1, net: 2 }));
    const deps = inertDeps();
    const signal = new AbortController().signal;
    const result = await fetchFirst(db, deps, chat(), { signal });
    expect(refreshFor).toHaveBeenCalledTimes(1);
    expect(refreshFor).toHaveBeenCalledWith(chat(), g.id, expect.objectContaining({ deps, signal }));
    expect(engine, 'the engine is reached only through the service').not.toHaveBeenCalled();
    expect(result.asked).toEqual([expect.objectContaining({ sourceAppId: ledger, sourceName: 'Ledger', outcome: 'fresh' })]);
    expect(result.calls).toEqual({ ai: 1, net: 2 });
  });

  it('no grant with `refresh` → nothing asked, no calls', async () => {
    grant(ledger, { refresh: false } as never);
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(refreshFor).not.toHaveBeenCalled();
    expect(result).toEqual({ asked: [], calls: { ai: 0, net: 0 } });
  });

  it('only the caller’s ADMITTED grants: a revoked grant and another reader’s grant are never asked', async () => {
    grant(ledger, { status: 'revoked' } as never);
    grant(pantry, { readerAppId: notes } as never);
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(refreshFor).not.toHaveBeenCalled();
    expect(result.asked).toEqual([]);
  });

  it('a SCHEDULE caller needs `unattended`: a grant for when Budget is open only is not asked; one allowed while away is', async () => {
    grant(ledger, { unattended: false });
    const away = grant(pantry, { unattended: true });
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), scheduleCaller(), { signal: new AbortController().signal, run: { spent: () => ({ ai: 0, net: 0 }), deadline: Date.now() + 60_000 } });
    expect(refreshFor).toHaveBeenCalledTimes(1);
    expect(refreshFor.mock.calls[0]![1]).toBe(away.id);
    expect(result.asked.map((entry) => entry.sourceAppId)).toEqual([pantry]);
  });

  it('…while the CHAT caller (someone is there) is asked for both', async () => {
    grant(ledger, { unattended: false });
    grant(pantry, { unattended: true });
    const refreshFor = stubRefreshFor(async () => FRESH());
    await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(refreshFor).toHaveBeenCalledTimes(2);
  });
});

describe('D-PR5-18 dedupe, the cap, sequential', () => {
  it('two grants on the SAME source are ONE ask', async () => {
    grant(ledger);
    grant(ledger, { scope: { tables: [{ name: 'accounts', columns: ['id'] }] } } as never);
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(refreshFor).toHaveBeenCalledTimes(1);
    expect(result.asked).toHaveLength(1);
  });

  it('REFRESH_FIRST_MAX_SOURCES is 2: three sources → two asked, the third `skipped` (never dispatched)', async () => {
    expect(REFRESH_FIRST_MAX_SOURCES).toBe(2);
    grant(ledger);
    grant(pantry);
    grant(notes);
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(refreshFor).toHaveBeenCalledTimes(REFRESH_FIRST_MAX_SOURCES);
    expect(result.asked).toHaveLength(3);
    expect(outcomes(result.asked).filter((outcome) => outcome === 'skipped')).toHaveLength(1);
    expect(outcomes(result.asked).filter((outcome) => outcome === 'fresh')).toHaveLength(2);
  });

  it('SEQUENTIAL: the second source is asked only after the first answered', async () => {
    grant(ledger);
    grant(pantry);
    const releases: Array<() => void> = [];
    const refreshFor = stubRefreshFor(
      () =>
        new Promise<RefreshForAnswer>((resolve) => {
          releases.push(() => resolve(FRESH()));
        }),
    );
    const pending = fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    await vi.waitFor(() => expect(refreshFor).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshFor, 'never two at once').toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.waitFor(() => expect(refreshFor).toHaveBeenCalledTimes(2));
    releases[1]!();
    expect(outcomes((await pending).asked)).toEqual(['fresh', 'fresh']);
  });

  it('the calls are summed across the sources asked', async () => {
    grant(ledger);
    grant(pantry);
    stubRefreshFor(async () => FRESH({ ai: 1, net: 3 }));
    expect((await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal })).calls).toEqual({ ai: 2, net: 6 });
  });
});

describe('D-PR5-18 how each answer reads', () => {
  it('`recent` → recent; a failure → failed (its calls still counted); the one-instance rule (busy) → failed', async () => {
    grant(ledger);
    grant(pantry);
    const answers = [RECENT(), FAILED()];
    stubRefreshFor(async () => answers.shift()!);
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(outcomes(result.asked)).toEqual(['recent', 'failed']);
    expect(result.calls).toEqual({ ai: 0, net: 1 });

    stubRefreshFor(async () => BUSY());
    const busy = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(outcomes(busy.asked)).toEqual(['failed', 'failed']);
  });

  it('a refresh failure never throws out of fetchFirst — a throwing refreshFor reads `failed`', async () => {
    grant(ledger);
    stubRefreshFor(async () => {
      throw new Error('the engine fell over');
    });
    const result = await fetchFirst(db, inertDeps(), chat(), { signal: new AbortController().signal });
    expect(outcomes(result.asked)).toEqual(['failed']);
  });

  it('the door’s own stop: the source being waited on reads `stopped`, and no later source is asked', async () => {
    grant(ledger);
    grant(pantry);
    const stop = new AbortController();
    const refreshFor = stubRefreshFor(
      (_caller, _grantId, opts) =>
        new Promise<RefreshForAnswer>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve({ outcome: { ok: false, code: ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, message: ACCESS_APP_MESSAGES.refreshStopped, retryable: false }, calls: { ai: 0, net: 0 } }), { once: true });
        }),
    );
    const pending = fetchFirst(db, inertDeps(), chat(), { signal: stop.signal });
    await vi.waitFor(() => expect(refreshFor).toHaveBeenCalledTimes(1));
    stop.abort();
    const result = await pending;
    expect(refreshFor, 'nothing asked after the stop').toHaveBeenCalledTimes(1);
    expect(result.asked[0]!.outcome).toBe('stopped');
    expect(outcomes(result.asked).slice(1).every((outcome) => outcome === 'skipped' || outcome === 'stopped')).toBe(true);
  });

  it('in-run mode with NO budget left (the deadline already passed) → every source `skipped`, nothing dispatched', async () => {
    grant(ledger);
    grant(pantry);
    const refreshFor = stubRefreshFor(async () => FRESH());
    const result = await fetchFirst(db, inertDeps(), scheduleCaller(), { signal: new AbortController().signal, run: { spent: () => ({ ai: 0, net: 0 }), deadline: Date.now() - 1 } });
    expect(refreshFor).not.toHaveBeenCalled();
    expect(outcomes(result.asked)).toEqual(['skipped', 'skipped']);
  });
});

describe('D-PR5-18 the real engine behind the service — in-run counting, the join, a joiner’s stop', () => {
  it('IN-RUN: the ceiling counts run.spent() PLUS the earlier sources’ calls — the second source is capped (failed), never dispatched; nothing folded into the day; the calls come back', async () => {
    schedulesOn({ ai: 0, net: 0 });
    grant(ledger);
    grant(pantry);
    const dispatch = vi.spyOn(appRun, 'dispatchLive').mockResolvedValue({ end: { kind: 'result', result: { ok: true } }, calls: { ai: 2, net: 0 }, refused: [] });
    const result = await fetchFirst(db, liveDeps(), scheduleCaller(), {
      signal: new AbortController().signal,
      run: { spent: () => ({ ai: SCHEDULE_DAILY_CEILINGS.ai - 2, net: 0 }), deadline: Date.now() + 60_000 },
    });
    expect(dispatch, 'the first source ran; the second met the ceiling with the first one’s calls counted').toHaveBeenCalledTimes(1);
    expect(outcomes(result.asked).sort()).toEqual(['failed', 'fresh']);
    expect(result.calls).toEqual({ ai: 2, net: 0 });
    expect(db.getSchedulerState()?.daily, 'in-run: no fold').toMatchObject({ ai: 0, net: 0 });
  });

  it('a door JOINS a refresh already in flight; a joiner’s stop reports `stopped` and leaves the shared run going — the other door gets `fresh`, one dispatch', async () => {
    schedulesOn();
    grant(ledger);
    let release: (() => void) | undefined;
    let dispatchSignal: AbortSignal | undefined;
    const dispatch = vi.spyOn(appRun, 'dispatchLive').mockImplementation(
      (d) =>
        new Promise((resolve) => {
          dispatchSignal = d.signal;
          release = () => resolve({ end: { kind: 'result', result: { ok: true } }, calls: { ai: 0, net: 1 }, refused: [] });
        }),
    );
    const deps = liveDeps();
    const stopA = new AbortController();
    const doorA = fetchFirst(db, deps, chat(), { signal: stopA.signal });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const doorB = fetchFirst(db, deps, scheduleCaller(), { signal: new AbortController().signal, run: { spent: () => ({ ai: 0, net: 0 }), deadline: Date.now() + 60_000 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopA.abort();
    expect(outcomes((await doorA).asked)).toEqual(['stopped']);
    expect(dispatchSignal?.aborted, 'B still waits — the shared run is not aborted').toBe(false);
    release!();
    expect(outcomes((await doorB).asked)).toEqual(['fresh']);
    expect(dispatch, 'one dispatch for both doors').toHaveBeenCalledTimes(1);
  });

  it('the engine keeps the last settled outcome: inside the cooldown a later ask reads `recent` with the time of the fetch it used', async () => {
    schedulesOn();
    grant(ledger);
    vi.spyOn(appRun, 'dispatchLive').mockResolvedValue({ end: { kind: 'result', result: { ok: true } }, calls: { ai: 0, net: 0 }, refused: [] });
    expect(outcomes((await fetchFirst(db, liveDeps(), chat(), { signal: new AbortController().signal })).asked)).toEqual(['fresh']);
    const again = await fetchFirst(db, liveDeps(), chat(), { signal: new AbortController().signal });
    expect(again.asked).toEqual([expect.objectContaining({ sourceAppId: ledger, sourceName: 'Ledger', outcome: 'recent' })]);
    expect(again.asked[0]!.at, 'when the fetch it used happened').toBeDefined();
  });

  it('service.refreshFor answers { outcome, calls } — the frame’s `refresh` keeps its wire result (the outcome alone)', async () => {
    schedulesOn();
    const g = grant(ledger);
    vi.spyOn(appRun, 'dispatchLive').mockResolvedValue({ end: { kind: 'result', result: { ok: true } }, calls: { ai: 1, net: 0 }, refused: [] });
    const service = accessService() as unknown as { refreshFor: RefreshForFn };
    const answer = await service.refreshFor(chat(), g.id, { deps: liveDeps(), signal: new AbortController().signal });
    expect(answer).toEqual({ outcome: { ok: true, op: 'refresh', fresh: true }, calls: { ai: 1, net: 0 } });
  });

  it('service.refreshFor runs the policy first: a grant the caller does not own answers not-granted, nothing dispatched', async () => {
    schedulesOn();
    const other = grant(ledger, { readerAppId: notes } as never);
    const dispatch = vi.spyOn(appRun, 'dispatchLive');
    const service = accessService() as unknown as { refreshFor: RefreshForFn };
    const answer = await service.refreshFor(chat(), other.id, { deps: liveDeps(), signal: new AbortController().signal });
    expect(answer.outcome).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED });
    expect(answer.calls).toEqual({ ai: 0, net: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('D-PR5-18 / D-PR5-24 the words — ONE home, `access/copy.ts` FETCH_FIRST (straight apostrophes; *new data*, never *look up*)', () => {
  it('done(source): *fetched new data from Ledger first*', () => {
    expect(FETCH_FIRST.done('Ledger')).toBe('fetched new data from Ledger first');
  });

  it('recent(source, when, ok): *Ledger fetched new data 4 min ago — used that* / *Ledger couldn\'t fetch new data 4 min ago — used what it had*', () => {
    expect(FETCH_FIRST.recent('Ledger', '4 min ago', true)).toBe('Ledger fetched new data 4 min ago — used that');
    expect(FETCH_FIRST.recent('Ledger', '4 min ago', false)).toBe("Ledger couldn't fetch new data 4 min ago — used what it had");
  });

  it('askedRecently(source, when) — no outcome known: *Ledger was asked for new data 4 min ago*', () => {
    expect(FETCH_FIRST.askedRecently('Ledger', '4 min ago')).toBe('Ledger was asked for new data 4 min ago');
  });

  it('failed(source): *Ledger couldn\'t fetch new data — answered from what it had*', () => {
    expect(FETCH_FIRST.failed('Ledger')).toBe("Ledger couldn't fetch new data — answered from what it had");
  });

  it('skipped and stopped exist; every FETCH_FIRST sentence says *new data* or names the source, never *look up*, and keeps straight apostrophes', () => {
    const word = (value: unknown, ...args: unknown[]): string => (typeof value === 'function' ? (value as (...a: unknown[]) => string)(...args) : String(value));
    const sentences = [
      FETCH_FIRST.done('Ledger'),
      FETCH_FIRST.recent('Ledger', '4 min ago', true),
      FETCH_FIRST.recent('Ledger', '4 min ago', false),
      FETCH_FIRST.askedRecently('Ledger', '4 min ago'),
      FETCH_FIRST.failed('Ledger'),
      word(FETCH_FIRST.skipped, 'Ledger'),
      word(FETCH_FIRST.stopped, 'Ledger'),
    ];
    for (const sentence of sentences) {
      expect(typeof sentence).toBe('string');
      expect(sentence.length, sentence).toBeGreaterThan(0);
      expect(sentence, sentence).not.toMatch(/look(ed|ing)?[\s-]?up/i);
      expect(sentence, sentence).not.toContain('’');
      expect(sentence, sentence).not.toMatch(/\b(grant|reader|scope|declaration)\b/i);
    }
    expect(word(FETCH_FIRST.skipped, 'Ledger')).not.toBe(word(FETCH_FIRST.stopped, 'Ledger'));
  });
});
