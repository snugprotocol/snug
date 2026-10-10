// scoped-read.ts — one read another app was granted, on a SCOPED SCRATCH COPY of the source's
// runtime bytes (TASK-20261010-cross-app-access AC6; ADR-0075 §6; D4, D23).
//
// PURE: no DOM, no Worker, no userdb. The host runs this inside a dedicated Web Worker that
// owns its OWN sql.js instance under a wall clock (sql.js has no interrupt), so the engine
// passes `SQL` in and this module never initialises one.
//
// THE ORDER IS THE CONTRACT:
//  1. open a FRESH database on the bytes — sql.js copies them into its own heap, so the
//     caller's bytes are never mutated, whatever happens below;
//  2. DROP every trigger FIRST (a trigger on a granted table can name a table about to be
//     dropped — SQLite does not validate trigger bodies on a drop — and its DDL text alone
//     would carry that name), then every view, then every table outside the grant, `snug_kv`
//     and the `sqlite_stat*` statistics (they name dropped tables' indexes and count their
//     rows). A non-granted table is therefore PHYSICALLY ABSENT: the read fails with "no such
//     table", there is no name guard to get wrong. The drops are VERIFIED against
//     sqlite_master before anything else runs;
//  3. withhold every credential-named column of a granted table (see below);
//  4. `PRAGMA query_only = 1`;
//  5. the drift check: each granted table's live NON-credential columns (`selectableColumns`
//     — `PRAGMA table_xinfo`, generated columns included, the same list the consent sheet
//     shows — minus `isCredentialKeyName` — D23: such a column is never in a scope, so a
//     source that gains `api_key` has not drifted) against the recorded set; a difference — or
//     a granted table that is gone — answers `drift` and the statement is NOT run;
//  6. the two guards in order — `isReadOnlySelect` (any PRAGMA/ATTACH/DETACH, more than one
//     statement, a CTE write) THEN `forbiddenStatementReason` (load_extension, writable_schema)
//     — a refusal answers `refused` and the statement is NOT run;
//  7. the ONE statement through the shared per-statement runner (`scratch-statement.ts`) under
//     the row cap and a byte cap measured in UTF-8 BYTES (the answer crosses a frame whose
//     class is counted in bytes); `truncated`/`totalRows` exactly as `scratchRun` reports
//     them; a SQL error answers `failed`;
//  8. close the scratch, on every path.
//
// WITHHELD COLUMNS (step 3). A credential-named column is never in a grant's scope, but it
// is physically present in a granted table — and `SELECT api_key AS harmless …` would carry
// its value out under a name no column-keyed mask recognises. So, on the copy and before
// `query_only`, every credential-named column of a granted table is overwritten with the
// mask's own `***` (falling back to NULL, then to a random value, for a column whose
// constraints refuse the literal; triggers are already gone, so the UPDATE fires nothing).
// A generated column derived from it recomputes from the withheld value. If no value can be
// written the read fails closed rather than leak.
//
// FREE-PAGE RESIDUE. Dropped tables leave their bytes in free pages of the copy. They are
// unreachable here: this sql.js build has no `dbstat` and no `sqlite_dbpage` (both pinned by
// the tests), ATTACH and every PRAGMA are refused by the first guard, and `writable_schema`
// by the second — so the copy is not VACUUMed per query.
//
// DISCLOSED RESIDUALS (names and sizes, never row content — review finding 4). "Nothing but
// the granted table" is a claim about OBJECTS and ROWS, not about every name: (a) the granted
// table's OWN DDL may name a non-granted table — a `REFERENCES accounts(id)` clause survives
// in its `sqlite_master.sql` and answers through `pragma_foreign_key_list('transactions')`,
// so one table name and one column name from the source's own constraint text can cross;
// (b) `pragma_freelist_count` (a table-valued pragma the first guard admits inside a SELECT)
// reveals how many pages the dropped objects held. Every reach INTO a dropped table — quoted,
// `main.`-qualified, bracketed, in a subquery, CTE, join or UNION — still fails "no such
// table". The threat-model delta and the spec prose state both residuals beside D23.

import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import { isCredentialKeyName, isReadOnlySelect } from '@snugprotocol/protocol';
import { forbiddenStatementReason } from './driver.js';
import { jsonUtf8Weight, runScratchStatement } from './userdb/scratch-statement.js';

/** The granted tables, each with the columns recorded (FROZEN) at consent — an `AccessScope` satisfies it. */
export interface ScopedReadScope {
  tables: ReadonlyArray<{ name: string; columns: readonly string[] }>;
}

/** The reader's one statement and its bound parameters. */
export interface ScopedReadStatement {
  sql: string;
  params?: readonly unknown[];
}

export interface ScopedReadCaps {
  maxRows: number;
  /** Measured in UTF-8 BYTES of each kept row's JSON. */
  maxBytes: number;
}

/** `table.column` names: what the source added to, or removed from, a granted table since consent. */
export interface ScopedReadDrift {
  added: string[];
  removed: string[];
}

export type ScopedReadResult =
  | { ok: true; columns: string[]; rows: unknown[][]; truncated?: boolean; totalRows?: number }
  | { ok: false; reason: 'drift' | 'refused' | 'failed'; drift?: ScopedReadDrift; message: string };

const KV_TABLE = 'snug_kv';

/** The first guard's refusal — names what IS allowed, so a reader's model can correct itself. */
const NOT_ONE_READ_MESSAGE =
  'only one read-only SELECT (or WITH … SELECT) is allowed — no PRAGMA, ATTACH, DETACH, writes or multiple statements';

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function selectRows(scratch: Database, sql: string, params?: unknown[]): unknown[][] {
  const statement = scratch.prepare(sql, (params ?? []) as BindParams);
  try {
    const rows: unknown[][] = [];
    while (statement.step()) rows.push(statement.get() as unknown[]);
    return rows;
  } finally {
    statement.free();
  }
}

function namesOf(scratch: Database, type: 'trigger' | 'view'): string[] {
  return selectRows(scratch, 'SELECT name FROM sqlite_master WHERE type = ?', [type]).map((row) => String(row[0]));
}

/** Physical absence: triggers, then views, then every table outside the grant (and `snug_kv`, and the statistics). */
function dropOutsideScope(scratch: Database, granted: ReadonlySet<string>): void {
  for (const trigger of namesOf(scratch, 'trigger')) scratch.run(`DROP TRIGGER IF EXISTS ${quoteIdent(trigger)}`);
  for (const view of namesOf(scratch, 'view')) scratch.run(`DROP VIEW IF EXISTS ${quoteIdent(view)}`);
  // Virtual tables first: dropping one takes its shadow tables with it (IF EXISTS covers those).
  const tables = selectRows(scratch, "SELECT name, sql FROM sqlite_master WHERE type = 'table'")
    .map((row) => ({ name: String(row[0]), virtual: /^\s*CREATE\s+VIRTUAL\b/i.test(String(row[1] ?? '')) }))
    .sort((a, b) => Number(b.virtual) - Number(a.virtual));
  for (const { name } of tables) {
    const lower = name.toLowerCase();
    if (lower.startsWith('sqlite_') && !lower.startsWith('sqlite_stat')) continue; // sqlite_sequence &c. cannot be dropped
    if (granted.has(lower) && lower !== KV_TABLE) continue;
    scratch.run(`DROP TABLE IF EXISTS ${quoteIdent(name)}`);
  }
}

/** The belt on the drops: nothing but granted tables (their indexes, SQLite's own bookkeeping) may remain. */
function strayObject(scratch: Database, granted: ReadonlySet<string>): string | undefined {
  for (const row of selectRows(scratch, 'SELECT type, name, tbl_name FROM sqlite_master')) {
    const [type, name, table] = [String(row[0]), String(row[1]), String(row[2]).toLowerCase()];
    if (type === 'trigger' || type === 'view') return name;
    if (type === 'table') {
      const lower = name.toLowerCase();
      if (lower.startsWith('sqlite_stat')) return name;
      if (lower.startsWith('sqlite_')) continue;
      if (!granted.has(lower) || lower === KV_TABLE) return name;
    }
    if (type === 'index' && (!granted.has(table) || table === KV_TABLE)) return name;
  }
  return undefined;
}

/** The value expressions a withheld column is overwritten with, in order: the mask itself, then NULL, then a random value. */
const WITHHELD_VALUES = ["'***'", 'NULL', 'lower(hex(randomblob(16)))', 'abs(random())'] as const;

/**
 * Overwrite every credential-named, non-generated column of each granted table in the copy.
 * Answers the column that could not be withheld, if any.
 */
function withholdCredentialColumns(scratch: Database, tables: readonly string[]): string | undefined {
  scratch.run('PRAGMA ignore_check_constraints = 1');
  for (const table of tables) {
    // table_xinfo: `hidden` 0 is an ordinary column; 1 a virtual table's hidden column; 2/3 generated.
    const columns = selectRows(scratch, `PRAGMA table_xinfo(${quoteIdent(table)})`)
      .filter((row) => Number(row[6]) === 0)
      .map((row) => String(row[1]))
      .filter(isCredentialKeyName);
    for (const column of columns) {
      const withheld = WITHHELD_VALUES.some((value) => {
        try {
          scratch.run(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ${value}`);
          return true;
        } catch {
          return false;
        }
      });
      if (!withheld) return `${table}.${column}`;
    }
  }
  return undefined;
}

/**
 * Every column a SELECT on `table` can name, in declaration order — the ONE definition the
 * drift check and `describeAppData` (the consent sheet) share, so a fresh grant never drifts.
 * `PRAGMA table_xinfo`, not `table_info`: `hidden` 2/3 (generated, virtual or stored) are
 * columns the copy answers and must be disclosed; `hidden` 1 (a virtual table's hidden
 * column) stays out, as `table_info` leaves it (review finding 3).
 */
export function selectableColumns(db: Database, table: string): string[] {
  return selectRows(db, `PRAGMA table_xinfo(${quoteIdent(table)})`)
    .filter((row) => Number(row[6]) !== 1)
    .map((row) => String(row[1]));
}

/** Recorded vs live NON-credential columns of every granted table, as `table.column` names. */
function driftOf(scratch: Database, scope: ScopedReadScope): ScopedReadDrift {
  const added: string[] = [];
  const removed: string[] = [];
  for (const table of scope.tables) {
    const live = selectableColumns(scratch, table.name).filter((column) => !isCredentialKeyName(column));
    const recorded = new Set(table.columns);
    const present = new Set(live);
    for (const column of live) if (!recorded.has(column)) added.push(`${table.name}.${column}`);
    for (const column of table.columns) if (!present.has(column)) removed.push(`${table.name}.${column}`);
  }
  return { added, removed };
}

/**
 * Run ONE read-only statement on a scoped scratch copy of `bytes` — see the header for the
 * order. Never throws: every outcome is data.
 */
export function scopedScratchRead(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  scope: ScopedReadScope,
  statement: ScopedReadStatement,
  caps: ScopedReadCaps,
): ScopedReadResult {
  let scratch: Database | undefined;
  try {
    scratch = new SQL.Database(bytes);
    const granted = new Set(scope.tables.map((table) => table.name.toLowerCase()));

    dropOutsideScope(scratch, granted);
    const stray = strayObject(scratch, granted);
    if (stray !== undefined) return { ok: false, reason: 'failed', message: `the scoped copy still holds "${stray}"` };

    const present = new Set(selectRows(scratch, "SELECT lower(name) FROM sqlite_master WHERE type = 'table'").map((row) => String(row[0])));
    const withheld = withholdCredentialColumns(
      scratch,
      scope.tables.map((table) => table.name).filter((name) => present.has(name.toLowerCase())),
    );
    if (withheld !== undefined) return { ok: false, reason: 'failed', message: `the column ${withheld} could not be withheld` };

    scratch.run('PRAGMA query_only = 1');

    const drift = driftOf(scratch, scope);
    if (drift.added.length > 0 || drift.removed.length > 0) {
      return { ok: false, reason: 'drift', drift, message: 'the granted tables changed since access was allowed' };
    }

    if (!isReadOnlySelect(statement.sql)) return { ok: false, reason: 'refused', message: NOT_ONE_READ_MESSAGE };
    const forbidden = forbiddenStatementReason(statement.sql);
    if (forbidden !== undefined) return { ok: false, reason: 'refused', message: `forbidden statement: ${forbidden}` };

    const outcome = runScratchStatement(scratch, statement.sql, statement.params, {
      maxRows: caps.maxRows,
      maxBytes: caps.maxBytes,
      rowWeight: jsonUtf8Weight,
    });
    if (outcome.error !== undefined) return { ok: false, reason: 'failed', message: outcome.error };
    return {
      ok: true,
      columns: outcome.columns ?? [],
      rows: outcome.rows ?? [],
      ...(outcome.truncated === true ? { truncated: true, totalRows: outcome.totalRows } : {}),
    };
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) };
  } finally {
    scratch?.close(); // the copy — every drop and every withheld value with it — is discarded here
  }
}
