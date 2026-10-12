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

import { ACCESS_SHEET, OWN_UNDO, OWN_UNDO_NO_LONGER, rowsWord } from '../access/copy.js';
import { changedRows } from '../schedule/copy.js';
import type { AccessWriteFailedWhy } from './accessWriteCard.js';

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
  // PR-5 — the cross-app card (D-PR5-14).
  /** The HOST line the card opens on, said once: whose table, and that the change can be undone. */
  crossLead: (sourceName: string, table: string): string => `a change to ${sourceName}’s ${table} — you can undo it for seven days`,
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
