// scheduleKey.test.ts — TASK-20261009-scheduling-framework A3 (ADR-0074 §3; Gate-5 PR-B M8, S7):
// the kv handshake's names live in ONE module that neither the executor nor the scheduler owns
// (`schedule/scheduleKey.ts`), so `scheduler.ts` reaches the boot sweep's `clearScheduleKey`
// without importing `appRun.ts` (and the page runtime behind it). The sweep clears the key only
// in an app the file HOLDS: an app the task names but the file no longer has — deleted, or a
// task carried in by an import — is never asked, so no namespace is opened for it (S7).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { SCHEDULE_KV_KEY_PREFIX, SCHEDULE_RESULT_EVENT, SCHEDULE_RUN_EVENT, clearScheduleKey, scheduleKvKey } from '../schedule/scheduleKey.js';
import { installTestUserDb } from './userdbTestHelper.js';

let db: UserDb;
let appId: string;

const keyPresent = async (id: string, runId: string): Promise<boolean> => {
  const read = await db.driver.kvGet(id, scheduleKvKey(runId));
  return read.ok && 'value' in read;
};

beforeEach(async () => {
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Weather', html: '<html>v1</html>' }).appId;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the handshake’s names — one home', () => {
  it('the key family, the hint and the answer are the wire names the SDK listens on', () => {
    expect(SCHEDULE_KV_KEY_PREFIX).toBe('snug:schedule:');
    expect(scheduleKvKey('run-1')).toBe('snug:schedule:run-1');
    expect(SCHEDULE_RUN_EVENT).toBe('schedule-run');
    expect(SCHEDULE_RESULT_EVENT).toBe('schedule-result');
  });
});

describe('clearScheduleKey — the boot sweep’s one write', () => {
  it('clears the key in EVERY app an app-run step names, and nothing for a task the file no longer holds', async () => {
    const other = db.installApp({ displayName: 'Ledger', html: '<html>l</html>' }).appId;
    await db.driver.kvSet(appId, scheduleKvKey('r-1'), { runId: 'r-1' });
    await db.driver.kvSet(other, scheduleKvKey('r-1'), { runId: 'r-1' });
    await clearScheduleKey(db, { id: 'r-1' }, { steps: [{ kind: 'app-run', appId }, { kind: 'app-run', appId: other }, { kind: 'notify', title: 't', body: 'b' }] });
    expect(await keyPresent(appId, 'r-1')).toBe(false);
    expect(await keyPresent(other, 'r-1')).toBe(false);
    await expect(clearScheduleKey(db, { id: 'r-1' }, undefined)).resolves.toBeUndefined();
  });

  it('S7: an app the file does NOT hold is never asked — no kvSet, so no namespace is opened for a ghost', async () => {
    const kvSet = vi.spyOn(db.driver, 'kvSet');
    await clearScheduleKey(db, { id: 'r-ghost' }, { steps: [{ kind: 'app-run', appId: 'ghost-app' }, { kind: 'app-run', appId }] });
    expect(kvSet).toHaveBeenCalledTimes(1);
    expect(kvSet).toHaveBeenCalledWith(appId, scheduleKvKey('r-ghost'), null);
    expect(kvSet.mock.calls.some(([namespace]) => namespace === 'ghost-app')).toBe(false);
  });

  it('a deleted app is a ghost too — the C3 cascade removed its row, so its key is not chased', async () => {
    const doomed = db.installApp({ displayName: 'Doomed', html: '<html>d</html>' }).appId;
    await db.deleteApp(doomed);
    const kvSet = vi.spyOn(db.driver, 'kvSet');
    await clearScheduleKey(db, { id: 'r-2' }, { steps: [{ kind: 'app-run', appId: doomed }] });
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('never throws: a driver that answers an error as data, or throws, is swallowed', async () => {
    vi.spyOn(db.driver, 'kvSet').mockRejectedValue(new Error('closed'));
    await expect(clearScheduleKey(db, { id: 'r-3' }, { steps: [{ kind: 'app-run', appId }] })).resolves.toBeUndefined();
  });
});
