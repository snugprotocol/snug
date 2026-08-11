/**
 * TASK-20260811-lean-runtime-data-chat, P0.4 — `db.scratchRun` (ADR-0019, design D7).
 *
 * READ-ONLY BY CONSTRUCTION, NOT BY FLAG. The data lane runs LLM-generated SQL. A
 * `readonly: true` parameter would be a knob, and a knob is something a future call site
 * gets wrong once and silently turns into a write primitive. Instead the statements run
 * against a THROWAWAY sql.js instance opened on an exported copy of the app's materialized
 * runtime DB: a generated `UPDATE` genuinely executes — and dies with the copy. There is
 * no code path from here to the real file, so there is nothing to get wrong (the C1
 * doctrine applied to data).
 *
 * Two bonuses fall out of the same shape: reads stop marking the namespace dirty, and the
 * write-approval flow (D8) gets its dry-run preview for free.
 *
 * NAMESPACE JAIL (AC-F2-3) is INHERITED, not added. The materialized per-app DB is the
 * only thing exported, so another app's tables and every hub table (`snug_secrets`,
 * `snug_connections`, …) are PHYSICALLY ABSENT — the tests below assert they error as
 * missing rather than asserting a name guard, because a name guard would be exactly the
 * bolt-on this design avoids. Stated exemption: `snug_kv` is present (ADR-0010's one
 * exemption) — it is the app's OWN kv, and it is omitted from the schema context shown to
 * the SQL author rather than execution-guarded.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { execFrame, exportFrame, kvSetFrame, locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;
let appId: string;

/** Export the app's materialized bytes — the byte-compare oracle for "the real DB is untouched". */
async function appBytes(id: string): Promise<string> {
  const result = await db.driver.handle(id, exportFrame());
  return result.ok ? (result.bytesBase64 ?? '') : '';
}

/** Seed a row through the REAL driver, so the fixture data lives where an app's data lives. */
async function seed(sql: string, params: unknown[]): Promise<void> {
  const result = await db.driver.handle(appId, execFrame(sql, params));
  if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result)}`);
}

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
  const app = db.installApp({ displayName: 'Budget', html: '<html>v1</html>' });
  appId = app.appId;
  await db.applyAppDdl(appId, [
    'CREATE TABLE expenses (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL, spent_on TEXT)',
  ]);
  for (const row of [
    [1, 'coffee', 450, '2026-08-01'],
    [2, 'rent', 120000, '2026-08-01'],
    [3, 'coffee', 500, '2026-08-05'],
  ]) {
    await seed('INSERT INTO expenses (id, label, cents, spent_on) VALUES (?, ?, ?, ?)', row);
  }
});

describe('reads', () => {
  it('runs a SELECT against the app’s own data and returns rows + columns', async () => {
    const result = await db.scratchRun(appId, [
      { sql: 'SELECT label, SUM(cents) AS total FROM expenses GROUP BY label ORDER BY total DESC' },
    ]);

    expect(result.statements).toHaveLength(1);
    const [first] = result.statements;
    expect(first.error).toBeUndefined();
    expect(first.columns).toEqual(['label', 'total']);
    expect(first.rows).toEqual([
      ['rent', 120000],
      ['coffee', 950],
    ]);
  });

  it('supports bound parameters (the SQL author never string-concatenates values)', async () => {
    const result = await db.scratchRun(appId, [
      { sql: 'SELECT label FROM expenses WHERE cents > ? ORDER BY id', params: [1000] },
    ]);
    expect(result.statements[0]?.rows).toEqual([['rent']]);
  });

  it('runs several statements in sequence, each reported separately', async () => {
    const result = await db.scratchRun(appId, [
      { sql: 'SELECT COUNT(*) FROM expenses' },
      { sql: "SELECT COUNT(*) FROM expenses WHERE label = 'coffee'" },
    ]);
    expect(result.statements.map((s) => s.rows?.[0]?.[0])).toEqual([3, 2]);
  });

  it('a read does NOT mark the namespace dirty (bonus of the throwaway copy)', async () => {
    const before = await appBytes(appId);
    await db.scratchRun(appId, [{ sql: 'SELECT * FROM expenses' }]);
    expect(await appBytes(appId)).toBe(before);
  });
});

describe('D7 — mutations physically cannot reach the real DB', () => {
  it('an UPDATE reports its affected rows but leaves the real DB byte-identical', async () => {
    const before = await appBytes(appId);

    const result = await db.scratchRun(appId, [{ sql: "UPDATE expenses SET cents = 1 WHERE label = 'coffee'" }]);

    expect(result.statements[0]?.error).toBeUndefined();
    expect(result.statements[0]?.changes).toBe(2); // the dry-run preview D8 needs
    expect(await appBytes(appId)).toBe(before);
  });

  it('an INSERT leaves the real DB byte-identical', async () => {
    const before = await appBytes(appId);
    const result = await db.scratchRun(appId, [
      { sql: "INSERT INTO expenses (id, label, cents, spent_on) VALUES (9, 'ghost', 1, '2026-08-09')" },
    ]);
    expect(result.statements[0]?.changes).toBe(1);
    expect(await appBytes(appId)).toBe(before);
  });

  it('a DROP TABLE leaves the real DB byte-identical', async () => {
    const before = await appBytes(appId);
    await db.scratchRun(appId, [{ sql: 'DROP TABLE expenses' }]);
    expect(await appBytes(appId)).toBe(before);
    // and the real table is still queryable afterwards
    const after = await db.scratchRun(appId, [{ sql: 'SELECT COUNT(*) FROM expenses' }]);
    expect(after.statements[0]?.rows?.[0]?.[0]).toBe(3);
  });

  it('reports the RIGHT count for every statement, not just the first', async () => {
    // REGRESSION (whole-surface review, 2026-08-11). The first implementation treated
    // `getRowsModified()` as cumulative per connection and took a delta. It is
    // `sqlite3_changes()` — the count for the LATEST completed statement — so the delta
    // was only correct for the first write and produced NEGATIVE counts afterwards.
    //
    // Verified against the shipped sql.js: DELETE(2 rows) then UPDATE(1 row) yielded
    // [2, -1]. The approval card rendered "-1 row(s)", and the TOCTOU drift check could
    // not catch it because it re-ran the same broken arithmetic on both sides.
    const result = await db.scratchRun(appId, [
      { sql: "DELETE FROM expenses WHERE label = 'coffee'" }, // 2 rows
      { sql: "UPDATE expenses SET cents = 1 WHERE label = 'rent'" }, // 1 row
    ]);

    expect(result.statements.map((statement) => statement.changes)).toEqual([2, 1]);
  });

  it('reports 0 for a write that matches nothing, even after a larger write', async () => {
    const result = await db.scratchRun(appId, [
      { sql: "UPDATE expenses SET cents = 1 WHERE label = 'coffee'" }, // 2 rows
      { sql: 'UPDATE expenses SET cents = 2 WHERE id = 9999' }, // 0 rows
    ]);

    expect(result.statements.map((statement) => statement.changes)).toEqual([2, 0]);
  });

  it('reports a count for a write that also RETURNS rows (RETURNING clause)', async () => {
    // The result shape keyed `changes` on `columns.length === 0`, so a
    // `DELETE ... RETURNING id` carried rows but NO count — the card said "0 row(s)"
    // for a destructive statement, and drift could never fire for it.
    const result = await db.scratchRun(appId, [
      { sql: "DELETE FROM expenses WHERE label = 'coffee' RETURNING id" },
    ]);

    expect(result.statements[0]?.changes).toBe(2);
  });

  it('later statements SEE earlier ones within the same scratch run (a real dry run)', async () => {
    // D8's preview must reflect the batch as a whole: statement 2 has to observe
    // statement 1's effect or the previewed counts would be a lie.
    const result = await db.scratchRun(appId, [
      { sql: "DELETE FROM expenses WHERE label = 'coffee'" },
      { sql: 'SELECT COUNT(*) FROM expenses' },
    ]);
    expect(result.statements[0]?.changes).toBe(2);
    expect(result.statements[1]?.rows?.[0]?.[0]).toBe(1);
  });

  it('two scratch runs are independent — no state leaks between them', async () => {
    await db.scratchRun(appId, [{ sql: 'DELETE FROM expenses' }]);
    const second = await db.scratchRun(appId, [{ sql: 'SELECT COUNT(*) FROM expenses' }]);
    expect(second.statements[0]?.rows?.[0]?.[0]).toBe(3);
  });
});

describe('AC-F2-3 — the namespace jail is physical, not a name guard', () => {
  it('another app’s tables are ABSENT from the scratch copy (the query errors as missing)', async () => {
    const other = db.installApp({ displayName: 'Other', html: '<html>o</html>' });
    await db.applyAppDdl(other.appId, ['CREATE TABLE secrets_of_other (id INTEGER PRIMARY KEY, v TEXT)']);

    const result = await db.scratchRun(appId, [{ sql: 'SELECT * FROM secrets_of_other' }]);

    expect(result.statements[0]?.error).toBeDefined();
    expect(result.statements[0]?.error).toMatch(/no such table/i);
    expect(result.statements[0]?.rows).toBeUndefined();
  });

  it('hub tables are ABSENT — snug_secrets and snug_connections cannot be read', async () => {
    for (const table of ['snug_secrets', 'snug_connections', 'snug_apps', 'snug_app_versions']) {
      const result = await db.scratchRun(appId, [{ sql: `SELECT * FROM ${table}` }]);
      expect(result.statements[0]?.error, table).toMatch(/no such table/i);
    }
  });

  it('the app’s OWN snug_kv IS present once it exists — ADR-0010’s stated exemption, not a breach', async () => {
    // It is excluded from the schema context shown to the SQL author (that is the
    // knob-free way to keep it out of generated queries), but a query naming it is the
    // app's own data and must NOT be execution-guarded — no name guard exists to trip.
    //
    // The table is created lazily on first kv use (driver.ts `ensureKvTable`), so the
    // fixture writes a key first; an app that has never used kv simply has no such table,
    // which is an ordinary missing-table error rather than a jail wall.
    await db.driver.handle(appId, kvSetFrame('theme', 'dark'));

    const result = await db.scratchRun(appId, [{ sql: "SELECT value FROM snug_kv WHERE key = 'theme'" }]);

    expect(result.statements[0]?.error).toBeUndefined();
    expect(result.statements[0]?.rows).toHaveLength(1);
  });
});

describe('statement guards — the same ones the real executor applies', () => {
  it('refuses ATTACH (reaching outside the namespace file)', async () => {
    const result = await db.scratchRun(appId, [{ sql: "ATTACH DATABASE 'other.sqlite' AS other" }]);
    expect(result.statements[0]?.error).toMatch(/ATTACH/i);
  });

  it('refuses load_extension()', async () => {
    const result = await db.scratchRun(appId, [{ sql: "SELECT load_extension('evil.so')" }]);
    expect(result.statements[0]?.error).toMatch(/load_extension/i);
  });

  it('refuses multi-statement text in one entry', async () => {
    const result = await db.scratchRun(appId, [{ sql: 'SELECT 1; DROP TABLE expenses' }]);
    expect(result.statements[0]?.error).toMatch(/one SQL statement|multi/i);
  });

  it('refuses PRAGMA writable_schema — including quoted and qualified spellings (F-Sm3b)', async () => {
    // Pre-existing bypass, verified by execution and closed here: the guard anchored on
    // `PRAGMA\s+writable_schema`, so `PRAGMA "writable_schema"` and
    // `PRAGMA main.writable_schema` sailed past it.
    for (const sql of [
      'PRAGMA writable_schema = ON',
      'PRAGMA "writable_schema" = ON',
      'PRAGMA main.writable_schema = ON',
      "PRAGMA main.'writable_schema' = ON",
      'PRAGMA   writable_schema=1',
    ]) {
      const result = await db.scratchRun(appId, [{ sql }]);
      expect(result.statements[0]?.error, sql).toMatch(/writable_schema/i);
    }
  });

  it('stops the batch at the first refused statement rather than running on', async () => {
    const result = await db.scratchRun(appId, [
      { sql: "ATTACH DATABASE 'x.sqlite' AS x" },
      { sql: 'SELECT COUNT(*) FROM expenses' },
    ]);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]?.error).toMatch(/ATTACH/i);
  });
});

describe('AC-F2-6 — results are bounded before they re-enter the LLM context', () => {
  it('caps rows and says so', async () => {
    await db.applyAppDdl(appId, ['CREATE TABLE big (id INTEGER PRIMARY KEY, v TEXT)']);
    for (let i = 0; i < 260; i++) await seed('INSERT INTO big (id, v) VALUES (?, ?)', [i, `row-${i}`]);

    const result = await db.scratchRun(appId, [{ sql: 'SELECT * FROM big ORDER BY id' }]);

    const first = result.statements[0];
    expect(first?.rows?.length).toBe(200);
    expect(first?.truncated).toBe(true);
    expect(first?.totalRows).toBe(260);
  });

  it('does not flag truncation when the result fits', async () => {
    const result = await db.scratchRun(appId, [{ sql: 'SELECT * FROM expenses' }]);
    expect(result.statements[0]?.truncated).toBeFalsy();
  });

  it('caps result BYTES even when the row count is small', async () => {
    await db.applyAppDdl(appId, ['CREATE TABLE fat (id INTEGER PRIMARY KEY, v TEXT)']);
    for (let i = 0; i < 12; i++) await seed('INSERT INTO fat (id, v) VALUES (?, ?)', [i, 'x'.repeat(8000)]);

    const result = await db.scratchRun(appId, [{ sql: 'SELECT * FROM fat ORDER BY id' }]);

    const first = result.statements[0];
    expect(first?.truncated).toBe(true);
    expect((first?.rows?.length ?? 0)).toBeLessThan(12);
    expect(JSON.stringify(first?.rows).length).toBeLessThanOrEqual(32 * 1024);
  });
});

describe('errors and edges', () => {
  it('reports a SQL error as data rather than throwing', async () => {
    const result = await db.scratchRun(appId, [{ sql: 'SELECT * FROM nope' }]);
    expect(result.statements[0]?.error).toMatch(/no such table/i);
  });

  it('an app with no materialized data yields an empty-but-usable scratch DB', async () => {
    const fresh = db.installApp({ displayName: 'Empty', html: '<html>e</html>' });
    const result = await db.scratchRun(fresh.appId, [{ sql: 'SELECT 1' }]);
    expect(result.statements[0]?.rows).toEqual([[1]]);
  });

  it('throws for an unknown app (a typo must not silently query an empty DB)', async () => {
    await expect(db.scratchRun('no-such-app', [{ sql: 'SELECT 1' }])).rejects.toThrow();
  });

  it('an empty statement list is a no-op', async () => {
    const result = await db.scratchRun(appId, []);
    expect(result.statements).toEqual([]);
  });
});
