// App path (AC2): valid envelope → no thread history, JSON-only mode, response-format
// layer present, and the reply streamed RAW — the server never parses it (the runner does).

import { mockAdapter } from '@snugprotocol/adapters';
import { getSystemLayer } from '@snugprotocol/knowledge';
import { buildAppRequest } from '@snugprotocol/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createThreadStore } from '../stores/threads.js';
import { buildTestApp, invokeBody, parseSsePayload, spyAdapter } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const WIRE = buildAppRequest({
  appId: 'chess',
  instanceId: 'i1',
  requestId: 'r1',
  action: 'chat',
  payload: { move: 'e4' },
  state: { fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR' },
});

describe('POST /invoke — app path', () => {
  it('skips thread history even when the thread has messages (envelope is self-contained)', async () => {
    const threadStore = createThreadStore(':memory:');
    threadStore.append('T', { role: 'user', content: 'earlier chat message' });
    threadStore.append('T', { role: 'assistant', content: 'earlier reply' });
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"reply":"Nf3"}' }]));
    app = await buildTestApp({ adapter, threadStore });

    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(WIRE, 'T') });
    expect(response.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: WIRE }]);
    // and the app turn is never persisted into the thread
    expect(threadStore.history('T')).toHaveLength(2);
  });

  it('runs JSON-only: the adapter receives no tools', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"reply":"ok"}' }]));
    app = await buildTestApp({ adapter });
    await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(WIRE) });
    expect(calls[0]!.tools).toBeNull(); // spy snapshots undefined as null
  });

  it('assembles the system prompt with the response-format layer', async () => {
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: '{"reply":"ok"}' }]));
    app = await buildTestApp({ adapter });
    await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(WIRE) });
    expect(calls[0]!.system).toContain(getSystemLayer('app-response-format').slice(0, 80));
  });

  it('streams the reply raw — fences and prose reach the client byte-exact for the runner to parse', async () => {
    const rawReply = 'Sure!\n```json\n{"reply":"Nf3","state":{"n":1}}\n```\ntrailing prose';
    const { adapter } = spyAdapter(mockAdapter([{ text: rawReply }]));
    app = await buildTestApp({ adapter });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody(WIRE) });
    const events = await parseSsePayload(response.payload);
    const done = events.find((event) => event.event === 'done');
    expect(done).toBeDefined();
    expect(JSON.parse(done!.data)).toEqual({ text: rawReply });
    const deltas = events.filter((e) => e.event === 'delta').map((e) => (JSON.parse(e.data) as { text: string }).text);
    expect(deltas.join('')).toBe(rawReply);
  });
});
