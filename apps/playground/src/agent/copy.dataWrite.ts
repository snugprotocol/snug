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

import { OWN_UNDO, rowsWord } from '../access/copy.js';

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
        return `${line} · can no longer be undone`;
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
} as const;
