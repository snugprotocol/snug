/**
 * Render-directive contract — INTERNAL protocol surface (AL-04, plan D1).
 *
 * The `{kind:'auth_wizard'}` directive is the builder LLM's DOORBELL for the auth
 * wizard: it summons the card in chat and carries structured HINTS only. It is never
 * an authority (plan B2) — the host re-runs the provider ladder at wizard open,
 * discards directive hints on a registry hit, and computes provenance/confidence
 * itself; the `confidence`/`provenance` fields here are display-only and are never
 * read by gating code.
 *
 * PERSISTENCE LINE (M1): this directive schema IS the persisted shape (chat message
 * `meta`). It carries NO `evidence[]` and no docs-derived free text — untrusted
 * provider docs can contain a real credential (risk R5), so everything docs-derived
 * lives in the inferrer OUTPUT shape (`inferrerProposalSchema`), which is
 * wizard-ephemeral (wizardStore only, never written to any table).
 *
 * PROPOSAL LINE (M5), HISTORICAL as of TASK-20260810 P4: `llmProposalSchema` is no longer
 * exported — the v4 authoring channel is `connectionRequirementSchema`, which re-admits
 * the omitted seats and pays for them with bounds, a template lint, a registry-borrow ban
 * and a field-by-field review (ADR-0017). The omit-list survives here as the PRIVATE
 * `legacyProposalSchema` because two persisted shapes still embed it. The original
 * reasoning, which still explains what those shapes contain: every LLM-authored shape was =
 * hints MINUS registration copy (`registrationConsoleUrl`/`registrationInstructions`
 * — surfaced verbatim by the wizard, so phishing copy would render with wizard-grade
 * legitimacy) MINUS `headerTemplate` (controls where the secret is injected) MINUS
 * `fields`/`userLayerFields` (the credentials step renders field labels verbatim, so
 * an LLM-authored label could dictate WHICH secret the user pastes — credential
 * misdirection with wizard-grade legitimacy; fix-first 2 of the AL-04 review).
 * Registration, header placement, and credential field definitions come from the
 * registry, per-kind transformer defaults, or explicit user entry ONLY.
 *
 * PUBLICATION LINE: out of `json-schemas.ts` SOURCES (same precedent as AL-02/AL-03);
 * shape locked by in-package snapshot tests; prose staged by AL-12.
 *
 * DYNAMIC AUTH v2 (TASK-20260810 P0): the `connection_requirement` directive lands
 * ALONGSIDE `auth_wizard` (cutover rule, fold B1) and carries the full, bounded
 * `connectionRequirement` instead of the omit-list proposal. The orphaned
 * `authRequiredPayloadSchema` was DELETED in the same phase — it had zero non-test
 * consumers, and the display fields an app-side connect CTA needs now come from the
 * persisted `snug_connections` row, which is the requirement's only durable home.
 */

import { z } from 'zod';
import { authSpecHintsSchema } from './auth-schema.js';
import {
  CONNECTION_PROVENANCES,
  connectionRequirementSchema,
} from './connection-requirement.js';
import { PROTOCOL_VERSION } from './constants.js';

// ------------------------------------------------------------------ constants

/**
 * HOST-computed provenance of a wizard proposal (plan AC3/B2): which ladder rung the
 * HOST resolved the proposal from at wizard open. `'registry'` keeps the light
 * prefilled-review path; `'inference'` and `'user_docs'` ALWAYS force the
 * field-by-field `spec_confirm` review. Never taken from a directive's claim.
 */
export const AUTH_PROVENANCES = ['registry', 'inference', 'user_docs'] as const;

export type AuthProvenance = (typeof AUTH_PROVENANCES)[number];

/** Bounded `evidence[]` — max quotes per inferrer reply (wizard-ephemeral, M1). */
export const AUTH_EVIDENCE_MAX_ITEMS = 8;

/** Bounded `evidence[]` — max chars per quote. */
export const AUTH_EVIDENCE_MAX_CHARS = 300;

// ------------------------------------------------------------ proposal shapes

/**
 * THE LEGACY v3 PROPOSAL SHAPE, no longer exported.
 *
 * `llmProposalSchema` and its `LlmProposal` type were DELETED from the public surface by
 * TASK-20260810-p4-starters (the named exit item). Its last two consumers went with it:
 * the starter-manifest resolver (`starterDeclaration.ts`, rewired to
 * `connectionRequirementSchema`) and the v3 `auth-spec-inferrer` (deleted with its
 * adapter entry point). What replaced it is `connectionRequirementSchema` — see the long
 * rationale at the head of `connection-requirement.ts`: the five omissions below WERE the
 * AL-04 answer to credential misdirection, and they were also exactly why a
 * Coinbase-shaped requirement collapsed to one generic field.
 *
 * IT SURVIVES AS A PRIVATE CONSTANT, deliberately, because two shapes still embed it and
 * both are PERSISTED: `authWizardDirectiveSchema` (chat-meta rows, re-validated strictly
 * on every read) and `inferrerProposalSchema` (the wizard-ephemeral inferrer output whose
 * few-shot examples a knowledge-package contract test still feeds through the real
 * parser). Deleting the shape outright would stop historical `auth_wizard` messages from
 * rendering — a silent data loss for a row the user can still see. So the EXPORT is gone,
 * which is what closes the channel to new authors, and the validation behaviour of the
 * persisted shapes is bit-for-bit unchanged.
 */
const legacyProposalSchema = authSpecHintsSchema.omit({
  registrationConsoleUrl: true,
  registrationInstructions: true,
  headerTemplate: true,
  fields: true,
  userLayerFields: true,
});

/**
 * The inferrer's OUTPUT contract (plan D8): proposal + REQUIRED confidence in [0,1]
 * + bounded evidence quotes. Malformed confidence (missing/NaN/out-of-range) is a
 * SCHEMA rejection → typed inferrer error → empty `spec_confirm`, nothing prefilled
 * (M11 — there is no "reads as 0" branch). `evidence[]` quotes untrusted docs and is
 * WIZARD-EPHEMERAL: it travels inside the wizardStore intent and never persists (M1).
 */
export const inferrerProposalSchema = z.strictObject({
  proposal: legacyProposalSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1).max(AUTH_EVIDENCE_MAX_CHARS)).max(AUTH_EVIDENCE_MAX_ITEMS),
});
export type InferrerProposal = z.infer<typeof inferrerProposalSchema>;

// -------------------------------------------------------------- the directive

/**
 * The directive-kind discriminator — a PERSISTED literal (chat meta rows carry it),
 * pinned by test like AUTH_KINDS. Single home (AL-05, M48): the schema, the prompt
 * store's `{{authWizardDirectiveKind}}` placeholder, the playground scanner's
 * malformed-claim check, and the demo seam all read this export.
 */
export const AUTH_WIZARD_DIRECTIVE_KIND = 'auth_wizard' as const;

/**
 * The `auth_wizard` render directive — versioned with the frame discipline (`v`),
 * strict, and identical to the persisted chat-meta shape (M1). `confidence` and
 * `provenance` are OPTIONAL display-only echoes: the host recomputes both at wizard
 * open (B2) and no gating code may read the copies carried here (mutation M16).
 */
export const authWizardDirectiveSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal(AUTH_WIZARD_DIRECTIVE_KIND),
  proposal: legacyProposalSchema,
  /** Display-only. The host recomputes confidence at wizard open (B2). */
  confidence: z.number().min(0).max(1).optional(),
  /** Display-only. Provenance is HOST-computed at wizard open — never this claim (B2). */
  provenance: z.enum(AUTH_PROVENANCES).optional(),
});
export type AuthWizardDirective = z.infer<typeof authWizardDirectiveSchema>;

// ------------------------------------------------ connection_requirement (v2)

/**
 * The Dynamic Auth v2 directive-kind discriminator — a PERSISTED literal, single-homed
 * exactly like `AUTH_WIZARD_DIRECTIVE_KIND` (the prompt store, the playground scanner,
 * and the build-validation seam all read this export rather than retyping it).
 */
export const CONNECTION_REQUIREMENT_DIRECTIVE_KIND = 'connection_requirement' as const;

/**
 * The `connection_requirement` directive: the BUILD-time channel that carries a FULL
 * `connectionRequirement` (TASK-20260810 parent §5, R1). It is the successor to
 * `auth_wizard`, and the reason the two coexist here is the P0 cutover rule (fold B1) —
 * `auth_wizard`/`llmProposalSchema` keep shipping until their last runtime consumer
 * (`apps/playground/src/starter/starterDeclaration.ts:31`) is rewired in P4.
 *
 * WHAT CHANGED AND WHY IT IS SAFE. `auth_wizard` carried `llmProposalSchema`, which
 * OMITS registration copy, `headerTemplate`, and `fields` — the AL-04 answer to
 * credential misdirection, and also the reason a Coinbase-shaped requirement collapsed
 * to one generic field. This directive re-admits those seats and pays for them
 * elsewhere: bounds at parse (connection-requirement.ts), the template lint and
 * registry-borrow ban (packages/auth), and a strong field-by-field review that renders
 * every re-admitted byte verbatim before a credential is collected. The M5 principle
 * survives in a stronger form — an LLM-authored seat is not trusted, it is DISPLAYED.
 *
 * `provenance` here is the AUTHORING CHANNEL claim and, like `auth_wizard`'s, is
 * DISPLAY-ONLY: the host computes provenance from the channel it actually received the
 * directive on, and no gating code reads this copy. `confidence` is likewise display-only
 * (it drives the review's lower-confidence band, never an approval decision).
 */
export const connectionRequirementDirectiveSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal(CONNECTION_REQUIREMENT_DIRECTIVE_KIND),
  requirement: connectionRequirementSchema,
  /** Display-only. The host recomputes confidence from the ladder rung it resolved. */
  confidence: z.number().min(0).max(1).optional(),
  /** Display-only. The host computes provenance from the RECEIVING channel, not this claim. */
  provenance: z.enum(CONNECTION_PROVENANCES).optional(),
});
export type ConnectionRequirementDirective = z.infer<typeof connectionRequirementDirectiveSchema>;

/** The directive union — extended additively; the discriminator is the persisted literal. */
export const renderDirectiveSchema = z.discriminatedUnion('kind', [
  authWizardDirectiveSchema,
  connectionRequirementDirectiveSchema,
]);
export type RenderDirective = z.infer<typeof renderDirectiveSchema>;
