// Long-running builds over the subscription path (TASK-20260803-hub-ops).
//
// Two gaps this covers:
//   AC4 — Fastify left Node's http defaults in place, so a streaming /invoke that
//         outlives requestTimeout (300_000ms = exactly 5 minutes) was torn down by the
//         HTTP server mid-build. App builds are meant to run up to 30 minutes.
//   AC11 — /invoke never passed `onEvent` into runAgentTurn, so the SSE stream carried
//         no tool-progress signal at all: subscription mode showed "it's thinking…"
//         and nothing else for an entire multi-minute build.

import { mockAdapter } from '@snugprotocol/adapters';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { LONG_RUN_MS } from '../app.js';
import { buildTestApp, invokeBody, parseSsePayload, testConfig } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('request lifetimes admit a 30-minute build (AC4)', () => {
  it('overrides the Node defaults that would tear down a long stream', async () => {
    app = await buildTestApp();
    const server = app.server;

    // Node's default requestTimeout is 300_000 (5 min) and headersTimeout 60_000.
    // Inheriting either kills a 30-minute build with no error the client can see.
    expect(LONG_RUN_MS).toBeGreaterThanOrEqual(30 * 60_000);
    expect(server.requestTimeout === 0 || server.requestTimeout >= LONG_RUN_MS).toBe(true);
    expect(server.headersTimeout === 0 || server.headersTimeout >= LONG_RUN_MS).toBe(true);
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(LONG_RUN_MS);
  });
});

describe('subscription-mode progress (AC11)', () => {
  it('emits a step event per tool call so the client can show real progress', async () => {
    // A build that consults the KB, then writes the app, then signs off.
    const adapter = mockAdapter([
      { text: 'checking the template. ', toolCalls: [{ name: 'snug_app_builder', input: { query: 'template' } }] },
      {
        text: 'writing it. ',
        toolCalls: [{ name: 'artifact_write', input: { title: 'Oracle', content: '<!DOCTYPE html><html></html>' } }],
      },
      { text: 'done.' },
    ]);
    app = await buildTestApp({ config: testConfig(), adapter });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      payload: invokeBody('build me an app'),
    });

    const events = await parseSsePayload(response.payload);
    const steps = events.filter((e) => e.event === 'step').map((e) => JSON.parse(e.data) as Record<string, unknown>);

    // One start + one end per tool call, in order, naming the tool.
    expect(steps.map((s) => `${s.phase}:${s.tool}`)).toEqual([
      'start:snug_app_builder',
      'end:snug_app_builder',
      'start:artifact_write',
      'end:artifact_write',
    ]);
    // The stream still terminates normally and keeps its delta/done contract.
    expect(events.some((e) => e.event === 'delta')).toBe(true);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('step events never carry tool inputs or outputs (no prompt content on the wire)', async () => {
    const MARKER = 'SECRET-PROMPT-TEXT-a8f3';
    const adapter = mockAdapter([
      { text: 'x', toolCalls: [{ name: 'snug_app_builder', input: { query: MARKER } }] },
      { text: 'done.' },
    ]);
    app = await buildTestApp({ config: testConfig(), adapter });

    const response = await app.inject({
      method: 'POST',
      url: '/invoke',
      payload: invokeBody('go'),
    });

    const steps = (await parseSsePayload(response.payload)).filter((e) => e.event === 'step');
    expect(steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(steps)).not.toContain(MARKER);
  });
});
