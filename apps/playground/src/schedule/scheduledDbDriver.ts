// schedule/scheduledDbDriver.ts — the db binding a scheduled *Run [app]* hands its hidden frame
// (TASK-20261009-scheduled-run-open-app; the Gate-5 review's major).
//
// The hidden frame and a visible RunView of the same app reach ONE sql.js connection per
// namespace (the driver caches it), so state a request leaves on the connection is shared by
// both instances. Two requests from the app are safe — each is atomic at the host — but a
// TRANSACTION spanning requests is not: the visible copy's ROLLBACK would swallow a scheduled
// write made in between, a scheduled BEGIN would fail inside the visible one's, and a hidden run
// torn down mid-transaction would leave the connection open for whoever comes next. A whole-
// database IMPORT would swap the store out from under the open copy. So the scheduled binding
// refuses both by name with the driver's existing `FORBIDDEN_STATEMENT` (no new code); every
// other request — reads, writes, kv, export, the host-side kv — passes through untouched. No
// shipped starter uses either.

import { DB_ERROR_CODES, type DbDriverResult, type SnugDbDriver } from '@snugprotocol/db';

export const SCHEDULED_DB_REFUSAL = {
  transaction: 'a scheduled run cannot hold a transaction open — run each change as one statement',
  import: 'a scheduled run cannot replace the whole database',
} as const;

const TRANSACTION_CONTROL = /(?:^|;)\s*(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** The comment- and literal-stripped statement text, so a keyword inside a string never matches. */
const statementText = (sql: string): string =>
  sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .trim();

const refused = (message: string): DbDriverResult => ({ ok: false, code: DB_ERROR_CODES.FORBIDDEN_STATEMENT, message, retryable: false });

export function scheduledDbDriver(driver: SnugDbDriver): SnugDbDriver {
  return {
    get persistence() {
      return driver.persistence;
    },
    handle(namespace, request) {
      if (request.op === 'import') return Promise.resolve(refused(SCHEDULED_DB_REFUSAL.import));
      if (request.op === 'exec' && TRANSACTION_CONTROL.test(statementText(request.sql))) return Promise.resolve(refused(SCHEDULED_DB_REFUSAL.transaction));
      return driver.handle(namespace, request);
    },
    flush: () => driver.flush(),
    evict: (namespace) => driver.evict(namespace),
    close: () => driver.close(),
    kvSet: (namespace, key, value) => driver.kvSet(namespace, key, value),
    kvGet: (namespace, key) => driver.kvGet(namespace, key),
  };
}
