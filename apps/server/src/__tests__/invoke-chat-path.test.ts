// Chat path (AC3): scripted mock calls snug_app_builder then artifact_write —
// KB sections are served to the model, the artifact is persisted, and the SSE
// artifact/done events arrive in order. Plus thread history behavior.

import { mockAdapter } from '@snugprotocol/adapters';
import { APP_BUILDER_TOOL_NAME, searchKnowledge } from '@snugprotocol/knowledge';
import { LIMITS } from '@snugprotocol/protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createArtifactStore } from '../stores/artifacts.js';
import { createThreadStore } from '../stores/threads.js';
import { ARTIFACT_WRITE_TOOL_NAME } from '../tools.js';
import { buildTestApp, invokeBody, parseSsePayload, spyAdapter } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const APP_HTML = '<!doctype html><html><head><title>Test App</title></head><body>hi</body></html>';

function chatScript() {
  return [
    { text: '', toolCalls: [{ name: APP_BUILDER_TOOL_NAME, input: { query: 'template' } }] },
    { text: '', toolCalls: [{ name: ARTIFACT_WRITE_TOOL_NAME, input: { content: APP_HTML, title: 'My App' } }] },
    { deltas: ['Here ', 'you go'], text: 'Here you go' },
  ];
}

describe('POST /invoke — chat path', () => {
  it('serves KB sections to the model, persists the artifact, and orders artifact before done', async () => {
    const artifactStore = createArtifactStore(':memory:');
    const { calls, adapter } = spyAdapter(mockAdapter(chatScript()));
    app = await buildTestApp({ adapter, artifactStore });

    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('build me an app', 't1') });
    expect(response.statusCode).toBe(200);

    // Tools were offered (both, from the knowledge store)
    expect(calls[0]!.tools?.map((tool) => tool.name)).toEqual([APP_BUILDER_TOOL_NAME, ARTIFACT_WRITE_TOOL_NAME]);

    // KB sections reached the model as the tool result of the app-builder call
    const secondCallToolMessages = calls[1]!.messages.filter((message) => message.role === 'tool');
    expect(secondCallToolMessages).toHaveLength(1);
    const expectedSection = searchKnowledge('template')[0]!;
    expect(secondCallToolMessages[0]!.content).toContain(expectedSection.text.slice(0, 60));

    // Artifact persisted, within the size cap
    const stored = artifactStore.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.displayName).toBe('My App');
    expect(stored[0]!.bytes).toBeLessThanOrEqual(LIMITS.MAX_ARTIFACT_BYTES);

    // SSE: artifact event (with id + displayName) strictly before done
    const events = await parseSsePayload(response.payload);
    const names = events.map((event) => event.event);
    const artifactIndex = names.indexOf('artifact');
    const doneIndex = names.indexOf('done');
    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBe(names.length - 1);
    expect(artifactIndex).toBeLessThan(doneIndex);
    const artifactEvent = JSON.parse(events[artifactIndex]!.data) as { artifactId: string; displayName: string };
    expect(artifactEvent.displayName).toBe('My App');
    expect(artifactEvent.artifactId).toBe(stored[0]!.id);
    expect(JSON.parse(events[doneIndex]!.data)).toEqual({ text: 'Here you go', stopReason: 'end' });
  });

  it('appends the user and assistant turns to the thread and feeds capped history back on the next turn', async () => {
    const threadStore = createThreadStore(':memory:', { historyCap: 4 });
    const first = spyAdapter(mockAdapter([{ text: 'reply one' }, { text: 'reply two' }]));
    app = await buildTestApp({ adapter: first.adapter, threadStore });

    await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('message one', 'th') });
    expect(threadStore.history('th')).toEqual([
      { role: 'user', content: 'message one' },
      { role: 'assistant', content: 'reply one' },
    ]);

    await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('message two', 'th') });
    expect(first.calls[1]!.messages).toEqual([
      { role: 'user', content: 'message one' },
      { role: 'assistant', content: 'reply one' },
      { role: 'user', content: 'message two' },
    ]);
  });

  it('does not persist anything on adapter failure and reports the error as an SSE event', async () => {
    const threadStore = createThreadStore(':memory:');
    const adapter = mockAdapter([{ text: '', error: { code: 'NETWORK_ERROR', message: 'provider down', retryable: true } }]);
    app = await buildTestApp({ adapter, threadStore });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('hello', 'tf') });
    expect(response.statusCode).toBe(200); // stream already started — error travels as an event
    const events = await parseSsePayload(response.payload);
    expect(events.at(-1)?.event).toBe('error');
    expect(JSON.parse(events.at(-1)!.data)).toEqual({ code: 'NETWORK_ERROR', message: 'provider down', retryable: true });
    expect(threadStore.history('tf')).toEqual([]);
  });

  it('runs without a threadId (ephemeral turn, nothing persisted)', async () => {
    const threadStore = createThreadStore(':memory:');
    const { calls, adapter } = spyAdapter(mockAdapter([{ text: 'ok' }]));
    app = await buildTestApp({ adapter, threadStore });
    const response = await app.inject({ method: 'POST', url: '/invoke', payload: invokeBody('hi') });
    expect(response.statusCode).toBe(200);
    expect(calls[0]!.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});
