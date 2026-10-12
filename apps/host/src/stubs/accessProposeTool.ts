// The kit's `agent/accessProposeTool.ts` (TASK-20261010-host-broker PR-2, the kit-ceiling cut):
// the brain's ASK to read another app's data — the tool, the protocol's purpose and hints
// schemas, the ask ladder and the consent store behind it. It rides the chat's data and answer
// lanes, never routed in the kit (`./chatRouter.ts`), and the builder's BYOK set, which the
// kit's tool-free host-or-demo brain never builds (`agent/builder.ts` `toolFree`;
// `kitDeadLanes.test.ts` pins every kit host brain `tools: false`). The tool's name stays the
// real one; building the tool names the fact.

import type { AgentTool } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import type { AccessHints } from '@snugprotocol/protocol';

import { noDataLane } from './noDataLane.js';

export const ACCESS_PROPOSE_TOOL_NAME = 'access_propose';

/** What the brain asked for: its purpose, in the user's words, and the hints the host ranks apps by. */
export interface AccessProposal {
  purpose: string;
  hints?: AccessHints;
  /** PR-5 (D-PR5-15): an ask to change rows too — mirrored, never staged here. */
  access?: 'write';
}

export type OnAccessProposal = (proposal: AccessProposal, appId: string) => boolean | void;

export interface BuildAccessProposeToolOptions {
  getDb: () => Promise<UserDb>;
  resolveAppId: () => Promise<string | undefined>;
  onProposal?: OnAccessProposal;
}

export function buildAccessProposeTool(_options: BuildAccessProposeToolOptions): AgentTool {
  throw noDataLane('accessProposeTool.buildAccessProposeTool');
}
