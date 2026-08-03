// Subscription-mode model choice (TASK-20260803-serverless-run): a validated body
// `model` swaps the adapter via makeAdapter for that request only; garbage models are
// rejected by zod; absent makeAdapter falls back to the default adapter.

import { mockAdapter } from '@snugprotocol/adapters';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRateLimiter } from '../rate-limit.js';
import { registerInvokeRoute } from '../routes/invoke.js';
import { createArtifactStore } from '../stores/artifacts.js';
import { createThreadStore } from '../stores/threads.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function buildInvokeApp(makeAdapter?: (model: string) => ReturnType<typeof mockAdapter>): FastifyInstance {
  const instance = Fastify();
  registerInvokeRoute(instance, {
    adapter: mockAdapter([{ deltas: ['default'], text: 'default' }]),
    ...(makeAdapter !== undefined ? { makeAdapter } : {}),
    artifacts: createArtifactStore(':memory:'),
    threads: createThreadStore(':memory:'),
    heartbeatMs: 10_000,
    rateLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 100 }),
  });
  return instance;
}

describe('POST /invoke — model override', () => {
  it('routes a valid model through makeAdapter for that request', async () => {
    const makeAdapter = vi.fn(() => mockAdapter([{ deltas: ['tuned'], text: 'tuned' }]));
    app = buildInvokeApp(makeAdapter);
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      payload: { message: 'hello', model: 'claude-sonnet-5' },
    });
    expect(response.statusCode).toBe(200);
    expect(makeAdapter).toHaveBeenCalledWith('claude-sonnet-5');
    expect(response.payload).toContain('tuned');
  });

  it('serves the default adapter when no model is sent', async () => {
    const makeAdapter = vi.fn(() => mockAdapter([{ deltas: ['tuned'], text: 'tuned' }]));
    app = buildInvokeApp(makeAdapter);
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: { message: 'hello' } });
    expect(response.statusCode).toBe(200);
    expect(makeAdapter).not.toHaveBeenCalled();
    expect(response.payload).toContain('default');
  });

  it('rejects an over-long model string with a typed 400', async () => {
    app = buildInvokeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      payload: { message: 'hello', model: 'x'.repeat(200) },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.payload)).toMatchObject({ code: 'BAD_REQUEST' });
  });
});
