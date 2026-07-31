// errors.ts — shared error-result constructors (errors as data, never thrown).
// Codes come from the protocol's ERROR_CODES where one exists; STREAM_DROPPED is the
// transport-level extension named by the runner transport contract (R5: receivers
// classify unknown codes as HOST_ERROR and honor `retryable`).

import { ERROR_CODES } from '@snugprotocol/protocol';

import type { AdapterError } from './types.js';

/** A connection that ended before a terminal event — retryable by contract. */
export const STREAM_DROPPED_CODE = 'STREAM_DROPPED';

export function httpErrorResult(status: number, detail?: string): AdapterError {
  const suffix = detail !== undefined && detail !== '' ? `: ${detail.slice(0, 200)}` : '';
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
