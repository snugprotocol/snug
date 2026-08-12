/**
 * authChoiceCard — seed derivation + meta rehydration for the auth-option choice card
 * (TASK-20260812-auth-kind-choice, AC3/AC7/AC8).
 *
 * TWO SOURCES, ONE SEED SHAPE, DIFFERENT TRUST RULES (D4):
 *  - REGISTRY providers: the seed is a POINTER (appId/slot/providerName). Options are
 *    resolved from the pinned registry AT RENDER — the doorbell rule, so nothing a
 *    message carries can influence what the user is offered. Any `alternatives` on the
 *    payload are deliberately ignored for a provider the registry knows.
 *  - UNREGISTERED providers: options are the turn's validated inference alternatives.
 *    They persist on message meta and are RE-ADMITTED on every read — meta written
 *    yesterday cannot smuggle a shape past today's guards; failures drop silently.
 */
import { connectionRequirementSchema, type ConnectionRequirement } from '@snugprotocol/protocol';
import { admitConnectionRequirement, lookupWellKnownProvider } from '@snugprotocol/auth';

export interface AuthChoiceSeed {
  appId: string;
  slot: string;
  providerName: string;
  /** Present ONLY for unregistered providers — validated inference alternatives. */
  alternatives?: ConnectionRequirement[];
}

/**
 * Derive the choice-card seed for a row the post-turn pipeline just persisted, or
 * undefined when there is nothing to choose (the common case — one way in).
 */
export function authChoiceForPersistedRow(input: {
  appId: string;
  requirement: ConnectionRequirement;
  /** The inference turn's validated alternatives, when the inferrer produced any. */
  alternatives?: ConnectionRequirement[];
}): AuthChoiceSeed | undefined {
  const providerName = input.requirement.provider.name;
  const entry = lookupWellKnownProvider(providerName);
  if (entry !== undefined) {
    // Registry authority: options exist iff the ENTRY says so, and the seed carries
    // none of them — the card reads the registry itself at render (AC8).
    if ((entry.authOptions ?? []).length === 0) return undefined;
    return { appId: input.appId, slot: input.requirement.slot, providerName };
  }
  const alternatives = input.alternatives ?? [];
  if (alternatives.length === 0) return undefined;
  return { appId: input.appId, slot: input.requirement.slot, providerName, alternatives };
}

/**
 * Rehydrate a persisted seed — VALIDATE-ON-READ (AC7, the R-M5 rule). A malformed seat
 * yields no card; a malformed or no-longer-admissible alternative yields fewer options.
 * Never a crash, never trust in old bytes.
 */
export function metaToAuthChoice(meta: unknown): AuthChoiceSeed | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const seed = (meta as { authChoice?: unknown }).authChoice;
  if (typeof seed !== 'object' || seed === null) return undefined;
  const { appId, slot, providerName, alternatives } = seed as Record<string, unknown>;
  if (typeof appId !== 'string' || typeof slot !== 'string' || typeof providerName !== 'string') return undefined;

  const revalidated: ConnectionRequirement[] = [];
  if (Array.isArray(alternatives)) {
    for (const raw of alternatives) {
      const parsed = connectionRequirementSchema.safeParse(raw);
      if (!parsed.success) continue;
      // Re-admitted on the channel the alternatives CAME from. A shape refused today
      // is refused, whenever it was written.
      const admitted = admitConnectionRequirement<ConnectionRequirement>(parsed.data, { channel: 'inference' });
      if (!admitted.ok) continue;
      const reparsed = connectionRequirementSchema.safeParse(admitted.requirement);
      if (reparsed.success) revalidated.push(reparsed.data);
    }
  }
  return {
    appId,
    slot,
    providerName,
    ...(revalidated.length > 0 ? { alternatives: revalidated } : {}),
  };
}
