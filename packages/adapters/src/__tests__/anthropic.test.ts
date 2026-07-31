// Fixture-based request-shape and streaming tests — recorded SSE bodies, no live network.
import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../anthropic.js';
import type { AdapterMessage, ToolDef } from '../types.js';
import { abortErrorStream, block, fakeFetch, sseResponse } from './helpers.js';

const TOOL: ToolDef = {
  name: 'snug_app_builder',
  description: 'Retrieves the knowledge base.',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

const TEXT_FIXTURE =
  block('message_start', '{"type":"message_start","message":{"id":"msg_1"}}') +
  block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":0}') +
  block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}') +
  block('message_stop', '{"type":"message_stop"}');

const TOOL_FIXTURE =
  block('message_start', '{"type":"message_start","message":{"id":"msg_2"}}') +
  block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking it up."}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":0}') +
  block(
    'content_block_start',
    '{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"snug_app_builder","input":{}}}',
  ) +
  block('content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"que"}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ry\\":\\"template\\"}"}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":1}') +
  block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"tool_use"}}') +
  block('message_stop', '{"type":"message_stop"}');

describe('anthropicAdapter request shape', () => {
  it('places the system prompt top-level, streams, maps tools to input_schema, and sends auth headers', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'test-key', fetch: fetchImpl });
    await adapter.complete({ system: 'SYSTEM PROMPT', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('test-key');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect(call.bodyJson.model).toBe('claude-sonnet-5');
    expect(call.bodyJson.stream).toBe(true);
    expect(call.bodyJson.system).toBe('SYSTEM PROMPT');
    expect(call.bodyJson.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(call.bodyJson.tools).toEqual([
      { name: TOOL.name, description: TOOL.description, input_schema: TOOL.inputSchema },
    ]);
  });

  it('omits tools entirely in JSON-only mode (no tools offered)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]!.bodyJson).not.toHaveProperty('tools');
  });

  it('maps assistant tool calls to tool_use blocks and merges consecutive tool results into one user message', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const messages: AdapterMessage[] = [
      { role: 'user', content: 'build me an app' },
      {
        role: 'assistant',
        content: 'On it.',
        toolCalls: [
          { id: 'toolu_1', name: 'snug_app_builder', input: { query: 'template' } },
          { id: 'toolu_2', name: 'snug_app_builder', input: { query: 'persistence' } },
        ],
      },
      { role: 'tool', toolCallId: 'toolu_1', content: 'sections one' },
      { role: 'tool', toolCallId: 'toolu_2', content: 'sections two' },
    ];
    await adapter.complete({ system: 's', messages });
    expect(calls[0]!.bodyJson.messages).toEqual([
      { role: 'user', content: 'build me an app' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 'toolu_1', name: 'snug_app_builder', input: { query: 'template' } },
          { type: 'tool_use', id: 'toolu_2', name: 'snug_app_builder', input: { query: 'persistence' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'sections one' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'sections two' },
        ],
      },
    ]);
  });
});

describe('anthropicAdapter streaming assembly', () => {
  it('accumulates text deltas and streams each one', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const deltas: string[] = [];
    const result = await adapter.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['Hello', ' world']);
    expect(result).toEqual({ ok: true, text: 'Hello world', toolCalls: [], stopReason: 'end' });
  });

  it('assembles tool_use blocks from input_json_delta fragments', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(TOOL_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(result).toEqual({
      ok: true,
      text: 'Looking it up.',
      toolCalls: [{ id: 'toolu_1', name: 'snug_app_builder', input: { query: 'template' } }],
      stopReason: 'tool_use',
    });
  });

  it('tolerates a malformed block mid-stream', async () => {
    const withGarbage = TEXT_FIXTURE.replace(
      'event: message_delta',
      'event: content_block_delta\ndata: {broken json\n\nevent: message_delta',
    );
    const { fetchImpl } = fakeFetch(() => sseResponse(withGarbage));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe('Hello world');
  });
});

describe('anthropicAdapter error mapping', () => {
  it.each([
    [429, true],
    [500, true],
    [503, true],
    [401, false],
    [400, false],
  ])('HTTP %i → retryable %s, as data', async (status, retryable) => {
    const { fetchImpl } = fakeFetch(() => new Response('{"error":{"message":"nope"}}', { status }));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(retryable);
      expect(result.message).toContain(String(status));
    }
  });

  it('maps a thrown fetch to NETWORK_ERROR (retryable)', async () => {
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: () => Promise.reject(new TypeError('fetch failed')) });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
  });

  it('maps an abort to CANCELLED (clean, not retryable)', async () => {
    const controller = new AbortController();
    const adapter = anthropicAdapter({
      apiKey: 'k',
      fetch: (_url, init) =>
        Promise.resolve(
          new Response(
            abortErrorStream(init?.signal, block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"He"}}')),
            { status: 200 },
          ),
        ),
    });
    const pending = adapter.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
  });

  it('maps a stream that ends without message_stop to STREAM_DROPPED (retryable)', async () => {
    const dropped = TEXT_FIXTURE.replace(block('message_stop', '{"type":"message_stop"}'), '');
    const { fetchImpl } = fakeFetch(() => sseResponse(dropped));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: 'STREAM_DROPPED', retryable: true });
  });
});
