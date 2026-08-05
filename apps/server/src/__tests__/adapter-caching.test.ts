// AC12's server half: the hub's /invoke path is a builder/agent turn, so it gets prompt
// caching on the stable tools+system prefix — the same scope as direct mode (D0/Q2).
//
// This is the HIGHEST-VALUE caching path in the product: every hub user's builder turns
// share the same large system prompt, and they repeat many times within one build.
import { describe, expect, it } from 'vitest';

import { createAdapterFromConfig } from '../adapter.js';
import type { ServerConfig } from '../config.js';

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

describe('AC12 — the hub /invoke path caches its stable prefix', () => {
  it('sends cache_control on the system block for the anthropic adapter', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config(), fetchImpl);
    await adapter.complete({ system: 'THE BUILDER SYSTEM PROMPT', messages: [{ role: 'user', content: 'build it' }] });

    expect(bodies).toHaveLength(1);
    const system = bodies[0]!.system as Array<Record<string, unknown>>;
    expect(Array.isArray(system), 'the system field must be block-form to carry a breakpoint').toBe(true);
    expect(system.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('never puts a breakpoint on the volatile message tail', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config(), fetchImpl);
    await adapter.complete({ system: 'sys', messages: [{ role: 'user', content: 'a different question each time' }] });

    // A breakpoint here would write a new cache entry per request and never read one.
    expect(JSON.stringify(bodies[0]!.messages)).not.toContain('cache_control');
  });

  it('does NOT request caching from the openai adapter (AC14)', async () => {
    const { bodies, fetchImpl } = capture();
    const adapter = createAdapterFromConfig(config({ adapter: 'openai', openaiApiKey: 'k' }), fetchImpl);
    await adapter.complete({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] });

    expect(JSON.stringify(bodies[0])).not.toContain('cache_control');
  });
});
