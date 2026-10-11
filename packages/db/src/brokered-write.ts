// brokered-write.ts — the PURE half of the Write Broker (TASK-20261010-host-broker PR-3,
// contract v2 D-PR3-9 / D-PR3-10 / D-PR3-12; ADR-0076 §4; spec 1.2 §24.5): one app's bounded,
// journaled, undoable write onto another app's table, decided from the SCHEMA and the SCOPE —
// never from a row's value — and applied atomically on the live handle.
//
// PURE: no DOM, no Worker, no userdb. The host runs the parse + plan half inside the access
// engine's Worker (its own sql.js instance, a wall clock) and the apply half on the main
// thread through the driver's `brokeredWrite` seat (D-PR3-11) — the ONLY way onto a handle.
//
// FOUR SEATS, IN THE ORDER A WRITE CROSSES THEM:
//
//  1. `parseBrokeredStatement` — a small tokenizer and a literal-valued grammar. ONE plain
//     `INSERT INTO t (c, …) VALUES (…)[, (…)]` (the column list REQUIRED), `UPDATE t SET c =
//     <value>, … WHERE <terms>` or `DELETE FROM t WHERE <terms>`. A VALUE is a literal, a
//     placeholder, or NULL/TRUE/FALSE; a `-` glued to a number is ONE signed literal (D-Q4). A
//     WHERE is terms — `<column> <op> <value>` (`=`, `<>`, `!=`, `<`, `<=`, `>`, `>=`, `LIKE`),
//     `<column> [NOT] IN (<values>)`, `<column> IS [NOT] NULL` — joined by AND/OR/NOT with
//     parentheses. Everything else — a function, CASE, arithmetic, a column as a value, a
//     column against a column, a bare literal, a qualifier, a subquery, EXISTS, RETURNING, a
//     conflict clause, `OR …`, `DEFAULT VALUES`, `INSERT … SELECT`, `UPDATE … FROM`, WITH,
//     ORDER BY, LIMIT, BETWEEN, GLOB, a second statement — is refused BY NAME (D-Q6), so a
//     reader's model can correct itself. Answers what the statement NAMES: every column, the
//     SET columns in SET order, the INSERT list, the literals (strings unescaped, numbers as
//     written — D-Q5) and the placeholder count.
//  2. `tableFacts` — the table rules, read from the RAW handle (never a scoped copy: the copy
//     has no triggers — F3): the table exists as an ordinary rowid table (`pragma_table_list`:
//     not a view, not virtual, not a shadow table, not WITHOUT ROWID); no TEMP object shadows
//     its name; NO trigger on it in `sqlite_master` OR `sqlite_temp_master` (S13); its CREATE
//     text carries no `ON CONFLICT REPLACE` (a REPLACE resolution deletes rows no capture sees)
//     and — when the table has any column outside the granted `columns` — no `CHECK` (S2's
//     residual: a CHECK over an unshared column would answer a reader's probe); when
//     `PRAGMA foreign_keys` is on, no foreign key of ANY table names it with an action other
//     than NO ACTION (a cascade is a change no count reports) AND it holds no foreign key of its
//     own (Gate-5 SEC-6: a CHILD table's insert or update fails by the parent key's existence —
//     a one-bit oracle on a table the reader was not granted; symmetric with the parent-side
//     rule, and free when the pragma is off; the plan copy opens with foreign_keys off, so both
//     bite at the live seat — D-Q14); no column named `rowid`,
//     `oid` or `_rowid_` (such a column shadows the real rowid the capture and the undo key
//     on); and for a DELETE, EVERY live column is granted — no withheld, credential-named or
//     generated column (S5: a DELETE journals the whole row). The columns come back with
//     their generated flag (`table_xinfo`). Every refusal is worded for the reader without
//     the why (DS19).
//  3. `planBrokeredWrite` — in the Worker, on a FRESH export: parse → the table is in scope
//     WITH `write` (else `not-granted`) → the facts on the raw copy → the column rule: every
//     NAMED column is granted and not generated → every literal and bound value through the
//     ONE credential walk → `scopeCopy(…, { forPlan: true })` (the drops, the withhold, the
//     mask, the CHECK reset, the drift check — D-PR3-22) → every named column is outside the
//     set the copy MASKED a cell in (the third oracle: a write's `changes` on a masked column
//     would tell the reader what the mask hid — S1) → a DRY RUN inside `BEGIN … ROLLBACK` with
//     the capture objects → `changes ≤ maxChanges` (`too-many`), the captured rows journal-
//     able and ≤ `maxUndoBytes` (`too-large`). The plan carries the statement, its params,
//     the op, the table, the GRANTED columns (D-Q1), the SET/INSERT columns and the count —
//     NO row and no value leaves the Worker.
//  4. `applyBrokeredBatch` — SYNCHRONOUS on the live handle. The facts AGAIN, per plan, on
//     the live handle (the apply's check is the rule; the Worker's was the early answer), the
//     `forbiddenStatementReason` belt on every statement (S3), then `BEGIN IMMEDIATE` (a
//     transaction the app holds → `busy`, and the app's transaction is left exactly as it was
//     — D-Q3) → per plan: the capture objects, the statement, `sqlite3_changes()`, the caps
//     (`too-many`), the drift halt (`expectChanges` — `drifted`, with both counts), the
//     captured rows read and each cell judged UNDER ITS COLUMN — a cell the journal cannot
//     hold (`journalableCell`: the protocol's `accessParamSchema` as a PURE predicate — a text
//     of at most `JOURNAL_TEXT_MAX_CHARS`, a finite number, a boolean or NULL; a BLOB,
//     NaN or anything else is not — see THE WORKER'S BUNDLE below), or a credential-shaped
//     text (`findRecordCredential({ [column]: value })`, S12) — a hit is `unsafe` (or
//     `too-large` for an over-long text) when an undo is REQUIRED, else the write commits
//     with NO undo (D-Q15) → the journal
//     bytes ≤ `maxUndoBytes` → the capture objects dropped → `COMMIT`. A step that captured no
//     row is not journaled, and a write that captured none at all is not undoable (Gate-5 W-1:
//     nothing to put back, and an empty step never parses into the journal). A `committed` flag;
//     `finally` runs ROLLBACK (errors swallowed) whenever this apply's OWN BEGIN succeeded and
//     the commit did not, THEN drops any capture object still standing; a throw anywhere is
//     answered `failed` (S11).
//
// CAPTURE BY TEMP TRIGGER, PER-APPLY NAMES (D-PR3-10). Inside the transaction, per plan:
// `CREATE TEMP TABLE snug_undo_rows_<hex8> (snug_rowid INTEGER, c0, c1, …)` — POSITIONAL
// columns mapped back by index, so a target column named `r`, `rowid` or `snug_rowid` can
// never collide (F18) — and `CREATE TEMP TRIGGER snug_undo_trigger_<hex8> BEFORE UPDATE |
// BEFORE DELETE | AFTER INSERT ON t`, with UNQUALIFIED names in its body (a TEMP trigger on a
// main table may not qualify the table). An UPDATE captures `old.*` AND `new.*` of the SET
// columns under `new.rowid` — the rowid the write LEFT, which the undo's guard needs even when
// the statement moved an INTEGER PRIMARY KEY; a DELETE captures `old.*` of every non-generated
// column; an INSERT captures `new.rowid` and `new.*` of the INSERT list (an explicit INTEGER
// PRIMARY KEY value included). Created WITHOUT `IF NOT EXISTS` — a creation failure is
// `failed`, and the belt's `DROP … IF EXISTS` runs only on a name THIS apply created, so it
// can never remove an object the app made (S11). The affected set is the statement's OWN:
// `recursive_triggers` is off and the facts refused every app trigger.
//
// THE UNDO IS BUILT FROM STRUCTURE, NEVER FROM STATEMENT TEXT (S3). `buildUndoStatement(step,
// row)` makes the inverse with every identifier quoted and every value a bound parameter:
// an INSERT is undone by `DELETE FROM t WHERE rowid = ? AND c IS ? …` (the `after` values),
// an UPDATE by `UPDATE t SET c = ?, … WHERE rowid = ? AND c IS ? …` (SET = `before`, the
// guard = `after`), a DELETE by `INSERT INTO t (rowid, c, …) VALUES (?, …)` (`before`). The
// apply's `{ undo }` variant re-validates every step against the live schema — the table's
// shape rules above (an undo is the user's act, so the two READER-oracle rules — the CHECK
// over an unshared column and the DELETE's full coverage — do not apply to it), every named
// column present and none generated — builds every statement and runs the belt over each
// BEFORE the transaction, then applies them in the order given; an inverse that changed any
// number of rows but ONE means the source changed those rows since, and the WHOLE undo rolls
// back `drifted` (S18); a SQL error (a rowid reused since — D-Q19) is `failed`. An undo never
// captures and is never undoable.
//
// OWN MODE — THE SAME SEAT WITHOUT THE TABLE RULES (D-PR3-8, E1-Q12). The `{ own }` variant is
// the app's OWN change the user approved on a card (`applyApprovedWrite`'s two callers): the
// DML class only, ANY statement shape — a triggered table, WITHOUT ROWID, `ON CONFLICT REPLACE`,
// a foreign-key action, a generated or credential-named column, a `main.t` name, no WHERE —
// because the table rules above decide what ANOTHER app may do to a table, and here the user
// approved this change to the app's own table and reads the result in the app. So: the belts
// only (`forbiddenStatementReason`, the class guard `nonDataStatementReason`, ONE statement per
// entry — judged by the engine as each is compiled, since a `;` inside a literal is no statement
// end, and the whole batch rolls back on a second one), `BEGIN IMMEDIATE` (`busy`), each
// statement in order, `sqlite3_changes()`, the drift halt against `expectChanges` (`drifted` with
// both counts — the counts the user approved are own mode's count rule), `COMMIT`. No facts, no
// capture, `undoable: false` — an own-app undo surface is PR-4's (AC31).
//
// THE WORKER'S BUNDLE CARRIES NO SCHEMA (D-PR3-28). The kit's inline Worker reaches this module
// (`planBrokeredWrite`), and the protocol's `access.ts` constructs every access schema at its
// top level — one import from that module, even of a bare number, keeps every construction and
// zod in the bundle (Rollup cannot prove a schema call pure; measured: the schema swapped for
// the predicate but the constant still imported left the kit page 2,896,555 B against a
// 2,742,366 B baseline). So the journal's cell rule is the predicate above, its text bound is
// spelled here as `JOURNAL_TEXT_MAX_CHARS` (= the protocol's `ACCESS_PARAM_STRING_MAX_CHARS`,
// which must stay equal to it), and nothing this module imports from the protocol is a schema
// or lives beside one.
//
// `dmlTargetTable` is the driver's write signal's table (D-PR3-20 a): the first identifier
// after `INSERT [OR …] INTO`, `REPLACE INTO`, `UPDATE [OR …]` or `DELETE FROM`, comment-
// stripped and unquoted; `undefined` when the text cannot say.
//
// REFUSALS NAME THEIR RULE. Beside `reason: 'refused'` every refusal of the parser, the facts,
// the column rule or the value walk carries `rule` — `statement` · `no-where` · `table` ·
// `column` · `computed` · `value` — so the engine words it (`ACCESS_APP_MESSAGES.writeRefused`,
// E1-Q1) by switching on a token, never by parsing prose. The message beside it names the
// offending token or column (D-Q6) and never a value.

import type { BindParams, Database, SqlJsStatic } from 'sql.js';
import { findRecordCredential, isCredentialKeyName, utf8ByteLength } from '@snugprotocol/protocol';
import { scopeCopy, type ScopedReadDrift, type ScopedReadScope, type ScopedReadStatement } from './scoped-read.js';
import { errorMessage, quoteIdent, selectRows, tableColumns } from './sqlite-helpers.js';
import { forbiddenStatementReason, isSqlTailEmpty, nonDataStatementReason, stripSqlComments } from './statement-rules.js';

// ------------------------------------------------------------------------------- the shapes

/** The three statement shapes a brokered write may have. */
export type BrokeredOp = 'insert' | 'update' | 'delete';

/** What a parsed statement NAMES (the planner judges every column) and carries (the walk judges every value). */
export interface ParsedDml {
  op: BrokeredOp;
  table: string;
  /** Every column the statement names — SET, the INSERT list, WHERE — each once. */
  columns: string[];
  /** An UPDATE's SET columns, in SET order. */
  setColumns?: string[];
  /** An INSERT's column list, in list order. */
  insertColumns?: string[];
  /** Every string literal's unescaped value and every numeric literal as written (D-Q5). */
  literals: string[];
  placeholders: number;
  sql: string;
}

/** Which rule refused — the engine's token for its sentence (E1-Q1); the message names the token or column. */
export type BrokeredRefusalRule = 'statement' | 'no-where' | 'table' | 'column' | 'computed' | 'value';

/** A refusal decided from the statement text, the schema or the scope — never from a row. */
export interface BrokeredRefused {
  ok: false;
  reason: 'refused';
  rule: BrokeredRefusalRule;
  message: string;
}

export type BrokeredParseResult = { ok: true; parsed: ParsedDml } | BrokeredRefused;

/** One live column of a table as `tableFacts` reads it: its name as declared and whether it is generated. */
export interface ColumnFact {
  name: string;
  generated: boolean;
}

export type BrokeredFactsResult = { ok: true; columns: ColumnFact[] } | BrokeredRefused;

/** The caps a write runs under — the engine passes the protocol's (`ACCESS_WRITE_MAX_ROWS`, `ACCESS_UNDO_MAX_BYTES`). */
export interface BrokeredCaps {
  maxChanges: number;
  maxUndoBytes: number;
}

/** What the Worker hands the seat: the statement and its count — the GRANTED columns (D-Q1), never a row. */
export interface BrokeredPlan {
  sql: string;
  params?: readonly unknown[];
  op: BrokeredOp;
  table: string;
  /** The table's granted columns (the scope's), as the apply re-decides the column rule from the plan alone. */
  columns: string[];
  setColumns?: string[];
  insertColumns?: string[];
  previewChanges: number;
}

export type PlanRefusal =
  | BrokeredRefused
  | { ok: false; reason: 'not-granted' | 'too-many' | 'too-large' | 'unsafe' | 'failed' | 'copy-failed'; message: string }
  | { ok: false; reason: 'drift'; drift: ScopedReadDrift; message: string };

export type BrokeredPlanResult = { ok: true; plan: BrokeredPlan } | PlanRefusal;

/** One captured row: its rowid and the cells of the step's `columns` — `after` (INSERT), `before` + `after` (UPDATE), `before` (DELETE). */
export interface UndoRow {
  rowid: number;
  before?: unknown[];
  after?: unknown[];
}

/** One statement's captured rows — the journal's structure, from which an undo is BUILT (never statement text). */
export interface UndoStep {
  table: string;
  op: BrokeredOp;
  /** UPDATE: the SET columns in order; DELETE: every non-generated column; INSERT: the INSERT list. */
  columns: string[];
  rows: UndoRow[];
}

export type ApplyRefusal =
  | BrokeredRefused
  | {
      ok: false;
      reason: 'busy' | 'drifted' | 'too-many' | 'too-large' | 'unsafe' | 'failed';
      message: string;
      /** On `drifted`: the counts the plan expected, and the counts the statements made (through the one that drifted). */
      previewed?: number[];
      current?: number[];
    };

/** One statement of an app's OWN approved change (the `{ own }` variant, D-PR3-8): the text and its bound values. */
export interface OwnStatement {
  sql: string;
  params?: readonly unknown[];
}

/**
 * The Worker's plans to apply (strict, under the caps), the app's own approved statements (own
 * mode — the approved counts are its only bound) or an undo's structured steps to reverse (D-Q2;
 * Gate-5 W-2: only the strict variant carries `caps`, because only it reads them).
 */
export type BrokeredApplyInput =
  | { plans: readonly BrokeredPlan[]; caps: BrokeredCaps; expectChanges?: readonly number[]; requireUndo: boolean; capture: boolean }
  | { own: readonly OwnStatement[]; expectChanges?: readonly number[] }
  | { undo: readonly UndoStep[] };

export type BrokeredApplyResult = { ok: true; steps: UndoStep[]; changes: number[]; undoable: boolean } | ApplyRefusal;

// ------------------------------------------------------------------------------- the words

/** The one sentence a table rule answers with (DS19): no why, nothing about the table. */
const TABLE_REFUSED = "that table can't be changed from another app";
const refused = (rule: BrokeredRefusalRule, message: string): BrokeredRefused => ({ ok: false, reason: 'refused', rule, message });

// ------------------------------------------------------------------------------- the tokenizer

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'placeholder' | 'punct';

interface Token {
  kind: TokenKind;
  /** The token as written. */
  text: string;
  /** A word upper-cased; a quoted identifier or a string literal unescaped; otherwise the text. */
  value: string;
}

/** The parser's refusal, thrown inside and answered as data at the boundary. */
class Refusal extends Error {
  constructor(
    readonly rule: BrokeredRefusalRule,
    message: string,
  ) {
    super(message);
  }
}

function refuse(rule: BrokeredRefusalRule, message: string): never {
  throw new Refusal(rule, message);
}

/** A `-` glued to a number is ONE signed literal (D-Q4) — tried first, so `-3` never lexes as `-` then `3`. */
const SIGNED_NUMBER = /-(?:0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const NUMBER = /0[xX][0-9A-Fa-f]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_][\w$]*/y;
const NAMED_PLACEHOLDER = /[:@$][A-Za-z_][\w$]*/y;
const ANONYMOUS_PLACEHOLDER = /\?\d*/y;
/** The sticky rules in the order they are tried, each with the token kind it yields. */
const TOKEN_RULES: ReadonlyArray<readonly [RegExp, TokenKind]> = [
  [SIGNED_NUMBER, 'number'],
  [NUMBER, 'number'],
  [WORD, 'word'],
  [NAMED_PLACEHOLDER, 'placeholder'],
  [ANONYMOUS_PLACEHOLDER, 'placeholder'],
];
const TWO_CHAR_PUNCT = new Set(['<>', '<=', '>=', '!=', '||', '<<', '>>', '==']);

/**
 * The statement's tokens up to the first top-level `;`, and the raw text after it (the
 * one-statement rule reads that with `isSqlTailEmpty`). Comments are skipped; an unterminated
 * string or quoted name, or a character SQL has no use for, is refused by name.
 */
function tokenize(sql: string): { tokens: Token[]; rest: string } {
  const tokens: Token[] = [];
  let i = 0;
  const quoted = (close: string, kind: 'ident' | 'string'): void => {
    const start = i;
    i += 1;
    let value = '';
    for (;;) {
      const at = sql.indexOf(close, i);
      if (at === -1) refuse('statement', `an unterminated ${kind === 'string' ? 'string' : 'quoted name'} starting at "${sql.slice(start, start + 12)}"`);
      value += sql.slice(i, at);
      i = at + close.length;
      if (close !== ']' && sql.startsWith(close, i)) {
        value += close; // a doubled quote is one quote
        i += close.length;
        continue;
      }
      break;
    }
    tokens.push({ kind, text: sql.slice(start, i), value });
  };
  while (i < sql.length) {
    const ch = sql[i] ?? '';
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (ch === ';') return { tokens, rest: sql.slice(i + 1) };
    if (ch === "'") {
      quoted("'", 'string');
      continue;
    }
    if (ch === '"' || ch === '`') {
      quoted(ch, 'ident');
      continue;
    }
    if (ch === '[') {
      quoted(']', 'ident');
      continue;
    }
    let matched = false;
    for (const [rule, kind] of TOKEN_RULES) {
      rule.lastIndex = i;
      const match = rule.exec(sql);
      if (match === null) continue;
      const text = match[0];
      tokens.push({ kind, text, value: kind === 'word' ? text.toUpperCase() : text });
      i += text.length;
      matched = true;
      break;
    }
    if (matched) continue;
    const two = sql.slice(i, i + 2);
    const text = TWO_CHAR_PUNCT.has(two) ? two : ch;
    tokens.push({ kind: 'punct', text, value: text });
    i += text.length;
  }
  return { tokens, rest: '' };
}

// ------------------------------------------------------------------------------- the parser

/** Words that can never be a column or table name here — each refused by name where a name is expected. */
const RESERVED = new Set([
  'SELECT', 'WITH', 'CASE', 'EXISTS', 'NOT', 'AND', 'OR', 'IN', 'IS', 'LIKE', 'NULL', 'TRUE', 'FALSE', 'WHERE', 'SET', 'FROM', 'VALUES', 'INTO',
  'BETWEEN', 'GLOB', 'MATCH', 'REGEXP', 'COLLATE', 'ESCAPE', 'RETURNING', 'ORDER', 'LIMIT', 'DEFAULT', 'ON', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE',
]);
const COMPARISONS = new Set(['=', '==', '<>', '!=', '<', '<=', '>', '>=']);

/** A cursor over the tokens; every refusal names the token it stopped on. */
interface Cursor {
  peek(): Token | undefined;
  next(): Token;
  atEnd(): boolean;
  isWord(word: string): boolean;
  isPunct(text: string): boolean;
  /** The next token must be this word, else the one found is refused by name. */
  expectWord(word: string): void;
  expectPunct(text: string): void;
  /** Refuse on the token under the cursor, naming it — or the statement's end. */
  unexpected(why: string): never;
}

function cursorOver(tokens: readonly Token[]): Cursor {
  let index = 0;
  const peek = (): Token | undefined => tokens[index];
  const unexpected = (why: string): never => {
    const token = peek();
    return token === undefined ? refuse('statement', `the statement ends before it is complete — ${why}`) : refuse('statement', `"${token.text}" is not allowed — ${why}`);
  };
  const isWord = (word: string): boolean => {
    const token = peek();
    return token !== undefined && token.kind === 'word' && token.value === word;
  };
  const isPunct = (text: string): boolean => {
    const token = peek();
    return token !== undefined && token.kind === 'punct' && token.text === text;
  };
  const next = (): Token => {
    const token = tokens[index];
    if (token === undefined) return refuse('statement', 'the statement ends before it is complete');
    index += 1;
    return token;
  };
  return {
    peek,
    next,
    atEnd: () => index >= tokens.length,
    isWord,
    isPunct,
    expectWord: (word) => {
      if (!isWord(word)) unexpected(`"${word}" is required here`);
      next();
    },
    expectPunct: (text) => {
      if (!isPunct(text)) unexpected(`"${text}" is required here`);
      next();
    },
    unexpected,
  };
}

/**
 * A table or column name: a bare word outside the reserved set, or a quoted identifier. A
 * `.` after it is a qualifier (schema or table) — refused by name; a `(` after a bare word is a
 * function call — refused by name.
 */
function identifier(c: Cursor, what: 'table' | 'column'): string {
  const token = c.peek();
  if (token === undefined) c.unexpected(`a ${what} name is required`);
  if (token.kind === 'ident') {
    c.next();
  } else if (token.kind === 'word' && !RESERVED.has(token.value)) {
    c.next();
    // A bare column name followed by `(` is a function call (a table name is followed by its column list).
    if (what === 'column' && c.isPunct('(')) refuse('statement', `the function ${token.text}(…) is not allowed — a value must be a literal or a placeholder`);
  } else if (token.kind === 'word') {
    refuse('statement', `"${token.text}" is not allowed where a ${what} name is expected`);
  } else {
    refuse('statement', `"${token.text}" is not allowed — a ${what} name is expected here`);
  }
  if (c.isPunct('.')) refuse('statement', `the qualified name "${token.text}." is not allowed — name the ${what} alone`);
  // A quoted name is its unescaped value; a bare one is its spelling as written.
  return token.kind === 'ident' ? token.value : token.text;
}

interface Collected {
  literals: string[];
  placeholders: number;
}

/** A VALUE: a literal, a placeholder, or NULL/TRUE/FALSE. Everything else is refused by name. */
function value(c: Cursor, into: Collected): void {
  const token = c.peek();
  if (token === undefined) c.unexpected('a value is required');
  if (token.kind === 'string' || token.kind === 'number') {
    into.literals.push(token.value);
    c.next();
    return;
  }
  if (token.kind === 'placeholder') {
    into.placeholders += 1;
    c.next();
    return;
  }
  if (token.kind === 'word') {
    if (token.value === 'NULL' || token.value === 'TRUE' || token.value === 'FALSE') {
      c.next();
      return;
    }
    c.next();
    if (c.isPunct('(')) refuse('statement', `the function ${token.text}(…) is not allowed — a value must be a literal or a placeholder`);
    if (RESERVED.has(token.value)) refuse('statement', `"${token.text}" is not allowed — a value must be a literal or a placeholder`);
  }
  if (token.kind === 'word' || token.kind === 'ident') {
    refuse('statement', `"${token.text}" is not allowed as a value — a value must be a literal or a placeholder, never a column`);
  }
  refuse('statement', `"${token.text}" is not allowed — a value must be a literal or a placeholder`);
}

/** A parenthesised list of one or more values. */
function valueList(c: Cursor, into: Collected): number {
  c.expectPunct('(');
  let count = 0;
  for (;;) {
    value(c, into);
    count += 1;
    if (c.isPunct(',')) {
      c.next();
      continue;
    }
    c.expectPunct(')');
    return count;
  }
}

interface Named {
  /** Every column named, once each (case-insensitively), in first-seen order. */
  columns: string[];
  seen: Set<string>;
}

function nameColumn(named: Named, column: string): void {
  const lower = column.toLowerCase();
  if (named.seen.has(lower)) return;
  named.seen.add(lower);
  named.columns.push(column);
}

/** One WHERE term — see the header's grammar. */
function term(c: Cursor, named: Named, into: Collected): void {
  const column = identifier(c, 'column');
  nameColumn(named, column);
  const token = c.peek();
  if (token === undefined) c.unexpected('a comparison is required after a column');
  if (token.kind === 'punct' && COMPARISONS.has(token.text)) {
    c.next();
    value(c, into);
    return;
  }
  if (token.kind === 'word') {
    const negated = token.value === 'NOT';
    if (negated) c.next();
    if (c.isWord('LIKE')) {
      c.next();
      value(c, into);
      if (c.isWord('ESCAPE')) c.unexpected('an ESCAPE clause is not allowed');
      return;
    }
    if (c.isWord('IN')) {
      c.next();
      valueList(c, into);
      return;
    }
    if (!negated && c.isWord('IS')) {
      c.next();
      if (c.isWord('NOT')) c.next();
      c.expectWord('NULL');
      return;
    }
  }
  c.unexpected('a column is compared with =, <>, !=, <, <=, >, >=, LIKE, IN (…) or IS [NOT] NULL');
}

function primary(c: Cursor, named: Named, into: Collected): void {
  if (c.isPunct('(')) {
    c.next();
    orExpr(c, named, into);
    c.expectPunct(')');
    return;
  }
  term(c, named, into);
}

function notExpr(c: Cursor, named: Named, into: Collected): void {
  if (c.isWord('NOT')) {
    c.next();
    notExpr(c, named, into);
    return;
  }
  primary(c, named, into);
}

function andExpr(c: Cursor, named: Named, into: Collected): void {
  notExpr(c, named, into);
  while (c.isWord('AND')) {
    c.next();
    notExpr(c, named, into);
  }
}

function orExpr(c: Cursor, named: Named, into: Collected): void {
  andExpr(c, named, into);
  while (c.isWord('OR')) {
    c.next();
    andExpr(c, named, into);
  }
}

/** The WHERE clause, REQUIRED: its absence is the `no-where` rule; `FROM` and anything else is refused by name. */
function whereClause(c: Cursor, named: Named, into: Collected): void {
  if (c.atEnd()) refuse('no-where', 'a WHERE clause is required — a change to every row is made in the other app itself');
  if (!c.isWord('WHERE')) c.unexpected('a WHERE clause is required here');
  c.next();
  orExpr(c, named, into);
}

/** A comma-separated column list of one or more names, none twice. */
function columnList(c: Cursor, named: Named, until: string): string[] {
  const list: string[] = [];
  const lower = new Set<string>();
  for (;;) {
    const column = identifier(c, 'column');
    if (lower.has(column.toLowerCase())) refuse('statement', `the column "${column}" is named twice`);
    lower.add(column.toLowerCase());
    list.push(column);
    nameColumn(named, column);
    if (c.isPunct(',')) {
      c.next();
      continue;
    }
    c.expectPunct(until);
    return list;
  }
}

function parseInsert(c: Cursor, named: Named, into: Collected): Pick<ParsedDml, 'table' | 'insertColumns'> {
  if (c.isWord('OR')) c.unexpected('a conflict clause (OR REPLACE, OR IGNORE, …) is not allowed');
  c.expectWord('INTO');
  const table = identifier(c, 'table');
  if (c.isWord('VALUES')) c.unexpected('the column list is required — INSERT INTO t (c, …) VALUES (…)');
  if (!c.isPunct('(')) c.unexpected('the column list is required — INSERT INTO t (c, …) VALUES (…)');
  c.next();
  const insertColumns = columnList(c, named, ')');
  if (!c.isWord('VALUES')) c.unexpected('VALUES (…) is required — a value must be a literal or a placeholder');
  c.next();
  for (;;) {
    const count = valueList(c, into);
    if (count !== insertColumns.length) refuse('statement', `${count} values for ${insertColumns.length} columns`);
    if (c.isPunct(',')) {
      c.next();
      continue;
    }
    break;
  }
  return { table, insertColumns };
}

function parseUpdate(c: Cursor, named: Named, into: Collected): Pick<ParsedDml, 'table' | 'setColumns'> {
  if (c.isWord('OR')) c.unexpected('a conflict clause (OR REPLACE, OR IGNORE, …) is not allowed');
  const table = identifier(c, 'table');
  c.expectWord('SET');
  const setColumns: string[] = [];
  const lower = new Set<string>();
  for (;;) {
    const column = identifier(c, 'column');
    if (lower.has(column.toLowerCase())) refuse('statement', `the column "${column}" is set twice`);
    lower.add(column.toLowerCase());
    setColumns.push(column);
    nameColumn(named, column);
    c.expectPunct('=');
    value(c, into);
    if (c.isPunct(',')) {
      c.next();
      continue;
    }
    break;
  }
  whereClause(c, named, into);
  return { table, setColumns };
}

function parseDelete(c: Cursor, named: Named, into: Collected): Pick<ParsedDml, 'table'> {
  c.expectWord('FROM');
  const table = identifier(c, 'table');
  whereClause(c, named, into);
  return { table };
}

/**
 * Parse ONE plain INSERT, UPDATE or DELETE with literal values — see the header for the
 * grammar. Never throws: a refusal names the offending token (D-Q6).
 */
export function parseBrokeredStatement(sql: string): BrokeredParseResult {
  try {
    const { tokens, rest } = tokenize(sql);
    if (!isSqlTailEmpty(rest)) {
      const next = stripSqlComments(rest).trim().split(/\s+/)[0] ?? '';
      refuse('statement', `"${next}" begins a second statement — only one statement is allowed`);
    }
    const c = cursorOver(tokens);
    const verb = c.peek();
    if (verb === undefined) refuse('statement', 'no statement — one plain INSERT, UPDATE or DELETE is required');
    const named: Named = { columns: [], seen: new Set() };
    const into: Collected = { literals: [], placeholders: 0 };
    let head: Pick<ParsedDml, 'op' | 'table' | 'setColumns' | 'insertColumns'>;
    if (verb.kind === 'word' && verb.value === 'INSERT') {
      c.next();
      head = { op: 'insert', ...parseInsert(c, named, into) };
    } else if (verb.kind === 'word' && verb.value === 'UPDATE') {
      c.next();
      head = { op: 'update', ...parseUpdate(c, named, into) };
    } else if (verb.kind === 'word' && verb.value === 'DELETE') {
      c.next();
      head = { op: 'delete', ...parseDelete(c, named, into) };
    } else {
      refuse('statement', `"${verb.text}" is not allowed — only one plain INSERT, UPDATE or DELETE is`);
    }
    if (!c.atEnd()) c.unexpected('nothing may follow the statement');
    return { ok: true, parsed: { ...head, columns: named.columns, literals: into.literals, placeholders: into.placeholders, sql } };
  } catch (err) {
    if (err instanceof Refusal) return refused(err.rule, err.message);
    return refused('statement', errorMessage(err));
  }
}

// ------------------------------------------------------------------------------- dmlTargetTable

const DML_TARGET =
  /^\s*(?:INSERT(?:\s+OR\s+[A-Za-z]+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?|DELETE\s+FROM)\s+(?:"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|([A-Za-z_][\w$]*))/i;

/** The table a DML statement names, unquoted — or `undefined` when the text cannot say (the write signal's table, D-PR3-20 a). */
export function dmlTargetTable(sql: string): string | undefined {
  const match = DML_TARGET.exec(stripSqlComments(sql));
  if (match === null) return undefined;
  return match[1]?.replace(/""/g, '"') ?? match[2]?.replace(/``/g, '`') ?? match[3] ?? match[4];
}

// ------------------------------------------------------------------------------- tableFacts

/** A user column by one of these names shadows the real rowid in every statement — the capture and the undo would key on it. */
const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);

const tableRefused = (): BrokeredRefused => refused('table', TABLE_REFUSED);

/** The live columns of a table (`table_xinfo`, a virtual table's hidden columns left out) with the generated flag. */
function liveColumns(db: Database, table: string): ColumnFact[] {
  return tableColumns(db, table)
    .filter((column) => column.hidden !== 1)
    .map((column) => ({ name: column.name, generated: column.hidden >= 2 }));
}

/** Whether any foreign key of any table names `table` as its parent with an action other than NO ACTION. */
function foreignKeyActionOn(db: Database, table: string): boolean {
  const lower = table.toLowerCase();
  const children = selectRows(db, "SELECT name FROM sqlite_master WHERE type = 'table' UNION ALL SELECT name FROM sqlite_temp_master WHERE type = 'table'").map((row) =>
    String(row[0]),
  );
  return children.some((child) =>
    selectRows(db, 'SELECT "table", on_update, on_delete FROM pragma_foreign_key_list(?)', [child]).some(
      (row) => String(row[0]).toLowerCase() === lower && (String(row[1]) !== 'NO ACTION' || String(row[2]) !== 'NO ACTION'),
    ),
  );
}

/** Whether `table` is a CHILD of any foreign key (Gate-5 SEC-6): its own `foreign_key_list` is non-empty. */
function foreignKeyChild(db: Database, table: string): boolean {
  return selectRows(db, 'SELECT 1 FROM pragma_foreign_key_list(?) LIMIT 1', [table]).length > 0;
}

/**
 * The SHAPE rules of a table — the ones that hold for a write AND for an undo: an ordinary
 * rowid table of `main`, unshadowed, untriggered, without `ON CONFLICT REPLACE`, neither named
 * by a foreign-key action nor a foreign key's child while foreign keys are on (the parent side
 * is a change no count reports; the child side an oracle on the parent key's existence —
 * Gate-5 SEC-6), without a rowid-named column. Answers its live columns and its comment-stripped
 * CREATE text for the scope rules.
 */
function tableShape(db: Database, table: string): { ok: true; columns: ColumnFact[]; ddl: string } | BrokeredRefused {
  const listed = selectRows(db, "SELECT type, wr FROM pragma_table_list WHERE schema = 'main' AND lower(name) = lower(?)", [table]);
  if (listed.length !== 1) return tableRefused();
  const [kind, withoutRowid] = [String(listed[0]?.[0]), Number(listed[0]?.[1])];
  if (kind !== 'table' || withoutRowid !== 0) return tableRefused();
  const shadowed = selectRows(db, "SELECT 1 FROM sqlite_temp_master WHERE lower(name) = lower(?) AND type IN ('table', 'view')", [table]);
  if (shadowed.length > 0) return tableRefused();
  const triggered = selectRows(
    db,
    "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND lower(tbl_name) = lower(?) UNION ALL SELECT 1 FROM sqlite_temp_master WHERE type = 'trigger' AND lower(tbl_name) = lower(?)",
    [table, table],
  );
  if (triggered.length > 0) return tableRefused();
  const ddl = stripSqlComments(String(selectRows(db, "SELECT sql FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)", [table])[0]?.[0] ?? ''));
  if (/\bON\s+CONFLICT\s+REPLACE\b/i.test(ddl)) return tableRefused();
  const columns = liveColumns(db, table);
  if (columns.some((column) => ROWID_NAMES.has(column.name.toLowerCase()))) return tableRefused();
  const foreignKeys = Number(selectRows(db, 'PRAGMA foreign_keys')[0]?.[0] ?? 0) === 1;
  if (foreignKeys && (foreignKeyActionOn(db, table) || foreignKeyChild(db, table))) return tableRefused();
  return { ok: true, columns, ddl };
}

/**
 * The table rules for a brokered write, read from the RAW handle — see the header. Never
 * throws: a handle that cannot answer refuses (fail closed).
 */
export function tableFacts(db: Database, table: string, scope: { columns: readonly string[] }, op: BrokeredOp): BrokeredFactsResult {
  try {
    const shape = tableShape(db, table);
    if (!shape.ok) return shape;
    const granted = new Set(scope.columns.map((column) => column.toLowerCase()));
    const outside = shape.columns.filter((column) => !granted.has(column.name.toLowerCase()));
    if (outside.length > 0 && /\bCHECK\s*\(/i.test(shape.ddl)) return tableRefused();
    if (op === 'delete' && (outside.length > 0 || shape.columns.some((column) => column.generated || isCredentialKeyName(column.name)))) {
      return tableRefused();
    }
    return { ok: true, columns: shape.columns };
  } catch (err) {
    return refused('table', `${TABLE_REFUSED} (${errorMessage(err)})`);
  }
}

// ------------------------------------------------------------------------------- the column rule

/**
 * The named columns resolved against the live facts in the FACTS' spelling: each must exist,
 * be granted and not be generated — refused by name (`column` / `computed`).
 */
function resolveColumns(facts: readonly ColumnFact[], granted: readonly string[], named: readonly string[]): { ok: true; columns: string[] } | BrokeredRefused {
  const grantedLower = new Set(granted.map((column) => column.toLowerCase()));
  const columns: string[] = [];
  for (const name of named) {
    const fact = facts.find((column) => column.name.toLowerCase() === name.toLowerCase());
    if (fact === undefined || !grantedLower.has(fact.name.toLowerCase())) return refused('column', `a column it names isn't shared: "${name}"`);
    if (fact.generated) return refused('computed', `a computed column can't be used in a change: "${name}"`);
    columns.push(fact.name);
  }
  return { ok: true, columns };
}

/** The columns a statement's capture lists, canonical: SET (UPDATE), the INSERT list, or every non-generated column (DELETE). */
function captureColumns(plan: Pick<BrokeredPlan, 'op' | 'columns' | 'setColumns' | 'insertColumns'>, facts: readonly ColumnFact[]): { ok: true; columns: string[] } | BrokeredRefused {
  switch (plan.op) {
    case 'update':
      if (plan.setColumns === undefined || plan.setColumns.length === 0) return refused('statement', 'an update names no SET columns');
      return resolveColumns(facts, plan.columns, plan.setColumns);
    case 'insert':
      if (plan.insertColumns === undefined || plan.insertColumns.length === 0) return refused('statement', 'an insert names no columns');
      return resolveColumns(facts, plan.columns, plan.insertColumns);
    case 'delete':
      return { ok: true, columns: facts.filter((column) => !column.generated).map((column) => column.name) };
    default: {
      const never: never = plan.op;
      return never;
    }
  }
}

// ------------------------------------------------------------------------------- the capture

interface Capture {
  rows: string;
  trigger: string;
}

/** Eight hex digits per apply, so two applies never share a capture name. */
function hex8(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Create the capture table and trigger for one plan — each name recorded in `created` only
 * AFTER its CREATE succeeded, so the belt's drop can never touch an object this apply did
 * not make.
 */
function createCapture(db: Database, plan: Pick<BrokeredPlan, 'op' | 'table'>, columns: readonly string[], suffix: string, created: string[]): Capture {
  const capture: Capture = { rows: `snug_undo_rows_${suffix}`, trigger: `snug_undo_trigger_${suffix}` };
  const cells = plan.op === 'update' ? columns.length * 2 : columns.length;
  const slots = Array.from({ length: cells }, (_, index) => `c${index}`).join(', ');
  db.run(`CREATE TEMP TABLE ${capture.rows} (snug_rowid INTEGER${cells > 0 ? `, ${slots}` : ''})`);
  created.push(`TABLE ${capture.rows}`);
  const of = (ref: 'old' | 'new'): string => columns.map((column) => `${ref}.${quoteIdent(column)}`).join(', ');
  const body = ((): string => {
    switch (plan.op) {
      case 'update':
        return `BEFORE UPDATE ON ${quoteIdent(plan.table)} BEGIN INSERT INTO ${capture.rows} VALUES (new.rowid, ${of('old')}, ${of('new')}); END`;
      case 'delete':
        return `BEFORE DELETE ON ${quoteIdent(plan.table)} BEGIN INSERT INTO ${capture.rows} VALUES (old.rowid${columns.length > 0 ? `, ${of('old')}` : ''}); END`;
      case 'insert':
        return `AFTER INSERT ON ${quoteIdent(plan.table)} BEGIN INSERT INTO ${capture.rows} VALUES (new.rowid, ${of('new')}); END`;
      default: {
        const never: never = plan.op;
        return never;
      }
    }
  })();
  db.run(`CREATE TEMP TRIGGER ${capture.trigger} ${body}`);
  created.push(`TRIGGER ${capture.trigger}`);
  return capture;
}

/** The captured rows as the journal keeps them — positional cells mapped back under the step's columns. */
function readCapture(db: Database, capture: Capture, plan: Pick<BrokeredPlan, 'op' | 'table'>, columns: readonly string[]): UndoStep {
  const width = columns.length;
  const rows: UndoRow[] = selectRows(db, `SELECT * FROM ${capture.rows}`).map((row) => {
    const rowid = Number(row[0]);
    const cells = row.slice(1);
    switch (plan.op) {
      case 'update':
        return { rowid, before: cells.slice(0, width), after: cells.slice(width, width * 2) };
      case 'delete':
        return { rowid, before: cells.slice(0, width) };
      case 'insert':
        return { rowid, after: cells.slice(0, width) };
      default: {
        const never: never = plan.op;
        return never;
      }
    }
  });
  return { table: plan.table, op: plan.op, columns: [...columns], rows };
}

function dropCapture(db: Database, capture: Capture, created: string[]): void {
  db.run(`DROP TRIGGER ${capture.trigger}`);
  db.run(`DROP TABLE ${capture.rows}`);
  created.splice(0, created.length, ...created.filter((name) => name !== `TRIGGER ${capture.trigger}` && name !== `TABLE ${capture.rows}`));
}

/** The belt on every exit: whatever this apply created and did not drop goes, errors swallowed. */
function dropCreated(db: Database, created: readonly string[]): void {
  for (const name of [...created].reverse()) {
    try {
      db.run(`DROP ${name.startsWith('TRIGGER ') ? 'TRIGGER' : 'TABLE'} IF EXISTS ${name.slice(name.indexOf(' ') + 1)}`);
    } catch {
      /* the transaction's rollback already removed it, or the handle is gone */
    }
  }
}

/**
 * Run ONE statement to completion with its params bound; the rows it answers (none for plain
 * DML) are discarded. A second statement after it is refused by name — the engine is the judge
 * of where a statement ends (a `;` inside a literal is not one), so the tail is read from the
 * compiled statement, as the driver's `exec` reads it.
 */
function runToEnd(db: Database, sql: string, params: readonly unknown[] | undefined): void {
  const iterator = db.iterateStatements(sql);
  const first = iterator.next();
  if (first.done === true) refuse('statement', 'no SQL statement to execute');
  const statement = first.value;
  try {
    if (!isSqlTailEmpty(iterator.getRemainingSQL())) refuse('statement', 'one statement at a time — a second statement follows the first');
    if (params !== undefined && params.length > 0) statement.bind(params.map((param) => (param === undefined ? null : param)) as BindParams);
    while (statement.step()) {
      /* a plain DML statement answers no rows */
    }
  } finally {
    statement.free();
  }
}

/**
 * One plan inside an open transaction: the capture objects (when asked), the statement,
 * `sqlite3_changes()`, the captured rows, the capture dropped. Throws on any SQL failure —
 * the caller's `finally` rolls back and drops.
 */
function runPlan(
  db: Database,
  plan: BrokeredPlan,
  columns: readonly string[],
  capture: { suffix: string; created: string[] } | undefined,
): { changes: number; step?: UndoStep } {
  const objects = capture === undefined ? undefined : createCapture(db, plan, columns, capture.suffix, capture.created);
  runToEnd(db, plan.sql, plan.params);
  const changes = db.getRowsModified();
  if (objects === undefined || capture === undefined) return { changes };
  const step = readCapture(db, objects, plan, columns);
  dropCapture(db, objects, capture.created);
  return { changes, step };
}

// ------------------------------------------------------------------------------- the cell rule

/**
 * The journal's text bound: the protocol's `ACCESS_PARAM_STRING_MAX_CHARS` (4096), spelled here
 * and not imported — see THE WORKER'S BUNDLE in the header. The two numbers must stay equal.
 */
const JOURNAL_TEXT_MAX_CHARS = 4096;

type CellRefusal = { reason: 'unsafe' | 'too-large'; message: string };

const UNSAFE_CELL: CellRefusal = { reason: 'unsafe', message: "a value in the rows it changes can't be kept for an undo" };
const LONG_CELL: CellRefusal = { reason: 'too-large', message: 'a value in the rows it changes is too large to undo' };

/**
 * Whether the journal can hold `cell` — the protocol's `accessParamSchema` (a string of at most
 * `ACCESS_PARAM_STRING_MAX_CHARS` characters, a finite number, a boolean, null) as a PURE
 * predicate, so the Worker's bundle carries no schema (see the header). The caller judges length
 * first: an over-long text is `too-large`; anything else outside is `unsafe`.
 */
const journalableCell = (cell: unknown): boolean =>
  cell === null || typeof cell === 'boolean' || (typeof cell === 'number' && Number.isFinite(cell)) || (typeof cell === 'string' && cell.length <= JOURNAL_TEXT_MAX_CHARS);

/**
 * One captured cell judged UNDER ITS COLUMN (D-Q15, S12): an over-long text, a BLOB, NaN or
 * anything else the journal cannot hold, and a credential-shaped text by the ONE walk. Never
 * names the value.
 */
function cellRefusal(column: string, cell: unknown): CellRefusal | undefined {
  if (typeof cell === 'string' && cell.length > JOURNAL_TEXT_MAX_CHARS) return LONG_CELL;
  if (!journalableCell(cell)) return UNSAFE_CELL;
  if (typeof cell === 'string' && findRecordCredential({ [column]: cell }) !== undefined) return UNSAFE_CELL;
  return undefined;
}

function stepRefusal(step: UndoStep): CellRefusal | undefined {
  for (const row of step.rows) {
    for (const cells of [row.before, row.after]) {
      if (cells === undefined) continue;
      for (const [index, cell] of cells.entries()) {
        const hit = cellRefusal(step.columns[index] ?? '', cell);
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

const journalBytes = (steps: readonly UndoStep[]): number => utf8ByteLength(JSON.stringify(steps));

// ------------------------------------------------------------------------------- planBrokeredWrite

const TOO_MANY = (max: number): string => `too many rows — at most ${max} at a time`;
const TOO_LARGE = 'too large to undo';

/**
 * Plan ONE brokered write on a scoped copy of `bytes` built for a plan — see the header for
 * the order. Runs in the Worker. Never throws: every outcome is data, and no row or value
 * leaves.
 */
export function planBrokeredWrite(
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  scope: ScopedReadScope,
  statement: ScopedReadStatement,
  caps: BrokeredCaps,
): BrokeredPlanResult {
  const parsed = parseBrokeredStatement(statement.sql);
  if (!parsed.ok) return parsed;
  const { op, table, columns: named, setColumns, insertColumns, literals } = parsed.parsed;
  const forbidden = forbiddenStatementReason(statement.sql);
  if (forbidden !== undefined) return refused('statement', `forbidden statement: ${forbidden}`);

  const granted = scope.tables.find((entry) => entry.name.toLowerCase() === table.toLowerCase());
  if (granted === undefined || granted.write !== true) return { ok: false, reason: 'not-granted', message: 'this access is read-only for that table' };

  let scratch: Database | undefined;
  let began = false;
  try {
    scratch = new SQL.Database(bytes);
    const facts = tableFacts(scratch, granted.name, { columns: granted.columns }, op);
    if (!facts.ok) return facts;
    const resolved = resolveColumns(facts.columns, granted.columns, named);
    if (!resolved.ok) return resolved;
    const captured = captureColumns({ op, columns: [...granted.columns], ...(setColumns === undefined ? {} : { setColumns }), ...(insertColumns === undefined ? {} : { insertColumns }) }, facts.columns);
    if (!captured.ok) return captured;

    const params = statement.params ?? [];
    if (findRecordCredential([...literals, ...params]) !== undefined) return refused('value', "a value in it can't be matched");

    const copy = scopeCopy(scratch, scope, { forPlan: true });
    if (!copy.ok) return copy;
    const masked = named.find((column) => copy.masked.has(`${granted.name.toLowerCase()}.${column.toLowerCase()}`));
    if (masked !== undefined) return refused('column', `a column it names isn't shared: "${masked}"`);

    const plan: BrokeredPlan = {
      sql: statement.sql,
      ...(statement.params === undefined ? {} : { params: statement.params }),
      op,
      table: granted.name,
      columns: [...granted.columns],
      ...(setColumns === undefined ? {} : { setColumns }),
      ...(insertColumns === undefined ? {} : { insertColumns }),
      previewChanges: 0,
    };
    scratch.run('BEGIN');
    began = true;
    const created: string[] = [];
    let outcome: { changes: number; step?: UndoStep };
    try {
      outcome = runPlan(scratch, plan, captured.columns, { suffix: hex8(), created });
    } finally {
      dropCreated(scratch, created);
    }
    if (outcome.changes > caps.maxChanges) return { ok: false, reason: 'too-many', message: TOO_MANY(caps.maxChanges) };
    if (outcome.step !== undefined) {
      const cell = stepRefusal(outcome.step);
      if (cell !== undefined) return { ok: false, ...cell };
      if (journalBytes([outcome.step]) > caps.maxUndoBytes) return { ok: false, reason: 'too-large', message: TOO_LARGE };
    }
    return { ok: true, plan: { ...plan, previewChanges: outcome.changes } };
  } catch (err) {
    return { ok: false, reason: 'failed', message: errorMessage(err) };
  } finally {
    if (began && scratch !== undefined) {
      try {
        scratch.run('ROLLBACK'); // the dry run never lands
      } catch {
        /* the copy is closed below either way */
      }
    }
    scratch?.close();
  }
}

// ------------------------------------------------------------------------------- buildUndoStatement

/** The inverse of one captured row, from the structure alone — see the header. Throws only on a row that lacks its op's seat. */
export function buildUndoStatement(step: UndoStep, row: UndoRow): { sql: string; params: unknown[] } {
  const table = quoteIdent(step.table);
  const columns = step.columns.map(quoteIdent);
  const guard = (cells: unknown[]): { sql: string; params: unknown[] } => ({
    sql: ['rowid = ?', ...columns.map((column) => `${column} IS ?`)].join(' AND '),
    params: [row.rowid, ...cells],
  });
  const seat = (cells: unknown[] | undefined, name: 'before' | 'after'): unknown[] => {
    if (cells === undefined || cells.length !== step.columns.length) throw new Error(`a row of an "${step.op}" step holds no "${name}" values, one per column`);
    return cells;
  };
  switch (step.op) {
    case 'insert': {
      const where = guard(seat(row.after, 'after'));
      return { sql: `DELETE FROM ${table} WHERE ${where.sql}`, params: where.params };
    }
    case 'update': {
      const before = seat(row.before, 'before');
      const where = guard(seat(row.after, 'after'));
      return { sql: `UPDATE ${table} SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE ${where.sql}`, params: [...before, ...where.params] };
    }
    case 'delete': {
      const before = seat(row.before, 'before');
      return {
        sql: `INSERT INTO ${table} (rowid${columns.length > 0 ? `, ${columns.join(', ')}` : ''}) VALUES (${['?', ...columns.map(() => '?')].join(', ')})`,
        params: [row.rowid, ...before],
      };
    }
    default: {
      const never: never = step.op;
      return never;
    }
  }
}

// ------------------------------------------------------------------------------- applyBrokeredBatch

const WITHIN_TRANSACTION = /within a transaction/i;
/** The one `busy` answer — the seat's from its `BEGIN IMMEDIATE`, and the driver's from its transaction record (Gate-5 W-6: one spelling). */
export const BUSY_REFUSAL = { ok: false, reason: 'busy', message: 'the app is in the middle of a change' } as const satisfies ApplyRefusal;
const DRIFTED = 'the rows changed since the change was planned';

/** A throw inside an apply, answered as data: a refusal thrown by name keeps its rule; anything else is `failed` (S11). */
const thrown = (err: unknown): BrokeredApplyResult => (err instanceof Refusal ? refused(err.rule, err.message) : { ok: false, reason: 'failed', message: errorMessage(err) });

/** This apply's own transaction rolled back, errors swallowed — nothing of this apply's can be left open. */
function rollBack(db: Database): void {
  try {
    db.run('ROLLBACK');
  } catch {
    /* nothing of this apply's can be left open */
  }
}

/**
 * Open this apply's own transaction. `busy` when the app holds one — nothing of the app's is
 * touched (D-Q3); any other failure is `failed`.
 */
function beginImmediate(db: Database): ApplyRefusal | undefined {
  try {
    db.run('BEGIN IMMEDIATE');
    return undefined;
  } catch (err) {
    const message = errorMessage(err);
    return WITHIN_TRANSACTION.test(message) ? BUSY_REFUSAL : { ok: false, reason: 'failed', message };
  }
}

interface PreparedPlan {
  plan: BrokeredPlan;
  columns: string[];
}

function applyPlans(db: Database, input: Extract<BrokeredApplyInput, { plans: unknown }>): BrokeredApplyResult {
  const { plans, caps, expectChanges, requireUndo, capture } = input;
  // Phase 1 — before any transaction: the belt and the table rules on the LIVE handle, per plan.
  const prepared: PreparedPlan[] = [];
  for (const plan of plans) {
    const forbidden = forbiddenStatementReason(plan.sql);
    if (forbidden !== undefined) return refused('statement', `forbidden statement: ${forbidden}`);
    const facts = tableFacts(db, plan.table, { columns: plan.columns }, plan.op);
    if (!facts.ok) return facts;
    const columns = captureColumns(plan, facts.columns);
    if (!columns.ok) return columns;
    prepared.push({ plan, columns: columns.columns });
  }
  // Phase 2 — the transaction.
  const created: string[] = [];
  const steps: UndoStep[] = [];
  const changes: number[] = [];
  let undoable = capture;
  let began = false;
  let committed = false;
  try {
    const refusal = beginImmediate(db);
    if (refusal !== undefined) return refusal;
    began = true;
    const suffix = hex8();
    for (const [index, { plan, columns }] of prepared.entries()) {
      const outcome = runPlan(db, plan, columns, capture ? { suffix, created } : undefined);
      changes.push(outcome.changes);
      if (outcome.changes > caps.maxChanges) return { ok: false, reason: 'too-many', message: TOO_MANY(caps.maxChanges) };
      const expected = expectChanges?.[index];
      if (expected !== undefined && expected !== outcome.changes) {
        return { ok: false, reason: 'drifted', message: DRIFTED, previewed: [...(expectChanges ?? [])], current: [...changes] };
      }
      if (outcome.step === undefined || !undoable) continue;
      const cell = stepRefusal(outcome.step);
      if (cell !== undefined) {
        if (requireUndo) return { ok: false, ...cell };
        undoable = false;
        continue;
      }
      steps.push(outcome.step);
      if (journalBytes(steps) > caps.maxUndoBytes) {
        if (requireUndo) return { ok: false, reason: 'too-large', message: TOO_LARGE };
        undoable = false;
      }
    }
    db.run('COMMIT');
    committed = true;
    // A step that captured no row has nothing to put back, and an empty step never parses into the journal (W-1).
    const captured = steps.filter((step) => step.rows.length > 0);
    return { ok: true, steps: undoable ? captured : [], changes, undoable: undoable && captured.length > 0 };
  } catch (err) {
    return thrown(err);
  } finally {
    if (began && !committed) rollBack(db);
    dropCreated(db, created);
  }
}

/**
 * Own mode (D-PR3-8): the app's own approved statements — the text belts, then each statement
 * counted under this apply's own transaction with the approved counts as the halt; see OWN MODE
 * in the header. No facts, no capture, never undoable.
 */
function applyOwn(db: Database, input: Extract<BrokeredApplyInput, { own: unknown }>): BrokeredApplyResult {
  const { own, expectChanges } = input;
  // Phase 1 — before any transaction: the belts on every statement's text (S3; R-B1's class guard at the gate that touches data).
  for (const statement of own) {
    const forbidden = forbiddenStatementReason(statement.sql);
    if (forbidden !== undefined) return refused('statement', `forbidden statement: ${forbidden}`);
    const outOfClass = nonDataStatementReason(statement.sql);
    if (outOfClass !== undefined) return refused('statement', outOfClass);
  }
  // Phase 2 — the transaction: each statement in order and counted; a count the user did not approve halts the whole batch.
  const changes: number[] = [];
  let began = false;
  let committed = false;
  try {
    const refusal = beginImmediate(db);
    if (refusal !== undefined) return refusal;
    began = true;
    for (const [index, statement] of own.entries()) {
      runToEnd(db, statement.sql, statement.params);
      const count = db.getRowsModified();
      changes.push(count);
      const expected = expectChanges?.[index];
      if (expected !== undefined && expected !== count) return { ok: false, reason: 'drifted', message: DRIFTED, previewed: [...(expectChanges ?? [])], current: [...changes] };
    }
    db.run('COMMIT');
    committed = true;
    return { ok: true, steps: [], changes, undoable: false };
  } catch (err) {
    return thrown(err);
  } finally {
    if (began && !committed) rollBack(db);
  }
}

interface BuiltUndo {
  sql: string;
  params: unknown[];
  step: number;
}

function applyUndo(db: Database, steps: readonly UndoStep[]): BrokeredApplyResult {
  // Phase 1 — every step against the live schema, every statement built and belted, before any transaction.
  const built: BuiltUndo[] = [];
  for (const [index, step] of steps.entries()) {
    let shape: ReturnType<typeof tableShape>;
    try {
      shape = tableShape(db, step.table);
    } catch (err) {
      return refused('table', `${TABLE_REFUSED} (${errorMessage(err)})`);
    }
    if (!shape.ok) return shape;
    const resolved = resolveColumns(shape.columns, shape.columns.map((column) => column.name), step.columns);
    if (!resolved.ok) return resolved;
    // A genuine entry never NAMES a credential column (the plan refused it by name; a DELETE on a table
    // holding one was refused whole) — a step that does is planted, and its inverse would write under it (Gate-5 SEC-4).
    if (resolved.columns.some(isCredentialKeyName)) return refused('column', "a column it names isn't shared");
    const canonical: UndoStep = { ...step, columns: resolved.columns };
    for (const row of step.rows) {
      let statement: { sql: string; params: unknown[] };
      try {
        statement = buildUndoStatement(canonical, row);
      } catch (err) {
        return refused('statement', errorMessage(err));
      }
      const forbidden = forbiddenStatementReason(statement.sql);
      if (forbidden !== undefined) return refused('statement', `forbidden statement: ${forbidden}`);
      built.push({ ...statement, step: index });
    }
  }
  // Phase 2 — the transaction: every inverse must put back exactly ONE row, or the whole undo rolls back.
  const changes: number[] = steps.map(() => 0);
  let began = false;
  let committed = false;
  try {
    const refusal = beginImmediate(db);
    if (refusal !== undefined) return refusal;
    began = true;
    for (const statement of built) {
      runToEnd(db, statement.sql, statement.params);
      if (db.getRowsModified() !== 1) return { ok: false, reason: 'drifted', message: 'the other app changed these rows since' };
      changes[statement.step] = (changes[statement.step] ?? 0) + 1;
    }
    db.run('COMMIT');
    committed = true;
    return { ok: true, steps: [], changes, undoable: false };
  } catch (err) {
    return thrown(err);
  } finally {
    if (began && !committed) rollBack(db);
  }
}

/**
 * Apply the Worker's plans — or the app's own approved statements, or reverse an undo's steps —
 * atomically and SYNCHRONOUSLY on the live handle; see the header. Never throws: every outcome
 * is data.
 */
export function applyBrokeredBatch(db: Database, input: BrokeredApplyInput): BrokeredApplyResult {
  if ('plans' in input) return applyPlans(db, input);
  if ('own' in input) return applyOwn(db, input);
  return applyUndo(db, input.undo);
}
