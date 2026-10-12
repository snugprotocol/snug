// agent/copy.dataWrite.ts — the chat's data-write card, in words (TASK-20261010-host-broker PR-4,
// D-PR4-19; design D16, D20). The card (`views/ChatLog.tsx`) shows a change the chat's AI proposed
// to the app's OWN data — the summary, the verbatim statements and their dry-run counts — and,
// once the user answered, what became of it. Its sentences were JSX literals; they live here now,
// ONE home, so the vocabulary scan (`scheduleCopy.test.ts`, which reads this file) sees them and the
// count is always `rowsWord`'s — never "row(s)". The own-app undo's words are `access/copy.ts`'s
// `OWN_UNDO` (the ⋈ sheet's, reused), never respelled here.
//
// The voice is the chat's: lowercase-leading, plain words; a new sentence takes the typographic
// apostrophe.
//
// TASK-20261010-host-broker PR-5 (D-PR5-14, D-PR5-14a; D8, D9; v2.1 N6) adds the CROSS-APP card's
// words: a change the chat's AI proposed to ANOTHER app's table, which the user applies on the
// card. The host's line leads and says once that it can be undone; the count is a host fact said
// before any apply; the acts are this card's own (*apply to Ledger* / *cancel*, never approve or
// decline). Every failure says that nothing was changed — and *busy* and *waiting* are not the
// end of the card, so their words sit above the acts, which stay. The word *history* is never on
// the card: the access act opens the source's ⋈ sheet where the change and its undo are listed.
//
// Gate-5 fold G5-16 (ii-9): the lead's undo clause is said only where an undo is live — while the
// card waits, and once applied with its undo still in the source's journal; every other state opens
// on the plain lead. The days are `ACCESS_UNDO_TTL_MS`'s, never spelled apart from it.
//
// Gate-5 fold G5-17: what the chat's *fetch new data first* came to is persisted on the person's
// message as STRUCTURED facts (`meta.fetched`), never a sentence; `FETCH_FACTS` words them — the ONE
// wording, from `FETCH_FIRST`: the note under the person's message (the hook), the log with each
// name isolated, and the brain's one host line (`agent/chatFetch.ts`).

import { ACCESS_UNDO_TTL_MS, type ChatFetchFact } from '@snugprotocol/protocol';

import { ACCESS_SHEET, FETCH_FIRST, OWN_UNDO, OWN_UNDO_NO_LONGER, relativeTime, rowsWord } from '../access/copy.js';
import { changedRows } from '../schedule/copy.js';
import type { AccessWriteFailedWhy } from './accessWriteCard.js';

const DAY_MS = 86_400_000;
/** A small count in words — the lead says *seven days*, not *7 days*. */
const SMALL_COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'] as const;
/** How long a change to another app's data can be undone, in words — from the journal's own time to live. */
const UNDO_DAYS = ((days: number): string => `${SMALL_COUNT_WORDS[days] ?? String(days)} ${days === 1 ? 'day' : 'days'}`)(Math.round(ACCESS_UNDO_TTL_MS / DAY_MS));

/** "a change to Ledger’s transactions" — the cross-app card's lead without its undo clause. */
const crossLeadPlain = (sourceName: string, table: string): string => `a change to ${sourceName}’s ${table}`;

/** What an applied card says about its undo: offered (the act follows), no longer live (undone elsewhere, or aged out), or never possible. */
export type DataWriteUndoState = 'offered' | 'ended' | 'none';

export const DATA_WRITE_CARD = {
  apply: 'apply to my data',
  cancel: 'cancel',
  /** After each statement: its dry-run count — "— 2 rows". */
  previewed: (n: number): string => `— ${rowsWord(n)}`,
  /** "applied — 2 rows changed", with what it says about its undo. */
  appliedLine: (n: number, undo: DataWriteUndoState): string => {
    const line = `applied — ${rowsWord(n)} changed`;
    switch (undo) {
      case 'offered':
        return line;
      case 'ended':
        return `${line} · ${OWN_UNDO_NO_LONGER}`;
      case 'none':
        return `${line} · this one can’t be undone`;
      default: {
        const never: never = undo;
        return never;
      }
    }
  },
  undone: OWN_UNDO.undone,
  declined: 'cancelled — nothing was changed',
  /** The drift halt: the count moved between the preview and the approval. */
  drifted: 'the number of rows this would affect changed since the preview, so nothing was applied — ask again for a fresh one',
  failed: 'the change could not be applied — nothing was changed',
  /**
   * An approval that carries a seat no change to the app's OWN data has — another app's target among
   * them (Gate-5 G5-16 ii-4, D-PR5-10's second belt): refused before anything runs.
   */
  notOwn: 'that change isn’t one for this app’s own data — nothing was changed',
  // PR-5 — the cross-app card (D-PR5-14).
  /** The HOST line the card opens on, said once: whose table, and — while an undo is live — that the change can be undone. */
  crossLead: (sourceName: string, table: string): string => `${crossLeadPlain(sourceName, table)} — you can undo it for ${UNDO_DAYS}`,
  /** The lead where no undo is live (G5-16 ii-9): settled without a change, or applied with its undo gone or never made. */
  crossLeadPlain,
  /** The count, as a host fact, before any apply. */
  crossWould: (n: number, sourceName: string): string => `would change ${rowsWord(n)} in ${sourceName}`,
  crossApply: (sourceName: string): string => `apply to ${sourceName}`,
  /** Applied: what changed — the words the result page and the schedule's changes list share. */
  crossApplied: (n: number, sourceName: string): string => changedRows(n, sourceName),
  /** The applied line with its LIVE undo state, read from the source's journal: live (the access act follows), undone, or no longer undoable. */
  crossAppliedLine: (n: number, sourceName: string, undo: CrossUndoState): string => {
    const line = changedRows(n, sourceName);
    switch (undo) {
      case 'live':
        return line;
      case 'undone':
        return `${line} · ${OWN_UNDO.undone}`;
      case 'ended':
        return `${line} · ${OWN_UNDO_NO_LONGER}`;
      default: {
        const never: never = undo;
        return never;
      }
    }
  },
  /** The act that opens the source's ⋈ sheet in place, on its history — named by the sheet's own title. */
  crossOpenAccess: (sourceName: string): string => `open ${ACCESS_SHEET.title(sourceName)}`,
  /**
   * Why an apply did not change anything (D-PR5-14a): the reader and the source by their library
   * names, the table by its own. `drifted` and `failed` are this card's existing sentences.
   */
  crossFailed: (why: AccessWriteFailedWhy, names: CrossNames): string => CROSS_FAILED_WORDS[why](names),
} as const;

/** What an applied cross-app card says about its undo, from the source's journal. */
export type CrossUndoState = 'live' | 'undone' | 'ended';

/** The names a cross-app failure is said with. */
export interface CrossNames {
  readerName: string;
  sourceName: string;
  table: string;
}

const CROSS_FAILED_WORDS: Readonly<Record<AccessWriteFailedWhy, (names: CrossNames) => string>> = {
  ended: ({ readerName, sourceName }) => `${readerName}’s access to ${sourceName} ended — nothing was changed; allow it again from ${readerName}’s access`,
  'not-allowed': ({ readerName, sourceName, table }) => `${readerName} may no longer change ${sourceName}’s ${table} — nothing was changed`,
  busy: ({ sourceName }) => `${sourceName} is in the middle of a change — nothing was changed; try again in a moment`,
  refused: ({ sourceName }) => `${sourceName} refused this change — nothing was changed`,
  waiting: ({ readerName, sourceName }) => `too many of ${readerName}’s changes to ${sourceName} are waiting to be undone — undo some from ${sourceName}’s access, or wait`,
  gone: ({ sourceName, table }) => `${sourceName} or its ${table} are gone — nothing was changed`,
  drifted: () => DATA_WRITE_CARD.drifted,
  failed: () => DATA_WRITE_CARD.failed,
};

/** The facts of a note, side by side. */
const FACT_SEPARATOR = ' · ';
const MINUTE_MS = 60_000;

/** One fact in `FETCH_FIRST`'s words, its source by name; `now` dates a recent fetch's minutes. */
function factWords({ source, ...fact }: ChatFetchFact, now: number): string {
  switch (fact.outcome) {
    case 'fresh':
      return FETCH_FIRST.done(source);
    case 'recent': {
      // The fetch inside the cooldown this turn used: when it was, and how it went when that is known.
      if (fact.minutes === undefined) return FETCH_FIRST.recentUsed(source);
      const when = relativeTime(now - fact.minutes * MINUTE_MS, now);
      return fact.ok === undefined ? FETCH_FIRST.askedRecently(source, when) : FETCH_FIRST.recent(source, when, fact.ok);
    }
    case 'failed':
      return FETCH_FIRST.failed(source);
    case 'skipped':
      return FETCH_FIRST.skipped(source);
    case 'stopped':
      return FETCH_FIRST.stopped(source);
    case 'none':
      // The one fact of a fetch with nothing to ask: its `source` is the app the chat sits beside.
      return FETCH_FIRST.nothingToAsk(source);
    default: {
      const never: never = fact.outcome;
      return never;
    }
  }
}

/**
 * The chat's fetch facts in words (G5-17) — each re-worded from `FETCH_FIRST`, never read from a row.
 * A view that isolates the names passes each fact with a mark for its `source` and puts the name back.
 */
export const FETCH_FACTS = {
  /** The note: every fact, in order, side by side. */
  note: (facts: readonly ChatFetchFact[], now: number): string => facts.map((fact) => factWords(fact, now)).join(FACT_SEPARATOR),
} as const;
