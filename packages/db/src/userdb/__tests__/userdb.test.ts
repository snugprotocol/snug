// Child-1 ACs 1,2,3,6,7 (TASK-20260803-userdb-core): the UserDb service — one sql.js
// handle over one file, migrations, app versioning with retention + revert, chat,
// settings/secrets/profile, export/import with secrets-strip default, fail-closed
// corruption recovery, and the size guard.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  USERDB_FILE,
  USERDB_LIMITS,
  USERDB_SCHEMA_VERSION,
  USERDB_TABLES,
  accessGrantSchema,
  accessLogEntrySchema,
  accessRequestHash,
  canonicalAccessGrantIntent,
  scheduleRunSchema,
  scheduledTaskSchema,
  type AccessGrant,
  type AccessLogEntry,
  type ScheduleRun,
  type ScheduledTask,
} from '@snugprotocol/protocol';
import { execFrame, kvSetFrame, locateWasm } from '../../__tests__/helpers.js';
import { namespaceToFileName } from '../../namespace.js';
import { scopedScratchRead } from '../../scoped-read.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  accessDeclinedSettingKey,
  accessGrantSettingKey,
  accessLogSettingKey,
  accessMutedSettingKey,
  SCHEDULER_STATE_SETTING_KEY,
  scheduleDeclinedSettingKey,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
} from '../app-settings-keys.js';
import { SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS } from '../schedules.js';
import { openUserDb, USERDB_ERROR_CODES, UserDbError, type UserDb } from '../userdb.js';

const open = async (backend: MemoryBackend, overrides: Record<string, unknown> = {}): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1, ...overrides });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

let backend: MemoryBackend;
beforeEach(() => {
  backend = createMemoryBackend();
});

describe('open + migrations (AC2)', () => {
  it('creates a fresh user DB at the current schema version and persists it', async () => {
    const db = await open(backend);
    await db.flush();
    await db.close();
    expect(backend.files.has(USERDB_FILE)).toBe(true);
  });

  it('re-opens its own persisted bytes idempotently (no duplicate DDL failures)', async () => {
    const first = await open(backend);
    first.setSetting('mode', 'byok');
    await first.close();
    const second = await open(backend);
    expect(second.getSetting('mode')).toBe('byok');
    await second.close();
  });

  it('refuses bytes from a NEWER schema version instead of destroying them', async () => {
    const db = await open(backend);
    await db.close();
    const SQL = await initSqlJs({ locateFile: () => locateWasm() });
    const raw = new SQL.Database(backend.files.get(USERDB_FILE));
    raw.run(`PRAGMA user_version = ${USERDB_SCHEMA_VERSION + 10}`);
    await backend.save(USERDB_FILE, raw.export());
    raw.close();
    const result = await openUserDb({ backend, locateWasm });
    expect(result.status).toBe('unsupported');
  });
});

describe('apps + versioning (AC3)', () => {
  it('installApp creates version 1 and getAppHtml returns it', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: '<html>v1</html>' });
    expect(app.currentVersion).toBe(1);
    expect(db.getAppHtml(app.appId)).toBe('<html>v1</html>');
    expect(db.listApps().map((a) => a.appId)).toEqual([app.appId]);
    await db.close();
  });

  it('saveAppVersion increments, prunes beyond retention, and keeps the newest N plus the pinned factory (v2)', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: 'v1' });
    for (let i = 2; i <= 7; i++) db.saveAppVersion(app.appId, `v${i}`);
    const versions = db.listAppVersions(app.appId).map((v) => v.version);
    expect(versions).toEqual([7, 6, 5, 4, 3, 1]); // newest first, 5 unpinned retained + factory v1 pinned forever
    expect(db.getApp(app.appId)?.currentVersion).toBe(7);
    expect(db.getAppHtml(app.appId)).toBe('v7');
    expect(db.getAppHtml(app.appId, 3)).toBe('v3');
    expect(db.getAppHtml(app.appId, 1)).toBe('v1'); // factory default always recoverable
    await db.close();
  });

  it('revertApp copy-forwards the old HTML as a NEW version (history preserved)', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: 'v1' });
    db.saveAppVersion(app.appId, 'v2');
    db.saveAppVersion(app.appId, 'v3');
    const reverted = db.revertApp(app.appId, 2);
    expect(reverted.version).toBe(4);
    expect(db.getAppHtml(app.appId)).toBe('v2');
    expect(db.listAppVersions(app.appId).map((v) => v.version)).toEqual([4, 3, 2, 1]);
    await db.close();
  });

  it('updateAppMeta patches display fields without touching versions', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: 'v1' });
    db.updateAppMeta(app.appId, { description: 'play vs the model', iconEmoji: '♟️', usesDb: true });
    const updated = db.getApp(app.appId);
    expect(updated?.description).toBe('play vs the model');
    expect(updated?.iconEmoji).toBe('♟️');
    expect(updated?.usesDb).toBe(true);
    expect(updated?.displayName).toBe('Chess');
    expect(updated?.currentVersion).toBe(1);
    expect(() => db.updateAppMeta('nope', { description: 'x' })).toThrow(UserDbError);
    await db.close();
  });

  it('rejects unknown apps/versions with typed errors', async () => {
    const db = await open(backend);
    expect(() => db.saveAppVersion('nope', 'html')).toThrow(UserDbError);
    expect(() => db.revertApp('nope', 1)).toThrow(UserDbError);
    await db.close();
  });
});

describe('chat threads + messages', () => {
  it('persists threads and messages in order', async () => {
    const db = await open(backend);
    db.upsertThread('app:chess', { appId: 'chess', title: 'Chess chat' });
    db.appendChatMessage('app:chess', 'user', 'make it blue');
    db.appendChatMessage('app:chess', 'assistant', 'done');
    expect(db.listThreads()).toHaveLength(1);
    const messages = db.listChatMessages('app:chess');
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'make it blue'],
      ['assistant', 'done'],
    ]);
    await db.close();
  });

  /**
   * A staged data-write proposal persists on the assistant message's meta, and the user
   * resolving it (approve/decline) has to persist too — otherwise a reload re-offers a
   * change that already landed (R-M5).
   */
  it('updates a message’s meta in place, leaving content and pinning alone', async () => {
    const db = await open(backend);
    const row = db.appendChatMessage('app:m', 'assistant', 'awaiting approval', {
      pinned: true,
      meta: { dataWrite: { summary: 'add lunch' } },
    });

    db.updateChatMessageMeta(row.id, { dataWrite: { summary: 'add lunch', outcome: 'applied' } });

    const [stored] = db.listChatMessages('app:m');
    expect(stored?.meta).toEqual({ dataWrite: { summary: 'add lunch', outcome: 'applied' } });
    expect(stored?.content, 'content is untouched').toBe('awaiting approval');
    expect(stored?.pinned, 'pinning is untouched').toBe(true);
    await db.close();
  });

  /**
   * TASK-20260903-build-thread-continuity AC5b: the build page's thread sidebar can
   * delete a conversation. The thread row and its messages go — pinned rows included,
   * exactly as the app cascade treats them — and NOTHING else: the app a thread is
   * pinned to is the user's work and is never touched by a thread delete (D4).
   */
  it('deleteThread removes the thread and its messages, and nothing else', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: '<!DOCTYPE html><html><body>chess</body></html>' });
    db.upsertThread('thr-a', { appId: app.appId, title: 'first build' });
    db.appendChatMessage('thr-a', 'user', 'build chess', { pinned: true });
    db.appendChatMessage('thr-a', 'assistant', 'done', { pinned: true });
    db.upsertThread('thr-b', { title: 'unrelated' });
    db.appendChatMessage('thr-b', 'user', 'hello');

    db.deleteThread('thr-a');

    expect(db.getThread('thr-a')).toBeUndefined();
    expect(db.listChatMessages('thr-a')).toEqual([]);
    expect(db.listThreads().map((t) => t.threadId)).toEqual(['thr-b']);
    expect(db.listChatMessages('thr-b')).toHaveLength(1);
    expect(db.getApp(app.appId), 'a thread delete must never delete the app').toBeDefined();
    // A stale id (already deleted, never existed) is a no-op: the caller is a UI click.
    expect(() => db.deleteThread('thr-a')).not.toThrow();
    expect(() => db.deleteThread('thr-never')).not.toThrow();
    await db.close();
  });

  it('updating meta for an unknown message id is a silent no-op, never a throw', async () => {
    // The caller is a UI click handler; a stale id (pruned thread, deleted app) must not
    // take down the surface.
    const db = await open(backend);
    expect(() => db.updateChatMessageMeta(4242, { dataWrite: {} })).not.toThrow();
    await db.close();
  });
});

describe('settings / profile / secrets / sync config', () => {
  it('round-trips JSON values per store', async () => {
    const db = await open(backend);
    db.setSetting('provider', { name: 'anthropic', model: 'claude-sonnet-5' });
    db.setProfileField('displayName', 'Jeetu');
    db.setSecret('anthropicKey', 'sk-ant-secret');
    db.setSyncConfig('origin', { kind: 'hub' });
    expect(db.getSetting('provider')).toEqual({ name: 'anthropic', model: 'claude-sonnet-5' });
    expect(db.getProfileField('displayName')).toBe('Jeetu');
    expect(db.getSecret('anthropicKey')).toBe('sk-ant-secret');
    expect(db.listSecretKeys()).toEqual(['anthropicKey']);
    expect(db.getSyncConfig('origin')).toEqual({ kind: 'hub' });
    db.deleteSecret('anthropicKey');
    expect(db.getSecret('anthropicKey')).toBeUndefined();
    await db.close();
  });
});

describe('export / import (AC1)', () => {
  it('round-trips everything EXCEPT secrets by default; includeSecrets restores them too', async () => {
    const db = await open(backend);
    const a = db.installApp({ displayName: 'A', html: 'a1' });
    db.saveAppVersion(a.appId, 'a2');
    const b = db.installApp({ displayName: 'B', html: 'b1' });
    db.upsertThread('builder:1', { title: 't' });
    db.appendChatMessage('builder:1', 'user', 'hi');
    db.setSetting('mode', 'byok');
    db.setSecret('anthropicKey', 'sk-ant-secret');

    const stripped = await db.exportUserDb();
    const full = await db.exportUserDb({ includeSecrets: true });

    const restore = async (bytes: Uint8Array): Promise<UserDb> => {
      const fresh = createMemoryBackend();
      const target = await open(fresh);
      await target.importUserDb(bytes);
      return target;
    };

    const fromStripped = await restore(stripped);
    expect(fromStripped.listApps().map((x) => x.displayName).sort()).toEqual(['A', 'B']);
    expect(fromStripped.getAppHtml(a.appId)).toBe('a2');
    expect(fromStripped.listChatMessages('builder:1')).toHaveLength(1);
    expect(fromStripped.getSetting('mode')).toBe('byok');
    expect(fromStripped.getSecret('anthropicKey')).toBeUndefined();
    expect(fromStripped.getApp(b.appId)).toBeDefined();
    await fromStripped.close();

    const fromFull = await restore(full);
    expect(fromFull.getSecret('anthropicKey')).toBe('sk-ant-secret');
    await fromFull.close();
    await db.close();
  });

  it('default export contains zero secret bytes, even in free pages (VACUUMed)', async () => {
    const db = await open(backend);
    db.setSecret('anthropicKey', 'sk-ant-super-secret-value');
    const bytes = await db.exportUserDb();
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text.includes('sk-ant-super-secret-value')).toBe(false);
    await db.close();
  });

  it('rejects non-SQLite import bytes with a typed error', async () => {
    const db = await open(backend);
    await expect(db.importUserDb(new TextEncoder().encode('not a database'))).rejects.toThrow(UserDbError);
    await db.close();
  });
});

describe('corruption fails closed (AC6, F6)', () => {
  it('treats a ZERO-BYTE file as corrupt — an interrupted write must never silently become a fresh DB', async () => {
    await backend.save(USERDB_FILE, new Uint8Array(0));
    const result = await openUserDb({ backend, locateWasm });
    expect(result.status).toBe('corrupt');
  });

  it('treats magic-less bytes as corrupt even when sql.js would tolerate them', async () => {
    await backend.save(USERDB_FILE, new Uint8Array(32)); // zeros: no SQLite header
    const result = await openUserDb({ backend, locateWasm });
    expect(result.status).toBe('corrupt');
  });

  it('quarantines corrupt bytes and reports — never silently fresh', async () => {
    await backend.save(USERDB_FILE, new TextEncoder().encode('garbage-not-sqlite'));
    const result = await openUserDb({ backend, locateWasm });
    expect(result.status).toBe('corrupt');
    if (result.status !== 'corrupt') return;
    expect(backend.files.has(result.quarantinedFile)).toBe(true);
    expect(new TextDecoder().decode(backend.files.get(result.quarantinedFile))).toBe('garbage-not-sqlite');
    // recovery is an explicit caller decision:
    const fresh = await result.openFresh();
    fresh.setSetting('mode', 'byok');
    await fresh.close();
  });
});

describe('size guard (AC7, F8)', () => {
  it('refuses app writes that would exceed the user-DB cap with a typed error', async () => {
    const db = await open(backend, { maxBytes: 256 * 1024 });
    const big = 'x'.repeat(300 * 1024);
    expect(() => db.installApp({ displayName: 'Huge', html: big })).toThrow(UserDbError);
    try {
      db.installApp({ displayName: 'Huge', html: big });
    } catch (err) {
      expect((err as UserDbError).code).toBe('USERDB_TOO_LARGE');
    }
    await db.close();
  });

  it('defaults the cap to the spec constant', async () => {
    const db = await open(backend);
    expect(USERDB_LIMITS.MAX_USERDB_BYTES).toBe(64 * 1024 * 1024);
    // a normal-sized app is accepted under the default cap
    expect(() => db.installApp({ displayName: 'Ok', html: '<html>ok</html>' })).not.toThrow();
    await db.close();
  });
});

// TASK-20260905-host-kit AC9 (C1): a host where no credential can be USED (no BYOK rows,
// no connections — the host kit inside an artifact) must never adopt one. The strip runs
// on the CANDIDATE before it becomes live, so the secret bytes never touch the store.
describe('importUserDb({ stripSecrets }) — the candidate loses snug_secrets before adoption (AC9)', () => {
  const SECRET = 'sk-ant-must-never-land';

  async function donorBytes(): Promise<Uint8Array> {
    const donor = await open(createMemoryBackend());
    donor.setSecret('byok:anthropic', SECRET);
    donor.setSetting('mode', 'local');
    const bytes = await donor.exportUserDb({ includeSecrets: true });
    await donor.close();
    return bytes;
  }

  it('strips: no secret keys after import, and the adopted bytes carry no trace of the value', async () => {
    const target = await open(backend);
    await target.importUserDb(await donorBytes(), { stripSecrets: true });
    expect(target.listSecretKeys()).toEqual([]);
    expect(target.getSetting('mode')).toBe('local'); // everything else arrives untouched
    const adopted = await target.exportUserDb({ includeSecrets: true });
    expect(new TextDecoder('latin1').decode(adopted)).not.toContain(SECRET);
    await target.close();
  });

  it('positive twin: without the option the secret arrives, as today', async () => {
    const target = await open(backend);
    await target.importUserDb(await donorBytes());
    expect(target.listSecretKeys()).toEqual(['byok:anthropic']);
    expect(target.getSecret('byok:anthropic')).toBe(SECRET);
    await target.close();
  });
});

// ------------------------------------------- scheduled tasks across the file boundary
//
// TASK-20261009-scheduling-framework C4 (ADR-0074 §2, §6). A task is EXECUTABLE INTENT
// — like endpoint settings, connections and runtime contracts, it is the kind of row a
// foreign file must not be able to plant armed. So the import seam that every path
// (UI import, sync pull-merge, applyRemote, recovery restore) already funnels through
// gains one more pass, at the slot the connection reconciliation occupies:
//
//   - on EVERY import: `proposals` leave every run row (a foreign file can never plant an
//     approval card — security F1), and a `running`/`pending` claim older than its bound
//     is `interrupted` (reason `imported`): no host is still executing it;
//   - UNTRUSTED (a file off disk): a task not byte-identical to a local one lands
//     `enabled:false, provenance:'imported'`; the watermark becomes NOW (a foreign past
//     must not become a catch-up storm); declines and mutes are dropped (they are the
//     user's own answers to THEIR apps' suggestions, not something a file carries in);
//   - TRUSTED (the user's own origin): tasks stay as they are; the watermark is
//     max(local, imported) so a pull never rewinds a device behind runs it recorded.
//
// Export strips `proposals` the same way, on the throwaway copy: a proposed statement
// never leaves the device, on either export path.

const SCHEDULE_AT = '2026-10-09T08:00:00.000Z';
const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

function scheduledTask(id: string, overrides: Record<string, unknown> = {}): ScheduledTask {
  return scheduledTaskSchema.parse({
    id,
    title: `Task ${id}`,
    enabled: true,
    provenance: 'user',
    steps: [{ kind: 'notify', title: 'Water the plants', body: 'The ferns are thirsty.' }],
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'run-once',
    staleAfterMs: 86_400_000,
    alert: 'inbox',
    appVersions: {},
    createdAt: SCHEDULE_AT,
    updatedAt: SCHEDULE_AT,
    ...overrides,
  });
}

function scheduleRun(taskId: string, dueAt: string, overrides: Record<string, unknown> = {}): ScheduleRun {
  return scheduleRunSchema.parse({
    id: `run-${taskId}-${dueAt}`,
    taskId,
    dueAt,
    trigger: 'due',
    status: 'ok',
    host: { kind: 'web' },
    steps: [],
    ...overrides,
  });
}

const PROPOSAL_SQL = "UPDATE expenses SET note = 'PLANTED-BY-A-FOREIGN-FILE' WHERE id = 7";
const proposals = { items: [{ appId: 'ledger', sql: PROPOSAL_SQL, summary: 'Fix the note', counts: { changes: 1 } }], expiresAt: minutesAgo(-60) };

/** A donor file carrying whatever `plant` writes through the accessors — exported WITH secrets, like a sync push. */
async function donorBytes(plant: (donor: UserDb) => void): Promise<Uint8Array> {
  const donor = await open(createMemoryBackend());
  plant(donor);
  const bytes = await donor.exportUserDb({ includeSecrets: true });
  await donor.close();
  return bytes;
}

/**
 * Plant one settings row INTO exported bytes with raw sql.js — what a hostile or foreign
 * donor would do, and the only way to build a file that carries proposals, since the
 * donor's own export strips them (the `foreignDbWithRawContract` technique).
 */
async function plantRaw(bytes: Uint8Array, rows: Array<[key: string, value: unknown]>): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const raw = new SQL.Database(bytes);
  try {
    for (const [key, value] of rows) {
      raw.run(`INSERT OR REPLACE INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [key, JSON.stringify(value)]);
    }
    return raw.export();
  } finally {
    raw.close();
  }
}

/** Read one settings row straight out of exported bytes — the claim is about what LEAVES, so no accessor sits in between. */
async function settingFromBytes(bytes: Uint8Array, key: string): Promise<unknown> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const raw = new SQL.Database(bytes);
  try {
    const stmt = raw.prepare(`SELECT value FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key]);
    try {
      return stmt.step() ? (JSON.parse(String(stmt.get()[0])) as unknown) : undefined;
    } finally {
      stmt.free();
    }
  } finally {
    raw.close();
  }
}

describe('importUserDb — scheduled tasks are executable intent (TASK-20261009 C4)', () => {
  it('an UNTRUSTED file: a task the hub has never seen arrives DISABLED with provenance "imported", and is reported', async () => {
    const bytes = await donorBytes((donor) => donor.putScheduledTask(scheduledTask('foreign', { provenance: 'app', ownerAppId: 'weather' })));
    const db = await open(backend);

    const report = await db.importUserDb(bytes);

    const landed = db.getScheduledTask('foreign');
    expect(landed?.enabled).toBe(false);
    expect(landed?.provenance).toBe('imported');
    expect(landed?.ownerAppId).toBe('weather'); // the rest of the task is kept, readable, for the user to review
    expect(report.schedules).toEqual({ demotedTasks: 1, strippedProposals: 0 });
    await db.close();
  });

  it('an UNTRUSTED file: a task byte-identical (canonically) to a local one stays enabled — a backup round trip must not disarm the user', async () => {
    const mine = scheduledTask('mine');
    const bytes = await donorBytes((donor) => {
      // The same task with its keys in another order: the comparison is canonical, not raw.
      const reordered = Object.fromEntries(Object.entries(mine).reverse());
      donor.setSetting(scheduleSettingKey('mine'), reordered);
      donor.putScheduledTask(scheduledTask('edited-elsewhere', { title: 'Same id, other bytes' }));
    });
    const db = await open(backend);
    db.putScheduledTask(mine);
    db.putScheduledTask(scheduledTask('edited-elsewhere'));

    const report = await db.importUserDb(bytes);

    expect(db.getScheduledTask('mine')).toEqual(mine);
    expect(db.getScheduledTask('edited-elsewhere')?.enabled).toBe(false);
    expect(db.getScheduledTask('edited-elsewhere')?.provenance).toBe('imported');
    expect(report.schedules.demotedTasks).toBe(1);
    await db.close();
  });

  it('a TRUSTED origin keeps every task exactly as it is (a new device or a restore must not disarm the user)', async () => {
    const theirs = scheduledTask('theirs', { provenance: 'chat' });
    const bytes = await donorBytes((donor) => donor.putScheduledTask(theirs));
    const db = await open(backend);

    const report = await db.importUserDb(bytes, { trustedOrigin: true });

    expect(db.getScheduledTask('theirs')).toEqual(theirs);
    expect(report.schedules.demotedTasks).toBe(0);
    await db.close();
  });

  it('proposals are STRIPPED from every run row on both paths, and the planted SQL is nowhere in the adopted bytes', async () => {
    const exported = await donorBytes((donor) => {
      donor.putScheduledTask(scheduledTask('t1'));
      donor.putScheduledTask(scheduledTask('t2'));
    });
    // Planted raw: the donor's own export would already have stripped these.
    const bytes = await plantRaw(exported, [
      [scheduleRunsSettingKey('t1'), [scheduleRun('t1', minutesAgo(3), { status: 'ok' }), scheduleRun('t1', minutesAgo(5), { status: 'needs-you', proposals })]],
      [scheduleRunsSettingKey('t2'), [scheduleRun('t2', minutesAgo(4), { status: 'ok', proposals })]],
    ]);

    for (const options of [undefined, { trustedOrigin: true }]) {
      const db = await open(createMemoryBackend());
      const report = await db.importUserDb(bytes, options);
      expect(report.schedules.strippedProposals, `trusted=${String(options?.trustedOrigin)}`).toBe(2);
      for (const run of [...db.listScheduleRuns('t1'), ...db.listScheduleRuns('t2')]) {
        expect(run.proposals).toBeUndefined();
      }
      // The rows themselves survive a trusted pull; the untrusted path demotes t1 and so disarms its needs-you row (S1).
      expect(db.listScheduleRuns('t1').map((r) => r.status)).toEqual(options?.trustedOrigin === true ? ['ok', 'needs-you'] : ['ok']);
      const adopted = await db.exportUserDb({ includeSecrets: true });
      expect(new TextDecoder('latin1').decode(adopted)).not.toContain('PLANTED-BY-A-FOREIGN-FILE');
      await db.close();
    }
  });

  it('a running or pending claim older than its bound becomes "interrupted" (reason imported); a fresh one is left alone', async () => {
    const staleMinutes = SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS / 60_000 + 5;
    const bytes = await donorBytes((donor) => {
      donor.putScheduledTask(scheduledTask('t1'));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(staleMinutes + 10), { status: 'running', startedAt: minutesAgo(staleMinutes) }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(staleMinutes), { status: 'pending', trigger: 'catch-up' }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(2), { status: 'running', startedAt: minutesAgo(1) }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(3), { status: 'pending', trigger: 'catch-up' }));
    });
    const db = await open(backend);

    await db.importUserDb(bytes, { trustedOrigin: true });

    const byStatus = db.listScheduleRuns('t1').map((r) => [r.status, r.reason]);
    expect(byStatus).toEqual([
      ['pending', undefined],
      ['running', undefined],
      ['interrupted', 'imported'],
      ['interrupted', 'imported'],
    ]);
    await db.close();
  });

  it('a FUTURE-dated pending row for a demoted task is gone after an untrusted import — and so are its needs-you rows (S1/S7)', async () => {
    const bytes = await donorBytes((donor) => {
      donor.putScheduledTask(scheduledTask('planted', { provenance: 'app', ownerAppId: 'weather' }));
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(-120), { status: 'pending', trigger: 'catch-up' })); // two hours from now
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(30), { status: 'pending', trigger: 'catch-up' })); // fresh, past
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(60), { status: 'needs-you' }));
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(90), { status: 'running', startedAt: minutesAgo(-60) })); // started in the future
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(120), { status: 'ok' }));
      donor.putScheduleRun(scheduleRun('planted', minutesAgo(-5), { status: 'ok' })); // a result dated in the future
    });
    const db = await open(backend);

    const report = await db.importUserDb(bytes);

    expect(db.getScheduledTask('planted')).toMatchObject({ enabled: false, provenance: 'imported' });
    expect(report.schedules.demotedTasks).toBe(1);
    expect(db.listScheduleRuns('planted').map((r) => [r.status, r.reason])).toEqual([
      ['ok', undefined],
      ['interrupted', 'imported'], // the future-started claim: no host is executing it
    ]);
    await db.close();
  });

  it('on BOTH paths a run dated in the future is dropped and a claim started in the future is interrupted (S1/S7); a fresh past claim is kept', async () => {
    const bytes = await donorBytes((donor) => {
      donor.putScheduledTask(scheduledTask('t1'));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(-3), { status: 'pending', trigger: 'catch-up' })); // three minutes from now
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(-30), { status: 'ok' }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(5), { status: 'running', startedAt: minutesAgo(-60) }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(2), { status: 'running', startedAt: minutesAgo(1) }));
      donor.putScheduleRun(scheduleRun('t1', minutesAgo(4), { status: 'pending', trigger: 'catch-up' }));
    });
    for (const options of [undefined, { trustedOrigin: true }]) {
      const db = await open(createMemoryBackend());
      db.putScheduledTask(scheduledTask('t1')); // intent-identical: the untrusted path keeps it, like a backup round trip
      await db.importUserDb(bytes, options);
      expect(db.listScheduleRuns('t1').map((r) => [r.status, r.reason]), `trusted=${String(options?.trustedOrigin)}`).toEqual([
        ['pending', undefined],
        ['running', undefined],
        ['interrupted', 'imported'],
      ]);
      await db.close();
    }
  });

  it('UNTRUSTED: a ranThrough in the future is clamped to the import instant — a planted record cannot hold a schedule silent (S1)', async () => {
    const future = minutesAgo(-24 * 60);
    const bytes = await donorBytes((donor) => donor.putScheduledTask(scheduledTask('t1', { ranThrough: future })));
    const db = await open(backend);
    const before = Date.now();
    await db.importUserDb(bytes);
    const landed = db.getScheduledTask('t1');
    expect(landed?.enabled).toBe(false);
    expect(landed?.ranThrough).toBeDefined();
    expect(Date.parse(landed?.ranThrough ?? '')).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(landed?.ranThrough ?? '')).toBeGreaterThanOrEqual(before);
    await db.close();
  });

  it('a backup taken before a run and restored (UNTRUSTED) after it keeps the task ENABLED — the engine’s bookkeeping is not intent (M4/M16)', async () => {
    const db = await open(backend);
    const mine = scheduledTask('mine', { steps: [{ kind: 'app-think', appId: 'ledger', prompt: 'sum it', context: { maxRows: 50 } }], appVersions: { ledger: 1 } });
    db.putScheduledTask(mine);
    const backup = await db.exportUserDb({ includeSecrets: true });

    // One run happened since: a result row, `ranThrough`, the unseen counter, a fresh `appVersions` after a resume — and no `updatedAt` stamp (M16).
    db.putScheduleRun(scheduleRun('mine', minutesAgo(10), { status: 'ok', finishedAt: minutesAgo(9) }));
    db.putScheduledTask({ ...mine, ranThrough: minutesAgo(10), unseenResults: 1, consecutiveFailures: 0, enabledAt: minutesAgo(30), appVersions: { ledger: 2 } });

    const report = await db.importUserDb(backup);

    expect(db.getScheduledTask('mine')).toMatchObject({ enabled: true, provenance: 'user' });
    expect(report.schedules.demotedTasks).toBe(0);
    await db.close();
  });

  it('UNTRUSTED: the watermark becomes NOW, globalPause is kept, the daily counters are zeroed', async () => {
    const bytes = await donorBytes((donor) => {
      donor.putScheduledTask(scheduledTask('t1'));
      donor.setSchedulerState({ watermark: '2020-01-01T00:00:00.000Z', globalPause: true, daily: { date: '2020-01-01', ai: 40, net: 200 } });
    });
    const db = await open(backend);
    db.setSchedulerState({ watermark: '2025-06-01T00:00:00.000Z', globalPause: false, daily: { date: '2025-06-01', ai: 1, net: 1 } });
    const before = new Date().toISOString();

    await db.importUserDb(bytes);

    const state = db.getSchedulerState();
    expect(state?.watermark && state.watermark >= before, 'the watermark is now, not the foreign past').toBe(true);
    expect(state?.globalPause).toBe(true);
    expect(state?.daily).toEqual({ date: before.slice(0, 10), ai: 0, net: 0 });
    await db.close();
  });

  it('TRUSTED: the watermark is max(local, imported) — in both directions', async () => {
    const older = '2026-01-01T00:00:00.000Z';
    const newer = '2026-06-01T00:00:00.000Z';
    const imported = (watermark: string): Promise<Uint8Array> =>
      donorBytes((donor) => donor.setSchedulerState({ watermark, globalPause: false, daily: { date: watermark.slice(0, 10), ai: 2, net: 3 } }));

    const localNewer = await open(createMemoryBackend());
    localNewer.setSchedulerState({ watermark: newer, globalPause: false, daily: { date: '2026-06-01', ai: 0, net: 0 } });
    await localNewer.importUserDb(await imported(older), { trustedOrigin: true });
    expect(localNewer.getSchedulerState()?.watermark).toBe(newer);
    expect(localNewer.getSchedulerState()?.daily.ai, 'the rest of the imported state is kept').toBe(2);
    await localNewer.close();

    const localOlder = await open(createMemoryBackend());
    localOlder.setSchedulerState({ watermark: older, globalPause: false, daily: { date: '2026-01-01', ai: 0, net: 0 } });
    await localOlder.importUserDb(await imported(newer), { trustedOrigin: true });
    expect(localOlder.getSchedulerState()?.watermark).toBe(newer);
    await localOlder.close();
  });

  it('UNTRUSTED drops every decline and mute; TRUSTED keeps them', async () => {
    const bytes = await donorBytes((donor) => {
      donor.addScheduleDecline('weather', 'hash-1');
      donor.setScheduleMuted('ledger', true);
    });

    const untrusted = await open(createMemoryBackend());
    await untrusted.importUserDb(bytes);
    expect(untrusted.listScheduleDeclines('weather')).toEqual([]);
    expect(untrusted.isScheduleMuted('ledger')).toBe(false);
    expect(untrusted.listSettingKeys()).not.toContain(scheduleDeclinedSettingKey('weather', 'hash-1'));
    expect(untrusted.listSettingKeys()).not.toContain(scheduleMutedSettingKey('ledger'));
    await untrusted.close();

    const trusted = await open(createMemoryBackend());
    await trusted.importUserDb(bytes, { trustedOrigin: true });
    expect(trusted.listScheduleDeclines('weather')).toEqual(['hash-1']);
    expect(trusted.isScheduleMuted('ledger')).toBe(true);
    await trusted.close();
  });

  it('S9: an UNTRUSTED file’s chat messages lose `meta.schedule` — a staged suggestion is a foreign card; the data-write card and the other meta keys stay; TRUSTED keeps it', async () => {
    const schedule = { proposal: { title: 'morning', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: { kind: 'daily', time: '08:00', tz: 'device' } }, hash: 'h', channel: 'chat', threadId: 'app:x' };
    const bytes = await donorBytes((donor) => {
      donor.upsertThread('app:x', { appId: 'x', title: 'x' });
      donor.appendChatMessage('app:x', 'assistant', 'suggested', { meta: { schedule, dataWrite: { summary: 'add lunch' }, brainKind: 'byok' } });
      donor.appendChatMessage('app:x', 'assistant', 'only a card', { meta: { schedule } });
      donor.appendChatMessage('app:x', 'assistant', 'no meta');
    });

    const untrusted = await open(createMemoryBackend());
    await untrusted.importUserDb(bytes);
    const rows = untrusted.listChatMessages('app:x');
    expect(rows.map((m) => m.meta)).toEqual([{ dataWrite: { summary: 'add lunch' }, brainKind: 'byok' }, undefined, undefined]);
    await untrusted.close();

    const trusted = await open(createMemoryBackend());
    await trusted.importUserDb(bytes, { trustedOrigin: true });
    expect(trusted.listChatMessages('app:x')[0]?.meta).toEqual({ schedule, dataWrite: { summary: 'add lunch' }, brainKind: 'byok' });
    expect(trusted.listChatMessages('app:x')[1]?.meta).toEqual({ schedule });
    await trusted.close();
  });

  it('an untrusted file with no scheduling rows at all adds no scheduler state — old backups import as before', async () => {
    const bytes = await donorBytes((donor) => donor.setSetting('mode', 'local'));
    const db = await open(backend);
    await db.importUserDb(bytes);
    expect(db.getSchedulerState()).toBeUndefined();
    expect(db.listSettingKeys()).not.toContain(SCHEDULER_STATE_SETTING_KEY);
    await db.close();
  });
});

describe('exportUserDb — proposals never leave the device (TASK-20261009 C4)', () => {
  it('strips proposals from every run row on BOTH export paths; the live file keeps them', async () => {
    const db = await open(backend);
    db.putScheduledTask(scheduledTask('t1'));
    db.putScheduleRun(scheduleRun('t1', minutesAgo(5), { status: 'needs-you', proposals }));
    db.putScheduleRun(scheduleRun('t1', minutesAgo(3), { status: 'ok' }));

    for (const opts of [undefined, { includeSecrets: true }]) {
      const bytes = await db.exportUserDb(opts);
      expect(new TextDecoder('latin1').decode(bytes), `includeSecrets=${String(opts?.includeSecrets)}`).not.toContain(
        'PLANTED-BY-A-FOREIGN-FILE',
      );
      const row = (await settingFromBytes(bytes, scheduleRunsSettingKey('t1'))) as Array<Record<string, unknown>>;
      expect(row.map((r) => r.status)).toEqual(['ok', 'needs-you']); // the history itself is carried
      expect(row.every((r) => !('proposals' in r))).toBe(true);
    }
    // The device's own pending card is untouched by exporting.
    expect(db.listScheduleRuns('t1').find((r) => r.status === 'needs-you')?.proposals?.items[0]?.sql).toBe(PROPOSAL_SQL);
    await db.close();
  });
});

describe('getFileId — the file identity the scheduler keys its leader lock on (TASK-20261009 R1)', () => {
  it('answers the seeded db_id, a UUID, stable across a close and reopen of the same bytes', async () => {
    const backend = createMemoryBackend();
    const first = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (first.status !== 'ok') throw new Error('open failed');
    const id = first.userDb.getFileId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    await first.userDb.flush();
    await first.userDb.close();
    const second = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
    if (second.status !== 'ok') throw new Error('reopen failed');
    expect(second.userDb.getFileId()).toBe(id);
    await second.userDb.close();
  });
});

// ---------------------------------------------- access between apps (TASK-20261010 AC7, AC10)
//
// AC7 — the two reads the access engine needs from the SOURCE: `exportAppRuntime` (the live
// runtime bytes a scoped read copies; the `scratchRun` export path behind the `getApp` guard
// and the deleted-app tombstone) and `describeAppData` (what the consent sheet shows: tables,
// columns with a `sensitive` flag, row counts — from the SAME exported bytes).
//
// AC10 — the import pass on the CANDIDATE, beside the scheduler's: an UNTRUSTED file's grants
// land `suspended / imported` unless intent-identical to a local grant of the same id; a
// TRUSTED pull keeps them; an untrusted file's declines and mutes are dropped and its history
// entries tagged `imported`; a grant row that does not parse is removed and reported.
//
// Mutation checks (run by hand): drop the exportAppRuntime guard → the phantom-file row reds;
// skip the demotion → the "lands suspended" row reds; skip the tag → the tagging row reds.

const SOURCE_APP = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const READER_APP = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const GHOST_APP = 'f0f0f0f0-0000-4000-8000-000000000000';
const ACCESS_AT = '2026-10-10T08:00:00.000Z';

async function bytesOf(db: UserDb, appId: string): Promise<unknown[][]> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const copy = new SQL.Database(await db.exportAppRuntime(appId));
  try {
    return copy.exec('SELECT amount FROM transactions ORDER BY amount')[0]?.values ?? [];
  } finally {
    copy.close();
  }
}

async function codeOfAsync(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof UserDbError ? err.code : `not a UserDbError: ${String(err)}`;
  }
}

describe('exportAppRuntime — the live runtime bytes behind the getApp guard and the tombstone (TASK-20261010 AC7)', () => {
  it('answers the app’s live runtime bytes — a row written a moment ago is in them', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)']);
    await db.driver.handle(app.appId, execFrame('INSERT INTO transactions (amount) VALUES (450), (500)'));
    expect(await bytesOf(db, app.appId)).toEqual([[450], [500]]);
    await db.close();
  });

  it('an unknown app is NOT_FOUND — and no phantom namespace file appears for it', async () => {
    const db = await open(backend);
    expect(await codeOfAsync(db.exportAppRuntime(GHOST_APP))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    await db.flush();
    await db.close();
    expect(await backend.load(namespaceToFileName(GHOST_APP))).toBeUndefined();
  });

  it('a deleted app is NOT_FOUND — the tombstone, not a sandbox error', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)']);
    await db.deleteApp(app.appId);
    expect(await codeOfAsync(db.exportAppRuntime(app.appId))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    await db.close();
  });
});

describe('describeAppData — tables, columns (sensitive flagged) and row counts from the exported bytes (TASK-20261010 AC7)', () => {
  it('lists every table with its columns from PRAGMA table_info — a quoted reserved word with a CHECK survives — and its row count; snug_kv is not listed', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, [
      'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, "order" TEXT CHECK ("order" <> \'\'), api_key TEXT, user_password TEXT)',
      'CREATE TABLE notes (body TEXT)',
    ]);
    await db.driver.handle(app.appId, execFrame(`INSERT INTO transactions (amount, "order") VALUES (450, 'first'), (500, 'second')`));
    await db.driver.handle(app.appId, kvSetFrame('pin', '1234'));

    expect(await db.describeAppData(app.appId)).toEqual({
      tables: [
        { name: 'notes', columns: [{ name: 'body', sensitive: false }], rowCount: 0 },
        {
          name: 'transactions',
          columns: [
            { name: 'id', sensitive: false },
            { name: 'amount', sensitive: false },
            { name: 'order', sensitive: false },
            { name: 'api_key', sensitive: true },
            { name: 'user_password', sensitive: true },
          ],
          rowCount: 2,
        },
      ],
    });
    await db.close();
  });

  it('counts a row written but not yet persisted (it flushes first, and counts on the same exported bytes)', async () => {
    const db = await open(backend, { persistDebounceMs: 60_000 });
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)']);
    await db.driver.handle(app.appId, execFrame('INSERT INTO transactions (amount) VALUES (1)'));
    await db.driver.handle(app.appId, execFrame('INSERT INTO transactions (amount) VALUES (2)'));
    const described = await db.describeAppData(app.appId);
    expect(described.tables.map((t) => [t.name, t.rowCount])).toEqual([['transactions', 2]]);
    await db.close();
  });

  it('an app with no tables answers { tables: [] } — a kv-only app included', async () => {
    const db = await open(backend);
    const bare = db.installApp({ displayName: 'Bare', html: '<html></html>' });
    const kvOnly = db.installApp({ displayName: 'Kv', html: '<html></html>' });
    await db.driver.handle(kvOnly.appId, kvSetFrame('score', 3));
    expect(await db.describeAppData(bare.appId)).toEqual({ tables: [] });
    expect(await db.describeAppData(kvOnly.appId)).toEqual({ tables: [] });
    await db.close();
  });

  // Review finding 3: `PRAGMA table_info` hides GENERATED columns, yet the scoped copy still
  // answers a SELECT on them — so the sheet must show them (table_xinfo, hidden 2/3), flagged
  // `sensitive` by the same name rule, and a scope built from this description must not drift.
  it('lists GENERATED columns (stored and virtual) like ordinary ones — the sheet says exactly what the copy answers — and a scope built from it reads without drift', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, [
      'CREATE TABLE t (name TEXT, password TEXT, shadow TEXT GENERATED ALWAYS AS (password) STORED, name_copy TEXT GENERATED ALWAYS AS (name) VIRTUAL, api_key TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL)',
    ]);
    await db.driver.handle(app.appId, execFrame("INSERT INTO t (name, password) VALUES ('a', 'pw-one')"));

    const described = await db.describeAppData(app.appId);
    expect(described.tables).toEqual([
      {
        name: 't',
        columns: [
          { name: 'name', sensitive: false },
          { name: 'password', sensitive: true },
          { name: 'shadow', sensitive: false },
          { name: 'name_copy', sensitive: false },
          { name: 'api_key', sensitive: true },
        ],
        rowCount: 1,
      },
    ]);

    // The consent sheet's own derivation: every column that is not sensitive.
    const scope = { tables: described.tables.map((table) => ({ name: table.name, columns: table.columns.filter((c) => !c.sensitive).map((c) => c.name) })) };
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const result = scopedScratchRead(SQL, await db.exportAppRuntime(app.appId), scope, { sql: 'SELECT name, shadow, name_copy FROM t' }, { maxRows: 500, maxBytes: 65_536 });
    expect(result).toMatchObject({ ok: true, rows: [['a', '***', 'a']] });
    await db.close();
  });

  it('an unknown or deleted app is NOT_FOUND', async () => {
    const db = await open(backend);
    expect(await codeOfAsync(db.describeAppData(GHOST_APP))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.deleteApp(app.appId);
    expect(await codeOfAsync(db.describeAppData(app.appId))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    await db.close();
  });
});

function accessGrant(overrides: Record<string, unknown> = {}): AccessGrant {
  return accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId: READER_APP,
    sourceAppId: SOURCE_APP,
    scope: { tables: [{ name: 'transactions', columns: ['amount', 'category'] }] },
    access: 'read',
    purpose: 'to show spending by category',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: ACCESS_AT,
    updatedAt: ACCESS_AT,
    ...overrides,
  });
}

function accessEntry(grantId: string, overrides: Record<string, unknown> = {}): AccessLogEntry {
  return accessLogEntrySchema.parse({ at: ACCESS_AT, kind: 'granted', grantId, readerAppId: READER_APP, readerName: 'Budget', ...overrides });
}

function installAccessApps(db: UserDb): void {
  db.installApp({ appId: SOURCE_APP, displayName: 'Ledger', html: '<html>ledger</html>' });
  db.installApp({ appId: READER_APP, displayName: 'Budget', html: '<html>budget</html>' });
}

/** A donor file carrying the two apps and whatever `plant` writes — exported WITH secrets, like a sync push. */
const accessDonor = (plant: (donor: UserDb) => void): Promise<Uint8Array> =>
  donorBytes((donor) => {
    installAccessApps(donor);
    plant(donor);
  });

const declineHash = accessRequestHash({ hints: { tables: ['transactions'] } });
const decline = { purpose: 'to show spending by category', hints: { tables: ['transactions'] }, at: ACCESS_AT };

// TASK-20261010-host-broker PR-2 Gate-5 SEC-3: `listAppObjectNames` — every name in the app's
// RUNTIME sqlite_master (tables, views, indexes, triggers, whatever the app's own code created at
// runtime, not only what the registry holds), as stored, from the same flushed runtime snapshot
// `describeAppData` reads. The chat door de-collides its aliases against these, so the scratch
// attach never has to refuse a name.
describe('listAppObjectNames — every runtime object name, any type, as stored (PR-2 SEC-3)', () => {
  it('holds the registry table AND the runtime-created table, view, index and trigger — names as stored (case kept)', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Budget', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE envelopes (id INTEGER PRIMARY KEY, name TEXT)']);
    for (const sql of [
      'CREATE TABLE Ledger__Accounts (id INTEGER)',
      'CREATE VIEW ledger__transactions AS SELECT id FROM envelopes',
      'CREATE INDEX ledger__items ON envelopes (name)',
      "CREATE TRIGGER ledger__audit AFTER INSERT ON envelopes BEGIN SELECT 1; END",
    ]) {
      const result = await db.driver.handle(app.appId, execFrame(sql));
      expect(result.ok, sql).toBe(true);
    }
    const names = await db.listAppObjectNames(app.appId);
    expect(names).toEqual(expect.arrayContaining(['envelopes', 'Ledger__Accounts', 'ledger__transactions', 'ledger__items', 'ledger__audit']));
    expect(names).not.toContain('ledger__accounts');
    expect(names.every((name) => typeof name === 'string')).toBe(true);
    await db.close();
  });

  it('includes an object created a moment ago and not yet persisted (it flushes first, like describeAppData)', async () => {
    const db = await open(backend, { persistDebounceMs: 60_000 });
    const app = db.installApp({ displayName: 'Budget', html: '<html></html>' });
    await db.driver.handle(app.appId, execFrame('CREATE TABLE own (id INTEGER)'));
    await db.driver.handle(app.appId, execFrame('CREATE VIEW fresh_view AS SELECT id FROM own'));
    expect(await db.listAppObjectNames(app.appId)).toEqual(expect.arrayContaining(['own', 'fresh_view']));
    await db.close();
  });

  it('an unknown app is NOT_FOUND; a deleted app is NOT_FOUND', async () => {
    const db = await open(backend);
    expect(await codeOfAsync(db.listAppObjectNames(GHOST_APP))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY)']);
    await db.deleteApp(app.appId);
    expect(await codeOfAsync(db.listAppObjectNames(app.appId))).toBe(USERDB_ERROR_CODES.NOT_FOUND);
    await db.close();
  });

  it('reads a throwaway copy — the app’s bytes are unchanged by the call', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Ledger', html: '<html></html>' });
    await db.applyAppDdl(app.appId, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)']);
    await db.driver.handle(app.appId, execFrame('INSERT INTO transactions (amount) VALUES (450)'));
    const before = Buffer.from(await db.exportAppRuntime(app.appId)).toString('base64');
    await db.listAppObjectNames(app.appId);
    expect(Buffer.from(await db.exportAppRuntime(app.appId)).toString('base64')).toBe(before);
    await db.close();
  });
});

describe('importUserDb — access grants are disarmed unless intent-identical (TASK-20261010 AC10)', () => {
  it('an UNTRUSTED file: a grant the hub has never seen lands suspended / imported, the rest of it intact, and is reported', async () => {
    const theirs = accessGrant({ reads: 4 });
    const bytes = await accessDonor((donor) => donor.putAccessGrant(theirs));
    const db = await open(backend);

    const report = await db.importUserDb(bytes);

    const landed = db.getAccessGrant(theirs.id);
    expect(landed).toMatchObject({ status: 'suspended', suspendedReason: 'imported', purpose: theirs.purpose, scope: theirs.scope, reads: 4 });
    expect(landed?.revokedAt).toBeUndefined();
    expect(report.access).toEqual({ suspendedGrants: 1, removedGrants: 0, taggedLogEntries: 0 });
    await db.close();
  });

  it('an UNTRUSTED file: an intent-identical grant stays as it was; the same id with another intent is suspended', async () => {
    const mine = accessGrant();
    const edited = accessGrant();
    const bytes = await accessDonor((donor) => {
      // The same intent with moved bookkeeping (a read happened elsewhere) and keys in another order.
      const moved = { ...mine, reads: 9, lastReadAt: ACCESS_AT, updatedAt: '2026-10-11T08:00:00.000Z' };
      donor.setSetting(accessGrantSettingKey(mine.id), Object.fromEntries(Object.entries(moved).reverse()));
      donor.putAccessGrant({ ...edited, purpose: 'to read everything, forever' });
    });
    const db = await open(backend);
    installAccessApps(db);
    db.putAccessGrant(mine);
    db.putAccessGrant(edited);

    const report = await db.importUserDb(bytes);

    expect(db.getAccessGrant(mine.id)).toMatchObject({ status: 'active', reads: 9 });
    expect(canonicalAccessGrantIntent(db.getAccessGrant(mine.id)!)).toBe(canonicalAccessGrantIntent(mine));
    expect(db.getAccessGrant(edited.id)).toMatchObject({ status: 'suspended', suspendedReason: 'imported', purpose: 'to read everything, forever' });
    expect(report.access.suspendedGrants).toBe(1);
    await db.close();
  });

  it('an UNTRUSTED file: a suspended grant becomes suspended / imported; a revoked one stays revoked (already disarmed, never made revivable)', async () => {
    const paused = accessGrant({ status: 'suspended', suspendedReason: 'reader-updated' });
    const stopped = accessGrant({ status: 'revoked', revokedAt: ACCESS_AT });
    const bytes = await accessDonor((donor) => {
      donor.putAccessGrant(paused);
      donor.putAccessGrant(stopped);
    });
    const db = await open(backend);

    const report = await db.importUserDb(bytes);

    expect(db.getAccessGrant(paused.id)).toMatchObject({ status: 'suspended', suspendedReason: 'imported' });
    expect(db.getAccessGrant(stopped.id)).toEqual(stopped);
    expect(report.access.suspendedGrants).toBe(1);
    await db.close();
  });

  // W6 findings 2/27 — only a LIVE local grant vouches for its imported twin. A grant the user
  // STOPPED keeps its tombstone (an older copy of the file must never re-arm it), and a local
  // grant that is paused is never un-paused by a file.
  it('an UNTRUSTED file: a grant the user STOPPED is still stopped after importing an older copy that carries it active', async () => {
    const g = accessGrant();
    const bytes = await accessDonor((donor) => donor.putAccessGrant(g)); // the backup from before the stop
    const db = await open(backend);
    installAccessApps(db);
    const stoppedAt = '2026-10-11T09:00:00.000Z';
    db.putAccessGrant({ ...g, status: 'revoked', revokedAt: stoppedAt, updatedAt: stoppedAt });

    const report = await db.importUserDb(bytes);

    expect(db.getAccessGrant(g.id)).toMatchObject({ status: 'revoked', revokedAt: stoppedAt, updatedAt: stoppedAt });
    expect(db.getAccessGrant(g.id)?.suspendedReason).toBeUndefined();
    expect(report.access).toEqual({ suspendedGrants: 0, removedGrants: 0, taggedLogEntries: 0 });
    await db.close();
  });

  it('an UNTRUSTED file: an intent-identical twin of a locally PAUSED grant lands suspended / imported, never active', async () => {
    const g = accessGrant();
    const bytes = await accessDonor((donor) => donor.putAccessGrant(g));
    const db = await open(backend);
    installAccessApps(db);
    db.putAccessGrant({ ...g, status: 'suspended', suspendedReason: 'reader-updated' });

    const report = await db.importUserDb(bytes);

    expect(db.getAccessGrant(g.id)).toMatchObject({ status: 'suspended', suspendedReason: 'imported' });
    expect(report.access.suspendedGrants).toBe(1);
    await db.close();
  });

  // W6 finding 3 — the import seam of D18: consent given to the reader's OLD code does not survive
  // a file that replaces that code, exactly as a share link or an agent hand-in would not.
  it('an UNTRUSTED file that replaces the READER\'s code: its intent-identical grant lands suspended / imported', async () => {
    const g = accessGrant();
    const bytes = await donorBytes((donor) => {
      donor.installApp({ appId: SOURCE_APP, displayName: 'Ledger', html: '<html>ledger</html>' });
      donor.installApp({ appId: READER_APP, displayName: 'Budget', html: '<html>EVIL budget that exfiltrates</html>' });
      donor.putAccessGrant(g);
    });
    const db = await open(backend);
    installAccessApps(db);
    db.putAccessGrant(g);

    const report = await db.importUserDb(bytes);

    expect(db.getAppHtml(READER_APP)).toContain('EVIL');
    expect(db.getAccessGrant(g.id)).toMatchObject({ status: 'suspended', suspendedReason: 'imported' });
    expect(report.access.suspendedGrants).toBe(1);
    await db.close();
  });

  it('the twin: the same reader code (a backup round trip) keeps the intent-identical grant active', async () => {
    const g = accessGrant();
    const bytes = await accessDonor((donor) => donor.putAccessGrant(g));
    const db = await open(backend);
    installAccessApps(db);
    db.putAccessGrant(g);

    const report = await db.importUserDb(bytes);

    expect(db.getAccessGrant(g.id)).toMatchObject({ status: 'active' });
    expect(report.access.suspendedGrants).toBe(0);
    await db.close();
  });

  it('a TRUSTED pull keeps every grant exactly as it is', async () => {
    const theirs = accessGrant();
    const bytes = await accessDonor((donor) => donor.putAccessGrant(theirs));
    const db = await open(backend);

    const report = await db.importUserDb(bytes, { trustedOrigin: true });

    expect(db.getAccessGrant(theirs.id)).toEqual(theirs);
    expect(report.access).toEqual({ suspendedGrants: 0, removedGrants: 0, taggedLogEntries: 0 });
    await db.close();
  });

  it('an UNTRUSTED file’s declines and mutes are dropped; a TRUSTED pull keeps them', async () => {
    const bytes = await accessDonor((donor) => {
      donor.addAccessDecline(READER_APP, declineHash, decline);
      donor.setAccessMuted(READER_APP, true);
    });

    const untrusted = await open(createMemoryBackend());
    await untrusted.importUserDb(bytes);
    expect(untrusted.listAccessDeclines(READER_APP)).toEqual([]);
    expect(untrusted.isAccessMuted(READER_APP)).toBe(false);
    expect(untrusted.listSettingKeys()).not.toContain(accessDeclinedSettingKey(READER_APP, declineHash));
    expect(untrusted.listSettingKeys()).not.toContain(accessMutedSettingKey(READER_APP));
    await untrusted.close();

    const trusted = await open(createMemoryBackend());
    await trusted.importUserDb(bytes, { trustedOrigin: true });
    expect(trusted.listAccessDeclines(READER_APP).map((d) => d.hash)).toEqual([declineHash]);
    expect(trusted.isAccessMuted(READER_APP)).toBe(true);
    await trusted.close();
  });

  it('an UNTRUSTED file’s history entries are all tagged imported (idempotent — an already-tagged entry is not counted again); a TRUSTED pull tags nothing', async () => {
    const g = accessGrant();
    const bytes = await accessDonor((donor) => {
      donor.putAccessGrant(g);
      donor.appendAccessLog(SOURCE_APP, accessEntry(g.id));
      donor.appendAccessLog(SOURCE_APP, accessEntry(g.id, { kind: 'read', at: '2026-10-10T09:00:00.000Z', sql: 'SELECT 1', rows: 1 }));
      donor.appendAccessLog(SOURCE_APP, accessEntry(g.id, { kind: 'revoked', at: '2026-10-10T10:00:00.000Z', imported: true }));
    });

    const untrusted = await open(createMemoryBackend());
    const report = await untrusted.importUserDb(bytes);
    const log = untrusted.listAccessLog(SOURCE_APP);
    expect(log).toHaveLength(3);
    expect(log.every((e) => e.imported === true)).toBe(true);
    expect(report.access.taggedLogEntries).toBe(2);
    // Importing the adopted file again tags nothing new.
    const again = await untrusted.exportUserDb({ includeSecrets: true });
    const second = await open(createMemoryBackend());
    expect((await second.importUserDb(again)).access.taggedLogEntries).toBe(0);
    expect(second.listAccessLog(SOURCE_APP).every((e) => e.imported === true)).toBe(true);
    await second.close();
    await untrusted.close();

    const trusted = await open(createMemoryBackend());
    const trustedReport = await trusted.importUserDb(bytes, { trustedOrigin: true });
    expect(trusted.listAccessLog(SOURCE_APP).map((e) => e.imported ?? false)).toEqual([true, false, false]);
    expect(trustedReport.access.taggedLogEntries).toBe(0);
    await trusted.close();
  });

  it('a grant row that does not parse is REMOVED and reported on an UNTRUSTED import', async () => {
    const good = accessGrant();
    const exported = await accessDonor((donor) => donor.putAccessGrant(good));
    const junkKey = accessGrantSettingKey(crypto.randomUUID());
    const mismatchKey = accessGrantSettingKey(crypto.randomUUID());
    const bytes = await plantRaw(exported, [
      [junkKey, { readerAppId: READER_APP, status: 'active' }],
      [mismatchKey, accessGrant()], // the body names another id
    ]);

    const db = await open(createMemoryBackend());
    const report = await db.importUserDb(bytes);
    expect(report.access.removedGrants).toBe(2);
    expect(db.listSettingKeys()).not.toContain(junkKey);
    expect(db.listSettingKeys()).not.toContain(mismatchKey);
    expect(db.getAccessGrant(good.id)).toBeDefined();
    await db.close();
  });

  // The schedules precedent (review finding 2): a TRUSTED pull is the user's own file from their
  // own origin — a row this hub cannot parse may be a NEWER hub's grant (a field 1.1 does not
  // know). It is already inert here (the tolerant read answers "no such grant"); deleting it
  // would sync the deletion back and cost the newer device its grant.
  it('a TRUSTED pull keeps a grant row it cannot parse — inert here, intact for the hub that wrote it — and reports no removal', async () => {
    const good = accessGrant();
    const exported = await accessDonor((donor) => donor.putAccessGrant(good));
    const future = accessGrant();
    const futureKey = accessGrantSettingKey(future.id);
    const futureBody = { ...future, auditTrail: 'a field a later spec adds' };
    const bytes = await plantRaw(exported, [[futureKey, futureBody]]);

    const db = await open(createMemoryBackend());
    const report = await db.importUserDb(bytes, { trustedOrigin: true });
    expect(report.access.removedGrants).toBe(0);
    expect(db.getSetting(futureKey)).toEqual(futureBody);
    expect(db.getAccessGrant(future.id)).toBeUndefined(); // inert: the tolerant read does not honour it
    expect(db.listAccessGrants().map((g) => g.id)).toEqual([good.id]);
    await db.close();
  });

  it('the export carries grants and history: export → trusted import preserves both byte for byte', async () => {
    const db = await open(backend);
    installAccessApps(db);
    const g = accessGrant({ duration: { kind: 'until', at: '2026-10-17T08:00:00.000Z' } });
    db.putAccessGrant(g);
    db.appendAccessLog(SOURCE_APP, accessEntry(g.id));
    db.appendAccessLog(SOURCE_APP, accessEntry(g.id, { kind: 'read', at: '2026-10-10T09:00:00.000Z', sql: 'SELECT amount FROM transactions', rows: 3, attended: false }));
    const exported = await db.exportUserDb();
    expect(await settingFromBytes(exported, accessGrantSettingKey(g.id))).toEqual(g);
    expect(await settingFromBytes(exported, accessLogSettingKey(SOURCE_APP))).toEqual(db.listAccessLog(SOURCE_APP));

    const restored = await open(createMemoryBackend());
    await restored.importUserDb(exported, { trustedOrigin: true });
    expect(restored.listAccessGrants()).toEqual([g]);
    expect(restored.listAccessLog(SOURCE_APP)).toEqual(db.listAccessLog(SOURCE_APP));
    await restored.close();
    await db.close();
  });
});
