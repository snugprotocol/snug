// sharedUpdateDrift.test.ts — a SHARED update of an installed app pauses every schedule naming
// it at another version (TASK-20261009 E8, ADR-0074 §6): the act is `applySharedUpdate`, the
// recipient's one update path; the engine learns of it through the schedule revision.
//
// TASK-20261010-cross-app-access AC21 (ADR-0075 §9, D18): the same update SUSPENDS the access the
// updated app holds as a READER — `suspended / reader-updated`, a line on the source's history —
// through the ONE fan-out (`state/appVersionChanged.ts`); an update that is already current
// suspends nothing.

import { createMemoryBackend, installAppFromBundle, openUserDb, type UserDb } from '@snugprotocol/db';
import type { AppBundle } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectSources } from '../access/consent.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
import { scheduleRevisionStore } from '../platform/signals.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

let db: UserDb;
const entries = new Map<string, { bundleId: string; bundle: AppBundle }>();

vi.mock('../state/userdb.js', () => ({ getUserDb: async () => db }));
vi.mock('../state/appMeta.js', () => ({ refreshAppMeta: async () => undefined }));
vi.mock('../share/sharedInbox.js', () => ({
  getSharedEntry: (id: string) => entries.get(id),
  removeSharedEntry: async () => undefined,
  sharedEntryForLineage: () => undefined,
}));

import { applySharedUpdate } from '../share/installShared.js';

const LINEAGE = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const bundle = (html: string): AppBundle => ({
  format: 'snug-app-bundle/1',
  lineage: LINEAGE,
  sharedAt: '2026-09-05T00:00:00.000Z',
  app: { displayName: 'Pomodoro', usesDb: true },
  html,
  schema: { ddl: ['CREATE TABLE sessions (id INTEGER PRIMARY KEY, minutes INTEGER)'] },
  docs: [{ slug: 'vision', title: 'Vision', content: 'A pomodoro timer.' }],
  connections: [],
});

type TaskRow = Parameters<UserDb['putScheduledTask']>[0];
const DAY = 86_400_000;
const CREATED = '2026-10-01T00:00:00.000Z';
const scheduleNaming = (appId: string, version: number): TaskRow => ({
  id: `names-${version}`,
  title: 'Nightly',
  enabled: true,
  enabledAt: CREATED,
  provenance: 'user',
  steps: [{ kind: 'app-think', appId, prompt: 'sum it', context: { maxRows: 50 } }],
  spec: { kind: 'every', n: 1, unit: 'hours', tz: 'UTC' },
  cron: '0 * * * *',
  missedPolicy: 'ask',
  staleAfterMs: 7 * DAY,
  alert: 'inbox',
  appVersions: { [appId]: version },
  createdAt: CREATED,
  updatedAt: CREATED,
  consecutiveFailures: 0,
  unseenResults: 0,
});

beforeEach(async () => {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
  entries.clear();
  resetAccessSession();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.parse('2026-10-10T09:00:00.000Z') });
});

/** A source app with one table, and a DAY of access from `readerAppId` to it (the user's allow). */
async function readsLedger(readerAppId: string): Promise<{ ledger: string; grant: AnyAccessGrant }> {
  const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER)']);
  const ranked = await collectSources(db, readerAppId);
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger);
  if (source === undefined) throw new Error('the source is not a candidate');
  const grant = await createGrantFromDecision(db, {
    readerAppId,
    source,
    tables: ['transactions'],
    duration: 'day',
    unattended: false,
    purpose: 'to time what I spend',
    provenance: 'app',
    now: Date.parse('2026-10-10T09:00:00.000Z'),
  });
  return { ledger, grant };
}

describe('applySharedUpdate — the app-drift pause (E8)', () => {
  it('a shared update pauses the schedule naming the app at its enable version, bumps the schedule revision once, and leaves one already at the new version alone', async () => {
    const v1 = bundle('<!doctype html><html><body>v1</body></html>');
    const installed = await installAppFromBundle(db, v1, { bundleId: 'b1' });
    const appId = installed.appId;
    db.putScheduledTask(scheduleNaming(appId, 1));
    db.putScheduledTask(scheduleNaming(appId, 2));
    entries.set('b2', { bundleId: 'b2', bundle: bundle('<!doctype html><html><body>v2</body></html>') });
    const before = scheduleRevisionStore.get();
    const result = await applySharedUpdate(appId, 'b2');
    expect(result).toEqual({ version: 2 });
    expect(db.getScheduledTask('names-1')).toMatchObject({ enabled: false, pausedReason: 'app-updated', appVersions: { [appId]: 1 } });
    expect(db.getScheduledTask('names-1')?.updatedAt).not.toBe(CREATED);
    expect(db.getScheduledTask('names-2')).toMatchObject({ enabled: true, updatedAt: CREATED });
    expect(scheduleRevisionStore.get()).toBe(before + 1);
  });

  it('an update that is already current pauses nothing and bumps nothing', async () => {
    const v1 = bundle('<!doctype html><html><body>v1</body></html>');
    const installed = await installAppFromBundle(db, v1, { bundleId: 'b1' });
    db.putScheduledTask(scheduleNaming(installed.appId, 1));
    entries.set('b1', { bundleId: 'b1', bundle: v1 }); // the shelf key is what the update compares against
    const before = scheduleRevisionStore.get();
    const result = await applySharedUpdate(installed.appId, 'b1');
    expect(result).toEqual({ status: 'already-current' });
    expect(db.getScheduledTask('names-1')).toMatchObject({ enabled: true });
    expect(scheduleRevisionStore.get()).toBe(before);
  });
});

describe('applySharedUpdate — the access the updated app reads is suspended (AC21)', () => {
  it('a shared update suspends the reader’s access `reader-updated` and writes the line on the SOURCE’s history (newest first)', async () => {
    const installed = await installAppFromBundle(db, bundle('<!doctype html><html><body>v1</body></html>'), { bundleId: 'b1' });
    const { ledger, grant } = await readsLedger(installed.appId);
    entries.set('b2', { bundleId: 'b2', bundle: bundle('<!doctype html><html><body>v2</body></html>') });
    expect(await applySharedUpdate(installed.appId, 'b2')).toEqual({ version: 2 });
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'suspended', suspendedReason: 'reader-updated' });
    expect(db.listAccessLog(ledger)[0]).toMatchObject({ kind: 'suspended', grantId: grant.id, reason: 'reader-updated' });
  });

  it('an update that is already current suspends nothing', async () => {
    const v1 = bundle('<!doctype html><html><body>v1</body></html>');
    const installed = await installAppFromBundle(db, v1, { bundleId: 'b1' });
    const { ledger, grant } = await readsLedger(installed.appId);
    const lines = db.listAccessLog(ledger).length;
    entries.set('b1', { bundleId: 'b1', bundle: v1 });
    expect(await applySharedUpdate(installed.appId, 'b1')).toEqual({ status: 'already-current' });
    expect(db.getAccessGrant(grant.id)).toMatchObject({ status: 'active' });
    expect(db.listAccessLog(ledger)).toHaveLength(lines);
  });
});
