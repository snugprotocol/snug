// schedulerKeySweep.test.ts — TASK-20261009-scheduling-framework A3 (ADR-0074 §3; security F8):
// stale `snug:schedule:<runId>` keys are swept at boot. A tab that died mid-run leaves a
// `running` claim and the handshake key it wrote into the app's kv; the boot's stale-claim
// sweep retires the claim AND clears that key, so an app opened later never finds a run that
// nobody is waiting on. A claim still inside its bound belongs to a live sibling tab: its claim
// and its key are left alone. Over the REAL engine (`initScheduler` with the outside seams
// faked, the `scheduler.test.ts` harness) and a real memory-backed user db.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import type { ScheduledTask } from '@snugprotocol/protocol';

import type { SnugPlatform } from '../platform/platform.js';
import { clearScheduleKey, scheduleKvKey } from '../schedule/appRun.js';
import type { StepExecutor } from '../schedule/engine-types.js';
import { __resetSchedulerForTests, initScheduler, type SchedulerDeps } from '../schedule/scheduler.js';
import { installTestUserDb } from './userdbTestHelper.js';

const NOW = Date.parse('2026-10-09T12:05:00.000Z');
const CREATED = '2026-10-01T00:00:00.000Z';
const iso = (ms: number): string => new Date(ms).toISOString();
const WEB: SnugPlatform = { kind: 'web', scheduler: { wakeMode: 'page', hostLabel: 'this tab' }, capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

let db: UserDb;
let appId: string;

const recorder: StepExecutor = async () => ({ status: 'ok', summary: 'done', calls: { ai: 0, net: 0 } });

const deps = (): Partial<SchedulerDeps> => ({
  db: () => Promise.resolve(db),
  execute: recorder,
  locks: undefined,
  ticker: () => ({ start: () => {}, stop: () => {}, nextFireAt: () => undefined }),
  now: () => new Date(NOW),
  platform: () => WEB,
  allows: () => true,
});

function appRunTask(id: string): ScheduledTask {
  return {
    id,
    title: `run weather ${id}`,
    enabled: true,
    enabledAt: CREATED,
    provenance: 'user',
    steps: [{ kind: 'app-run', appId }],
    spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
    cron: '0 * * * *',
    missedPolicy: 'ask',
    staleAfterMs: 3_600_000,
    alert: 'inbox',
    appVersions: { [appId]: 1 },
    createdAt: CREATED,
    updatedAt: CREATED,
    consecutiveFailures: 0,
    unseenResults: 0,
  };
}

/** A `running` claim started `ageMs` ago, with its handshake key written as the executor would have. */
async function claim(taskId: string, runId: string, ageMs: number): Promise<void> {
  db.putScheduleRun({
    id: runId,
    taskId,
    dueAt: iso(NOW - ageMs),
    trigger: 'due',
    collapsedCount: 1,
    status: 'running',
    startedAt: iso(NOW - ageMs),
    host: { kind: 'web' },
    steps: [],
    calls: { ai: 0, net: 0 },
  });
  const wrote = await db.driver.kvSet(appId, scheduleKvKey(runId), { taskId, runId });
  if (!wrote.ok) throw new Error('seed kv failed');
}

const keyPresent = async (runId: string): Promise<boolean> => {
  const read = await db.driver.kvGet(appId, scheduleKvKey(runId));
  return read.ok && 'value' in read;
};

beforeEach(async () => {
  __resetSchedulerForTests();
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Weather', html: '<html>v1</html>' }).appId;
});

afterEach(() => {
  __resetSchedulerForTests();
});

describe('stale handshake keys are swept at boot', () => {
  it('a claim older than its bound is retired AND its key cleared; a claim inside its bound (a live sibling) keeps both', async () => {
    db.putScheduledTask(appRunTask('stale'));
    db.putScheduledTask(appRunTask('fresh'));
    await claim('stale', 'r-stale', 10 * 60_000); // ten minutes: past the 120 s run bound
    await claim('fresh', 'r-fresh', 10_000); // ten seconds: a sibling tab may still be on it
    expect(await keyPresent('r-stale')).toBe(true);

    await initScheduler(deps());

    expect(db.listScheduleRuns('stale')[0]).toMatchObject({ status: 'interrupted', reason: 'stale claim' });
    await vi.waitFor(async () => expect(await keyPresent('r-stale')).toBe(false));
    expect(db.listScheduleRuns('fresh')[0]?.status).toBe('running');
    expect(await keyPresent('r-fresh')).toBe(true);
  });

  it('clearScheduleKey clears the key in EVERY app an app-run step names and nothing for a task the file no longer holds', async () => {
    const other = db.installApp({ displayName: 'Ledger', html: '<html>l</html>' }).appId;
    await db.driver.kvSet(appId, scheduleKvKey('r-1'), { runId: 'r-1' });
    await db.driver.kvSet(other, scheduleKvKey('r-1'), { runId: 'r-1' });
    await clearScheduleKey(db, { id: 'r-1' }, { steps: [{ kind: 'app-run', appId }, { kind: 'app-run', appId: other }, { kind: 'notify', title: 't', body: 'b' }] });
    expect(await keyPresent('r-1')).toBe(false);
    expect((await db.driver.kvGet(other, scheduleKvKey('r-1'))).ok && 'value' in (await db.driver.kvGet(other, scheduleKvKey('r-1')))).toBe(false);
    await expect(clearScheduleKey(db, { id: 'r-1' }, undefined)).resolves.toBeUndefined();
  });
});
