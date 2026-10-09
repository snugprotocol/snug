// schedulePageModel.test.ts — the engine-owned derivation of `pageModel.ts` (Gate-5 S1): the
// missed card lists candidates of ENABLED schedules only. A `pending` row of a schedule the
// user turned off — or that an untrusted import demoted — is never offered to run.
import { describe, expect, it } from 'vitest';

import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { pendingRows } from '../schedule/pageModel.js';

const CREATED = '2026-10-01T00:00:00.000Z';

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: 't1',
  title: 'Hourly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'notify', title: 'Water', body: 'the ferns' }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 3_600_000,
  alert: 'inbox',
  appVersions: {},
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
  ...over,
});

const pending = (taskId: string, dueAt: string): ScheduleRun => ({
  id: `${taskId}-${dueAt}`,
  taskId,
  dueAt,
  trigger: 'catch-up',
  collapsedCount: 1,
  status: 'pending',
  host: { kind: 'web' },
  steps: [],
  calls: { ai: 0, net: 0 },
});

describe('pendingRows', () => {
  it('lists the pending rows of ENABLED schedules only, oldest due first; a disabled, paused or imported-disabled schedule’s candidates are not offered', () => {
    const tasks = [
      task({ id: 'on' }),
      task({ id: 'off', enabled: false }),
      task({ id: 'paused', enabled: false, pausedReason: 'failures' }),
      task({ id: 'imported', enabled: false, provenance: 'imported' }),
    ];
    const runsByTask: Record<string, ScheduleRun[]> = {
      on: [pending('on', '2026-10-09T11:00:00.000Z'), pending('on', '2026-10-09T09:00:00.000Z'), { ...pending('on', '2026-10-09T10:00:00.000Z'), status: 'ok' }],
      off: [pending('off', '2026-10-09T08:00:00.000Z')],
      paused: [pending('paused', '2026-10-09T08:30:00.000Z')],
      imported: [pending('imported', '2026-10-09T07:00:00.000Z')],
      gone: [pending('gone', '2026-10-09T06:00:00.000Z')],
    };
    const rows = pendingRows(tasks, runsByTask);
    expect(rows.map((row) => [row.item.id, row.run.dueAt])).toEqual([
      ['on', '2026-10-09T09:00:00.000Z'],
      ['on', '2026-10-09T11:00:00.000Z'],
    ]);
  });
});
