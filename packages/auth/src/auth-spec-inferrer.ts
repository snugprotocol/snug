/**
 * auth-spec-inferrer — the LLM-assisted proposal generator (AL-04 plan D2/D3/D4),
 * ported from OProject and re-seated DI-pure on a plain completion seam.
 *
 * Inference is a PROPOSAL generator, never an authority (roadmap A10). The ladder is
 * enforced here, not advised (D4): (1) pinned registry — `lookupWellKnownProvider`
 * hit ⇒ deterministic `paramsToAuthSpec`, provenance 'registry', NO seam call;
 * (2) model knowledge — provenance 'inference'; (3) user-pasted docs — provenance
 * 'user_docs'. There is NO live-fetch rung: the host never fetches a docs URL (an
 * arbitrary-URL fetch would be an unfrozen network surface beside AL-03's frozen
 * allowlist wall); desktop-native fetch is a documented future rung only.
 *
 * The prompt is INJECTED by the caller as a rendered string (plan D2): this package's
 * dep surface is pinned to ['@snugprotocol/db','@snugprotocol/protocol'] — it can
 * never import @snugprotocol/knowledge, and the import-specifier lint makes that
 * executable. Replies are parsed with the protocol's fence-tolerant `parseAgentReply`
 * and strict-validated with `inferrerProposalSchema`: any parse/validation failure —
 * including malformed confidence (M11) and the M5-excluded registration/
 * headerTemplate fields — is a typed error and the wizard opens an EMPTY
 * `spec_confirm`, nothing prefilled.
 *
 * Provenance is computed from the LADDER RUNG alone — never from confidence, never
 * from anything the reply claims (B2/AC3). Confidence survives only as UX copy
 * grading (`AUTH_INFERENCE_CONFIDENCE_NOTE_THRESHOLD`), demoted from v1's gate.
 */

import {
  inferrerProposalSchema,
  parseAgentReply,
  type AuthProvenance,
  type AuthSpec,
  type LlmProposal,
} from '@snugprotocol/protocol';
import { paramsToAuthSpec } from './params-to-auth-spec.js';
import { lookupWellKnownProvider, type WellKnownOauthProvider } from './well-known-providers.js';

/** The minimal completion seam (D2) — one prompt string in, one reply string out. */
export type InferrerComplete = (prompt: string, opts: { signal?: AbortSignal }) => Promise<string>;

/**
 * Confidence COPY-GRADE threshold (AC3/M3): a valid confidence below this adds "the
 * model was unsure about this" framing inside `spec_confirm`. Copy grading ONLY —
 * renamed from v1's `…_GATE` because it gates nothing: the review branch keys on
 * host-computed provenance, and malformed confidence is a schema rejection (M11).
 */
export const AUTH_INFERENCE_CONFIDENCE_NOTE_THRESHOLD = 0.7;

/** True when `spec_confirm` should carry the "the model was unsure" copy. */
export function needsUnsureConfidenceNote(confidence: number): boolean {
  return confidence < AUTH_INFERENCE_CONFIDENCE_NOTE_THRESHOLD;
}

export interface AuthSpecInferrerDeps {
  complete: InferrerComplete;
  /** Injectable registry lookup for tests; defaults to the pinned well-known registry. */
  lookup?: (name: string) => WellKnownOauthProvider | undefined;
}

export interface InferAuthSpecInput {
  /** Provider display name — the ladder key. The caller's value is authoritative. */
  providerName: string;
  /** Explicit kind wins over the model's guess; the registry rung defaults to oauth2_auth_code. */
  kindHint?: string;
  /**
   * Untrusted pasted docs text (rung 3). Its PRESENCE selects provenance
   * 'user_docs'; its CONTENT rides inside the caller-rendered prompt — this module
   * never persists, logs, or re-transmits it.
   */
  docsText?: string;
  /** The rendered D8 prompt for rungs 2/3 (caller-supplied — see module doc). */
  prompt: string;
  signal?: AbortSignal;
}

export type AuthSpecInferrerErrorCode = 'reply_unparseable' | 'reply_invalid' | 'completion_failed';

export type InferAuthSpecResult =
  | {
      ok: true;
      /** HOST-computed from the ladder rung — the wizard's review-branch selector (AC3). */
      provenance: AuthProvenance;
      /** The reviewable proposal — everything `spec_confirm` displays comes from here. */
      proposal: LlmProposal;
      /** Absent on the registry rung (no model ran). UX copy grading only. */
      confidence?: number;
      /** Docs quotes justifying extracted hosts/endpoints. WIZARD-EPHEMERAL (M1). */
      evidence: string[];
      /** The deterministic transformer's verdict; null ⇒ ask the user for more (D3c). */
      spec: AuthSpec | null;
      reason: string;
    }
  | { ok: false; provenance: AuthProvenance; code: AuthSpecInferrerErrorCode; message: string };

export interface AuthSpecInferrer {
  infer(input: InferAuthSpecInput): Promise<InferAuthSpecResult>;
}

export function createAuthSpecInferrer(deps: AuthSpecInferrerDeps): AuthSpecInferrer {
  const lookup = deps.lookup ?? lookupWellKnownProvider;

  return {
    async infer(input: InferAuthSpecInput): Promise<InferAuthSpecResult> {
      // Rung 1 — pinned registry. Checked FIRST, before docs presence is even
      // considered: pasted docs must never displace a registry entry (AC8), so a
      // famous provider never reaches the seam at all (AC2, mutation M3).
      const wellKnown = lookup(input.providerName);
      if (wellKnown !== undefined) {
        const proposal: LlmProposal = {
          providerName: input.providerName,
          // Registry entries are OAuth providers; without an explicit kind the
          // deterministic transformer still needs one, so the OAuth-code kind is the
          // registry rung's default (journaled decision — the transformer's own
          // fail-closed rules still apply).
          kindHint: input.kindHint ?? 'oauth2_auth_code',
        };
        const built = paramsToAuthSpec(proposal);
        return {
          ok: true,
          provenance: 'registry',
          proposal,
          evidence: [],
          spec: built.spec,
          reason: built.reason,
        };
      }

      // Rungs 2/3 — the model. Provenance comes from the rung, nothing else.
      const provenance: AuthProvenance = input.docsText !== undefined ? 'user_docs' : 'inference';

      let replyText: string;
      try {
        replyText = await deps.complete(input.prompt, { signal: input.signal });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, provenance, code: 'completion_failed', message: `completion failed: ${message}` };
      }

      const parsed = parseAgentReply(replyText);
      if (!parsed.ok) {
        return {
          ok: false,
          provenance,
          code: 'reply_unparseable',
          message: 'the model reply was not a parseable JSON object',
        };
      }

      const validated = inferrerProposalSchema.safeParse(parsed.data);
      if (!validated.success) {
        const issues = validated.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.code}`)
          .join('; ');
        return {
          ok: false,
          provenance,
          code: 'reply_invalid',
          message: `the model reply failed the output contract: ${issues}`,
        };
      }

      // The caller's identity hints are authoritative over the model's echo: the
      // provider NAME is the ladder key at every mount, and an explicit user kind
      // wins over a guess. Everything else in the proposal stays reviewable as-is.
      const proposal: LlmProposal = {
        ...validated.data.proposal,
        providerName: input.providerName,
        ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
      };

      const built = paramsToAuthSpec(proposal);
      return {
        ok: true,
        provenance,
        proposal,
        confidence: validated.data.confidence,
        evidence: validated.data.evidence,
        spec: built.spec,
        reason: built.reason,
      };
    },
  };
}
