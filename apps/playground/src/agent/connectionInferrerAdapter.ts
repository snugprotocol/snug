/**
 * connectionInferrerAdapter — the playground side of the Dynamic Auth v2 requirement
 * inferrer seam (TASK-20260810-p3-wizard, plan §6 item 5).
 *
 * WHAT THIS CLOSES. P2 shipped `createConnectionRequirementInferrer` with NO production
 * caller while the shipped wizard still reached the v3 spec inferrer, so P2's AC7
 * ("inference never sees a credential") held only BY TEST CONSTRUCTION. This module is
 * the caller that makes it true on the path that actually ships.
 *
 * WHERE INFERENCE NOW RUNS, AND WHY IT MOVED. At BUILD time, from the post-turn
 * declaration seam — never from the run-time wizard (Q5). The trigger is the one case
 * that is otherwise unrecoverable: the model wrote an app that calls `useConnectedFetch`
 * but closed its reply WITHOUT a `connection_requirement` directive. That app is broken
 * in a way the user can neither see nor fix — every connected call resolves
 * `{ ok: false }` forever and no connect card renders, because a card is drawn from a
 * persisted row and there is no row. Before this, the only outcome was a note telling the
 * user to go ask the agent again. Now the host asks on their behalf, using the provider
 * name the app's own code reveals.
 *
 * C1 — INFERENCE NEVER SEES A CREDENTIAL, STRUCTURALLY. This is an ordering fact rather
 * than a discipline: the call happens at BUILD, before the user has been asked for
 * anything, so at the moment it executes no credential for this connection EXISTS. The
 * inferrer's input type has no seat one could occupy, the prompt is assembled from named
 * fields rather than spread from an object, and this adapter passes only a provider name,
 * a slot, and a rendered prompt. Nothing here reads `snug_secrets`.
 *
 * ADR-0004 — the prompt is NOT authored here. It is rendered by
 * `buildConnectionRequirementInferrerPrompt` from the central store
 * (`prompts/tools/connection-requirement-inferrer.md`), because packages/auth's dep
 * surface is pinned and can never import @snugprotocol/knowledge. This module is one of
 * the two places allowed to join them: the app depends on both.
 *
 * ADR-0012 — `cache` is NEVER set on this turn. It is a one-shot well below every
 * cacheable-prefix minimum, so a breakpoint would be a pure write premium.
 */

import type { AgentAdapter } from '@snugprotocol/adapters';
import { buildConnectionRequirementInferrerPrompt } from '@snugprotocol/knowledge';
import {
  createConnectionRequirementInferrer,
  type InferConnectionRequirementResult,
  type RequirementInferrerComplete,
} from '@snugprotocol/auth';

import { completeWithAdapter, liveInferenceAdapter } from './inferrerAdapter.js';

// ---------------------------------------------------------------------------
// Paste-box credential tripwire (D10/M2, mutation M19) — REHOMED FROM THE v3 STORE
// ---------------------------------------------------------------------------
//
// WHY IT SURVIVED THE v3 DELETION. `docsText` transits to the user's BYOK provider BY
// DESIGN — that is the whole point of the pasted-docs rung — so a user who pastes a page
// that happens to contain a live key has sent it to a third party. That is the ONE path
// by which a real credential can reach an LLM, and it is a user action rather than a
// system one, so no structural boundary can close it. The tripwire is the last moment to
// catch it, and it must fire BEFORE the completion seam is invoked, never after.
//
// Q5 removed the RUN-TIME paste box, not pasted docs as a channel: the build/edit rung
// still accepts them, so the tripwire moves here with its patterns intact rather than
// being deleted alongside the surface that used to call it.

const TRIPWIRE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/, // Anthropic/OpenAI-style keys
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}/, // AWS access key ids
  /\bBearer\s+ey[A-Za-z0-9._~+/-]{10,}/i, // pasted JWT bearer
  /\bgh[pousr]_[A-Za-z0-9]{16,}/, // GitHub PATs
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAIza[A-Za-z0-9_-]{10,}/, // Google
];

/**
 * High-entropy token heuristic: a long base64ish run mixing cases and digits.
 * URLs are stripped FIRST (nonBlocking 7): the old per-token `/^https?:/` skip was dead —
 * ':' and '.' are not in the token character class, so a URL never matched as one token
 * and its long path segments false-positived, training users to click "send anyway".
 * Stripping applies to this heuristic ONLY: the explicit credential patterns above still
 * scan the FULL text, so a key pasted inside a URL still trips.
 */
function looksHighEntropy(text: string): boolean {
  const withoutUrls = text.replace(/\bhttps?:\/\/[^\s"'<>)\]]+/gi, ' ');
  for (const match of withoutUrls.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const token = match[0];
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /[0-9]/.test(token)) return true;
  }
  return false;
}

/**
 * True when pasted docs look like they contain a REAL credential (R5). The caller warns
 * and requires an explicit override BEFORE the completion seam is invoked.
 */
export function docsTripwire(text: string): boolean {
  return TRIPWIRE_PATTERNS.some((pattern) => pattern.test(text)) || looksHighEntropy(text);
}

export interface RunConnectionRequirementInferenceInput {
  /** Provider display name — the ladder key. The HOST's value, never the model's. */
  providerName: string;
  /** The slot the recovered requirement will occupy. The host's value. */
  slot: string;
  /**
   * Untrusted provider documentation, when the user pasted some in BUILD chat. Its
   * presence selects provenance 'user_docs'. There is NO run-time paste box (Q5).
   */
  docsText?: string;
  kindHint?: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the live settings-configured adapter. */
  adapter?: AgentAdapter;
  /**
   * The user's explicit "send it anyway" after the tripwire warned. Absent, pasted docs
   * that look like they carry a live credential BLOCK the call. It is deliberately a
   * per-call decision rather than a setting: a remembered override would silently apply
   * to a future paste the user has not looked at.
   */
  overrideTripwire?: boolean;
}

/** Distinct from an inference RESULT: nothing was sent, so there is nothing to report. */
export type ConnectionInferenceOutcome =
  | { blocked: 'tripwire' }
  | { blocked?: undefined; result: InferConnectionRequirementResult };

/**
 * Run the v2 inferrer for one slot. The registry rung short-circuits inside the inferrer
 * and never touches the seam at all, so a well-known provider costs no tokens and cannot
 * be displaced by pasted docs.
 *
 * A missing model is an HONEST FAILURE, surfaced before any seam call: the demo brain's
 * scripted replies would guarantee a misleading 'not parseable' error, so a keyless or
 * mock configuration returns `completion_failed` with copy that names the actual repair.
 */
export async function runConnectionRequirementInference(
  input: RunConnectionRequirementInferenceInput,
): Promise<InferConnectionRequirementResult> {
  const outcome = await runConnectionRequirementInferenceGuarded(input);
  if (outcome.blocked === 'tripwire') {
    return {
      ok: false,
      provenance: 'user_docs',
      code: 'completion_failed',
      message:
        'the documentation you pasted looks like it contains a real credential — remove it before sending, or confirm you want to send it anyway',
    };
  }
  return outcome.result;
}

/**
 * The tripwire-aware entry point. THE TRIPWIRE RUNS FIRST — before the prompt is even
 * rendered, let alone sent — because a warning that fires after the bytes have left is
 * not a warning.
 */
export async function runConnectionRequirementInferenceGuarded(
  input: RunConnectionRequirementInferenceInput,
): Promise<ConnectionInferenceOutcome> {
  if (input.docsText !== undefined && input.overrideTripwire !== true && docsTripwire(input.docsText)) {
    return { blocked: 'tripwire' };
  }
  return { result: await runInference(input) };
}

/**
 * The keyless refusal, named because it is USER-FACING COPY and must keep naming the
 * actual repair. It is the honest end of the ladder — reached only when a rung genuinely
 * needs a model — so it must never be softened into "something went wrong".
 */
const KEYLESS_INFERENCE_MESSAGE =
  'working out this connection needs a bring-your-own-key model — the demo brain cannot read provider docs. Add a provider key (or a local model) in Settings, then ask the app to set the connection up again.';

async function runInference(
  input: RunConnectionRequirementInferenceInput,
): Promise<InferConnectionRequirementResult> {
  const { system, user } = buildConnectionRequirementInferrerPrompt({
    providerName: input.providerName,
    ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
    ...(input.docsText !== undefined ? { docsText: input.docsText } : {}),
  });

  /**
   * THE MODEL IS DEMANDED LAZILY, INSIDE THE SEAM — never before the inferrer runs.
   *
   * This ordering is load-bearing and was a real defect until the P3 fold. The inferrer's
   * FIRST rung is the pinned registry, which answers from constants in this repo and never
   * touches the completion seam; the eager version resolved a live adapter up front and
   * returned `completion_failed` when there was none, so the registry rung was never
   * reached. On the demo brain (or any keyless configuration) recovering a connection to a
   * provider WE PIN — Spotify, Google, Gmail — failed with "needs a bring-your-own-key
   * model", telling the user to go buy a model to obtain a value we already had. Worse, it
   * was the build-time RECOVERY path that hit it: the one case where the app is otherwise
   * unfixable from the user's side.
   *
   * Deferring the resolution makes the module doc's own claim ("a well-known provider
   * costs no tokens and cannot be displaced") structurally true rather than aspirational.
   * A keyless configuration still fails honestly for an UNPINNED provider — the same copy,
   * naming the same repair — because that failure is correct and must survive.
   */
  const complete: RequirementInferrerComplete = async (prompt, options) => {
    if (input.adapter !== undefined) return completeWithAdapter(input.adapter, system)(prompt, options);
    const live = await liveInferenceAdapter();
    if (!live.ok) {
      // Thrown rather than returned: the inferrer owns the mapping to `completion_failed`,
      // and provenance comes from the RUNG it was on — never from how the failure arose.
      throw new Error(KEYLESS_INFERENCE_MESSAGE);
    }
    return completeWithAdapter(live.adapter, system)(prompt, options);
  };

  const inferrer = createConnectionRequirementInferrer({ complete });
  return inferrer.infer({
    providerName: input.providerName,
    slot: input.slot,
    prompt: user,
    ...(input.docsText !== undefined ? { fromPastedDocs: true } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}
