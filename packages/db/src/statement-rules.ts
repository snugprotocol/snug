// statement-rules.ts — the pure rules over SQL TEXT (and the one DDL text) every module of
// this package that runs a statement shares, homed ONCE in a leaf (no sql.js, no driver, no
// userdb import) — the `sqlite-helpers.ts` shape, for the same reason.
//
// They lived in `driver.ts` until TASK-20261010-host-broker PR-3 (D-PR3-11): the driver now
// imports the Write Broker's apply (`brokered-write.ts`), which plans on a scoped copy
// (`scoped-read.ts`), and both of those need the statement guards — an import of them from
// `driver.ts` would close a cycle (driver → brokered-write → scoped-read → driver). `driver.ts`
// re-exports every name below verbatim, so its public surface and every importer are unchanged.

/** Exported for the userdb materializer: the kv table must be byte-identical on both sides. */
export const KV_TABLE_DDL = 'CREATE TABLE IF NOT EXISTS snug_kv (key TEXT PRIMARY KEY, value TEXT)';

/**
 * SQL with its block and line comments blanked — the one rule every statement-text guard reads
 * through (Gate-5 W-3: the four guards below, the driver's transaction record and the Write
 * Broker's parser each carried their own copy of the two regexes; one definition cannot drift).
 */
export const stripSqlComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** True when the SQL tail is only whitespace, semicolons, and comments — i.e. no second statement. */
/** Exported alongside `forbiddenStatementReason` so `scratchRun` shares the multi-statement rule. */
export function isSqlTailEmpty(tail: string): boolean {
  return stripSqlComments(tail).replace(/[\s;]+/g, '').length === 0;
}

/** BLOB cells become plain number arrays so results stay JSON/structured-clone friendly. */
export const normalizeCell = (cell: unknown): unknown => (cell instanceof Uint8Array ? Array.from(cell) : cell);

/**
 * Statement classes closed on purpose (Gate-5): ATTACH (reach outside the namespace
 * file), PRAGMA writable_schema (silent schema corruption), load_extension() (native
 * code). Checked on the comment-stripped statement text; other PRAGMAs stay allowed.
 *
 * EXPORTED as of TASK-20260811 (D7): `scratchRun` runs LLM-authored SQL through the SAME
 * guards. One definition, not two — a second copy is a second thing to forget to update.
 *
 * The `writable_schema` match tolerates SQLite's alternate spellings (fold F-Sm3b,
 * pre-existing and verified bypassable): the identifier may be quoted (`"writable_schema"`,
 * `'writable_schema'`, `[writable_schema]`, backticks) and/or schema-qualified
 * (`main.writable_schema`), all of which SQLite honors and the original anchored pattern
 * missed. Matching the bare token anywhere after `PRAGMA` is the conservative reading: the
 * cost of a false positive is one refused pragma naming a reserved word, and the cost of a
 * false negative is silent schema corruption.
 */
export function forbiddenStatementReason(sql: string): string | undefined {
  const cleaned = stripSqlComments(sql).trim();
  if (/^ATTACH\b/i.test(cleaned)) return 'ATTACH is not allowed';
  if (/^PRAGMA\b/i.test(cleaned) && /\bwritable_schema\b/i.test(cleaned)) {
    return 'PRAGMA writable_schema is not allowed';
  }
  if (/\bload_extension\s*\(/i.test(cleaned)) return 'load_extension() is not allowed';
  return undefined;
}

/**
 * True when the statement's KIND modifies rows, so `sqlite3_changes()` describes IT.
 *
 * `getRowsModified()` is sticky — it keeps reporting the previous modifying statement's
 * count for anything that follows — so a count must be attached by kind, not unconditionally
 * (R-M1). Keyed on the verb rather than a runtime counter because a modifying statement
 * that matched zero rows still needs to report 0, and no counter can distinguish that from
 * a SELECT after the fact.
 */
export function isRowModifyingStatement(sql: string): boolean {
  const cleaned = stripSqlComments(sql).trim();
  return /^(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(cleaned);
}

/**
 * The DATA-WRITE lane is DML-only: INSERT, UPDATE, DELETE and nothing else.
 *
 * Why a class allowlist rather than better copy on the card (R-B1, 2026-08-11): the data
 * lane's single security control is a human approving a proposal, and the only impact
 * signal that proposal carries is the affected-row count. `sqlite3_changes()` is 0 for ALL
 * DDL, so `DROP TABLE expenses` previewed as "would affect 0 row(s)" — the most destructive
 * statement available rendering as the most harmless, and the TOCTOU drift check comparing
 * 0 to 0 and passing. Reproduced end to end: the table was gone, and unlike the feature
 * lane the data lane has no versioning and no revert, so there was no way back.
 *
 * Restricting the class removes the primitive instead of relabeling it. It also matches
 * what the lane is FOR — adding and correcting entries — while schema change keeps its own
 * reviewed path through `schema_apply` (ADR-0010's verbatim-DDL registry) in the feature
 * lane, which versions and reloads. A statement kind whose blast radius a row count cannot
 * express does not belong behind a gate whose only signal is a row count.
 *
 * Lives beside `forbiddenStatementReason` deliberately: the scratch preview and the real
 * executor must share one definition, or they can disagree about what a write may contain
 * — and the preview is what the user approved.
 */
export function nonDataStatementReason(sql: string): string | undefined {
  const cleaned = stripSqlComments(sql).trim();
  if (/^(INSERT|UPDATE|DELETE)\b/i.test(cleaned)) return undefined;
  const verb = /^\s*([A-Za-z]+)/.exec(cleaned)?.[1]?.toUpperCase() ?? 'that';
  return `${verb} is not allowed in a data change — only INSERT, UPDATE and DELETE are. Schema changes go through the app's schema tools, not a data write.`;
}
