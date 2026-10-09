// scheduleProtection.test.ts — TASK-20261009-scheduling-framework E7/E8 (ADR-0074 §6; Q5): the
// pure self-protection rules. Daily counters keyed on the UTC date, the global ceilings with
// their 80 % warning, the per-run outcome fold (5 consecutive failures → paused `failures`;
// 30 unseen results → paused `ignored`), seen / resume / app-update pause, and app drift.
// Every function answers a NEW value and never touches its input.
import { describe, expect, it } from 'vitest';

import { RUN_STATUSES, SCHEDULE_DAILY_CEILINGS, type RunStatus, type ScheduleRun, type ScheduledTask, type SchedulerState } from '@snugprotocol/protocol';

import { RESULT_STATUSES } from '../schedule/taskShape.js';
import {
  appDrift,
  applyRunOutcome,
  ceilingWarning,
  dailyCounters,
  markSeen,
  pauseForAppUpdate,
  resumeTask,
  wouldExceedCeiling,
} from '../schedule/protection.js';

const CREATED = '2026-10-01T00:00:00.000Z';

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'hourly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 3_600_000,
  alert: 'inbox',
  appVersions: { ledger: 3, notes: 1 },
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

const run = (status: RunStatus): ScheduleRun => ({
  id: 'r1',
  taskId: 't1',
  dueAt: '2026-10-09T12:00:00.000Z',
  trigger: 'due',
  collapsedCount: 1,
  status,
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
});

const state = (daily: SchedulerState['daily']): SchedulerState => ({ watermark: '2026-10-09T12:00:00.000Z', globalPause: false, daily });

describe('dailyCounters — one UTC day', () => {
  it('answers the same counters (same object) while the UTC date has not changed', () => {
    const daily = { date: '2026-10-09', ai: 12, net: 40 };
    expect(dailyCounters(state(daily), '2026-10-09T23:59:59.000Z')).toBe(daily);
  });

  it('resets to zeros on a new UTC date', () => {
    expect(dailyCounters(state({ date: '2026-10-09', ai: 12, net: 40 }), '2026-10-10T00:00:00.000Z')).toEqual({ date: '2026-10-10', ai: 0, net: 0 });
  });

  it('keys on the UTC date, never a device-local one — an offset instant is converted first', () => {
    // 2026-10-09T20:30 at UTC-5 is 2026-10-10T01:30Z: a new UTC day although the local calendar still says the 9th.
    expect(dailyCounters(state({ date: '2026-10-09', ai: 12, net: 40 }), '2026-10-09T20:30:00-05:00')).toEqual({ date: '2026-10-10', ai: 0, net: 0 });
  });

  it('an unreadable instant leaves the counters alone rather than resetting them', () => {
    const daily = { date: '2026-10-09', ai: 12, net: 40 };
    expect(dailyCounters(state(daily), 'not a date')).toBe(daily);
  });
});

describe('wouldExceedCeiling / ceilingWarning', () => {
  it('reaching the ceiling exactly is allowed; one past it names the ceiling', () => {
    expect(wouldExceedCeiling({ date: '2026-10-09', ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 }, { ai: 1 })).toBeUndefined();
    expect(wouldExceedCeiling({ date: '2026-10-09', ai: SCHEDULE_DAILY_CEILINGS.ai, net: 0 }, { ai: 1 })).toBe('ai');
    expect(wouldExceedCeiling({ date: '2026-10-09', ai: 0, net: SCHEDULE_DAILY_CEILINGS.net }, { net: 1 })).toBe('net');
  });

  it('an empty add never exceeds; both over → ai is named first', () => {
    expect(wouldExceedCeiling({ date: '2026-10-09', ai: 0, net: 0 }, {})).toBeUndefined();
    expect(wouldExceedCeiling({ date: '2026-10-09', ai: SCHEDULE_DAILY_CEILINGS.ai, net: SCHEDULE_DAILY_CEILINGS.net }, { ai: 1, net: 1 })).toBe('ai');
  });

  it('ceilingWarning fires at 80 % of either ceiling, ai first', () => {
    expect(ceilingWarning({ date: '2026-10-09', ai: 79, net: 0 })).toBeUndefined();
    expect(ceilingWarning({ date: '2026-10-09', ai: 80, net: 0 })).toBe('ai');
    expect(ceilingWarning({ date: '2026-10-09', ai: 0, net: 399 })).toBeUndefined();
    expect(ceilingWarning({ date: '2026-10-09', ai: 0, net: 400 })).toBe('net');
    expect(ceilingWarning({ date: '2026-10-09', ai: 80, net: 400 })).toBe('ai');
  });
});

describe('applyRunOutcome', () => {
  it('ok resets consecutive failures and adds one unseen result', () => {
    const next = applyRunOutcome(task({ consecutiveFailures: 3, unseenResults: 4 }), run('ok'));
    expect(next).toMatchObject({ consecutiveFailures: 0, unseenResults: 5, enabled: true });
    expect(next.pausedReason).toBeUndefined();
  });

  it.each(['failed', 'no-handler'] as const)('%s adds one consecutive failure AND one unseen result — a failure is a result the user may open (M8)', (status) => {
    expect(applyRunOutcome(task({ consecutiveFailures: 1, unseenResults: 2 }), run(status))).toMatchObject({ consecutiveFailures: 2, unseenResults: 3, enabled: true });
  });

  it('the fifth consecutive failure pauses the task for failures', () => {
    const next = applyRunOutcome(task({ consecutiveFailures: 4 }), run('failed'));
    expect(next).toMatchObject({ consecutiveFailures: 5, pausedReason: 'failures', enabled: false });
    expect(applyRunOutcome(task({ consecutiveFailures: 3 }), run('failed')).enabled).toBe(true);
  });

  it('needs-you adds an unseen result and leaves the failure count alone', () => {
    expect(applyRunOutcome(task({ consecutiveFailures: 2, unseenResults: 0 }), run('needs-you'))).toMatchObject({ consecutiveFailures: 2, unseenResults: 1 });
  });

  it.each(['skipped', 'pending', 'running'] as const)('%s changes no counter', (status) => {
    const before = task({ consecutiveFailures: 2, unseenResults: 7 });
    expect(applyRunOutcome(before, run(status))).toMatchObject({ consecutiveFailures: 2, unseenResults: 7, enabled: true });
  });

  it.each(['interrupted', 'capped'] as const)('%s adds one unseen result and leaves the failure streak alone (M8)', (status) => {
    expect(applyRunOutcome(task({ consecutiveFailures: 2, unseenResults: 7 }), run(status))).toMatchObject({ consecutiveFailures: 2, unseenResults: 8, enabled: true });
  });

  it('the unseen counter moves for EXACTLY the statuses the view counts as results — one set, `RESULT_STATUSES` (M8)', () => {
    for (const status of RUN_STATUSES) {
      expect(applyRunOutcome(task({ unseenResults: 0 }), run(status)).unseenResults, status).toBe(RESULT_STATUSES.has(status) ? 1 : 0);
    }
    expect([...RESULT_STATUSES].sort()).toEqual(['capped', 'failed', 'interrupted', 'needs-you', 'no-handler', 'ok']);
  });

  it('the thirtieth unseen result pauses the task as ignored', () => {
    const next = applyRunOutcome(task({ unseenResults: 29 }), run('ok'));
    expect(next).toMatchObject({ unseenResults: 30, pausedReason: 'ignored', enabled: false });
    expect(applyRunOutcome(task({ unseenResults: 29 }), run('needs-you'))).toMatchObject({ pausedReason: 'ignored', enabled: false });
    expect(applyRunOutcome(task({ unseenResults: 28 }), run('ok')).enabled).toBe(true);
  });

  it('an already-paused task keeps its first reason', () => {
    const next = applyRunOutcome(task({ enabled: false, pausedReason: 'app-updated', unseenResults: 29 }), run('ok'));
    expect(next).toMatchObject({ pausedReason: 'app-updated', enabled: false, unseenResults: 30 });
  });

  it.each(RUN_STATUSES)('answers a NEW object for status %s and never mutates the input', (status) => {
    const before = task({ consecutiveFailures: 4, unseenResults: 29 });
    const snapshot = JSON.stringify(before);
    const next = applyRunOutcome(before, run(status));
    expect(next).not.toBe(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('markSeen / resumeTask / pauseForAppUpdate / appDrift', () => {
  it('markSeen decrements by n (default 1) and never goes below zero', () => {
    expect(markSeen(task({ unseenResults: 3 })).unseenResults).toBe(2);
    expect(markSeen(task({ unseenResults: 3 }), 2).unseenResults).toBe(1);
    expect(markSeen(task({ unseenResults: 1 }), 5).unseenResults).toBe(0);
  });

  it('resumeTask clears the pause, re-enables with enabledAt = now and zeroes both counters', () => {
    const paused = task({ enabled: false, pausedReason: 'failures', consecutiveFailures: 5, unseenResults: 12 });
    const next = resumeTask(paused, '2026-10-09T13:00:00.000Z');
    expect(next).toMatchObject({ enabled: true, enabledAt: '2026-10-09T13:00:00.000Z', consecutiveFailures: 0, unseenResults: 0 });
    expect('pausedReason' in next).toBe(false);
    expect(paused.pausedReason).toBe('failures');
  });

  it('resumeTask records fresh appVersions when the card that re-enables carries them (the app-updated case)', () => {
    const next = resumeTask(task({ enabled: false, pausedReason: 'app-updated' }), '2026-10-09T13:00:00.000Z', { ledger: 4, notes: 1 });
    expect(next.appVersions).toEqual({ ledger: 4, notes: 1 });
    expect(resumeTask(task(), '2026-10-09T13:00:00.000Z').appVersions).toEqual({ ledger: 3, notes: 1 });
  });

  it('pauseForAppUpdate pauses a task that names the app at another version and keeps appVersions as recorded, so the card can name the change', () => {
    const next = pauseForAppUpdate(task(), 'ledger', 4);
    expect(next).toMatchObject({ enabled: false, pausedReason: 'app-updated', appVersions: { ledger: 3, notes: 1 } });
  });

  it('pauseForAppUpdate leaves a task alone when the app is not named or the version is unchanged', () => {
    const t = task();
    expect(pauseForAppUpdate(t, 'weather', 2)).toBe(t);
    expect(pauseForAppUpdate(t, 'ledger', 3)).toBe(t);
  });

  it('appDrift names the apps whose current version differs from the one recorded at enable; an app missing from the library is not drift', () => {
    expect(appDrift(task(), { ledger: 3, notes: 1 })).toEqual([]);
    expect(appDrift(task(), { ledger: 4, notes: 1 })).toEqual(['ledger']);
    expect(appDrift(task(), { ledger: 4, notes: 2, weather: 9 })).toEqual(['ledger', 'notes']);
    expect(appDrift(task(), { notes: 1 })).toEqual([]);
  });
});
