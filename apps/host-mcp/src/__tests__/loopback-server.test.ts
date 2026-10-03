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

import { RUNNER_MARKER_HEADER } from '../loopback-gates.js';
import { CLOSE_LINGER_MS, createLoopbackServer, type LoopbackServer } from '../loopback-server.js';
import { createUserFileStore } from '../userdb-fs.js';

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
    await start({ store: createUserFileStore(home), brainState: () => ({ state: 'logged-out' as const, detail: 'run `/login`' }) });

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

  it('reports the BRAIN’s state, so the page can name it instead of failing at the first think (D-B35)', async () => {
    await server.close();
    await start({ store: createUserFileStore(home), brainState: () => ({ state: 'logged-out' as const, detail: 'run `claude` and `/login`' }) });
    const body = (await (await call('/status')).json()) as { brain?: { state: string; detail?: string } };
    expect(body.brain?.state).toBe('logged-out');
    expect(body.brain?.detail).toMatch(/login/i);
  });

  it('reports a ready brain plainly', async () => {
    await server.close();
    await start({ store: createUserFileStore(home), brainState: () => ({ state: 'ready' as const }) });
    const body = (await (await call('/status')).json()) as { brain?: { state: string } };
    expect(body.brain?.state).toBe('ready');
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
  const post = (brain: { stream(request: never, sink: Sink): Promise<void> }, init: RequestInit = {}) =>
    start({ store: createUserFileStore(home), brain }).then(() =>
      call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }), ...init }),
    );

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
      brain: {
        async stream(_request, sink) {
          sink.signal?.addEventListener('abort', () => {
            aborted = true;
            release();
          });
          sink.write(': open\n\n');
          await gate;
        },
      },
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
    await start({ store: createUserFileStore(home), brain: { async stream() { spawned = true; } } });
    for (const messages of [[null], [{ role: 'user', content: 42 }], [{ content: 'x' }]]) {
      const response = await call('/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
      expect(response.status, JSON.stringify(messages)).toBe(400);
    }
    expect(spawned).toBe(false);
  });
});

describe('the chat route validates the user’s choice at the envelope boundary (review, 2026-10-03; C5)', () => {
  const streamed: unknown[] = [];
  const brain = {
    async stream(request: never, sink: { write(chunk: string): void }) {
      streamed.push(request);
      sink.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      sink.write('data: [DONE]\n\n');
    },
  };
  const send = async (extra: Record<string, unknown>) => {
    await start({ store: createUserFileStore(home), brain });
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

describe('/status carries the chip’s model list (S9)', () => {
  it('is always present, and empty when no list was given', async () => {
    const status = (await (await call('/status')).json()) as { models?: unknown };
    expect(status.models).toEqual([]);
  });

  it('carries what the runner read', async () => {
    const models = [{ id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true }];
    await start({ store: createUserFileStore(home), models: () => models });
    expect(((await (await call('/status')).json()) as { models?: unknown }).models).toEqual(models);
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
    let state: { state: string } | undefined;
    await start({
      brainState: () => state,
      onFirstContact: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state = { state: 'absent' };
      },
    });
    const body = (await (await call('/status')).json()) as { brain?: { state: string } };
    expect(body.brain?.state).toBe('absent');
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
      brain: {
        async stream(_request, sink) {
          sink.write(': open\n\n');
          await new Promise(() => {}); // a model that never finishes
        },
      },
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
    for (const key of ['binding', 'port', 'pages', 'oauthRedirect']) expect(typeof body[key], key).toBe(typeof wire[key]);
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
