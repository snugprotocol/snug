// errors.ts — shared error-result constructors (errors as data, never thrown).
// Codes come from the protocol's ERROR_CODES where one exists; STREAM_DROPPED is the
// transport-level extension named by the runner transport contract (R5: receivers
// classify unknown codes as HOST_ERROR and honor `retryable`).

import { ERROR_CODES, jwtShapeInText } from '@snugprotocol/protocol';

import { CHATGPT_ERROR_CODES, type ChatgptErrorCode } from './bearer-source.js';
import type { AdapterError } from './types.js';

/** A connection that ended before a terminal event — retryable by contract. */
export const STREAM_DROPPED_CODE = 'STREAM_DROPPED';

/** Provider detail is capped so one error can never carry a whole echoed request body. */
export const ERROR_DETAIL_CAP = 200;

export function httpErrorResult(status: number, detail?: string): AdapterError {
  const suffix = detail !== undefined && detail !== '' ? `: ${detail.slice(0, ERROR_DETAIL_CAP)}` : '';
  return {
    ok: false,
    code: ERROR_CODES.HOST_ERROR,
    message: `HTTP ${status}${suffix}`,
    retryable: status === 429 || status >= 500,
  };
}

export function networkErrorResult(err: unknown): AdapterError {
  return {
    ok: false,
    code: ERROR_CODES.NETWORK_ERROR,
    message: err instanceof Error ? err.message : 'network request failed',
    retryable: true,
  };
}

export function cancelledResult(): AdapterError {
  return { ok: false, code: ERROR_CODES.CANCELLED, message: 'request aborted', retryable: false };
}

export function streamDroppedResult(): AdapterError {
  return {
    ok: false,
    code: STREAM_DROPPED_CODE,
    message: 'stream ended before completion',
    retryable: true,
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

// ---------------------------------------------------------------------------------------------
// The ChatGPT-plan route (TASK-20261023-siwc-chatgpt-plan D3/D5, ADR-0078 §3/§5)
// ---------------------------------------------------------------------------------------------

/**
 * One fixed sentence per named code — the ONLY prose a CHATGPT_* result ever carries. The
 * route's 401 echoes the bearer it was sent and its 403 talks about API keys, and OpenAI's
 * masked-prefix echoes defeat value scrubs, so these states forward no provider text at all:
 * a person reads what to do next (sign in, allow the plan, review usage, wait), never a
 * fragment of a token. Pinned by value in the adapter test — surfaces may have learned them.
 */
export const CHATGPT_ERROR_SENTENCES: Record<ChatgptErrorCode, string> = {
  [CHATGPT_ERROR_CODES.SIGN_IN_NEEDED]: 'Sign in to ChatGPT to continue.',
  [CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED]:
    "ChatGPT plan usage isn't allowed for Snug — allow it in Settings, or use a key or a local model.",
  [CHATGPT_ERROR_CODES.USAGE_LIMIT]: "Usage limit reached — Review your plan or this app's limit in ChatGPT settings.",
  [CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE]: 'ChatGPT plan usage is unavailable right now — try again shortly.',
};

/** A named ChatGPT-plan result: the fixed sentence, `retryable` as decided by the caller, partial text kept. */
export function chatgptErrorResult(code: ChatgptErrorCode, retryable: boolean, partialText = ''): AdapterError {
  return {
    ok: false,
    code,
    message: CHATGPT_ERROR_SENTENCES[code],
    retryable,
    ...(partialText !== '' ? { partialText } : {}),
  };
}

/**
 * Redact, THEN cap — in that order, because a token straddling the cut would otherwise leave
 * an unmatched prefix behind that no later scrub can recognise. `redact` is the bearer
 * source's exact-value scrub over every token it handed out (after a refresh-and-retry the
 * failing attempt's bearer is a different one); the JWT-shape backstop from `packages/protocol`
 * catches a token the source never saw. Callers pass text AFTER any JSON extraction, since a
 * `\u`-escaped echo inside a raw body would slip past a scrub over the raw text (lesson L206).
 */
export function redactThenCap(text: string, redact: (text: string) => string, cap = ERROR_DETAIL_CAP): string {
  const scrubbed = redact(text).replace(jwtShapeInText(), '***');
  return scrubbed.length > cap ? scrubbed.slice(0, cap) : scrubbed;
}
