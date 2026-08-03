// Child-1 ACs 1,2,3,6,7 (TASK-20260803-userdb-core): the UserDb service — one sql.js
// handle over one file, migrations, app versioning with retention + revert, chat,
// settings/secrets/profile, export/import with secrets-strip default, fail-closed
// corruption recovery, and the size guard.
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { USERDB_FILE, USERDB_LIMITS, USERDB_SCHEMA_VERSION } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
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

  it('saveAppVersion increments, prunes beyond retention, and keeps the newest N', async () => {
    const db = await open(backend);
    const app = db.installApp({ displayName: 'Chess', html: 'v1' });
    for (let i = 2; i <= 7; i++) db.saveAppVersion(app.appId, `v${i}`);
    const versions = db.listAppVersions(app.appId).map((v) => v.version);
    expect(versions).toEqual([7, 6, 5, 4, 3]); // newest first, 5 retained
    expect(db.getApp(app.appId)?.currentVersion).toBe(7);
    expect(db.getAppHtml(app.appId)).toBe('v7');
    expect(db.getAppHtml(app.appId, 3)).toBe('v3');
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
