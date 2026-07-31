/**
 * Typed error codes carried in ok:false DbDriverResults. The wire's error `code` is an
 * open string (protocol rule R5), so these ship as-is; app-side receivers classify
 * unknown codes via `retryable` and render them as HOST_ERROR.
 */
export const DB_ERROR_CODES = {
  /** sql.js wasm/init or persistence backend failed to come up. */
  INIT_FAILED: 'DB_INIT_FAILED',
  /** SQLite rejected the statement (syntax error, missing table, bind failure, …). */
  SQL_ERROR: 'DB_SQL_ERROR',
  /** More than one statement in a single exec — rejected before anything runs. */
  MULTI_STATEMENT: 'DB_MULTI_STATEMENT',
  /** A size cap was exceeded: 5 MiB artifact (export/import) or the 8 MiB db frame class. */
  TOO_LARGE: 'DB_TOO_LARGE',
  /** Import payload is not an openable SQLite database (base64/magic/open-check failed). */
  BAD_IMPORT: 'DB_BAD_IMPORT',
  /** Statement class closed on purpose: ATTACH, PRAGMA writable_schema, load_extension(). */
  FORBIDDEN_STATEMENT: 'DB_FORBIDDEN_STATEMENT',
  /** Anything unexpected — the driver boundary never throws (errors-as-data). */
  INTERNAL: 'DB_INTERNAL',
} as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[keyof typeof DB_ERROR_CODES];
