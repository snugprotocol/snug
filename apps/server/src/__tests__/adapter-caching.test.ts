// AC12's server scope: caching is a per-TURN decision, not a per-adapter one.
//
// The server builds ONE adapter that serves BOTH /invoke paths. The builder path is the
// highest-value caching path in the product (every hub user's turns share one large
// system prompt, repeated across a build); the app-frame path must NOT be cached — its
// envelopes are below the model-dependent minimum, so a breakpoint there pays a 1.25x
// write premium on a prefix that is never read (D0/Q2).
//
// The original version of this file asserted only at the adapter level, which is exactly
// why it missed that the adapter default was caching both paths (Gate-5 review).
import { describe, expect, it } from 'vitest';

import { mockAdapter } from '@snugprotocol/adapters';
import { buildAppRequest } from '@snugprotocol/protocol';

import { createAdapterFromConfig } from '../adapter.js';
import type { ServerConfig } from '../config.js';
import { buildTestApp, invokeBody, spyAdapter } from './helpers.js';

/** Records the request body the adapter would put on the wire. */
function capture(): { bodies: Record<string, unknown>[]; fetchImpl: typeof fetch } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    // A minimal well-formed stream: the assertion is on the REQUEST, not the reply.
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n'));
          controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const config = (overrides: Partial<ServerConfig> = {}): ServerConfig =>
  ({ adapter: 'anthropic', anthropicApiKey: 'test-key', model: 'claude-opus-5', ...overrides }) as ServerConfig;

describe('AC12 — caching is a per-TURN decision, not a per-adapter one', () => {
  it('caches when the caller asks for it (the builder turn)', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config(), fetchImpl);
    await adapter.complete({
      system: 'THE BUILDER SYSTEM PROMPT',
      messages: [{ role: 'user', content: 'build it' }],
      cache: true,
    });

    expect(bodies).toHaveLength(1);
    const system = bodies[0]!.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system), 'the system field must be block-form to carry a breakpoint').toBe(true);
    expect(system.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('does NOT cache when the caller stays silent (the app-frame turn)', async () => {
    // Same adapter instance as above — only the request differs.
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config(), fetchImpl);
    await adapter.complete({
      system: 'app-frame host prompt',
      messages: [{ role: 'user', content: '{"snug":"app-request","action":"move"}' }],
    });

    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
    expect(typeof bodies[0]!.system, 'no breakpoint means the plain-string form').toBe('string');
  });

  it('never puts a breakpoint on the volatile message tail', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config(), fetchImpl);
    await adapter.complete({
      system: 'sys',
      messages: [{ role: 'user', content: 'a different question each time' }],
      cache: true,
    });

    // A breakpoint here would write a new cache entry per request and never read one.
    expect(JSON.stringify(bodies[0]!.messages)).not.toContain('cache_control');
  });

  it('does NOT request caching from the openai adapter even when asked (AC14)', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config({ adapter: 'openai', openaiApiKey: 'k' }), fetchImpl);
    await adapter.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }], cache: true });

    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });
});

// The route-level half. The adapter tests above prove the ADAPTER honours the flag;
// these prove the ROUTE sets it on the right path — which is the half that was wrong
// (the adapter cached unconditionally, so both /invoke paths were cached).
describe('AC12 — the /invoke ROUTE opts in on the builder path only', () => {
  it('asks for caching on the chat/builder path', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'built it' }]));
    const app = await buildTestApp({ adapter });
    try {
      await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('build me a chess app') });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cache, 'the builder turn is the high-value caching path').toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does NOT ask for caching on the app-frame path', async () => {
    // A Chess move: a short self-contained envelope, below the cacheable minimum. A
    // breakpoint here bills a 1.25x write premium forever for a cache never read.
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"snug":"app-response"}' }]));
    const app = await buildTestApp({ adapter });
    try {
      const wire = buildAppRequest({
        appId: 'chess',
        instanceId: 'i1',
        requestId: 'r1',
        action: 'chat',
        payload: { move: 'e4' },
      });
      await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(wire) });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cache, 'app-frame envelopes are excluded by D0/Q2').toBe(false);
    } finally {
      await app.close();
    }
  });
});
