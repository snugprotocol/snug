// errors.ts — the one table from the artifact runtime's `SampleErrorCode` (sample.d.ts
// 0.2.41) to Snug adapter errors (TASK-20260905-binding-a-artifacts AC1). Every code is
// NAMED and every result is `retryable: false` except a transient upstream failure — the
// runner must never loop on a host brain (the contract's own rule: "NEVER retry from a
// loop"; `rate_limited` means back off, and the viewer pays for every call). Unknown codes
// and non-SampleError throws become the protocol's HOST_ERROR with the message kept, so a
// new platform code is visible rather than swallowed. Codes outside ERROR_CODES are
// classified HOST_ERROR at the frame boundary (protocol R5) — the message carries the truth.

import type { AdapterError } from '@snugprotocol/adapters';
import { ERROR_CODES } from '@snugprotocol/protocol';

import { PROMPT_TOO_LARGE_CODE } from '@playground/agent/promptBudget';

export const HOST_BRAIN_CODES = {
  /** The viewer declined (or the session cannot sample here) — every later call would fail too. */
  CONSENT_DENIED: 'HOST_BRAIN_CONSENT_DENIED',
  /** Too many calls for this viewer right now — back off; never retried by the runner. */
  RATE_LIMITED: 'HOST_BRAIN_RATE_LIMITED',
  /**
   * The prompt is over the host's input cap — named with the byte count. ONE string with
   * the builder's pre-flight refusal (agent/promptBudget.ts): the same code whether the
   * kit refused before calling or the runtime answered `prompt_too_large`.
   */
  PROMPT_TOO_LARGE: PROMPT_TOO_LARGE_CODE,
  /** Claude declined to answer this prompt; resending unchanged gives the same outcome. */
  REFUSED: 'HOST_BRAIN_REFUSED',
  /** A blank or unparseable reply. */
  EMPTY: 'HOST_BRAIN_EMPTY_REPLY',
  /** The call itself was malformed — a caller bug, never a viewer condition. */
  INVALID_REQUEST: 'HOST_BRAIN_INVALID_REQUEST',
  /** The platform failed transiently. The one retryable code. */
  UPSTREAM: 'HOST_BRAIN_UPSTREAM',
  /** Tool traffic offered to a tool-free brain — a caller bug (the builder takes the tool-free arm). */
  TOOLS_UNSUPPORTED: 'HOST_BRAIN_TOOLS_UNSUPPORTED',
  /** `window.claude.complete` answered with something that is not a string. */
  BAD_REPLY: 'HOST_BRAIN_BAD_REPLY',
} as const;

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

const format = (n: number): string => n.toLocaleString('en-US');

export function mapSampleError(error: SampleErrorLike, context: SampleErrorContext): AdapterError {
  const partial = typeof error.text === 'string' && error.text !== '' ? { partialText: error.text } : {};
  const said = typeof error.message === 'string' && error.message !== '' ? ` (${error.message})` : '';
  const code = typeof error.code === 'string' ? error.code : undefined;
  switch (code) {
    case 'cancelled':
      return { ok: false, code: ERROR_CODES.CANCELLED, message: 'stopped', retryable: false, ...partial };
    case 'not_granted':
    case 'sampling_disabled':
    case 'not_declared':
    case 'capability_disabled':
    case 'capability_removed':
    case 'session_expired':
      return {
        ok: false,
        code: HOST_BRAIN_CODES.CONSENT_DENIED,
        message: `this page may not use Claude in this view${said} — reload to be asked again, or open the artifact where Claude is available`,
        retryable: false,
        ...partial,
      };
    case 'rate_limited':
    case 'queue_overflow':
      return {
        ok: false,
        code: HOST_BRAIN_CODES.RATE_LIMITED,
        message: `Claude is busy for this viewer right now${said} — wait a moment, then try again; Snug never retries on its own`,
        retryable: false,
        ...partial,
      };
    case 'prompt_too_large':
      return {
        ok: false,
        code: HOST_BRAIN_CODES.PROMPT_TOO_LARGE,
        message: `the prompt is ${format(context.promptBytes)} bytes; this host accepts up to ${context.maxPromptBytes !== undefined ? format(context.maxPromptBytes) : '65,536'} — the app or its context is too large to run here`,
        retryable: false,
      };
    case 'refused':
      return { ok: false, code: HOST_BRAIN_CODES.REFUSED, message: `Claude declined to answer this request${said}`, retryable: false };
    case 'empty_completion':
    case 'invalid_json':
      return { ok: false, code: HOST_BRAIN_CODES.EMPTY, message: `Claude answered with nothing usable${said}`, retryable: false, ...partial };
    case 'invalid_request':
    case 'transform_error':
    case 'images_unavailable':
    case 'tools_unavailable':
    case 'image_rejected':
      return { ok: false, code: HOST_BRAIN_CODES.INVALID_REQUEST, message: `the request to Claude was malformed${said} — a Snug defect, not something to retry`, retryable: false };
    case 'upstream_error':
      return { ok: false, code: HOST_BRAIN_CODES.UPSTREAM, message: `Claude could not be reached${said} — try again in a moment`, retryable: true, ...partial };
    default:
      return {
        ok: false,
        code: ERROR_CODES.HOST_ERROR,
        message: code !== undefined ? `the host answered with an unknown error "${code}"${said}` : `the host brain failed${said}`,
        retryable: false,
        ...partial,
      };
  }
}
