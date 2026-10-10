// scratch-statement.ts — the ONE per-statement runner over a throwaway sql.js handle
// (TASK-20261010-cross-app-access, ADR-0075 §6).
//
// Two callers run app- or AI-authored SQL on a scratch copy and must answer it the same way:
// `scratchRun` (the data lane's read-only-by-construction executor, ADR-0019 D7) and
// `scopedScratchRead` (another app's granted read, ADR-0075 §6). Both used to need the same
// loop — one statement out of the text, the single-statement tail check, the bind, the step
// under a row cap and a byte cap, BLOB normalisation, and the modifying-statement count —
// so it lives here ONCE and each caller supplies only what differs: how a kept row is
// weighed against the byte cap. `scratchRun` weighs JSON CHARACTERS (its historical
// behaviour, pinned by scratch-run.test.ts); the scoped read weighs UTF-8 BYTES, because its
// answer crosses a frame whose class is measured in bytes.
//
// The statement GUARDS are not here: each caller applies its own, in its own order, before
// it calls in (`scratchRun`: `forbiddenStatementReason`; the scoped read: `isReadOnlySelect`
// then `forbiddenStatementReason`). Pure — no DOM, no Worker, no userdb import — so the
// access engine's Worker can bundle it.

import type { BindParams, Database, Statement } from 'sql.js';
import { utf8ByteLength } from '@snugprotocol/protocol';
import { isRowModifyingStatement, isSqlTailEmpty, normalizeCell } from '../driver.js';

/** How one kept row is weighed against `maxBytes`. */
export type RowWeight = (row: readonly unknown[]) => number;

/** `scratchRun`'s measure: JSON characters (UTF-16 code units). Kept for its pinned behaviour. */
export const jsonCharWeight: RowWeight = (row) => JSON.stringify(row).length;

/** The scoped read's measure: JSON UTF-8 bytes — what a frame's size class counts. */
export const jsonUtf8Weight: RowWeight = (row) => utf8ByteLength(JSON.stringify(row));

export interface StatementCaps {
  /** Rows kept before the answer is `truncated`. */
  maxRows: number;
  /** Total weight of kept rows before the answer is `truncated`. */
  maxBytes: number;
  rowWeight: RowWeight;
}

/**
 * One statement's outcome — rows/columns for a read, `changes` for a write (the dry-run
 * preview), or `error` instead of both. Errors are DATA here, exactly as in the driver.
 */
export interface StatementOutcome {
  rows?: unknown[][];
  columns?: string[];
  /** Rows the statement would affect — attached to every MODIFYING statement, and only to those. */
  changes?: number;
  /** True when `rows` was cut by the row or byte cap. */
  truncated?: boolean;
  /** Rows the query actually produced, present only when `truncated`. */
  totalRows?: number;
  error?: string;
}

/** The refusal for text holding more than one statement — the wording `scratchRun` has always used. */
export const SINGLE_STATEMENT_MESSAGE = 'exec accepts exactly one SQL statement — split multi-statement scripts into separate entries';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Run ONE statement of `sql` on `scratch` under `caps`. Never throws: a SQL error, an empty
 * text or a multi-statement text answers `{ error }`.
 */
export function runScratchStatement(
  scratch: Database,
  sql: string,
  params: readonly unknown[] | undefined,
  caps: StatementCaps,
): StatementOutcome {
  let statement: Statement | undefined;
  try {
    const iterator = scratch.iterateStatements(sql);
    const first = iterator.next();
    if (first.done === true) return { error: 'no SQL statement to execute' };
    statement = first.value;
    if (!isSqlTailEmpty(iterator.getRemainingSQL())) return { error: SINGLE_STATEMENT_MESSAGE };
    if (params !== undefined && params.length > 0) {
      statement.bind(params.map((p) => (p === undefined ? null : p)) as BindParams);
    }
    const columns = statement.getColumnNames();
    const rows: unknown[][] = [];
    let totalRows = 0;
    let truncated = false;
    let weight = 0;
    while (statement.step()) {
      totalRows += 1;
      if (truncated) continue; // keep counting so `totalRows` is honest
      const row = (statement.get() as unknown[]).map(normalizeCell);
      // The byte cap is checked BEFORE the row is kept: a single fat row must not push the
      // payload past the cap it exists to enforce.
      weight += caps.rowWeight(row);
      if (rows.length >= caps.maxRows || weight > caps.maxBytes) {
        truncated = true;
        continue;
      }
      rows.push(row);
    }
    /**
     * `getRowsModified()` is `sqlite3_changes()` — the count for the LATEST completed
     * statement, NOT a running total for the connection.
     *
     * This was implemented as a delta against a previous reading, which is right only for
     * the first write and produces NEGATIVE counts afterwards (verified: DELETE 2 rows then
     * UPDATE 1 row reported `[2, -1]`). The approval card rendered that number, and the
     * TOCTOU drift check could not catch it because it re-ran the same arithmetic on both
     * sides and got the same wrong answer. Found by the P4 whole-surface review;
     * regression-tested in scratch-run.
     *
     * The count is attached to every MODIFYING statement, including one with a `RETURNING`
     * clause. Keying it on `columns.length === 0` meant a `DELETE … RETURNING id` carried
     * rows but no count, so the card said "0 row(s)" for a destructive statement and drift
     * could never fire for it — and the statement text is the model's to choose.
     *
     * But `sqlite3_changes()` is also STICKY (R-M1, 2026-08-11): it keeps reporting the last
     * modifying statement's count for every statement that follows. A `DELETE` then `SELECT`
     * batch therefore previewed as `[3, 3]`, and the approval card told the user a SELECT
     * would change 3 rows. Worse, that second number is not an independent measurement — it
     * is a copy of the first — so the TOCTOU drift check could never derive a real signal
     * from it.
     *
     * The discriminator is the statement's KIND, not a runtime counter: a DELETE matching
     * nothing must still report 0 (the user needs to see it), while a SELECT must report
     * nothing at all. `total_changes()` cannot tell those two apart — both leave it
     * untouched — which is why this keys off the verb.
     */
    const modifies = isRowModifyingStatement(sql);
    return {
      ...(columns.length > 0 ? { rows, columns } : {}),
      ...(modifies ? { changes: scratch.getRowsModified() } : {}),
      ...(truncated ? { truncated, totalRows } : {}),
    };
  } catch (err) {
    return { error: errorMessage(err) };
  } finally {
    statement?.free();
  }
}
