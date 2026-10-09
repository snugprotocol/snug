// schedulePlan.test.ts — TASK-20261009-scheduling-framework E4/E5 (ADR-0074 §5): the PURE
// reconcile planner. `plan()` takes the tasks, their run rows, the scheduler state and `now`,
// and answers the actions a store must apply — run / pending / skip / supersede / advance —
// and the watermark it may write once every row is written. No I/O, no clock: `now` is a
// value, and the occurrence engine is injectable so a boundary can be placed to the second.
//
// Most rows use the REAL cron (`every 1 hours` in UTC → `0 * * * *`), so the planner is pinned
// against the engine it will run on; the grace / due / stale boundaries use an injected
// `occurrences` so an instant can sit exactly 14:59 or 15:01 minutes old without depending on
// a cadence. Every expected instant is written by hand.
import { describe, expect, it, vi } from 'vitest';

import { RUN_STATUSES, SCHEDULE_GRACE_MS, type ScheduleRun, type ScheduledTask, type SchedulerState } from '@snugprotocol/protocol';

import { occurrencesBetween } from '../schedule/cron.js';
import { collapseMissed, plan, windowStart, type PlanAction, type PlanInput } from '../schedule/plan.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Friday 2026-10-09 12:20Z — the hourly 12:00 occurrence is 20 minutes old (MISSED); at 12:05 it is late. */
const NOW = new Date('2026-10-09T12:20:00.000Z');
const iso = (d: Date | number): string => new Date(d).toISOString();
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const CREATED = '2026-10-01T00:00:00.000Z';

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'hourly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'notify', title: 'hi', body: 'now' }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 7 * DAY,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

const state = (over: Partial<SchedulerState> = {}): SchedulerState => ({
  watermark: '2026-10-09T11:20:00.000Z',
  globalPause: false,
  daily: { date: '2026-10-09', ai: 0, net: 0 },
  ...over,
});

const run = (over: Partial<ScheduleRun> & Pick<ScheduleRun, 'dueAt' | 'status'>): ScheduleRun => ({
  id: `r-${over.dueAt}`,
  taskId: 't1',
  trigger: 'due',
  collapsedCount: 1,
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
  ...over,
});

/** An injected occurrence engine answering fixed instants — for boundaries placed to the second. */
const fixed = (...dates: Date[]): PlanInput['occurrences'] => () => dates;

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  tasks: [task()],
  runsByTask: {},
  state: state(),
  now: NOW,
  ...over,
});

const kinds = (actions: PlanAction[]): string[] => actions.map((a) => a.kind);

describe('plan — the window', () => {
  it('48 missed hourly occurrences collapse to ONE pending with collapsedCount 48, plus one advance', () => {
    const result = plan(input({ state: state({ watermark: '2026-10-07T12:20:00.000Z' }) }));
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 48 },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-09T12:00:00.000Z' },
    ]);
  });

  it('a task created after a 3-day closure has zero actions — its window starts at createdAt, not the watermark', () => {
    const created = iso(ago(15 * MINUTE));
    const result = plan(
      input({
        tasks: [task({ createdAt: created, enabledAt: created })],
        state: state({ watermark: iso(ago(3 * DAY)) }),
      }),
    );
    expect(result.actions).toEqual([]);
  });

  it('the window starts at enabledAt when it is newer than the watermark', () => {
    const result = plan(
      input({
        tasks: [task({ enabledAt: '2026-10-09T10:30:00.000Z' })],
        state: state({ watermark: '2026-10-09T08:20:00.000Z' }),
      }),
    );
    expect(result.actions[0]).toEqual({ kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 2 });
  });

  it('the window starts at startsAt when it is the newest bound', () => {
    const result = plan(
      input({
        tasks: [task({ startsAt: '2026-10-09T10:30:00.000Z' })],
        state: state({ watermark: '2026-10-09T08:20:00.000Z' }),
      }),
    );
    expect(result.actions[0]).toEqual({ kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 2 });
  });

  it('a startsAt in the future plans nothing', () => {
    const result = plan(input({ tasks: [task({ startsAt: iso(NOW.getTime() + HOUR) })] }));
    expect(result.actions).toEqual([]);
  });

  it('a ranThrough newer than the watermark (a synced file) starts the window there — nothing already recorded elsewhere is re-planned', () => {
    const result = plan(
      input({
        tasks: [task({ ranThrough: '2026-10-09T11:00:00.000Z' })],
        state: state({ watermark: '2026-10-09T08:20:00.000Z' }),
      }),
    );
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 1 },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-09T12:00:00.000Z' },
    ]);
  });

  it('asks the occurrence engine for exactly (windowStart, now] with the stride anchor = startsAt ?? createdAt', () => {
    const occurrences = vi.fn<typeof occurrencesBetween>(() => []);
    const t = task({ startsAt: '2026-10-09T10:30:00.000Z' });
    plan(input({ tasks: [t], state: state({ watermark: '2026-10-09T08:20:00.000Z' }), occurrences }));
    expect(occurrences).toHaveBeenCalledTimes(1);
    const [spec, from, to, opts] = occurrences.mock.calls[0] as Parameters<typeof occurrencesBetween>;
    expect(spec).toBe(t.spec);
    expect(from.toISOString()).toBe('2026-10-09T10:30:00.000Z');
    expect(to).toBe(NOW);
    expect(opts?.anchor?.toISOString()).toBe('2026-10-09T10:30:00.000Z');

    const byCreated = vi.fn<typeof occurrencesBetween>(() => []);
    plan(input({ occurrences: byCreated }));
    expect((byCreated.mock.calls[0] as Parameters<typeof occurrencesBetween>)[3]?.anchor?.toISOString()).toBe(CREATED);
  });
});

describe('plan — who is skipped outright', () => {
  it('a disabled task plans nothing', () => {
    expect(plan(input({ tasks: [task({ enabled: false })], state: state({ watermark: '2026-10-07T12:20:00.000Z' }) })).actions).toEqual([]);
  });

  it.each(['failures', 'ignored', 'app-updated'] as const)('a task paused for %s plans nothing, even when enabled is still true', (pausedReason) => {
    const paused = plan(input({ tasks: [task({ enabled: false, pausedReason })], state: state({ watermark: '2026-10-07T12:20:00.000Z' }) }));
    expect(paused.actions).toEqual([]);
    const inconsistent = plan(input({ tasks: [task({ enabled: true, pausedReason })], state: state({ watermark: '2026-10-07T12:20:00.000Z' }) }));
    expect(inconsistent.actions).toEqual([]);
  });

  it('globalPause plans nothing and leaves the watermark where it was, so held occurrences come back as late or missed when unpaused', () => {
    const paused = state({ watermark: '2026-10-07T12:20:00.000Z', globalPause: true });
    const result = plan(input({ state: paused }));
    expect(result.actions).toEqual([]);
    expect(result.watermark).toBe('2026-10-07T12:20:00.000Z');
  });
});

describe('plan — dedupe against run rows', () => {
  it.each(RUN_STATUSES)('an existing run row for (taskId, dueAt) with status %s suppresses the occurrence; advance still records it', (status) => {
    const due = ago(5 * MINUTE);
    const result = plan(input({ occurrences: fixed(due), runsByTask: { t1: [run({ dueAt: iso(due), status })] } }));
    expect(result.actions).toEqual([{ kind: 'advance', taskId: 't1', ranThrough: iso(due) }]);
  });

  it('dedupe compares instants, not strings — a row written without milliseconds still matches', () => {
    const due = ago(5 * MINUTE);
    const noMillis = iso(due).replace('.000Z', 'Z');
    const result = plan(input({ occurrences: fixed(due), runsByTask: { t1: [run({ dueAt: noMillis, status: 'ok' })] } }));
    expect(kinds(result.actions)).toEqual(['advance']);
  });

  it('a run row for another task never suppresses this one', () => {
    const due = ago(5 * MINUTE);
    const result = plan(input({ occurrences: fixed(due), runsByTask: { other: [run({ taskId: 'other', dueAt: iso(due), status: 'ok' })] } }));
    expect(kinds(result.actions)).toEqual(['run', 'advance']);
  });
});

describe('plan — due, late and the grace boundary', () => {
  it('an occurrence exactly at now (zero age) runs with trigger due', () => {
    const result = plan(input({ occurrences: fixed(NOW) }));
    expect(result.actions[0]).toEqual({ kind: 'run', taskId: 't1', dueAt: iso(NOW), trigger: 'due', collapsedCount: 1 });
  });

  it('an occurrence inside the current minute is still due; one a full minute old is late', () => {
    expect(plan(input({ occurrences: fixed(ago(20_000)) })).actions[0]).toMatchObject({ kind: 'run', trigger: 'due' });
    expect(plan(input({ occurrences: fixed(ago(MINUTE)) })).actions[0]).toMatchObject({ kind: 'run', trigger: 'late' });
  });

  it('14:59 old is late; exactly 15:00 old is late; 15:01 old is missed (asked)', () => {
    expect(plan(input({ occurrences: fixed(ago(SCHEDULE_GRACE_MS - 1_000)) })).actions[0]).toMatchObject({ kind: 'run', trigger: 'late' });
    expect(plan(input({ occurrences: fixed(ago(SCHEDULE_GRACE_MS)) })).actions[0]).toMatchObject({ kind: 'run', trigger: 'late' });
    expect(plan(input({ occurrences: fixed(ago(SCHEDULE_GRACE_MS + 1_000)) })).actions[0]).toMatchObject({ kind: 'pending', collapsedCount: 1 });
  });

  it('graceMs is injectable — with a 5-minute grace a 10-minute-old occurrence is missed', () => {
    expect(plan(input({ occurrences: fixed(ago(10 * MINUTE)), graceMs: 5 * MINUTE })).actions[0]).toMatchObject({ kind: 'pending' });
  });

  it('several occurrences inside the grace window collapse to ONE late run for the latest, counting the earlier ones', () => {
    const latest = ago(2 * MINUTE);
    const result = plan(input({ occurrences: fixed(ago(12 * MINUTE), ago(7 * MINUTE), latest) }));
    expect(result.actions).toEqual([
      { kind: 'run', taskId: 't1', dueAt: iso(latest), trigger: 'late', collapsedCount: 3 },
      { kind: 'advance', taskId: 't1', ranThrough: iso(latest) },
    ]);
  });

  it('when the latest in the grace window is due, the one run is due and still counts the late ones', () => {
    const result = plan(input({ occurrences: fixed(ago(10 * MINUTE), ago(5 * MINUTE), ago(20_000)) }));
    expect(result.actions[0]).toMatchObject({ kind: 'run', trigger: 'due', collapsedCount: 3 });
  });

  it('a one-off that is merely late runs — only a MISSED one-off is asked', () => {
    const at = ago(5 * MINUTE);
    const once = task({ spec: { kind: 'once', at: iso(at), tz: 'UTC' }, cron: '', missedPolicy: 'run-once' });
    expect(plan(input({ tasks: [once] })).actions[0]).toEqual({ kind: 'run', taskId: 't1', dueAt: iso(at), trigger: 'late', collapsedCount: 1 });
  });

  it('missed and late occurrences in one window yield both: the collapsed candidate and the late run', () => {
    const now = new Date('2026-10-09T12:05:00.000Z');
    const result = plan(input({ now, state: state({ watermark: '2026-10-09T09:30:00.000Z' }) }));
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-09T11:00:00.000Z', collapsedCount: 2 },
      { kind: 'run', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', trigger: 'late', collapsedCount: 1 },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-09T12:00:00.000Z' },
    ]);
  });
});

describe('plan — missed occurrences by policy', () => {
  it('ask → pending with the latest dueAt and the collapsed count', () => {
    const result = plan(input({ tasks: [task({ missedPolicy: 'ask' })], state: state({ watermark: '2026-10-09T09:20:00.000Z' }) }));
    expect(result.actions[0]).toEqual({ kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 3 });
  });

  it('run-once → ONE run with trigger catch-up for the latest, counting the rest', () => {
    const result = plan(input({ tasks: [task({ missedPolicy: 'run-once' })], state: state({ watermark: '2026-10-09T09:20:00.000Z' }) }));
    expect(result.actions[0]).toEqual({ kind: 'run', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', trigger: 'catch-up', collapsedCount: 3 });
  });

  it('skip → skip with reason policy', () => {
    const result = plan(input({ tasks: [task({ missedPolicy: 'skip' })], state: state({ watermark: '2026-10-09T09:20:00.000Z' }) }));
    expect(result.actions[0]).toEqual({ kind: 'skip', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 3, reason: 'policy' });
  });

  it.each(['run-once', 'skip', 'ask'] as const)('a missed one-off is ALWAYS asked — policy %s', (missedPolicy) => {
    const at = ago(30 * MINUTE);
    const once = task({ spec: { kind: 'once', at: iso(at), tz: 'UTC' }, cron: '', missedPolicy });
    expect(plan(input({ tasks: [once] })).actions[0]).toEqual({ kind: 'pending', taskId: 't1', dueAt: iso(at), collapsedCount: 1 });
  });

  it('a candidate older than staleAfterMs is skipped as stale — no card, whatever the policy', () => {
    const latest = ago(2 * HOUR);
    for (const missedPolicy of ['ask', 'run-once', 'skip'] as const) {
      const result = plan(input({ tasks: [task({ missedPolicy, staleAfterMs: HOUR })], occurrences: fixed(ago(3 * HOUR), latest) }));
      expect(result.actions[0]).toEqual({ kind: 'skip', taskId: 't1', dueAt: iso(latest), collapsedCount: 2, reason: 'stale' });
    }
  });

  it('staleness is strict: a candidate exactly staleAfterMs old is still fresh', () => {
    const result = plan(input({ tasks: [task({ staleAfterMs: HOUR })], occurrences: fixed(ago(HOUR)) }));
    expect(result.actions[0]).toMatchObject({ kind: 'pending' });
  });

  it('a stale one-off is skipped, not asked', () => {
    const at = ago(2 * DAY);
    const once = task({ spec: { kind: 'once', at: iso(at), tz: 'UTC' }, cron: '', staleAfterMs: DAY });
    expect(plan(input({ tasks: [once], state: state({ watermark: CREATED }) })).actions[0]).toMatchObject({ kind: 'skip', reason: 'stale' });
  });
});

describe('plan — supersede', () => {
  it('a newer missed candidate supersedes an earlier pending row: the new pending counts it and the old one is named for deletion', () => {
    const result = plan(
      input({
        state: state({ watermark: '2026-10-09T10:20:00.000Z' }),
        runsByTask: { t1: [run({ dueAt: '2026-10-09T11:00:00.000Z', status: 'pending', trigger: 'catch-up', collapsedCount: 3 })] },
      }),
    );
    expect(result.actions).toEqual([
      { kind: 'supersede', taskId: 't1', dueAt: '2026-10-09T11:00:00.000Z' },
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 4 },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-09T12:00:00.000Z' },
    ]);
  });

  it('a stale candidate also supersedes the earlier pending — it is older still — and the skip carries both counts', () => {
    const old = ago(5 * HOUR);
    const latest = ago(3 * HOUR);
    const result = plan(
      input({
        tasks: [task({ staleAfterMs: HOUR })],
        occurrences: fixed(latest),
        runsByTask: { t1: [run({ dueAt: iso(old), status: 'pending', trigger: 'catch-up', collapsedCount: 3 })] },
      }),
    );
    expect(result.actions).toEqual([
      { kind: 'supersede', taskId: 't1', dueAt: iso(old) },
      { kind: 'skip', taskId: 't1', dueAt: iso(latest), collapsedCount: 4, reason: 'stale' },
      { kind: 'advance', taskId: 't1', ranThrough: iso(latest) },
    ]);
  });

  it('a late run does NOT supersede an earlier pending — only a newer missed candidate does', () => {
    const result = plan(
      input({
        occurrences: fixed(ago(5 * MINUTE)),
        runsByTask: { t1: [run({ dueAt: '2026-10-09T11:00:00.000Z', status: 'pending', trigger: 'catch-up' })] },
      }),
    );
    expect(kinds(result.actions)).toEqual(['run', 'advance']);
  });

  it('a non-pending older row is never superseded', () => {
    const result = plan(
      input({
        state: state({ watermark: '2026-10-09T10:20:00.000Z' }),
        runsByTask: { t1: [run({ dueAt: '2026-10-09T11:00:00.000Z', status: 'ok' })] },
      }),
    );
    expect(kinds(result.actions)).toEqual(['pending', 'advance']);
    expect(result.actions[0]).toMatchObject({ collapsedCount: 1 });
  });
});

describe('plan — the end of a schedule', () => {
  it('occurrences past endsAt become ONE skip{ended} for the latest; those before it are planned as usual', () => {
    const result = plan(
      input({
        tasks: [task({ endsAt: '2026-10-09T10:30:00.000Z' })],
        state: state({ watermark: '2026-10-09T08:20:00.000Z' }),
      }),
    );
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-09T10:00:00.000Z', collapsedCount: 2 },
      { kind: 'skip', taskId: 't1', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 2, reason: 'ended' },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-09T12:00:00.000Z' },
    ]);
  });

  it('once ranThrough has passed endsAt the end is on record — nothing more is planned', () => {
    const result = plan(input({ tasks: [task({ endsAt: '2026-10-09T10:30:00.000Z', ranThrough: '2026-10-09T11:00:00.000Z' })] }));
    expect(result.actions).toEqual([]);
  });

  it('a spec until-date is respected by the engine: nothing after the end of that day is planned', () => {
    const until = task({ spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC', until: { kind: 'date', date: '2026-10-08' } } });
    const result = plan(input({ tasks: [until], state: state({ watermark: '2026-10-08T22:20:00.000Z' }) }));
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 't1', dueAt: '2026-10-08T23:00:00.000Z', collapsedCount: 1 },
      { kind: 'advance', taskId: 't1', ranThrough: '2026-10-08T23:00:00.000Z' },
    ]);
  });
});

describe('plan — the watermark and several tasks', () => {
  it('the watermark advances to now, with actions and without', () => {
    expect(plan(input()).watermark).toBe(iso(NOW));
    expect(plan(input({ tasks: [] })).watermark).toBe(iso(NOW));
  });

  it('no occurrence in the window → no advance', () => {
    expect(plan(input({ occurrences: fixed() })).actions).toEqual([]);
  });

  it('tasks are planned independently, in order', () => {
    const late = ago(5 * MINUTE);
    const result = plan(
      input({
        tasks: [task({ id: 'a' }), task({ id: 'b', enabled: false }), task({ id: 'c', spec: { kind: 'once', at: iso(late), tz: 'UTC' }, cron: '' })],
      }),
    );
    expect(result.actions).toEqual([
      { kind: 'pending', taskId: 'a', dueAt: '2026-10-09T12:00:00.000Z', collapsedCount: 1 },
      { kind: 'advance', taskId: 'a', ranThrough: '2026-10-09T12:00:00.000Z' },
      { kind: 'run', taskId: 'c', dueAt: iso(late), trigger: 'late', collapsedCount: 1 },
      { kind: 'advance', taskId: 'c', ranThrough: iso(late) },
    ]);
  });

  it('plan never mutates its input', () => {
    const t = task();
    const s = state({ watermark: '2026-10-07T12:20:00.000Z' });
    const rows = { t1: [run({ dueAt: '2026-10-09T11:00:00.000Z', status: 'pending' })] };
    const before = JSON.stringify({ t, s, rows });
    plan(input({ tasks: [t], state: s, runsByTask: rows }));
    expect(JSON.stringify({ t, s, rows })).toBe(before);
  });
});

describe('collapseMissed / windowStart', () => {
  it('collapseMissed answers undefined for nothing, else the LATEST instant and the count — order of input does not matter', () => {
    expect(collapseMissed([])).toBeUndefined();
    const a = new Date('2026-10-09T10:00:00.000Z');
    const b = new Date('2026-10-09T12:00:00.000Z');
    const c = new Date('2026-10-09T11:00:00.000Z');
    expect(collapseMissed([a, b, c])).toEqual({ dueAt: b, collapsedCount: 3 });
  });

  it.each([
    ['the watermark when nothing on the task is newer', task({ enabledAt: undefined }), '2026-10-09T11:20:00.000Z'],
    ['createdAt when there is no enabledAt and it is newer', task({ enabledAt: undefined, createdAt: '2026-10-09T11:40:00.000Z' }), '2026-10-09T11:40:00.000Z'],
    ['enabledAt over createdAt', task({ createdAt: '2026-10-09T11:40:00.000Z', enabledAt: '2026-10-09T11:50:00.000Z' }), '2026-10-09T11:50:00.000Z'],
    ['startsAt when it is the newest', task({ startsAt: '2026-10-09T12:00:00.000Z' }), '2026-10-09T12:00:00.000Z'],
    ['ranThrough when it is the newest', task({ ranThrough: '2026-10-09T12:10:00.000Z' }), '2026-10-09T12:10:00.000Z'],
  ])('windowStart is the max of the four bounds — %s', (_name, t, expected) => {
    expect(windowStart(t, state()).toISOString()).toBe(expected);
  });
});
