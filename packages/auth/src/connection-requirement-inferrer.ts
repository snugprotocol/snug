/**
 * connection-requirement-inferrer — the FULL-REQUIREMENT successor to
 * `auth-spec-inferrer` (TASK-20260810-p2-pipeline, parent §5 R2).
 *
 * WHAT CHANGED FROM v3, and why. `createAuthSpecInferrer` emits `llmProposalSchema`
 * HINTS — a three-key shape (`providerName`/`kindHint`/`declaredApiHosts`) that omits
 * `fields`, `registration` and `headerTemplate`. Those omissions were AL-04's answer to
 * credential misdirection, and they are also why a Coinbase-shaped requirement collapsed
 * to one generic field: the channel had no way to say "this provider issues three
 * values". This inferrer emits a WHOLE requirement instead, and pays for the richer
 * channel exactly as ADR-0017 prescribes — the model PROPOSES, the HOST VALIDATES:
 * `connectionRequirementSchema` bounds every seat, `admitConnectionRequirement` runs the
 * registry-borrow ban, the template lint makes the engine's literal fallback unreachable,
 * and the strong field-by-field review renders every byte before a credential is
 * collected. Nothing here is trusted because the model said it.
 *
 * C1 — INFERENCE NEVER SEES A CREDENTIAL, STRUCTURALLY (AC7). This is an ordering fact,
 * not a discipline: inference runs at BUILD time, before the user has been asked for
 * anything, so at the moment this code executes no credential for this connection
 * EXISTS. `InferConnectionRequirementInput` therefore has no seat one could occupy, and
 * the prompt is assembled from the caller's three named fields rather than spread from
 * the input object — so a caller that adds a credential-shaped property (through
 * `unknown`, a JSON round trip, or a synced call path the compiler never checks) cannot
 * have it ride along. That last point is the difference between "today's call site does
 * not pass one" and "there is nowhere to put one".
 *
 * THE LADDER IS UNCHANGED (D4) and is enforced here, not advised: (1) pinned registry —
 * no seam call at all; (2) model knowledge — provenance 'inference'; (3) user-pasted
 * docs — provenance 'user_docs'. There is NO live-fetch rung: the host never fetches a
 * docs URL, because an arbitrary-URL fetch would be an unfrozen network surface beside
 * the frozen host allowlist. Desktop-native fetch is a documented FUTURE rung only.
 *
 * PROVENANCE COMES FROM THE RUNG ALONE — never from confidence, never from anything the
 * reply claims. The reply's own `provenance`/`confidence` echoes are display-only.
 *
 * The prompt is INJECTED by the caller as a rendered string: this package's dep surface
 * is pinned to ['@snugprotocol/db','@snugprotocol/protocol'] and can never import
 * @snugprotocol/knowledge (an import-specifier lint makes that executable). The prompt
 * itself lives in the central store (ADR-0004),
 * `prompts/tools/connection-requirement-inferrer.md`.
 *
 * CUTOVER (fold B1): additive. `createAuthSpecInferrer` and `llmProposalSchema` keep
 * shipping; their removal is P4's named exit item.
 */

import {
  connectionRequirementSchema,
  parseAgentReply,
  type ConnectionProvenance,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import { admitConnectionRequirement } from './requirement-admission.js';
import { lintAuthHeaderTemplate } from './template-lint.js';
import {
  lookupWellKnownProvider,
  requirementFromRegistryEntry,
  resolveInferrerAlias,
  type WellKnownOauthProvider,
} from './well-known-providers.js';

/** The minimal completion seam — one prompt string in, one reply string out. */
export type RequirementInferrerComplete = (prompt: string, opts: { signal?: AbortSignal }) => Promise<string>;

export interface ConnectionRequirementInferrerDeps {
  complete: RequirementInferrerComplete;
  /** Injectable registry lookup for tests; defaults to the pinned well-known registry. */
  lookup?: (name: string) => WellKnownOauthProvider | undefined;
}

/**
 * The inferrer's input. Every seat is named, and NONE of them is credential-shaped —
 * see the C1 note in the module doc. This type is the structural half of AC7.
 */
export interface InferConnectionRequirementInput {
  /** Provider display name — the ladder key. The caller's value is authoritative. */
  providerName: string;
  /** The connection slot this requirement will occupy; the host's value, not the model's. */
  slot: string;
  /** The rendered prompt for rungs 2/3 (caller-supplied — see module doc). */
  prompt: string;
  /**
   * Whether untrusted pasted docs were the source. Its PRESENCE selects provenance
   * 'user_docs'. The docs TEXT itself rides inside the caller-rendered `prompt`; this
   * module never persists, logs, or re-transmits it.
   */
  fromPastedDocs?: boolean;
  signal?: AbortSignal;
}

export type ConnectionRequirementInferrerErrorCode =
  | 'reply_unparseable'
  | 'reply_invalid'
  | 'completion_failed'
  | 'admission_refused'
  | 'template_lint_failed';

export type InferConnectionRequirementResult =
  | {
      ok: true;
      /** HOST-computed from the ladder rung — never read off the reply. */
      provenance: ConnectionProvenance;
      /**
       * The validated, admitted requirement — or null when the model honestly refused.
       * Null opens an EMPTY form for the user rather than prefilling a guess.
       */
      requirement: ConnectionRequirement | null;
      /** Display-only UX copy grading. Never gates an approval. */
      confidence?: number;
      /** Docs quotes justifying extracted hosts/endpoints. WIZARD-EPHEMERAL. */
      evidence: string[];
      /** True when the registry-borrow ban substituted pinned values. */
      borrowed?: boolean;
      borrowedFrom?: string;
    }
  | { ok: false; provenance: ConnectionProvenance; code: ConnectionRequirementInferrerErrorCode; message: string };

export interface ConnectionRequirementInferrer {
  infer(input: InferConnectionRequirementInput): Promise<InferConnectionRequirementResult>;
}

export function createConnectionRequirementInferrer(
  deps: ConnectionRequirementInferrerDeps,
): ConnectionRequirementInferrer {
  const lookup = deps.lookup ?? lookupWellKnownProvider;

  return {
    async infer(input: InferConnectionRequirementInput): Promise<InferConnectionRequirementResult> {
      // Rung 1 — the pinned registry, checked FIRST so a famous provider never reaches
      // the seam at all and pasted docs can never displace a registry entry. The exact
      // key is consulted first, then the INFERRER-scoped alias map ("Coinbase Pro" is
      // Coinbase for AUTHORING) — both inside this rung, before any seam reference,
      // which AC4's call-recording test names explicitly. Aliases deliberately do NOT
      // touch `lookupWellKnownProvider` (D3): resolution and the borrow ban keep their
      // own semantics, and this short-circuit grants registry authority nowhere else.
      //
      // THE ENTRY IS THE AUTHORITY on kind and fields (AC1/AC2). This literal used to
      // hardcode `kind: 'oauth2_auth_code'` and discard the entry's `fields`, which
      // routed API-key providers into an OAuth connect step that cannot succeed —
      // the owner's Coinbase defect. `requirementFromRegistryEntry` copies every seat
      // the entry holds and invents none.
      const wellKnown = lookup(input.providerName) ?? resolveInferrerAlias(input.providerName)?.entry;
      if (wellKnown !== undefined) {
        const built = connectionRequirementSchema.safeParse(
          requirementFromRegistryEntry(wellKnown, input.providerName, input.slot),
        );
        return {
          ok: true,
          provenance: 'registry',
          requirement: built.success ? built.data : null,
          evidence: [],
        };
      }

      // Rungs 2/3 — the model. Provenance comes from the rung, nothing else.
      //
      // NOTE the prompt is passed through verbatim as the ONLY thing the seam receives.
      // Nothing is spread from `input`, which is what makes the C1 claim structural
      // rather than incidental (AC7).
      const provenance: ConnectionProvenance = input.fromPastedDocs === true ? 'user_docs' : 'inference';

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

      const envelope = parsed.data as Record<string, unknown>;
      const rawConfidence = envelope['confidence'];
      const confidence = typeof rawConfidence === 'number' && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : undefined;
      if (confidence === undefined) {
        return {
          ok: false,
          provenance,
          code: 'reply_invalid',
          message: 'the reply carried a missing or out-of-range confidence',
        };
      }
      const evidence = Array.isArray(envelope['evidence'])
        ? envelope['evidence'].filter((quote): quote is string => typeof quote === 'string')
        : [];

      // An HONEST REFUSAL is a success, not an error: a null requirement opens an empty
      // form the user fills in, which is a better outcome than a prefilled guess.
      const rawRequirement = envelope['requirement'];
      if (rawRequirement === null || rawRequirement === undefined) {
        return { ok: true, provenance, requirement: null, confidence, evidence };
      }

      // The HOST's identity values are authoritative over the model's echo: the slot is
      // the host's, and the provider NAME is the ladder key at every mount.
      const claimed =
        typeof rawRequirement === 'object' && !Array.isArray(rawRequirement)
          ? { ...(rawRequirement as Record<string, unknown>) }
          : {};
      claimed['slot'] = input.slot;
      const claimedProvider = claimed['provider'];
      claimed['provider'] = {
        ...(typeof claimedProvider === 'object' && claimedProvider !== null && !Array.isArray(claimedProvider)
          ? (claimedProvider as Record<string, unknown>)
          : {}),
        name: input.providerName,
      };

      const validated = connectionRequirementSchema.safeParse(claimed);
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

      // ADMISSION on the rung's channel — the registry-borrow ban and the userLayer gate.
      // Run HERE as well as at the persist seam because a refused requirement must never
      // be RENDERED to the user as a proposal either: the review screen is where borrowed
      // legitimacy would do its work.
      const admitted = admitConnectionRequirement<ConnectionRequirement>(validated.data, { channel: provenance });
      if (!admitted.ok) {
        return {
          ok: false,
          provenance,
          code: 'admission_refused',
          message: admitted.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
        };
      }

      // Re-parse post-substitution: admission may have replaced hosts, endpoints and the
      // provider name, and everything downstream must see what will actually be stored.
      const readmitted = connectionRequirementSchema.safeParse(admitted.requirement);
      if (!readmitted.success) {
        return {
          ok: false,
          provenance,
          code: 'reply_invalid',
          message: 'the requirement failed validation after registry substitution',
        };
      }
      const requirement = readmitted.data;

      // The template lint, against the requirement's OWN declared field keys. A template
      // that fails here would sign the wrong bytes at request time, so it is refused
      // before it can be shown to a user as something worth approving.
      const headerTemplate = requirement.request?.headerTemplate;
      if (headerTemplate !== undefined) {
        const lint = lintAuthHeaderTemplate(headerTemplate, {
          fieldKeys: (requirement.fields ?? []).map((field) => field.key),
        });
        if (!lint.ok) {
          return {
            ok: false,
            provenance,
            code: 'template_lint_failed',
            message: lint.issues.map((issue) => `${issue.header}: ${issue.message}`).join('; '),
          };
        }
      }

      return {
        ok: true,
        provenance,
        requirement,
        confidence,
        evidence,
        ...(admitted.borrowed === true ? { borrowed: true, borrowedFrom: admitted.borrowedFrom } : {}),
      };
    },
  };
}
