// Builder chat streams — server mode consumes the /invoke SSE contract
// (delta/artifact/done/error + heartbeats); BYOK mode synthesizes the same events
// from an in-browser agent turn. Plus the AC-5 spy: the BYOK key never travels to
// the reference server.

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createByokBuilder, createServerBuilder, type ArtifactEvent } from '../agent/builder.js';
import { DEMO_APP_TITLE } from '../agent/demoApp.js';
import { createByokLibrary } from '../state/library.js';
import { setByokKey } from '../state/mode.js';

function sseResponse(blocks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createServerBuilder', () => {
  it('dispatches delta, artifact, and done events from a scripted SSE stream', async () => {
    const fetchSpy = vi.fn(async () =>
      sseResponse([
        'event: delta\ndata: {"text":"buil"}\n\n',
        ':hb\n\n', // heartbeat comment — tolerated
        'event: delta\ndata: {"text":"ding…"}\n\n',
        'event: artifact\ndata: {"artifactId":"art-9","displayName":"tic-tac-toe"}\n\n',
        'event: done\ndata: {"text":"building… done"}\n\n',
      ]),
    );
    const builder = createServerBuilder('thr-1', fetchSpy);
    const deltas: string[] = [];
    const artifacts: ArtifactEvent[] = [];
    const result = await builder.send(
      'build me tic-tac-toe',
      { onDelta: (d) => deltas.push(d), onArtifact: (a) => artifacts.push(a) },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, text: 'building… done' });
    expect(deltas).toEqual(['buil', 'ding…']);
    expect(artifacts).toEqual([{ artifactId: 'art-9', displayName: 'tic-tac-toe' }]);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ message: 'build me tic-tac-toe', threadId: 'thr-1' });
  });

  it('surfaces typed SSE error events', async () => {
    const builder = createServerBuilder('thr-1', async () =>
      sseResponse(['event: error\ndata: {"code":"RATE_LIMITED","message":"slow down","retryable":true}\n\n']),
    );
    const result = await builder.send('x', {}, new AbortController().signal);
    expect(result).toEqual({ ok: false, code: 'RATE_LIMITED', message: 'slow down', retryable: true });
  });

  it('maps non-200 JSON bodies (409 conflict) to typed errors', async () => {
    const builder = createServerBuilder('thr-1', async () =>
      new Response(JSON.stringify({ code: 'THREAD_CONFLICT', message: 'busy', retryable: true }), { status: 409 }),
    );
    const result = await builder.send('x', {}, new AbortController().signal);
    expect(result).toEqual({ ok: false, code: 'THREAD_CONFLICT', message: 'busy', retryable: true });
  });

  it('never sends the BYOK key to the reference server (AC-5 spy)', async () => {
    setByokKey('sk-ant-supersecret-42');
    const fetchSpy = vi.fn(async () => sseResponse(['event: done\ndata: {"text":"ok"}\n\n']));
    const builder = createServerBuilder('thr-1', fetchSpy);
    await builder.send('hello', {}, new AbortController().signal);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/invoke');
    expect(JSON.stringify(init.headers)).not.toContain('sk-ant-supersecret-42');
    expect(String(init.body)).not.toContain('sk-ant-supersecret-42');
  });
});

describe('createByokBuilder (demo brain)', () => {
  it('runs fully in-browser: artifact saved locally, events synthesized, no network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));
    const library = createByokLibrary(new IDBFactory());
    const builder = createByokBuilder({ provider: 'mock', library, getKey: () => undefined });

    const artifacts: ArtifactEvent[] = [];
    const activity: string[] = [];
    let streamed = '';
    const result = await builder.send(
      'build me tic-tac-toe',
      {
        onDelta: (delta) => {
          streamed += delta;
        },
        onArtifact: (artifact) => artifacts.push(artifact),
        onActivity: (label) => activity.push(label),
      },
      new AbortController().signal,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe(streamed);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.displayName).toBe(DEMO_APP_TITLE);
    expect(activity).toEqual(['consulting the knowledge base…', 'writing the app file…']);
    // The artifact is really in the local library, runnable.
    const html = await library.getHtml(artifacts[0]?.artifactId ?? '');
    expect(html).toContain('<!DOCTYPE html>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
