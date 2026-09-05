// custodyStore.ts — where the user's file stands relative to its durable copy
// (TASK-20260905-binding-a-artifacts AC5/AC7): the "your file" chip renders THIS, the
// artifact record and the export seat write it. A plain store (the playground's own
// `createStore`), one object, read by the chip through `useStore`.

import { createStore, type Store } from '@playground/state/store';

export interface CustodyState {
  /** The working copy has changes the durable copy does not (a save is owed). */
  dirty: boolean;
  /** No durable write is possible in this view (no `artifact` namespace, or the first refusal came back). */
  readOnly: boolean;
  /** The browser's copy and the page's copy differ; which is the more recent by the save counter. */
  divergence?: 'newer' | 'older';
  /** The last outcome worth telling the user (a refusal, a conflict, an export result). */
  note?: string;
  /** The durable copy's counter and instant, when known. */
  saved?: { saved: number; savedAt: string };
}

export interface CustodyStore extends Store<CustodyState> {
  patch(partial: Partial<CustodyState>): void;
}

export function createCustodyStore(initial: Partial<CustodyState> = {}): CustodyStore {
  const store = createStore<CustodyState>({ dirty: false, readOnly: false, ...initial });
  return {
    ...store,
    patch(partial) {
      const next = { ...store.get(), ...partial };
      // `undefined` in a patch CLEARS the field (a divergence resolved, a note dismissed).
      for (const key of Object.keys(partial) as (keyof CustodyState)[]) if (partial[key] === undefined) delete next[key];
      store.set(next);
    },
  };
}
