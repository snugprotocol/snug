// sqlite-helpers.ts — the two tiny sql.js helpers every module of this package that walks a
// handle by hand needs, homed ONCE in a leaf (no userdb, no scoped-read import) so the scoped
// read and the user db quote and step identically (TASK-20261010-cross-app-access W6 fix lane:
// `scoped-read.ts` cannot import `userdb.ts`, which imports it).

import type { Database } from 'sql.js';

/** A SQLite identifier, double-quoted, with every embedded `"` doubled. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

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
