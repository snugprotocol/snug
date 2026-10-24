// openai-responses.ts — the OpenAI Responses adapter that runs on the user's ChatGPT plan
// (TASK-20261023-siwc-chatgpt-plan D3/D5; ADR-0078 §3/§5). It holds no key: a `BearerSource`
// hands it a bearer per attempt, refreshes once when that attempt came back 401, and scrubs
// every error body before a message is formed. Reached ONLY via runAgentTurn. Browser-safe.
//
// What the measurements made load-bearing (task file, "Phase 1 — spike evidence"):
// - the route answers a 2xx stream with NO content-type header — a stream is decided by STATUS;
// - `max_output_tokens` is rejected, so the only output cap is a client-side ceiling;
// - the 401 body echoes the bearer it was sent, so 401/403 forward no provider prose at all.

import { ERROR_CODES } from '@snugprotocol/protocol';

import { CHATGPT_ERROR_CODES, type BearerResult, type BearerSource } from './bearer-source.js';
import {
  cancelledResult,
  chatgptErrorResult,
  httpErrorResult,
  isAbortError,
  networkErrorResult,
  redactThenCap,
  streamDroppedResult,
} from './errors.js';
import {
  applyResponsesEvent,
  buildResponsesBody,
  emptyStreamState,
  errorDetailOf,
  toolCallsOf,
  usageOf,
  wireModelOf,
  type ResponsesStreamState,
} from './responses-wire.js';
import { parseSse, tryParseJsonRecord } from './sse.js';
import type { AdapterError, AdapterRequest, AdapterResult, AgentAdapter, FetchLike } from './types.js';

/** Pinned: the plan route is OpenAI's public API base — never an option a caller could redirect. */
export const RESPONSES_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** Matches the Chat Completions sibling: an app build can emit a whole single-file app. */
export const RESPONSES_DEFAULT_MAX_TOKENS = 128_000;
/** Soft tokens→characters rule for the client-side ceiling; the route gives no server-side cap. */
const CHARS_PER_TOKEN = 4;

const USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';
const USAGE_UNAVAILABLE_CODE = 'subscription_sharing_usage_unavailable';

export interface OpenAiResponsesAdapterOptions {
  /** The session keeper's seam — a bearer per attempt, never a key (adapters cannot depend on auth). */
  bearer: BearerSource;
  model: string;
  /** A thinking level in OpenAI's own vocabulary; sent as `reasoning.effort` only when chosen (D6). */
  effort?: string;
  /** Output ceiling in tokens, enforced client-side (×4 characters) because the route rejects a server cap. */
  maxTokens?: number;
  /** Injectable for fixture-based tests — adapter tests never hit the network. */
  fetch?: FetchLike;
}

type Attempt = { kind: 'unauthorized' } | { kind: 'settled'; result: AdapterResult };

export function openaiResponsesAdapter(options: OpenAiResponsesAdapterOptions): AgentAdapter {
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const { bearer, model, effort } = options;
  const maxTokens = options.maxTokens ?? RESPONSES_DEFAULT_MAX_TOKENS;

  return {
    async complete(request: AdapterRequest): Promise<AdapterResult> {
      const { system, messages, tools, signal, onDelta, maxOutputTokens } = request;
      // The per-turn cap NARROWS the construction ceiling and can never widen it (ADR-0018 D4).
      const turnMaxTokens = maxOutputTokens === undefined ? maxTokens : Math.min(maxOutputTokens, maxTokens);
      const ceilingChars = turnMaxTokens * CHARS_PER_TOKEN;
      const body = JSON.stringify(buildResponsesBody({ model, system, messages, tools, effort }));

      // The adapter's OWN controller drives the fetch: the ceiling aborts it without touching
      // the caller's signal (a ceiling stop is a `max_tokens` result, never CANCELLED), and the
      // caller's abort is mirrored onto it. The bearer source never sees either signal — a
      // refresh in flight runs to completion so the keeper's rotation is never half-done (D4).
      const controller = new AbortController();
      const mirrorAbort = (): void => controller.abort();
      if (signal?.aborted === true) controller.abort();
      else signal?.addEventListener('abort', mirrorAbort, { once: true });

      const send = async (token: string): Promise<Attempt> => {
        if (controller.signal.aborted) return { kind: 'settled', result: cancelledResult() };
        let response: Response;
        try {
          response = await fetchImpl(`${RESPONSES_DEFAULT_BASE_URL}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body,
            signal: controller.signal,
          });
        } catch (err) {
          const result = isAbortError(err) || controller.signal.aborted ? cancelledResult() : networkErrorResult(err);
          return { kind: 'settled', result };
        }
        if (response.status === 401) return { kind: 'unauthorized' };
        if (!response.ok) return { kind: 'settled', result: await preStreamError(response, bearer) };
        return { kind: 'settled', result: await readStream(response) };
      };

      /** A 2xx is a stream — by status, never by header: the plan route sends no content-type. */
      const readStream = async (response: Response): Promise<AdapterResult> => {
        const state = emptyStreamState();
        let ceilingHit = false;
        try {
          for await (const event of parseSse(response.body)) {
            const data = tryParseJsonRecord(event.data);
            if (data === null) continue; // a malformed block never kills the stream
            const delta = applyResponsesEvent(state, data, event.event);
            if (delta !== undefined) onDelta?.(delta);
            // "Exceeds", not "reaches": output of exactly the ceiling completes normally. Every
            // output character counts — text AND function-call arguments (S6): a model writing
            // a megabyte of JSON into a tool call is the same runaway as one writing prose.
            if (state.outputChars > ceilingChars) {
              ceilingHit = true;
              controller.abort();
              break;
            }
            if (state.terminal !== undefined) break; // post-settle events are never read
          }
        } catch (err) {
          if (ceilingHit) return ceilingResult(state);
          if (isAbortError(err) || controller.signal.aborted) return cancelledResult();
          return withPartial(streamDroppedResult(), state.text);
        }
        return ceilingHit ? ceilingResult(state) : settle(state, bearer);
      };

      try {
        const first = await bearer.get();
        if (!first.ok) return bearerFailureResult(first);

        const attempt = await send(first.token);
        if (attempt.kind === 'settled') return attempt.result;

        // One forced refresh on the token that failed, then one retry — a second 401 is a
        // sign-in state, and its body (which echoes the bearer) is never read. The keeper is
        // told which bearer the route refused, so its status stops saying "signed in" (G5-C4).
        const refreshed = await bearer.refresh(first.token);
        if (!refreshed.ok) return bearerFailureResult(refreshed);
        const retry = await send(refreshed.token);
        if (retry.kind === 'settled') return retry.result;
        await invalidateQuietly(bearer, refreshed.token);
        return chatgptErrorResult(CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, false);
      } finally {
        signal?.removeEventListener('abort', mirrorAbort);
      }
    },
  };
}

/** The ceiling cut the reply: the same `max_tokens` contract a provider cap gives the bridge, with the partial text. */
function ceilingResult(state: ResponsesStreamState): AdapterResult {
  return { ok: true, text: state.text, toolCalls: toolCallsOf(state), stopReason: 'max_tokens' };
}

/** The terminal event decides the result; only `response.completed` is plain success. */
function settle(state: ResponsesStreamState, bearer: BearerSource): AdapterResult {
  const { terminal } = state;
  if (terminal === undefined) return withPartial(streamDroppedResult(), state.text);
  switch (terminal.kind) {
    case 'completed':
      return okResult(state, terminal.response, toolCallsOf(state).length > 0 ? 'tool_use' : 'end');
    case 'incomplete':
      return terminal.reason === 'max_output_tokens'
        ? okResult(state, terminal.response, 'max_tokens')
        : withPartial(hostError(`response incomplete: ${redactThenCap(terminal.reason, bearer.redact)}`), state.text);
    case 'failed': {
      if (terminal.code === USAGE_LIMIT_CODE) return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_LIMIT, false, state.text);
      if (terminal.code === USAGE_UNAVAILABLE_CODE) {
        return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, true, state.text);
      }
      const detail = [terminal.code, terminal.message].filter((part) => part !== '').join(': ');
      return withPartial(hostError(redactThenCap(detail === '' ? 'response failed' : detail, bearer.redact)), state.text);
    }
  }
}

function okResult(
  state: ResponsesStreamState,
  response: Record<string, unknown>,
  stopReason: 'end' | 'tool_use' | 'max_tokens',
): AdapterResult {
  const usage = usageOf(response);
  const wireModel = wireModelOf(response);
  return {
    ok: true,
    text: state.text,
    toolCalls: toolCallsOf(state),
    stopReason,
    ...(usage !== undefined ? { usage } : {}),
    ...(wireModel !== undefined ? { model: wireModel } : {}),
  };
}

/**
 * Pre-stream statuses (D3, AC6/AC7/AC10). 403/429/503 are named with their fixed sentences and
 * their bodies are never read; 400 and the rest carry the detail — after JSON extraction,
 * redacted, then capped. 401 is the caller's (one refresh, one retry).
 */
async function preStreamError(response: Response, bearer: BearerSource): Promise<AdapterError> {
  switch (response.status) {
    case 403:
      return chatgptErrorResult(CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED, false);
    case 429:
      return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_LIMIT, false);
    case 503:
      return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, true);
    default:
      return httpErrorResult(response.status, redactThenCap(errorDetailOf(await safeText(response)), bearer.redact));
  }
}

/**
 * The keeper could not produce a bearer: a NAMED result, never a fall-through to a key, a local
 * model or the demo brain (D5). Sign-in and consent are a person's acts, so those two are never
 * retryable whatever the keeper said; `refresh_not_ready` keeps the tokens and asks for patience;
 * a network failure is the keeper's network, not a sign-in.
 */
function bearerFailureResult(failure: Extract<BearerResult, { ok: false }>): AdapterError {
  switch (failure.code) {
    case 'sign_in_needed':
      return chatgptErrorResult(CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, false);
    case 'plan_not_granted':
      return chatgptErrorResult(CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED, false);
    case 'usage_unavailable':
      return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, failure.retryable);
    case 'refresh_not_ready':
      return chatgptErrorResult(CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, true);
    case 'network':
      return networkErrorResult(new Error('network request failed while reaching the ChatGPT session'));
  }
}

/** `bearer.invalidate`, when the source has one: awaited, and anything it throws — sync or async — stays with the keeper. */
async function invalidateQuietly(bearer: BearerSource, stale: string): Promise<void> {
  try {
    await bearer.invalidate?.(stale);
  } catch {
    // The named result the caller returns next is the user's news; the keeper's own failure is not.
  }
}

/** A HOST_ERROR whose message the caller has already redacted and capped. */
function hostError(message: string): AdapterError {
  return { ok: false, code: ERROR_CODES.HOST_ERROR, message, retryable: false };
}

function withPartial(error: AdapterError, text: string): AdapterError {
  return text !== '' ? { ...error, partialText: text } : error;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
