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

import { isModelId, type ChatMessage } from './brains/brain.js';
import { DEFAULT_BRAIN, type BrainRegistry } from './brains/registry.js';
import { buildId, VERSION } from './build.js';
import { admitDataPlaneRequest, RUNNER_REFUSAL_HEADERS } from './loopback-gates.js';
import type { FetchProxy, ProxyRequest, ProxyResult } from './fetch-proxy.js';
import { validUserFileName, type UserFileStore } from './userdb-fs.js';
import { RealHomeRefusedError } from './home.js';

/** A user file is not a provider response: the proxy's 1 MiB cap must not reach this route. */
const MAX_USERDB_BODY_BYTES = 64 * 1024 * 1024;
/** A `/fetch` request document (the URL, method, headers and body the executor already built). */
const MAX_FETCH_REQUEST_BYTES = 8 * 1024 * 1024;

/** A hand-in report is an id, a word and one sentence — a few hundred bytes. */
const MAX_OUTCOME_BODY_BYTES = 8 * 1024;
/** What survives of a report's reason: enough for a sentence, never a document. */
export const MAX_OUTCOME_REASON_CHARS = 500;

/**
 * What the page did with one handed-in bundle (K6):
 *   installed — a new app; updated — a newer version of an unedited copy;
 *   current   — the user's copy already IS this bundle, so nothing changed;
 *   offered   — the user edited their copy, so the update waits for them in the run header;
 *   refused   — with the page's reason.
 */
export const HAND_IN_OUTCOMES = ['installed', 'updated', 'current', 'offered', 'refused'] as const;
export type HandInOutcomeKind = (typeof HAND_IN_OUTCOMES)[number];

export interface HandInReport {
  /** The id the runner put on the `hand-in` event this report answers. */
  id: string;
  outcome: HandInOutcomeKind;
  reason?: string;
  /** The version an update landed as. */
  version?: number;
}

/** The runner mints a hand-in id as 16 random bytes in hex; nothing else is one. */
const HAND_IN_ID = /^[0-9a-f]{32}$/;
/** C0, DEL and C1 — a reason is one line of plain text by the time it leaves this module. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/**
 * A report, parsed at the boundary (C5). `undefined` for anything that is not one. The
 * reason is the one field whose TEXT travels on — into `snug_hand_in`'s answer, and so into
 * an agent's context — which is why its control characters are flattened and its length
 * bounded here, before anything else can read it.
 */
export function parseHandInReport(value: unknown): HandInReport | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { id, outcome, reason, version } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !HAND_IN_ID.test(id)) return undefined;
  if (typeof outcome !== 'string' || !(HAND_IN_OUTCOMES as readonly string[]).includes(outcome)) return undefined;
  if (reason !== undefined && typeof reason !== 'string') return undefined;
  if (version !== undefined && (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1)) return undefined;
  return {
    id,
    outcome: outcome as HandInOutcomeKind,
    ...(reason !== undefined ? { reason: reason.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, MAX_OUTCOME_REASON_CHARS) } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/**
 * How long `close()` lets open responses finish before it cuts them. A chat stream holds a
 * connection for as long as the model talks, and `http.Server.close()` waits for every one:
 * without a bound a stopping runner would stay alive behind a tab nobody is reading.
 */
export const CLOSE_LINGER_MS = 1_000;

export type ServerEvent = 'hand-in' | 'status' | 'shutdown';

export interface LoopbackServerOptions {
  token?: string;
  /** The kit page's bytes. A function so a rebuild is picked up without a restart in dev. */
  page?: () => string;
  proxy?: Pick<FetchProxy, 'handle'>;
  /**
   * Where user files live. REQUIRED (D-B34) — the default was the real `~/Snug`, and that is
   * how a test destroyed the owner's user file.
   */
  store: UserFileStore;
  /** Names the other product holding the user file, when one is (D-B10). */
  heldBy?: () => string | undefined;
  /**
   * The user's own agents (ADR-0071). `/status` and the `status` event report every one of
   * them — its state, its remedy, its models and levels — so the page's chip can NAME a
   * logged-out or missing CLI rather than letting it surface as a failed think; and the
   * chat route asks it which ONE answers a think. Absent → no brain at all: the route
   * answers `no-brain`, and the page's demo brain answers in its place.
   */
  brains?: Pick<BrainRegistry, 'statuses' | 'resolve'>;
  /**
   * Called ONCE, by the first request that passed the gate — the first page contact — and
   * awaited before that request is answered. It is what makes the brain probe lazy (B1): a
   * session that only ever speaks over stdio spawns no CLI, and what a fast probe learns
   * still rides the page's very first `/status`.
   */
  onFirstContact?: () => void | Promise<void>;
  /**
   * Whether an OAuth redirect can come back to this origin: true only when the listener
   * bound the port a user registers with a provider (D-B13). Absent → `false`: a server
   * that was never told it holds that port must not let the page offer a sign-in that
   * cannot return.
   */
  oauthRedirect?: () => boolean;
  /** The page reporting what it did with a handed-in bundle (K6). Already parsed and bounded. */
  onHandInOutcome?: (report: HandInReport) => void;
  /**
   * The page asking for the brains to be probed again (D4): a think just failed, or the demo
   * brain is answering in a real brain's place. The floor is the registry's — this route
   * only carries the ask.
   */
  onBrainRecheck?: () => void | Promise<void>;
}

export interface LoopbackServer {
  listen(port: number): Promise<{ port: number }>;
  close(): Promise<void>;
  address(): AddressInfo;
  emit(event: Exclude<ServerEvent, 'status'>, data: unknown): void;
  /** Tell every open page the runner's status NOW — the same document `GET /status` answers. */
  emitStatus(): void;
  /** How many pages are listening — the runner is "open" when at least one is. */
  subscriberCount(): number;
  /**
   * Stop taking `/userdb` writes and wait — at most `timeoutMs` — for the ones in flight
   * (L4). Called BEFORE the lock is released: a write still running when a successor takes
   * the lock is two writers on one user file.
   */
  drainWrites(timeoutMs: number): Promise<void>;
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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `auto`, or a driver's id — compared against the registry, never displayed back. */
const BRAIN_CHOICE = /^[a-z][a-z0-9-]{0,31}$/;
/** A thinking level is a short word in every brain's vocabulary; WHICH words, its driver decides. */
const MAX_EFFORT_CHARS = 64;

/** The user's per-machine choice for ONE brain (ADR-0070 §5, ADR-0071 §5). */
interface BrainEntry {
  model?: string;
  effort?: string;
}

export interface ChatBody {
  messages: ChatMessage[];
  /** `auto`, or the one brain the user pinned. Absent is `auto`. */
  brain?: string;
  /** The entry for one brain — the only one the route applies is the brain it resolved. */
  entryFor(brain: string): BrainEntry;
}

/**
 * An entry's SHAPE, checked for every entry whichever brain answers: a value that reaches a
 * driver at all can ride argv. A non-string model once threw a TypeError deep in argv
 * building, and a dash-led id must never depend on a CLI's parser to stay a value.
 */
function entryOf(value: unknown, what: string): BrainEntry {
  if (!isRecord(value)) throw new Error(`${what} must be an object`);
  const { model, effort } = value;
  if (model !== undefined && !isModelId(model)) throw new Error(`"${String(model).slice(0, 80)}" is not a model id`);
  if (effort !== undefined && (typeof effort !== 'string' || effort.length > MAX_EFFORT_CHARS)) throw new Error('effort must be a string');
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/**
 * The chat route's body, parsed at the envelope boundary (C5): `{ messages, brain?, prefs? }`.
 * Throws the sentence a 400 carries.
 *
 * `prefs` holds the user's choice PER BRAIN, because a model id and a thinking level mean
 * something only in one brain's vocabulary. Top-level `model` / `effort` are the form the
 * page sent while there was one brain, and still mean the `claude` entry. The page's
 * OpenAI adapter has always filled `model` with the literal `claude` when nothing was
 * chosen — a placeholder, never an id — and it is dropped HERE, once, so no driver has to
 * know about it.
 */
export function parseChatBody(value: unknown): ChatBody {
  if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error('messages must be an array');
  for (const message of value.messages as unknown[]) {
    if (!isRecord(message) || typeof message.role !== 'string' || !(typeof message.content === 'string' || Array.isArray(message.content))) {
      throw new Error('every message needs a string role and a string or array content');
    }
  }
  if (value.brain !== undefined && (typeof value.brain !== 'string' || !BRAIN_CHOICE.test(value.brain))) throw new Error('brain must be "auto" or a brain’s id');

  const legacy = entryOf(value, 'the request');
  if (legacy.model === 'claude') delete legacy.model;
  const entries = new Map<string, BrainEntry>();
  if (value.prefs !== undefined) {
    if (!isRecord(value.prefs)) throw new Error('prefs must be an object');
    for (const [brain, entry] of Object.entries(value.prefs)) entries.set(brain, entryOf(entry, 'every prefs entry'));
  }

  return {
    messages: value.messages as ChatMessage[],
    ...(value.brain !== undefined ? { brain: value.brain } : {}),
    // Field by field, the per-brain form wins where both were sent.
    entryFor: (brain) => (brain === DEFAULT_BRAIN ? { ...legacy, ...entries.get(brain) } : (entries.get(brain) ?? {})),
  };
}

export function createLoopbackServer(options: LoopbackServerOptions): LoopbackServer {
  const token = options.token ?? '';
  const page = options.page ?? (() => '<!doctype html><title>Snug</title>');
  // REQUIRED (D-B34). This line used to read `?? createUserFileStore(~/Snug)`, and that
  // default is how the oversize-body test wrote 2 MiB of zeros over the owner's real user
  // file. An omitted store is now a refusal at construction, before a listener exists.
  const store = options.store;
  if (store === undefined) {
    throw new RealHomeRefusedError('createLoopbackServer needs an explicit store; it no longer defaults to the real ~/Snug (D-B34)');
  }
  const heldBy = options.heldBy ?? (() => undefined);

  const subscribers = new Set<ServerResponse>();
  let httpServer: Server | undefined;
  let boundPort = 0;
  let firstContact: Promise<void> | undefined;
  // `/userdb` writes between their first byte and the rename, and whoever waits on them.
  let writesInFlight = 0;
  let draining = false;
  let onWritesIdle: (() => void) | undefined;

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

  /**
   * The runner's status, as `GET /status` answers it and as the `status` event carries it:
   * ONE shape (`fixtures/status-wire.json`, read by this route's test and the page's client).
   * The page ships with the process — one build, no skew — so there is no older reader to
   * keep a second shape for.
   */
  const statusBody = (): Record<string, unknown> => {
    const held = heldBy();
    const { active, brains } = options.brains?.statuses() ?? { brains: [] };
    return {
      binding: 'local-host',
      port: boundPort,
      pages: subscribers.size,
      ...(held !== undefined ? { heldBy: held } : {}),
      version: VERSION,
      build: buildId(),
      // Always a boolean: the page's `oauth` offer (and so every sign-in tile) reads it.
      oauthRedirect: options.oauthRedirect?.() === true,
      // The brain a think sent NOW would run on under `auto`. Absent = none is ready.
      ...(active !== undefined ? { active } : {}),
      // Always present, possibly empty: every brain this runner has, ready or not.
      brains,
    };
  };

  const emit = (event: ServerEvent, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const subscriber of subscribers) subscriber.write(frame);
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;

    // The document, open by construction (see the header note).
    //
    // `/oauth/callback` serves the SAME document (D-B14). The web popup path makes the
    // registered redirect URI `${origin}/oauth/callback` — a PATH, not a hash route
    // (connectionWizard.ts:2351) — so the provider sends the user's browser here. The
    // document's boot reads that path FIRST and renders the callback page alone, which
    // delivers the code over BroadcastChannel (apps/host `boot.tsx`, K2). This comment used
    // to say "the page's own HashRouter takes over once it loads": a hash router never
    // looks at the path, so that document rendered the hub and no sign-in completed (found
    // 2026-10-03). It is open for the same reason `/` is, and for one more: the redirect
    // arrives carrying only what the PROVIDER put in the query, so there is no bearer to
    // present and gating it would 401 every real callback.
    if ((path === '/' || path === '/oauth/callback') && request.method === 'GET') {
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
      // The marker is the same on every one of them, so it explains nothing either.
      end(response, admitted.status, '', RUNNER_REFUSAL_HEADERS);
      return;
    }

    // The first page contact. A failure in it is the probe's to report, never this request's.
    firstContact ??= Promise.resolve()
      .then(() => options.onFirstContact?.())
      .catch(() => {});
    await firstContact;

    if (path === '/status') {
      json(response, 200, statusBody());
      return;
    }

    if (path === '/hand-in/outcome' && request.method === 'POST') {
      const body = await readBody(request, MAX_OUTCOME_BODY_BYTES);
      if (body === undefined) {
        end(response, 413);
        return;
      }
      let report: HandInReport | undefined;
      try {
        report = parseHandInReport(JSON.parse(body.toString('utf8')));
      } catch {
        report = undefined;
      }
      if (report === undefined) {
        end(response, 400);
        return;
      }
      // An id nobody is waiting on (the tool's bound has passed) is still a 204: the page
      // did its part, and "too late" is not something it can act on.
      options.onHandInOutcome?.(report);
      end(response, 204);
      return;
    }

    if (path === '/brain/recheck' && request.method === 'POST') {
      // Asked, not awaited: a probe can take as long as the user's CLI takes to start, and
      // its verdict travels as a `status` event to every open page.
      void Promise.resolve()
        .then(() => options.onBrainRecheck?.())
        .catch(() => {});
      end(response, 202);
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
      // REPLAY WHAT IS ALREADY KNOWN. The brain probe is kicked off by the page's FIRST
      // request — its `/status`, sent before it subscribes here — so the probe's emit can
      // land in zero subscribers, and a fire-and-forget event is simply lost: the chip would
      // keep its boot label forever. A page that subscribes later is told the current state
      // immediately.
      if (options.brains !== undefined) {
        response.write(`event: status\ndata: ${JSON.stringify(statusBody())}\n\n`);
      }
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

    // The brain route (ADR-0068 §5, ADR-0071): OpenAI-compatible, so the page reaches it
    // through the adapter it already has. It answers SSE because `openaiAdapter` always
    // streams — a brain that answers whole (Codex) sends its one frame the same way.
    if (path === '/v1/chat/completions' && request.method === 'POST') {
      const body = await readBody(request, MAX_FETCH_REQUEST_BYTES);
      if (body === undefined) {
        end(response, 413);
        return;
      }
      let chat: ChatBody;
      try {
        chat = parseChatBody(JSON.parse(body.toString('utf8')));
      } catch (error) {
        json(response, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
        return;
      }

      // WHICH brain answers is the registry's decision alone (ADR-0071 §4): `auto` is the
      // default brain or nothing, a pin is that brain or nothing. "Nothing" is said with a
      // code, so the page can let its demo brain answer and show the remedy — it is not a
      // failure of the brain that was asked, and it names no brain.
      const resolved = options.brains?.resolve(chat.brain) ?? { ok: false as const, message: 'this runner has no brain' };
      if (!resolved.ok) {
        json(response, 503, { error: { message: resolved.message, code: 'no-brain' } });
        return;
      }
      const { driver, brain } = resolved;
      // From here every answer — the stream, a refusal, a bad choice — names the brain it
      // is about, so the page records it against THAT brain and no other. Set on the
      // response itself, so no later path can answer without it.
      response.setHeader('x-snug-brain', driver.id);

      // ONLY the resolved brain's entry is applied, and its own driver judges it: a model or
      // a level means something in one brain's vocabulary and nothing in another's.
      const { model, effort } = chat.entryFor(driver.id);
      if (model !== undefined && !driver.acceptsModel(model)) {
        json(response, 400, { error: { message: `"${model}" is not a model ${driver.name} offers` } });
        return;
      }
      if (effort !== undefined && !driver.acceptsEffort(model, effort)) {
        json(response, 400, { error: { message: `"${effort}" is not a thinking level ${driver.name} has for ${model ?? 'its default model'}` } });
        return;
      }

      // The stream: headers go out with the FIRST chunk, so a failure before any delta can
      // still be a 502 the page reads; after a delta the stream simply ends with no finish,
      // which the page's adapter reports as dropped — never as a complete answer.
      const controller = new AbortController();
      let headersSent = false;
      const sink = {
        write: (chunk: string): void => {
          if (!headersSent) {
            headersSent = true;
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
          }
          response.write(chunk);
        },
        signal: controller.signal,
      };
      // The page giving up (a closed tab, an aborted fetch) reaps the child: `close` fires
      // on a normal end too, so only an unfinished response counts.
      response.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      try {
        await brain.stream({ messages: chat.messages, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) }, sink);
        response.end();
      } catch (error) {
        if (headersSent) {
          response.end();
          return;
        }
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
        if (draining) {
          // The runner is stopping. SAID, with the marker, so the page can tell the user
          // (K7) — a write accepted now could land after the lock has changed hands.
          end(response, 503, '', RUNNER_REFUSAL_HEADERS);
          return;
        }
        writesInFlight += 1;
        try {
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
        } finally {
          writesInFlight -= 1;
          if (writesInFlight === 0) onWritesIdle?.();
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
      await new Promise<void>((resolve) => {
        const linger = setTimeout(() => server.closeAllConnections(), CLOSE_LINGER_MS);
        linger.unref?.();
        server.close(() => {
          clearTimeout(linger);
          resolve();
        });
      });
    },

    async drainWrites(timeoutMs: number): Promise<void> {
      draining = true;
      if (writesInFlight === 0) return;
      await new Promise<void>((resolve) => {
        // The bound NAMES itself by returning: a write wedged on a dead disk must not hold
        // the exit, and the caller's own hard deadline is the backstop behind this one.
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        onWritesIdle = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    },

    address(): AddressInfo {
      return httpServer?.address() as AddressInfo;
    },

    emit,

    emitStatus(): void {
      emit('status', statusBody());
    },

    subscriberCount(): number {
      return subscribers.size;
    },
  };
}
