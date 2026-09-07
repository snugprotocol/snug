// The loopback data plane (ADR-0068 §1/§2).
//
// Hand-rolled over `node:http` for the reason the sidecar states for its own transport: the
// surface is a handful of routes on a socket only this machine can reach, and a
// general-purpose stack would bring middleware, body parsers and a dependency tree onto a
// plugin whose whole argument is that it is small enough to read.
//
// The document at `/` is open; everything beneath it is bearer-gated. That asymmetry is
// deliberate and not a gap: the page cannot present a token it has not been handed yet, and
// the token reaches it in the launch URL's FRAGMENT, which a browser never sends to a
// server. So the first request is anonymous by construction and every subsequent one is not.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { admitDataPlaneRequest } from './loopback-gates.js';
import type { FetchProxy, ProxyRequest, ProxyResult } from './fetch-proxy.js';
import { createUserFileStore, validUserFileName, type UserFileStore } from './userdb-fs.js';

/** A user file is not a provider response: the proxy's 1 MiB cap must not reach this route. */
const MAX_USERDB_BODY_BYTES = 64 * 1024 * 1024;
/** A `/fetch` request document (the URL, method, headers and body the executor already built). */
const MAX_FETCH_REQUEST_BYTES = 8 * 1024 * 1024;

export type ServerEvent = 'hand-in' | 'status' | 'shutdown';

export interface LoopbackServerOptions {
  token?: string;
  /** The kit page's bytes. A function so a rebuild is picked up without a restart in dev. */
  page?: () => string;
  proxy?: Pick<FetchProxy, 'handle'>;
  store?: UserFileStore;
  /** Names the other product holding the user file, when one is (D-B10). */
  heldBy?: () => string | undefined;
  /** The `claude -p` shim. Absent → `/v1/chat/completions` answers a named refusal. */
  brain?: { complete(request: { messages: Array<{ role: string; content: string | Array<{ type?: string; text?: string }> }>; model?: string }): Promise<string> };
}

export interface LoopbackServer {
  listen(port: number): Promise<{ port: number }>;
  close(): Promise<void>;
  address(): AddressInfo;
  emit(event: ServerEvent, data: unknown): void;
  /** How many pages are listening — the runner is "open" when at least one is. */
  subscriberCount(): number;
}

const readBody = async (request: IncomingMessage, cap: number): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    // Capped WHILE reading: a client that buffered first would defeat the bound before the
    // check saw a byte.
    if (total > cap) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

export function createLoopbackServer(options: LoopbackServerOptions = {}): LoopbackServer {
  const token = options.token ?? '';
  const page = options.page ?? (() => '<!doctype html><title>Snug</title>');
  const store = options.store ?? createUserFileStore(`${process.env.HOME ?? '.'}/Snug`);
  const heldBy = options.heldBy ?? (() => undefined);

  const subscribers = new Set<ServerResponse>();
  let httpServer: Server | undefined;
  let boundPort = 0;

  const end = (response: ServerResponse, status: number, body: string | Buffer = '', headers: Record<string, string> = {}): void => {
    response.writeHead(status, headers);
    // A Buffer is written AS BYTES. Passing binary through a JS string re-encodes it as
    // UTF-8 on the way out, turning every byte above 0x7F into U+FFFD — which corrupts a
    // SQLite file while leaving its header intact, so it still "looks complete" and the
    // damage only surfaces later as an unreadable database.
    response.end(body);
  };

  const json = (response: ServerResponse, status: number, value: unknown): void =>
    end(response, status, JSON.stringify(value), { 'content-type': 'application/json' });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;

    // The document, open by construction (see the header note).
    if (path === '/' && request.method === 'GET') {
      end(response, 200, page(), { 'content-type': 'text/html; charset=utf-8' });
      return;
    }

    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
    const admitted = admitDataPlaneRequest({ method: request.method ?? 'GET', path, headers }, { port: boundPort, token });
    if (!admitted.ok) {
      // No body detail: a refusal that explains itself tells a prober which half it got right.
      end(response, admitted.status);
      return;
    }

    if (path === '/status') {
      const held = heldBy();
      json(response, 200, {
        binding: 'local-host',
        port: boundPort,
        pages: subscribers.size,
        ...(held !== undefined ? { heldBy: held } : {}),
      });
      return;
    }

    if (path === '/events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      response.write(': open\n\n');
      subscribers.add(response);
      request.on('close', () => subscribers.delete(response));
      return;
    }

    if (path === '/fetch' && request.method === 'POST') {
      const body = await readBody(request, MAX_FETCH_REQUEST_BYTES);
      if (body === undefined) {
        end(response, 413);
        return;
      }
      let parsed: ProxyRequest;
      try {
        parsed = JSON.parse(body.toString('utf8')) as ProxyRequest;
        if (typeof parsed.url !== 'string' || typeof parsed.method !== 'string') throw new Error('shape');
      } catch {
        end(response, 400);
        return;
      }
      if (options.proxy === undefined) {
        json(response, 200, { ok: false, code: 'NET_FETCH_FAILED', message: 'this runner has no network transport' } satisfies ProxyResult);
        return;
      }
      // A proxy REFUSAL rides as a 200 envelope: the page needs the code to name the
      // failure, and an HTTP 4xx here would be indistinguishable from a gate refusal.
      json(response, 200, await options.proxy.handle(parsed));
      return;
    }

    // The brain shim (ADR-0068 §5): OpenAI-compatible, so the page reaches it through the
    // adapter it already has. It answers SSE because `openaiAdapter` always streams.
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      if (options.brain === undefined) {
        json(response, 503, { error: { message: 'no brain is configured for this runner' } });
        return;
      }
      const body = await readBody(request, MAX_FETCH_REQUEST_BYTES);
      if (body === undefined) {
        end(response, 413);
        return;
      }
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { messages?: unknown; model?: string };
        if (!Array.isArray(parsed.messages)) throw new Error('messages must be an array');
        const sse = await options.brain.complete(parsed as never);
        end(response, 200, sse, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      } catch (error) {
        // The reason reaches the page: a usage limit or a missing CLI is something the
        // user can act on, and an opaque failure would read as "the model said nothing".
        json(response, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
      }
      return;
    }

    if (path.startsWith('/userdb/')) {
      const name = decodeURIComponent(path.slice('/userdb/'.length));
      if (!validUserFileName(name)) {
        end(response, 400);
        return;
      }
      if (request.method === 'GET') {
        try {
          const bytes = await store.read(name);
          // 404 is absence and ONLY absence; anything else must reject so the page's
          // backend takes its error path rather than minting a fresh database.
          if (bytes === undefined) end(response, 404);
          else end(response, 200, Buffer.from(bytes), { 'content-type': 'application/octet-stream' });
        } catch {
          end(response, 500);
        }
        return;
      }
      if (request.method === 'PUT') {
        const held = heldBy();
        if (held !== undefined) {
          // Locked, not silently dropped: the page refuses to open when this is true, so a
          // write arriving here at all is a race worth naming.
          json(response, 423, { code: 'USERDB_HELD', heldBy: held });
          return;
        }
        const body = await readBody(request, MAX_USERDB_BODY_BYTES);
        if (body === undefined) {
          end(response, 413);
          return;
        }
        try {
          await store.write(name, new Uint8Array(body));
          end(response, 204);
        } catch {
          end(response, 500);
        }
        return;
      }
    }

    end(response, 404);
  };

  return {
    async listen(port: number): Promise<{ port: number }> {
      httpServer = createServer((request, response) => {
        void handle(request, response).catch(() => {
          // A throwing handler must not leak its reason: the page is on the other end.
          if (!response.headersSent) end(response, 500);
        });
      });
      await new Promise<void>((resolve, reject) => {
        httpServer!.once('error', reject);
        // 127.0.0.1 explicitly — never 0.0.0.0, which would put this on the network.
        httpServer!.listen(port, '127.0.0.1', resolve);
      });
      boundPort = (httpServer.address() as AddressInfo).port;
      return { port: boundPort };
    },

    async close(): Promise<void> {
      for (const subscriber of subscribers) subscriber.end();
      subscribers.clear();
      const server = httpServer;
      httpServer = undefined;
      if (server === undefined) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },

    address(): AddressInfo {
      return httpServer?.address() as AddressInfo;
    },

    emit(event: ServerEvent, data: unknown): void {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const subscriber of subscribers) subscriber.write(frame);
    },

    subscriberCount(): number {
      return subscribers.size;
    },
  };
}
