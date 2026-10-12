// The kit's `agent/accessWriteCard.ts` (TASK-20261010-host-broker PR-5, D-PR5-16): the chat's
// CROSS-APP card as state — its strict reader, its persisted shape and the apply its act reaches,
// which carries the chat's write verbs (`access/chatWrite.ts`) and through them the Write Broker.
// In the kit no turn is ever routed to the data lane that stages one (`./chatRouter.ts`,
// `./laneTools.ts`), and its surface is swapped out with it (`./AccessWriteCard.tsx`), so the only
// calls the kit can reach are the READ a chat row from another host may hit — a file the desktop
// wrote, opened here — and the persist of an answer no card can give. The read answers NO card
// (the real module's own answer for a row it will not stand behind) and the persist is a no-op;
// serialising a card or applying one names the fact. The shapes mirror the real module's
// (`kitDeadLanes.test.ts` checks them with `expectTypeOf`).

import type { UserDb } from '@snugprotocol/db';

import { noDataLane } from './noDataLane.js';

export type AccessWriteFailedWhy = 'busy' | 'drifted' | 'ended' | 'not-allowed' | 'refused' | 'waiting' | 'gone' | 'failed';

export interface AccessWriteTarget {
  grantId: string;
  grantedAt: string;
  sourceAppId: string;
  table: string;
}

export type AccessWriteOutcome = 'applied' | 'declined' | 'drifted' | 'failed';

export interface AccessWriteCardState {
  appId: string;
  target: AccessWriteTarget;
  sql: string;
  summary?: string;
  previewed: number;
  outcome?: AccessWriteOutcome;
  failedWhy?: AccessWriteFailedWhy;
  undoId?: string;
  messageRowId?: number;
}

export type PersistedAccessWrite = Omit<AccessWriteCardState, 'messageRowId'>;

/** A persisted cross-app card renders NO card in the kit — its surface is swapped out with it. */
export function metaToAccessWrite(_meta: unknown): AccessWriteCardState | undefined {
  return undefined;
}

export function accessWriteToMeta(_card: AccessWriteCardState): { accessWrite: PersistedAccessWrite } {
  throw noDataLane('accessWriteCard.accessWriteToMeta');
}

export function persistAccessWrite(
  _db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  _threadId: string,
  _card: AccessWriteCardState,
): void {
  // No card mounts in the kit (`metaToAccessWrite` admits none), so there is never an answer to persist.
}

export async function approveCrossAppWrite(_db: UserDb, _card: AccessWriteCardState, _options: { threadId: string }): Promise<AccessWriteCardState> {
  throw noDataLane('accessWriteCard.approveCrossAppWrite');
}
