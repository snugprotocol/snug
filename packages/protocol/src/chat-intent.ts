/**
 * TASK-20260811-lean-runtime-data-chat — `chatIntentSchema`, the app-chat router's input
 * (ADR-0019). INTERNAL protocol surface.
 *
 * WHY THIS EXISTS. Today every message in the chat rail beside an installed app is an
 * unconditional REBUILD-shaped turn: the app's whole HTML plus every doc, with
 * `artifact_write` in hand. A user asking "what did I spend on food last month?" gets an
 * agent primed to rewrite their app. Classification comes first now, and the intent picks
 * both the context that gets assembled and the tools the turn may reach.
 *
 * FAIL-CLOSED IS THE WHOLE DESIGN (AC-F2-1). `parseChatIntent` returns `undefined` for
 * every unusable reply and the router then CLARIFIES. There is deliberately no default
 * lane and no "best guess" fallback: the feature lane writes code on model authority
 * (owner decision (e)), so a malformed classification silently landing there would
 * reproduce the very bug this replaces, with extra steps.
 *
 * Internal draft — OUT of `json-schemas.ts` SOURCES (AL-12 held).
 */

import { z } from 'zod';

// ------------------------------------------------------------------ constants

/**
 * The eight intents. PERSISTED/ROUTED literals — the router, the tool-set selection, the
 * context assembler and the classifier prompt all read them from here, never retyped.
 *
 * `schema_change` is classified separately from `app_change` even though v1 collapses the
 * two EXECUTION-wise (owner decision (c)): the copy a user sees differs ("I'll add a
 * column…" vs "I'll change the app…"), and separating them now means the day they need
 * different execution the discriminator already exists in the data.
 *
 * `provider_read`/`provider_write` (TASK-20260815, ADR-0031 §2) are the connected-API
 * twins of the data pair: the subject is data living at the app's connected PROVIDER, not
 * in the app's own tables, and the executing seam is the connected-fetch executor rather
 * than the scratch database.
 */
export const CHAT_INTENTS = [
  'data_read',
  'data_write',
  'schema_change',
  'app_change',
  'provider_read',
  'provider_write',
  'app_question',
  'other',
] as const;

export type ChatIntent = (typeof CHAT_INTENTS)[number];

/** Max chars for the classifier's clarifying question — one question, not a paragraph. */
export const CHAT_INTENT_CLARIFICATION_MAX_CHARS = 300;

/**
 * The four execution lanes an intent can route to. `clarify` is deliberately NOT here:
 * it is the router's failure posture, never an intent's assignment.
 */
export const CHAT_LANES = ['data', 'feature', 'provider', 'answer'] as const;

export type ChatLane = (typeof CHAT_LANES)[number];

/**
 * THE lane assignment — one exhaustive map, compile-checked (F7, TASK-20260815 plan
 * review). The predicate else-chain this replaces routed any intent the chain forgot to
 * the answer lane by fall-through: a silent default in a design whose whole doctrine is
 * "there is no default lane". `satisfies Record<ChatIntent, ChatLane>` makes an intent
 * without a lane a compile error in the same edit that adds the intent.
 */
export const LANE_FOR_INTENT = {
  data_read: 'data',
  data_write: 'data',
  schema_change: 'feature',
  app_change: 'feature',
  provider_read: 'provider',
  provider_write: 'provider',
  app_question: 'answer',
  other: 'answer',
} as const satisfies Record<ChatIntent, ChatLane>;

export function laneForIntent(intent: ChatIntent): ChatLane {
  return LANE_FOR_INTENT[intent];
}

const intentsInLane = (lane: ChatLane): readonly ChatIntent[] =>
  CHAT_INTENTS.filter((intent) => LANE_FOR_INTENT[intent] === lane);

/** The DATA lane: reads run free on a scratch copy; writes end at a human approval gate. */
export const CHAT_INTENT_DATA_LANE = intentsInLane('data');

/** The FEATURE lane: code/schema edits, landing with today's builder trust + versioning. */
export const CHAT_INTENT_FEATURE_LANE = intentsInLane('feature');

/** The PROVIDER lane: LLM-composed requests through the governed connected-fetch executor. */
export const CHAT_INTENT_PROVIDER_LANE = intentsInLane('provider');

// -------------------------------------------------------------------- schema

export const chatIntentSchema = z.strictObject({
  intent: z.enum(CHAT_INTENTS),
  /**
   * The model's own confidence. The router uses it as a SECOND gate below the schema: a
   * well-formed but low-confidence classification clarifies rather than routes, so the
   * expensive lanes need both a valid shape and conviction.
   */
  confidence: z.number().min(0).max(1),
  /** Optional question to put to the user when the ask is ambiguous. */
  clarification: z.string().min(1).max(CHAT_INTENT_CLARIFICATION_MAX_CHARS).optional(),
});

export type ChatIntentClassification = z.infer<typeof chatIntentSchema>;

// ------------------------------------------------------------------ read path

/**
 * Parse a classifier reply. Returns `undefined` for EVERY unusable shape — no default
 * lane, no partial acceptance (see the fail-closed note above).
 */
export function parseChatIntent(raw: string | null | undefined): ChatIntentClassification | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = chatIntentSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

// ---------------------------------------------------------------- predicates
// Derived VIEWS of `LANE_FOR_INTENT` — kept because call sites read better as a
// question than a comparison; they can never disagree with the map they read.

/** Data lane — gets DDL + samples and the data tools, never the app's code. */
export function isDataIntent(intent: ChatIntent): boolean {
  return LANE_FOR_INTENT[intent] === 'data';
}

/** Feature lane — gets code + docs and the authoring tools. */
export function isFeatureIntent(intent: ChatIntent): boolean {
  return LANE_FOR_INTENT[intent] === 'feature';
}

/** Provider lane — gets connection facts and the provider_request tool, never credentials. */
export function isProviderIntent(intent: ChatIntent): boolean {
  return LANE_FOR_INTENT[intent] === 'provider';
}
