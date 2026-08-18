// app-model-setting.test.ts — TASK-20260817-per-app-model-selector, the DB half.
//
// The per-app model pick is stored as a namespaced key in the EXISTING free-form
// `snug_settings` KV (`appModel:<appId>`), not as a column on `snug_apps` (ADR-0036 D2).
// That choice buys no schema-version bump and no migration; its one price is that
// `snug_settings` is not app-keyed, so the cascade in `deleteApp` must be taught about
// it explicitly — exactly as it was taught about the `auth:<appId>:*` secrets slice
// (step 3b). The delete-app suite's own header states the rule this file exercises:
// there are ZERO foreign keys in the user DB, so "cascade" is entirely hand-written and
// a missed table is a SILENT orphan.
//
// AC4 (DB half): the pick survives a real write/read round trip through the file bytes.
// AC9: `deleteApp` removes it, and — the part a naive test misses — removes ONLY it.

import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { USERDB_FILE, USERDB_TABLES } from '@snugprotocol/protocol';

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

/**
 * Read the user-DB file straight out of the backend and query it independently — the
 * same technique the delete-app suite uses. Asserting through a second sql.js handle
 * over the persisted BYTES (rather than through `db`'s own accessors) is what makes this
 * a state assertion instead of a return-value assertion: an accessor that answers from a
 * stale in-memory map would pass the latter and fail this.
 */
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

/** The key shape under test. Deliberately restated here rather than imported: if the
 *  production spelling changes, this file must be edited too — the pin is the point. */
const appModelKey = (appId: string): string => `appModel:${appId}`;

describe('per-app model setting — persistence (AC4)', () => {
  it('round-trips a pick through the persisted file bytes', async () => {
    const app = db.installApp({ displayName: 'chess', html: '<html>v1</html>' });
    db.setSetting(appModelKey(app.appId), 'claude-opus-5');

    const persisted = await readUserDbTables();
    const rows = persisted.query(`SELECT value FROM ${USERDB_TABLES.settings} WHERE key = ?`, [
      appModelKey(app.appId),
    ]);
    expect(rows).toHaveLength(1);
    // Values are JSON-encoded by the generic kvSet, so the stored cell is a JSON string.
    expect(JSON.parse(String(rows[0]?.[0]))).toBe('claude-opus-5');

    expect(db.getSetting(appModelKey(app.appId))).toBe('claude-opus-5');
  });

  it('keeps two apps picks independent (AC5, at the storage altitude)', async () => {
    const a = db.installApp({ displayName: 'a', html: '<html>a</html>' });
    const b = db.installApp({ displayName: 'b', html: '<html>b</html>' });
    db.setSetting(appModelKey(a.appId), 'claude-opus-5');
    db.setSetting(appModelKey(b.appId), 'gpt-4o');

    expect(db.getSetting(appModelKey(a.appId))).toBe('claude-opus-5');
    expect(db.getSetting(appModelKey(b.appId))).toBe('gpt-4o');
    // And neither touched the GLOBAL default, which lives at the bare `model` key.
    expect(db.getSetting('model')).toBeUndefined();
  });
});

describe('per-app model setting — cascade on deleteApp (AC9)', () => {
  it('deletes the deleted app’s pick', async () => {
    const app = db.installApp({ displayName: 'chess', html: '<html>v1</html>' });
    db.setSetting(appModelKey(app.appId), 'claude-opus-5');
    await db.flush();

    // Precondition — the seed really did store it, so a later absence means the delete
    // did the work rather than the write never having happened.
    const before = await readUserDbTables();
    expect(
      before.query(`SELECT 1 FROM ${USERDB_TABLES.settings} WHERE key = ?`, [appModelKey(app.appId)]),
    ).toHaveLength(1);

    await db.deleteApp(app.appId);

    const after = await readUserDbTables();
    expect(
      after.query(`SELECT 1 FROM ${USERDB_TABLES.settings} WHERE key = ?`, [appModelKey(app.appId)]),
    ).toHaveLength(0);
  });

  it('leaves every OTHER app’s pick and the global settings untouched', async () => {
    const doomed = db.installApp({ displayName: 'doomed', html: '<html>a</html>' });
    const keeper = db.installApp({ displayName: 'keeper', html: '<html>b</html>' });
    db.setSetting(appModelKey(doomed.appId), 'claude-opus-5');
    db.setSetting(appModelKey(keeper.appId), 'gpt-4o');
    // The global keys the hub relies on. A prefix delete written as `LIKE 'appModel:%'`
    // — or worse, one that swept `snug_settings` broadly — would take these with it, and
    // the user would lose their provider/mode config by deleting an unrelated app.
    db.setSetting('model', 'claude-sonnet-5');
    db.setSetting('provider', 'anthropic');
    db.setSetting('mode', 'byok');
    await db.flush();

    await db.deleteApp(doomed.appId);

    expect(db.getSetting(appModelKey(doomed.appId))).toBeUndefined();
    expect(db.getSetting(appModelKey(keeper.appId))).toBe('gpt-4o');
    expect(db.getSetting('model')).toBe('claude-sonnet-5');
    expect(db.getSetting('provider')).toBe('anthropic');
    expect(db.getSetting('mode')).toBe('byok');
  });

  it('deletes an app that never had a pick without throwing', async () => {
    // The common case: most apps inherit and never store a row at all. A cascade that
    // assumed a row exists (or that reported a failure when the DELETE matched nothing)
    // would break the ordinary delete path.
    const app = db.installApp({ displayName: 'plain', html: '<html>v1</html>' });
    await db.flush();
    await expect(db.deleteApp(app.appId)).resolves.toBeUndefined();
    expect(db.getApp(app.appId)).toBeUndefined();
  });
});
