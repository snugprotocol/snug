// agent/laneTools.ts — the lane-scoped tool selection (ADR-0019 D9; TASK-20261009 P2; split out
// of `useBuilderChat.ts` at Gate-5 PR-B M4; TASK-20261010-host-broker PR-2 D-PR2-10/11). The
// second lock on what a routed turn may reach, as ONE EXHAUSTIVE SWITCH over the lane
// (feasibility F2):
//
//  - `undefined` means "the builder's own set" and is answered ONLY by the feature lane and by
//    an unrouted turn. The else-chain this replaced let any lane it did not name fall through
//    to the full builder set — `artifact_write` in hand — which is the exact failure the lane
//    design exists to prevent. A new lane fails to compile until this switch names its tools.
//  - A ROUTED non-feature lane with NO context target (a thread with no app pinned yet) runs
//    TOOL-FREE (`[]`) — the model answers in words — never the builder set (Gate-5 PR-B S10).
//  - data: the two data tools (`data_read` drops the write tool — a question is not permission
//    to propose a change) over the turn's `shared` seat when the chat door opened, + the choice
//    card + `access_propose` under the offer rule.
//  - feature: the builder set (its trust story is versioning, not cards).
//  - provider: the governed request tool (read-only unless `provider_write`) + the choice card.
//  - schedule: ONLY `schedule_propose` — no card, no data tool, nothing that writes; where the
//    host does not schedule at all the turn runs tool-free and the model answers in words.
//  - answer: the choice card + `access_propose` under the offer rule.
//
// THE OFFER RULE (D-PR2-11; B-Q7) is lane-based, not brain-based: `access_propose` rides the
// data and answer lanes for an OWNED app (a starter preview's chat may not ask what its frame
// may not) when the Settings switch *never let apps ask* is off and the user has not muted this
// app's asks — whatever the brain; only the MATERIALISATION (the hook's) needs the chat door.
// The tool answers the per-ask rungs (a decline, an ask pending, a second this turn) at the call.
//
// Every lane's tools are imported LAZILY, so the chat path loads a tool set only when a turn
// is routed to it.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import type { ScheduleProposal } from '@snugprotocol/protocol';

import { allows } from '../platform/platform.js';
import type { AccessProposal } from './accessProposeTool.js';
import type { RoutedLane } from './chatRouter.js';
import type { PendingWriteProposal, SharedTablesSeat } from './dataTools.js';

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
  /** One access ask per turn; `false` ⇒ not staged (TASK-20261010-host-broker PR-2, D-PR2-11). */
  onAccessProposal: (proposal: AccessProposal, appId: string) => boolean;
  /** The chat door's tables for this DATA turn (D-PR2-10) — absent when the door did not open. */
  shared?: SharedTablesSeat;
}

/** `access_propose` for `target` under the offer rule (the header), or nothing. */
async function accessProposeToolFor(deps: LaneToolDeps, target: string): Promise<AgentTool[]> {
  const [{ appMayUseAccess }, { accessAsksOff }] = await Promise.all([import('../run/appCapabilityRules.js'), import('../access/consent.js')]);
  if (!appMayUseAccess(target) || accessAsksOff() || deps.db.isAccessMuted(target)) return [];
  const { buildAccessProposeTool } = await import('./accessProposeTool.js');
  return [
    buildAccessProposeTool({
      getDb: () => Promise.resolve(deps.db),
      resolveAppId: () => Promise.resolve(target),
      onProposal: deps.onAccessProposal,
    }),
  ];
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
          ...(deps.shared !== undefined ? { shared: deps.shared } : {}),
        }),
        deps.presentCardTool,
        ...(await accessProposeToolFor(deps, target)),
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
      return [deps.presentCardTool, ...(await accessProposeToolFor(deps, target))];
    default: {
      const never: never = route;
      return never;
    }
  }
}
