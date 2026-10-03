// AC7 — the control plane on a real unix socket.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acked,
  attachControl,
  CONTROL_OPS,
  controlCall,
  createControlSocket,
  MAX_CONTROL_LINE_BYTES,
  MAX_SOCKET_PATH_BYTES,
  probeControlSocket,
  type ControlSocket,
  type ControlSocketDeps,
} from '../control-socket.js';
import { MAX_RPC_LINE_BYTES } from '../mcp/jsonrpc.js';

let dir: string;
let socket: ControlSocket | undefined;

beforeEach(() => {
  // Short by design: `sun_path` is ~104 bytes and a session scratchpad blows past it.
  dir = mkdtempSync(path.join(tmpdir(), 'snugctl-'));
});
afterEach(async () => {
  await socket?.close();
  socket = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const listen = async (handle = vi.fn(async () => ({ tokenHash: 'h', port: 43127 })), onPersistentCountChange?: (n: number) => void): Promise<string> => {
  socket = createControlSocket({ handle, ...(onPersistentCountChange !== undefined ? { onPersistentCountChange } : {}) });
  const target = path.join(dir, 's.sock');
  await socket.listen(target);
  return target;
};

describe('the socket itself', () => {
  it('is created 0600 — the filesystem is the whole access-control story', async () => {
    const target = await listen();
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it('REFUSES a path too long for sun_path instead of binding a truncated one', async () => {
    // Node truncates rather than erroring, so the process would bind at a name nobody can
    // compute and appear perfectly healthy.
    const long = path.join(dir, `${'x'.repeat(MAX_SOCKET_PATH_BYTES)}.sock`);
    const s = createControlSocket({ handle: async () => ({}) });
    await expect(s.listen(long)).rejects.toThrow(/too long/);
  });

  it('a socket that VANISHES between the bind and the chmod is a rejected listen — never an uncaught exception', async () => {
    // Another newcomer's take-over may unlink the canonical path in exactly that moment. The
    // chmod used to run bare inside the `listening` callback: its ENOENT was thrown from an
    // event handler, which is the process dying with the lock held.
    const s = createControlSocket({ handle: async () => ({}) });
    const target = path.join(dir, 's.sock');
    const listening = s.listen(target); // bound synchronously; `listening` fires a tick later
    rmSync(target);
    await expect(listening).rejects.toMatchObject({ code: 'ENOENT' });
    // Nothing is left bound or recorded: the same object can listen again, and close cleanly.
    await s.listen(target);
    expect(await probeControlSocket(target)).toMatchObject({ ok: true, op: 'hello' });
    await s.close();
  });

  it('removes the socket file on close', async () => {
    const target = await listen();
    await socket!.close();
    socket = undefined;
    expect(() => statSync(target)).toThrow();
  });
});

describe('the handshake', () => {
  it('answers a probe with the identity the lock records', async () => {
    const target = await listen();
    expect(await probeControlSocket(target)).toMatchObject({ tokenHash: 'h', port: 43127 });
  });

  it('answers undefined for a socket path that does not exist', async () => {
    expect(await probeControlSocket(path.join(dir, 'absent.sock'))).toBeUndefined();
  });

  it('answers undefined rather than hanging when nothing replies', async () => {
    // A wedged primary must look stale quickly; a probe that hung would wedge the newcomer.
    socket = createControlSocket({ handle: () => new Promise(() => ({})) });
    const target = path.join(dir, 'quiet.sock');
    await socket.listen(target);
    expect(await probeControlSocket(target, 200)).toBeUndefined();
  });

  it('survives a client that sends garbage', async () => {
    const target = await listen();
    const { createConnection } = await import('node:net');
    const client = createConnection(target);
    await new Promise((r) => client.on('connect', r));
    client.write('not json\n');
    await new Promise((r) => setTimeout(r, 50));
    // still serving
    expect(await probeControlSocket(target)).toMatchObject({ tokenHash: 'h' });
    client.destroy();
  });
});

describe('the attached-client count (D-B9)', () => {
  it('rises and falls with real connections, and reports each change', async () => {
    // MIGRATED 2026-10-03 to the count the product reads. This pinned `clientCount()` and
    // `onClientCountChange` — every open connection, a status poll included — which the exit
    // decision stopped reading when presence became a HELD connection (L7), and which had no
    // caller left. An "attached client" is a connection that said `attach`: that is what is
    // counted here now, over the same two real connections, and connecting alone is not it.
    const counts: number[] = [];
    const target = await listen(undefined, (n) => counts.push(n));
    const { createConnection } = await import('node:net');
    const attach = `${JSON.stringify({ op: 'attach' })}\n`;
    const a = createConnection(target);
    await new Promise((r) => a.on('connect', r));
    expect(socket!.persistentCount()).toBe(0);
    a.write(attach);
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(1));
    const b = createConnection(target);
    await new Promise((r) => b.on('connect', r));
    b.write(attach);
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(2));
    a.destroy();
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(1));
    b.destroy();
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(0));
    expect(counts).toContain(2);
    // Each change, once, in order — up with each session and down with each.
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it('is the ONLY count the socket keeps: nothing counts, or reports, a connection that merely opened', async () => {
    // What was removed stays removed: a second counter beside the one the exit decision
    // reads is how a status poll came to look like a second window.
    const target = await listen();
    expect(socket).not.toHaveProperty('clientCount');
    const onClientCountChange = vi.fn();
    const onPersistentCountChange = vi.fn();
    await socket!.close();
    socket = createControlSocket({ handle: async () => ({}), onPersistentCountChange, ...({ onClientCountChange } as object) });
    await socket.listen(target);
    const { createConnection } = await import('node:net');
    const idle = createConnection(target);
    await new Promise((r) => idle.on('connect', r));
    await controlCall(target, { op: 'status' });
    idle.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(onClientCountChange).not.toHaveBeenCalled();
    expect(onPersistentCountChange).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ L3 / L5 / L7
//
// Everything below was added with the lifecycle range (TASK-20261003). The plan review found
// that the socket answered EVERY request with the same success-shaped hello — so a client
// asking an older primary to do something it had never heard of read "running: true" and
// called it done. Hence: a positive ack naming the op, an error for an unknown one, a cap on
// a line, and ONE client.

type Handle = ControlSocketDeps['handle'];
const serve = async (handle: Handle): Promise<string> => {
  socket = createControlSocket({ handle });
  const target = path.join(dir, 's.sock');
  await socket.listen(target);
  return target;
};

const raw = async (target: string, bytes: string | Buffer): Promise<{ lines: string[]; closed: boolean }> => {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const client = createConnection(target);
    let text = '';
    let closed = false;
    const finish = (): void => {
      client.destroy();
      resolve({ lines: text.split('\n').filter((line) => line !== ''), closed });
    };
    client.on('connect', () => client.write(bytes));
    client.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      setTimeout(finish, 50);
    });
    client.on('close', () => {
      closed = true;
      finish();
    });
    // `close` always follows; an error on a connection the server cut is not the answer.
    client.on('error', () => {});
  });
};

describe('every op answers for itself (L3)', () => {
  it.each(CONTROL_OPS.map((op) => [op]))('%s answers a positive ack naming the op', async (op) => {
    const target = await serve(async () => ({}));
    expect(await controlCall(target, { op })).toEqual({ ok: true, op });
  });

  it('carries the handler’s own fields beside the ack', async () => {
    const target = await serve(async () => ({ port: 43127, pages: 2 }));
    expect(await controlCall(target, { op: 'status' })).toEqual({ ok: true, op: 'status', port: 43127, pages: 2 });
  });

  it('an UNKNOWN op answers { error: "unknown op" } and never reaches the handler', async () => {
    // The mutant this kills is the old behaviour itself: one answer for everything.
    const handle = vi.fn<Handle>(async () => ({ tokenHash: 'h', port: 43127 }));
    const target = await serve(handle);
    expect(await controlCall(target, { op: 'goodbye' })).toEqual({ error: 'unknown op' });
    expect(await controlCall(target, { op: 'constructor' })).toEqual({ error: 'unknown op' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('a request that is not an object with an op is refused, not guessed at', async () => {
    const handle = vi.fn<Handle>(async () => ({}));
    const target = await serve(handle);
    for (const line of ['"hello"', '[]', 'null', '{}', '{"op":7}', 'not json']) {
      const { lines } = await raw(target, `${line}\n`);
      expect(JSON.parse(lines[0]!), line).toHaveProperty('error');
      expect(JSON.parse(lines[0]!), line).not.toHaveProperty('ok', true);
    }
    expect(handle).not.toHaveBeenCalled();
  });

  it('a handler that answers an error is NOT ok — and still names the op', async () => {
    const target = await serve(async () => ({ error: 'pages-open', pages: 1 }));
    expect(await controlCall(target, { op: 'stop' })).toEqual({ ok: false, op: 'stop', error: 'pages-open', pages: 1 });
  });

  it('a handler that THROWS is an error answer, and the socket keeps serving', async () => {
    const target = await serve(async (request) => {
      if (request.op === 'open') throw new Error('no browser here');
      return {};
    });
    expect(await controlCall(target, { op: 'open' })).toEqual({ ok: false, op: 'open', error: 'no browser here' });
    expect(await controlCall(target, { op: 'hello' })).toEqual({ ok: true, op: 'hello' });
  });

  it('a handler cannot forge the ack of another op', async () => {
    const target = await serve(async () => ({ ok: true, op: 'launch-url' }));
    expect(await controlCall(target, { op: 'hello' })).toEqual({ ok: true, op: 'hello' });
  });

  it('hands the request’s own fields to the handler', async () => {
    const handle = vi.fn<Handle>(async () => ({}));
    const target = await serve(handle);
    await controlCall(target, { op: 'call', name: 'snug_status', args: { a: 1 } });
    expect(handle.mock.calls[0]![0]).toEqual({ op: 'call', name: 'snug_status', args: { a: 1 } });
  });
});

describe('a line is capped (L3)', () => {
  it('admits a line as large as the largest hand-in the stdio transport admits', async () => {
    // An attached session forwards `snug_hand_in` over this socket, so the cap here must
    // not be SMALLER than the one on the pipe the bundle arrived through.
    const handle = vi.fn<Handle>(async () => ({}));
    const target = await serve(handle);
    const html = 'x'.repeat(MAX_RPC_LINE_BYTES - 1024);
    expect(await controlCall(target, { op: 'call', name: 'snug_hand_in', args: { bundle: { html } } }, { timeoutMs: 10_000 })).toEqual({ ok: true, op: 'call' });
    expect((handle.mock.calls[0]![0].args as { bundle: { html: string } }).bundle.html).toHaveLength(html.length);
  });

  it('refuses a line past the cap, closes that connection, and keeps serving the next', async () => {
    const handle = vi.fn<Handle>(async () => ({}));
    const target = await serve(handle);
    const { lines, closed } = await raw(target, Buffer.alloc(MAX_CONTROL_LINE_BYTES + 2, 0x78));
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ error: 'line too long' }]);
    expect(closed).toBe(true);
    expect(handle).not.toHaveBeenCalled();
    expect(await controlCall(target, { op: 'hello' })).toEqual({ ok: true, op: 'hello' });
  });
});

describe('controlCall — the one client (L3)', () => {
  it('answers undefined when the peer answers something that is not a JSON object', async () => {
    const { createServer } = await import('node:net');
    for (const reply of ['nope\n', '"a string"\n', '[1]\n', 'null\n']) {
      const target = path.join(dir, `odd${reply.length}.sock`);
      const server = createServer((peer) => peer.on('data', () => peer.write(reply)));
      await new Promise<void>((resolve) => server.listen(target, resolve));
      try {
        expect(await controlCall(target, { op: 'hello' }), reply).toBeUndefined();
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });

  it('answers undefined when the peer hangs up without answering', async () => {
    const { createServer } = await import('node:net');
    const target = path.join(dir, 'hangup.sock');
    const server = createServer((peer) => peer.on('data', () => peer.destroy()));
    await new Promise<void>((resolve) => server.listen(target, resolve));
    try {
      expect(await controlCall(target, { op: 'hello' })).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reassembles an answer that arrives in pieces, mid-character', async () => {
    const { createServer } = await import('node:net');
    const target = path.join(dir, 'split.sock');
    const answer = Buffer.from(`${JSON.stringify({ ok: true, op: 'status', home: '/Users/é/Snug' })}\n`, 'utf8');
    const cut = answer.indexOf(0xc3) + 1; // between the two bytes of `é`
    const server = createServer((peer) =>
      peer.on('data', () => {
        peer.write(answer.subarray(0, cut));
        setTimeout(() => peer.write(answer.subarray(cut)), 20);
      }),
    );
    await new Promise<void>((resolve) => server.listen(target, resolve));
    try {
      expect(await controlCall(target, { op: 'status' })).toEqual({ ok: true, op: 'status', home: '/Users/é/Snug' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('gives up at its own timeout', async () => {
    socket = createControlSocket({ handle: () => new Promise(() => ({})) });
    const target = path.join(dir, 'slow.sock');
    await socket.listen(target);
    const began = Date.now();
    expect(await controlCall(target, { op: 'status' }, { timeoutMs: 150 })).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(1_400);
  });

  it('acked() is true only for the positive ack of THAT op', () => {
    expect(acked({ ok: true, op: 'call' }, 'call')).toBe(true);
    expect(acked({ ok: true, op: 'hello' }, 'call')).toBe(false);
    expect(acked({ ok: false, op: 'call', error: 'x' }, 'call')).toBe(false);
    // An OLDER build's answer to anything: success-shaped, and not an ack.
    expect(acked({ tokenHash: 'h', port: 43127, running: true, clients: 1 }, 'call')).toBe(false);
    expect(acked(undefined, 'call')).toBe(false);
  });
});

describe('presence: a held connection is a session, a transient op is not (L7)', () => {
  it('counts an `attach` connection for as long as it stays open', async () => {
    const counts: number[] = [];
    socket = createControlSocket({ handle: async () => ({ port: 43127 }), onPersistentCountChange: (n) => counts.push(n) });
    const target = path.join(dir, 'p.sock');
    await socket.listen(target);

    const held = await attachControl(target, { onLost: () => {} });
    expect(held.kind).toBe('held');
    expect(socket.persistentCount()).toBe(1);
    if (held.kind === 'held') {
      expect(held.answer).toEqual({ ok: true, op: 'attach', port: 43127 });
      held.close();
    }
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(0));
    expect(counts).toEqual([1, 0]);
  });

  it('NEVER counts a transient op — a status poll must not look like a session', async () => {
    // The mutant: counting connections. A `snug status` in a loop would then hold the
    // runner alive for ever, and one arriving during the grace would cancel it.
    const counts: number[] = [];
    socket = createControlSocket({ handle: async () => ({}), onPersistentCountChange: (n) => counts.push(n) });
    const target = path.join(dir, 't.sock');
    await socket.listen(target);
    for (const op of ['hello', 'status', 'open', 'launch-url', 'call', 'stop']) await controlCall(target, { op });
    expect(socket.persistentCount()).toBe(0);
    expect(counts).toEqual([]);
  });

  it('does not count an `attach` the handler refused', async () => {
    socket = createControlSocket({ handle: async () => ({ error: 'stopping' }) });
    const target = path.join(dir, 'r.sock');
    await socket.listen(target);
    const outcome = await attachControl(target, { onLost: () => {} });
    expect(outcome.kind).toBe('refused');
    expect(socket.persistentCount()).toBe(0);
  });

  it('counts two sessions apart, and one connection only once however often it says attach', async () => {
    socket = createControlSocket({ handle: async () => ({}) });
    const target = path.join(dir, 'two.sock');
    await socket.listen(target);
    const a = await attachControl(target, { onLost: () => {} });
    const b = await attachControl(target, { onLost: () => {} });
    expect(socket.persistentCount()).toBe(2);

    const { createConnection } = await import('node:net');
    const chatty = createConnection(target);
    await new Promise((resolve) => chatty.on('connect', resolve));
    chatty.write(`${JSON.stringify({ op: 'attach' })}\n${JSON.stringify({ op: 'attach' })}\n`);
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.persistentCount()).toBe(3);

    chatty.destroy();
    if (a.kind === 'held') a.close();
    if (b.kind === 'held') b.close();
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(0));
  });
});

describe('attachControl — the session’s end of the held connection (L7)', () => {
  it('tells the session when the primary goes away', async () => {
    socket = createControlSocket({ handle: async () => ({}) });
    const target = path.join(dir, 'gone.sock');
    await socket.listen(target);
    const onLost = vi.fn();
    const held = await attachControl(target, { onLost });
    expect(held.kind).toBe('held');
    await socket.close();
    socket = undefined;
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledTimes(1));
  });

  it('does NOT report a loss the session caused itself by closing', async () => {
    socket = createControlSocket({ handle: async () => ({}) });
    const target = path.join(dir, 'self.sock');
    await socket.listen(target);
    const onLost = vi.fn();
    const held = await attachControl(target, { onLost });
    if (held.kind === 'held') held.close();
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onLost).not.toHaveBeenCalled();
  });

  it('an OLDER build’s answer is `refused` with what it said — never held (L3)', async () => {
    // What a build from before this range answers to ANY line: its hello, no ack.
    const { createServer } = await import('node:net');
    const target = path.join(dir, 'old.sock');
    const server = createServer((peer) => peer.on('data', () => peer.write(`${JSON.stringify({ tokenHash: 'h', port: 43127, running: true, clients: 1 })}\n`)));
    await new Promise<void>((resolve) => server.listen(target, resolve));
    try {
      const outcome = await attachControl(target, { onLost: () => {} });
      expect(outcome).toEqual({ kind: 'refused', answer: { tokenHash: 'h', port: 43127, running: true, clients: 1 } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('nothing listening is `silent`', async () => {
    expect(await attachControl(path.join(dir, 'absent.sock'), { onLost: () => {} })).toEqual({ kind: 'silent' });
  });

  it('a peer that never answers is `silent` at the timeout', async () => {
    socket = createControlSocket({ handle: () => new Promise(() => ({})) });
    const target = path.join(dir, 'mute.sock');
    await socket.listen(target);
    expect(await attachControl(target, { onLost: () => {}, timeoutMs: 100 })).toEqual({ kind: 'silent' });
    await vi.waitFor(() => expect(socket!.persistentCount()).toBe(0));
  });
});

describe('an op whose effect would cut its own answer off', () => {
  it('runs afterAnswer only once the answer has been written — the caller still reads its ack', async () => {
    // `stop` closes this very socket. Closing first would turn a clean ack into a hang-up,
    // which the CLI could not tell from a runner that died.
    socket = createControlSocket({
      handle: async (_request, connection) => {
        connection.afterAnswer(() => void socket!.close());
        return { stopping: true };
      },
    });
    const target = path.join(dir, 'stop.sock');
    await socket.listen(target);
    expect(await controlCall(target, { op: 'stop' })).toEqual({ ok: true, op: 'stop', stopping: true });
    await vi.waitFor(() => expect(() => statSync(target)).toThrow());
    socket = undefined;
  });
});
