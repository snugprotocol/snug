// The kit's `agent/laneTools.ts` (TASK-20261010-host-broker PR-2, the kit-ceiling cut): the
// lane-scoped tool selection and, through its lazy imports, the data tools, the provider tools,
// the schedule tool, the access tool and the consent rules. In the kit a turn is never routed
// (`./chatRouter.ts`), so `laneToolsFor` is only ever asked for `undefined` — the builder's own
// set — and answers it as the real module does. A ROUTED lane cannot happen here; the stub
// names the fact rather than answering a tool set. `useBuilderChat.ts` re-exports the name;
// the playground and the desktop keep the real module.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposal } from '@snugprotocol/protocol';

import type { AccessProposal } from './accessProposeTool.js';
import type { RoutedLane } from './chatRouter.js';
import { noDataLane } from './noDataLane.js';

/**
 * The real module's seams, mirrored. The shapes `dataTools.ts` and the cross-app card own (the
 * write proposal, the chat door's shared seat and its caller, the cross-app card — PR-5) ride out
 * with the lane: the stub never calls nor reads them.
 */
export interface LaneToolDeps {
  db: UserDb;
  contextTarget: string | undefined;
  threadId: string;
  signal: AbortSignal;
  presentCardTool: AgentTool;
  onDataProposal: (proposal: never) => boolean;
  onProviderFailureCode: (appId: string, code: string) => void;
  onScheduleProposal: (proposal: ScheduleProposal, appId: string | undefined) => boolean;
  onAccessProposal: (proposal: AccessProposal, appId: string) => boolean;
  shared?: unknown;
  accessCaller?: unknown;
  onAccessWriteProposal?: (card: never) => boolean;
}

export function laneToolsFor(route: RoutedLane | undefined, _deps: LaneToolDeps): Promise<AgentTool[] | undefined> {
  if (route === undefined || route.lane === 'feature') return Promise.resolve(undefined);
  return Promise.reject(noDataLane(`laneTools.laneToolsFor('${route.lane}')`));
}
