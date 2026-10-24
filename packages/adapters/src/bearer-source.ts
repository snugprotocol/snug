// bearer-source.ts — the seam between a session keeper and the Responses adapter
// (TASK-20261023-siwc-chatgpt-plan D3/D5, plan §2; Gate-2 finding F6). Defined HERE because
// adapters cannot depend on auth: the keeper (`@snugprotocol/auth`'s ChatGPT-plan session) is
// adapted to this shape in the playground's platform seat, and the adapter never sees a key —
// it asks for a bearer per attempt, asks for a refresh when the attempt it made came back 401,
// tells the source when the RETRY came back 401 too, and hands every error body through
// `redact` before a message is formed (the bearer of the attempt that FAILED, which after a
// refresh-and-retry is a different token).

/**
 * Why a bearer could not be produced, in the keeper's words. Every code is a NAMED result on
 * the adapter side (`CHATGPT_*` below) — never a fall-through to a key, a local model or the
 * demo brain (D5: the user chose this brain; a missing session is a result, not a reroute).
 */
export type BearerFailureCode = 'sign_in_needed' | 'plan_not_granted' | 'usage_unavailable' | 'network' | 'refresh_not_ready';

export type BearerResult = { ok: true; token: string } | { ok: false; code: BearerFailureCode; retryable: boolean };

export interface BearerSource {
  /** The current bearer, refreshed proactively by the keeper when it is about to expire. */
  get(): Promise<BearerResult>;
  /**
   * A FORCED refresh after a 401 on `stale`. The keeper first checks `stale` is still the
   * current token — another caller may already have rotated it — and otherwise answers the
   * newer one without a second POST (single-flight, D4).
   */
  refresh(stale: string): Promise<BearerResult>;
  /** Scrub every bearer this source has handed out from `text` (the auth side's exact-value scrub). */
  redact(text: string): string;
  /**
   * The route rejected `stale` AFTER a refresh-and-retry: the session the keeper holds is not
   * one the route accepts, so the keeper should say "signed out" instead of looking healthy
   * while every send burns a refresh and two requests (Gate 5 G5-C4). Optional and additive —
   * a source without it is complete; the adapter awaits it and swallows whatever it throws,
   * because the named result it is about to return is the user's news, not the keeper's error.
   */
  invalidate?(stale: string): Promise<void>;
}

/**
 * The four host-level codes the ChatGPT-plan route answers with (D5, AC6/AC7). Strings on the
 * wire that apps already classify as `HOST_ERROR` honouring `retryable` (R5); the playground
 * renders each with one sentence a person can act on, and the limit's primary action is
 * Manage usage. Pinned by value in the contract test — apps may have learned them.
 */
export const CHATGPT_ERROR_CODES = {
  SIGN_IN_NEEDED: 'CHATGPT_SIGN_IN_NEEDED',
  PLAN_NOT_GRANTED: 'CHATGPT_PLAN_NOT_GRANTED',
  USAGE_LIMIT: 'CHATGPT_USAGE_LIMIT',
  USAGE_UNAVAILABLE: 'CHATGPT_USAGE_UNAVAILABLE',
} as const;

export type ChatgptErrorCode = (typeof CHATGPT_ERROR_CODES)[keyof typeof CHATGPT_ERROR_CODES];
