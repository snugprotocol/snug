// createHttpTransport — the runner AgentTransport client. Fixture SSE only, no network.
import type { AgentTransport } from '@snugprotocol/runner';
import { describe, expect, it } from 'vitest';

import { createHttpTransport } from '../http-transport.js';
import { abortErrorStream, block, fakeFetch, sseResponse } from './helpers.js';

const HAPPY =
  ':hb\n\n' +
  block('delta', '{"text":"Hel"}') +
  block('delta', '{"text":"lo"}') +
  block('artifact', '{"artifactId":"a1","displayName":"App"}') +
  block('done', '{"text":"Hello"}');

describe('createHttpTransport', () => {
  it('conforms to the runner AgentTransport contract (compile-time check)', () => {
    const transport: AgentTransport = createHttpTransport('http://localhost/invoke');
    expect(typeof transport.send).toBe('function');
  });

  it('POSTs the wire string with threadId, streams deltas, and resolves the done text', async () => {
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(HAPPY));
    const transport = createHttpTransport('http://localhost/invoke', { threadId: 't1', fetch: fetchImpl });
    const deltas: string[] = [];
    const result = await transport.send('[SNUG_APP_REQUEST]\n{}', {
      signal: new AbortController().signal,
      onDelta: (d) => deltas.push(d),
    });
    expect(calls[0]!.url).toBe('http://localhost/invoke');
    expect(calls[0]!.headers.accept).toBe('text/event-stream');
    expect(calls[0]!.bodyJson).toEqual({ message: '[SNUG_APP_REQUEST]\n{}', threadId: 't1' });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(result).toEqual({ ok: true, text: 'Hello' });
  });

  /**
   * R-B2 (2026-08-11): `getContract()` was awaited into a local and then never referenced,
   * so the POST body carried no `contract` field. F1 was silently inert for every
   * subscription user — apps ran on bare generic layers with no error and no UI signal.
   *
   * It survived because no test crossed THIS seam: the server route had 16 passing tests
   * for a field the client never sent, and the playground's contract tests cover only the
   * direct (byok/local) transport. A green suite on each side of a seam says nothing about
   * the seam.
   */
  it('sends the resolved runtime contract in the POST body (R-B2)', async () => {
    const contract = { overview: 'A chess app. Reply with one legal move.' };
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(HAPPY));
    const transport = createHttpTransport('http://x/invoke', {
      fetch: fetchImpl,
      getContract: () => Promise.resolve(contract),
    });

    await transport.send('hi', { signal: new AbortController().signal, onDelta: () => {} });

    expect(calls[0]!.bodyJson).toEqual({ message: 'hi', contract });
  });

  it('omits `contract` entirely for a contract-less app (no null, no empty object)', async () => {
    // The server distinguishes absent from present; a null would be a parse error, and an
    // empty object would render an empty system suffix onto a legacy app's turn.
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(HAPPY));
    const transport = createHttpTransport('http://x/invoke', {
      fetch: fetchImpl,
      getContract: () => Promise.resolve(undefined),
    });

    await transport.send('hi', { signal: new AbortController().signal, onDelta: () => {} });

    expect(calls[0]!.bodyJson).toEqual({ message: 'hi' });
    expect(Object.hasOwn(calls[0]!.bodyJson as object, 'contract')).toBe(false);
  });

  it('reads the contract PER SEND, so an edit or revert between turns is picked up', async () => {
    // The same per-send rule the direct transport follows (F-M1): a contract captured at
    // construction would go stale the moment the user edited or reverted the app.
    const contracts = [{ overview: 'first' }, { overview: 'second' }];
    let call = 0;
    const { calls, fetchImpl } = fakeFetch(() => sseResponse(HAPPY));
    const transport = createHttpTransport('http://x/invoke', {
      fetch: fetchImpl,
      getContract: () => Promise.resolve(contracts[call++]),
    });

    await transport.send('one', { signal: new AbortController().signal, onDelta: () => {} });
    await transport.send('two', { signal: new AbortController().signal, onDelta: () => {} });

    expect((calls[0]!.bodyJson as { contract: unknown }).contract).toEqual({ overview: 'first' });
    expect((calls[1]!.bodyJson as { contract: unknown }).contract).toEqual({ overview: 'second' });
  });

  it('tolerates heartbeats and a malformed block without killing the stream', async () => {
    const body = ':hb\n\n' + block('delta', '{broken json') + block('delta', '{"text":"ok"}') + ':hb\n\n' + block('done', '{"text":"ok"}');
    const { fetchImpl } = fakeFetch(() => sseResponse(body));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const deltas: string[] = [];
    const result = await transport.send('hi', { signal: new AbortController().signal, onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(['ok']);
    expect(result).toEqual({ ok: true, text: 'ok' });
  });

  it('maps HTTP 409 to THREAD_CONFLICT, retryable', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('conflict', { status: 409 }));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const result = await transport.send('hi', { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, code: 'THREAD_CONFLICT', retryable: true });
  });

  it('passes through a typed JSON error body on non-409 failures', async () => {
    const body = JSON.stringify({ code: 'CREDENTIAL_REJECTED', message: 'credential-shaped value', retryable: false });
    const { fetchImpl } = fakeFetch(() => new Response(body, { status: 400 }));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const result = await transport.send('hi', { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, code: 'CREDENTIAL_REJECTED', message: 'credential-shaped value', retryable: false });
  });

  it('maps an SSE error event to an error result honoring retryable', async () => {
    const body = block('error', '{"code":"NETWORK_ERROR","message":"upstream failed","retryable":true}');
    const { fetchImpl } = fakeFetch(() => sseResponse(body));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const result = await transport.send('hi', { signal: new AbortController().signal });
    expect(result).toEqual({ ok: false, code: 'NETWORK_ERROR', message: 'upstream failed', retryable: true });
  });

  it('maps a thrown fetch to NETWORK_ERROR, retryable', async () => {
    const transport = createHttpTransport('http://x/invoke', { fetch: () => Promise.reject(new TypeError('down')) });
    const result = await transport.send('hi', { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, code: 'NETWORK_ERROR', retryable: true });
  });

  it('resolves CANCELLED cleanly (never throws) when aborted mid-stream', async () => {
    const controller = new AbortController();
    const transport = createHttpTransport('http://x/invoke', {
      fetch: (_url, init) =>
        Promise.resolve(new Response(abortErrorStream(init?.signal, block('delta', '{"text":"He"}')), { status: 200 })),
    });
    const result = await transport.send('hi', {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    expect(result).toMatchObject({ ok: false, code: 'CANCELLED', retryable: false });
  });

  it('maps a stream that drops before done to STREAM_DROPPED, retryable', async () => {
    const { fetchImpl } = fakeFetch(() => sseResponse(block('delta', '{"text":"He"}')));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const result = await transport.send('hi', { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: false, code: 'STREAM_DROPPED', retryable: true });
  });

  it('ignores events after the terminal done block (post-settle)', async () => {
    const body = block('done', '{"text":"final"}') + block('delta', '{"text":"late"}');
    const { fetchImpl } = fakeFetch(() => sseResponse(body));
    const transport = createHttpTransport('http://x/invoke', { fetch: fetchImpl });
    const deltas: string[] = [];
    const result = await transport.send('hi', { signal: new AbortController().signal, onDelta: (d) => deltas.push(d) });
    expect(result).toEqual({ ok: true, text: 'final' });
    expect(deltas).toEqual([]);
  });
});
