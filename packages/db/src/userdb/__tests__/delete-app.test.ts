// delete-app.test.ts — cascade delete of an installed app (TASK-20260803-hub-ops,
// AC16-AC21 + AC23).
//
// There are ZERO foreign keys in the user DB and `PRAGMA foreign_keys` is never set,
// so "cascade" here is entirely hand-written: every table that references an app must
// be named explicitly. A missed table is a SILENT orphan, which is why AC18 sweeps all
// of them rather than trusting the implementation's own list.
//
// The delete deliberately IGNORES `pinned` (owner-confirmed): the factory version and
// the bootstrap chat message go too. The existing retention helpers (pruneChatMessages,
// version retention) must NOT be reused — both refuse pinned rows by design.
//
// SCHEDULES (TASK-20261009-scheduling-framework C3, ADR-0074 §2). The scheduler's rows
// live in `snug_settings` too, so the cascade owes them three sweeps, each of which the
// last describe below is the mutation check for — remove one and its row reds:
//   - the task + runs delete for a task whose EVERY step names the app
//       → "a task that only ever named the deleted app vanishes with its runs row";
//   - the `scheduleDeclined:<appId>:` prefix delete → "the app's declines … are gone";
//   - the `scheduleMuted:<appId>` equality delete  → "… and its mute … are gone".
// A multi-app task is deliberately NOT rewritten: the engine derives `appMissing` on a
// step result from the missing app at run time, so the task row stays byte-identical.
//
// ACCESS BETWEEN APPS (TASK-20261010-cross-app-access AC9, ADR-0075 §9). Step 3c''' sweeps
// the access rows inside the same transaction, one sweep per row below — remove one and its
// row reds (each was mutation-checked by hand):
//   - every grant where the app is the READER        → "… every grant where it is the reader …";
//   - every grant where the app is the SOURCE        → "… every grant where it is the source …";
//   - the `accessLog:<appId>` equality delete        → "… its own history row …";
//   - the `accessDeclined:<appId>:` prefix delete    → "… its declines …";
//   - the `accessMuted:<appId>` equality delete      → "… its mute …".
// A sibling app's rows — its grants, its history (even the entries naming the deleted
// reader: the source keeps its history), its declines and its mute — are untouched.

import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  APP_KV_TABLE,
  USERDB_FILE,
  USERDB_TABLES,
  accessGrantSchema,
  accessLogEntrySchema,
  accessRequestHash,
  appDataToken,
  type AccessGrant,
  type AccessLogEntry,
  scheduleRunSchema,
  scheduledTaskSchema,
  type ScheduleRun,
  type ScheduleStep,
  type ScheduledTask,
} from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';
import { execFrame, kvSetFrame } from '../../__tests__/helpers.js';
import {
  accessDeclinedSettingKey,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  scheduleDeclinedSettingKey,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
} from '../app-settings-keys.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

/** Read the user-DB file straight out of the backend and query it independently. */
async function readUserDbTables(): Promise<{ query: (sql: string, params?: unknown[]) => unknown[][] }> {
  await db.flush();
  const bytes = await backend.load(USERDB_FILE);
  if (bytes === undefined) throw new Error('no user db bytes');
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const handle = new SQL.Database(bytes);
  return {
    query: (sql, params) => {
      const stmt = handle.prepare(sql, params as never);
      const rows: unknown[][] = [];
      try {
        while (stmt.step()) rows.push(stmt.get() as unknown[]);
      } finally {
        stmt.free();
      }
      return rows;
    },
  };
}

/**
 * An app with something in EVERY table the cascade must reach: native data tables,
 * a schema, a migration, docs, several versions (incl. the pinned factory), a thread,
 * and chat messages (incl. a pinned bootstrap).
 */
async function seedFullApp(displayName = 'chess', installSource?: string): Promise<string> {
  const app = db.installApp({
    displayName,
    html: '<html>v1</html>',
    ...(installSource !== undefined ? { installSource } : {}),
  });
  const appId = app.appId;

  await db.applyAppDdl(appId, ['CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, result TEXT)']);
  await db.driver.handle(appId, execFrame(`INSERT INTO games (result) VALUES ('win')`));
  await db.driver.handle(appId, kvSetFrame('highScore', 42));
  await db.driver.flush();

  db.saveAppVersion(appId, '<html>v2</html>');
  db.saveAppVersion(appId, '<html>v3</html>');
  db.putAppDoc(appId, 'overview', { title: 'Overview', content: 'how chess works' });
  db.putAppDoc(appId, 'rules', { content: 'en passant is real' });

  const threadId = `app:${appId}`;
  db.upsertThread(threadId, { appId });
  const bootstrap = db.appendChatMessage(threadId, 'user', 'build me chess');
  db.pinChatMessage(bootstrap.id);
  db.appendChatMessage(threadId, 'assistant', 'built it', { pinned: true });
  db.appendChatMessage(threadId, 'user', 'make the board bigger');
  await db.flush();
  return appId;
}

describe('deleteApp — cascade (AC16, AC18)', () => {
  it('removes the app row and every referencing row in one call', async () => {
    const appId = await seedFullApp();
    const token = appDataToken(appId);
    // Precondition: the seed really did populate everything.
    const before = await readUserDbTables();
    expect(before.query(`SELECT 1 FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId])).toHaveLength(1);
    expect(before.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${token}__*'`).length)
      .toBeGreaterThan(0);

    await db.deleteApp(appId);

    expect(db.getApp(appId)).toBeUndefined();
    expect(db.listApps().map((a) => a.appId)).not.toContain(appId);

    const after = await readUserDbTables();
    // AC18: sweep every app_id-bearing table plus the thread_id join — zero orphans.
    for (const table of [
      USERDB_TABLES.apps,
      USERDB_TABLES.appVersions,
      USERDB_TABLES.appSchemas,
      USERDB_TABLES.appMigrations,
      USERDB_TABLES.appDocs,
      USERDB_TABLES.chatThreads,
    ]) {
      expect(after.query(`SELECT * FROM ${table} WHERE app_id = ?`, [appId]), `orphans left in ${table}`).toHaveLength(0);
    }
    expect(
      after.query(
        `SELECT * FROM ${USERDB_TABLES.chatMessages} WHERE thread_id NOT IN (SELECT thread_id FROM ${USERDB_TABLES.chatThreads})`,
      ),
      'orphaned chat messages',
    ).toHaveLength(0);
    // The app's native data tables are gone from the file, not merely emptied.
    expect(
      after.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${token}__*'`),
    ).toHaveLength(0);
  });

  it('removes PINNED rows too — factory version and bootstrap message (AC17)', async () => {
    const appId = await seedFullApp();
    const threadId = `app:${appId}`;
    // Precondition: a pinned version and pinned messages exist.
    expect(db.listAppVersions(appId).some((v) => v.pinned)).toBe(true);
    expect(db.listChatMessages(threadId).some((m) => m.pinned)).toBe(true);

    await db.deleteApp(appId);

    const after = await readUserDbTables();
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.appVersions} WHERE app_id = ?`, [appId])).toHaveLength(0);
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.chatMessages} WHERE thread_id = ?`, [threadId])).toHaveLength(0);
    expect(db.listChatMessages(threadId)).toHaveLength(0);
  });

  it('leaves a second app completely untouched', async () => {
    const keep = await seedFullApp('keeper', 'src-keep');
    const drop = await seedFullApp('goner', 'src-drop');
    const keepToken = appDataToken(keep);

    await db.deleteApp(drop);

    expect(db.getApp(keep)).toBeDefined();
    expect(db.listAppVersions(keep).length).toBeGreaterThan(0);
    expect(db.listAppDocs(keep)).toHaveLength(2);
    expect(db.listChatMessages(`app:${keep}`)).toHaveLength(3);
    expect(db.getAppSchema(keep)).toBeDefined();
    const after = await readUserDbTables();
    expect(
      after.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${keepToken}__*'`).length,
    ).toBeGreaterThan(0);
    // The surviving app's data still reads back through the driver.
    const read = await db.driver.handle(keep, execFrame('SELECT result FROM games'));
    expect(read.ok).toBe(true);
  });

  it('throws NOT_FOUND for an unknown app and leaves the DB alone', async () => {
    const appId = await seedFullApp();
    await expect(db.deleteApp('app-does-not-exist')).rejects.toThrow();
    expect(db.getApp(appId)).toBeDefined();
  });
});

describe('deleteApp — install source reuse (AC19)', () => {
  it('frees the install_source so the same app can be reinstalled', async () => {
    const source = 'https://example.test/chess.html';
    const first = await seedFullApp('chess', source);
    expect(db.getAppByInstallSource(source)?.appId).toBe(first);

    await db.deleteApp(first);
    expect(db.getAppByInstallSource(source)).toBeUndefined();

    // The partial unique index must no longer collide.
    const again = db.installApp({ displayName: 'chess', html: '<html>fresh</html>', installSource: source });
    expect(again.appId).toBeDefined();
    expect(db.getAppByInstallSource(source)?.appId).toBe(again.appId);
  });
});

describe('deleteApp — no resurrection (AC20, AC23)', () => {
  it('stays deleted across a flush cycle (the materializer must not rebuild it)', async () => {
    const appId = await seedFullApp();
    const token = appDataToken(appId);

    // R1 only bites when the namespace is DIRTY at delete time: `persist` skips clean
    // states, so a delete right after a flush would pass even with no cache invalidation
    // and no eviction. Write WITHOUT flushing so a pending write-back is outstanding —
    // that is the state in which writeBack would rebuild the rest tables and resurrect
    // the app.
    await db.driver.handle(appId, execFrame(`INSERT INTO games (result) VALUES ('unflushed')`));

    await db.deleteApp(appId);
    // The exact R1 hazard: writeBack recreates rest tables from a still-open runtime
    // copy, so a flush AFTER the delete could resurrect the app's data tables.
    await db.driver.flush();
    await db.flush();

    const after = await readUserDbTables();
    expect(
      after.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${token}__*'`),
      'app data tables came back after flush',
    ).toHaveLength(0);
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId])).toHaveLength(0);
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.appSchemas} WHERE app_id = ?`, [appId])).toHaveLength(0);
  });

  it('reaches the exported bytes — the delete is marked dirty and flushed (AC23)', async () => {
    const appId = await seedFullApp('secretive');
    await db.deleteApp(appId);
    await db.flush();

    const bytes = await db.exportUserDb({ includeSecrets: true });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain(appId);
    expect(text).not.toContain('how chess works');
  });

  it('a fresh open over the same backend does not see the deleted app', async () => {
    const appId = await seedFullApp();
    await db.deleteApp(appId);
    await db.flush();

    const reopened = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (reopened.status !== 'ok') throw new Error('reopen failed');
    expect(reopened.userDb.getApp(appId)).toBeUndefined();
    expect(reopened.userDb.listApps().map((a) => a.appId)).not.toContain(appId);
  });

  it('reinstalling after delete does not inherit the old app’s data (AC20)', async () => {
    const appId = await seedFullApp('chess', 'src-1');
    await db.deleteApp(appId);
    await db.flush();

    const fresh = db.installApp({ displayName: 'chess', html: '<html>fresh</html>', installSource: 'src-1' });
    // A same-token collision would surface the dead app's rows through the new install.
    const probe = await db.driver.handle(fresh.appId, execFrame('SELECT name FROM sqlite_master'));
    expect(probe.ok).toBe(true);
    if (probe.ok && probe.rows !== undefined) {
      expect(probe.rows.flat().map(String)).not.toContain('games');
    }
    expect(db.getAppSchema(fresh.appId)).toBeUndefined();
    expect(db.listAppDocs(fresh.appId)).toHaveLength(0);
  });
});

describe('deleteApp — atomicity (AC21)', () => {
  it('rolls back completely when the cascade fails mid-flight', async () => {
    const appId = await seedFullApp();
    const before = await readUserDbTables();
    const versionsBefore = before.query(`SELECT * FROM ${USERDB_TABLES.appVersions} WHERE app_id = ?`, [appId]).length;
    const docsBefore = before.query(`SELECT * FROM ${USERDB_TABLES.appDocs} WHERE app_id = ?`, [appId]).length;
    expect(versionsBefore).toBeGreaterThan(0);
    expect(docsBefore).toBeGreaterThan(0);

    // Fault injection with a REAL SQLite failure rather than a test backdoor in the
    // public API: a BEFORE DELETE trigger that RAISE(ABORT)s on snug_apps, injected by
    // round-tripping the file through importUserDb (the pattern userdb-v2.test.ts uses).
    // The cascade drops data tables and deletes the other six tables BEFORE it reaches
    // snug_apps, so the abort lands mid-transaction — exactly the partial-cascade case
    // AC21 guards. Verified against sql.js: RAISE(ABORT) aborts the statement, and
    // ROLLBACK restores even the already-DROPped tables.
    const bytes = await db.exportUserDb({ includeSecrets: true });
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const doctored = new SQL.Database(bytes);
    doctored.run(
      `CREATE TRIGGER test_block_app_delete BEFORE DELETE ON ${USERDB_TABLES.apps} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    const doctoredBytes = doctored.export();
    doctored.close();
    await db.importUserDb(doctoredBytes);

    await expect(db.deleteApp(appId)).rejects.toThrow();

    const after = await readUserDbTables();
    expect(after.query(`SELECT 1 FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId])).toHaveLength(1);
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.appVersions} WHERE app_id = ?`, [appId])).toHaveLength(
      versionsBefore,
    );
    expect(after.query(`SELECT * FROM ${USERDB_TABLES.appDocs} WHERE app_id = ?`, [appId])).toHaveLength(docsBefore);
    expect(db.getApp(appId)).toBeDefined();
    // And the app still works afterwards.
    expect(db.listAppDocs(appId)).toHaveLength(2);
  });
});

describe('deleteApp — kv-only app (no schema)', () => {
  it('cascades an app that only ever used kv, not DDL', async () => {
    const app = db.installApp({ displayName: 'kv only', html: '<html>x</html>' });
    await db.driver.handle(app.appId, kvSetFrame('seen', true));
    await db.driver.flush();
    await db.flush();
    const token = appDataToken(app.appId);
    const before = await readUserDbTables();
    expect(before.query(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [
      `app_${token}__${APP_KV_TABLE}`,
    ])).toHaveLength(1);

    await db.deleteApp(app.appId);
    await db.flush();

    const after = await readUserDbTables();
    expect(after.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${token}__*'`)).toHaveLength(0);
    expect(db.getApp(app.appId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------
// Adversarial-review regressions (Gate 5, 2026-08-03). All three were verified to
// reproduce against the first implementation before being fixed.
// ---------------------------------------------------------------------------------

describe('deleteApp — deletion is terminal (review F1)', () => {
  it('a still-running app cannot resurrect itself with a post-delete write', async () => {
    const appId = await seedFullApp();
    const token = appDataToken(appId);

    await db.deleteApp(appId);

    // The app's iframe does not stop when the app is deleted. Its next db frame used to
    // re-register the namespace and re-create the data tables on the following
    // write-back, leaving an ORPHANED snug_app_schemas row with no parent app.
    const afterWrite = await db.driver.handle(appId, execFrame('CREATE TABLE zombie (id INTEGER PRIMARY KEY)'));
    expect(afterWrite.ok, 'a deleted app must not accept further db frames').toBe(false);
    await db.driver.flush();
    await db.flush();

    const after = await readUserDbTables();
    expect(
      after.query(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'app_${token}__*'`),
      'the app resurrected its data tables',
    ).toHaveLength(0);
    expect(
      after.query(`SELECT app_id FROM ${USERDB_TABLES.appSchemas} WHERE app_id = ?`, [appId]),
      'orphaned schema row with no parent app',
    ).toHaveLength(0);
    expect(after.query(`SELECT app_id FROM ${USERDB_TABLES.apps} WHERE app_id = ?`, [appId])).toHaveLength(0);
  });

  it('other apps keep working after a sibling is deleted', async () => {
    const keep = await seedFullApp('keeper', 'src-keep');
    const drop = await seedFullApp('goner', 'src-drop');
    await db.deleteApp(drop);
    const ok = await db.driver.handle(keep, execFrame(`INSERT INTO games (result) VALUES ('still works')`));
    expect(ok.ok).toBe(true);
  });
});

describe('deleteApp — rollback preserves unflushed app data (review F2)', () => {
  it('a failed delete does not silently discard the app’s most recent writes', async () => {
    // A long debounce keeps the write UNFLUSHED at delete time. With the suite-default
    // 1ms the timer fires first, the delta is already in the rest tables, and this test
    // would pass without exercising the bug at all.
    const slow = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 60_000 });
    if (slow.status !== 'ok') throw new Error('open failed');
    db = slow.userDb;

    const appId = await seedFullApp();

    // Inject the abort trigger FIRST: importUserDb rebuilds the inner driver, which would
    // otherwise destroy the very unflushed delta this test is about.
    const bytes = await db.exportUserDb({ includeSecrets: true });
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const doctored = new SQL.Database(bytes);
    doctored.run(
      `CREATE TRIGGER test_block_rollback BEFORE DELETE ON ${USERDB_TABLES.apps} BEGIN SELECT RAISE(ABORT, 'injected'); END`,
    );
    const doctoredBytes = doctored.export();
    doctored.close();
    await db.importUserDb(doctoredBytes);

    // NOW write without flushing: this delta lives only in the app's in-memory runtime,
    // and the 60s debounce guarantees no timer rescues it.
    await db.driver.handle(appId, execFrame(`INSERT INTO games (result) VALUES ('UNFLUSHED-PRECIOUS')`));

    await expect(db.deleteApp(appId)).rejects.toThrow();

    // The app is still installed AND still has the row it wrote before the failed delete.
    expect(db.getApp(appId)).toBeDefined();
    const read = await db.driver.handle(appId, execFrame('SELECT result FROM games'));
    expect(read.ok).toBe(true);
    if (read.ok && read.rows !== undefined) {
      expect(read.rows.flat().map(String)).toContain('UNFLUSHED-PRECIOUS');
    }
  });
});

// ------------------------------------------------- scheduled tasks (TASK-20261009 C3)

const SCHEDULE_AT = '2026-10-09T08:00:00.000Z';

function scheduledTask(id: string, steps: ScheduleStep[]): ScheduledTask {
  return scheduledTaskSchema.parse({
    id,
    title: `Task ${id}`,
    enabled: true,
    provenance: 'user',
    steps,
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'run-once',
    staleAfterMs: 86_400_000,
    alert: 'inbox',
    appVersions: {},
    createdAt: SCHEDULE_AT,
    updatedAt: SCHEDULE_AT,
  });
}

function scheduleRun(taskId: string): ScheduleRun {
  return scheduleRunSchema.parse({
    id: `run-${taskId}`,
    taskId,
    dueAt: SCHEDULE_AT,
    trigger: 'due',
    status: 'ok',
    host: { kind: 'web' },
    steps: [],
  });
}

const runStep = (appId: string): ScheduleStep => ({ kind: 'app-run', appId });
const thinkStep = (appId: string): ScheduleStep => ({ kind: 'app-think', appId, prompt: 'Summarise.', context: { maxRows: 50 } });
const notifyStep: ScheduleStep = { kind: 'notify', title: 'Water the plants', body: 'The ferns are thirsty.' };

describe('deleteApp — scheduled tasks, declines and the mute (TASK-20261009 C3, AC18 rows)', () => {
  it('a task that only ever named the deleted app vanishes with its runs row', async () => {
    const appId = await seedFullApp('goner');
    db.putScheduledTask(scheduledTask('only-goner', [runStep(appId), thinkStep(appId)]));
    db.putScheduleRun(scheduleRun('only-goner'));
    expect(db.listScheduleRuns('only-goner')).toHaveLength(1);

    await db.deleteApp(appId);

    expect(db.getScheduledTask('only-goner')).toBeUndefined();
    expect(db.listScheduleRuns('only-goner')).toEqual([]);
    const after = await readUserDbTables();
    for (const key of [scheduleSettingKey('only-goner'), scheduleRunsSettingKey('only-goner')]) {
      expect(after.query(`SELECT 1 FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]), `row ${key} survived`).toHaveLength(0);
    }
  });

  it('a task that names another app too SURVIVES with every step intact — the engine marks the dead step at run time', async () => {
    const goner = await seedFullApp('goner', 'src-goner');
    const keeper = await seedFullApp('keeper', 'src-keeper');
    const twoApps = scheduledTask('two-apps', [runStep(goner), runStep(keeper)]);
    const withReminder = scheduledTask('with-reminder', [notifyStep, thinkStep(goner)]);
    db.putScheduledTask(twoApps);
    db.putScheduledTask(withReminder);
    db.putScheduleRun(scheduleRun('two-apps'));

    await db.deleteApp(goner);

    expect(db.getScheduledTask('two-apps')).toEqual(twoApps);
    expect(db.getScheduledTask('with-reminder')).toEqual(withReminder);
    expect(db.listScheduleRuns('two-apps')).toHaveLength(1);
  });

  it("the app's declines (prefix) and its mute (equality) are gone; a sibling app's rows and tasks are untouched", async () => {
    const goner = await seedFullApp('goner', 'src-goner');
    const keeper = await seedFullApp('keeper', 'src-keeper');
    db.addScheduleDecline(goner, 'hash-1');
    db.addScheduleDecline(goner, 'hash-2');
    db.setScheduleMuted(goner, true);
    db.addScheduleDecline(keeper, 'hash-1');
    db.setScheduleMuted(keeper, true);
    const keeperTask = scheduledTask('keeper-only', [runStep(keeper)]);
    db.putScheduledTask(keeperTask);
    db.putScheduleRun(scheduleRun('keeper-only'));

    await db.deleteApp(goner);

    expect(db.listScheduleDeclines(goner)).toEqual([]);
    expect(db.isScheduleMuted(goner)).toBe(false);
    const after = await readUserDbTables();
    for (const key of [
      scheduleDeclinedSettingKey(goner, 'hash-1'),
      scheduleDeclinedSettingKey(goner, 'hash-2'),
      scheduleMutedSettingKey(goner),
    ]) {
      expect(after.query(`SELECT 1 FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]), `row ${key} survived`).toHaveLength(0);
    }
    // The sibling keeps everything.
    expect(db.listScheduleDeclines(keeper)).toEqual(['hash-1']);
    expect(db.isScheduleMuted(keeper)).toBe(true);
    expect(db.getScheduledTask('keeper-only')).toEqual(keeperTask);
    expect(db.listScheduleRuns('keeper-only')).toHaveLength(1);
  });

  it('a schedule row that does not parse is left alone — the cascade cannot know whose it is', async () => {
    const appId = await seedFullApp('goner');
    db.setSetting(scheduleSettingKey('unreadable'), { steps: [{ kind: 'app-run', appId }] });

    await db.deleteApp(appId);

    expect(db.listUnreadableScheduleKeys()).toEqual([scheduleSettingKey('unreadable')]);
  });
});

// ------------------------------------------------ access between apps (TASK-20261010 AC9)

const ACCESS_AT = '2026-10-10T08:00:00.000Z';

function accessGrant(readerAppId: string, sourceAppId: string): AccessGrant {
  return accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId,
    sourceAppId,
    scope: { tables: [{ name: 'games', columns: ['id', 'result'] }] },
    access: 'read',
    purpose: 'to compare results',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: ACCESS_AT,
    updatedAt: ACCESS_AT,
  });
}

function accessEntry(grant: AccessGrant, readerName: string): AccessLogEntry {
  return accessLogEntrySchema.parse({ at: ACCESS_AT, kind: 'granted', grantId: grant.id, readerAppId: grant.readerAppId, readerName });
}

const declineHash = accessRequestHash({ hints: { tables: ['games'] } });
const decline = { purpose: 'to compare results', hints: { tables: ['games'] }, at: ACCESS_AT };

/** Three apps with access state in every direction: goner reads keeper, keeper reads goner, keeper reads other. */
async function seedAccess(): Promise<{
  goner: string;
  keeper: string;
  other: string;
  gonerReadsKeeper: AccessGrant;
  keeperReadsGoner: AccessGrant;
  keeperReadsOther: AccessGrant;
}> {
  const goner = await seedFullApp('goner', 'src-goner');
  const keeper = await seedFullApp('keeper', 'src-keeper');
  const other = await seedFullApp('other', 'src-other');
  const gonerReadsKeeper = accessGrant(goner, keeper);
  const keeperReadsGoner = accessGrant(keeper, goner);
  const keeperReadsOther = accessGrant(keeper, other);
  for (const grant of [gonerReadsKeeper, keeperReadsGoner, keeperReadsOther]) db.putAccessGrant(grant);
  // Each source's history: keeper's names the goner as a reader; goner's names the keeper.
  db.appendAccessLog(keeper, accessEntry(gonerReadsKeeper, 'goner'));
  db.appendAccessLog(goner, accessEntry(keeperReadsGoner, 'keeper'));
  db.appendAccessLog(other, accessEntry(keeperReadsOther, 'keeper'));
  db.addAccessDecline(goner, declineHash, decline);
  db.addAccessDecline(keeper, declineHash, decline);
  db.setAccessMuted(goner, true);
  db.setAccessMuted(keeper, true);
  await db.flush();
  return { goner, keeper, other, gonerReadsKeeper, keeperReadsGoner, keeperReadsOther };
}

async function expectRowsGone(keys: readonly string[]): Promise<void> {
  const after = await readUserDbTables();
  for (const key of keys) {
    expect(after.query(`SELECT 1 FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]), `row ${key} survived`).toHaveLength(0);
  }
}

describe('deleteApp — access grants, history, declines and the mute (TASK-20261010 AC9)', () => {
  it('removes every grant where it is the reader', async () => {
    const { goner, gonerReadsKeeper } = await seedAccess();
    await db.deleteApp(goner);
    expect(db.getAccessGrant(gonerReadsKeeper.id)).toBeUndefined();
    await expectRowsGone([accessGrantSettingKey(gonerReadsKeeper.id)]);
  });

  it('removes every grant where it is the source', async () => {
    const { goner, keeperReadsGoner } = await seedAccess();
    await db.deleteApp(goner);
    expect(db.getAccessGrant(keeperReadsGoner.id)).toBeUndefined();
    await expectRowsGone([accessGrantSettingKey(keeperReadsGoner.id)]);
  });

  it('removes its own history row (accessLog:<appId>)', async () => {
    const { goner } = await seedAccess();
    await db.deleteApp(goner);
    await expectRowsGone([accessLogSettingKey(goner)]);
  });

  it('removes its declines (accessDeclined:<appId>:*)', async () => {
    const { goner } = await seedAccess();
    db.addAccessDecline(goner, accessRequestHash({ hints: { words: ['chess'] } }), { ...decline, hints: { words: ['chess'] } });
    await db.deleteApp(goner);
    expect(db.listSettingKeys().filter((key) => key.startsWith(`accessDeclined:${goner}:`))).toEqual([]);
    await expectRowsGone([accessDeclinedSettingKey(goner, declineHash)]);
  });

  it('removes its mute (accessMuted:<appId>)', async () => {
    const { goner } = await seedAccess();
    await db.deleteApp(goner);
    expect(db.isAccessMuted(goner)).toBe(false);
    await expectRowsGone([accessMutedSettingKey(goner)]);
  });

  it('a grant row that no longer parses but names the app is removed too — a later lenient reader must not find it', async () => {
    const { goner } = await seedAccess();
    const plantedKey = accessGrantSettingKey(crypto.randomUUID());
    db.setSetting(plantedKey, { readerAppId: goner, sourceAppId: 'anyone', junk: true });
    await db.deleteApp(goner);
    await expectRowsGone([plantedKey]);
  });

  it("a sibling app's rows are untouched — its grants, its history (even entries naming the deleted reader), its declines and its mute", async () => {
    const { goner, keeper, other, gonerReadsKeeper, keeperReadsOther } = await seedAccess();
    const keeperHistory = db.listAccessLog(keeper);
    const otherHistory = db.listAccessLog(other);

    await db.deleteApp(goner);

    expect(db.getAccessGrant(keeperReadsOther.id)).toEqual(keeperReadsOther);
    expect(db.listAccessLog(keeper)).toEqual(keeperHistory);
    expect(db.listAccessLog(keeper)[0]?.grantId).toBe(gonerReadsKeeper.id);
    expect(db.listAccessLog(other)).toEqual(otherHistory);
    expect(db.listAccessDeclines(keeper).map((d) => d.hash)).toEqual([declineHash]);
    expect(db.isAccessMuted(keeper)).toBe(true);
  });

  it('the sweeps run INSIDE the cascade transaction: a failed delete leaves every access row in place', async () => {
    const { goner, gonerReadsKeeper, keeperReadsGoner } = await seedAccess();
    const bytes = await db.exportUserDb({ includeSecrets: true });
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const doctored = new SQL.Database(bytes);
    doctored.run(
      `CREATE TRIGGER test_block_app_delete BEFORE DELETE ON ${USERDB_TABLES.apps} BEGIN SELECT RAISE(ABORT, 'injected failure'); END`,
    );
    const doctoredBytes = doctored.export();
    doctored.close();
    await db.importUserDb(doctoredBytes, { trustedOrigin: true });

    await expect(db.deleteApp(goner)).rejects.toThrow();

    expect(db.getAccessGrant(gonerReadsKeeper.id)).toEqual(gonerReadsKeeper);
    expect(db.getAccessGrant(keeperReadsGoner.id)).toEqual(keeperReadsGoner);
    expect(db.listAccessLog(goner)).toHaveLength(1);
    expect(db.listAccessDeclines(goner)).toHaveLength(1);
    expect(db.isAccessMuted(goner)).toBe(true);
  });
});
