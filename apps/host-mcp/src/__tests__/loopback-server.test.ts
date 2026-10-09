// The loopback data plane, on a real listener (AC2/AC3/AC6/AC8).
//
// These bind an actual ephemeral port and speak real HTTP, because the gate unit tests
// prove the DECISION and this proves the WIRING: a route that forgets to call the gate, a
// header the server never reads, a body limit applied to the wrong route. A test that
// builds its own wiring cannot detect missing wiring.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChatRequest, StreamSink } from '../brains/brain.js';
import { createBrainRegistry } from '../brains/registry.js';
import { buildId, VERSION } from '../build.js';
import { RUNNER_MARKER_HEADER } from '../loopback-gates.js';
import { CLOSE_LINGER_MS, createLoopbackServer, type LoopbackServer } from '../loopback-server.js';
import { createUserFileStore } from '../userdb-fs.js';
import { brainOf, fakeDriver, probed } from './fixtures/fake-brains.js';

const TOKEN = 'c'.repeat(64);
const PAGE = '<!doctype html><title>kit</title>';

let server: LoopbackServer;
let origin: string;
let home: string;

const start = async (over: Partial<Parameters<typeof createLoopbackServer>[0]> = {}): Promise<void> => {
  // ALWAYS an isolated store — and since D-B34 there is no other kind: omitting `store`
  // REFUSES rather than defaulting to the real `~/Snug`. The first run of this file read
  // the developer's own user file and failed the absence case; a later test wrote 2 MiB of
  // zeros over it. A test that can touch real data is a test that can destroy it.
  server = createLoopbackServer({ token: TOKEN, page: () => PAGE, store: createUserFileStore(home), ...over });
  const { port } = await server.listen(0);
  origin = `http://127.0.0.1:${port}`;
};

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'snug-host-srv-'));
  await start();
});
afterEach(async () => {
  await server?.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * ONE ready brain — `claude`, the default — answering with this function. MIGRATED
 * 2026-10-03 (ADR-0071), fixture only: the route used to be handed a brain; it is now handed
 * the registry and asks it which brain answers, so the fake rides in a one-driver registry.
 */
const oneBrain = (stream: (request: ChatRequest, sink: StreamSink) => Promise<void>) => probed([fakeDriver('claude', { create: () => brainOf(stream) })]);

/** A browser-shaped call: same-origin, bearer, Host correct. */
const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, origin, ...(init.headers as Record<string, string> | undefined) },
  });

describe('the real-home guard (D-B34)', () => {
  it('refuses to construct without a store, rather than defaulting to the live ~/Snug', () => {
    // The incident path, closed at its narrowest point: the oversize-body test reached the
    // owner's real user file by passing no store at all. There is now no such call.
    // Cast: the type already refuses this call, so what is under test is the RUNTIME half
    // of the guard — a JS caller, a stale build, an `as any`.
    expect(() => createLoopbackServer({ token: TOKEN, page: () => PAGE } as Parameters<typeof createLoopbackServer>[0])).toThrow(/store/i);
  });
});

describe('binding', () => {
  it('binds loopback only — never 0.0.0.0', async () => {
    expect(server.address().address).toBe('127.0.0.1');
  });

  it('serves the kit page at / without a bearer — it is the page that receives the token', async () => {
    // The page cannot present a bearer it has not been given yet: the token rides in the
    // launch URL's fragment, which the browser never sends. So the DOCUMENT is open and
    // every data-plane route beneath it is not.
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(PAGE);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('sends no CORS headers on any route', async () => {
    const response = await call('/status');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('a late subscriber still learns the brain state (D-B35)', () => {
  it('replays the current status to a page that subscribes AFTER the probe answered', async () => {
    // MEASURED: the probe is kicked off by `runner.start()`, before any browser exists, so
    // its `emit` can land in ZERO subscribers and a fire-and-forget event is simply lost —
    // the chip would keep its boot label forever. A page that arrives later must be told
    // what is already known, so `/events` opens with the current status rather than only
    // promising future ones.
    await server.close();
    await start({ store: createUserFileStore(home), brains: await probed([fakeDriver('claude', { readiness: { state: 'logged-out', detail: 'run `/login`' } })]) });

    const response = await call('/events');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(first, 'the stream must open with what is already known').toContain('logged-out');
  });
});

describe('/oauth/callback (D-B14)', () => {
  it('serves the PAGE at the registered redirect URI, so the popup can deliver its code', async () => {
    // D-B14 puts the web popup path on this binding: the redirect URI is
    // `${origin}/oauth/callback` — a PATH, not a hash route (connectionWizard.ts:2351) —
    // and the provider sends the user's browser there. Without this route the process
    // 404s the popup and every OAuth connection dies at the last step. The document's own
    // boot sees the path and renders the callback page ALONE (apps/host boot, K2) — it used
    // to be claimed here that "the page's own HashRouter takes over", and under a hash router
    // that document rendered the hub, so no sign-in ever completed.
    const response = await fetch(`${origin}/oauth/callback?code=abc&state=xyz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toBe(PAGE);
  });

  it('needs no bearer — the provider’s redirect cannot carry one', async () => {
    // The popup arrives from the IdP with only the query the provider put there. Gating
    // this on the bearer would 401 every real callback.
    const response = await fetch(`${origin}/oauth/callback?code=abc`);
    expect(response.status).toBe(200);
  });
});

describe('the gate is actually wired to every data-plane route', () => {
  it.each(['/status', '/events', '/userdb/user.snug'])('401s %s without a bearer', async (path) => {
    const response = await fetch(`${origin}${path}`, { headers: { origin } });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('');
  });

  it('401s /fetch without a bearer', async () => {
    const response = await fetch(`${origin}/fetch`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  });

  it('403s a foreign Origin even with the right bearer', async () => {
    const response = await fetch(`${origin}/status`, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
  });

  it('404s an unknown path rather than leaking which routes exist', async () => {
    expect((await call('/nope')).status).toBe(404);
  });
});

describe('/status', () => {
  it('reports the runner truthfully', async () => {
    const response = await call('/status');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { binding: string; port: number };
    expect(body.binding).toBe('local-host');
    expect(body.port).toBe(server.address().port);
  });

  it('never includes the bearer', async () => {
    expect(await (await call('/status')).text()).not.toContain(TOKEN);
  });

  // MIGRATED 2026-10-03 (ADR-0071, the wire): the brain's state used to ride a top-level
  // `brain` field; it is now that brain's entry in `brains[]`. Same claims, new address.
  it('reports the BRAIN’s state, so the page can name it instead of failing at the first think (D-B35)', async () => {
    await server.close();
    await start({ store: createUserFileStore(home), brains: await probed([fakeDriver('claude', { readiness: { state: 'logged-out', detail: 'run `claude` and `/login`' } })]) });
    const body = (await (await call('/status')).json()) as { active?: string; brains: Array<{ id: string; state: string; detail?: string }> };
    expect(body.brains[0]?.state).toBe('logged-out');
    expect(body.brains[0]?.detail).toMatch(/login/i);
    expect(body.active, 'a brain that is not ready is not the active one').toBeUndefined();
  });

  it('reports a ready brain plainly', async () => {
    await server.close();
    await start({ store: createUserFileStore(home), brains: await probed([fakeDriver('claude')]) });
    const body = (await (await call('/status')).json()) as { active?: string; brains: Array<{ id: string; state: string; detail?: string }> };
    expect(body.brains[0]).toMatchObject({ id: 'claude', state: 'ready' });
    expect(body.brains[0]).not.toHaveProperty('detail');
    expect(body.active).toBe('claude');
  });
});

describe('/fetch', () => {
  it('hands the request to the proxy and returns its envelope', async () => {
    await server.close();
    await start({
      proxy: {
        handle: async () => ({ ok: true as const, status: 200, statusText: 'OK', headers: [['content-type', 'application/json']], bodyBase64: Buffer.from('{"a":1}').toString('base64') }),
      },
    });
    const response = await call('/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://api.example.com/x', method: 'GET', headers: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 200 });
  });

  it('returns a proxy refusal as a 200 envelope, so the page maps the CODE rather than a transport error', async () => {
    // A refusal that arrived as an HTTP 4xx would be indistinguishable from a gate refusal
    // at the page's fetch seam; the code is what the executor needs to name the failure.
    await server.close();
    await start({ proxy: { handle: async () => ({ ok: false as const, code: 'NET_INVALID_REQUEST' as const, message: 'refused' }) } });
    const response = await call('/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://127.0.0.1/x', method: 'GET', headers: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, code: 'NET_INVALID_REQUEST' });
  });

  it('refuses a malformed request body by name', async () => {
    const response = await call('/fetch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
    expect(response.status).toBe(400);
  });
});

describe('/userdb', () => {
  it('404s an absent file — and ONLY absence is a 404', async () => {
    const response = await call('/userdb/user.snug');
    expect(response.status).toBe(404);
  });

  it('round-trips bytes', async () => {
    const put = await call('/userdb/user.snug', { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect(put.status).toBe(204);
    const got = await call('/userdb/user.snug');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('round-trips EVERY byte value, including a real SQLite header — the file is binary, not text', async () => {
    // A response written as a JS string is encoded on the way out, and a UTF-8 encoder
    // replaces every byte above 0x7F with U+FFFD. That corrupts a SQLite file silently:
    // the header survives, so it still "looks complete", and the damage appears later as
    // an unreadable database. This drives all 256 values through the round trip.
    const bytes = new Uint8Array(256 + 16);
    bytes.set(new TextEncoder().encode('SQLite format 3\0'), 0);
    for (let i = 0; i < 256; i += 1) bytes[16 + i] = i;
    const put = await call('/userdb/user.snug', { method: 'PUT', body: bytes });
    expect(put.status).toBe(204);
    const got = await call('/userdb/user.snug');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it('refuses an unsafe file name', async () => {
    expect((await call('/userdb/..%2fetc%2fpasswd')).status).toBe(400);
  });

  it('423s every write while the file is held, so the page can refuse to open rather than lose work', async () => {
    await server.close();
    await start({ heldBy: () => 'Snug for Mac' });
    const put = await call('/userdb/user.snug', { method: 'PUT', body: new Uint8Array([1]) });
    expect(put.status).toBe(423);
    const status = (await (await call('/status')).json()) as { heldBy?: string };
    expect(status.heldBy).toBe('Snug for Mac');
  });

  it('accepts a body far larger than the proxy cap — a user file is not a provider response', async () => {
    // D-B27: sharing the 1 MiB proxy cap here would silently 413 a real user file into the
    // db's swallowed-save path.
    const big = new Uint8Array(2 * 1024 * 1024);
    expect((await call('/userdb/user.snug', { method: 'PUT', body: big })).status).toBe(204);
  });
});

describe('/events', () => {
  it('streams hand-ins to the page', async () => {
    const response = await call('/events');
    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // The stream opens with a comment frame (`: open`) that keeps proxies from buffering;
    // read until the event itself arrives rather than assuming which chunk carries it.
    let text = '';
    server.emit('hand-in', { bundle: { lineage: 'abc' } });
    while (!text.includes('hand-in')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain('hand-in');
    expect(text).toContain('abc');
    await reader.cancel();
  });
});

describe('the page the process serves', () => {
  it('is the real runner, not the placeholder — found by the ONE locator, in the repo layout', async () => {
    // The placeholder is what a MISSING page looks like, and it serves with HTTP 200 — so a
    // wrong lookup path is invisible unless something asserts on the bytes. Found exactly
    // that way: the repo-relative fallback climbed one directory too few.
    //
    // MIGRATED 2026-10-03 (K1). It used to read the second build's output by a path of its
    // own and RETURN when that build was absent, which is a pass nobody earned. It now asks
    // `locatePage` from where the bundle is built, and a missing kit build fails BY NAME
    // (turbo builds `host` before this suite — turbo.json).
    const { locatePage } = await import('../page.js');
    const nodePath = await import('node:path');
    const found = locatePage(nodePath.resolve(__dirname, '../../dist'));
    const built = nodePath.resolve(__dirname, '../../../host/dist/snug-host.html');
    expect(found.damaged, 'the repo build must carry no pin that disagrees with it').toBe(false);
    if (found.damaged) return;
    expect(found.file, 'apps/host/dist/snug-host.html is missing — run `pnpm --filter host build` before this suite').toBe(built);
    expect(found.html.length).toBeGreaterThan(100_000);
    expect(found.html).not.toContain('is missing from this install');
  });
});

describe('the chat route STREAMS (ADR-0069 §5, AC6)', () => {
  type Sink = { write(chunk: string): void; signal?: AbortSignal };
  const readAll = async (response: Response): Promise<string> => await response.text();
  const post = async (brain: { stream(request: never, sink: Sink): Promise<void> }, init: RequestInit = {}) => {
    await start({ store: createUserFileStore(home), brains: await oneBrain((request, sink) => brain.stream(request as never, sink)) });
    return call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), ...init });
  };

  it('writes each chunk as it arrives and ends after the finish', async () => {
    const response = await post({
      async stream(_request, sink) {
        sink.write('data: {"choices":[{"delta":{"content":"a"},"finish_reason":null}]}\n\n');
        await new Promise((r) => setTimeout(r, 5));
        sink.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        sink.write('data: [DONE]\n\n');
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = await readAll(response);
    expect(body.indexOf('"content":"a"')).toBeLessThan(body.indexOf('"finish_reason":"stop"'));
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('a failure AFTER a delta closes the stream with no finish — the page reads a dropped stream, never a complete answer', async () => {
    const response = await post({
      async stream(_request, sink) {
        sink.write('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
        throw new Error('your Claude CLI stopped answering for 60s');
      },
    });
    expect(response.status).toBe(200);
    const body = await readAll(response);
    expect(body).toContain('"content":"partial"');
    expect(body).not.toContain('finish_reason":"stop"');
    expect(body).not.toContain('[DONE]');
  });

  it('a failure BEFORE any delta is a 502 the page can read', async () => {
    const response = await post({
      async stream() {
        throw new Error('Not logged in · Please run /login');
      },
    });
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/login/);
  });

  it('a body that is not a chat request is a 400, not a spawn', async () => {
    let spawned = false;
    const response = await post(
      {
        async stream() {
          spawned = true;
        },
      },
      { body: JSON.stringify({ nope: true }) },
    );
    expect(response.status).toBe(400);
    expect(spawned).toBe(false);
  });

  it('the page aborting its fetch aborts the brain’s signal', async () => {
    let aborted = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await start({
      store: createUserFileStore(home),
      brains: await oneBrain(async (_request, sink) => {
        sink.signal?.addEventListener('abort', () => {
          aborted = true;
          release();
        });
        sink.write(': open\n\n');
        await gate;
      }),
    });
    const controller = new AbortController();
    const pending = call('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pending.catch(() => {});
    await gate;
    expect(aborted).toBe(true);
  });
});

describe('the chat route refuses a malformed message entry before anything is spawned', () => {
  it('a message with no role, or a numeric content, is a 400', async () => {
    let spawned = false;
    await start({ store: createUserFileStore(home), brains: await oneBrain(async () => void (spawned = true)) });
    for (const messages of [[null], [{ role: 'user', content: 42 }], [{ content: 'x' }]]) {
      const response = await call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
      expect(response.status, JSON.stringify(messages)).toBe(400);
    }
    expect(spawned).toBe(false);
  });
});

describe('the chat route validates the user’s choice at the envelope boundary (review, 2026-10-03; C5)', () => {
  const streamed: unknown[] = [];
  const stream = async (request: ChatRequest, sink: { write(chunk: string): void }): Promise<void> => {
    streamed.push(request);
    sink.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    sink.write('data: [DONE]\n\n');
  };
  const send = async (extra: Record<string, unknown>) => {
    await start({ store: createUserFileStore(home), brains: await oneBrain(stream) });
    return call('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...extra }),
    });
  };

  it('refuses a non-string model with 400 — it once reached argv building and threw a TypeError', async () => {
    streamed.length = 0;
    const response = await send({ model: 5 });
    expect(response.status).toBe(400);
    expect(streamed).toEqual([]);
  });

  it('refuses a model id that could read as a FLAG, naming it — argv safety must not rest on the CLI’s parser', async () => {
    streamed.length = 0;
    const response = await send({ model: '--dangerous-flag' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('--dangerous-flag');
    expect(streamed).toEqual([]);
  });

  it('refuses a model id carrying whitespace or a control character', async () => {
    expect((await send({ model: 'claude sonnet' })).status).toBe(400);
    expect((await send({ model: 'claude\u0000x' })).status).toBe(400);
  });

  it('refuses a non-string effort with 400', async () => {
    expect((await send({ effort: ['max'] })).status).toBe(400);
  });

  it('still accepts every real id shape — aliases, dated ids, the context suffix', async () => {
    for (const model of ['claude', 'sonnet', 'claude-haiku-4-5-20251001', 'claude-opus-5-5[1m]']) {
      expect((await send({ model, effort: 'low' })).status, model).toBe(200);
    }
  });
});

// MIGRATED 2026-10-03 (ADR-0071, the wire): the model list used to be a top-level `models`
// of `{ id, name, effort: boolean }`; it is now each brain's own `models`, each with the
// thinking levels THAT model has. "Always present, possibly empty" holds one level up too.
describe('/status carries each brain’s model list (S9)', () => {
  it('`brains` is always present, and empty when the runner was given none', async () => {
    const status = (await (await call('/status')).json()) as { brains?: unknown };
    expect(status.brains).toEqual([]);
  });

  it('a brain with no catalogue carries an EMPTY list — the page’s signal to keep free text', async () => {
    await server.close();
    await start({ brains: await probed([fakeDriver('claude')]) });
    const status = (await (await call('/status')).json()) as { brains: Array<{ models: unknown; efforts: unknown }> };
    expect(status.brains[0]).toMatchObject({ models: [], efforts: [] });
  });

  it('carries what the driver read', async () => {
    const catalog = { efforts: ['low', 'max'], models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: ['low', 'max'] }, { id: 'claude-haiku-4-5', name: 'Haiku 4.5', efforts: [] }] };
    await server.close();
    await start({ brains: await probed([fakeDriver('claude', { catalog: () => catalog })]) });
    const status = (await (await call('/status')).json()) as { brains: Array<{ models: unknown; efforts: unknown }> };
    expect(status.brains[0]).toMatchObject(catalog);
  });

  it('is re-read on every ask — a CLI update between two page loads needs no restart', async () => {
    let models = [{ id: 'old', name: 'Old', efforts: [] as string[] }];
    await server.close();
    await start({ brains: await probed([fakeDriver('claude', { catalog: () => ({ efforts: [], models }) })]) });
    models = [{ id: 'new', name: 'New', efforts: [] }];
    const status = (await (await call('/status')).json()) as { brains: Array<{ models: Array<{ id: string }> }> };
    expect(status.brains[0]!.models[0]!.id).toBe('new');
  });
});

// ------------------------------------------------------------------ the lifecycle range
// (TASK-20261003: the marker header, the lazy first contact, a stop that loses no write.)

describe('a gate refusal says "a Snug runner refused you" — and nothing more', () => {
  // The kit page is one build for every binding (ADR-0072), so at `http://127.0.0.1` it has
  // to tell "a runner that will not let me in" (→ "open it from your agent") from "a static
  // server that has no /status" (→ a plain file). The marker is that difference. It is ONE
  // constant on EVERY refusal, so it tells a prober which process this is — which the open
  // document at `/` already does — and nothing about which half of the gate it got right.

  it.each(['/status', '/events', '/userdb/user.snug', '/fetch', '/v1/chat/completions', '/nope'])('a 401 on %s carries x-snug-runner: 1', async (route) => {
    const response = await fetch(`${origin}${route}`, { headers: { origin } });
    expect(response.status).toBe(401);
    expect(response.headers.get(RUNNER_MARKER_HEADER)).toBe('1');
    expect(await response.text()).toBe('');
  });

  it('a 403 carries the SAME header, byte for byte — the status is the only thing that differs', async () => {
    const refused = await fetch(`${origin}/status`, { headers: { origin } });
    const foreign = await fetch(`${origin}/status`, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' } });
    const preflight = await fetch(`${origin}/status`, { method: 'OPTIONS', headers: { origin } });
    expect(foreign.status).toBe(403);
    expect(preflight.status).toBe(403);
    const marker = (response: Response): string | null => response.headers.get(RUNNER_MARKER_HEADER);
    expect([marker(refused), marker(foreign), marker(preflight)]).toEqual(['1', '1', '1']);
  });

  it('is not a CORS header and exposes none — a foreign page still cannot read it', async () => {
    const response = await fetch(`${origin}/status`, { headers: { origin: 'https://evil.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-expose-headers')).toBeNull();
  });
});

describe('the first page contact (B1: probes are lazy)', () => {
  it('is announced ONCE, by the first AUTHENTICATED request — never by the document or a refusal', async () => {
    await server.close();
    let contacts = 0;
    await start({ onFirstContact: () => void (contacts += 1) });
    await fetch(`${origin}/`);
    await fetch(`${origin}/oauth/callback?code=x`);
    await fetch(`${origin}/status`, { headers: { origin } }); // 401
    await fetch(`${origin}/status`, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' } }); // 403
    expect(contacts, 'an anonymous request must not start the brain probe — it spawns the user’s CLI').toBe(0);
    await call('/status');
    await call('/status');
    await call('/userdb/user.snug');
    expect(contacts).toBe(1);
  });

  it('is waited for, so what it learns rides the very answer that triggered it', async () => {
    await server.close();
    // MIGRATED 2026-10-03 (the wire): what the first contact learns is a brain's verdict,
    // which now rides `brains[]`.
    const registry = createBrainRegistry({
      drivers: [
        fakeDriver('claude', {
          probe: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { state: 'absent', detail: 'install it' };
          },
        }),
      ],
    });
    await start({ brains: registry, onFirstContact: () => registry.probe() });
    const body = (await (await call('/status')).json()) as { brains: Array<{ state: string }> };
    expect(body.brains[0]?.state).toBe('absent');
  });

  it('a first contact that throws does not fail the request', async () => {
    await server.close();
    await start({
      onFirstContact: () => {
        throw new Error('probe blew up');
      },
    });
    expect((await call('/status')).status).toBe(200);
  });
});

describe('stopping loses no write (L4)', () => {
  /** A store whose write is held open until the test lets it finish. */
  const slowStore = () => {
    const inner = createUserFileStore(home);
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const began = new Promise<void>((resolve) => (entered = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    return {
      began,
      release: () => release(),
      store: {
        read: inner.read,
        write: async (name: string, bytes: Uint8Array) => {
          entered();
          await gate;
          await inner.write(name, bytes);
        },
      },
    };
  };
  const put = (bytes: string): Promise<Response> => call('/userdb/user.snug', { method: 'PUT', body: bytes });

  it('drainWrites waits for a write that is already in flight, and that write lands', async () => {
    await server.close();
    const slow = slowStore();
    await start({ store: slow.store });
    const writing = put('the user’s last edit');
    await slow.began;

    let drained = false;
    const draining = server.drainWrites(5_000).then(() => void (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(drained, 'the drain returned while a write was still in flight').toBe(false);

    slow.release();
    await draining;
    expect((await writing).status).toBe(204);
    expect(Buffer.from((await createUserFileStore(home).read('user.snug'))!).toString('utf8')).toBe('the user’s last edit');
  });

  it('refuses a write that arrives AFTER the drain began — said, with the marker, never half-taken', async () => {
    await server.drainWrites(1_000);
    const response = await put('too late');
    expect(response.status).toBe(503);
    expect(response.headers.get(RUNNER_MARKER_HEADER)).toBe('1');
    expect(await createUserFileStore(home).read('user.snug')).toBeUndefined();
    // Reading is still answered: nothing about a read can be lost.
    expect((await call('/userdb/user.snug')).status).toBe(404);
  });

  it('gives up at its bound rather than holding the exit for a write that never finishes', async () => {
    await server.close();
    const slow = slowStore();
    await start({ store: slow.store });
    void put('stuck').catch(() => {});
    await slow.began;
    const began = Date.now();
    await server.drainWrites(120);
    expect(Date.now() - began).toBeLessThan(2_000);
    slow.release();
  });

  it('close() does not wait for ever on a response that is still streaming', async () => {
    await server.close();
    await start({
      brains: await oneBrain(async (_request, sink) => {
        sink.write(': open\n\n');
        await new Promise(() => {}); // a model that never finishes
      }),
    });
    const streaming = call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
    const response = await streaming;
    expect(response.status).toBe(200);
    const began = Date.now();
    await server.close();
    expect(Date.now() - began).toBeLessThan(CLOSE_LINGER_MS + 2_000);
    await response.text().catch(() => {});
  });
});

// ------------------------------------------------------------------ the one-kit range
// (TASK-20261003 R2: the redirect fact on /status, the hand-in outcome, the brain re-check.)

describe('/status says whether an OAuth redirect can come back here (ADR-0068 D-B13)', () => {
  const redirect = async (): Promise<unknown> => ((await (await call('/status')).json()) as { oauthRedirect?: unknown }).oauthRedirect;

  it('is always a boolean, and FALSE unless the runner says the registered port was bound', async () => {
    // The registered redirect URI names the fixed port; a runner that fell back to another
    // port must not let the page offer a sign-in that can never return. So absence of the
    // fact is "no", never "yes".
    expect(await redirect()).toBe(false);
    await server.close();
    await start({ oauthRedirect: () => true });
    expect(await redirect()).toBe(true);
    await server.close();
    await start({ oauthRedirect: () => false });
    expect(await redirect()).toBe(false);
  });

  it('is the field the wire fixture names — the page’s client and this route read ONE shape', async () => {
    const { readFileSync } = await import('node:fs');
    const wire = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'status-wire.json'), 'utf8')) as Record<string, unknown>;
    expect(typeof wire.oauthRedirect).toBe('boolean');
    const body = (await (await call('/status')).json()) as Record<string, unknown>;
    for (const key of ['binding', 'port', 'pages', 'oauthRedirect', 'version', 'build']) expect(typeof body[key], key).toBe(typeof wire[key]);
  });
});

describe('POST /hand-in/outcome — the page says what it did with a bundle (K6)', () => {
  const ID = 'a'.repeat(32);
  const seen: unknown[] = [];
  const post = (body: unknown, init: RequestInit = {}): Promise<Response> =>
    call('/hand-in/outcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init });

  beforeEach(async () => {
    seen.length = 0;
    await server.close();
    await start({ onHandInOutcome: (report) => void seen.push(report) });
  });

  it('hands a well-formed report to the runner and answers 204', async () => {
    expect((await post({ id: ID, outcome: 'installed' })).status).toBe(204);
    expect((await post({ id: ID, outcome: 'updated', version: 3 })).status).toBe(204);
    expect((await post({ id: ID, outcome: 'offered' })).status).toBe(204);
    expect((await post({ id: ID, outcome: 'current' })).status).toBe(204);
    expect((await post({ id: ID, outcome: 'refused', reason: 'it asks for a connection' })).status).toBe(204);
    expect(seen).toEqual([
      { id: ID, outcome: 'installed' },
      { id: ID, outcome: 'updated', version: 3 },
      { id: ID, outcome: 'offered' },
      { id: ID, outcome: 'current' },
      { id: ID, outcome: 'refused', reason: 'it asks for a connection' },
    ]);
  });

  it('is bearer-gated like every data-plane route, with the marker', async () => {
    const response = await fetch(`${origin}/hand-in/outcome`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ id: ID, outcome: 'installed' }) });
    expect(response.status).toBe(401);
    expect(response.headers.get(RUNNER_MARKER_HEADER)).toBe('1');
    expect(seen).toEqual([]);
  });

  it.each([
    ['not JSON', '{nope'],
    ['not an object', '[]'],
    ['no id', { outcome: 'installed' }],
    ['an id that is not the runner’s shape', { id: 'chess', outcome: 'installed' }],
    ['an id with a path in it', { id: '../'.repeat(10) + 'ab', outcome: 'installed' }],
    ['an outcome outside the vocabulary', { id: ID, outcome: 'deleted-everything' }],
    ['a reason that is not text', { id: ID, outcome: 'refused', reason: { $ne: 1 } }],
    ['a version that is not a positive integer', { id: ID, outcome: 'updated', version: -1 }],
    ['a version that is not a number', { id: ID, outcome: 'updated', version: '3' }],
  ])('refuses %s with a 400 and tells the runner nothing', async (_label, body) => {
    expect((await post(body)).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it('strips control characters from the reason and caps its length — it ends up in an agent’s context', async () => {
    // The reason is quoted in `snug_hand_in`'s answer, so it reaches a model. A line break
    // or an escape sequence in it could dress page-supplied text up as a new instruction
    // or a second tool result.
    await post({ id: ID, outcome: 'refused', reason: `line one\nline two\u0000\u001b[31m\u0085 end${'x'.repeat(2_000)}` });
    const [report] = seen as Array<{ reason: string }>;
    expect(report!.reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(report!.reason.startsWith('line one line two')).toBe(true);
    expect(report!.reason.length).toBeLessThanOrEqual(500);
  });

  it('caps the body — a report is a few hundred bytes, never a megabyte', async () => {
    const response = await post({ id: ID, outcome: 'refused', reason: 'x'.repeat(64 * 1024) });
    expect(response.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('only POST is a report', async () => {
    expect((await call('/hand-in/outcome')).status).toBe(404);
  });
});

describe('POST /brain/recheck — the page asks for the brain to be probed again (D4)', () => {
  it('tells the runner and answers 202: the verdict arrives as a status event, not in this answer', async () => {
    await server.close();
    let asked = 0;
    await start({ onBrainRecheck: () => void (asked += 1) });
    const response = await call('/brain/recheck', { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(asked).toBe(1);
  });

  it('is bearer-gated — an anonymous request must not be able to spawn the user’s CLI', async () => {
    await server.close();
    let asked = 0;
    await start({ onBrainRecheck: () => void (asked += 1) });
    const response = await fetch(`${origin}/brain/recheck`, { method: 'POST', headers: { origin } });
    expect(response.status).toBe(401);
    expect(asked).toBe(0);
  });

  it('a recheck that throws does not fail the request or leak its reason', async () => {
    await server.close();
    await start({
      onBrainRecheck: () => {
        throw new Error('probe blew up at /Users/someone/.claude');
      },
    });
    const response = await call('/brain/recheck', { method: 'POST' });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
});

// ------------------------------------------------------------------ the brain registry range
// (TASK-20261003 R4, ADR-0071: the wire, the body contract, which brain answered.)

describe('the page’s wire: /status and the `status` event are ONE shape (B2)', () => {
  const wire = async (): Promise<Record<string, unknown> & { brains: Array<Record<string, unknown>> }> => {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'status-wire.json'), 'utf8')) as Record<string, unknown> & { brains: Array<Record<string, unknown>> };
  };
  /** Drivers that ARE the fixture's two brains — so what the route writes can be compared with it whole. */
  const driversOf = (fixture: { brains: Array<Record<string, unknown>> }) =>
    fixture.brains.map((brain) =>
      fakeDriver(brain.id as string, {
        name: brain.name as string,
        via: brain.via as string,
        verified: brain.verified as boolean,
        streaming: brain.streaming as boolean,
        maxPromptBytes: brain.maxPromptBytes as number,
        readiness: { state: brain.state as 'ready', ...(typeof brain.detail === 'string' ? { detail: brain.detail } : {}) },
        catalog: () => ({ efforts: brain.efforts as string[], models: brain.models as Array<{ id: string; name: string; efforts: string[] }> }),
      }),
    );

  it('GET /status IS the fixture — the one the page’s client test reads too — but for the facts only this process knows', async () => {
    const fixture = await wire();
    await server.close();
    await start({ brains: await probed(driversOf(fixture)), oauthRedirect: () => true });
    const body = (await (await call('/status')).json()) as Record<string, unknown>;
    expect(body).toEqual({ ...fixture, port: server.address().port, pages: 0, version: VERSION, build: buildId() });
    // Key for key: nothing the fixture does not name, and nothing it names missing.
    expect(Object.keys(body).sort()).toEqual(Object.keys(fixture).sort());
    for (const [index, brain] of fixture.brains.entries()) {
      expect(Object.keys((body.brains as Array<Record<string, unknown>>)[index]!).sort()).toEqual(Object.keys(brain).sort());
    }
  });

  it('the legacy single-brain fields are GONE — the page ships with the process, so there is no older reader', async () => {
    await server.close();
    await start({ brains: await probed([fakeDriver('claude')]) });
    const body = (await (await call('/status')).json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('brain');
    expect(body).not.toHaveProperty('models');
  });

  it('says which build is running — `version` and `build` are the process’s own', async () => {
    const body = (await (await call('/status')).json()) as Record<string, unknown>;
    expect(body.version).toBe(VERSION);
    expect(body.build).toBe(buildId());
  });

  it('the `status` event carries the SAME document as GET /status', async () => {
    const fixture = await wire();
    await server.close();
    await start({ brains: await probed(driversOf(fixture)), oauthRedirect: () => true });
    const response = await call('/events');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const frames = (): string[] => text.split('\n\n').filter((frame) => frame.startsWith('event: status'));
    const until = async (count: number): Promise<void> => {
      while (frames().length < count) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
    };
    await until(1); // the replay a late subscriber gets
    server.emitStatus();
    await until(2);
    const got = (await (await call('/status')).json()) as Record<string, unknown>;
    await reader.cancel();
    for (const frame of frames()) {
      expect(JSON.parse(frame.split('\n')[1]!.slice('data: '.length))).toEqual(got);
    }
    expect(frames()).toHaveLength(2);
  });

  it('a runner with no brains replays nothing on /events — there is nothing to tell', async () => {
    const response = await call('/events');
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value!);
    await reader.cancel();
    expect(first).toBe(': open\n\n');
  });
});

describe('the chat route: which brain answers, on whose choice (B2, B3)', () => {
  type Seen = { brain: string; request: ChatRequest };
  let seen: Seen[];
  let asked: Array<[string, string, string | undefined, string]>;

  /** A brain that answers at once and records the request it was handed. */
  const recording = (id: string) =>
    brainOf(async (request, sink) => {
      seen.push({ brain: id, request });
      sink.write(`data: {"choices":[{"delta":{"content":"from ${id}"},"finish_reason":null}]}\n\n`);
      sink.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      sink.write('data: [DONE]\n\n');
    });

  /** Two brains with DIFFERENT vocabularies, each recording what its validators were asked. */
  const twoBrains = async (over: { claude?: Parameters<typeof fakeDriver>[1]; codex?: Parameters<typeof fakeDriver>[1] } = {}) => {
    seen = [];
    asked = [];
    const vocabulary = (id: string, models: string[], efforts: string[]): Parameters<typeof fakeDriver>[1] => ({
      create: () => recording(id),
      acceptsModel: (model) => {
        asked.push([id, 'model', undefined, model]);
        return models.includes(model);
      },
      acceptsEffort: (model, effort) => {
        asked.push([id, 'effort', model, effort]);
        return efforts.includes(effort);
      },
    });
    await server.close();
    await start({
      brains: await probed([
        fakeDriver('claude', { ...vocabulary('claude', ['claude-sonnet-5-5', 'haiku'], ['low', 'max']), ...over.claude }),
        fakeDriver('codex', { verified: false, ...vocabulary('codex', ['gpt-6-sol'], ['low', 'ultra']), ...over.codex }),
      ]),
    });
  };
  const think = (extra: Record<string, unknown> = {}): Promise<Response> =>
    call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...extra }) });
  const refusal = async (response: Response): Promise<{ message: string; code?: string }> => ((await response.json()) as { error: { message: string; code?: string } }).error;

  it('with no `brain` it is `auto`: the default brain answers, and the answer names it in x-snug-brain', async () => {
    await twoBrains();
    for (const extra of [{}, { brain: 'auto' }]) {
      const response = await think(extra);
      expect(response.status).toBe(200);
      expect(response.headers.get('x-snug-brain')).toBe('claude');
      expect(await response.text()).toContain('from claude');
    }
    expect(seen.map((entry) => entry.brain)).toEqual(['claude', 'claude']);
  });

  it('a pin names ONE brain — and an unverified brain answers exactly that way', async () => {
    await twoBrains();
    const response = await think({ brain: 'codex' });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-snug-brain')).toBe('codex');
    expect(await response.text()).toContain('from codex');
  });

  it('applies ONLY the resolved brain’s entry: `auto` with a codex pref present runs Claude on Claude’s own prefs', async () => {
    await twoBrains();
    const response = await think({ brain: 'auto', prefs: { claude: { model: 'haiku', effort: 'max' }, codex: { model: 'gpt-6-sol', effort: 'ultra' } } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-snug-brain')).toBe('claude');
    expect(seen).toEqual([{ brain: 'claude', request: { messages: [{ role: 'user', content: 'x' }], model: 'haiku', effort: 'max' } }]);
    // Codex's validators were never even asked: its entry was not the one in play.
    expect(asked.every(([brain]) => brain === 'claude')).toBe(true);
  });

  it('…and a pinned Codex runs on Codex’s — never on the choice made for Claude', async () => {
    await twoBrains();
    const response = await think({ brain: 'codex', model: 'claude-sonnet-5-5', effort: 'max', prefs: { claude: { model: 'haiku' }, codex: { effort: 'ultra' } } });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ brain: 'codex', request: { messages: [{ role: 'user', content: 'x' }], effort: 'ultra' } }]);
    expect(asked).toEqual([['codex', 'effort', undefined, 'ultra']]);
  });

  it('an entry that would be REFUSED by its own brain is harmless while another brain answers', async () => {
    await twoBrains();
    // A stale Codex slug in storage must not break every Claude think.
    const response = await think({ prefs: { codex: { model: 'gpt-retired', effort: 'warp' }, hermes: { model: 'whatever' } } });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-snug-brain')).toBe('claude');
  });

  it('top-level `model` / `effort` are the legacy single-brain form: they mean the CLAUDE entry', async () => {
    await twoBrains();
    expect((await think({ model: 'haiku', effort: 'low' })).status).toBe(200);
    expect(seen[0]!.request).toEqual({ messages: [{ role: 'user', content: 'x' }], model: 'haiku', effort: 'low' });
  });

  it('the per-brain form wins over the legacy one, field by field', async () => {
    await twoBrains();
    expect((await think({ model: 'haiku', effort: 'low', prefs: { claude: { effort: 'max' } } })).status).toBe(200);
    expect(seen[0]!.request).toEqual({ messages: [{ role: 'user', content: 'x' }], model: 'haiku', effort: 'max' });
  });

  it('strips the page’s `claude` placeholder ONCE, here — no driver is ever asked whether "claude" is a model', async () => {
    await twoBrains();
    expect((await think({ model: 'claude' })).status).toBe(200);
    expect((await think({ model: 'claude', brain: 'codex' })).status).toBe(200);
    expect(seen.map((entry) => entry.request)).toEqual([{ messages: [{ role: 'user', content: 'x' }] }, { messages: [{ role: 'user', content: 'x' }] }]);
    expect(asked).toEqual([]);
  });

  it('a model the resolved brain does not offer is a 400 that names it and the brain — and nothing is spawned', async () => {
    await twoBrains();
    const response = await think({ brain: 'codex', prefs: { codex: { model: 'claude-sonnet-5-5' } } });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-snug-brain')).toBe('codex');
    expect((await refusal(response)).message).toBe('"claude-sonnet-5-5" is not a model CODEX offers');
    expect(seen).toEqual([]);
  });

  it('a level is judged FOR THE CHOSEN MODEL by the resolved brain — a 400 in its words, not a silently slower think', async () => {
    await twoBrains();
    const response = await think({ prefs: { claude: { model: 'haiku', effort: 'ultra' } } });
    expect(response.status).toBe(400);
    expect((await refusal(response)).message).toBe('"ultra" is not a thinking level CLAUDE has for haiku');
    expect(asked).toEqual([
      ['claude', 'model', undefined, 'haiku'],
      ['claude', 'effort', 'haiku', 'ultra'],
    ]);
    const noModel = await think({ effort: 'ultra' });
    expect((await refusal(noModel)).message).toBe('"ultra" is not a thinking level CLAUDE has for its default model');
    expect(seen).toEqual([]);
  });

  it.each([
    ['a brain that is not a string', { brain: 7 }],
    ['a brain that is not an id', { brain: 'Claude; rm -rf' }],
    ['an empty brain', { brain: '' }],
    ['prefs that is not an object', { prefs: ['claude'] }],
    ['a prefs entry that is not an object', { prefs: { claude: 'haiku' } }],
    ['a prefs model that could read as a flag', { prefs: { codex: { model: '--dangerously-bypass-approvals-and-sandbox' } } }],
    ['a prefs model for a brain that is NOT answering, of the wrong type', { prefs: { codex: { model: 5 } } }],
    ['a prefs effort that is not a string', { prefs: { claude: { effort: ['max'] } } }],
    ['an effort too long to be a word', { effort: 'x'.repeat(65) }],
  ])('refuses %s with a 400 before any brain is asked', async (_label, extra) => {
    await twoBrains();
    const response = await think(extra);
    expect(response.status).toBe(400);
    expect(response.headers.get('x-snug-brain')).toBeNull();
    expect(seen).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('names the brain even when its answer was EMPTY — the header rides the response, not the first chunk', async () => {
    await twoBrains({ claude: { create: () => brainOf(async () => {}) } });
    const response = await think();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-snug-brain')).toBe('claude');
    expect(await response.text()).toBe('');
  });

  it('a brain’s failure before any delta is a 502 that still names the brain — the page records the refusal against THAT brain', async () => {
    await twoBrains({ codex: { create: () => brainOf(async () => Promise.reject(new Error('Codex could not answer.'))) } });
    const response = await think({ brain: 'codex' });
    expect(response.status).toBe(502);
    expect(response.headers.get('x-snug-brain')).toBe('codex');
    expect((await refusal(response)).message).toBe('Codex could not answer.');
  });
});

describe('a think the registry cannot place is `no-brain` — the page’s demo brain answers, and no brain is named (B3)', () => {
  const think = (extra: Record<string, unknown> = {}): Promise<Response> =>
    call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], ...extra }) });
  const expectNoBrain = async (response: Response, message: RegExp): Promise<void> => {
    expect(response.status).toBe(503);
    expect(response.headers.get('x-snug-brain'), 'no brain answered, so none is named').toBeNull();
    const body = (await response.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe('no-brain');
    expect(body.error.message).toMatch(message);
  };
  let streams: string[];
  const answering = (id: string, over: Parameters<typeof fakeDriver>[1] = {}) => fakeDriver(id, { create: () => brainOf(async () => void streams.push(id)), ...over });
  beforeEach(() => {
    streams = [];
  });

  it('a runner with no registry at all', async () => {
    await expectNoBrain(await think(), /no brain/);
  });

  it('`auto` while the default brain is not ready — and a READY second brain is never used in its place', async () => {
    await server.close();
    await start({ brains: await probed([answering('claude', { readiness: { state: 'outdated', detail: 'run `claude update`' } }), answering('codex')]) });
    await expectNoBrain(await think(), /CLAUDE is not ready — run `claude update`/);
    await expectNoBrain(await think({ brain: 'auto' }), /CLAUDE is not ready/);
    expect(streams, 'the think went to another vendor without a user act').toEqual([]);
  });

  it('a PINNED brain that is not ready — never the other one, however ready it is', async () => {
    await server.close();
    await start({ brains: await probed([answering('claude'), answering('codex', { verified: false, readiness: { state: 'logged-out', detail: 'run `codex login`' } })]) });
    await expectNoBrain(await think({ brain: 'codex' }), /CODEX is not ready — run `codex login`/);
    expect(streams).toEqual([]);
  });

  it('a pin for a brain this runner does not have', async () => {
    await server.close();
    await start({ brains: await probed([answering('claude')]) });
    await expectNoBrain(await think({ brain: 'hermes' }), /no brain called "hermes"/);
    expect(streams).toEqual([]);
  });

  it('a think sent before any probe has answered — an unchecked brain is not a ready one', async () => {
    await server.close();
    await start({ brains: createBrainRegistry({ drivers: [answering('claude')] }) });
    await expectNoBrain(await think(), /still checking/);
    expect(streams).toEqual([]);
  });

  it('a malformed body is still a 400 first — a bad request is not "no brain"', async () => {
    expect((await think({ model: 5 })).status).toBe(400);
  });
});
