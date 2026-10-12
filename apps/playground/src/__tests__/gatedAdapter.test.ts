// gatedAdapter.test.ts — TASK-20261010-host-broker PR-4 (AC29; contract v2 D-PR4-15).
//
// The scheduled agent's AI-call ceiling is the ADAPTER WRAPPER, not a pre-check: the tool loop can
// make up to ten round trips, and every one of them is an AI call the day's ceiling must admit.
// `gatedAdapter(inner, admit)` asks, on EVERY `complete()`, whether one more AI call fits —
//
//   countersSoFar(admit.db, admit.spent?.() ?? {ai:0,net:0}, admit.soFar, admit.now()) + {ai: 1}
//
// against `SCHEDULE_DAILY_CEILINGS` (`protection.ts` `wouldExceedCeiling`: reaching the ceiling
// exactly is allowed, one past it is not). No headroom → `{ok:false, code:'CAPPED'}` and the inner
// adapter is NEVER called — nothing more is sent. Headroom → it delegates and `admit.soFar.ai`
// increments (only then). `soFar` is the step's own tally, SHARED with the fetch tool's net
// counting, which is why it is a mutable object the wrapper writes and the caller reads.
//
// Assumed seam (Q-T-A-2): `gatedAdapter(inner: AgentAdapter, admit: { db, spent?, soFar, now })`,
// `db` the scheduler-state seat (`ctx.db`), `spent` the run's `ctx.spent`, `now` the step's clock.
// The day is the UTC date of `now()` — the injected clock, never the wall clock.
//
// RED until `agent/gatedAdapter.ts` exists (the static import below fails the file).

import type { AdapterRequest, AdapterResult, AgentAdapter } from '@snugprotocol/adapters';
import { SCHEDULE_DAILY_CEILINGS, type SchedulerState } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { gatedAdapter } from '../agent/gatedAdapter.js';
import type { Calls, SchedulerStateSeat } from '../schedule/protection.js';

const NOW = '2026-10-09T15:00:00.000Z';
const TODAY = '2026-10-09';

const REQUEST: AdapterRequest = { system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
const OK: AdapterResult = { ok: true, text: 'fine', toolCalls: [], stopReason: 'end' };

/** An inner adapter that answers `OK` (the same object every time) and records each request. */
function inner(result: AdapterResult = OK): AgentAdapter & { requests: AdapterRequest[] } {
  const requests: AdapterRequest[] = [];
  return {
    requests,
    complete: (request) => {
      requests.push(request);
      return Promise.resolve(result);
    },
  };
}

/** The scheduler-state seat with today's counters at `ai`/`net` (or no row at all). */
function seat(daily?: { date?: string; ai: number; net: number }): SchedulerStateSeat {
  const state: SchedulerState | undefined =
    daily === undefined ? undefined : { watermark: NOW, globalPause: false, daily: { date: daily.date ?? TODAY, ai: daily.ai, net: daily.net } };
  return {
    getSchedulerState: () => state,
    setSchedulerState: () => {
      throw new Error('the gate never writes the day — the queue folds it');
    },
  };
}

function admitFor(db: SchedulerStateSeat, extra: { spent?: () => Calls; soFar?: Calls; now?: () => Date } = {}): { db: SchedulerStateSeat; spent?: () => Calls; soFar: Calls; now: () => Date } {
  return {
    db,
    ...(extra.spent !== undefined ? { spent: extra.spent } : {}),
    soFar: extra.soFar ?? { ai: 0, net: 0 },
    now: extra.now ?? (() => new Date(NOW)),
  };
}

describe('gatedAdapter — headroom: it delegates, and only then counts', () => {
  it('under the ceiling the inner adapter answers, the SAME request and the SAME result pass through', async () => {
    const wrapped = inner();
    const admit = admitFor(seat({ ai: 0, net: 0 }));
    const result = await gatedAdapter(wrapped, admit).complete(REQUEST);
    expect(result).toBe(OK);
    expect(wrapped.requests).toEqual([REQUEST]);
    expect(wrapped.requests[0]).toBe(REQUEST);
    expect(admit.soFar).toEqual({ ai: 1, net: 0 });
  });

  it('reaching the ceiling EXACTLY is allowed (99 used today → the 100th call goes)', async () => {
    const wrapped = inner();
    const admit = admitFor(seat({ ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 }));
    const result = await gatedAdapter(wrapped, admit).complete(REQUEST);
    expect(result.ok).toBe(true);
    expect(wrapped.requests).toHaveLength(1);
    expect(admit.soFar.ai).toBe(1);
  });

  it('no scheduler row (the scheduler never booted on this file) counts as a fresh day', async () => {
    const wrapped = inner();
    const admit = admitFor(seat());
    expect((await gatedAdapter(wrapped, admit).complete(REQUEST)).ok).toBe(true);
    expect(wrapped.requests).toHaveLength(1);
  });

  it('the day is the UTC date of the INJECTED clock: yesterday’s full counters do not refuse today', async () => {
    const wrapped = inner();
    const admit = admitFor(seat({ date: '2026-10-08', ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 }));
    expect((await gatedAdapter(wrapped, admit).complete(REQUEST)).ok).toBe(true);
    expect(wrapped.requests).toHaveLength(1);
  });

  it('only the AI ceiling is asked: a day whose NET counter is full still admits an AI call', async () => {
    const wrapped = inner();
    const admit = admitFor(seat({ ai: 0, net: SCHEDULE_DAILY_CEILINGS.net }));
    expect((await gatedAdapter(wrapped, admit).complete(REQUEST)).ok).toBe(true);
    expect(wrapped.requests).toHaveLength(1);
  });

  it('an inner FAILURE that was delegated is still an AI call the step spent (the wire was asked)', async () => {
    const failing = inner({ ok: false, code: 'NETWORK_ERROR', message: 'unreachable', retryable: true });
    const admit = admitFor(seat({ ai: 0, net: 0 }));
    const result = await gatedAdapter(failing, admit).complete(REQUEST);
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR', message: 'unreachable', retryable: true });
    expect(admit.soFar.ai).toBe(1);
  });
});

describe('gatedAdapter — no headroom: CAPPED, and the inner adapter is never called', () => {
  it('a full day answers {ok:false, code:"CAPPED"} without calling the inner adapter; nothing is counted', async () => {
    const wrapped = inner();
    const admit = admitFor(seat({ ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 }));
    const result = await gatedAdapter(wrapped, admit).complete(REQUEST);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('CAPPED');
    expect(result.retryable).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(wrapped.requests).toEqual([]);
    expect(admit.soFar).toEqual({ ai: 0, net: 0 });
  });

  it('the question counts what the run already spent (`spent`) and what this step spent so far (`soFar`)', async () => {
    const wrapped = inner();
    // 97 today + 1 by the steps before this one + 1 by this step's earlier call: one more fits (100), the next does not.
    const admit = admitFor(seat({ ai: 97, net: 0 }), { spent: () => ({ ai: 1, net: 0 }), soFar: { ai: 1, net: 0 } });
    const gated = gatedAdapter(wrapped, admit);
    expect((await gated.complete(REQUEST)).ok).toBe(true);
    expect(admit.soFar.ai).toBe(2);
    const second = await gated.complete(REQUEST);
    expect(second.ok === false && second.code).toBe('CAPPED');
    expect(wrapped.requests).toHaveLength(1);
    expect(admit.soFar.ai).toBe(2);
  });

  it('a counter the caller moves between calls is read fresh — the fetch tool’s net calls and this tally are ONE object', async () => {
    const wrapped = inner();
    const soFar = { ai: 0, net: 0 };
    const admit = admitFor(seat({ ai: SCHEDULE_DAILY_CEILINGS.ai - 2, net: 0 }), { soFar });
    const gated = gatedAdapter(wrapped, admit);
    expect((await gated.complete(REQUEST)).ok).toBe(true);
    // Another seat of the same step spent an AI call meanwhile (by the shared tally): no headroom left.
    soFar.ai += 1;
    const second = await gated.complete(REQUEST);
    expect(second.ok === false && second.code).toBe('CAPPED');
    expect(wrapped.requests).toHaveLength(1);
  });

  it('the run’s `spent` is read at EACH call, never captured once', async () => {
    const wrapped = inner();
    let spentAi = 0;
    const admit = admitFor(seat({ ai: SCHEDULE_DAILY_CEILINGS.ai - 2, net: 0 }), { spent: () => ({ ai: spentAi, net: 0 }) });
    const gated = gatedAdapter(wrapped, admit);
    expect((await gated.complete(REQUEST)).ok).toBe(true);
    spentAi = 1;
    const second = await gated.complete(REQUEST);
    expect(second.ok === false && second.code).toBe('CAPPED');
    expect(wrapped.requests).toHaveLength(1);
  });
});
