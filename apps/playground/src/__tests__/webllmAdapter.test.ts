// AL-07 AC4/AC5/AC6/AC7/AC8: the WebLLM adapter against the SAME AgentAdapter
// contract every other provider implements — engine faked through the loader seam,
// no network, no WebGPU. One test runs the adapter through runAgentTurn to prove the
// inspector's event union (round_trip_start/round_trip) fires unchanged.

import { runAgentTurn, type AgentTurnEvent } from '@snugprotocol/adapters';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetWebllmEngineForTests,
  setWebllmEngineLoaderForTests,
  type WebllmChatRequest,
  type WebllmChunk,
  type WebllmEngineLike,
} from '../agent/webllm/engine.js';
import { WEBLLM_DEFAULT_MODEL } from '../agent/webllm/model.js';
import {
  webllmAdapter,
  WEBLLM_LOAD_FAILED_CODE,
  WEBLLM_TOOLS_UNSUPPORTED_CODE,
} from '../agent/webllm/webllmAdapter.js';

/** A scripted fake engine: yields the given chunks, records every request. */
function fakeEngine(chunks: WebllmChunk[]): { engine: WebllmEngineLike; requests: WebllmChatRequest[]; interrupts: number } {
  const state = { requests: [] as WebllmChatRequest[], interrupts: 0 };
  const engine: WebllmEngineLike = {
    chat: {
      completions: {
        create(request) {
          state.requests.push(request);
          async function* generate(): AsyncGenerator<WebllmChunk> {
            for (const chunk of chunks) yield chunk;
          }
          return Promise.resolve(generate());
        },
      },
    },
    interruptGenerate: () => {
      state.interrupts += 1;
    },
  };
  return { engine, requests: state.requests, get interrupts() { return state.interrupts; } } as {
    engine: WebllmEngineLike;
    requests: WebllmChatRequest[];
    interrupts: number;
  };
}

const delta = (content: string, model = 'fake-model'): WebllmChunk => ({
  model,
  choices: [{ delta: { content }, finish_reason: null }],
});

const finish = (model = 'fake-model'): WebllmChunk => ({
  model,
  choices: [{ delta: {}, finish_reason: 'stop' }],
});

const usageChunk = (prompt: number, completion: number, model = 'fake-model'): WebllmChunk => ({
  model,
  choices: [],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

beforeEach(() => {
  resetWebllmEngineForTests();
});

afterEach(() => {
  setWebllmEngineLoaderForTests(undefined);
  resetWebllmEngineForTests();
  vi.restoreAllMocks();
});

describe('webllmAdapter — contract (AC4)', () => {
  it('streams deltas through onDelta, returns the concatenated text with stopReason end', async () => {
    const fake = fakeEngine([delta('hel'), delta('lo'), finish(), usageChunk(12, 3)]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    const adapter = webllmAdapter();
    const deltas: string[] = [];
    const result = await adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (d) => deltas.push(d),
    });
    expect(result).toMatchObject({ ok: true, text: 'hello', stopReason: 'end', toolCalls: [] });
    expect(deltas).toEqual(['hel', 'lo']);
  });

  it('sends the system prompt as the leading system message and maps history in order', async () => {
    const fake = fakeEngine([delta('x'), finish()]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    await webllmAdapter().complete({
      system: 'the system prompt',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.messages).toEqual([
      { role: 'system', content: 'the system prompt' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(fake.requests[0]?.stream).toBe(true);
    expect(fake.requests[0]?.stream_options).toEqual({ include_usage: true });
  });

  it('maps usage to inputTokens/outputTokens and leaves the cache fields ABSENT (never 0)', async () => {
    const fake = fakeEngine([delta('ok'), finish(), usageChunk(100, 7)]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    const result = await webllmAdapter().complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 7 });
      expect(result.usage).not.toHaveProperty('cacheCreationTokens');
      expect(result.usage).not.toHaveProperty('cacheReadTokens');
    }
  });

  it('never throws across the boundary: a mid-stream engine error becomes an error RESULT with partialText', async () => {
    const engine: WebllmEngineLike = {
      chat: {
        completions: {
          create() {
            async function* generate(): AsyncGenerator<WebllmChunk> {
              yield delta('partial ');
              throw new Error('device lost');
            }
            return Promise.resolve(generate());
          },
        },
      },
    };
    setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
    const result = await webllmAdapter().complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.partialText).toBe('partial ');
    }
  });
});

describe('webllmAdapter — wire model name (AC5)', () => {
  it('reports the engine-REPORTED model id, not the configured one', async () => {
    const fake = fakeEngine([delta('x', 'ENGINE-REPORTED-ID'), finish('ENGINE-REPORTED-ID')]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    const result = await webllmAdapter({ model: 'configured-id' }).complete({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe('ENGINE-REPORTED-ID');
  });

  it('falls back to the configured id only when chunks carry no model', async () => {
    const fake = fakeEngine([
      { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    const result = await webllmAdapter({ model: 'configured-id' }).complete({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe('configured-id');
  });
});

describe('webllmAdapter — tools refused honestly (AC6)', () => {
  it('a request carrying tools gets a typed error and the engine is NEVER loaded', async () => {
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const result = await webllmAdapter().complete({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      tools: [{ name: 't', description: 'd', inputSchema: {} }],
    });
    expect(result).toMatchObject({ ok: false, code: WEBLLM_TOOLS_UNSUPPORTED_CODE, retryable: false });
    expect(loader).not.toHaveBeenCalled();
  });

  it('tool-result messages in the history are refused the same way (no silent drop)', async () => {
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const result = await webllmAdapter().complete({
      system: 's',
      messages: [
        { role: 'user', content: 'u' },
        { role: 'tool', toolCallId: 'c1', content: 'out' },
      ],
    });
    expect(result).toMatchObject({ ok: false, code: WEBLLM_TOOLS_UNSUPPORTED_CODE, retryable: false });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('webllmAdapter — engine lifecycle (AC7)', () => {
  it('loads the engine ONCE across turns and adapter instances (fresh-adapter-per-turn must not reload)', async () => {
    const fake = fakeEngine([delta('x'), finish()]);
    const loader = vi.fn(() => Promise.resolve(fake.engine));
    setWebllmEngineLoaderForTests(loader);
    await webllmAdapter().complete({ system: 's', messages: [{ role: 'user', content: '1' }] });
    await webllmAdapter().complete({ system: 's', messages: [{ role: 'user', content: '2' }] });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(WEBLLM_DEFAULT_MODEL, expect.any(Function));
  });

  it('a load failure is a typed retryable error result — and the NEXT turn retries the load', async () => {
    const fake = fakeEngine([delta('recovered'), finish()]);
    const loader = vi
      .fn<() => Promise<WebllmEngineLike>>()
      .mockRejectedValueOnce(new Error('out of GPU memory'))
      .mockResolvedValueOnce(fake.engine);
    setWebllmEngineLoaderForTests(loader);
    const adapter = webllmAdapter();
    const first = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(first).toMatchObject({ ok: false, code: WEBLLM_LOAD_FAILED_CODE, retryable: true });
    const second = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'u' }] });
    expect(second).toMatchObject({ ok: true, text: 'recovered' });
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('webllmAdapter — abort (AC8)', () => {
  it('a pre-aborted signal cancels without touching the engine', async () => {
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const controller = new AbortController();
    controller.abort();
    const result = await webllmAdapter().complete({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
    expect(loader).not.toHaveBeenCalled();
  });

  it('a mid-stream abort interrupts generation and preserves the streamed text as partialText', async () => {
    const controller = new AbortController();
    let interrupts = 0;
    const engine: WebllmEngineLike = {
      chat: {
        completions: {
          create() {
            async function* generate(): AsyncGenerator<WebllmChunk> {
              yield delta('before-abort ');
              controller.abort();
              // A real engine stops yielding after interruptGenerate; the abort check
              // must not depend on further chunks arriving.
            }
            return Promise.resolve(generate());
          },
        },
      },
      interruptGenerate: () => {
        interrupts += 1;
      },
    };
    setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
    const result = await webllmAdapter().complete({
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      signal: controller.signal,
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false, partialText: 'before-abort ' });
    expect(interrupts).toBeGreaterThanOrEqual(1);
  });
});

describe('webllmAdapter through runAgentTurn — the inspector feed (AC4)', () => {
  it('emits round_trip_start and round_trip with the response carrying the wire model name', async () => {
    const fake = fakeEngine([delta('done', 'loaded-id'), finish('loaded-id')]);
    setWebllmEngineLoaderForTests(() => Promise.resolve(fake.engine));
    const events: AgentTurnEvent[] = [];
    const result = await runAgentTurn({
      adapter: webllmAdapter(),
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      onEvent: (event) => events.push(event),
    });
    expect(result).toEqual({ ok: true, text: 'done' });
    expect(events.map((event) => event.type)).toEqual(['round_trip_start', 'round_trip']);
    const trip = events[1];
    expect(trip?.type).toBe('round_trip');
    if (trip?.type === 'round_trip') {
      expect(trip.response.ok).toBe(true);
      if (trip.response.ok) expect(trip.response.model).toBe('loaded-id');
      expect(trip.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
