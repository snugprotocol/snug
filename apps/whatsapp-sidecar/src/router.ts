/**
 * THE SIDECAR ROUTER (ADR-0032) — every request that reaches the helper passes through
 * here, and every refusal it makes is one of the reasons this process is allowed to exist.
 *
 * THE AUTH RULE, stated once: EVERY route requires a credential. The app routes require the
 * minted access token; the pairing and verify routes require the SPAWN NONCE, which only
 * the process that started this sidecar knows (`sidecar_ctl` passes it at spawn, and the
 * wizard holds it).
 *
 * Why the pairing routes are not open — this task's first draft had them so, and it was
 * wrong. `GET /pair/status` RELEASES the access token. An open pairing surface means
 * anything able to reach the socket can mint itself a credential and drive the user's
 * WhatsApp, without ever breaking the credential store: it just asks for the credential.
 * The nonce is what makes "reaching the socket" insufficient.
 *
 * WHAT THIS PROCESS DELIBERATELY DOES NOT DO: it holds no model key and makes no model
 * call. Analysis, persona-building, translation and reply composition all happen in the
 * governed host, so this stays transport and custody. A sidecar that could compose its own
 * replies would be a second brain outside every surface the host reviews.
 */

import { isAppReachableSidecarRoute } from '@snugprotocol/protocol';
import type { SidecarStore } from './store.js';
import type { WaSocket } from './wa-socket.js';

/** The nonce header. One spelling, shared with `sidecar_ctl` and the wizard. */
export const SPAWN_NONCE_HEADER = 'x-snug-spawn-nonce';

/** WhatsApp's own limit is ~65 536; refusing above it is honest rather than optimistic. */
export const MAX_SEND_CHARS = 65_536;

export interface SidecarRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body?: unknown;
}

export interface SidecarResponse {
  status: number;
  body?: unknown;
}

export interface RouterDeps {
  socket: WaSocket;
  store: SidecarStore;
  /** Handed in at spawn by `sidecar_ctl`; never read from the request. */
  spawnNonce: string;
  mintToken: () => string;
  now: () => number;
  /**
   * How long `GET /events` may hold an up-to-date cursor before answering empty
   * (ADR-0034 §1). Default 8 000 ms — inside the server's 10 s request timeout with margin;
   * a hold that outlived the transport's own timeout would answer nobody.
   */
  eventHoldMs?: number;
}

export interface SidecarRouter {
  handle(request: SidecarRequest): Promise<SidecarResponse>;
}

const json = (status: number, body?: unknown): SidecarResponse => ({ status, body });

/** Constant-time-ish compare. Not a timing-attack defense on a unix socket — hygiene. */
function secretEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(headers: Record<string, string | undefined>): string | undefined {
  const raw = headers['authorization'] ?? headers['Authorization'];
  if (raw === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1];
}

/**
 * Split a path into its segments, query stripped, each segment percent-DECODED.
 *
 * The decode is load-bearing and was missing until the first end-to-end run: a JID contains
 * `@`, callers encode it (`encodeURIComponent`), and the Rust admission deliberately forwards
 * the ORIGINAL path — decoding before forwarding would let `%2f` smuggle a separator past the
 * route matcher. So this is the seat that owes the decode, and it decodes PER SEGMENT, after
 * splitting, so an encoded separator can never introduce a new segment.
 *
 * A segment that cannot be decoded yields `undefined` for the whole path rather than falling
 * back to the raw bytes: a value we cannot decode is a value we cannot reason about, and a
 * thread reachable under a spelling nothing else agrees on is worse than a 404.
 */
function segmentsOf(path: string): string[] | undefined {
  const clean = path.split(/[?#]/, 1)[0] ?? '';
  const segments = clean.split('/').filter((segment) => segment.length > 0);
  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  return decoded;
}

/** The `?cursor=` value: a whole number, or undefined when absent. Anything else is null. */
function cursorOf(path: string): number | undefined | null {
  const query = path.split('#', 1)[0]?.split('?', 2)[1];
  if (query === undefined) return undefined;
  const raw = new URLSearchParams(query).get('cursor');
  if (raw === null) return undefined;
  // Digits only: '-1', '1.5' and '1e3' are all values a ring buffer cannot reason about.
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function createRouter(deps: RouterDeps): SidecarRouter {
  const { socket, store, spawnNonce, mintToken } = deps;
  const eventHoldMs = deps.eventHoldMs ?? 8_000;

  const wizardAuthorized = (request: SidecarRequest): boolean =>
    secretEquals(request.headers[SPAWN_NONCE_HEADER], spawnNonce);

  const appAuthorized = (request: SidecarRequest): boolean => {
    const token = store.token();
    // No token yet means nothing is authorized — never "anything goes until pairing".
    return token !== undefined && secretEquals(bearer(request.headers), token);
  };

  return {
    async handle(request) {
      const segments = segmentsOf(request.path);
      if (segments === undefined) return json(404, { error: 'no such route' });
      const method = request.method.toUpperCase();

      // ---------------------------------------------------------- pairing (wizard only)
      if (segments[0] === 'pair') {
        if (!wizardAuthorized(request)) return json(401, { error: 'unauthorized' });
        if (segments[1] === 'start' && method === 'POST') {
          await socket.startLink();
          return json(200, { state: socket.linkState() });
        }
        if (segments[1] === 'qr' && method === 'GET') {
          // Once linked there is no QR, and saying so is better than serving a stale one
          // the user would scan to no effect.
          const qr = socket.linkState() === 'linked' ? undefined : socket.currentQr();
          return json(200, qr === undefined ? { state: socket.linkState() } : { state: socket.linkState(), qr });
        }
        if (segments[1] === 'status' && method === 'GET') {
          const state = socket.linkState();
          if (state !== 'linked') return json(200, { state });
          // THE MINT, once. `setToken` refuses to overwrite, so a second poll returns the
          // same value rather than issuing a fresh secret to whoever asked last.
          if (store.token() === undefined) store.setToken(mintToken());
          return json(200, { state, token: store.token() });
        }
        return json(segments.length > 1 ? 405 : 404, { error: 'no such route' });
      }

      // ------------------------------------------------- verify seat (wizard only, ADR-0025)
      if (segments[0] === 'session') {
        if (!wizardAuthorized(request) && !appAuthorized(request)) return json(401, { error: 'unauthorized' });
        if (segments[1] === 'status' && method === 'GET') {
          // Status ONLY — never the auth state it is derived from.
          return json(200, { state: socket.linkState(), sync: socket.historyState() });
        }
        return json(405, { error: 'no such route' });
      }

      // ---------------------------------------------- the hint stream (app surface, v2)
      if (segments[0] === 'events') {
        // Same two checks as every app route, same order — a long-poll is not a side door
        // (review F6), and the contract module keeps the only opinion on reachability.
        if (!isAppReachableSidecarRoute(method, request.path)) {
          return json(['GET', 'POST'].includes(method) ? 404 : 405, { error: 'no such route' });
        }
        if (!appAuthorized(request)) return json(401, { error: 'unauthorized' });

        const cursor = cursorOf(request.path);
        if (cursor === null) return json(400, { error: 'cursor must be a whole number' });

        let page = socket.eventsSince(cursor);
        if (cursor !== undefined && page.hints.length === 0 && !page.resync) {
          // THE HOLD — for a consumer that HAS a cursor and is up to date. Bounded well
          // inside the transport's own 10 s request timeout; a hold that outlives the
          // transport answers nobody. A cursorless call is the BOOTSTRAP ("hand me a live
          // cursor") and answers immediately — holding it would stall every app open.
          await socket.waitForEvents(cursor, eventHoldMs);
          page = socket.eventsSince(cursor);
        }
        return json(200, page);
      }

      // ------------------------------------------------------------------- app surface
      if (segments[0] === 'chats') {
        // The contract module decides what an app may reach; this process does not keep a
        // second opinion. A path it does not admit is refused before any handler runs.
        if (!isAppReachableSidecarRoute(method, request.path)) {
          const known = ['GET', 'POST'].includes(method);
          return json(known ? 404 : 405, { error: 'no such route' });
        }
        if (!appAuthorized(request)) return json(401, { error: 'unauthorized' });

        if (segments.length === 1 && method === 'GET') {
          return json(200, { chats: socket.listChats() });
        }

        const jid = segments[1];
        if (jid === undefined) return json(404, { error: 'no such route' });
        const leaf = segments[2];

        if (leaf === 'history' && method === 'GET') {
          const page = socket.history(jid);
          if (page === undefined) return json(404, { error: 'no such thread' });
          // The sync state rides WITH the page: an app that cannot see "still arriving" or
          // "completion was inferred" will describe a partial history as the whole record.
          return json(200, { ...page, sync: socket.historyState() });
        }

        if (leaf === 'messages' && method === 'GET') {
          const messages = socket.messagesSince(jid);
          if (messages === undefined) return json(404, { error: 'no such thread' });
          return json(200, { messages, sync: socket.historyState() });
        }

        if (leaf === 'media' && method === 'GET') {
          const id = segments[3];
          if (id === undefined) return json(404, { error: 'no such route' });
          const result = await socket.mediaOf(jid, id);
          if (result === undefined) return json(404, { error: 'no such media' });
          // Relayed VERBATIM, the too-large refusal included: refusing is the adapter's
          // decision and truncating here would turn an honest refusal into a corrupt image.
          return json(200, result);
        }

        if (leaf === 'picture' && method === 'GET') {
          const picture = await socket.pictureOf(jid);
          if (picture === undefined) return json(404, { error: 'no picture' });
          return json(200, picture);
        }

        if (leaf === 'messages' && method === 'POST') {
          if (socket.linkState() !== 'linked') {
            return json(409, { error: 'this helper is not linked to WhatsApp yet' });
          }
          const text = typeof (request.body as { text?: unknown })?.text === 'string'
            ? ((request.body as { text: string }).text)
            : '';
          const trimmed = text.trim();
          if (trimmed.length === 0) return json(400, { error: 'a message needs some text' });
          if (text.length > MAX_SEND_CHARS) return json(400, { error: 'that message is too long to send' });
          if (socket.messagesSince(jid) === undefined) return json(404, { error: 'no such thread' });
          const sent = await socket.sendText(jid, text);
          return json(200, { id: sent.id });
        }

        return json(404, { error: 'no such route' });
      }

      return json(404, { error: 'no such route' });
    },
  };
}
