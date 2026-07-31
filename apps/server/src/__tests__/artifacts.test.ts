// Artifact serving (AC5): CSP header byte-exact from the runner (imported, never
// retyped), nosniff, typed 404, oversized writes rejected. Plus store behavior.

import { LIMITS } from '@snugprotocol/protocol';
// Deep import mirrors the route: byte-exact source of truth without the React surface.
import { RUNNER_CSP } from '@snugprotocol/runner/dist/csp.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { createArtifactStore } from '../stores/artifacts.js';
import { createThreadStore } from '../stores/threads.js';
import { buildTestApp } from './helpers.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const HTML = '<!doctype html><html><head><title>Served App</title></head><body>hello</body></html>';

describe('GET /artifacts/:id', () => {
  it('serves HTML with the authoritative runner CSP header, byte-exact, plus nosniff', async () => {
    const artifactStore = createArtifactStore(':memory:');
    const put = artifactStore.put({ html: HTML });
    if (!put.ok) throw new Error('unexpected put failure');
    app = await buildTestApp({ artifactStore });

    const response = await app.inject({ method: 'GET', url: `/artifacts/${put.artifact.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-security-policy']).toBe(RUNNER_CSP);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.payload).toBe(HTML);
  });

  it('returns a typed 404 for an unknown artifact', async () => {
    app = await buildTestApp({ artifactStore: createArtifactStore(':memory:') });
    const response = await app.inject({ method: 'GET', url: '/artifacts/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ code: 'NOT_FOUND', message: 'no such artifact', retryable: false });
  });

  it('lists artifact metadata (no HTML bodies)', async () => {
    const artifactStore = createArtifactStore(':memory:');
    artifactStore.put({ html: HTML, displayName: 'One' });
    app = await buildTestApp({ artifactStore });
    const response = await app.inject({ method: 'GET', url: '/artifacts' });
    const body = response.json() as { artifacts: Array<Record<string, unknown>> };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.displayName).toBe('One');
    expect(body.artifacts[0]!).not.toHaveProperty('html');
  });
});

describe('artifact store', () => {
  it('rejects a write over MAX_ARTIFACT_BYTES with a typed error', () => {
    const store = createArtifactStore(':memory:');
    const oversized = 'a'.repeat(LIMITS.MAX_ARTIFACT_BYTES + 1);
    const result = store.put({ html: oversized });
    expect(result).toMatchObject({ ok: false, code: 'ARTIFACT_TOO_LARGE' });
    expect(store.list()).toHaveLength(0);
    store.close();
  });

  it('accepts a write at exactly the cap', () => {
    const store = createArtifactStore(':memory:');
    const result = store.put({ html: 'a'.repeat(LIMITS.MAX_ARTIFACT_BYTES) });
    expect(result.ok).toBe(true);
    store.close();
  });

  it('derives the display name from <title> when none is given, capped in length', () => {
    const store = createArtifactStore(':memory:');
    const fromTitle = store.put({ html: HTML });
    expect(fromTitle.ok && fromTitle.artifact.displayName).toBe('Served App');
    const longTitle = store.put({ html: HTML, displayName: 'x'.repeat(500) });
    expect(longTitle.ok && longTitle.artifact.displayName.length).toBe(LIMITS.DISPLAY_NAME_CHARS);
    const untitled = store.put({ html: '<p>no title</p>' });
    expect(untitled.ok && untitled.artifact.displayName).toBe('Untitled app');
    store.close();
  });
});

describe('thread store', () => {
  it('caps history at the configured limit, keeping the most recent messages in order', () => {
    const store = createThreadStore(':memory:', { historyCap: 40 });
    for (let i = 1; i <= 45; i++) {
      store.append('t', { role: i % 2 === 1 ? 'user' : 'assistant', content: `message ${i}` });
    }
    const history = store.history('t');
    expect(history).toHaveLength(40);
    expect(history[0]!.content).toBe('message 6');
    expect(history.at(-1)!.content).toBe('message 45');
    store.close();
  });

  it('keeps threads isolated', () => {
    const store = createThreadStore(':memory:');
    store.append('a', { role: 'user', content: 'in a' });
    expect(store.history('b')).toEqual([]);
    store.close();
  });
});
