// The kit's `agent/chatRouter.ts` (TASK-20261010-host-broker PR-2, the kit-ceiling cut): the
// playground's classification-first router for an app-attached chat, and behind it the
// classifier prompt, the protocol's intent schema and the lane map. Every kit binding pins the
// HOST brain (composed `tools: false`) or the DEMO brain, and the REAL `classifierApplies`
// already skips the classifier under the host brain — so no kit turn is ever routed, and the
// router's bytes were dead in the page. This stub keeps the names and the two constants
// (`useBuilderChat.ts` reads them), answers "no classifier" for EVERY brain, and names the fact
// if a route is ever asked for. The types mirror the real module's for the stub's own
// compilation only: the swap is the bundler's, not the compiler's, so tsc still checks the
// playground's importers against the real module.

import type { AgentAdapter, AgentTurnEvent } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import type { ChatIntent } from '@snugprotocol/protocol';

import { noDataLane } from './noDataLane.js';

/** The real router's threshold, kept so the constant an importer reads is the real one. */
export const MIN_ROUTING_CONFIDENCE = 0.4;

export type ChatRoute =
  | { lane: 'data'; intent: ChatIntent }
  | { lane: 'feature'; intent: ChatIntent }
  | { lane: 'provider'; intent: ChatIntent }
  | { lane: 'schedule'; intent: ChatIntent }
  | { lane: 'answer'; intent: ChatIntent }
  | { lane: 'clarify'; question: string; intent?: ChatIntent };

/** A route that runs a turn — everything but the router's own `clarify` posture. */
export type RoutedLane = Exclude<ChatRoute, { lane: 'clarify' }>;

/** The real router's clarifying reply, kept verbatim. */
export const DEFAULT_CLARIFY_QUESTION =
  'I can work with this app’s data (answer questions about it, or add and correct entries) or change the app itself. Which would you like?';

export interface RouteChatMessageInput {
  db: UserDb;
  appId: string;
  message: string;
  threadId: string;
  adapter: AgentAdapter;
  signal?: AbortSignal;
  onLlmEvent?: (event: AgentTurnEvent) => void;
}

/** The kit never classifies: its brain is pinned host-or-demo, tool-free, whatever the seat names. */
export function classifierApplies(_input: {
  brain: 'settings' | 'webllm' | 'demo' | 'host';
  contextTarget: string | undefined;
  serverTurn: boolean;
}): boolean {
  return false;
}

export function routeChatMessage(_input: RouteChatMessageInput): Promise<ChatRoute> {
  return Promise.reject(noDataLane('chatRouter.routeChatMessage'));
}
