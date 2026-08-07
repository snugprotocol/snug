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
 * PROPOSAL LINE (M5): every LLM-authored shape uses `llmProposalSchema` =
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
 */

import { z } from 'zod';
import { AUTH_KINDS, authSpecHintsSchema } from './auth-schema.js';
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
 * The ONLY shape an LLM-authored proposal may take (M5): transformer hints minus
 * registration copy + headerTemplate + credential field definitions (`fields`/
 * `userLayerFields` — the label surface the credentials step renders verbatim).
 * Strictness is preserved through `.omit` — a reply/directive carrying an excluded
 * key is a strict-schema rejection (`inferrer.poison-registration` /
 * `inferrer.poison-fields`, mutation M21).
 */
export const llmProposalSchema = authSpecHintsSchema.omit({
  registrationConsoleUrl: true,
  registrationInstructions: true,
  headerTemplate: true,
  fields: true,
  userLayerFields: true,
});
export type LlmProposal = z.infer<typeof llmProposalSchema>;

/**
 * The inferrer's OUTPUT contract (plan D8): proposal + REQUIRED confidence in [0,1]
 * + bounded evidence quotes. Malformed confidence (missing/NaN/out-of-range) is a
 * SCHEMA rejection → typed inferrer error → empty `spec_confirm`, nothing prefilled
 * (M11 — there is no "reads as 0" branch). `evidence[]` quotes untrusted docs and is
 * WIZARD-EPHEMERAL: it travels inside the wizardStore intent and never persists (M1).
 */
export const inferrerProposalSchema = z.strictObject({
  proposal: llmProposalSchema,
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string().min(1).max(AUTH_EVIDENCE_MAX_CHARS)).max(AUTH_EVIDENCE_MAX_ITEMS),
});
export type InferrerProposal = z.infer<typeof inferrerProposalSchema>;

// -------------------------------------------------------------- the directive

/**
 * The `auth_wizard` render directive — versioned with the frame discipline (`v`),
 * strict, and identical to the persisted chat-meta shape (M1). `confidence` and
 * `provenance` are OPTIONAL display-only echoes: the host recomputes both at wizard
 * open (B2) and no gating code may read the copies carried here (mutation M16).
 */
export const authWizardDirectiveSchema = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  kind: z.literal('auth_wizard'),
  proposal: llmProposalSchema,
  /** Display-only. The host recomputes confidence at wizard open (B2). */
  confidence: z.number().min(0).max(1).optional(),
  /** Display-only. Provenance is HOST-computed at wizard open — never this claim (B2). */
  provenance: z.enum(AUTH_PROVENANCES).optional(),
});
export type AuthWizardDirective = z.infer<typeof authWizardDirectiveSchema>;

/** The directive union (one member v1) — future directives extend this discriminator. */
export const renderDirectiveSchema = z.discriminatedUnion('kind', [authWizardDirectiveSchema]);
export type RenderDirective = z.infer<typeof renderDirectiveSchema>;

// ------------------------------------------------------- AUTH_REQUIRED payload

/**
 * Payload for the reserved `ERROR_CODES.AUTH_REQUIRED` (constants.ts): the display
 * fields an app-side "connect" CTA needs. Additive — the wire error-code rule (open
 * strings, R5) is unchanged. Strict-rejects unknown keys (mutation M29).
 */
export const authRequiredPayloadSchema = z.strictObject({
  providerName: z.string().min(1),
  kind: z.enum(AUTH_KINDS),
  declaredApiHosts: z.array(z.string().min(1)).optional(),
});
export type AuthRequiredPayload = z.infer<typeof authRequiredPayloadSchema>;
