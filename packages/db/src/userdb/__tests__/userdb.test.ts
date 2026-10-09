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
  scheduleRunSchema,
  scheduledTaskSchema,
  type ScheduleRun,
  type ScheduledTask,
} from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  SCHEDULER_STATE_SETTING_KEY,
  scheduleDeclinedSettingKey,
  scheduleMutedSettingKey,
  scheduleRunsSettingKey,
  scheduleSettingKey,
} from '../app-settings-keys.js';
import { SCHEDULE_IMPORTED_CLAIM_MAX_AGE_MS } from '../schedules.js';
import { openUserDb, UserDbError, type UserDb } from '../userdb.js';

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
