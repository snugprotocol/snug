/**
 * THE UNIX-SOCKET TRANSPORT (ADR-0032 §4).
 *
 * The router decides; this file only carries bytes to and from it. That division is why the
 * router's refusals can be tested without a socket at all — and why this file must be
 * scrupulous about handing over a request that means EXACTLY what arrived. A transport that
 * dropped a query string or mangled a header would not fail loudly; it would hand the router
 * a subtly different request, and every carefully-tested refusal above would then be
 * deciding about the wrong thing.
 *
 * HAND-ROLLED HTTP, deliberately, and the same reasoning as the Rust side's: the surface is
 * eight routes over a socket only this machine can reach, and `node:http` would bring a
 * general-purpose server (keep-alive, chunked encoding, 100-continue, header folding) to a
 * job that wants a small, auditable parser. Fewer behaviours means fewer behaviours to
 * reason about when the thing on the other end holds a WhatsApp session.
 *
 * WHY 0600 IS THE WHOLE SECURITY STORY. With no TCP endpoint there is no port to squat and
 * no network path to filter: the filesystem decides who may connect. `sidecar_ctl` creates
 * the directory, and this server chmods the socket the instant it exists.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import type { SidecarRouter } from './router.js';

/** Matches the Rust side's cap (`MAX_RESPONSE_BYTES`) — a request may not exceed it either. */
const MAX_REQUEST_BYTES = 1024 * 1024;

/**
 * How long a connection may take to deliver a complete request.
 *
 * A client that announces `content-length: 500` and sends five bytes would otherwise pin a
 * handler open forever — a trivial local denial of service against the helper, and one that
 * needs no privileges beyond reaching the socket.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux; 100 is the safe floor.
 *
 * Node does NOT reject a longer path — it TRUNCATES, binds at the truncated name, and reports
 * success. A helper listening at a name nobody else can compute looks identical to a healthy
 * one until every request fails, so this refuses up front. (`~/Snug/whatsapp-sidecar.sock` is
 * ~39 bytes, so the real path has ample room; this catches an unusual HOME or a future
 * relocation, and it caught a 124-byte scratchpad path on the helper's first live run.)
 */
const MAX_SOCKET_PATH_BYTES = 100;

export interface SidecarServerDeps {
  router: SidecarRouter;
  socketPath: string;
}

export interface SidecarServer {
  listen(): Promise<void>;
  close(): Promise<void>;
}

interface ParsedRequest {
  method: string;
  /** Path AND query — the router matches on the full thing. */
  path: string;
  headers: Record<string, string | undefined>;
  body?: string;
}

/** Parse a request head. Returns undefined for anything that is not a well-formed line. */
function parseHead(head: string): { request: ParsedRequest; contentLength: number } | undefined {
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const match = /^([A-Za-z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) return undefined;

  const headers: Record<string, string | undefined> = {};
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    // Header names are case-insensitive on the wire; the router looks them up in lower case,
    // so normalize HERE rather than making every consumer remember to.
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }

  const declared = Number(headers['content-length'] ?? '0');
  return {
    request: { method: match[1] ?? '', path: match[2] ?? '', headers },
    contentLength: Number.isFinite(declared) && declared > 0 ? declared : 0,
  };
}

function writeResponse(socket: Socket, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const head =
    `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}\r\n` +
    'content-type: application/json\r\n' +
    `content-length: ${Buffer.byteLength(payload)}\r\n` +
    'connection: close\r\n\r\n';
  socket.end(head + payload);
}

export function createSidecarServer(deps: SidecarServerDeps): SidecarServer {
  const { router, socketPath } = deps;

  const server: Server = createServer((socket) => {
    let raw = Buffer.alloc(0);
    let handled = false;

    const timer = setTimeout(() => {
      if (handled) return;
      handled = true;
      writeResponse(socket, 408, { error: 'request timed out' });
    }, REQUEST_TIMEOUT_MS);
    // Do not hold the process open for an idle connection's timer.
    timer.unref?.();

    const finish = (status: number, body: unknown): void => {
      if (handled) return;
      handled = true;
      clearTimeout(timer);
      writeResponse(socket, status, body);
    };

    socket.on('error', () => {
      handled = true;
      clearTimeout(timer);
    });

    socket.on('data', (chunk: Buffer | string) => {
      if (handled) return;
      // Never `setEncoding` on this socket: the body must be measured in BYTES (the cap and
      // `content-length` are both byte counts), and a string view would silently count UTF-16
      // code units instead.
      raw = Buffer.concat([raw, typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk]);
      if (raw.byteLength > MAX_REQUEST_BYTES) {
        finish(413, { error: 'request too large' });
        return;
      }

      const headEnd = raw.indexOf('\r\n\r\n');
      if (headEnd === -1) return; // head still arriving

      const parsed = parseHead(raw.subarray(0, headEnd).toString('utf8'));
      if (parsed === undefined) {
        finish(400, { error: 'malformed request' });
        return;
      }

      const bodyStart = headEnd + 4;
      const received = raw.byteLength - bodyStart;
      if (received < parsed.contentLength) return; // body still arriving

      const bodyText =
        parsed.contentLength > 0
          ? raw.subarray(bodyStart, bodyStart + parsed.contentLength).toString('utf8')
          : undefined;

      // The router expects `body` already parsed — it reads `body.text` — so a malformed
      // JSON body becomes `undefined` and the router's own validation refuses it. Parsing
      // here rather than there keeps the router transport-free.
      let body: unknown;
      if (bodyText !== undefined && bodyText.length > 0) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = undefined;
        }
      }

      void router
        .handle({
          method: parsed.request.method,
          path: parsed.request.path,
          headers: parsed.request.headers,
          ...(body !== undefined ? { body } : {}),
        })
        .then((response) => finish(response.status, response.body))
        // A handler that threw must not leave the caller waiting, and must not leak the
        // reason: an internal error message from this process could name paths or session
        // internals, and the webview is on the other end.
        .catch(() => finish(500, { error: 'the helper failed to handle that request' }));
    });
  });

  return {
    listen() {
      return new Promise<void>((resolve, reject) => {
        const pathBytes = Buffer.byteLength(socketPath, 'utf8');
        if (pathBytes > MAX_SOCKET_PATH_BYTES) {
          reject(
            new Error(
              `socket path is too long for a unix socket (${pathBytes} bytes, max ${MAX_SOCKET_PATH_BYTES}): ${socketPath}`,
            ),
          );
          return;
        }
        // A socket file left by a crashed run makes bind fail with EADDRINUSE. Removing it is
        // safe because this path is ours and `sidecar_ctl` is its only other writer.
        try {
          rmSync(socketPath, { force: true });
        } catch {
          /* nothing to remove */
        }
        server.once('error', reject);
        server.listen(socketPath, () => {
          try {
            // The access-control decision, applied the moment the socket exists.
            chmodSync(socketPath, 0o600);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          server.removeListener('error', reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        server.close(() => {
          try {
            rmSync(socketPath, { force: true });
          } catch {
            /* already gone */
          }
          resolve();
        });
      });
    },
  };
}
