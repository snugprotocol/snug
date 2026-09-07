// custodyStore.ts — where the user's file stands relative to its durable copy
// (TASK-20260905-binding-a-artifacts AC5/AC7): the "your file" chip renders THIS, the
// artifact record and the export seat write it. A plain store (the playground's own
// `createStore`), one object, read by the chip through `useStore`.

import type { CustodyState } from '@playground/platform/platform';
import { createStore, type Store } from '@playground/state/store';

export type { CustodyState };

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
