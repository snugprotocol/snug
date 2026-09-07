// AC7 — the control plane on a real unix socket.

import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createControlSocket, MAX_SOCKET_PATH_BYTES, probeControlSocket, type ControlSocket } from '../control-socket.js';

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

const listen = async (handle = vi.fn(async () => ({ tokenHash: 'h', port: 43127 })), onClientCountChange?: (n: number) => void): Promise<string> => {
  socket = createControlSocket({ handle, ...(onClientCountChange !== undefined ? { onClientCountChange } : {}) });
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
    const counts: number[] = [];
    const target = await listen(undefined, (n) => counts.push(n));
    const { createConnection } = await import('node:net');
    const a = createConnection(target);
    await new Promise((r) => a.on('connect', r));
    expect(socket!.clientCount()).toBe(1);
    const b = createConnection(target);
    await new Promise((r) => b.on('connect', r));
    expect(socket!.clientCount()).toBe(2);
    a.destroy();
    await vi.waitFor(() => expect(socket!.clientCount()).toBe(1));
    b.destroy();
    await vi.waitFor(() => expect(socket!.clientCount()).toBe(0));
    expect(counts).toContain(2);
  });
});
