// scheduleFloors.test.ts — TASK-20261009-scheduling-framework (ADR-0074 §5, §6; Q12; security
// F6): the pure cost rules the editor and the consent surface read. The smallest gap between
// two occurrences, the frequency floor per provenance (5 min for the user's own, 15 min for
// anything proposed), the refusal sentence, the freshness window (one period, clamped to a
// minute … seven days; a one-off keeps a day), the cost-derived catch-up default, and the
// weekly call estimate behind the cost line. Everything is computed in UTC from one anchor
// (Friday 2026-10-09 12:20Z) so no test depends on the machine's zone or DST.
import { describe, expect, it } from 'vitest';

import {
  APP_AGENT_MAX_ROUND_TRIPS,
  APP_AGENT_MAX_TOOL_CALLS,
  SCHEDULE_DAILY_CEILINGS,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_STALE_AFTER_MS,
  TASK_PROVENANCES,
  type ScheduleSpec,
  type ScheduleStep,
} from '@snugprotocol/protocol';

import {
  defaultMissedPolicy,
  estimatedCallsPerWeek,
  frequencyFloorMs,
  frequencyFloorRefusal,
  freshnessWindowMs,
  minIntervalMs,
} from '../schedule/floors.js';
import { dailyAiBound } from '../schedule/editorModel.js';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const ANCHOR = new Date('2026-10-09T12:20:00.000Z');

const every = (n: number, unit: 'minutes' | 'hours' | 'days', until?: ScheduleSpec['until']): ScheduleSpec =>
  until ? { kind: 'every', n, unit, tz: 'UTC', until } : { kind: 'every', n, unit, tz: 'UTC' };
const daily = (time = '08:00', until?: ScheduleSpec['until']): ScheduleSpec => (until ? { kind: 'daily', time, tz: 'UTC', until } : { kind: 'daily', time, tz: 'UTC' });
const custom = (cron: string): ScheduleSpec => ({ kind: 'custom', cron, tz: 'UTC' });
const once = (at: string): ScheduleSpec => ({ kind: 'once', at, tz: 'UTC' });

const NOTIFY: ScheduleStep = { kind: 'notify', title: 'hi', body: 'now' };
const THINK: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } };
const RUN: ScheduleStep = { kind: 'app-run', appId: 'ledger' };

describe('minIntervalMs — the smallest gap between consecutive occurrences', () => {
  it.each<[string, ScheduleSpec, number | undefined]>([
    ['every 5 minutes', every(5, 'minutes'), 5 * MINUTE],
    ['every 2 hours', every(2, 'hours'), 2 * HOUR],
    ['every 3 days', every(3, 'days'), 3 * DAY],
    ['daily', daily(), DAY],
    ['weekly Mon+Fri → the Fri→Mon gap of 3 days', { kind: 'weekly', days: ['mon', 'fri'], time: '08:00', tz: 'UTC' }, 3 * DAY],
    ['weekly Mon only → 7 days', { kind: 'weekly', days: ['mon'], time: '08:00', tz: 'UTC' }, 7 * DAY],
    ['monthly on the 1st → the shortest month seen, 28 days', { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: 'UTC' }, 28 * DAY],
    ['custom */10 minutes', custom('*/10 * * * *'), 10 * MINUTE],
    ['custom weekdays at 8 → 1 day', custom('0 8 * * 1-5'), DAY],
    ['a one-off has no gap', once('2026-10-10T08:00:00.000Z'), undefined],
    ['a spec that never fires has no gap', custom('0 0 31 2 *'), undefined],
  ])('%s', (_name, spec, expected) => {
    expect(minIntervalMs(spec, ANCHOR)).toBe(expected);
  });

  it('a custom cron is measured from its fields, not nine samples (S6): a minute list dense at the hour’s end, and a wrap across midnight', () => {
    const dodge = custom('0,5,10,15,20,25,30,35,40,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59 * * * *'); // 24 an hour, 1-minute gaps at the end
    expect(minIntervalMs(dodge, ANCHOR)).toBe(MINUTE);
    expect(frequencyFloorRefusal(dodge, 'user', ANCHOR)).toContain('every 1 minute');
    expect(minIntervalMs(custom('0,59 0,23 * * *'), ANCHOR)).toBe(MINUTE); // 23:59 → 00:00 the next day
    expect(minIntervalMs(custom('30 9 * * 1'), ANCHOR)).toBe(7 * DAY);
    expect(minIntervalMs(custom('0 9 1,2 * *'), ANCHOR)).toBe(DAY);
    expect(minIntervalMs(custom('45 8 * * *'), ANCHOR)).toBe(DAY);
    expect(minIntervalMs(custom('0 8,20 * * *'), ANCHOR)).toBe(12 * HOUR);
    expect(minIntervalMs(custom('0 9 1 1,12 *'), ANCHOR)).toBe(31 * DAY); // Dec 1 → Jan 1
  });

  it('samples without the until — a schedule limited to one run still has its period', () => {
    expect(minIntervalMs(daily('08:00', { kind: 'count', count: 1 }), ANCHOR)).toBe(DAY);
    expect(minIntervalMs(daily('08:00', { kind: 'date', date: '2026-10-09' }), ANCHOR)).toBe(DAY);
  });
});

describe('frequencyFloorMs / frequencyFloorRefusal', () => {
  it('the user may run every 5 minutes; every other provenance every 15', () => {
    expect(frequencyFloorMs('user')).toBe(SCHEDULE_MIN_INTERVAL_MS.user);
    for (const provenance of TASK_PROVENANCES) {
      if (provenance !== 'user') expect(frequencyFloorMs(provenance)).toBe(SCHEDULE_MIN_INTERVAL_MS.other);
    }
  });

  it('refuses below the floor with a sentence that names the floor in minutes; nothing at or above it', () => {
    const user = frequencyFloorRefusal(every(4, 'minutes'), 'user', ANCHOR);
    expect(user).toBeDefined();
    expect(user).toContain('5 minutes');
    expect(frequencyFloorRefusal(every(5, 'minutes'), 'user', ANCHOR)).toBeUndefined();

    const app = frequencyFloorRefusal(every(10, 'minutes'), 'app', ANCHOR);
    expect(app).toBeDefined();
    expect(app).toContain('15 minutes');
    expect(frequencyFloorRefusal(every(15, 'minutes'), 'app', ANCHOR)).toBeUndefined();
    expect(frequencyFloorRefusal(custom('*/5 * * * *'), 'builder', ANCHOR)).toContain('15 minutes');
  });

  it('a one-off, a daily and a never-firing spec are never refused', () => {
    expect(frequencyFloorRefusal(once('2026-10-10T08:00:00.000Z'), 'app', ANCHOR)).toBeUndefined();
    expect(frequencyFloorRefusal(daily(), 'app', ANCHOR)).toBeUndefined();
    expect(frequencyFloorRefusal(custom('0 0 31 2 *'), 'app', ANCHOR)).toBeUndefined();
  });

  it('the refusal names how often it would run, in the copy voice (lowercase lead, no internal words)', () => {
    const text = frequencyFloorRefusal(every(2, 'minutes'), 'user', ANCHOR) ?? '';
    expect(text).toContain('every 2 minutes');
    expect(text).toMatch(/^[a-z]/);
    expect(text).not.toMatch(/\b(task|proposal)s?\b/i);
  });
});

describe('freshnessWindowMs — one period, clamped', () => {
  it.each<[string, ScheduleSpec, number]>([
    ['a one-off keeps a day', once('2026-10-10T08:00:00.000Z'), DAY],
    ['every minute → the one-minute floor', every(1, 'minutes'), SCHEDULE_STALE_AFTER_MS.min],
    ['hourly → one hour', every(1, 'hours'), HOUR],
    ['daily → one day', daily(), DAY],
    ['every 7 days → seven days', every(7, 'days'), SCHEDULE_STALE_AFTER_MS.max],
    ['every 10 days → clamped to seven', every(10, 'days'), SCHEDULE_STALE_AFTER_MS.max],
    ['monthly → clamped to seven', { kind: 'monthly', on: { kind: 'day', day: 1 }, time: '09:00', tz: 'UTC' }, SCHEDULE_STALE_AFTER_MS.max],
    ['a spec with no measurable period → seven', custom('0 0 31 2 *'), SCHEDULE_STALE_AFTER_MS.max],
  ])('%s', (_name, spec, expected) => {
    expect(freshnessWindowMs(spec, ANCHOR)).toBe(expected);
  });
});

describe('defaultMissedPolicy — derived from cost', () => {
  it('a reminder-only schedule catches up silently', () => {
    expect(defaultMissedPolicy([NOTIFY])).toBe('run-once');
    expect(defaultMissedPolicy([NOTIFY, NOTIFY])).toBe('run-once');
  });

  it('anything that spends the brain or the network asks', () => {
    expect(defaultMissedPolicy([THINK])).toBe('ask');
    expect(defaultMissedPolicy([NOTIFY, RUN])).toBe('ask');
    expect(defaultMissedPolicy([NOTIFY, THINK, NOTIFY])).toBe('ask');
  });
});

describe('estimatedCallsPerWeek — occurrences in the next 7 days × the steps that spend', () => {
  it.each<[string, ScheduleSpec, ScheduleStep[], { ai: number; net: number }]>([
    ['hourly, one ask-the-AI step', every(1, 'hours'), [THINK], { ai: 168, net: 0 }],
    ['daily, run + think + remind', daily(), [RUN, THINK, NOTIFY], { ai: 7, net: 7 }],
    ['daily, reminders only', daily(), [NOTIFY], { ai: 0, net: 0 }],
    ['every 5 minutes, two thinks', every(5, 'minutes'), [THINK, THINK], { ai: 4032, net: 0 }],
    ['a one-off inside the week', once('2026-10-09T13:20:00.000Z'), [THINK], { ai: 1, net: 0 }],
    ['a one-off beyond the week', once('2026-10-20T13:20:00.000Z'), [THINK], { ai: 0, net: 0 }],
    ['weekly on Monday', { kind: 'weekly', days: ['mon'], time: '08:00', tz: 'UTC' }, [THINK], { ai: 1, net: 0 }],
    ['daily for 3 runs — until.count is honoured from the anchor', daily('08:00', { kind: 'count', count: 3 }), [THINK], { ai: 3, net: 0 }],
    ['a spec that never fires', custom('0 0 31 2 *'), [THINK], { ai: 0, net: 0 }],
  ])('%s', (_name, spec, steps, expected) => {
    expect(estimatedCallsPerWeek(spec, steps, ANCHOR)).toEqual(expected);
  });

  it('counts every minute of a per-minute cron (10 080) and answers within a bound', () => {
    estimatedCallsPerWeek(custom('* * * * *'), [THINK], ANCHOR); // warm the zone formatter
    const started = performance.now();
    const got = estimatedCallsPerWeek(custom('* * * * *'), [THINK], ANCHOR);
    const elapsed = performance.now() - started;
    expect(got).toEqual({ ai: 10_080, net: 0 });
    expect(elapsed).toBeLessThan(1_500);
  });
});

// TASK-20261010-host-broker PR-4 (D-PR4-20; F15, D12): an *Ask <App>'s AI* step that may look things
// up costs what its bounds allow — APP_AGENT_MAX_ROUND_TRIPS AI calls and APP_AGENT_MAX_TOOL_CALLS
// look-ups a time ({ai: 10, net: 8}) — in STEP_COST, so the weekly estimate, the daily bound and the
// catch-up default all read the same number. A tool-free ask step still costs one AI call.
describe('PR-4 — a tools step costs {ai: 10, net: 8} (STEP_COST, the weekly estimate, the daily bound)', () => {
  const TOOLS: ScheduleStep = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 }, tools: true };

  it('the bounds are the protocol’s constants: 10 round trips, 8 tool calls', () => {
    expect(APP_AGENT_MAX_ROUND_TRIPS).toBe(10);
    expect(APP_AGENT_MAX_TOOL_CALLS).toBe(8);
  });

  it.each<[string, ScheduleSpec, ScheduleStep[], { ai: number; net: number }]>([
    ['daily, one tools step', daily(), [TOOLS], { ai: 70, net: 56 }],
    ['hourly, one tools step', every(1, 'hours'), [TOOLS], { ai: 1680, net: 1344 }],
    ['weekly on Monday, a tools step beside a tool-free one and a run', { kind: 'weekly', days: ['mon'], time: '08:00', tz: 'UTC' }, [TOOLS, THINK, RUN], { ai: 11, net: 9 }],
    ['a one-off inside the week', once('2026-10-09T13:20:00.000Z'), [TOOLS], { ai: 10, net: 8 }],
    ['a tools step beside a reminder', daily(), [NOTIFY, TOOLS], { ai: 70, net: 56 }],
  ])('estimatedCallsPerWeek: %s', (_name, spec, steps, expected) => {
    expect(estimatedCallsPerWeek(spec, steps, ANCHOR)).toEqual(expected);
  });

  it('the tool-free ask step is unchanged — one AI call, no network (negative twin)', () => {
    expect(estimatedCallsPerWeek(daily(), [THINK], ANCHOR)).toEqual({ ai: 7, net: 0 });
  });

  it('dailyAiBound: the busiest day × 10 for a tools step, capped at the ceiling (the consent’s *up to N AI calls a day*)', () => {
    expect(dailyAiBound(daily(), [TOOLS], ANCHOR)).toBe(10);
    expect(dailyAiBound(daily(), [TOOLS, THINK], ANCHOR)).toBe(11);
    expect(dailyAiBound(every(2, 'hours'), [TOOLS], ANCHOR)).toBe(SCHEDULE_DAILY_CEILINGS.ai);
    expect(dailyAiBound(every(12, 'hours'), [TOOLS], ANCHOR)).toBe(20);
    expect(dailyAiBound(daily(), [THINK], ANCHOR), 'the tool-free step is still one').toBe(1);
  });

  it('a tools step spends, so the catch-up default asks', () => {
    expect(defaultMissedPolicy([TOOLS])).toBe('ask');
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-5 (AC39b; contract v2 D-PR5-19; F10). An *ask* step carrying
// `refreshFirst` may first run up to REFRESH_FIRST_MAX_SOURCES (2) other apps' own fetch — each the
// cost of a *run <app>* step — so it counts that many on top of its own: an honest "up to".
// ---------------------------------------------------------------------------------------------

describe('PR-5 D-PR5-19 — a refreshFirst step costs REFRESH_FIRST_MAX_SOURCES × the app-run step’s cost on top of its own (F10)', () => {
  const FETCH_THINK = { ...THINK, refreshFirst: true } as unknown as ScheduleStep;
  const FETCH_TOOLS = { kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 }, tools: true, refreshFirst: true } as unknown as ScheduleStep;

  it('REFRESH_FIRST_MAX_SOURCES is the protocol’s 2', async () => {
    const protocol = (await import('@snugprotocol/protocol')) as unknown as { REFRESH_FIRST_MAX_SOURCES?: number };
    expect(protocol.REFRESH_FIRST_MAX_SOURCES).toBe(2);
  });

  it('stepCost: the tool-free ask step {1, 0} + 2 × app-run {0, 1} = {ai: 1, net: 2}', async () => {
    const { stepCost } = await import('../schedule/floors.js');
    const run = stepCost(RUN);
    expect(stepCost(FETCH_THINK)).toEqual({ ai: stepCost(THINK).ai + 2 * run.ai, net: stepCost(THINK).net + 2 * run.net });
    expect(stepCost(FETCH_THINK)).toEqual({ ai: 1, net: 2 });
  });

  it('stepCost: the tools step {10, 8} + 2 × app-run = {ai: 10, net: 10}', async () => {
    const { stepCost } = await import('../schedule/floors.js');
    expect(stepCost(FETCH_TOOLS)).toEqual({ ai: APP_AGENT_MAX_ROUND_TRIPS, net: APP_AGENT_MAX_TOOL_CALLS + 2 });
  });

  it('estimatedCallsPerWeek: daily, one refreshFirst ask step → {ai: 7, net: 14}', () => {
    expect(estimatedCallsPerWeek(daily(), [FETCH_THINK], ANCHOR)).toEqual({ ai: 7, net: 14 });
  });

  it('the fetch is not a look-up: stepsLookUps counts only what the step’s own tools may make', async () => {
    const { stepsLookUps } = await import('../schedule/floors.js');
    expect(stepsLookUps([FETCH_THINK])).toBe(0);
    expect(stepsLookUps([FETCH_TOOLS])).toBe(APP_AGENT_MAX_TOOL_CALLS);
  });

  it('GUARD: the same step without the seat costs what it did (negative twin)', () => {
    expect(estimatedCallsPerWeek(daily(), [THINK], ANCHOR)).toEqual({ ai: 7, net: 0 });
  });

  it('a refreshFirst step spends, so the catch-up default asks', () => {
    expect(defaultMissedPolicy([FETCH_THINK])).toBe('ask');
  });
});
