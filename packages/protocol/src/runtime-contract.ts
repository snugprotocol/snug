/**
 * TASK-20260811-lean-runtime-data-chat — `runtimeContractSchema`, the compact artifact a
 * runtime app turn is assembled FROM (ADR-0018). INTERNAL protocol surface.
 *
 * WHY THIS EXISTS. An installed app's LLM turn (a Chess move) is already one
 * self-contained envelope — no conversation is replayed. What it DOES carry is the
 * app-BUILDER system assembly (`buildHostSystemPrompt({appBuilder: true})` at both call
 * sites): ~3 KB net of authoring instructions a runtime move cannot act on, uncached by
 * design (ADR-0012). The contract replaces that with the ~10 lines a move actually needs:
 * what the app is, which settings shape the answer, what state arrives each turn, and the
 * minimal JSON expected back.
 *
 * HOST-ASSIGNED, NEVER APP-CLAIMED. The contract is read from `snug_app_versions` by the
 * host and rendered into the SYSTEM slot. An app frame cannot supply one (the envelope has
 * no such seat and its schemas strip unknown keys), and an IMPORTED contract is dropped
 * unless byte-identical to a locally known row (`canonicalRuntimeContract`, AC-F1-7) — a
 * foreign contract must never speak with system authority. Same trust shape as
 * `dbNamespace`/`netAppId`.
 *
 * BOUNDS AT PARSE. Every seat is capped here, and the whole serialized artifact is capped
 * again, because this schema is the ONLY gate on three channels: the authoring tool, a
 * starter manifest, and the subscription-mode `/invoke` body — the last of which is
 * client-controlled (fold F-M3). A bound not enforced here is not enforced.
 *
 * STRICT, deliberately — unlike the tolerant app-frame parsers. Frame tolerance buys
 * forward compatibility on a wire whose unknown fields are DATA; an unknown key here
 * would be unreviewed text entering the system slot.
 *
 * PUBLICATION LINE: like `auth-schema.ts`, `render-directive.ts` and the net frames,
 * deliberately NOT in `json-schemas.ts` SOURCES — this stays internal-draft until a spec
 * push is authorized (AL-12 held). The shape is locked by in-package tests instead.
 */

import { z } from 'zod';

// ------------------------------------------------------------------ constants

/** App overview — what the app is and what the model's role in it is. The one required seat. */
export const RUNTIME_CONTRACT_OVERVIEW_MAX_CHARS = 600;

/** Optional persona/voice note. Prose that shapes tone, not instructions that grant power. */
export const RUNTIME_CONTRACT_PERSONA_MAX_CHARS = 400;

/** What the app sends each turn ("current board + last move, never history"). */
export const RUNTIME_CONTRACT_STATE_GUIDANCE_MAX_CHARS = 500;

/** The minimal JSON response shape expected back. */
export const RUNTIME_CONTRACT_RESPONSE_GUIDANCE_MAX_CHARS = 500;

/** Max app-settings entries relevant to LLM turns (difficulty, clock, …). */
export const RUNTIME_CONTRACT_MAX_SETTINGS = 16;

/**
 * Setting-key charset. A key is a LABEL rendered into the system slot beside its value —
 * `[a-z0-9_]` by construction so a key can never carry sentence-shaped instruction text
 * ("ignore all previous instructions": rejected on the space alone).
 */
export const RUNTIME_CONTRACT_SETTING_KEY_RULE = /^[a-z0-9_]{1,40}$/;

/** Max chars per setting VALUE — a scalar, not an essay. */
export const RUNTIME_CONTRACT_SETTING_VALUE_MAX_CHARS = 120;

/**
 * Per-turn output ceiling window (D4). Floor 256: below that a legitimate structured reply
 * truncates mid-JSON, which fails the app's parse for a reason the user cannot act on.
 * Ceiling 8192: matches local mode's own cap, so a contract can never ask for more than
 * the smallest brain can give.
 */
export const RUNTIME_MAX_OUTPUT_TOKENS_FLOOR = 256;
export const RUNTIME_MAX_OUTPUT_TOKENS_CEILING = 8192;

/**
 * Whole-artifact cap on the serialized contract. The per-seat caps sum to more than this
 * on purpose: a contract may spend its budget on ANY seat, but the total is what actually
 * rides the system slot every single turn, so the total is what the token budget needs
 * bounded. 2.5 KB is roughly a third of the builder assembly this replaces.
 */
export const RUNTIME_CONTRACT_MAX_BYTES = 2560;

// ------------------------------------------------------------- building blocks

/**
 * Scalar setting values only. A nested object or array here would be an unbounded
 * structure rendered into the system slot — and `settings` is a SLICE of app settings for
 * the model's benefit, never a serialization channel.
 */
const settingValueSchema = z.union([
  z.string().max(RUNTIME_CONTRACT_SETTING_VALUE_MAX_CHARS),
  z.number(),
  z.boolean(),
]);

const settingsSchema = z
  .record(z.string().regex(RUNTIME_CONTRACT_SETTING_KEY_RULE), settingValueSchema)
  .refine(
    (settings) => Object.keys(settings).length <= RUNTIME_CONTRACT_MAX_SETTINGS,
    `settings accepts at most ${RUNTIME_CONTRACT_MAX_SETTINGS} entries`,
  );

// --------------------------------------------------------------- the contract

const runtimeContractShape = {
  /** What the app is and what the model is doing inside it. */
  overview: z.string().min(1).max(RUNTIME_CONTRACT_OVERVIEW_MAX_CHARS),
  /** Optional voice/persona note. */
  personaNote: z.string().min(1).max(RUNTIME_CONTRACT_PERSONA_MAX_CHARS).optional(),
  /** What the app sends per turn — the anti-duplication seat (state, not history). */
  stateGuidance: z.string().min(1).max(RUNTIME_CONTRACT_STATE_GUIDANCE_MAX_CHARS).optional(),
  /** The minimal JSON shape expected back. */
  responseGuidance: z.string().min(1).max(RUNTIME_CONTRACT_RESPONSE_GUIDANCE_MAX_CHARS).optional(),
  /** The app-settings slice that shapes LLM answers. */
  settings: settingsSchema.optional(),
  /**
   * Per-turn output bound (D4). OPT-IN: absent means "today's behavior exactly", which is
   * what keeps contract-less legacy apps byte-identical (AC-F1-4) and stops a story-teller
   * app being silently truncated.
   */
  maxOutputTokens: z
    .int()
    .min(RUNTIME_MAX_OUTPUT_TOKENS_FLOOR)
    .max(RUNTIME_MAX_OUTPUT_TOKENS_CEILING)
    .optional(),
} as const;

export const runtimeContractSchema = z
  .strictObject(runtimeContractShape)
  .refine(
    (contract) => JSON.stringify(contract).length <= RUNTIME_CONTRACT_MAX_BYTES,
    `the serialized runtime contract must be at most ${RUNTIME_CONTRACT_MAX_BYTES} bytes`,
  );

export type RuntimeContract = z.infer<typeof runtimeContractSchema>;

// ------------------------------------------------------------------ read path

/**
 * The TOLERANT read path for persisted/stored contract text.
 *
 * Returns `undefined` rather than throwing on anything unusable, because the caller is a
 * runtime turn: an app whose contract row is malformed must run on the lean generic layers
 * (AC-F1-4), not fail its move. The strict schema still decides what "usable" means — this
 * only chooses the failure MODE.
 */
export function parseRuntimeContract(raw: string | null | undefined): RuntimeContract | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = runtimeContractSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

// ------------------------------------------------------------ canonical identity

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortKeysDeep(entry)]));
  }
  return value;
}

/**
 * Canonical bytes for a contract — key-sorted, whitespace-free JSON.
 *
 * Load-bearing for the IMPORT GUARD (D2(iii)/AC-F1-7): an imported version row keeps its
 * contract only when these bytes match a locally known row's. Key order is not stable
 * across the channels that produce contracts (an LLM re-emits the same contract with keys
 * shuffled), so comparing raw stored text would drop contracts that are in fact identical
 * — and dropping a legitimate contract is a silent quality regression, not a safe default.
 *
 * A canonical STRING, not a digest, for the same reason as `canonicalRequirementHash`:
 * the comparison is exact, needs no async crypto, and has no collision surface.
 */
export function canonicalRuntimeContract(contract: RuntimeContract): string {
  return JSON.stringify(sortKeysDeep(contract));
}
