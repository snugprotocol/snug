// C1 negative tests (hard constraint — risk tier medium mandates these):
// inbound credential headers never reach adapter payloads; credential-shaped values
// in an app envelope are rejected before any model sees them.

import { mockAdapter } from '@snugprotocol/adapters';
import { buildAppRequest } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildTestApp, invokeBody, parseSsePayload, spyAdapter } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const CREDENTIAL_HEADERS = {
  authorization: 'Bearer topsecret-header-token-123',
  cookie: 'session=supersecret-cookie-456',
  'x-api-key': 'sk-ant-superkey-789xyz',
};

describe('C1: inbound credential headers never reach the adapter', () => {
  it('strips Authorization/Cookie/X-Api-Key from everything adapter-bound (chat path)', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'hi there' }]));
    app = await buildTestApp({ adapter });
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: CREDENTIAL_HEADERS,
      payload: invokeBody('hello', 't-sec'),
    });
    expect(response.statusCode).toBe(200);
    expect(calls.length).toBeGreaterThan(0);
    const everythingAdapterBound = JSON.stringify(calls);
    for (const value of Object.values(CREDENTIAL_HEADERS)) {
      expect(everythingAdapterBound).not.toContain(value);
    }
  });

  it('strips credential headers on the app path too', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"reply":"ok"}' }]));
    app = await buildTestApp({ adapter });
    const wire = buildAppRequest({ appId: 'a', instanceId: 'i', requestId: 'r', action: 'chat', payload: { move: 'e4' } });
    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      headers: CREDENTIAL_HEADERS,
      payload: invokeBody(wire),
    });
    expect(response.statusCode).toBe(200);
    const everythingAdapterBound = JSON.stringify(calls);
    for (const value of Object.values(CREDENTIAL_HEADERS)) {
      expect(everythingAdapterBound).not.toContain(value);
    }
  });
});

describe('C1: envelope credential-value scan', () => {
  it('rejects an envelope whose payload plants a Bearer token — typed 400, adapter never called', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'should never run' }]));
    app = await buildTestApp({ adapter });
    const wire = buildAppRequest({
      appId: 'a',
      instanceId: 'i',
      requestId: 'r',
      action: 'chat',
      payload: { auth: 'Bearer stolen-token-abcdef' },
    });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(wire) });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { code: string; retryable: boolean };
    expect(body.code).toBe('CREDENTIAL_REJECTED');
    expect(body.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects a credential planted in envelope state as well', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'x' }]));
    app = await buildTestApp({ adapter });
    const wire = buildAppRequest({
      appId: 'a',
      instanceId: 'i',
      requestId: 'r',
      action: 'chat',
      state: { saved: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' },
    });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(wire) });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('CREDENTIAL_REJECTED');
    expect(calls).toHaveLength(0);
  });

  it('rejects a credential planted in responseSchema — the WHOLE envelope is scanned, not just payload/state', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'should never run' }]));
    app = await buildTestApp({ adapter });
    const wire = buildAppRequest({
      appId: 'a',
      instanceId: 'i',
      requestId: 'r',
      action: 'chat',
      responseSchema: {
        type: 'object',
        properties: { auth: { type: 'string', default: 'Bearer sk-ant-api03-stolen-key-000' } },
      },
    });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(wire) });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { code: string }).code).toBe('CREDENTIAL_REJECTED');
    expect(calls).toHaveLength(0);
  });

  it("passes a chess app's {token: 'rook'} — key-name-only hits are warnings, never rejects", async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"reply":"Nf3"}' }]));
    app = await buildTestApp({ adapter });
    const wire = buildAppRequest({
      appId: 'chess',
      instanceId: 'i',
      requestId: 'r',
      action: 'move',
      payload: { token: 'rook' },
    });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(wire) });
    expect(response.statusCode).toBe(200);
    const events = await parseSsePayload(response.payload);
    expect(events.at(-1)?.event).toBe('done');
    expect(calls).toHaveLength(1);
  });
});
