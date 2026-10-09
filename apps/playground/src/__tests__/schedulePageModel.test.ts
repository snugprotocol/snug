// schedulePageModel.test.ts — the engine-owned derivation of `pageModel.ts` (Gate-5 S1): the
// missed card lists candidates of ENABLED schedules only. A `pending` row of a schedule the
// user turned off — or that an untrusted import demoted — is never offered to run.
import { describe, expect, it } from 'vitest';

import type { ScheduleRun, ScheduledTask } from '@snugprotocol/protocol';

import { describeSpec, nextOccurrence } from '../schedule/cron.js';
import { appRunAppOf, formatOccurrence, nextWords, pendingRows } from '../schedule/pageModel.js';
import { formatOccurrence as formatOccurrenceFromPreview } from '../schedule/PreviewAndCost.js';

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

describe('nextWords (M7) — the next occurrence in words, ONE function for the card, the strip and the sheet', () => {
  /** Friday 2026-10-09 12:20Z — a daily 08:00 is tomorrow morning. */
  const NOW = new Date('2026-10-09T12:20:00.000Z');

  it('the next occurrence, formatted in the spec’s zone', () => {
    expect(nextWords({ kind: 'daily', time: '08:00', tz: 'UTC' }, NOW)).toBe('Sat, Oct 10, 8:00 AM UTC');
  });

  it('a one-off whose time has passed has no next, so the spec is described instead', () => {
    const past = { kind: 'once', at: '2026-10-01T09:00:00.000Z', tz: 'UTC' } as const;
    expect(nextWords(past, NOW)).toBe(describeSpec(past));
  });

  it('an anchor (the saved schedule’s createdAt) is passed through: an every-N-days stride without a time keeps the ANCHOR’s wall time', () => {
    const spec = { kind: 'every', n: 1, unit: 'days', tz: 'UTC' } as const;
    const anchor = new Date('2026-10-01T06:30:00.000Z');
    const expected = nextOccurrence(spec, NOW, { anchor });
    expect(expected).toBeDefined();
    expect(nextWords(spec, NOW, anchor)).toBe(formatOccurrence(expected!, 'UTC'));
    expect(nextWords(spec, NOW, anchor)).toBe('Sat, Oct 10, 6:30 AM UTC');
    // Without one, the search anchors at `now` — the stride keeps 12:20.
    expect(nextWords(spec, NOW)).toBe('Sat, Oct 10, 12:20 PM UTC');
  });

  it('formatOccurrence lives with the page’s other clocks; the preview re-exports the same function', () => {
    expect(formatOccurrenceFromPreview).toBe(formatOccurrence);
    expect(formatOccurrence(new Date('2026-10-16T17:00:00.000Z'), 'UTC')).toBe('Fri, Oct 16, 5:00 PM UTC');
  });
});

describe('appRunAppOf (S2) — the app a *run <app>* step runs', () => {
  it('the first run step’s app; undefined for a schedule that runs no app', () => {
    expect(appRunAppOf([{ kind: 'notify', title: 'a', body: 'b' }])).toBeUndefined();
    expect(appRunAppOf([{ kind: 'app-think', appId: 'ledger', prompt: 'p', context: { maxRows: 1 } }])).toBeUndefined();
    expect(
      appRunAppOf([
        { kind: 'app-think', appId: 'ledger', prompt: 'p', context: { maxRows: 1 } },
        { kind: 'app-run', appId: 'weather' },
        { kind: 'app-run', appId: 'other' },
      ]),
    ).toBe('weather');
  });
});
