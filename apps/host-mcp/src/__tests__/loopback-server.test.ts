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

import { createLoopbackServer, type LoopbackServer } from '../loopback-server.js';
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
  it('is the real runner, not the placeholder', async () => {
    // The placeholder is what a MISSING page looks like, and it serves with HTTP 200 — so a
    // wrong lookup path is invisible unless something asserts on the bytes. Found exactly
    // that way: the repo-relative fallback climbed one directory too few.
    const { readFileSync, existsSync } = await import('node:fs');
    const nodePath = await import('node:path');
    const built = nodePath.resolve(__dirname, '../../../host/dist-local/snug-host-local.html');
    if (!existsSync(built)) return; // CANNOT RUN without the sibling build; the gate covers that
    const html = readFileSync(built, 'utf8');
    expect(html.length).toBeGreaterThan(100_000);
    expect(html).not.toContain('is missing from this install');
  });
});
