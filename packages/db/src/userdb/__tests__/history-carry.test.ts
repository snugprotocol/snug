/**
 * TASK-20261010-host-broker PR-5 (contract v2 D-PR5-8; AC37's unit half) — the two-device history
 * carry, `packages/db/src/userdb/history-carry.ts`.
 *
 * HISTORY ONLY: `accessLog:*` lines are carried between the two images in BOTH resolutions;
 * `accessUndo:*` and `ownUndo:*` FOLLOW the winning image. Identity = the natural key
 * `(at, kind, grantId, readerAppId)`; a match keeps the WINNER's entry with `count`/`rows` = the
 * max; carried entries are the loser's lines newer than `since` (all when `since` is null) whose
 * source app the winner holds; a carried `wrote` line loses `undoId`; merge newest-first by `at`
 * (tie: the winner's first); then the prune tiers WITHOUT throwing (carried entries give way first;
 * the winner's protected lines never); the winner's unparseable elements kept verbatim.
 * A STOP WINS: a pulled row whose id is in the local tombstone set — parseable or not — is replaced
 * by the local revoked row (`snapshotLocalAccessGrants` keeps the FULL revoked row).
 *
 *   snapshotLocalAccessHistory(sql)                       → the LOSER's history, read before the swap
 *   carryAccessHistory(target, snapshot, {since})         → {carried, dropped} — `target` is the WINNER
 *   applyTombstones(target, revokedRows)                  → how many rows were replaced
 *
 * This lane's reading of the open seats (reported as questions): `carried` counts loser lines ADDED
 * to the winner (a natural-key match is a merge, not a carry); `dropped` counts loser candidates that
 * were not added (an absent source, or a carried line that gave way to a cap), so for the candidates
 * newer than `since`, `carried + dropped + matched = candidates`; `revokedRows` is
 * `snapshotLocalAccessGrants(sql).revoked`, a map of grant id → the full revoked `AccessGrant`.
 *
 * Every handle here is a REAL user-file image (exported by a UserDb, opened raw) — the carry runs on
 * the import candidate and on the live handle, both bare `SettingsSql`.
 */

import {
  ACCESS_LOG_MAX_BYTES,
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_TOTAL_MAX_BYTES,
  USERDB_TABLES,
  accessGrantSchema,
  accessLogEntrySchema,
  utf8ByteLength,
  type AccessGrant,
} from '@snugprotocol/protocol';
import initSqlJs, { type Database } from 'sql.js';
import { afterEach, describe, expect, it } from 'vitest';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend } from '../../persistence.js';
import { snapshotLocalAccessGrants } from '../access.js';
import { accessGrantSettingKey, accessLogSettingKey, accessUndoSettingKey, ownUndoKey } from '../app-settings-keys.js';
import type { SettingsSql } from '../schedules.js';
import { openUserDb, type UserDb } from '../userdb.js';

type HistoryCarryModule = typeof import('../history-carry.js');
const MODULE = '../history-carry.js';
let loading: Promise<HistoryCarryModule> | undefined;
function carryModule(): Promise<HistoryCarryModule> {
  loading ??= import(/* @vite-ignore */ MODULE) as Promise<HistoryCarryModule>;
  return loading;
}

// ------------------------------------------------------------------------------ fixtures

const LEDGER = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const BUDGET = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const SPARE = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const G1 = '9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a';
const G2 = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const UNDO = '8c6f1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';

const at = (hh: number, mm: number, ss = 0): string => `2026-10-12T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.000Z`;

/** One history line, schema-valid. */
const line = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  accessLogEntrySchema.parse({ at: at(10, 0), kind: 'read', grantId: G1, readerAppId: BUDGET, readerName: 'Budget', ...over }) as Record<string, unknown>;

function grant(over: Record<string, unknown> = {}): AccessGrant {
  return accessGrantSchema.parse({
    id: G1,
    readerAppId: BUDGET,
    sourceAppId: LEDGER,
    scope: { tables: [{ name: 'transactions', columns: ['amount', 'category'] }] },
    access: 'read',
    purpose: 'to show spending by category',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: at(9, 0),
    updatedAt: at(9, 0),
    ...over,
  });
}

interface Image {
  sql: SettingsSql;
  /** The `accessLog:<source>` row's elements as stored (raw JSON), or `undefined` when there is no row. */
  log(source: string): unknown[] | undefined;
  /** A settings row's raw value text. */
  raw(key: string): string | undefined;
}

const opened: Database[] = [];
afterEach(() => {
  for (const handle of opened.splice(0)) handle.close();
});

/** A real user-file image shaped by `build` (apps installed, rows written through the accessors or raw), opened raw. */
async function image(build: (db: UserDb) => void): Promise<Image> {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  build(result.userDb);
  const bytes = await result.userDb.exportUserDb({ includeSecrets: true });
  await result.userDb.close();
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const handle = new SQL.Database(bytes);
  opened.push(handle);
  const sql: SettingsSql = {
    select: (text, params) => {
      const stmt = handle.prepare(text, (params ?? []) as never);
      const rows: unknown[][] = [];
      try {
        while (stmt.step()) rows.push(stmt.get());
      } finally {
        stmt.free();
      }
      return rows;
    },
    run: (text, params) => handle.run(text, (params ?? []) as never),
  };
  const raw = (key: string): string | undefined => {
    const row = sql.select(`SELECT value FROM ${USERDB_TABLES.settings} WHERE key = ?`, [key])[0];
    return row === undefined ? undefined : String(row[0]);
  };
  return {
    sql,
    raw,
    log: (source) => {
      const text = raw(accessLogSettingKey(source));
      return text === undefined ? undefined : (JSON.parse(text) as unknown[]);
    },
  };
}

/** Both apps held; the history row written RAW (newest first, as stored) so the fixture is exactly what it says. */
const withHistory =
  (rows: Record<string, unknown[]>, extra?: (db: UserDb) => void) =>
  (db: UserDb): void => {
    db.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger</html>' });
    db.installApp({ appId: BUDGET, displayName: 'Budget', html: '<html>budget</html>' });
    for (const [source, entries] of Object.entries(rows)) db.setSetting(accessLogSettingKey(source), entries);
    extra?.(db);
  };

const ats = (entries: unknown[] | undefined): string[] => (entries ?? []).map((entry) => String((entry as { at?: unknown }).at));

// ================================================================== carryAccessHistory

describe('carryAccessHistory — what is carried, and in what order (D-PR5-8, AC37)', () => {
  it('D-PR5-8 the loser\'s lines the winner lacks are carried; the row is merged newest-first by at', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 2), sql: 'SELECT a' }), line({ at: at(10, 0), kind: 'granted' })] }));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(10, 3), sql: 'SELECT b' }), line({ at: at(10, 1), sql: 'SELECT c' }), line({ at: at(10, 0), kind: 'granted' })] }));

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report).toEqual({ carried: 2, dropped: 0, rewritten: 1 }); // Gate-5 fold G5-7: the carry reports rewritten (rows written)
    expect(ats(winner.log(LEDGER))).toEqual([at(10, 3), at(10, 2), at(10, 1), at(10, 0)]);
    expect((winner.log(LEDGER) ?? []).map((entry) => (entry as { sql?: string }).sql)).toEqual(['SELECT b', 'SELECT a', 'SELECT c', undefined]);
    for (const entry of winner.log(LEDGER) ?? []) expect(accessLogEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('D-PR5-8 a natural-key match keeps the WINNER\'s entry, with count and rows the max of the two', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 5), sql: 'SELECT a', count: 2, rows: 5 }), line({ at: at(10, 4), sql: 'SELECT b', rows: 1 })] }));
    const loser = await image(
      withHistory({ [LEDGER]: [line({ at: at(10, 5), sql: 'SELECT other', count: 3, rows: 4, attended: false }), line({ at: at(10, 4), sql: 'SELECT b', count: 4, rows: 9 })] }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report.carried).toBe(0);
    expect(winner.log(LEDGER)).toEqual([
      line({ at: at(10, 5), sql: 'SELECT a', count: 3, rows: 5 }),
      line({ at: at(10, 4), sql: 'SELECT b', count: 4, rows: 9 }),
    ]);
  });

  it('D-PR5-8 the natural key is (at, kind, grantId, readerAppId) — a difference in any one is another line', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const base = { at: at(10, 5), kind: 'read', grantId: G1, readerAppId: BUDGET };
    const winner = await image(withHistory({ [LEDGER]: [line(base)] }));
    const loser = await image(
      withHistory({
        [LEDGER]: [line({ ...base, kind: 'refused', reason: 'not now' }), line({ ...base, grantId: G2 }), line({ ...base, readerAppId: SPARE, readerName: 'Spare' }), line({ ...base, sql: 'SELECT a' })],
      }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report.carried).toBe(3); // the fourth differs only in sql: the same line
    expect(winner.log(LEDGER)).toHaveLength(4);
  });

  it('D-PR5-8 since: only the loser\'s lines NEWER than since are candidates', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(9, 0), kind: 'granted' })] }));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(10, 3), sql: 'SELECT new' }), line({ at: at(10, 1), sql: 'SELECT old' }), line({ at: at(9, 0), kind: 'granted' })] }));

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: at(10, 2) });

    expect(report).toEqual({ carried: 1, dropped: 0, rewritten: 1 }); // Gate-5 fold G5-7: the carry reports rewritten (rows written)
    expect(ats(winner.log(LEDGER))).toEqual([at(10, 3), at(9, 0)]);
  });

  it('D-PR5-8 a tie on at puts the WINNER\'s line first', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), grantId: G1, sql: 'SELECT winner' })] }));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), grantId: G2, sql: 'SELECT loser' })] }));

    carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect((winner.log(LEDGER) ?? []).map((entry) => (entry as { sql?: string }).sql)).toEqual(['SELECT winner', 'SELECT loser']);
  });

  it('D-PR5-8 a carried wrote line loses its undoId — the winner holds no such entry; the winner\'s own keeps its', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerWrote = line({ at: at(10, 1), kind: 'wrote', grantId: G2, authority: 'permission', changes: 2, undoId: UNDO, via: 'app' });
    const winner = await image(withHistory({ [LEDGER]: [winnerWrote] }));
    const loser = await image(
      withHistory({ [LEDGER]: [line({ at: at(10, 4), kind: 'undone', changes: 1, via: 'user' }), line({ at: at(10, 3), kind: 'wrote', authority: 'approval', changes: 1, undoId: crypto.randomUUID(), via: 'chat' })] }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report.carried).toBe(2);
    const merged = (winner.log(LEDGER) ?? []) as Array<Record<string, unknown>>;
    expect(merged.map((entry) => entry.kind)).toEqual(['undone', 'wrote', 'wrote']);
    expect('undoId' in (merged[1] ?? {})).toBe(false);
    expect(merged[1]).toMatchObject({ kind: 'wrote', authority: 'approval', changes: 1, via: 'chat' });
    expect(merged[2]).toEqual(winnerWrote);
  });

  it('D-PR5-8 a source the winner does not hold is dropped — counted, and no row is written for it', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({}));
    const loser = await image(
      withHistory({}, (db) => {
        db.installApp({ appId: SPARE, displayName: 'Spare', html: '<html>spare</html>' });
        db.setSetting(accessLogSettingKey(SPARE), [line({ at: at(10, 1) }), line({ at: at(10, 0), kind: 'granted' })]);
        db.setSetting(accessLogSettingKey(LEDGER), [line({ at: at(10, 2) })]);
      }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report).toEqual({ carried: 1, dropped: 2, rewritten: 1 }); // Gate-5 fold G5-7: the carry reports rewritten (rows written)
    expect(winner.raw(accessLogSettingKey(SPARE))).toBeUndefined();
    expect(ats(winner.log(LEDGER))).toEqual([at(10, 2)]);
  });

  it('D-PR5-8 the loser\'s unreadable elements are never carried; the winner\'s are kept verbatim', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerJunk = { kind: 'read', grantId: 'not-a-uuid', at: at(10, 0) };
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 1) }), winnerJunk, 'garbage'] }));
    const loser = await image(withHistory({ [LEDGER]: [{ junk: true }, line({ at: at(10, 2), sql: 'SELECT b' }), 42] }));

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report.carried).toBe(1);
    const merged = winner.log(LEDGER) ?? [];
    expect(merged).toContainEqual(winnerJunk);
    expect(merged).toContain('garbage');
    expect(merged).not.toContainEqual({ junk: true });
    expect(merged).not.toContain(42);
    expect(merged.filter((entry) => accessLogEntrySchema.safeParse(entry).success)).toHaveLength(2);
  });

  it('D-PR5-8 the journals FOLLOW the winner — no accessUndo: or ownUndo: row is carried, and the winner\'s are untouched', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerJournal = [{ id: UNDO, note: 'the winner\'s' }];
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0) })] }, (db) => db.setSetting(accessUndoSettingKey(LEDGER), winnerJournal)));
    const loser = await image(
      withHistory({ [LEDGER]: [line({ at: at(10, 1), sql: 'SELECT b' })] }, (db) => {
        db.setSetting(accessUndoSettingKey(BUDGET), [{ id: crypto.randomUUID(), note: 'the loser\'s' }]);
        db.setSetting(ownUndoKey(LEDGER, 'approval'), [{ id: crypto.randomUUID() }]);
      }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report.carried).toBe(1); // the history moved …
    expect(winner.raw(accessUndoSettingKey(LEDGER))).toBe(JSON.stringify(winnerJournal)); // … the journals did not
    expect(winner.raw(accessUndoSettingKey(BUDGET))).toBeUndefined();
    expect(winner.raw(ownUndoKey(LEDGER, 'approval'))).toBeUndefined();
  });
});

describe('carryAccessHistory — the caps never throw (D-PR5-8, AC37)', () => {
  it('D-PR5-8 the entry cap: carried lines give way first, the winner keeps every line', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerLines = Array.from({ length: ACCESS_LOG_MAX_ENTRIES - 5 }, (_, i) => line({ at: at(8, Math.floor(i / 60), i % 60), sql: `SELECT w${i}` }));
    const loserLines = Array.from({ length: 10 }, (_, i) => line({ at: at(11, i), sql: `SELECT l${i}` }));
    const winner = await image(withHistory({ [LEDGER]: [...winnerLines].reverse() }));
    const loser = await image(withHistory({ [LEDGER]: [...loserLines].reverse() }));

    let report: { carried: number; dropped: number } | undefined;
    expect(() => {
      report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });
    }).not.toThrow();

    const merged = winner.log(LEDGER) ?? [];
    expect(merged).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
    for (const kept of winnerLines) expect(merged).toContainEqual(kept);
    expect(report).toEqual({ carried: 5, dropped: 5, rewritten: 1 }); // Gate-5 fold G5-7: the carry reports rewritten (rows written)
  });

  it('D-PR5-8 the byte cap: the row stays within ACCESS_LOG_MAX_BYTES and the winner keeps its line', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerLine = line({ at: at(8, 0), kind: 'granted' });
    const long = (i: number): string => `SELECT ${String(i).padStart(3, '0')} ${'x'.repeat(185)}`;
    const loserLines = Array.from({ length: 190 }, (_, i) => line({ at: at(10, Math.floor(i / 60), i % 60), sql: long(i), tables: ['transactions', 'accounts'] }));
    const winner = await image(withHistory({ [LEDGER]: [winnerLine] }));
    const loser = await image(withHistory({ [LEDGER]: [...loserLines].reverse() }));
    expect(utf8ByteLength(JSON.stringify(loserLines))).toBeGreaterThan(ACCESS_LOG_MAX_BYTES); // the fixture really crosses the cap

    let report: { carried: number; dropped: number } | undefined;
    expect(() => {
      report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });
    }).not.toThrow();

    expect(utf8ByteLength(winner.raw(accessLogSettingKey(LEDGER)) ?? '')).toBeLessThanOrEqual(ACCESS_LOG_MAX_BYTES);
    expect(winner.log(LEDGER)).toContainEqual(winnerLine);
    expect(report?.carried).toBeGreaterThan(0);
    expect((report?.carried ?? 0) + (report?.dropped ?? 0)).toBe(190);
  });

  it('D-PR5-8 the winner\'s protected lines never give way — a full row of latest lifecycle lines carries nothing, and nothing throws', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winnerLines = Array.from({ length: ACCESS_LOG_MAX_ENTRIES }, (_, i) => line({ at: at(9, Math.floor(i / 60), i % 60), kind: 'granted', grantId: crypto.randomUUID() }));
    const winner = await image(withHistory({ [LEDGER]: [...winnerLines].reverse() }));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(11, 0) }), line({ at: at(11, 1) }), line({ at: at(11, 2) })] }));
    const before = winner.raw(accessLogSettingKey(LEDGER));

    let report: { carried: number; dropped: number } | undefined;
    expect(() => {
      report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });
    }).not.toThrow();

    expect(report).toEqual({ carried: 0, dropped: 3, rewritten: 0 }); // Gate-5 fold G5-7: the carry reports rewritten (rows written)
    expect(JSON.parse(winner.raw(accessLogSettingKey(LEDGER)) ?? '[]')).toEqual(JSON.parse(before ?? '[]'));
  });

  it('D-PR5-8 total: a loser row that is not an array, or not JSON, carries nothing and throws nothing', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0) })] }));
    const loser = await image(
      withHistory({}, (db) => {
        db.setSetting(accessLogSettingKey(LEDGER), { not: 'an array' });
        db.setSetting(accessLogSettingKey(BUDGET), 'not json either');
      }),
    );

    let report: { carried: number; dropped: number } | undefined;
    expect(() => {
      report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });
    }).not.toThrow();
    expect(report?.carried).toBe(0);
    expect(ats(winner.log(LEDGER))).toEqual([at(10, 0)]);
  });
});

// ======================================================================= the tombstones

describe('applyTombstones — a stop wins across a sync (D-PR5-8, AC37)', () => {
  const stoppedAt = at(11, 0);
  const revoked = grant({ status: 'revoked', revokedAt: stoppedAt, updatedAt: stoppedAt });

  it('D-PR5-8 snapshotLocalAccessGrants keeps the FULL revoked row (what a tombstone writes back)', async () => {
    const local = await image(withHistory({}, (db) => db.putAccessGrant(revoked)));
    expect(snapshotLocalAccessGrants(local.sql).revoked.get(G1)).toEqual(revoked);
  });

  it('D-PR5-8 a pulled ACTIVE row for a tombstoned id becomes the local revoked row — and is counted', async () => {
    const { applyTombstones } = await carryModule();
    const local = await image(withHistory({}, (db) => db.putAccessGrant(revoked)));
    const pulled = await image(withHistory({}, (db) => db.putAccessGrant(grant({ reads: 9, updatedAt: at(10, 30) }))));

    const replaced = applyTombstones(pulled.sql, snapshotLocalAccessGrants(local.sql).revoked);

    expect(replaced).toBe(1);
    expect(JSON.parse(pulled.raw(accessGrantSettingKey(G1)) ?? 'null')).toEqual(revoked);
  });

  it('D-PR5-8 a pulled row that does NOT parse, for a tombstoned id, is replaced too', async () => {
    const { applyTombstones } = await carryModule();
    const local = await image(withHistory({}, (db) => db.putAccessGrant(revoked)));
    const pulled = await image(withHistory({}, (db) => db.setSetting(accessGrantSettingKey(G1), { id: G1, status: 'active', auditTrail: 'a newer hub\'s field' })));

    const replaced = applyTombstones(pulled.sql, snapshotLocalAccessGrants(local.sql).revoked);

    expect(replaced).toBe(1);
    expect(JSON.parse(pulled.raw(accessGrantSettingKey(G1)) ?? 'null')).toEqual(revoked);
  });

  it('D-PR5-8 a row with no tombstone is untouched; nothing to replace counts 0', async () => {
    const { applyTombstones } = await carryModule();
    const local = await image(withHistory({}, (db) => db.putAccessGrant(revoked)));
    const other = grant({ id: G2 });
    const pulled = await image(withHistory({}, (db) => db.putAccessGrant(other)));
    const before = pulled.raw(accessGrantSettingKey(G2));

    expect(applyTombstones(pulled.sql, snapshotLocalAccessGrants(local.sql).revoked)).toBe(0);
    expect(pulled.raw(accessGrantSettingKey(G2))).toBe(before);
  });
});

// =================================================================================================
// TASK-20261010-host-broker PR-5 Gate 5 — G5-7 [DB-7] and G5-8 [DB-8].
//
// G5-7: `carryAccessHistory` reports `rewritten` — the history ROWS it wrote (a count-only merge is a
// write) — so its callers mark the file dirty and move the loop on any write; and a loser line whose
// NATURAL KEY exists on both sides is a candidate whatever its `at`: a coalesced group that began
// before `since` and grew after it keeps the larger count (only the max-merge applies — a line the
// winner LACKS still obeys `since`).
// G5-8 (pins only): the carry's cross-source CEILING pass (ACCESS_LOG_TOTAL_MAX_BYTES).
// =================================================================================================

describe('G5-7 — rewritten, and a natural key on both sides is a candidate whatever its at (DB-7)', () => {
  it('G5-7 a recount-only carry reports rewritten 1 and carried 0 — the row was written', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), sql: 'SELECT g', count: 2 })] }));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), sql: 'SELECT g', count: 5 })] }));

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report).toEqual({ carried: 0, dropped: 0, rewritten: 1 });
    expect(winner.log(LEDGER)).toEqual([line({ at: at(10, 0), sql: 'SELECT g', count: 5 })]);
  });

  it('G5-7 a carry that changes nothing reports rewritten 0 and leaves the row byte-identical', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const rows = { [LEDGER]: [line({ at: at(10, 0), sql: 'SELECT g', count: 5 })] };
    const winner = await image(withHistory(rows));
    const loser = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), sql: 'SELECT g', count: 2 })] }));
    const before = winner.raw(accessLogSettingKey(LEDGER));

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report).toEqual({ carried: 0, dropped: 0, rewritten: 0 });
    expect(winner.raw(accessLogSettingKey(LEDGER))).toBe(before);
  });

  it('G5-7 rewritten counts ROWS, not lines — lines carried into two sources are 2', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(9, 0), kind: 'granted' })], [BUDGET]: [line({ at: at(9, 0), kind: 'granted', grantId: G2 })] }));
    const loser = await image(
      withHistory({
        [LEDGER]: [line({ at: at(10, 2), sql: 'SELECT b' }), line({ at: at(10, 1), sql: 'SELECT a' })],
        [BUDGET]: [line({ at: at(10, 3), grantId: G2, sql: 'SELECT c' })],
      }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });

    expect(report).toEqual({ carried: 3, dropped: 0, rewritten: 2 });
  });

  it('G5-7 a group that began BEFORE since and grew after it keeps the larger count; a line the winner lacks still obeys since', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const winner = await image(withHistory({ [LEDGER]: [line({ at: at(10, 0), sql: 'SELECT g', count: 2, rows: 1 })] }));
    const loser = await image(
      withHistory({
        [LEDGER]: [
          line({ at: at(10, 0, 20), sql: 'SELECT old' }), // ≤ since and the winner lacks it: not a candidate
          line({ at: at(10, 0), sql: 'SELECT g', count: 6, rows: 3 }), // the same group, grown past since
        ],
      }),
    );

    const report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: at(10, 0, 30) });

    expect(winner.log(LEDGER)).toEqual([line({ at: at(10, 0), sql: 'SELECT g', count: 6, rows: 3 })]);
    expect(report).toEqual({ carried: 0, dropped: 0, rewritten: 1 });
  });
});

describe('G5-8 — the carry\'s cross-source ceiling pass (ACCESS_LOG_TOTAL_MAX_BYTES; DB-8)', () => {
  /** A full-ish history row for some other source: schema-valid reads, serialized just under ACCESS_LOG_MAX_BYTES. */
  function fullRow(grantId: string, budget: number): unknown[] {
    const entries: unknown[] = [];
    for (let i = 0; ; i += 1) {
      const next = line({ at: at(7, Math.floor(i / 60) % 60, i % 60), grantId, sql: `SELECT ${String(i).padStart(3, '0')} ${'f'.repeat(189)}` });
      if (utf8ByteLength(JSON.stringify([...entries, next])) > budget || entries.length === ACCESS_LOG_MAX_ENTRIES) return entries;
      entries.push(next);
    }
  }

  it('G5-8 sixteen near-full sources: the carry adds nothing beyond the ceiling, the oldest carried lines give way first, every winner line is byte-identical, nothing throws, and a source whose carried lines all gave way gets no write', async () => {
    const { snapshotLocalAccessHistory, carryAccessHistory } = await carryModule();
    const fillers = Array.from({ length: 16 }, () => crypto.randomUUID());
    const ledgerGranted = line({ at: at(9, 0), kind: 'granted' });
    const budgetGranted = line({ at: at(9, 0), kind: 'granted', grantId: G2 });
    const winner = await image(
      withHistory({ [LEDGER]: [ledgerGranted], [BUDGET]: [budgetGranted] }, (db) => {
        for (const source of fillers) db.setSetting(accessLogSettingKey(source), fullRow(G1, ACCESS_LOG_MAX_BYTES - 300));
      }),
    );
    // BUDGET's carried lines are the OLDEST reads, so they give way first; LEDGER's newer ones keep what room is left.
    const budgetReads = Array.from({ length: 5 }, (_, i) => line({ at: at(9, 10 + i), grantId: G2, sql: `SELECT b${i} ${'b'.repeat(180)}` }));
    const ledgerReads = Array.from({ length: 30 }, (_, i) => line({ at: at(11, i), sql: `SELECT l${i} ${'l'.repeat(180)}` }));
    const loser = await image(withHistory({ [LEDGER]: [...ledgerReads].reverse(), [BUDGET]: [...budgetReads].reverse() }));

    const rowsBefore = new Map([...fillers, LEDGER, BUDGET].map((source) => [source, winner.raw(accessLogSettingKey(source))]));
    const totalOf = (): number => [...fillers, LEDGER, BUDGET].reduce((sum, source) => sum + utf8ByteLength(winner.raw(accessLogSettingKey(source)) ?? ''), 0);
    for (const source of fillers) {
      const row = JSON.parse(winner.raw(accessLogSettingKey(source)) ?? '[]') as unknown[];
      expect(row.length).toBeLessThanOrEqual(ACCESS_LOG_MAX_ENTRIES); // each filler is a row the caps admit …
      expect(utf8ByteLength(JSON.stringify(row))).toBeGreaterThan(ACCESS_LOG_MAX_BYTES - 700); // … and near-full
    }
    // The fixture really binds on the CEILING, not on a per-source cap: the winner is under it, the carry would cross it, and LEDGER alone stays far under its own cap.
    expect(totalOf()).toBeLessThan(ACCESS_LOG_TOTAL_MAX_BYTES);
    expect(totalOf() + utf8ByteLength(JSON.stringify([...ledgerReads, ...budgetReads]))).toBeGreaterThan(ACCESS_LOG_TOTAL_MAX_BYTES);
    expect(utf8ByteLength(JSON.stringify([...ledgerReads, ledgerGranted]))).toBeLessThan(ACCESS_LOG_MAX_BYTES);

    let report: { carried: number; dropped: number } | undefined;
    expect(() => {
      report = carryAccessHistory(winner.sql, snapshotLocalAccessHistory(loser.sql), { since: null });
    }).not.toThrow();

    // Nothing beyond the ceiling.
    expect(totalOf()).toBeLessThanOrEqual(ACCESS_LOG_TOTAL_MAX_BYTES);
    // Every candidate is carried or dropped; some gave way, some were carried.
    expect((report?.carried ?? 0) + (report?.dropped ?? 0)).toBe(35);
    expect(report?.dropped).toBeGreaterThanOrEqual(5);
    expect(report?.carried).toBeGreaterThan(0);
    // The fillers are untouched, byte for byte.
    for (const source of fillers) expect(winner.raw(accessLogSettingKey(source)), source).toBe(rowsBefore.get(source));
    // BUDGET's carried lines all gave way: its row is not written at all.
    expect(winner.raw(accessLogSettingKey(BUDGET))).toBe(rowsBefore.get(BUDGET));
    // LEDGER keeps its own line and exactly `carried` of the loser's — the NEWEST ones.
    const ledger = winner.log(LEDGER) ?? [];
    expect(ledger).toContainEqual(ledgerGranted);
    expect(ledger).toHaveLength((report?.carried ?? 0) + 1);
    const kept = ledger.filter((entry) => (entry as { kind?: string }).kind === 'read');
    expect(ats(kept)).toEqual(ats([...ledgerReads].reverse().slice(0, report?.carried ?? 0)));
  });
});
