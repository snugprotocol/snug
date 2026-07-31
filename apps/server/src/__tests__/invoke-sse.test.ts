// SSE mechanics (AC4): heartbeats, the thread-conflict 409, and the rate cap.

import { mockAdapter, type AgentAdapter } from '@snugprotocol/adapters';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_BODY_BYTES } from '../app.js';
import { createRateLimiter } from '../rate-limit.js';
import { buildTestApp, invokeBody, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function slowAdapter(delayMs: number): AgentAdapter {
  return {
    async complete() {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { ok: true, text: 'slow reply', toolCalls: [], stopReason: 'end' };
    },
  };
}

function gatedAdapter(): { adapter: AgentAdapter; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    adapter: {
      async complete() {
        await gate;
        return { ok: true, text: 'gated reply', toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

describe('POST /invoke — SSE mechanics', () => {
  it('emits heartbeat comments while the adapter is slow (short interval override)', async () => {
    app = await buildTestApp({ config: testConfig({ heartbeatMs: 20 }), adapter: slowAdapter(90) });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('hi') });
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.payload).toContain(':hb');
    expect(response.payload).toContain('event: done');
  });

  it('returns 409 THREAD_CONFLICT for a concurrent /invoke on the same thread, then completes the first', async () => {
    const { adapter, release } = gatedAdapter();
    app = await buildTestApp({ adapter });

    const first = app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('one', 'same-thread') });
    await new Promise((resolve) => setTimeout(resolve, 30)); // let request 1 take the lock
    const second = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('two', 'same-thread') });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({
      code: 'THREAD_CONFLICT',
      message: 'another request is in flight for this thread',
      retryable: true,
    });

    release();
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.payload).toContain('event: done');

    // lock released — the thread is usable again
    const third = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('three', 'same-thread') });
    expect(third.statusCode).toBe(200);
  });

  it('enforces the per-IP rate cap with a typed 429', async () => {
    app = await buildTestApp({
      adapter: mockAdapter([{ text: 'a' }, { text: 'b' }, { text: 'c' }]),
      rateLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0 }),
    });
    expect((await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('1') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('2') })).statusCode).toBe(200);
    const third = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('3') });
    expect(third.statusCode).toBe(429);
    expect((third.json() as { code: string }).code).toBe('RATE_LIMITED');
  });

  it('keeps CORS access-control headers on the hijacked SSE response', async () => {
    app = await buildTestApp({ adapter: mockAdapter([{ text: 'hi' }]) });
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: { origin: 'http://localhost:5173' },
      payload: invokeBody('hello'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('rejects a body over the explicit bodyLimit with 413', async () => {
    app = await buildTestApp({ adapter: mockAdapter([{ text: 'x' }]) });
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      payload: invokeBody('a'.repeat(MAX_BODY_BYTES + 1024)),
    });
    expect(response.statusCode).toBe(413);
  });

  it('rejects a malformed body with a typed 400', async () => {
    app = await buildTestApp({ adapter: mockAdapter([{ text: 'x' }]) });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: { nope: true } });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('BAD_REQUEST');
  });
});
