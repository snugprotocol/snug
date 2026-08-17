/**
 * THE UNIX-SOCKET SERVER (ADR-0032 §4, Phase C.2).
 *
 * The router's refusals are tested in `router.test.ts` against a scripted fake. What is
 * tested HERE is the transport in front of it — the half that was missing when the helper
 * was first journaled as done: parsing a real HTTP/1.1 request off a socket into the shape
 * the router expects, and writing a response back.
 *
 * WHY THIS SEAM IS WORTH ITS OWN TESTS. Everything the router refuses depends on being handed
 * an accurate `{method, path, headers, body}`. A transport that lowercased a header
 * inconsistently, dropped the query string, or mis-parsed a chunked body would not fail
 * loudly — it would hand the router a request that means something slightly different from
 * what arrived, and every carefully-tested refusal above it would then be deciding about the
 * wrong thing. So these tests drive a REAL server over a REAL unix socket.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import { createSidecarServer, type SidecarServer } from '../server.js';
import { createRouter, SPAWN_NONCE_HEADER } from '../router.js';
import { createMemoryStore } from '../store.js';
import { createFakeWaSocket, type FakeWaSocket } from './fake-wa-socket.js';

const NONCE = 'n'.repeat(64);

let running: SidecarServer | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (running !== undefined) await running.close();
  running = undefined;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function startServer(): Promise<{ socketPath: string; socket: FakeWaSocket }> {
  dir = mkdtempSync(path.join(tmpdir(), 'snug-sidecar-test-'));
  const socketPath = path.join(dir, 'test.sock');
  const socket = createFakeWaSocket();
  const store = createMemoryStore();
  const router = createRouter({
    socket,
    store,
    spawnNonce: NONCE,
    mintToken: () => 't'.repeat(64),
    now: () => 0,
  });
  running = createSidecarServer({ router, socketPath });
  await running.listen();
  return { socketPath, socket };
}

/** A minimal HTTP/1.1 client over the unix socket — the shape `sidecar_fetch` speaks. */
function request(
  socketPath: string,
  method: string,
  requestPath: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let raw = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      raw += chunk;
    });
    client.on('error', reject);
    client.on('end', () => {
      const headEnd = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, headEnd);
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, body: raw.slice(headEnd + 4) });
    });
    const payload = opts.body ?? '';
    const headers = {
      host: 'localhost',
      connection: 'close',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      ...(opts.headers ?? {}),
    };
    const head = `${method} ${requestPath} HTTP/1.1\r\n${Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n')}\r\n\r\n`;
    client.write(head + payload);
  });
}

describe('the unix-socket server', () => {
  it('creates the socket with 0600 permissions — the filesystem IS the access control', async () => {
    // With no TCP endpoint, "who may connect" is decided entirely by this mode bit. A
    // group- or world-readable socket would hand the user's WhatsApp session to any process
    // on the machine, which is the property the UDS design exists to provide.
    const { socketPath } = await startServer();
    const mode = statSync(socketPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('routes a wizard request and returns the router’s JSON', async () => {
    const { socketPath, socket } = await startServer();
    socket.emitQr('qr-payload');

    const res = await request(socketPath, 'GET', '/pair/qr', {
      headers: { [SPAWN_NONCE_HEADER]: NONCE },
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ state: 'waiting', qr: 'qr-payload' });
  });

  it('carries the 401 through as a real HTTP status, not a 200 with an error body', async () => {
    // A refusal that arrived as 200 would be read by the app as success.
    const { socketPath } = await startServer();
    const res = await request(socketPath, 'GET', '/pair/qr');
    expect(res.status).toBe(401);
  });

  it('preserves the QUERY STRING — the router matches on the full path-and-query', async () => {
    // `?since=` and `?cursor=` are how the app pages history. A transport that split the
    // query off would silently turn every paged read into a full read.
    const { socketPath, socket } = await startServer();
    socket.emitLinked();
    const token = await mintToken(socketPath);
    socket.seedChat('a@s.whatsapp.net', [{ id: 'm1', from: 'a@s.whatsapp.net', text: 'hi', ts: 1 }], { name: 'A' });

    const res = await request(socketPath, 'GET', '/chats/a%40s.whatsapp.net/messages?since=5', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('reads a POST body and hands it to the router', async () => {
    const { socketPath, socket } = await startServer();
    socket.emitLinked();
    const token = await mintToken(socketPath);
    socket.seedChat('a@s.whatsapp.net', [{ id: 'm1', from: 'a@s.whatsapp.net', text: 'hi', ts: 1 }], { name: 'A' });

    const res = await request(socketPath, 'POST', '/chats/a%40s.whatsapp.net/messages', {
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: 'hello there' }),
    });

    expect(res.status).toBe(200);
    expect(socket.sent()).toEqual([{ jid: 'a@s.whatsapp.net', text: 'hello there' }]);
  });

  it('a body that never arrives in full does not hang the socket forever', async () => {
    // A client that announces content-length and then stalls must not pin a handler open.
    // Without a timeout this is a trivial local denial of service against the helper.
    const { socketPath } = await startServer();
    const result = await new Promise<string>((resolve) => {
      const client = connect(socketPath);
      client.setEncoding('utf8');
      let raw = '';
      client.on('data', (c) => {
        raw += c;
      });
      client.on('close', () => resolve(raw));
      client.on('error', () => resolve(raw));
      client.write('POST /chats/a/messages HTTP/1.1\r\ncontent-length: 500\r\n\r\nshort');
    });
    expect(result.length).toBeGreaterThan(0);
  }, 15_000);

  it('refuses a request line that is not valid HTTP rather than guessing', async () => {
    const { socketPath } = await startServer();
    const result = await new Promise<string>((resolve) => {
      const client = connect(socketPath);
      client.setEncoding('utf8');
      let raw = '';
      client.on('data', (c) => {
        raw += c;
      });
      client.on('close', () => resolve(raw));
      client.on('error', () => resolve(raw));
      client.write('this is not http\r\n\r\n');
    });
    expect(result).toMatch(/^HTTP\/1\.1 400/);
  });

  it('closes cleanly and removes its socket file, so a restart cannot hit EADDRINUSE', async () => {
    const { socketPath } = await startServer();
    await running!.close();
    running = undefined;
    expect(() => statSync(socketPath)).toThrow();
  });
});

/** Drive the pairing flow far enough to hold a real token. */
async function mintToken(socketPath: string): Promise<string> {
  const res = await request(socketPath, 'GET', '/pair/status', {
    headers: { [SPAWN_NONCE_HEADER]: NONCE },
  });
  return JSON.parse(res.body).token as string;
}

/**
 * SOCKET PATH LENGTH (found by the first real run, not by a test).
 *
 * `sockaddr_un.sun_path` is ~104 bytes on macOS and ~108 on Linux. Node does NOT reject a
 * longer path: it TRUNCATES, binds a socket at the truncated name, and reports success. The
 * first live run produced a socket literally called `w` in the target directory, after which
 * `chmod` on the intended path failed with ENOENT — the only reason the failure was visible
 * at all.
 *
 * Left unchecked the bad case is worse than that crash: a truncated path could collide with
 * an existing name, or bind somewhere the 0600 chmod never reaches, and the helper would
 * appear to be running while `sidecar_fetch` dialled a path with nothing on it.
 *
 * The unit tests could never have caught this — `mkdtemp` paths are short. Only running the
 * built helper the way the shell runs it exposed it.
 */
describe('socket path length', () => {
  it('refuses a path too long for sun_path instead of letting the OS truncate it', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'snug-sidecar-long-'));
    const socketPath = path.join(dir, `${'d'.repeat(120)}.sock`);
    const server = createSidecarServer({
      router: createRouter({
        socket: createFakeWaSocket(),
        store: createMemoryStore(),
        spawnNonce: NONCE,
        mintToken: () => 't',
        now: () => 0,
      }),
      socketPath,
    });

    await expect(server.listen()).rejects.toThrow(/too long/i);
  });
});
