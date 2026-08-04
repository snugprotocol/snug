// Child-1 (TASK-20260803-userdb-v2): service-level v2 behavior — factory version
// pinning (umbrella AC6), bootstrap message pinning + prune (AC5), per-app docs (AC7),
// install-source dedup (AC8), and the structural v1→v2 migration (AC10, data abandoned
// by design — owner-approved).
import { beforeEach, describe, expect, it } from 'vitest';
import initSqlJs from 'sql.js';
import { USERDB_FILE } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

describe('factory version pinning (AC6)', () => {
  it('pins v1 on install; 7 edits retain factory + the 5 most recent', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    for (let i = 2; i <= 8; i++) db.saveAppVersion(app.appId, `<html>v${i}</html>`);
    const versions = db.listAppVersions(app.appId);
    expect(versions.map((v) => v.version)).toEqual([8, 7, 6, 5, 4, 1]);
    expect(versions.find((v) => v.version === 1)?.pinned).toBe(true);
    expect(versions.filter((v) => v.pinned)).toHaveLength(1);
  });

  it('resetToFactory restores the exact factory HTML even after v1 would have been pruned unpinned', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>FACTORY</html>' });
    for (let i = 2; i <= 9; i++) db.saveAppVersion(app.appId, `<html>v${i}</html>`);
    const meta = db.resetToFactory(app.appId);
    expect(db.getAppHtml(app.appId)).toBe('<html>FACTORY</html>');
    expect(meta.note).toContain('factory');
    expect(db.getApp(app.appId)?.currentVersion).toBe(meta.version);
  });

  it('revert to a pruned version still throws NOT_FOUND (unchanged contract)', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    for (let i = 2; i <= 9; i++) db.saveAppVersion(app.appId, `<html>v${i}</html>`);
    expect(() => db.revertApp(app.appId, 2)).toThrow();
  });
});

describe('bootstrap message pinning + prune (AC5)', () => {
  it('pinned messages survive pruning at any cap; unpinned prune keeps the newest N', () => {
    const first = db.appendChatMessage('thr-1', 'user', 'build me a portfolio app');
    db.pinChatMessage(first.id);
    const reply = db.appendChatMessage('thr-1', 'assistant', 'built it', { pinned: true });
    for (let i = 0; i < 20; i++) db.appendChatMessage('thr-1', 'user', `chatter ${i}`);
    db.pruneChatMessages('thr-1', 5);
    const kept = db.listChatMessages('thr-1');
    expect(kept).toHaveLength(7); // 2 pinned + 5 newest unpinned
    expect(kept[0]).toMatchObject({ id: first.id, pinned: true });
    expect(kept[1]).toMatchObject({ id: reply.id, pinned: true });
    expect(kept.slice(2).every((m) => m.content.startsWith('chatter 1'))).toBe(true);
  });

  it('getThread returns the durable thread row (app pin) or undefined', () => {
    db.upsertThread('thr-9', { appId: 'app-1', title: 'portfolio build' });
    expect(db.getThread('thr-9')).toMatchObject({ threadId: 'thr-9', appId: 'app-1', title: 'portfolio build' });
    expect(db.getThread('missing')).toBeUndefined();
  });

  it('meta JSON rides the message (artifact cards, wire text)', () => {
    const msg = db.appendChatMessage('thr-1', 'assistant', 'done', {
      meta: { artifact: { appId: 'a-1', version: 2, displayName: 'Portfolio' } },
    });
    const listed = db.listChatMessages('thr-1');
    expect(listed[0]!.id).toBe(msg.id);
    expect(listed[0]!.meta).toEqual({ artifact: { appId: 'a-1', version: 2, displayName: 'Portfolio' } });
  });
});

describe('per-app docs (AC7)', () => {
  it('CRUD round-trip, isolated per app, listed with metadata', () => {
    db.putAppDoc('app-1', 'vision', { title: 'Vision', content: '# North star' });
    db.putAppDoc('app-1', 'lessons', { content: 'lesson 1' });
    db.putAppDoc('app-2', 'vision', { content: 'other app' });
    expect(db.getAppDoc('app-1', 'vision')).toMatchObject({ title: 'Vision', content: '# North star' });
    expect(db.listAppDocs('app-1').map((d) => d.slug).sort()).toEqual(['lessons', 'vision']);
    expect(db.listAppDocs('app-2')).toHaveLength(1);
    db.putAppDoc('app-1', 'lessons', { content: 'lesson 1\nlesson 2' });
    expect(db.getAppDoc('app-1', 'lessons')?.content).toContain('lesson 2');
    db.deleteAppDoc('app-1', 'lessons');
    expect(db.getAppDoc('app-1', 'lessons')).toBeUndefined();
  });

  it('docs and pins survive whole-DB export → import (AC2/AC7)', async () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>', installSource: 'starter:chess' });
    db.putAppDoc(app.appId, 'vision', { content: 'the vision' });
    const boot = db.appendChatMessage('thr-1', 'user', 'bootstrap', { pinned: true });
    const bytes = await db.exportUserDb({ includeSecrets: true });

    const fresh = createMemoryBackend();
    const result = await openUserDb({ backend: fresh, locateWasm, persistDebounceMs: 1 });
    if (result.status !== 'ok') throw new Error('open failed');
    const other = result.userDb;
    await other.importUserDb(bytes);
    expect(other.getAppDoc(app.appId, 'vision')?.content).toBe('the vision');
    expect(other.listChatMessages('thr-1')[0]).toMatchObject({ id: boot.id, pinned: true });
    expect(other.getAppByInstallSource('starter:chess')?.appId).toBe(app.appId);
    expect(other.listAppVersions(app.appId)[0]?.pinned).toBe(true);
    await other.close();
  });
});

describe('install-source dedup (AC8)', () => {
  it('installing the same source twice returns the existing app — no duplicate rows', () => {
    const first = db.installApp({ displayName: 'Chess', html: '<html>chess</html>', installSource: 'starter:chess' });
    const second = db.installApp({ displayName: 'Chess', html: '<html>chess</html>', installSource: 'starter:chess' });
    expect(second.appId).toBe(first.appId);
    expect(db.listApps()).toHaveLength(1);
    expect(db.listAppVersions(first.appId)).toHaveLength(1); // no extra version row either
  });

  it('getAppByInstallSource finds the install; built apps (no source) are unaffected', () => {
    const built = db.installApp({ displayName: 'Built', html: '<html/>' });
    const starter = db.installApp({ displayName: 'Chess', html: '<html/>', installSource: 'starter:chess' });
    expect(db.getAppByInstallSource('starter:chess')?.appId).toBe(starter.appId);
    expect(db.getAppByInstallSource('starter:none')).toBeUndefined();
    expect(built.installSource).toBeUndefined();
    expect(db.listApps()).toHaveLength(2);
  });
});

describe('v1→v2 structural migration (AC10 — data abandoned by design)', () => {
  it('migrates a v1 file: new tables/columns/index present, blob table dropped, oldest versions pinned', async () => {
    // Build a faithful v1 file with the ORIGINAL v1 DDL (snug_app_data, no pinned/meta/install_source).
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const v1 = new SQL.Database();
    for (const ddl of [
      'CREATE TABLE snug_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE snug_profile (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE snug_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE snug_secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      `CREATE TABLE snug_apps (app_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT,
        icon_emoji TEXT, icon_color TEXT, uses_db INTEGER NOT NULL DEFAULT 0, current_version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE snug_app_versions (app_id TEXT NOT NULL, version INTEGER NOT NULL, html TEXT NOT NULL,
        note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (app_id, version))`,
      `CREATE TABLE snug_chat_threads (thread_id TEXT PRIMARY KEY, app_id TEXT, title TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      `CREATE TABLE snug_chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
      'CREATE TABLE snug_app_data (namespace TEXT PRIMARY KEY, bytes BLOB NOT NULL, updated_at TEXT NOT NULL)',
      'CREATE TABLE snug_sync (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ]) {
      v1.run(ddl);
    }
    v1.run("INSERT INTO snug_apps VALUES ('a1', 'Legacy', NULL, NULL, NULL, 1, 3, 't', 't')");
    for (const version of [2, 3]) {
      v1.run(`INSERT INTO snug_app_versions VALUES ('a1', ${version}, '<html>v${version}</html>', NULL, 't')`);
    }
    v1.run("INSERT INTO snug_app_data VALUES ('a1.sqlite', x'00', 't')");
    v1.run('PRAGMA user_version = 1');
    const v1bytes = v1.export();
    v1.close();

    const migratedBackend = createMemoryBackend();
    await migratedBackend.save(USERDB_FILE, v1bytes);
    const result = await openUserDb({ backend: migratedBackend, locateWasm, persistDebounceMs: 1 });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    const migrated = result.userDb;

    // structural: new surfaces exist and work
    migrated.putAppDoc('a1', 'vision', { content: 'v' });
    expect(migrated.getAppByInstallSource('starter:x')).toBeUndefined();
    // oldest SURVIVING version is stamped as factory
    const versions = migrated.listAppVersions('a1');
    expect(versions.find((v) => v.version === 2)?.pinned).toBe(true);
    expect(versions.find((v) => v.version === 3)?.pinned).toBe(false);
    // blob table is gone; abandoned data does not resurface
    const raw = new SQL.Database(await migrated.exportUserDb({ includeSecrets: true }));
    expect(raw.exec("SELECT name FROM sqlite_master WHERE name = 'snug_app_data'")).toEqual([]);
    const version = raw.exec('PRAGMA user_version');
    expect(version[0]?.values).toEqual([[2]]);
    raw.close();
    await migrated.close();
  });

  it('a v3-from-the-future file is refused, not migrated or overwritten', async () => {
    const SQL = await initSqlJs({ locateFile: locateWasm });
    const future = new SQL.Database();
    future.run('CREATE TABLE snug_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    future.run('PRAGMA user_version = 3');
    const bytes = future.export();
    future.close();
    const futureBackend = createMemoryBackend();
    await futureBackend.save(USERDB_FILE, bytes);
    const result = await openUserDb({ backend: futureBackend, locateWasm, persistDebounceMs: 1 });
    expect(result.status).toBe('unsupported');
  });
});
