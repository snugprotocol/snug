// access/relevance.ts — the consent sheet's discovery: rank the user's apps by how well they
// match what the asking app said it wants (TASK-20261010-cross-app-access AC16; ADR-0075 §5).
//
// WHY A DETERMINISTIC MATCH, NOT A BRAIN CALL. The ranking is shown to the user, never to the
// app, and it has to be explainable: an LLM would spend the user's brain on the act of asking
// and could not say why Ledger came first. So the score is a plain lexical match of the app's
// hints (exact table names it named, free words) over the candidates' table names, column
// names, and the app's own name and description — case-insensitive, a word may sit inside a
// longer name ("transaction" finds `transactions`).
//
// THE SCORE IS A LEXICOGRAPHIC ORDER packed into one number: an exact hint-table match beats
// any number of word hits in table names, which beat any number in column names, which beat
// any number in the name or description. Each tier counts DISTINCT hints (≤ 16 by the
// protocol's caps), so a base of 17 per tier keeps the tiers from ever overlapping.
// Ties break by display name, then app id — the order never depends on the input order.
//
// WHAT IS NEVER A CANDIDATE. The asking app itself; an app with no readable table; an app the caller
// already found over the copy cap or holding a WhatsApp fact (`excluded` on the input — the
// db and sidecar reads live with the caller, so this module stays pure). They collapse into
// `excluded` with their reason, for the sheet's one footer sentence.
//
// SENSITIVE COLUMNS (credential-named, D23) stay in each table's column list, flagged — the
// sheet shows them as *never shared* — but a hint never matches one: a column that can never
// be allowed is no reason to put its table first. A table whose EVERY column is sensitive has
// nothing a grant could hold (D23: the scope is exactly the readable columns, and a scope table
// needs one), so it is listed for the sheet but never matched, scored or pre-selected; an app
// whose every table is like that has no data to read (`no-tables`).
//
// Pure: no db, no store, no React.

import { ACCESS_HINT_TABLES_MAX, ACCESS_HINT_WORDS_MAX } from '@snugprotocol/protocol';

export interface SourceColumn {
  name: string;
  sensitive: boolean;
}

export interface SourceTable {
  name: string;
  columns: SourceColumn[];
  rowCount: number;
}

export interface SourceApp {
  appId: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
  tables: SourceTable[];
}

/** Why an app is not offered — the footer sentence names each (copy.ts `excludedFooter`). */
export const EXCLUDED_REASONS = ['reader', 'no-tables', 'too-large', 'sidecar'] as const;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];

export interface ExcludedApp {
  appId: string;
  displayName: string;
  reason: ExcludedReason;
}

/** A candidate as the caller found it: described, or already known to be unusable. */
export type SourceInput = SourceApp | { appId: string; displayName: string; excluded: 'too-large' | 'sidecar' };

export interface RankedSource extends SourceApp {
  score: number;
  /** The tables a hint matched, in the app's own table order. */
  matchedTables: string[];
}

export interface RankedSources {
  matched: RankedSource[];
  rest: RankedSource[];
  excluded: ExcludedApp[];
}

/** At most this many candidates are shown first; the rest sit behind *more apps…*. */
export const MATCHED_MAX = 5;

/** One tier's weight: a tier counts at most 16 distinct hints, so 17 separates the tiers. */
const TIER = Math.max(ACCESS_HINT_WORDS_MAX, ACCESS_HINT_TABLES_MAX) + 1;
/** A free word shorter than this matches too much to rank anything ("a" is inside every name). */
const MIN_WORD_CHARS = 2;

const fold = (text: string): string => text.trim().toLowerCase();

/** Trimmed, lower-cased, de-duplicated — and capped at the protocol's own bound. */
function normalise(values: readonly string[] | undefined, cap: number, minChars: number): string[] {
  const out = new Set<string>();
  for (const value of values ?? []) {
    const folded = fold(value);
    if (folded.length >= minChars) out.add(folded);
    if (out.size >= cap) break;
  }
  return [...out];
}

const byNameThenId = (a: { displayName: string; appId: string }, b: { displayName: string; appId: string }): number =>
  a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0;

const isDescribed = (input: SourceInput): input is SourceApp => !('excluded' in input);

/** A table a grant could hold: at least one column that is not credential-named (D23). */
export const isOfferable = (table: SourceTable): boolean => table.columns.some((column) => !column.sensitive);

function score(app: SourceApp, hintTables: readonly string[], words: readonly string[]): RankedSource {
  // Only offerable tables can match: a table with nothing readable is never a reason to rank an app.
  const offerable = app.tables.filter(isOfferable);
  const tableNames = offerable.map((table) => fold(table.name));
  const exact = hintTables.filter((hint) => tableNames.includes(hint)).length;
  const inTables = words.filter((word) => tableNames.some((name) => name.includes(word))).length;
  const shareable = (table: SourceTable): string[] => table.columns.filter((column) => !column.sensitive).map((column) => fold(column.name));
  const inColumns = words.filter((word) => offerable.some((table) => shareable(table).some((name) => name.includes(word)))).length;
  const about = fold(`${app.displayName} ${app.description ?? ''}`);
  const inAbout = words.filter((word) => about.includes(word)).length;

  const matchedTables = offerable
    .filter((table) => {
      const name = fold(table.name);
      return hintTables.includes(name) || words.some((word) => name.includes(word) || shareable(table).some((column) => column.includes(word)));
    })
    .map((table) => table.name);

  return { ...app, score: ((exact * TIER + inTables) * TIER + inColumns) * TIER + inAbout, matchedTables };
}

/**
 * Rank every app for the sheet. Every input lands in exactly one of `matched` (score > 0, at
 * most `MATCHED_MAX`, highest first), `rest` (the overflow highest first, then the unmatched by
 * name) or `excluded` (by name).
 */
export function rankSources(input: {
  readerAppId: string;
  apps: readonly SourceInput[];
  hints?: { words?: readonly string[]; tables?: readonly string[] };
}): RankedSources {
  const hintTables = normalise(input.hints?.tables, ACCESS_HINT_TABLES_MAX, 1);
  const words = normalise(input.hints?.words, ACCESS_HINT_WORDS_MAX, MIN_WORD_CHARS);

  const excluded: ExcludedApp[] = [];
  const ranked: RankedSource[] = [];
  for (const app of input.apps) {
    if (app.appId === input.readerAppId) excluded.push({ appId: app.appId, displayName: app.displayName, reason: 'reader' });
    else if (!isDescribed(app)) excluded.push({ appId: app.appId, displayName: app.displayName, reason: app.excluded });
    else if (!app.tables.some(isOfferable)) excluded.push({ appId: app.appId, displayName: app.displayName, reason: 'no-tables' });
    else ranked.push(score(app, hintTables, words));
  }

  ranked.sort((a, b) => b.score - a.score || byNameThenId(a, b));
  const scored = ranked.filter((source) => source.score > 0);
  const unscored = ranked.filter((source) => source.score === 0);
  return {
    matched: scored.slice(0, MATCHED_MAX),
    rest: [...scored.slice(MATCHED_MAX), ...unscored],
    excluded: excluded.sort(byNameThenId),
  };
}

/** The tables the sheet ticks first: those a hint matched, or every OFFERABLE table when none did. */
export function preselectedTables(source: RankedSource): string[] {
  return source.matchedTables.length > 0 ? [...source.matchedTables] : source.tables.filter(isOfferable).map((table) => table.name);
}
