// Test helpers: in-memory app builder, spy adapter, and real SSE parsing over
// fastify-injected responses (via the adapters package's tolerant parser).

import {
  parseSse,
  type AdapterRequest,
  type AgentAdapter,
  type SseEvent,
} from '@snugprotocol/adapters';
import type { FastifyInstance } from 'fastify';

import { buildApp, type AppOptions } from '../app.js';
import type { ServerConfig } from '../config.js';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    adapter: 'mock',
    port: 0,
    host: '127.0.0.1',
    corsOrigin: true,
    dataDir: ':memory:',
    heartbeatMs: 15_000,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 },
    ...overrides,
  };
}

export async function buildTestApp(options: Partial<AppOptions> & { config?: ServerConfig } = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: options.config ?? testConfig(), ...options });
  return app;
}

/** JSON-snapshot spy: records exactly what reaches the adapter (the C1 assertion surface). */
export function spyAdapter(inner: AgentAdapter): {
  calls: Array<Pick<AdapterRequest, 'system' | 'messages' | 'tools'>>;
  adapter: AgentAdapter;
} {
  const calls: Array<Pick<AdapterRequest, 'system' | 'messages' | 'tools'>> = [];
  return {
    calls,
    adapter: {
      complete(request) {
        calls.push(
          JSON.parse(
            JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools ?? null }),
          ) as Pick<AdapterRequest, 'system' | 'messages' | 'tools'>,
        );
        return inner.complete(request);
      },
    },
  };
}

/** Parse an injected SSE payload with the real (tolerant) SSE parser. */
export async function parseSsePayload(payload: string): Promise<SseEvent[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  const events: SseEvent[] = [];
  for await (const event of parseSse(stream)) events.push(event);
  return events;
}

export function invokeBody(message: string, threadId?: string): Record<string, unknown> {
  return threadId === undefined ? { message } : { message, threadId };
}
