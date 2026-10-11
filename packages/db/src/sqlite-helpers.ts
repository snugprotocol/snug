// sqlite-helpers.ts — the tiny sql.js helpers every module of this package that walks a handle
// by hand needs, homed ONCE in a leaf (no userdb, no scoped-read import) so the scoped read and
// the user db quote and step identically (TASK-20261010-cross-app-access W6 fix lane:
// `scoped-read.ts` cannot import `userdb.ts`, which imports it). Since TASK-20261010-host-broker
// PR-3 Gate 5 (W-3, W-10) it also homes the one `errorMessage` and the one `table_xinfo` read.

import type { Database } from 'sql.js';

/** A SQLite identifier, double-quoted, with every embedded `"` doubled. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** A thrown value as its message — the one spelling (Gate-5 W-3), so six modules do not each carry it. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Every row of one statement on `target`, with `params` bound when there are any. */
export function selectRows(target: Database, sql: string, params?: readonly unknown[]): unknown[][] {
  const statement = target.prepare(sql);
  try {
    if (params !== undefined && params.length > 0) statement.bind(params as never);
    const rows: unknown[][] = [];
    while (statement.step()) rows.push(statement.get() as unknown[]);
    return rows;
  } finally {
    statement.free();
  }
}

/**
 * The columns of `table` as `PRAGMA table_xinfo` lists them, by field (Gate-5 W-10): `name` as
 * declared and `hidden` — 0 an ordinary column, 1 a virtual table's hidden column, 2 a virtual
 * generated column, 3 a stored one. The ONE read every column rule of this package filters on,
 * so no caller indexes a pragma row by position.
 */
export function tableColumns(target: Database, table: string): { name: string; hidden: number }[] {
  return selectRows(target, `PRAGMA table_xinfo(${quoteIdent(table)})`).map((row) => ({ name: String(row[1]), hidden: Number(row[6]) }));
}
