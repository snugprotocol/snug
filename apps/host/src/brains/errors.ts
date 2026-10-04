// errors.ts — the one table from the artifact runtime's `SampleErrorCode` to Snug adapter
// results (TASK-20260905-binding-a-artifacts AC1; re-cited to contract 0.2.67 by
// TASK-20261003 R5 C4 — the contract claude.ai serves since at least 2026-10-03; the kit was
// written to 0.2.41). The table names EXACTLY the contract's nineteen codes (`satisfies`
// below, and `brains.test.ts` holds it equal to the union quoted verbatim from `sample.d.ts`
// 0.2.67), so a contract that adds, drops or renames a code is one failing assertion.
//
// Grouped as 0.2.67 groups them — by what the page should do — with two moves from the
// kit's 0.2.41 table: `queue_overflow` is a PAGE BUG ("hundreds of calls were made before the
// runtime started"), no longer a rate limit; `session_expired` is "tell the viewer" ("the
// viewer must sign in again"), no longer a consent refusal. The contract's rules this keeps:
//   - "Only `upstream_error` is transient; NEVER retry any code from a loop." `retryable` is
//     true for it alone, and it is a MANUAL retry hint (the run view's "try again", an app's
//     own button): nothing in the kit or the runner retries a host-brain answer by itself —
//     the runner retries only THREAD_CONFLICT, which no code here becomes. The viewer pays
//     for every call.
//   - "Treat an unknown code as `upstream_error`." A code this table does not know becomes
//     UPSTREAM, with the code itself in the sentence so a new platform code is visible.
//   - `e.text` is "the part of the answer you may keep": kept on every code but `refused`,
//     whose partial is WITHDRAWN ("clear what you showed").
// A rejection with no string `code` is not a SampleError at all: the protocol's HOST_ERROR
// with its message kept. Codes outside ERROR_CODES are classified HOST_ERROR at the frame
// boundary (protocol R5) — the sentence carries the truth.

import type { AdapterError } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { PROMPT_TOO_LARGE_CODE } from '@playground/agent/promptBudget';
import { HOST_BRAIN_REFUSED_CODE } from '@playground/platform/platform';

import { DEFAULT_MAX_PROMPT_BYTES } from './prompt.js';

export const HOST_BRAIN_CODES = {
  /** The viewer (or their organization) has not allowed this page to use Claude in this view. */
  CONSENT_DENIED: 'HOST_BRAIN_CONSENT_DENIED',
  /** Claude cannot be used in this view for a reason that is not consent (the account, the declaration, the runtime) — permanent for the view. */
  UNAVAILABLE: 'HOST_BRAIN_UNAVAILABLE',
  /** The viewer must sign in to Claude again. */
  SESSION_EXPIRED: 'HOST_BRAIN_SESSION_EXPIRED',
  /** Too many calls for this viewer right now — back off; never retried by the runner. */
  RATE_LIMITED: 'HOST_BRAIN_RATE_LIMITED',
  /**
   * The prompt is over the host's input cap — named with the byte count. ONE string with
   * the builder's pre-flight refusal (agent/promptBudget.ts): the same code whether the
   * kit refused before calling or the runtime answered `prompt_too_large`.
   */
  PROMPT_TOO_LARGE: PROMPT_TOO_LARGE_CODE,
  /**
   * Claude declined to answer this prompt; resending unchanged gives the same outcome. The
   * platform seat's code (platform.ts): the one failure whose streamed text is withdrawn.
   */
  REFUSED: HOST_BRAIN_REFUSED_CODE,
  /** A blank or unparseable reply. */
  EMPTY: 'HOST_BRAIN_EMPTY_REPLY',
  /**
   * A page bug — the contract's group: "nothing was sent; the message says what to change". A
   * malformed call, one the runtime could not prepare, a flood before it started, or an image
   * (which the kit never sends). A Snug defect, never a viewer condition, never retried.
   */
  INVALID_REQUEST: 'HOST_BRAIN_INVALID_REQUEST',
  /** The platform failed transiently — or answered a code this table does not know. The one retryable code. */
  UPSTREAM: 'HOST_BRAIN_UPSTREAM',
  /** Tool traffic for a tool-free brain — a caller bug (the builder takes the tool-free arm). */
  TOOLS_UNSUPPORTED: 'HOST_BRAIN_TOOLS_UNSUPPORTED',
} as const;

/** `SampleErrorCode` of `sample.d.ts`, contract 0.2.67 — the nineteen codes, in the contract's order. */
export type SampleErrorCode =
  | 'invalid_request'
  | 'prompt_too_large'
  | 'images_unavailable'
  | 'tools_unavailable'
  | 'image_rejected'
  | 'cancelled'
  | 'not_granted'
  | 'session_expired'
  | 'sampling_disabled'
  | 'not_declared'
  | 'rate_limited'
  | 'refused'
  | 'empty_completion'
  | 'invalid_json'
  | 'upstream_error'
  | 'capability_disabled'
  | 'capability_removed'
  | 'transform_error'
  | 'queue_overflow';

/** The slice of a rejected `sample` promise the mapping reads. */
export interface SampleErrorLike {
  code?: unknown;
  message?: unknown;
  /** Partial text the page may keep (sample.d.ts: `e.text`). */
  text?: unknown;
}

export interface SampleErrorContext {
  /** Bytes of the input that was sent — named in the PROMPT_TOO_LARGE message. */
  promptBytes: number;
  /** The cap `limits()` reported, when known. */
  maxPromptBytes?: number;
}

/** One code's named result: the Snug code a reader branches on, and the sentence a person reads. */
export interface SampleErrorResult {
  code: string;
  /** `said` is the runtime's own message, in parentheses, or empty. */
  sentence: (said: string, context: SampleErrorContext) => string;
  /** `refused` only: the partial is withdrawn, never kept. */
  withdrawsPartial?: true;
}

const format = (n: number): string => n.toLocaleString('en-US');
const snugDefect = 'a Snug defect, not something to retry';

/**
 * Every code of the contract, by the contract's own groups. `images_unavailable`,
 * `image_rejected` and `tools_unavailable` are a feature to hide or a file to change for a
 * page that sends images or tools; the kit sends neither (no image affordance; tool traffic
 * is refused before the call), so for it each names a Snug defect instead.
 */
export const SAMPLE_ERRORS = {
  // You did it.
  cancelled: { code: ERROR_CODES.CANCELLED, sentence: () => 'stopped' },

  // A page bug — nothing was sent.
  invalid_request: { code: HOST_BRAIN_CODES.INVALID_REQUEST, sentence: (said) => `the request to Claude was malformed${said} — ${snugDefect}` },
  transform_error: { code: HOST_BRAIN_CODES.INVALID_REQUEST, sentence: (said) => `the request to Claude could not be prepared${said} — ${snugDefect}` },
  queue_overflow: {
    code: HOST_BRAIN_CODES.INVALID_REQUEST,
    sentence: (said) => `Snug made hundreds of calls to Claude before this view’s runtime had started${said} — nothing was sent; ${snugDefect}`,
  },
  prompt_too_large: {
    code: HOST_BRAIN_CODES.PROMPT_TOO_LARGE,
    sentence: (said, context) =>
      `the prompt is ${format(context.promptBytes)} bytes; this host accepts up to ${format(context.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES)}${said} — the app or its context is too large to run here`,
  },

  // Hide the feature for this view — permanent, never re-asked.
  not_granted: { code: HOST_BRAIN_CODES.CONSENT_DENIED, sentence: (said) => `Claude is not allowed for this page in this view${said} — if you declined, reload to be asked again` },
  sampling_disabled: { code: HOST_BRAIN_CODES.UNAVAILABLE, sentence: (said) => `Claude is not available to this account or organization${said}` },
  not_declared: { code: HOST_BRAIN_CODES.UNAVAILABLE, sentence: (said) => `this artifact no longer declares Claude${said}, so it cannot ask Claude in this view` },
  capability_disabled: { code: HOST_BRAIN_CODES.UNAVAILABLE, sentence: (said) => `Claude is allowed here but cannot be used in this view${said}` },
  capability_removed: {
    code: HOST_BRAIN_CODES.UNAVAILABLE,
    sentence: (said) => `the runtime serving this view does not offer what Snug called${said} — open the artifact in an up-to-date Claude app`,
  },
  images_unavailable: { code: HOST_BRAIN_CODES.INVALID_REQUEST, sentence: (said) => `this view cannot send images to Claude${said} — and Snug never sends one, so this is ${snugDefect}` },
  tools_unavailable: { code: HOST_BRAIN_CODES.TOOLS_UNSUPPORTED, sentence: (said) => `this view cannot run page tools${said} — Snug’s host turns never offer any, so this is ${snugDefect}` },

  // Tell the viewer, keep the control — the page never retries by itself.
  rate_limited: {
    code: HOST_BRAIN_CODES.RATE_LIMITED,
    sentence: (said) => `Claude is busy for this viewer right now${said} — wait a moment, then try again; Snug never retries on its own`,
  },
  session_expired: { code: HOST_BRAIN_CODES.SESSION_EXPIRED, sentence: (said) => `your Claude session has ended${said} — sign in to Claude again, then try again` },
  image_rejected: { code: HOST_BRAIN_CODES.INVALID_REQUEST, sentence: (said) => `Claude rejected an image${said} — Snug never sends one, so this is ${snugDefect}` },
  refused: {
    code: HOST_BRAIN_CODES.REFUSED,
    sentence: (said) => `Claude declined to answer this request${said} — sending it unchanged gets the same answer`,
    withdrawsPartial: true,
  },
  empty_completion: { code: HOST_BRAIN_CODES.EMPTY, sentence: (said) => `Claude answered with no text${said} — ask for something simpler` },
  invalid_json: { code: HOST_BRAIN_CODES.EMPTY, sentence: (said) => `Claude’s reply held no parseable JSON${said}` },
  upstream_error: { code: HOST_BRAIN_CODES.UPSTREAM, sentence: (said) => `Claude could not be reached${said} — try again in a moment` },
} satisfies Record<SampleErrorCode, SampleErrorResult>;

const isContractCode = (code: string): code is SampleErrorCode => Object.prototype.hasOwnProperty.call(SAMPLE_ERRORS, code);

export function mapSampleError(error: SampleErrorLike, context: SampleErrorContext): AdapterError {
  const said = typeof error.message === 'string' && error.message !== '' ? ` (${error.message})` : '';
  const partial = typeof error.text === 'string' && error.text !== '' ? { partialText: error.text } : {};
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (code === undefined) return { ok: false, code: ERROR_CODES.HOST_ERROR, message: `the host brain failed${said}`, retryable: false, ...partial };
  if (!isContractCode(code)) {
    return {
      ok: false,
      code: HOST_BRAIN_CODES.UPSTREAM,
      message: `the host answered with an error this kit does not know, "${code}"${said} — treated as a passing failure; try again in a moment`,
      retryable: true,
      ...partial,
    };
  }
  const result: SampleErrorResult = SAMPLE_ERRORS[code];
  return {
    ok: false,
    code: result.code,
    message: result.sentence(said, context),
    retryable: result.code === HOST_BRAIN_CODES.UPSTREAM,
    ...(result.withdrawsPartial === true ? {} : partial),
  };
}
