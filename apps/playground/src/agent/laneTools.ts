// agent/laneTools.ts — the lane-scoped tool selection (ADR-0019 D9; TASK-20261009 P2; split out
// of `useBuilderChat.ts` at Gate-5 PR-B M4). The second lock on what a routed turn may reach,
// as ONE EXHAUSTIVE SWITCH over the lane (feasibility F2):
//
//  - `undefined` means "the builder's own set" and is answered ONLY by the feature lane and by
//    an unrouted turn. The else-chain this replaced let any lane it did not name fall through
//    to the full builder set — `artifact_write` in hand — which is the exact failure the lane
//    design exists to prevent. A new lane fails to compile until this switch names its tools.
//  - A ROUTED non-feature lane with NO context target (a thread with no app pinned yet) runs
//    TOOL-FREE (`[]`) — the model answers in words — never the builder set (Gate-5 PR-B S10).
//  - data: the two data tools (`data_read` drops the write tool — a question is not permission
//    to propose a change) + the choice card.
//  - feature: the builder set (its trust story is versioning, not cards).
//  - provider: the governed request tool (read-only unless `provider_write`) + the choice card.
//  - schedule: ONLY `schedule_propose` — no card, no data tool, nothing that writes; where the
//    host does not schedule at all the turn runs tool-free and the model answers in words.
//  - answer: the choice card alone.
//
// Every lane's tools are imported LAZILY, so the chat path loads a tool set only when a turn
// is routed to it.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposal } from '@snugprotocol/protocol';

import { allows } from '../platform/platform.js';
import type { RoutedLane } from './chatRouter.js';
import type { PendingWriteProposal } from './dataTools.js';

/** What the lane tool selection needs from the turn — the seams, never React state. */
export interface LaneToolDeps {
  db: UserDb;
  /** The app the message sits beside (the thread's pin); a routed lane without one runs tool-free. */
  contextTarget: string | undefined;
  threadId: string;
  /** The turn's abort signal — the provider lane threads it so a cancelled turn denies its own parked confirm (AC6). */
  signal: AbortSignal;
  /** The inline choice card, offered to every routed non-feature lane but the schedule lane. */
  presentCardTool: AgentTool;
  /** One data-write proposal per turn; `false` ⇒ not staged. */
  onDataProposal: (proposal: PendingWriteProposal) => boolean;
  /** Provider-lane request failures, code-keyed (TASK-20260815 AC5). */
  onProviderFailureCode: (appId: string, code: string) => void;
  /** One schedule suggestion per turn; `false` ⇒ not staged (TASK-20261009 P1). */
  onScheduleProposal: (proposal: ScheduleProposal, appId: string | undefined) => boolean;
}

export async function laneToolsFor(route: RoutedLane | undefined, deps: LaneToolDeps): Promise<AgentTool[] | undefined> {
  if (route === undefined || route.lane === 'feature') return undefined;
  const target = deps.contextTarget;
  if (target === undefined) return [];
  switch (route.lane) {
    case 'data': {
      const { buildDataTools } = await import('./dataTools.js');
      return [
        ...buildDataTools({
          appId: target,
          getDb: () => Promise.resolve(deps.db),
          allowWrites: route.intent === 'data_write',
          onProposal: deps.onDataProposal,
        }),
        deps.presentCardTool,
      ];
    }
    case 'provider': {
      const { buildProviderTools } = await import('./providerTools.js');
      return [
        ...buildProviderTools({
          appId: target,
          getDb: () => Promise.resolve(deps.db),
          allowWrites: route.intent === 'provider_write',
          signal: deps.signal,
          onFailureCode: (code) => deps.onProviderFailureCode(target, code),
        }),
        deps.presentCardTool,
      ];
    }
    case 'schedule': {
      if (!allows('schedule')) return [];
      const { buildScheduleProposeTool } = await import('./scheduleProposeTool.js');
      return [
        buildScheduleProposeTool({
          getDb: () => Promise.resolve(deps.db),
          resolveAppId: () => Promise.resolve(target),
          onProposal: deps.onScheduleProposal,
        }),
      ];
    }
    case 'answer':
      return [deps.presentCardTool];
    default: {
      const never: never = route;
      return never;
    }
  }
}
