// The control plane (ADR-0068 §2/§3): a unix socket under `~/Snug/host/`, mode 0600.
//
// It exists so that attached sessions and the human CLI never need the bearer. The WhatsApp
// helper's delta states the reasoning this inherits: with no TCP endpoint there is no port
// to squat and no network path to filter — the filesystem decides who may connect. That is
// why the token can stay in memory (D-B8) instead of being written somewhere a second
// session could read it.
//
// One divergence from the sidecar, and it matters. The sidecar unlinks its socket path
// before binding, safe because it is that path's only writer. Here every peer is symmetric:
// any session may be the primary, so an unconditional unlink would cut a LIVE primary's
// socket out from under it — it would keep serving its open descriptors while every future
// attach failed, freezing the client count that decides when to exit. So only a
// proven-dead owner's socket is removed, and that decision lives in `lock.ts`.

import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

/** `sun_path` is 104 bytes on macOS and Node TRUNCATES rather than refusing (lesson 2026-08-26). */
export const MAX_SOCKET_PATH_BYTES = 100;

export interface ControlRequest {
  op: 'hello' | 'status' | 'open' | 'goodbye';
}

export interface ControlAnswer {
  tokenHash?: string;
  port?: number;
  url?: string;
  running?: boolean;
  clients?: number;
  error?: string;
}

export interface ControlSocketDeps {
  /** Answers one control request. */
  handle(request: ControlRequest): Promise<ControlAnswer>;
  /** Called when the attached-client count changes: the exit decision reads it (D-B9). */
  onClientCountChange?(count: number): void;
}

export interface ControlSocket {
  listen(path: string): Promise<void>;
  close(): Promise<void>;
  clientCount(): number;
}

export function createControlSocket(deps: ControlSocketDeps): ControlSocket {
  const clients = new Set<Socket>();
  let server: Server | undefined;
  let socketPath: string | undefined;

  const publish = (): void => deps.onClientCountChange?.(clients.size);

  return {
    async listen(path: string): Promise<void> {
      if (Buffer.byteLength(path, 'utf8') > MAX_SOCKET_PATH_BYTES) {
        // Node truncates silently, so the helper would bind at a name nobody can compute
        // and look perfectly healthy.
        throw new Error(`the control socket path is too long (${Buffer.byteLength(path, 'utf8')} bytes): ${path}`);
      }
      socketPath = path;
      server = createServer((socket) => {
        clients.add(socket);
        publish();
        socket.on('close', () => {
          clients.delete(socket);
          publish();
        });
        // Errors on a peer socket are that peer's problem, never ours to crash on.
        socket.on('error', () => {
          clients.delete(socket);
          publish();
        });

        let buffer = '';
        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          for (;;) {
            const newline = buffer.indexOf('\n');
            if (newline === -1) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (line.trim() === '') continue;
            void (async () => {
              let answer: ControlAnswer;
              try {
                answer = await deps.handle(JSON.parse(line) as ControlRequest);
              } catch (error) {
                answer = { error: error instanceof Error ? error.message : String(error) };
              }
              socket.write(`${JSON.stringify(answer)}\n`);
            })();
          }
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(path, () => {
          // The access-control decision, applied the moment the socket exists.
          chmodSync(path, 0o600);
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      for (const client of clients) client.destroy();
      clients.clear();
      const current = server;
      server = undefined;
      if (current !== undefined) await new Promise<void>((resolve) => current.close(() => resolve()));
      if (socketPath !== undefined) rmSync(socketPath, { force: true });
    },

    clientCount(): number {
      return clients.size;
    },
  };
}

/** Ask a socket who it is — the attach handshake's identity check. */
export async function probeControlSocket(path: string, timeoutMs = 1_500): Promise<ControlAnswer | undefined> {
  const { createConnection } = await import('node:net');
  return new Promise<ControlAnswer | undefined>((resolve) => {
    let settled = false;
    const done = (answer: ControlAnswer | undefined): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    const socket = createConnection(path);
    const timer = setTimeout(() => done(undefined), timeoutMs);
    timer.unref?.();
    socket.on('error', () => done(undefined));
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'hello' })}\n`));
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, newline)) as ControlAnswer);
      } catch {
        done(undefined);
      }
    });
  });
}
