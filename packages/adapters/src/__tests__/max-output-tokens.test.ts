/**
 * TASK-20260811-lean-runtime-data-chat, P0.5 — per-turn `maxOutputTokens` (ADR-0018 D4).
 *
 * PER-TURN, LIKE `cache`, AND FOR THE SAME REASON. One adapter instance serves turns of
 * different shapes — the hub's `/invoke` answers both the builder path and the app-frame
 * path — so only the CALLER knows what this turn's output should cost. A construction-time
 * ceiling could not tell a Chess move from a story generation.
 *
 * OPT-IN, NEVER IMPOSED. App transport sets it only when the runtime contract asks for it;
 * a contract-less legacy app keeps today's default exactly (AC-F1-4). Capping a legacy
 * story-teller app would be a silent regression that looks like the model "stopping early".
 *
 * CLAMPED, NEVER RAISED. The per-turn value narrows the adapter's own ceiling and can
 * never widen it — local mode's 8K cap in particular has to survive a contract asking for
 * more, because that cap describes what the local server can actually deliver.
 */

import { describe, expect, it } from 'vitest';

import { anthropicAdapter } from '../anthropic.js';
import { localAdapter, LOCAL_DEFAULT_MAX_TOKENS } from '../local.js';
import { openaiAdapter } from '../openai.js';
import { block, fakeFetch, sseResponse } from './helpers.js';

const ANTHROPIC_FIXTURE =
  block('message_start', '{"type":"message_start","message":{"id":"msg_1"}}') +
  block('content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}') +
  block('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}') +
  block('content_block_stop', '{"type":"content_block_stop","index":0}') +
  block('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"}}') +
  block('message_stop', '{"type":"message_stop"}');

const OPENAI_FIXTURE =
  'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' + 'data: [DONE]\n\n';

const turn = { messages: [{ role: 'user' as const, content: 'move' }] };

describe('anthropic adapter', () => {
  it('sends the per-turn cap as max_tokens when the caller asks for one', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(ANTHROPIC_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 512 });

    expect(calls[0]!.bodyJson.max_tokens).toBe(512);
  });

  it('keeps today’s default when the caller asks for nothing (AC-F1-4)', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(ANTHROPIC_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn });

    expect(calls[0]!.bodyJson.max_tokens).toBe(128_000);
  });

  it('CLAMPS to the construction ceiling — a per-turn value can narrow, never widen', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(ANTHROPIC_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, maxTokens: 4096 });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 100_000 });

    expect(calls[0]!.bodyJson.max_tokens).toBe(4096);
  });

  it('narrows below the construction ceiling when the per-turn value is smaller', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(ANTHROPIC_FIXTURE));
    const adapter = anthropicAdapter({ apiKey: 'k', fetch: fetchImpl, maxTokens: 4096 });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 256 });

    expect(calls[0]!.bodyJson.max_tokens).toBe(256);
  });
});

describe('openai adapter', () => {
  it('sends the per-turn cap as max_completion_tokens', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(OPENAI_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 512 });

    expect(calls[0]!.bodyJson.max_completion_tokens).toBe(512);
  });

  it('keeps today’s default without a per-turn cap', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(OPENAI_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn });

    expect(calls[0]!.bodyJson.max_completion_tokens).toBe(128_000);
  });

  it('clamps to the construction ceiling', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(OPENAI_FIXTURE));
    const adapter = openaiAdapter({ apiKey: 'k', fetch: fetchImpl, maxTokens: 2048 });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 99_999 });

    expect(calls[0]!.bodyJson.max_completion_tokens).toBe(2048);
  });
});

describe('local adapter — the 8K rule survives the contract', () => {
  it('a contract asking for more than the local cap is clamped DOWN to it', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(OPENAI_FIXTURE));
    const adapter = localAdapter({ fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 100_000 });

    // localAdapter delegates to openaiAdapter with LOCAL_DEFAULT_MAX_TOKENS as its
    // construction ceiling, so the clamp is what enforces the 8K rule.
    expect(calls[0]!.bodyJson.max_completion_tokens).toBe(LOCAL_DEFAULT_MAX_TOKENS);
  });

  it('a smaller per-turn cap still applies under the local ceiling', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(OPENAI_FIXTURE));
    const adapter = localAdapter({ fetch: fetchImpl });

    await adapter.complete({ system: 'S', ...turn, maxOutputTokens: 512 });

    expect(calls[0]!.bodyJson.max_completion_tokens).toBe(512);
  });
});
