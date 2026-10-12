// The kit's `agent/accessCard.ts` (TASK-20261010-host-broker PR-2, the kit-ceiling cut): the
// ask card's state — staging, persisting on the row's `meta.access`, re-admitting a persisted
// row through the protocol's schemas. In the kit no ask is ever staged (`./accessProposeTool.ts`)
// and the card's surface is swapped out with it (`./AccessCard.tsx`), so the only calls the kit
// can reach are the READS a chat row from another host may hit — a file the desktop wrote,
// opened here — and `persistAccessResolution` from a card that never mounts. The reads answer
// NO card (the real module's own answer for a row it cannot stand behind) and the persist is a
// no-op; staging or serialising a card names the fact. The shapes mirror the real module's —
// PR-3's written tables and PR-5's write ask included (D-PR5-16, v2.1 N9; `kitDeadLanes.test.ts`
// checks them with `expectTypeOf`).

import type { UserDb } from '@snugprotocol/db';
import type { AccessDuration, AccessHints } from '@snugprotocol/protocol';

import type { AccessProposal } from './accessProposeTool.js';
import { noDataLane } from './noDataLane.js';

export type AccessCardResolution =
  | { kind: 'allowed'; sourceName: string; tables: string[]; duration: AccessDuration; write?: string[] }
  | { kind: 'not-now' }
  | { kind: 'declined' }
  | { kind: 'failed' };

export interface AccessCardState {
  purpose: string;
  hints?: AccessHints;
  access?: 'write';
  appId: string;
  threadId: string;
  resolution?: AccessCardResolution;
  messageRowId?: number;
}

export type PersistedAccessCard = Omit<AccessCardState, 'messageRowId'>;

export function stageAccessCard(_proposal: AccessProposal, _options: { appId: string; threadId: string }): AccessCardState {
  throw noDataLane('accessCard.stageAccessCard');
}

export function accessCardToMeta(_card: AccessCardState): { access: PersistedAccessCard } {
  throw noDataLane('accessCard.accessCardToMeta');
}

/** A persisted ask renders NO card in the kit — its surface is swapped out with it. */
export function metaToAccessCard(_meta: unknown): AccessCardState | undefined {
  return undefined;
}

export function persistAccessResolution(
  _db: {
    updateChatMessageMeta(id: number, meta: unknown): void;
    listChatMessages(threadId: string): { id: number; meta?: unknown }[];
  },
  _resolved: AccessCardState,
): void {
  // No card mounts in the kit (`metaToAccessCard` admits none), so there is never an answer to persist.
}

export function readAccessCardRow(_db: Pick<UserDb, 'listChatMessages' | 'getThread'>, _threadId: string, _rowId: number): AccessCardState | undefined {
  return undefined;
}
