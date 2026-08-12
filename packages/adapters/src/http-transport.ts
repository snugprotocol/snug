// http-transport.ts — the runner AgentTransport client: POST /invoke + SSE.
// Structurally identical to @snugprotocol/runner's AgentTransport (a type-conformance
// test locks this); declared locally so this browser-safe package carries no runner
// dependency at runtime.
//
// Condition → code map (task contract): HTTP 409 → THREAD_CONFLICT (retryable — the
// host retries and restarts delta accumulation itself), abort → CANCELLED (clean),
// network failure → NETWORK_ERROR, mid-stream drop → STREAM_DROPPED (retryable).
// Heartbeat comments and malformed blocks are tolerated; events after the terminal
// `done`/`error` block are never read.

import { ERROR_CODES } from '@snugprotocol/protocol';

import {
  cancelledResult,
  httpErrorResult,
  isAbortError,
  networkErrorResult,
  streamDroppedResult,
} from './errors.js';
import { parseSse, tryParseJsonRecord } from './sse.js';
import type { AdapterError, FetchLike } from './types.js';

export type HttpTransportResult =
  | { ok: true; text: string; stopReason?: 'end' | 'max_tokens' }
  | AdapterError;

export interface HttpTransportSendOptions {
  signal: AbortSignal;
  /** Called with each streamed DELTA (not cumulative) — the host accumulates. */
  onDelta?: (delta: string) => void;
}

export interface HttpTransport {
  send(wire: string, options: HttpTransportSendOptions): Promise<HttpTransportResult>;
}

export interface HttpTransportOptions {
  /** Forwarded as body `threadId` so the server can keep per-thread history. */
  threadId?: string;
  /** Forwarded as body `model` — subscription-mode model choice (host-owned, validated server-side). */
  model?: string;
  /** Extra request headers (host-owned — never app-controlled, per C1). */
  headers?: Record<string, string>;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  /**
   * Resolve the app's runtime contract for THIS send (ADR-0018 D3).
   *
   * The hub is stateless about apps and cannot look a contract up, so subscription mode
   * has to carry it. Called per send rather than captured at construction, matching the
   * direct path's rule — a contract read once would go stale on an edit or revert.
   * Returning `undefined` (or omitting the option) sends no contract, which is exactly
   * what a contract-less app should do.
   */
  getContract?: () => Promise<unknown | undefined>;
}

export function createHttpTransport(invokeUrl: string, options: HttpTransportOptions = {}): HttpTransport {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  return {
    async send(wire, { signal, onDelta }) {
      const contract = await options.getContract?.();
      let response: Response;
      try {
        response = await fetchImpl(invokeUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...options.headers,
          },
          body: JSON.stringify({
            message: wire,
            ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
            ...(options.model !== undefined ? { model: options.model } : {}),
            // Omitted entirely when absent: the route distinguishes "no contract" from a
            // present-but-empty one, and a legacy app must assemble byte-identically to
            // before this feature existed (AC-F1-4).
            ...(contract !== undefined ? { contract } : {}),
          }),
          signal,
        });
      } catch (err) {
        return isAbortError(err) || signal.aborted ? cancelledResult() : networkErrorResult(err);
      }

      if (response.status === 409) {
        return {
          ok: false,
          code: ERROR_CODES.THREAD_CONFLICT,
          message: 'another request is in flight for this thread',
          retryable: true,
        };
      }
      if (!response.ok) {
        const bodyText = await safeText(response);
        const parsed = tryParseJsonRecord(bodyText);
        if (parsed !== null && typeof parsed.code === 'string' && typeof parsed.message === 'string') {
          return { ok: false, code: parsed.code, message: parsed.message, retryable: parsed.retryable === true };
        }
        return httpErrorResult(response.status, bodyText);
      }

      try {
        for await (const event of parseSse(response.body)) {
          const data = tryParseJsonRecord(event.data);
          if (data === null) continue; // one malformed block never kills the stream
          if (event.event === 'delta') {
            if (typeof data.text === 'string') onDelta?.(data.text);
          } else if (event.event === 'done') {
            return {
              ok: true,
              text: typeof data.text === 'string' ? data.text : '',
              // Forwarded so the runner bridge can tell a cap-truncated reply from model
              // non-compliance (TASK-20260812 AC3). Absent from older servers — omitted,
              // keeping today's shape exactly.
              ...(data.stopReason === 'max_tokens' || data.stopReason === 'end'
                ? { stopReason: data.stopReason }
                : {}),
            };
          } else if (event.event === 'error') {
            return {
              ok: false,
              code: typeof data.code === 'string' ? data.code : ERROR_CODES.HOST_ERROR,
              message: typeof data.message === 'string' ? data.message : 'server error',
              retryable: data.retryable === true,
            };
          }
          // artifact/unknown events are not transport concerns — ignored
        }
      } catch (err) {
        return isAbortError(err) || signal.aborted ? cancelledResult() : streamDroppedResult();
      }
      return streamDroppedResult(); // stream ended before a terminal done/error event
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
