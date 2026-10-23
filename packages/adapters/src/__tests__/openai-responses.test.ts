// TASK-20261023-siwc-chatgpt-plan L2 — Gate 3 tests for the OpenAI Responses adapter that runs
// on the user's ChatGPT plan through a bearer, never a key (plan D3/D5, ADR-0078 §3/§5; AC4,
// AC6, AC7, AC10's adapter rows, AC12). Written FIRST: every test here is red until
// `src/openai-responses.ts` lands.
//
// What the measurements (task file, "Phase 1 — spike evidence") make load-bearing:
// - the plan route answers a 2xx stream with NO `content-type` header — a stream is decided by
//   status, never by the header (the spike's own first version failed exactly there);
// - `temperature`, `store:true`, `stream:false` are rejected 400 `{detail}` — and the docs list
//   more rejected parameters, each pinned absent below;
// - the 401 body ECHOES the bearer it was sent and talks about API keys — so 401/403 forward no
//   provider prose at all, and every other detail is redacted (the bearer of the attempt that
//   failed) BEFORE the 200-character cap, with a JWT-shape backstop from `packages/protocol`.
//
// The fake bearer source hands out named tokens, records every `get`/`refresh`, and implements
// `redact` as an exact-substring replace of the tokens it handed out — so a test can prove the
// adapter called `redact` (a token the JWT backstop would not recognise is still scrubbed).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CHATGPT_ERROR_CODES,
  CHATGPT_ERROR_SENTENCES,
  RESPONSES_DEFAULT_BASE_URL,
  RESPONSES_DEFAULT_MAX_TOKENS,
  STREAM_DROPPED_CODE,
  openaiResponsesAdapter,
  type AdapterMessage,
  type AdapterRequest,
  type AdapterResult,
  type BearerFailureCode,
  type BearerResult,
  type BearerSource,
  type ToolDef,
} from '../index.js';
import { abortErrorStream, block, fakeFetch, streamOf } from './helpers.js';

// ---------------------------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------------------------

/** Two bearers that are NOT JWT-shaped, so only `bearer.redact` — never the backstop — can scrub them. */
const TOKEN_A = 'SECRETBEARERalpha0123456789abcdefghijklmnopq';
const TOKEN_B = 'SECRETBEARERbravo9876543210zyxwvutsrqponmlkj';
const MODEL = 'gpt-6.1-sol';

const SENTENCE = {
  SIGN_IN_NEEDED: 'Sign in to ChatGPT to continue.',
  PLAN_NOT_GRANTED: "ChatGPT plan usage isn't allowed for Snug — allow it in Settings, or use a key or a local model.",
  USAGE_LIMIT: "Usage limit reached — Review your plan or this app's limit in ChatGPT settings.",
  USAGE_UNAVAILABLE: 'ChatGPT plan usage is unavailable right now — try again shortly.',
} as const;

interface FakeBearer extends BearerSource {
  readonly gets: number;
  /** Every `refresh` call's FULL argument list — a signal smuggled in would show here. */
  readonly refreshCalls: unknown[][];
  readonly handedOut: readonly string[];
}

/**
 * A bearer source over a fixed token sequence: `get()` answers the first, each successful
 * `refresh` the next. `getResult`/`refreshResult` override the answers.
 */
function fakeBearer(
  opts: {
    tokens?: string[];
    getResult?: BearerResult;
    refreshResult?: (stale: string) => BearerResult | Promise<BearerResult>;
  } = {},
): FakeBearer {
  const tokens = opts.tokens ?? [TOKEN_A, TOKEN_B];
  const handedOut: string[] = [];
  const refreshCalls: unknown[][] = [];
  let gets = 0;
  let next = 0;
  const hand = (): BearerResult => {
    const token = tokens[Math.min(next, tokens.length - 1)]!;
    next += 1;
    handedOut.push(token);
    return { ok: true, token };
  };
  return {
    get gets() {
      return gets;
    },
    refreshCalls,
    handedOut,
    async get() {
      gets += 1;
      return opts.getResult ?? hand();
    },
    async refresh(...args: unknown[]) {
      refreshCalls.push(args);
      if (opts.refreshResult !== undefined) {
        const result = await opts.refreshResult(args[0] as string);
        if (result.ok) handedOut.push(result.token);
        return result;
      }
      return hand();
    },
    redact(text: string) {
      let out = text;
      for (const token of handedOut) out = out.split(token).join('***');
      return out;
    },
  };
}

/** One SSE event in the Responses shape: the `event:` name and the JSON `type` agree, as on the wire. */
function ev(type: string, payload: Record<string, unknown> = {}): string {
  return block(type, JSON.stringify({ type, ...payload }));
}

const USAGE_WIRE = {
  input_tokens: 35,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: 7 },
  output_tokens: 95,
  output_tokens_details: { reasoning_tokens: 80 },
  total_tokens: 130,
};

const created = ev('response.created', { sequence_number: 0, response: { id: 'resp_1', status: 'in_progress', model: MODEL, output: [] } });
const messageAdded = (outputIndex = 0) =>
  ev('response.output_item.added', {
    output_index: outputIndex,
    item: { id: `msg_${outputIndex}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
  });
const textDelta = (delta: string, outputIndex = 0) =>
  ev('response.output_text.delta', { output_index: outputIndex, content_index: 0, item_id: `msg_${outputIndex}`, delta });
const completed = (usage: Record<string, unknown> | undefined = USAGE_WIRE, model = MODEL) =>
  ev('response.completed', {
    response: { id: 'resp_1', status: 'completed', model, output: [], ...(usage !== undefined ? { usage } : {}) },
  });
const fnAdded = (outputIndex: number, callId: string, name: string) =>
  ev('response.output_item.added', {
    output_index: outputIndex,
    item: { id: `fc_${outputIndex}`, type: 'function_call', status: 'in_progress', arguments: '', call_id: callId, name },
  });
const argsDelta = (outputIndex: number, delta: string) =>
  ev('response.function_call_arguments.delta', { output_index: outputIndex, item_id: `fc_${outputIndex}`, delta });
const argsDone = (outputIndex: number, args: string) =>
  ev('response.function_call_arguments.done', { output_index: outputIndex, item_id: `fc_${outputIndex}`, arguments: args });
const failed = (code: string, message: string) =>
  ev('response.failed', { response: { id: 'resp_1', status: 'failed', model: MODEL, error: { code, message } } });
const incomplete = (reason: string) =>
  ev('response.incomplete', {
    response: { id: 'resp_1', status: 'incomplete', model: MODEL, incomplete_details: { reason }, usage: USAGE_WIRE },
  });

const TEXT_STREAM = created + messageAdded() + textDelta('Hello') + textDelta(', world') + completed();

/** A 2xx exactly as the plan route sends it: a body and NO headers at all (AC12). */
function bareStream(body: string | string[], status = 200): Response {
  return new Response(streamOf(...(Array.isArray(body) ? body : [body])), { status });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The measured 401 shape: it echoes the bearer it was sent and talks about API keys. */
function echoing401(token: string, code = 'invalid_api_key'): Response {
  return jsonResponse(401, {
    error: {
      code,
      message: `Incorrect API key provided: ${token}. You can find your API key at https://platform.openai.com/account/api-keys.`,
      type: 'invalid_request_error',
    },
  });
}

const WEATHER_TOOL: ToolDef = {
  name: 'get_weather',
  description: 'Current weather for a city.',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

const USER_ONLY: AdapterMessage[] = [{ role: 'user', content: 'Say hello.' }];

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

function build(
  factory: (url: string, init: RequestInit) => Response | Promise<Response>,
  opts: { bearer?: FakeBearer; effort?: string; maxTokens?: number; model?: string } = {},
) {
  const bearer = opts.bearer ?? fakeBearer();
  const { calls, fetchImpl } = fakeFetch(factory);
  const adapter = openaiResponsesAdapter({
    bearer,
    model: opts.model ?? MODEL,
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    fetch: fetchImpl,
  });
  return { adapter, bearer, calls };
}

async function run(
  factory: (url: string, init: RequestInit) => Response | Promise<Response>,
  request: Partial<AdapterRequest> = {},
  opts: Parameters<typeof build>[1] = {},
) {
  const built = build(factory, opts);
  const deltas: string[] = [];
  const result: AdapterResult = await built.adapter.complete({
    system: 'You are terse.',
    messages: USER_ONLY,
    onDelta: (d: string) => deltas.push(d),
    ...request,
  });
  return { ...built, result, deltas };
}

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

describe('openai-responses exports', () => {
  it('pins the API base to https://api.openai.com/v1', () => {
    expect(RESPONSES_DEFAULT_BASE_URL).toBe('https://api.openai.com/v1');
  });

  it('the default output ceiling matches the Chat Completions sibling (128 000 tokens)', () => {
    expect(RESPONSES_DEFAULT_MAX_TOKENS).toBe(128_000);
  });

  it('maps each CHATGPT_* code to its one fixed, actionable sentence', () => {
    expect(CHATGPT_ERROR_SENTENCES).toEqual({
      [CHATGPT_ERROR_CODES.SIGN_IN_NEEDED]: SENTENCE.SIGN_IN_NEEDED,
      [CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED]: SENTENCE.PLAN_NOT_GRANTED,
      [CHATGPT_ERROR_CODES.USAGE_LIMIT]: SENTENCE.USAGE_LIMIT,
      [CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE]: SENTENCE.USAGE_UNAVAILABLE,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Request shape (AC4)
// ---------------------------------------------------------------------------------------------

describe('request shape (AC4)', () => {
  it('POSTs to exactly ${RESPONSES_DEFAULT_BASE_URL}/responses with the bearer from get() and a JSON content type', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.url).toBe(`${RESPONSES_DEFAULT_BASE_URL}/responses`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(headerOf(calls[0]!.init, 'authorization')).toBe(`Bearer ${TOKEN_A}`);
    expect(headerOf(calls[0]!.init, 'content-type')).toBe('application/json');
  });

  it('the base is pinned — a smuggled baseUrl option is not honoured', async () => {
    const bearer = fakeBearer();
    const { calls, fetchImpl } = fakeFetch(() => bareStream(TEXT_STREAM));
    const options = { bearer, model: MODEL, fetch: fetchImpl, baseUrl: 'https://evil.example/v1' };
    const adapter = openaiResponsesAdapter(options as unknown as Parameters<typeof openaiResponsesAdapter>[0]);
    await adapter.complete({ system: 's', messages: USER_ONLY });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
  });

  it('a minimal turn sends EXACTLY { model, instructions, input, store:false, stream:true }', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { system: 'SYS', messages: USER_ONLY });
    expect(calls[0]!.bodyJson).toEqual({
      model: MODEL,
      instructions: 'SYS',
      input: [{ role: 'user', content: 'Say hello.' }],
      store: false,
      stream: true,
    });
  });

  it('with tools and an effort, adds ONLY top-level function tools and reasoning.effort', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { system: 'SYS', tools: [WEATHER_TOOL] }, { effort: 'high' });
    expect(calls[0]!.bodyJson).toEqual({
      model: MODEL,
      instructions: 'SYS',
      input: [{ role: 'user', content: 'Say hello.' }],
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Current weather for a city.',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      ],
      reasoning: { effort: 'high' },
      store: false,
      stream: true,
    });
  });

  it('sends the model given at construction', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), {}, { model: 'gpt-5.1-codex' });
    expect(calls[0]!.bodyJson.model).toBe('gpt-5.1-codex');
  });

  it('omits `tools` when the request offers an empty tool list', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { tools: [] });
    expect(calls[0]!.bodyJson).not.toHaveProperty('tools');
  });

  it('omits `reasoning` entirely when no effort was given', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { tools: [WEATHER_TOOL] });
    expect(calls[0]!.bodyJson).not.toHaveProperty('reasoning');
  });

  it('`store` is the boolean false (not absent) and `stream` the boolean true (not absent)', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM));
    expect(Object.prototype.hasOwnProperty.call(calls[0]!.bodyJson, 'store')).toBe(true);
    expect(calls[0]!.bodyJson.store).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(calls[0]!.bodyJson, 'stream')).toBe(true);
    expect(calls[0]!.bodyJson.stream).toBe(true);
  });

  it('maps the whole conversation into input items: user, assistant text, function_call, function_call_output', async () => {
    const messages: AdapterMessage[] = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! Checking.', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Olden' } }] },
      { role: 'tool', toolCallId: 'call_1', content: '14°C, rain' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_2', name: 'get_weather', input: { city: 'Bergen' } },
          { id: 'call_3', name: 'get_weather', input: { city: 'Oslo', units: 'c' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_2', content: '9°C' },
      { role: 'tool', toolCallId: 'call_3', content: '{"t":11}' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Thanks' },
    ];
    const { calls } = await run(() => bareStream(TEXT_STREAM), { messages, tools: [WEATHER_TOOL] });
    expect(calls[0]!.bodyJson.input).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! Checking.' },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Olden"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '14°C, rain' },
      // the empty assistant text is omitted when the turn carried tool calls
      { type: 'function_call', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"Bergen"}' },
      { type: 'function_call', call_id: 'call_3', name: 'get_weather', arguments: '{"city":"Oslo","units":"c"}' },
      { type: 'function_call_output', call_id: 'call_2', output: '9°C' },
      { type: 'function_call_output', call_id: 'call_3', output: '{"t":11}' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Thanks' },
    ]);
  });

  it('the system prompt rides `instructions` and never becomes a system-role input item', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { system: 'You are the builder.' });
    expect(calls[0]!.bodyJson.instructions).toBe('You are the builder.');
    const input = calls[0]!.bodyJson.input as Record<string, unknown>[];
    expect(input.some((item) => item.role === 'system' || item.role === 'developer')).toBe(false);
    expect(JSON.stringify(input)).not.toContain('You are the builder.');
  });

  it('request.cache is ignored — no cache field anywhere in the body', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { cache: true, tools: [WEATHER_TOOL] });
    expect(JSON.stringify(calls[0]!.bodyJson)).not.toMatch(/cache/i);
  });

  it('request.maxOutputTokens NEVER becomes max_output_tokens (the route rejects it; the ceiling is client-side)', async () => {
    const { calls } = await run(() => bareStream(TEXT_STREAM), { maxOutputTokens: 512 }, { maxTokens: 4096 });
    expect(calls[0]!.bodyJson).not.toHaveProperty('max_output_tokens');
    expect(JSON.stringify(calls[0]!.bodyJson)).not.toContain('512');
    expect(JSON.stringify(calls[0]!.bodyJson)).not.toContain('4096');
  });

  // One negative per rejected parameter (AC4) — on the fullest request the adapter can be asked
  // to build (tools, effort, cache, a per-turn cap, a tool round trip in the history).
  const REJECTED = [
    'temperature',
    'top_p',
    'max_output_tokens',
    'max_tool_calls',
    'metadata',
    'user',
    'truncation',
    'previous_response_id',
    'background',
    'conversation',
    'moderation',
    'multi_agent',
    'prompt',
    'prompt_cache_retention',
    'safety_identifier',
    'top_logprobs',
  ] as const;

  it.each(REJECTED)('never sends the rejected parameter `%s`', async (param) => {
    const messages: AdapterMessage[] = [
      { role: 'user', content: 'Weather?' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'get_weather', input: { city: 'Olden' } }] },
      { role: 'tool', toolCallId: 'call_1', content: 'rain' },
    ];
    const { calls } = await run(
      () => bareStream(TEXT_STREAM),
      { messages, tools: [WEATHER_TOOL], cache: true, maxOutputTokens: 256 },
      { effort: 'high', maxTokens: 1000 },
    );
    expect(calls[0]!.bodyJson).not.toHaveProperty(param);
  });
});

// ---------------------------------------------------------------------------------------------
// Stream parsing (AC12, D3)
// ---------------------------------------------------------------------------------------------

describe('stream parsing (AC12)', () => {
  it('parses a 2xx with NO content-type header as SSE (the measured plan route)', async () => {
    const response = bareStream(TEXT_STREAM);
    expect(response.headers.get('content-type')).toBeNull(); // precondition: truly header-less
    const { result, deltas } = await run(() => response);
    expect(result).toEqual({
      ok: true,
      text: 'Hello, world',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 35, outputTokens: 95, cacheReadTokens: 7, cacheCreationTokens: 0 },
      model: MODEL,
    });
    expect(deltas).toEqual(['Hello', ', world']);
  });

  it('parses the same stream when it IS labelled text/event-stream', async () => {
    const { result } = await run(
      () => new Response(streamOf(TEXT_STREAM), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(result).toMatchObject({ ok: true, text: 'Hello, world', stopReason: 'end' });
  });

  it('streams each output_text.delta through onDelta in order, and the final text is their concatenation', async () => {
    const parts = ['a', 'bc', ' ', 'déf', '😀', '"quoted"\n'];
    const { result, deltas } = await run(() => bareStream(created + messageAdded() + parts.map((p) => textDelta(p)).join('') + completed()));
    expect(deltas).toEqual(parts);
    expect(result).toMatchObject({ ok: true, text: parts.join('') });
  });

  it('reports the model the wire answered with (response.completed.response.model), not the configured id', async () => {
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('x') + completed(USAGE_WIRE, 'gpt-6.1-sol-2026-10-01')), {}, {
      model: 'gpt-6.1-sol',
    });
    expect(result).toMatchObject({ ok: true, model: 'gpt-6.1-sol-2026-10-01' });
  });

  it('usage maps input/output/cached/cache-write tokens — the recorded wire DOES report `cache_write_tokens`, so it is mapped (even when 0), never coerced', async () => {
    // Conductor's fold (2026-10-23): the brief said "cacheCreationTokens absent" on the assumption the
    // route reported nothing about cache writes; the recorded `response.completed` carries
    // `input_tokens_details.cache_write_tokens`, and TokenUsage's rule is "absent only when the provider
    // said nothing" — a reported 0 is a fact ("cached 0%"), so it rides through.
    const { result } = await run(() => bareStream(TEXT_STREAM));
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.usage).toEqual({ inputTokens: 35, outputTokens: 95, cacheReadTokens: 7, cacheCreationTokens: 0 });
  });

  it('a usage block with no input_tokens_details leaves cacheReadTokens ABSENT, not 0', async () => {
    const { result } = await run(() =>
      bareStream(created + messageAdded() + textDelta('x') + completed({ input_tokens: 3, output_tokens: 1, total_tokens: 4 })),
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 1 });
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
  });

  it('ignores response.metadata — even one carrying a delta-looking field', async () => {
    const metadata = ev('response.metadata', {
      response_id: 'resp_1',
      delta: 'LEAKED-METADATA',
      metadata: { openai_chatgpt_moderation_metadata: { prompt: { flagged: false } } },
    });
    const { result, deltas } = await run(() =>
      bareStream(created + messageAdded() + textDelta('Hi') + metadata + textDelta('!') + completed()),
    );
    expect(result).toMatchObject({ ok: true, text: 'Hi!', stopReason: 'end' });
    expect(deltas.join('')).not.toContain('LEAKED');
  });

  it('ignores unknown event types, done/part events, heartbeats and a malformed block', async () => {
    const noise =
      ev('response.brand_new_event', { delta: 'NOPE', output_index: 0 }) +
      ': keep-alive\n\n' +
      'event: response.output_text.delta\ndata: {not json\n\n' +
      ev('response.content_part.added', { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) +
      ev('response.output_text.done', { output_index: 0, content_index: 0, text: 'Hello, world' });
    const { result, deltas } = await run(() =>
      bareStream(created + messageAdded() + textDelta('Hello') + noise + textDelta(', world') + completed()),
    );
    expect(result).toMatchObject({ ok: true, text: 'Hello, world', toolCalls: [], stopReason: 'end' });
    expect(deltas).toEqual(['Hello', ', world']);
  });

  it('assembles a function call from output_item.added + arguments deltas + .done → stopReason tool_use', async () => {
    const stream =
      created +
      fnAdded(0, 'call_abc', 'get_weather') +
      argsDelta(0, '{"ci') +
      argsDelta(0, 'ty":"Ol') +
      argsDelta(0, 'den"}') +
      argsDone(0, '{"city":"Olden"}') +
      completed();
    const { result } = await run(() => bareStream(stream), { tools: [WEATHER_TOOL] });
    expect(result).toMatchObject({
      ok: true,
      text: '',
      toolCalls: [{ id: 'call_abc', name: 'get_weather', input: { city: 'Olden' } }],
      stopReason: 'tool_use',
    });
  });

  it('orders several function calls by output_index, with interleaved argument deltas kept apart', async () => {
    const stream =
      created +
      fnAdded(2, 'call_two', 'get_weather') +
      fnAdded(1, 'call_one', 'get_weather') +
      argsDelta(2, '{"city":') +
      argsDelta(1, '{"city":') +
      argsDelta(1, '"Oslo"}') +
      argsDelta(2, '"Bergen"}') +
      argsDone(1, '{"city":"Oslo"}') +
      argsDone(2, '{"city":"Bergen"}') +
      completed();
    const { result } = await run(() => bareStream(stream), { tools: [WEATHER_TOOL] });
    expect(result).toMatchObject({
      ok: true,
      toolCalls: [
        { id: 'call_one', name: 'get_weather', input: { city: 'Oslo' } },
        { id: 'call_two', name: 'get_weather', input: { city: 'Bergen' } },
      ],
      stopReason: 'tool_use',
    });
  });

  it('the .done event’s `arguments` is authoritative over the accumulated deltas', async () => {
    const stream =
      created + fnAdded(0, 'call_x', 'get_weather') + argsDelta(0, '{"city":"Ol') + argsDone(0, '{"city":"Olden"}') + completed();
    const { result } = await run(() => bareStream(stream), { tools: [WEATHER_TOOL] });
    expect(result).toMatchObject({ ok: true, toolCalls: [{ id: 'call_x', name: 'get_weather', input: { city: 'Olden' } }] });
  });

  it('text and a function call in one response: both kept, stopReason tool_use', async () => {
    const stream =
      created +
      messageAdded(0) +
      textDelta('Checking the weather.', 0) +
      fnAdded(1, 'call_w', 'get_weather') +
      argsDone(1, '{"city":"Olden"}') +
      completed();
    const { result } = await run(() => bareStream(stream), { tools: [WEATHER_TOOL] });
    expect(result).toMatchObject({
      ok: true,
      text: 'Checking the weather.',
      toolCalls: [{ id: 'call_w', name: 'get_weather', input: { city: 'Olden' } }],
      stopReason: 'tool_use',
    });
  });

  it('a non-function output item (reasoning) never becomes a tool call', async () => {
    const reasoning = ev('response.output_item.added', {
      output_index: 0,
      item: { id: 'rs_1', type: 'reasoning', content: [], encrypted_content: 'gAAAA', call_id: 'not_a_call', name: 'nope' },
    });
    const { result } = await run(() => bareStream(created + reasoning + messageAdded(1) + textDelta('ok', 1) + completed()));
    expect(result).toMatchObject({ ok: true, text: 'ok', toolCalls: [], stopReason: 'end' });
  });

  it('response.incomplete with reason max_output_tokens → ok, stopReason max_tokens, the partial text kept', async () => {
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('Once upon a ') + incomplete('max_output_tokens')));
    expect(result).toMatchObject({ ok: true, text: 'Once upon a ', toolCalls: [], stopReason: 'max_tokens' });
  });

  it('response.incomplete for any other reason → HOST_ERROR naming the reason, partial text kept', async () => {
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('Once') + incomplete('content_filter')));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', partialText: 'Once' });
    if (result.ok) return;
    expect(result.message).toContain('content_filter');
  });

  it('response.failed with subscription_sharing_usage_limit_exceeded → CHATGPT_USAGE_LIMIT, fixed sentence, not retryable, partial kept', async () => {
    const { result } = await run(() =>
      bareStream(
        created + messageAdded() + textDelta('Partial ') + failed('subscription_sharing_usage_limit_exceeded', `limit for ${TOKEN_A}`),
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: CHATGPT_ERROR_CODES.USAGE_LIMIT,
      message: SENTENCE.USAGE_LIMIT,
      retryable: false,
      partialText: 'Partial ',
    });
  });

  it('response.failed with subscription_sharing_usage_unavailable → CHATGPT_USAGE_UNAVAILABLE, retryable', async () => {
    const { result } = await run(() =>
      bareStream(created + messageAdded() + textDelta('P') + failed('subscription_sharing_usage_unavailable', 'try later')),
    );
    expect(result).toEqual({
      ok: false,
      code: CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE,
      message: SENTENCE.USAGE_UNAVAILABLE,
      retryable: true,
      partialText: 'P',
    });
  });

  it('response.failed with any other code → HOST_ERROR carrying the message, the bearer redacted', async () => {
    const { result } = await run(() =>
      bareStream(created + messageAdded() + textDelta('P') + failed('server_error', `The model crashed while serving ${TOKEN_A}.`)),
    );
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', partialText: 'P' });
    if (result.ok) return;
    expect(result.message).toContain('The model crashed while serving');
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('response.failed messages are redacted THEN capped: an echoed bearer straddling the 200th character is fully gone', async () => {
    const lead = 'The model crashed. ';
    const pad = 'x'.repeat(190 - lead.length);
    const message = `${lead}${pad}${TOKEN_A} and then a long tail that the cap must cut ${'y'.repeat(300)}`;
    expect(message.indexOf(TOKEN_A)).toBe(190); // starts before 200, ends after it
    const { result } = await run(() => bareStream(created + failed('server_error', message)));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    expect(JSON.stringify(result)).not.toContain('SECRETBEAR');
    if (result.ok) return;
    expect(result.message).toContain(lead.trim());
    expect(result.message).not.toContain('y'.repeat(50)); // the cap applied
  });

  it('an `error` event with the usage-limit code → CHATGPT_USAGE_LIMIT with the fixed sentence', async () => {
    const error = ev('error', { code: 'subscription_sharing_usage_limit_exceeded', message: 'You hit your limit.', param: null });
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('So far') + error));
    expect(result).toEqual({
      ok: false,
      code: CHATGPT_ERROR_CODES.USAGE_LIMIT,
      message: SENTENCE.USAGE_LIMIT,
      retryable: false,
      partialText: 'So far',
    });
  });

  it('an `error` event with the usage-unavailable code → CHATGPT_USAGE_UNAVAILABLE, retryable', async () => {
    const error = ev('error', { code: 'subscription_sharing_usage_unavailable', message: 'Busy.', param: null });
    const { result } = await run(() => bareStream(created + error));
    expect(result).toMatchObject({
      ok: false,
      code: CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE,
      message: SENTENCE.USAGE_UNAVAILABLE,
      retryable: true,
    });
  });

  it('an `error` event with another code → HOST_ERROR carrying its message, the bearer redacted', async () => {
    const error = ev('error', { code: 'server_error', message: `Something broke near ${TOKEN_A}`, param: null });
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('So far') + error));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', partialText: 'So far' });
    if (result.ok) return;
    expect(result.message).toContain('Something broke near');
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('a stream that ends without a terminal event → STREAM_DROPPED, retryable, with the partial text', async () => {
    const { result } = await run(() => bareStream(created + messageAdded() + textDelta('Half a sent')));
    expect(result).toEqual({
      ok: false,
      code: STREAM_DROPPED_CODE,
      message: expect.any(String) as unknown as string,
      retryable: true,
      partialText: 'Half a sent',
    });
  });

  it('a stream whose connection errors mid-reply → STREAM_DROPPED with the partial text', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    // Pull-driven, so the bytes are READ before the connection dies (erroring in `start` would
    // discard the queued chunk and test nothing).
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(created + messageAdded() + textDelta('Before the drop')));
        else controller.error(new TypeError('network connection lost'));
      },
    });
    const { result } = await run(() => new Response(body, { status: 200 }));
    expect(result).toMatchObject({ ok: false, code: STREAM_DROPPED_CODE, retryable: true, partialText: 'Before the drop' });
  });

  it('only response.completed is success — response.created/in_progress alone is a dropped stream', async () => {
    const inProgress = ev('response.in_progress', { response: { id: 'resp_1', status: 'in_progress', model: MODEL } });
    const { result } = await run(() => bareStream(created + inProgress));
    expect(result).toMatchObject({ ok: false, code: STREAM_DROPPED_CODE });
  });
});

// ---------------------------------------------------------------------------------------------
// Client-side output ceiling (AC12, D3) — the only cap while max_output_tokens is rejected
// ---------------------------------------------------------------------------------------------

describe('client-side output ceiling (AC12)', () => {
  /**
   * A body that delivers `chunks` and then stays OPEN until the fetch signal aborts — so the
   * only way the turn can end is the adapter aborting its own fetch.
   */
  function openUntilAborted(init: RequestInit, chunks: string[]): Response {
    return new Response(abortErrorStream(init.signal, ...chunks), { status: 200 });
  }

  const TEN = '0123456789';

  it('aborts the fetch once output passes maxTokens × 4 chars and answers ok + max_tokens + the partial text', async () => {
    const chunks = [created, messageAdded(), ...Array.from({ length: 10 }, () => textDelta(TEN))];
    const { result, calls, deltas } = await run((_url, init) => openUntilAborted(init, chunks), {}, { maxTokens: 10 });
    expect(calls[0]!.init.signal).toBeDefined();
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(result).toMatchObject({ ok: true, toolCalls: [], stopReason: 'max_tokens' });
    if (!result.ok) return;
    expect(result.text.length).toBeGreaterThan(40);
    expect(result.text.length).toBeLessThan(100);
    expect(TEN.repeat(10).startsWith(result.text)).toBe(true);
    expect(deltas.join('')).toBe(result.text);
  }, 5_000);

  it('output of EXACTLY the ceiling is not cut (the rule is "exceeds")', async () => {
    const { result } = await run(
      () => bareStream([created, messageAdded(), ...Array.from({ length: 4 }, () => textDelta(TEN)), completed()]),
      {},
      { maxTokens: 10 },
    );
    expect(result).toMatchObject({ ok: true, text: TEN.repeat(4), stopReason: 'end' });
  });

  it('request.maxOutputTokens NARROWS the ceiling', async () => {
    const chunks = [created, messageAdded(), ...Array.from({ length: 10 }, () => textDelta(TEN))];
    const { result } = await run((_url, init) => openUntilAborted(init, chunks), { maxOutputTokens: 10 }, { maxTokens: 1_000 });
    expect(result).toMatchObject({ ok: true, stopReason: 'max_tokens' });
    if (!result.ok) return;
    expect(result.text.length).toBeGreaterThan(40);
    expect(result.text.length).toBeLessThan(100);
  }, 5_000);

  it('request.maxOutputTokens never RAISES the ceiling (clamped to the construction value)', async () => {
    const chunks = [created, messageAdded(), ...Array.from({ length: 10 }, () => textDelta(TEN))];
    const { result } = await run((_url, init) => openUntilAborted(init, chunks), { maxOutputTokens: 1_000 }, { maxTokens: 10 });
    expect(result).toMatchObject({ ok: true, stopReason: 'max_tokens' });
    if (!result.ok) return;
    expect(result.text.length).toBeLessThan(100);
  }, 5_000);

  it('with no maxTokens, the default ceiling is RESPONSES_DEFAULT_MAX_TOKENS (128 000) × 4 chars', async () => {
    const limit = 128_000 * 4; // literal on purpose: the export test pins the constant, this pins the behaviour
    // exactly at the ceiling completes normally …
    const atLimit = await run(() => bareStream([created, messageAdded(), textDelta('a'.repeat(limit)), completed()]));
    expect(atLimit.result).toMatchObject({ ok: true, stopReason: 'end' });
    // … one character past it is cut client-side.
    const past = await run((_url, init) => openUntilAborted(init, [created, messageAdded(), textDelta('a'.repeat(limit)), textDelta('bb')]));
    expect(past.result).toMatchObject({ ok: true, stopReason: 'max_tokens' });
    expect(past.calls[0]!.init.signal!.aborted).toBe(true);
  }, 10_000);

  it('the ceiling abort never aborts the CALLER’s signal, and is not reported as CANCELLED', async () => {
    const caller = new AbortController();
    const chunks = [created, messageAdded(), ...Array.from({ length: 10 }, () => textDelta(TEN))];
    const { result } = await run((_url, init) => openUntilAborted(init, chunks), { signal: caller.signal }, { maxTokens: 10 });
    expect(caller.signal.aborted).toBe(false);
    expect(result).toMatchObject({ ok: true, stopReason: 'max_tokens' });
  }, 5_000);
});

// ---------------------------------------------------------------------------------------------
// Pre-stream HTTP errors, the 401 refresh flow, redaction (D3, AC6, AC7, AC10)
// ---------------------------------------------------------------------------------------------

describe('401 → one refresh → one retry (AC6)', () => {
  it('a 401 calls bearer.refresh ONCE with the token that failed, then retries ONCE with the new bearer', async () => {
    let n = 0;
    const { result, bearer, calls } = await run(() => (n++ === 0 ? echoing401(TOKEN_A) : bareStream(TEXT_STREAM)));
    expect(bearer.refreshCalls).toEqual([[TOKEN_A]]);
    expect(calls).toHaveLength(2);
    expect(headerOf(calls[0]!.init, 'authorization')).toBe(`Bearer ${TOKEN_A}`);
    expect(headerOf(calls[1]!.init, 'authorization')).toBe(`Bearer ${TOKEN_B}`);
    expect(calls[1]!.bodyJson).toEqual(calls[0]!.bodyJson);
    expect(result).toMatchObject({ ok: true, text: 'Hello, world', stopReason: 'end' });
  });

  it.each(['invalid_api_key', 'subscription_sharing_invalid_user'])(
    'a second 401 (%s) → CHATGPT_SIGN_IN_NEEDED with the fixed sentence; neither bearer appears anywhere',
    async (code) => {
      let n = 0;
      // The second 401 echoes a DIFFERENT token — the one the retry sent.
      const { result, bearer, calls } = await run(() => (n++ === 0 ? echoing401(TOKEN_A, code) : echoing401(TOKEN_B, code)));
      expect(result).toEqual({
        ok: false,
        code: CHATGPT_ERROR_CODES.SIGN_IN_NEEDED,
        message: SENTENCE.SIGN_IN_NEEDED,
        retryable: false,
      });
      expect(bearer.refreshCalls).toHaveLength(1);
      expect(calls).toHaveLength(2);
      const all = JSON.stringify(result);
      expect(all).not.toContain(TOKEN_A);
      expect(all).not.toContain(TOKEN_B);
      expect(all).not.toContain('SECRETBEARER');
      expect(all).not.toMatch(/api key/i); // no provider prose at all
    },
  );

  it('refresh answering sign_in_needed → CHATGPT_SIGN_IN_NEEDED, no retry, no body prose', async () => {
    const bearer = fakeBearer({ refreshResult: () => ({ ok: false, code: 'sign_in_needed', retryable: false }) });
    const { result, calls } = await run(() => echoing401(TOKEN_A), {}, { bearer });
    expect(result).toEqual({ ok: false, code: CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, message: SENTENCE.SIGN_IN_NEEDED, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['plan_not_granted', false, CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED, SENTENCE.PLAN_NOT_GRANTED],
    ['usage_unavailable', true, CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, SENTENCE.USAGE_UNAVAILABLE],
  ] as const)('refresh answering %s → the matching code and sentence, retryable taken from the result', async (code, retryable, mapped, sentence) => {
    const bearer = fakeBearer({ refreshResult: () => ({ ok: false, code, retryable }) });
    const { result, calls } = await run(() => echoing401(TOKEN_A), {}, { bearer });
    expect(result).toEqual({ ok: false, code: mapped, message: sentence, retryable });
    expect(calls).toHaveLength(1);
  });

  it('refresh answering network → NETWORK_ERROR, retryable (tokens are the keeper’s; never a sign-in)', async () => {
    const bearer = fakeBearer({ refreshResult: () => ({ ok: false, code: 'network', retryable: true }) });
    const { result } = await run(() => echoing401(TOKEN_A), {}, { bearer });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('refresh answering refresh_not_ready → a retryable result that is NOT sign-in-needed', async () => {
    const bearer = fakeBearer({ refreshResult: () => ({ ok: false, code: 'refresh_not_ready', retryable: true }) });
    const { result } = await run(() => echoing401(TOKEN_A), {}, { bearer });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).not.toBe(CHATGPT_ERROR_CODES.SIGN_IN_NEEDED);
    expect(result.retryable).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('the turn’s abort never reaches a bearer refresh in flight; the turn answers CANCELLED', async () => {
    const controller = new AbortController();
    let refreshSettled = false;
    const bearer = fakeBearer({
      refreshResult: async () => {
        controller.abort(); // the user stops the turn WHILE the refresh is in flight
        await new Promise((resolve) => setTimeout(resolve, 5));
        refreshSettled = true; // … and the refresh still runs to completion
        return { ok: true, token: TOKEN_B };
      },
    });
    const { result, calls } = await run(
      (_url, init) => {
        if (init.signal?.aborted === true) throw new DOMException('The operation was aborted.', 'AbortError');
        return echoing401(TOKEN_A);
      },
      { signal: controller.signal },
      { bearer },
    );
    expect(bearer.refreshCalls).toHaveLength(1);
    // the seam takes the stale token only — no AbortSignal is handed to the keeper
    expect(bearer.refreshCalls[0]).toEqual([TOKEN_A]);
    expect(bearer.refreshCalls[0]!.some((arg) => arg instanceof AbortSignal)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refreshSettled).toBe(true);
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
    // no request after the abort ever carried the refreshed bearer out
    for (const call of calls.slice(1)) expect(call.init.signal?.aborted).toBe(true);
  });
});

describe('bearer.get() failures — a named result and NO fetch (D5)', () => {
  it.each([
    ['sign_in_needed', false, CHATGPT_ERROR_CODES.SIGN_IN_NEEDED, SENTENCE.SIGN_IN_NEEDED],
    ['plan_not_granted', false, CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED, SENTENCE.PLAN_NOT_GRANTED],
    ['usage_unavailable', true, CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE, SENTENCE.USAGE_UNAVAILABLE],
  ] as const)('get() answering %s → %s with its sentence, nothing sent', async (code, retryable, mapped, sentence) => {
    const bearer = fakeBearer({ getResult: { ok: false, code, retryable } });
    const { result, calls } = await run(() => bareStream(TEXT_STREAM), {}, { bearer });
    expect(result).toEqual({ ok: false, code: mapped, message: sentence, retryable });
    expect(calls).toHaveLength(0);
    expect(bearer.refreshCalls).toHaveLength(0);
  });

  it('get() answering network → NETWORK_ERROR retryable, nothing sent', async () => {
    const bearer = fakeBearer({ getResult: { ok: false, code: 'network', retryable: true } });
    const { result, calls } = await run(() => bareStream(TEXT_STREAM), {}, { bearer });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
    expect(calls).toHaveLength(0);
  });

  it('every BearerFailureCode yields a result — none throws, none reaches the network', async () => {
    const codes: BearerFailureCode[] = ['sign_in_needed', 'plan_not_granted', 'usage_unavailable', 'network', 'refresh_not_ready'];
    for (const code of codes) {
      const bearer = fakeBearer({ getResult: { ok: false, code, retryable: code !== 'sign_in_needed' && code !== 'plan_not_granted' } });
      const { result, calls } = await run(() => bareStream(TEXT_STREAM), {}, { bearer });
      expect(result.ok, code).toBe(false);
      expect(calls, code).toHaveLength(0);
    }
  });
});

describe('pre-stream HTTP statuses (D3, AC7, AC10)', () => {
  it('403 → CHATGPT_PLAN_NOT_GRANTED, fixed sentence, not retryable, no body text, no refresh', async () => {
    const body = { error: { code: 'subscription_sharing_not_allowed', message: `Plan usage disabled for ${TOKEN_A} — see your api key settings` } };
    const { result, bearer } = await run(() => jsonResponse(403, body));
    expect(result).toEqual({ ok: false, code: CHATGPT_ERROR_CODES.PLAN_NOT_GRANTED, message: SENTENCE.PLAN_NOT_GRANTED, retryable: false });
    expect(JSON.stringify(result)).not.toContain('Plan usage disabled');
    expect(bearer.refreshCalls).toHaveLength(0);
  });

  it('429 → CHATGPT_USAGE_LIMIT with the fixed sentence, not retryable', async () => {
    const { result, bearer } = await run(() =>
      jsonResponse(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: `limit hit (${TOKEN_A})` } }),
    );
    expect(result).toEqual({ ok: false, code: CHATGPT_ERROR_CODES.USAGE_LIMIT, message: SENTENCE.USAGE_LIMIT, retryable: false });
    expect(bearer.refreshCalls).toHaveLength(0);
  });

  it('503 → CHATGPT_USAGE_UNAVAILABLE with the fixed sentence, retryable', async () => {
    const { result } = await run(() =>
      jsonResponse(503, { error: { code: 'subscription_sharing_usage_unavailable', message: 'unavailable' } }),
    );
    expect(result).toEqual({
      ok: false,
      code: CHATGPT_ERROR_CODES.USAGE_UNAVAILABLE,
      message: SENTENCE.USAGE_UNAVAILABLE,
      retryable: true,
    });
  });

  it('400 {detail} → HOST_ERROR carrying the detail (the measured rejection shape), not retryable', async () => {
    const { result, bearer } = await run(() => jsonResponse(400, { detail: 'Unsupported parameter: temperature' }));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR', retryable: false });
    if (result.ok) return;
    expect(result.message).toContain('Unsupported parameter: temperature');
    expect(bearer.refreshCalls).toHaveLength(0);
  });

  it('400: a bearer echoed across the 200th character is fully redacted (redact BEFORE the cap)', async () => {
    const lead = 'Unsupported parameter: temperature. Request was: ';
    const detail = `${lead}${'x'.repeat(185 - lead.length)}${TOKEN_A} ${'z'.repeat(300)}`;
    expect(detail.indexOf(TOKEN_A)).toBe(185);
    expect(detail.indexOf(TOKEN_A) + TOKEN_A.length).toBeGreaterThan(200);
    const { result } = await run(() => jsonResponse(400, { detail }));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    if (result.ok) return;
    expect(result.message).toContain('Unsupported parameter: temperature');
    expect(JSON.stringify(result)).not.toContain('SECRETBEAR'); // not even a prefix survives
    expect(result.message).not.toContain('z'.repeat(50)); // the 200-character cap applied
  });

  it('400: a \\u-escaped bearer echo inside the JSON body is scrubbed (redaction runs after JSON extraction)', async () => {
    // The raw body spells the first character as S — a scrub over the raw text would miss it.
    const raw = `{"detail":"Unsupported parameter: temperature (sent with \\u0053${TOKEN_A.slice(1)})"}`;
    expect(raw).not.toContain(TOKEN_A);
    const { result } = await run(() => jsonResponse(400, raw));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    if (result.ok) return;
    expect(result.message).toContain('Unsupported parameter: temperature');
    expect(JSON.stringify(result)).not.toContain(TOKEN_A.slice(1, 20));
  });

  it('400 after a refresh-and-retry: the SECOND bearer’s echo is redacted too', async () => {
    let n = 0;
    const { result, calls } = await run(() =>
      n++ === 0 ? echoing401(TOKEN_A) : jsonResponse(400, { detail: `Unsupported parameter: temperature for ${TOKEN_B}` }),
    );
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    if (result.ok) return;
    expect(result.message).toContain('Unsupported parameter: temperature');
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('the JWT-shape backstop masks an eyJ… token the bearer source never handed out', async () => {
    const stranger = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiJ1c2VyLTEyMyIsImF1ZCI6WyJ4Il19.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const { result } = await run(() => jsonResponse(400, { detail: `Bad token ${stranger} in request` }));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    if (result.ok) return;
    expect(result.message).toContain('***');
    expect(result.message).not.toContain('eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ');
    expect(result.message).toContain('Bad token');
  });

  it('the JWT-shape backstop also covers stream failure messages', async () => {
    const stranger = 'eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ.eyJzdWIiOiJ1c2VyLTEyMyIsImF1ZCI6WyJ4Il19.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const { result } = await run(() => bareStream(created + failed('server_error', `bad bearer ${stranger}`)));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    expect(JSON.stringify(result)).not.toContain('eyJhbGciOiJSUzI1NiIsImtpZCI6IngifQ');
  });

  it('a 5xx other than 503 → HOST_ERROR with no bearer in it', async () => {
    const { result } = await run(() => jsonResponse(500, { error: { message: `internal error for ${TOKEN_A}` } }));
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    expect(JSON.stringify(result)).not.toContain('SECRETBEARER');
  });

  it('a network failure → NETWORK_ERROR, retryable', async () => {
    const { result } = await run(() => {
      throw new TypeError('fetch failed');
    });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
  });

  it('an abort via request.signal mid-stream → CANCELLED, not retryable', async () => {
    const controller = new AbortController();
    const { result } = await run(
      (_url, init) => new Response(abortErrorStream(init.signal, created, messageAdded(), textDelta('He')), { status: 200 }),
      { signal: controller.signal, onDelta: () => controller.abort() },
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
  });

  it('an already-aborted request.signal → CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();
    const { result } = await run(
      (_url, init) => {
        if (init.signal?.aborted === true) throw new DOMException('The operation was aborted.', 'AbortError');
        return bareStream(TEXT_STREAM);
      },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
  });
});

// ---------------------------------------------------------------------------------------------
// Source lints (AC10, AC12)
// ---------------------------------------------------------------------------------------------

describe('source lints (AC10, AC12)', () => {
  const source = (file: string): string => readFileSync(join(__dirname, '..', file), 'utf8');

  it('openai-responses.ts never logs (no console.)', () => {
    expect(source('openai-responses.ts')).not.toMatch(/\bconsole\./);
  });

  it('errors.ts never logs (no console.)', () => {
    expect(source('errors.ts')).not.toMatch(/\bconsole\./);
  });

  it('openai-responses.ts never reads the response content-type — a stream is decided by status', () => {
    expect(source('openai-responses.ts')).not.toMatch(/\.get\(\s*['"`]content-type['"`]\s*\)/i);
  });

  it('openai-responses.ts never names the backend-api route', () => {
    expect(source('openai-responses.ts')).not.toContain('backend-api');
  });

  it('the lint patterns can fail (proof against a planted line)', () => {
    expect("const t = res.headers.get('Content-Type');").toMatch(/\.get\(\s*['"`]content-type['"`]\s*\)/i);
    expect('console.log(token)').toMatch(/\bconsole\./);
  });
});
