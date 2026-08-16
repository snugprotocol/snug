/**
 * chatRouter — classification-first routing for an app-attached chat (ADR-0019 D6).
 *
 * WHAT CHANGES. Today every message beside an installed app becomes a rebuild-shaped
 * builder turn. Now the message is classified first, and the intent chooses BOTH the
 * context assembled and the tools offered — two locks on the same door, because a turn
 * that holds the app's code and an artifact tool can rewrite the app whatever the user
 * actually asked for.
 *
 * FAIL-CLOSED IS THE DESIGN (AC-F2-1). Every failure — an adapter error, an unparseable
 * reply, a low-confidence guess, a thrown exception — resolves to `clarify`. There is no
 * default lane, because the lane a wrong default would pick is the one that writes code.
 *
 * KEPT PURE ON PURPOSE. `routeChatMessage` takes a db and an adapter and returns a
 * decision; it does not touch React state, persist anything, or run the routed turn. That
 * is what lets the lifecycle obligations (abort, placeholder settlement, persistence) be
 * tested at the hook and the routing rules be tested here, rather than tangling both.
 */

import { runAgentTurn, type AgentAdapter, type AgentTurnEvent } from '@snugprotocol/adapters';
import type { UserDb } from '@snugprotocol/db';
import { buildChatIntentClassifierPrompt } from '@snugprotocol/knowledge';
import { laneForIntent, parseChatIntent, type ChatIntent } from '@snugprotocol/protocol';

import { tableSummaries } from './intentContext.js';
import { connectionSummaries } from './providerContext.js';

/**
 * Below this, a well-formed classification still clarifies.
 *
 * The schema decides whether the SHAPE is usable; this decides whether the model was
 * confident enough to act on. Two gates rather than one, because "valid JSON" and "knows
 * what the user meant" are different claims.
 */
export const MIN_ROUTING_CONFIDENCE = 0.4;

/** How many prior exchanges the classifier sees — enough for "and last month?" to resolve. */
const RECENT_TURNS = 2;

export type ChatRoute =
  | { lane: 'data'; intent: ChatIntent }
  | { lane: 'feature'; intent: ChatIntent }
  | { lane: 'provider'; intent: ChatIntent }
  | { lane: 'answer'; intent: ChatIntent }
  | { lane: 'clarify'; question: string; intent?: ChatIntent };

/** The clarifying reply used whenever classification fails outright. */
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

/**
 * Classify one app-chat message and decide its lane.
 *
 * Never throws: an exception anywhere in classification is a `clarify`, so a routing bug
 * can never escalate into the outer turn-failure path (fold F-M4c).
 */
export async function routeChatMessage(input: RouteChatMessageInput): Promise<ChatRoute> {
  try {
    const { db, appId, message, threadId, adapter, signal, onLlmEvent } = input;
    const app = db.getApp(appId);
    const docs = db.listAppDocs(appId);
    const recent = db
      .listChatMessages(threadId)
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .slice(-RECENT_TURNS)
      .map((entry) => ({ role: entry.role === 'user' ? ('user' as const) : ('assistant' as const), content: entry.content }));

    const { system, user } = buildChatIntentClassifierPrompt({
      message,
      ...(app !== undefined ? { appName: app.displayName } : {}),
      tableSummaries: tableSummaries(db, appId),
      docTitles: docs.map((doc) => doc.title ?? doc.slug),
      // Approved connections, identity only (TASK-20260815): the classifier cannot tell
      // provider data from local-table data without knowing a connection exists.
      connectionSummaries: connectionSummaries(db, appId),
      recentTurns: recent,
    });

    const result = await runAgentTurn({
      adapter,
      system,
      messages: [{ role: 'user', content: user }],
      // Tool-free by construction: the classifier decides a lane and nothing else.
      // A one-shot below any cacheable minimum, so no `cache` (ADR-0012).
      ...(signal !== undefined ? { signal } : {}),
      ...(onLlmEvent !== undefined ? { onEvent: onLlmEvent } : {}),
    });
    if (!result.ok) return { lane: 'clarify', question: DEFAULT_CLARIFY_QUESTION };

    const classification = parseChatIntent(extractJson(result.text));
    if (classification === undefined) return { lane: 'clarify', question: DEFAULT_CLARIFY_QUESTION };

    // An explicit clarification from a confident classifier is still a clarification:
    // the model saw a genuine ambiguity and asking is the correct outcome.
    if (classification.clarification !== undefined) {
      return { lane: 'clarify', question: classification.clarification, intent: classification.intent };
    }
    if (classification.confidence < MIN_ROUTING_CONFIDENCE) {
      return { lane: 'clarify', question: DEFAULT_CLARIFY_QUESTION, intent: classification.intent };
    }

    // ONE exhaustive map decides the lane (plan-review F7): the predicate chain this
    // replaces fell through to `answer` for any intent it forgot — a silent default in a
    // design whose doctrine is "there is no default lane". An intent without a map entry
    // is now a compile error in the protocol package, not a misroute here. The switch is
    // exhaustive over ChatLane — a NEW lane fails to compile until this dispatch names it.
    const lane = laneForIntent(classification.intent);
    switch (lane) {
      case 'data':
        return { lane, intent: classification.intent };
      case 'feature':
        return { lane, intent: classification.intent };
      case 'provider':
        return { lane, intent: classification.intent };
      case 'answer':
        return { lane, intent: classification.intent };
    }
  } catch {
    return { lane: 'clarify', question: DEFAULT_CLARIFY_QUESTION };
  }
}

/** Models wrap JSON in prose or fences; the schema still decides whether it is usable. */
function extractJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start === -1 || end <= start ? text : text.slice(start, end + 1);
}
