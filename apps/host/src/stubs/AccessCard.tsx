// The kit's `access/AccessCard.tsx` (TASK-20261010-host-broker PR-2, the kit-ceiling cut): the
// brain's ask card in the chat rail — its outcome line, the consent copy, `startUserAsk` and
// the user-db read behind it. `ChatLog` mounts it only for a message whose `meta.access`
// re-admits as a card, and the kit's `./accessCard.ts` admits none — so the card never mounts
// here, and renders nothing if it is ever asked to. The resolve type stays for `ChatLog` and
// `RunView`, which name it.

import type { AccessCardResolution, AccessCardState } from './accessCard.js';

export type ResolveAccessCard = (card: AccessCardState, messageId: number, resolution: AccessCardResolution) => void;

export interface AccessCardProps {
  card: AccessCardState;
  messageId: number;
  busy: boolean;
  onResolve?: ResolveAccessCard | undefined;
}

export function AccessCard(_props: AccessCardProps): null {
  return null;
}
