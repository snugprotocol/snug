// access/materialise.ts — another app's tables as a brain sees them: dumped through the Worker,
// named `<alias>__<table>` in the reader's own throwaway copy (TASK-20261010-host-broker PR-2
// AC10; ADR-0076 §2; contract v2 D-PR2-6 the dump and its caps · D-PR2-8 aliases de-collided
// against the reader's FULL object names · D-PR2-10 the whole-identifier match · D-PR2-18 never
// throws; v2.1 notes A-Q5..A-Q8).
//
// `materialiseGrants` takes the rows the service ADMITTED (live, owned, allowed for this caller —
// the policy's verdict is the service's to ask) and, in grant order, dumps each through
// `deps.dump` under ONE set budget: a dump is handed `maxTotalBytes = SET − bytes so far`, the
// crossing table comes back cut and the later ones empty (the db's rule), and a grant whose budget
// is already spent is skipped `too-large` before any work. Every failure is a SKIP with its reason
// — `drift` (the service pauses the source), `timeout` (no strike: the SQL is the host's),
// `unavailable`, `failed`, `copy-failed`, `ended` — never a throw. A grant is re-checked when its
// dump DEQUEUES (`stillLive`) and again when it ANSWERS (S3: a stop or a pause that landed while
// the worker ran wins — none of its rows leave).
//
// THE ALIAS is the source's name as an identifier — lower-case, runs of anything but `[a-z0-9]`
// folded to `_`, trimmed, at most 32 characters, `app_` in front when it does not start with a
// letter — and it is accepted only when NONE of its full names `${alias}__${table}` (every granted
// table) is taken: by the reader's registry objects, by a table the reader's code created at
// runtime (in the runtime bytes, not the registry), by `snug_kv`, by SQLite's own `sqlite_` family
// (a prefix rule — A-Q6), or by an earlier alias of this set. Else `2`, `3`, … are appended. So
// the brain's `ledger__transactions` is never the reader's own table in disguise, and the attach
// (`scratchRun`'s belt, D-PR2-9) never has to refuse a name.
//
// `namesTable` is the lazy door's test (D-PR2-10): does this statement name this table, as a whole
// identifier — bare, "quoted", `quoted`, [bracketed], in any case, and conservatively inside a
// string literal too (a name that merely contains it, `ledger__transactions_archive`, does not).
// `toAttach` is what the scratch copy is handed: `{ name, columns, rows }` per table, for every
// grant or for the named ones only. Nothing here writes a history line: the service does, through
// `recordRead`, before rows reach a brain.
//
// This module reaches the engine through `deps` and the db it is handed — it imports the pure
// policy (ownership), the leaf facts, the limits and types only — so the data tools can import
// `namesTable` and `toAttach` without loading the engine (F13). No string here spells the engine's
// internal words (copy.ts's vocabulary scan reads this file).

import { ACCESS_SOURCE_MAX_BYTES, utf8ByteLength } from '@snugprotocol/protocol';
import type { ScratchAttachTable, UserDb } from '@snugprotocol/db';

import { isExpired } from './grantFacts.js';
import type { FoundAccessGrant, LiveGrantRow } from './grants.js';
import { ACCESS_MATERIALISE_MAX_BYTES, ACCESS_MATERIALISE_MAX_ROWS, ACCESS_MATERIALISE_MAX_SET_BYTES, ACCESS_MATERIALISE_TIMEOUT_MS } from './limits.js';
import { ownsGrant, type AccessCaller } from './policy.js';
import type { scopedDump } from './scopedRead.js';
import type { MaterialiseSkip, MaterialiseSkipReason, MaterialisedSet, MaterialisedTable } from './service.js';

/** What the loop needs of the engine — the dump, the clock and the finder, bound by the service (tests inject). */
export interface MaterialiseDeps {
  dump: typeof scopedDump;
  now(): number;
  find(grantId: string): FoundAccessGrant | undefined;
}

const ALIAS_MAX_CHARS = 32;
/** SQLite reserves every object name starting with this — never a full name of ours (A-Q6). */
const RESERVED_PREFIX = 'sqlite_';
/** The app's own key-value table, present in every runtime. */
const KV_TABLE = 'snug_kv';
const JOIN = '__';

/** A source too large to export for a read (the protocol's bound on a runtime). */
class SourceTooLarge extends Error {}

/** D-PR2-8: the slug, then the first of `slug`, `slug2`, `slug3`, … none of whose full names is taken. */
export function aliasFor(sourceName: string, grantedTables: readonly string[], taken: ReadonlySet<string>): string {
  const base = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, ALIAS_MAX_CHARS);
  const slug = /^[a-z]/.test(base) ? base : `app_${base}`;
  const free = (candidate: string): boolean =>
    grantedTables.every((table) => {
      const full = `${candidate}${JOIN}${table}`.toLowerCase();
      return !full.startsWith(RESERVED_PREFIX) && !taken.has(full);
    });
  let candidate = slug;
  for (let n = 2; !free(candidate); n += 1) candidate = `${slug}${n}`;
  return candidate;
}

/**
 * Every name a full name must not be, lower-cased: the reader's registry objects (tables and
 * views — and its indexes and triggers too, since the attach refuses ANY same-named object), the
 * tables its code created at runtime, and `snug_kv`. The `sqlite_` family is `aliasFor`'s prefix rule.
 */
export async function takenNamesFor(db: UserDb, readerAppId: string): Promise<Set<string>> {
  const taken = new Set<string>([KV_TABLE]);
  for (const object of db.getAppSchema(readerAppId)?.objects ?? []) taken.add(object.name.toLowerCase());
  for (const table of (await db.describeAppData(readerAppId)).tables) taken.add(table.name.toLowerCase());
  return taken;
}

/** The dump's measure of a kept row (A-Q5) — the scoped read's own: its JSON in UTF-8 bytes. */
const rowBytes = (row: readonly unknown[]): number => utf8ByteLength(JSON.stringify(row));

/**
 * Dump the admitted rows in order under the set budget, alias each, and answer the set. Never
 * throws: a grant-level failure is a skip with its reason (the header); the service wraps the
 * whole call for anything else.
 */
export async function materialiseGrants(db: UserDb, caller: AccessCaller, rows: readonly LiveGrantRow[], deps: MaterialiseDeps): Promise<MaterialisedSet> {
  const taken = await takenNamesFor(db, caller.appId);
  const tables: MaterialisedTable[] = [];
  const skipped: MaterialiseSkip[] = [];
  let remaining = ACCESS_MATERIALISE_MAX_SET_BYTES;

  for (const row of rows) {
    const { grant } = row;
    const skip = (reason: MaterialiseSkipReason): void => {
      skipped.push({ grantId: grant.id, sourceAppId: grant.sourceAppId, sourceName: row.sourceName, reason });
    };
    if (remaining <= 0) {
      skip('too-large');
      continue;
    }
    /** Still this caller's, active and unexpired — asked when the dump dequeues and again when it answers. */
    const stillOwned = (): boolean => {
      const current = deps.find(grant.id);
      return current !== undefined && ownsGrant(caller, current) && current.grant.status === 'active' && !isExpired(current.grant, deps.now());
    };
    let outcome: Awaited<ReturnType<typeof scopedDump>>;
    try {
      outcome = await deps.dump({
        grantId: grant.id,
        bytes: async () => {
          const bytes = await db.exportAppRuntime(grant.sourceAppId);
          if (bytes.byteLength > ACCESS_SOURCE_MAX_BYTES) throw new SourceTooLarge();
          return bytes;
        },
        scope: grant.scope,
        caps: { maxRows: ACCESS_MATERIALISE_MAX_ROWS, maxBytes: ACCESS_MATERIALISE_MAX_BYTES, maxTotalBytes: remaining },
        stillLive: stillOwned,
        timeoutMs: ACCESS_MATERIALISE_TIMEOUT_MS,
      });
    } catch (err) {
      skip(err instanceof SourceTooLarge ? 'too-large' : 'failed');
      continue;
    }
    if (!outcome.ok) {
      skip(outcome.reason);
      continue;
    }
    // S3: the worker took time — a stop, a pause or an expiry that landed meanwhile wins.
    if (!stillOwned()) {
      skip('ended');
      continue;
    }
    const granted = grant.scope.tables.map((table) => table.name);
    const alias = aliasFor(row.sourceName, granted, taken);
    for (const name of granted) taken.add(`${alias}${JOIN}${name}`.toLowerCase());
    for (const table of outcome.tables) {
      remaining -= table.rows.reduce((sum, cells) => sum + rowBytes(cells), 0);
      tables.push({
        grantId: grant.id,
        sourceAppId: grant.sourceAppId,
        sourceName: row.sourceName,
        alias,
        name: `${alias}${JOIN}${table.name}`,
        table: table.name,
        columns: table.columns,
        types: table.types,
        rows: table.rows,
        truncated: table.truncated === true,
        ...(table.totalRows !== undefined ? { totalRows: table.totalRows } : {}),
        duration: row.duration,
        ...(row.expiresAt !== undefined ? { expiresAt: row.expiresAt } : {}),
      });
    }
  }

  return { tables, skipped, readOnlyTables: tables.map((table) => table.name).sort() };
}

/** What the scratch copy is handed (D-PR2-9): every table of the set, or only the named grants' tables. */
export function toAttach(set: MaterialisedSet, grantIds?: readonly string[]): ScratchAttachTable[] {
  const wanted = grantIds === undefined ? undefined : new Set(grantIds);
  return set.tables
    .filter((table) => wanted === undefined || wanted.has(table.grantId))
    .map((table) => ({ name: table.name, columns: [...table.columns], rows: table.rows }));
}

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * D-PR2-10: whether `sql` names `name` as a WHOLE identifier — bare, "quoted", `quoted`,
 * [bracketed], in any case, and conservatively inside a string literal; never a longer identifier
 * that merely contains it.
 */
export function namesTable(sql: string, name: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapeForRegExp(name)}(?![A-Za-z0-9_])`, 'i').test(sql);
}
