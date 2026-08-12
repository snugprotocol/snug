/**
 * TASK-20260812-app-reply-parse-failure, AC3 — the adapter's stop reason SURVIVES.
 *
 * The confirmed defect behind the owner's unwinnable retry loop: the provider says WHY
 * generation stopped (`max_tokens` = the host-imposed output cap cut the reply off), but
 * the adapters synthesized `stopReason` from tool calls alone and the turn layer dropped
 * it entirely — so the bridge reported a truncated reply as "not parseable JSON", charged
 * a parse-failure strike for it, and the app's retry could only truncate again.
 *
 * This suite pins the chain bottom-up: provider wire → AdapterResult → AgentTurnResult.
 * The bridge half (truncation is NOT a strike) lives in the runner's host-messaging suite.
 */

import { describe, expect, it } from 'vitest';

import { runAgentTurn } from '../agent-turn.js';
import { anthropicAdapter } from '../anthropic.js';
import { mockAdapter } from '../mock.js';
import { openaiAdapter } from '../openai.js';
import { block, fakeFetch, sseResponse } from './helpers.js';

function anthropicFixture(stopReason: string): string {
  return (
    block('message_start', '{"type":"message_start","message":{"id":"msg_1"}}') +
    block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
    block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"rows\\":["}}') +
    block('content_block_stop', '{"type":"content_block_stop","index":0}') +
    block('message_delta', `{"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}`) +
    block('message_stop', '{"type":"message_stop"}')
  );
}

const turn = { messages: [{ role: 'user' as const, content: 'move' }] };

describe('anthropic adapter — stop_reason from the wire', () => {
  it('reports max_tokens when the provider says the cap cut the reply off', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(anthropicFixture('max_tokens')));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('max_tokens');
  });

  it('still reports end for a normal end_turn', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(anthropicFixture('end_turn')));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('end');
  });
});

describe('openai adapter — finish_reason from the wire', () => {
  it('normalizes finish_reason "length" to max_tokens', async () => {
    const fixture =
      'data: {"choices":[{"delta":{"content":"{\\"rows\\":["}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
      'data: [DONE]\n\n';
    const { fetchImpl } = fakeFetch(() => sseResponse(fixture));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('max_tokens');
  });

  it('still reports end for finish_reason "stop"', async () => {
    const fixture =
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n';
    const { fetchImpl } = fakeFetch(() => sseResponse(fixture));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('end');
  });
});

describe('mock adapter — scriptable stop reason', () => {
  it('a turn scripted as max_tokens reports it', async () => {
    const adapter = mockAdapter([{ text: '{"rows":[', stopReason: 'max_tokens' }]);

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('max_tokens');
  });

  it('an unscripted turn keeps the end default', async () => {
    const adapter = mockAdapter([{ text: '{"ok":true}' }]);

    const result = await adapter.complete({ system: 'S', ...turn });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('end');
  });
});

describe('runAgentTurn — the turn layer carries the final stop reason', () => {
  it('a truncated final reply surfaces stopReason max_tokens to the caller', async () => {
    const adapter = mockAdapter([{ text: '{"rows":[', stopReason: 'max_tokens' }]);

    const result = await runAgentTurn({ adapter, system: 'S', messages: [{ role: 'user', content: 'x' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('max_tokens');
  });

  it('a normally finished turn surfaces stopReason end', async () => {
    const adapter = mockAdapter([{ text: '{"ok":true}' }]);

    const result = await runAgentTurn({ adapter, system: 'S', messages: [{ role: 'user', content: 'x' }] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('end');
  });

  it('a tool round followed by a truncated final reply still reports max_tokens', async () => {
    const adapter = mockAdapter([
      { text: '', toolCalls: [{ name: 'lookup', input: {} }] },
      { text: '{"rows":[', stopReason: 'max_tokens' },
    ]);

    const result = await runAgentTurn({
      adapter,
      system: 'S',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ def: { name: 'lookup', description: 'd', inputSchema: {} }, run: async () => 'data' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe('max_tokens');
  });
});
