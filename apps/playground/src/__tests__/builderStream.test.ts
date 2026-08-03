// Builder chat streams — subscription mode consumes the /invoke SSE contract
// (delta/artifact/done/error + heartbeats); direct mode synthesizes the same events
// from an in-browser agent turn. Plus the AC-5 spy: the BYOK key never travels to
// the hub server.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppTargetSink } from '../agent/artifactSink.js';
import { createDirectBuilder, createServerBuilder, type ArtifactEvent } from '../agent/builder.js';
import { DEMO_APP_TITLE } from '../agent/demoApp.js';
import { setByokKey } from '../state/mode.js';
import { installTestUserDb } from './userdbTestHelper.js';

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

  it('forwards the subscription-mode model choice in the body', async () => {
    const fetchSpy = vi.fn(async () => sseResponse(['event: done\ndata: {"text":"ok"}\n\n']));
    const builder = createServerBuilder('thr-1', fetchSpy, 'claude-sonnet-5');
    await builder.send('hello', {}, new AbortController().signal);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ message: 'hello', threadId: 'thr-1', model: 'claude-sonnet-5' });
  });

  it('never sends the BYOK key to the hub server (AC-5 spy)', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-ant-supersecret-42');
    const fetchSpy = vi.fn(async () => sseResponse(['event: done\ndata: {"text":"ok"}\n\n']));
    const builder = createServerBuilder('thr-1', fetchSpy);
    await builder.send('hello', {}, new AbortController().signal);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/invoke');
    expect(JSON.stringify(init.headers)).not.toContain('sk-ant-supersecret-42');
    expect(String(init.body)).not.toContain('sk-ant-supersecret-42');
  });
});

describe('createDirectBuilder (demo brain)', () => {
  it('F15 guard: refuses the turn while endpoint settings are unconfirmed — key untouched', async () => {
    const db = await installTestUserDb();
    const getKey = vi.fn(() => Promise.resolve('sk-should-not-be-read'));
    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: createAppTargetSink({ getDb: () => Promise.resolve(db) }),
      getKey,
      needsConfirm: () => true,
    });
    const result = await builder.send('build me anything', {}, new AbortController().signal);
    expect(result).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED', retryable: false });
    expect(getKey).not.toHaveBeenCalled();
  });

  it('runs fully in-browser: artifact saved into the user DB, events synthesized, no network', async () => {
    const db = await installTestUserDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network must not be touched'));
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'mock',
      sink,
      getKey: () => Promise.resolve(undefined),
    });

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
    const html = db.getAppHtml(artifacts[0]?.artifactId ?? '');
    expect(html).toContain('<!DOCTYPE html>');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
