// appDrift.test.ts — the update-confirm sentence and what it counts (TASK-20261009 E8).
import type { ScheduledTask } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { schedulesNamingApp, updatePausesSentence } from '../schedule/appDrift.js';

const t = (id: string, over: Partial<ScheduledTask>): ScheduledTask =>
  ({ id, title: id, enabled: true, provenance: 'user', steps: [], spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' }, cron: '0 * * * *', missedPolicy: 'ask', staleAfterMs: 3_600_000, alert: 'inbox', appVersions: {}, createdAt: 'x', updatedAt: 'x', consecutiveFailures: 0, unseenResults: 0, ...over }) as ScheduledTask;

describe('schedulesNamingApp', () => {
  it('counts the ENABLED schedules that recorded the app at enable — at any version — and nothing disabled or unrelated', () => {
    const tasks = [
      t('a', { appVersions: { app: 1 } }),
      t('b', { appVersions: { app: 7, other: 2 } }),
      t('c', { appVersions: { other: 2 } }),
      t('d', { appVersions: { app: 1 }, enabled: false, pausedReason: 'app-updated' }),
    ];
    expect(schedulesNamingApp(tasks, 'app').map((x) => x.id)).toEqual(['a', 'b']);
    expect(schedulesNamingApp(tasks, 'nobody')).toEqual([]);
  });
});

describe('updatePausesSentence', () => {
  it('nothing for no schedule; one, two, three and four-plus are each a sentence in the user’s words (never “task”)', () => {
    expect(updatePausesSentence([])).toBeUndefined();
    expect(updatePausesSentence(['Nightly'])).toBe('Updating pauses the schedule that runs this app — “Nightly” — until you turn it back on from the Schedule page.');
    expect(updatePausesSentence(['Nightly', 'Weekly review'])).toBe('Updating pauses 2 schedules that run this app — “Nightly” and “Weekly review” — until you turn them back on from the Schedule page.');
    expect(updatePausesSentence(['A', 'B', 'C'])).toContain('3 schedules that run this app — “A”, “B” and “C” —');
    expect(updatePausesSentence(['A', 'B', 'C', 'D', 'E'])).toContain('5 schedules that run this app — “A”, “B”, “C” and 2 more —');
    for (const s of [updatePausesSentence(['A']), updatePausesSentence(['A', 'B'])]) expect(s).not.toMatch(/\btask\b/i);
  });

  // TASK-20261010-host-broker PR-4 (contract v2 D-PR4-8; v2.1 N5): an update disarms every schedule
  // that makes changes on its own, from ANY source — so when one of the named schedules is armed the
  // sentence says so, the tail *and stops it making changes on its own* before *until you turn it back
  // on…*. The number agrees with the count; unarmed (or the option absent) the sentence is today's.
  it('an ARMED schedule among them adds the tail *and stops it making changes on its own* before *until you turn it back on…*', () => {
    expect(updatePausesSentence(['Nightly'], { armed: true })).toBe(
      'Updating pauses the schedule that runs this app — “Nightly” — and stops it making changes on its own until you turn it back on from the Schedule page.',
    );
    expect(updatePausesSentence(['Nightly', 'Weekly review'], { armed: true })).toBe(
      'Updating pauses 2 schedules that run this app — “Nightly” and “Weekly review” — and stops them making changes on their own until you turn them back on from the Schedule page.',
    );
    expect(updatePausesSentence(['Nightly'], { armed: false })).toBe(updatePausesSentence(['Nightly']));
    expect(updatePausesSentence([], { armed: true })).toBeUndefined();
    for (const s of [updatePausesSentence(['A'], { armed: true }), updatePausesSentence(['A', 'B'], { armed: true })]) expect(s).not.toMatch(/\btask\b/i);
  });
});
