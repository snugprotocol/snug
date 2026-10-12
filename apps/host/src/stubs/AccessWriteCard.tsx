// The kit's `access/AccessWriteCard.tsx` (TASK-20261010-host-broker PR-5, D-PR5-16): the chat's
// card for a change to ANOTHER app's table — its words, the source's ⋈ sheet it opens in place,
// and the file reads behind it. `ChatLog` mounts it only for a message whose `meta.accessWrite`
// re-admits as a card, and the kit's `./accessWriteCard.ts` admits none — so the card never mounts
// here, and renders nothing if it is ever asked to. The props stay for `ChatLog`, which names them.

import type { AccessWriteCardState } from './accessWriteCard.js';

export interface AccessWriteCardProps {
  card: AccessWriteCardState;
  messageId: number;
  busy: boolean;
  onApply?: (card: AccessWriteCardState, messageId: number) => void;
  onCancel?: (card: AccessWriteCardState, messageId: number) => void;
}

export function AccessWriteCard(_props: AccessWriteCardProps): null {
  return null;
}
