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
 * The six lanes. PERSISTED/ROUTED literals — the router, the tool-set selection, the
 * context assembler and the classifier prompt all read them from here, never retyped.
 *
 * `schema_change` is classified separately from `app_change` even though v1 collapses the
 * two EXECUTION-wise (owner decision (c)): the copy a user sees differs ("I'll add a
 * column…" vs "I'll change the app…"), and separating them now means the day they need
 * different execution the discriminator already exists in the data.
 */
export const CHAT_INTENTS = [
  'data_read',
  'data_write',
  'schema_change',
  'app_change',
  'app_question',
  'other',
] as const;

export type ChatIntent = (typeof CHAT_INTENTS)[number];

/** Max chars for the classifier's clarifying question — one question, not a paragraph. */
export const CHAT_INTENT_CLARIFICATION_MAX_CHARS = 300;

/** The DATA lane: reads run free on a scratch copy; writes end at a human approval gate. */
export const CHAT_INTENT_DATA_LANE = ['data_read', 'data_write'] as const;

/** The FEATURE lane: code/schema edits, landing with today's builder trust + versioning. */
export const CHAT_INTENT_FEATURE_LANE = ['schema_change', 'app_change'] as const;

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

const DATA_LANE: ReadonlySet<string> = new Set(CHAT_INTENT_DATA_LANE);
const FEATURE_LANE: ReadonlySet<string> = new Set(CHAT_INTENT_FEATURE_LANE);

/** Data lane — gets DDL + samples and the data tools, never the app's code. */
export function isDataIntent(intent: ChatIntent): boolean {
  return DATA_LANE.has(intent);
}

/** Feature lane — gets code + docs and the authoring tools. */
export function isFeatureIntent(intent: ChatIntent): boolean {
  return FEATURE_LANE.has(intent);
}
