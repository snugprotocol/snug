// Fixture-based request-shape and streaming tests — recorded SSE bodies, no live network.
import { describe, expect, it } from 'vitest';

import { openaiAdapter } from '../openai.js';
import type { AdapterMessage, ToolDef } from '../types.js';
import { block, fakeFetch, sseResponse } from './helpers.js';

const TOOL: ToolDef = {
  name: 'artifact_write',
  description: 'Creates an artifact.',
  inputSchema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
};

const TEXT_FIXTURE =
  block(null, '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}') +
  block(null, '{"choices":[{"index":0,"delta":{"content":"Hel"}}]}') +
  block(null, '{"choices":[{"index":0,"delta":{"content":"lo"}}]}') +
  block(null, '{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}') +
  block(null, '[DONE]');

const TOOL_FIXTURE =
  block(null, '{"choices":[{"index":0,"delta":{"role":"assistant"}}]}') +
  block(
    null,
    '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"artifact_write","arguments":""}}]}}]}',
  ) +
  block(null, '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"content\\":"}}]}}]}') +
  block(null, '{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"<p>hi</p>\\"}"}}]}}]}') +
  block(null, '{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}') +
  block(null, '[DONE]');

describe('openaiAdapter request shape', () => {
  it('sends Bearer auth, the system message first, mapped function tools, and stream: true', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'oa-key', fetch: fetchImpl });
    await adapter.complete({ system: 'SYSTEM PROMPT', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer oa-key');
    expect(call.bodyJson.model).toBe('gpt-4o');
    expect(call.bodyJson.stream).toBe(true);
    expect(call.bodyJson.messages).toEqual([
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'hi' },
    ]);
    expect(call.bodyJson.tools).toEqual([
      { type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema } },
    ]);
  });

  it('omits tools entirely in JSON-only mode', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0]!.bodyJson).not.toHaveProperty('tools');
  });

  it('maps assistant tool calls and tool replies (role: tool + tool_call_id)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const messages: AdapterMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_abc', name: 'artifact_write', input: { content: 'x' } }] },
      { role: 'tool', toolCallId: 'call_abc', content: 'Created artifact.' },
    ];
    await adapter.complete({ system: 's', messages });
    expect(calls[0]!.bodyJson.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_abc', type: 'function', function: { name: 'artifact_write', arguments: '{"content":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_abc', content: 'Created artifact.' },
    ]);
  });
});

describe('openaiAdapter streaming assembly', () => {
  it('accumulates content deltas and streams each one', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(TEXT_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const deltas: string[] = [];
    const result = await adapter.complete({
      system: 's',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toEqual({ ok: true, text: 'Hello', toolCalls: [], stopReason: 'end' });
  });

  it('accumulates tool_call argument fragments across chunks', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(TOOL_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [TOOL] });
    expect(result).toEqual({
      ok: true,
      text: '',
      toolCalls: [{ id: 'call_abc', name: 'artifact_write', input: { content: '<p>hi</p>' } }],
      stopReason: 'tool_use',
    });
  });

  it('tolerates a malformed chunk mid-stream', async () => {
    const withGarbage = TEXT_FIXTURE.replace(block(null, '[DONE]'), block(null, '{oops') + block(null, '[DONE]'));
    const { fetchImpl } = fakeFetch(() => sseResponse(withGarbage));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(true);
  });
});

describe('openaiAdapter error mapping', () => {
  it.each([
    [429, true],
    [500, true],
    [401, false],
  ])('HTTP %i → retryable %s, as data', async (status, retryable) => {
    const { fetchImpl } = fakeFetch(() => new Response('{"error":{"message":"nope"}}', { status }));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryable).toBe(retryable);
  });

  it('maps a thrown fetch to NETWORK_ERROR (retryable)', async () => {
    const adapter = openaiAdapter({ apiKey: 'k', fetch: () => Promise.reject(new TypeError('fetch failed')) });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
  });

  it('maps a stream without finish_reason to STREAM_DROPPED (retryable)', async () => {
    const dropped =
      block(null, '{"choices":[{"index":0,"delta":{"content":"partial"}}]}'); // connection died here
    const { fetchImpl } = fakeFetch(() => sseResponse(dropped));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: 'STREAM_DROPPED', retryable: true });
  });
});
