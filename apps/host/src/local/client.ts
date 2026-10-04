// The page's half of the loopback contract (ADR-0068 §1).
//
// Everything the local host process offers the page goes through here: the outbound fetch
// seam, the user file, the event stream, and what the page tells the runner back (a
// hand-in's outcome, a request to probe the brain again). It is the only module that knows
// the bearer, which arrives in the launch URL's fragment and lives in `sessionStorage` for
// this tab alone.
//
// It is also where a STOPPED runner is noticed (K7). The db swallows a failed save by
// design, so a runner that went away used to take every later edit and keep none of them,
// with nothing on screen to say so. Three things mean "gone", and each is seen here: the
// runner's own `shutdown` event; an event stream that is lost and does not come back within
// a short bound; a `/userdb` write the runner refuses (or nothing answers). The page then
// says so and takes no further edits.

import { base64ToBytes, type FileBackendFs } from '@snugprotocol/db';

/** Where the token lives once the fragment has been stripped: this tab, this origin. */
const TOKEN_KEY = 'snug-host-token';

/**
 * What every refusal on the runner's data plane carries (`apps/host-mcp`
 * `loopback-gates.ts`, which this page cannot import — it is Node code; a test pins the two
 * spellings together). It is how the one kit page tells "a runner that will not let me in"
 * from "a static server with no such route".
 */
export const RUNNER_MARKER_HEADER = 'x-snug-runner';

export const isRunnerRefusal = (response: Response): boolean => response.headers.get(RUNNER_MARKER_HEADER) === '1';

/** What a write is refused with once the runner is known gone — and what the page says. */
export const RUNNER_STOPPED_MESSAGE = 'the Snug runner stopped — reopen Snug from your agent';

/**
 * How long a lost event stream may stay lost before the runner is called stopped. Long
 * enough for a laptop waking up to re-open the stream; short enough that a user who keeps
 * typing into a dead page is told within a few seconds, not after the next save.
 */
export const EVENTS_RECONNECT_BOUND_MS = 4_000;
const EVENTS_RETRY_MS = 500;

/** What the page did with one handed-in bundle (the runner's `POST /hand-in/outcome`). */
export interface HandInReport {
  id: string;
  outcome: 'installed' | 'updated' | 'current' | 'offered' | 'refused';
  reason?: string;
  version?: number;
}

export interface LocalClient {
  /** The `fetchImpl` the platform seam hands to `connectedFetchDepsFor`. */
  fetchImpl(input: string, init?: RequestInit): Promise<Response>;
  fs: FileBackendFs;
  /** Subscribe to the process's pushes. Returns an unsubscribe. */
  events(onEvent: (name: string, data: unknown) => void): () => void;
  /** Tell the runner what became of a hand-in. Never rejects: an undelivered report is "not confirmed", not a failure here. */
  reportHandIn(report: HandInReport): Promise<void>;
  /** Ask the runner to probe the brain again. Never rejects; the verdict arrives as a `status` event. */
  recheckBrain(): Promise<void>;
  /** Whether the runner is known gone (K7). Set once, never cleared: a new runner is a new page. */
  stopped: { get(): boolean; subscribe(listener: () => void): () => void };
}

/** One model a brain will take, with the thinking levels THAT model has, in the brain's own words. */
export interface BrainWireModel {
  id: string;
  name: string;
  /** Empty = this model has no thinking axis. */
  efforts: readonly string[];
}

/**
 * One brain the runner knows about, as it reports it (ADR-0071 §1, §6): the user's own
 * `claude` CLI, their Codex CLI, whatever a later driver adds.
 */
export interface BrainWire {
  /** The driver's id (`claude`, `codex`). Compared, never displayed. */
  id: string;
  name: string;
  /** Whose it is, in words (`your Claude Code CLI`). */
  via: string;
  /**
   * `ready | logged-out | outdated | absent | unknown` today. Kept as the string it is: a
   * later driver may add a state, and the chip renders one it does not know as unknown.
   */
  state: string;
  /** One sentence a person can act on. Present whenever the state is not `ready`. */
  detail?: string;
  /** Whether its tool-free posture was proven on a real, logged-in run. Unverified = pin only, never `auto`. */
  verified: boolean;
  /** Whether an answer arrives as it is written, or whole at the end. */
  streaming: boolean;
  /** The levels on offer while no model is chosen (the brain's default model's). */
  efforts: readonly string[];
  /** Empty = no catalogue could be read; the chip keeps free text as the whole model control. */
  models: readonly BrainWireModel[];
  /** The largest system prompt this brain can be handed, in UTF-8 bytes, where it has a limit. */
  maxPromptBytes?: number;
}

export interface LocalStatus {
  binding: string;
  port: number;
  pages: number;
  heldBy?: string;
  /**
   * Whether an OAuth redirect can come back to this runner: false when the port a user
   * registers with a provider was taken and the runner fell back to another (ADR-0068
   * D-B13). The process always says; absent (an older wire) reads as available.
   */
  oauthRedirect?: boolean;
  /**
   * The brain a think sent NOW would run on under the default choice, `auto` (ADR-0071 §4).
   * ABSENT = none is ready — including "the runner has not asked its brains yet", which is
   * not a claim that one works.
   */
  active?: string;
  /** Every brain the runner knows, ready or not. EMPTY until its first probe has answered. */
  brains: readonly BrainWire[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringsOf = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((item): item is string => typeof item === 'string') ? value : undefined;

function modelOf(value: unknown): BrainWireModel | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id === '' || typeof value.name !== 'string') return undefined;
  const efforts = stringsOf(value.efforts);
  return efforts === undefined ? undefined : { id: value.id, name: value.name, efforts };
}

/**
 * One brain entry, or `undefined` for anything that is not one. Nothing is defaulted: an
 * entry with no `verified` is not read as verified, nor as unverified — it is not read.
 */
function brainOf(value: unknown): BrainWire | undefined {
  if (!isRecord(value)) return undefined;
  const { id, name, via, state, detail, verified, streaming, maxPromptBytes } = value;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string' || typeof via !== 'string' || typeof state !== 'string') return undefined;
  if (typeof verified !== 'boolean' || typeof streaming !== 'boolean') return undefined;
  const efforts = stringsOf(value.efforts);
  if (efforts === undefined || !Array.isArray(value.models)) return undefined;
  const models: BrainWireModel[] = [];
  for (const entry of value.models) {
    const model = modelOf(entry);
    if (model === undefined) return undefined;
    models.push(model);
  }
  return {
    id,
    name,
    via,
    state,
    ...(typeof detail === 'string' ? { detail } : {}),
    verified,
    streaming,
    efforts,
    models,
    ...(typeof maxPromptBytes === 'number' && Number.isFinite(maxPromptBytes) && maxPromptBytes > 0 ? { maxPromptBytes } : {}),
  };
}

/** The brains of a status: each entry that is one, in the runner's order (its default brain first). */
function brainsOf(value: unknown): readonly BrainWire[] {
  if (!Array.isArray(value)) return [];
  return value.map(brainOf).filter((brain): brain is BrainWire => brain !== undefined);
}

const activeOf = (value: unknown): { active?: string } => (typeof value === 'string' && value !== '' ? { active: value } : {});

/**
 * The runner's `/status`, parsed — never cast (the wire is pinned by ONE fixture, read here
 * and by the process's route test). `undefined` for anything that is not a runner's status:
 * the boot treats a 200 that does not parse as "not a runner", so a static server that
 * happens to answer `/status` cannot make the page compose the runner's platform. An
 * optional seat of the wrong shape is dropped, which every reader takes as "not known".
 */
export function parseLocalStatus(value: unknown): LocalStatus | undefined {
  if (!isRecord(value) || value.binding !== 'local-host' || typeof value.port !== 'number' || typeof value.pages !== 'number') return undefined;
  return {
    binding: value.binding,
    port: value.port,
    pages: value.pages,
    ...(typeof value.heldBy === 'string' ? { heldBy: value.heldBy } : {}),
    ...(typeof value.oauthRedirect === 'boolean' ? { oauthRedirect: value.oauthRedirect } : {}),
    ...activeOf(value.active),
    brains: brainsOf(value.brains),
  };
}

/**
 * What a `status` event carries: the same brains `/status` does, late. `undefined` for a
 * frame with no brains list — that is not a status, and applying it would read as "no brain
 * is ready" and put the demo brain in front of a user whose agent is fine.
 */
export function parseStatusEvent(value: unknown): Pick<LocalStatus, 'active' | 'brains'> | undefined {
  if (!isRecord(value) || !Array.isArray(value.brains)) return undefined;
  return { ...activeOf(value.active), brains: brainsOf(value.brains) };
}

/**
 * Read the token out of the fragment and REMOVE it from the address bar before anything
 * else runs — including the router, which reads `location.hash` when it first renders.
 * `replaceState` rather than `pushState` so no history entry keeps the token either.
 *
 * `sessionStorage` is whatever the guarded accessor found (`safeStorage.ts`): undefined
 * where the global throws, and then this load still works and a reload has nothing to
 * remember the token by.
 */
export function claimTokenFromFragment(win: {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(state: unknown, title: string, url: string): void };
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined;
}): string | undefined {
  const match = /[#&]token=([0-9a-f]{64})\b/.exec(win.location.hash);
  if (match?.[1] !== undefined) {
    try {
      win.sessionStorage?.setItem(TOKEN_KEY, match[1]);
    } catch {
      /* a tab that cannot remember still works for this load */
    }
    // Land on the app's own default route, not on a hash the router would try to match.
    win.history.replaceState(null, '', `${win.location.pathname}#/`);
    return match[1];
  }
  try {
    return win.sessionStorage?.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The envelope the process answers `/fetch` with. */
interface FetchEnvelope {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  bodyBase64?: string;
  code?: string;
  message?: string;
}

/** Statuses that MUST carry no body: constructing a Response with one throws. */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Rebuild a `Response` the executor can run its gates against.
 *
 * Three things here are load-bearing rather than incidental:
 *  * a null-body status must be constructed with `null`, or `new Response` THROWS and a
 *    perfectly successful DELETE surfaces to the app as a transport failure;
 *  * a status outside 200–599 throws too, so it is clamped;
 *  * `statusText` outside the reason-phrase grammar throws, so it is dropped.
 */
export function responseFromEnvelope(envelope: FetchEnvelope): Response {
  const status = Math.min(599, Math.max(200, envelope.status ?? 200));
  const headers = new Headers();
  for (const [name, value] of envelope.headers ?? []) {
    try {
      headers.append(name, value);
    } catch {
      /* a header the browser forbids in a Response is not one the executor reads */
    }
  }
  // The db package's decoder — the repo's one (this file had a private copy of it). It is
  // TOTAL: garbage is `undefined`, and that must stay a failure rather than become "no body".
  const decoded = NULL_BODY_STATUS.has(status) || envelope.bodyBase64 === undefined ? null : base64ToBytes(envelope.bodyBase64);
  if (decoded === undefined) throw new Error('the local Snug runner answered a body that is not base64');
  // `BodyInit` wants an ArrayBuffer view spelled as a BufferSource; a bare Uint8Array
  // narrows differently under this TS lib. The bytes are identical either way.
  const body: BodyInit | null = decoded === null ? null : (decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength) as ArrayBuffer);
  const init: ResponseInit = { status, headers };
  if (envelope.statusText !== undefined && /^[\t -~\u0080-\u00ff]*$/.test(envelope.statusText)) {
    init.statusText = envelope.statusText;
  }
  return new Response(body, init);
}

/**
 * Serialize a request body for the wire. The executor always sends a string, but the OAuth
 * service sends `URLSearchParams` — and `JSON.stringify` of one yields `"{}"`, which would
 * make every token exchange and refresh a silently empty POST.
 */
export function serializeBody(body: BodyInit | null | undefined): string | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return String(body);
}

export interface LocalClientDeps {
  /** The page's own fetch, to its own origin. Late-bound by default so a test's stub is the one called. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** The event stream's clock and wait, for a test that turns them by hand. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  reconnectBoundMs?: number;
  retryMs?: number;
}

export function createLocalClient(token: string, deps: LocalClientDeps = {}): LocalClient {
  const auth = { authorization: `Bearer ${token}` };
  const send = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reconnectBoundMs = deps.reconnectBoundMs ?? EVENTS_RECONNECT_BOUND_MS;
  const retryMs = deps.retryMs ?? EVENTS_RETRY_MS;

  const call = (path: string, init: RequestInit = {}): Promise<Response> =>
    send(path, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } });

  let stopped = false;
  const stopListeners = new Set<() => void>();
  const markStopped = (): void => {
    if (stopped) return;
    stopped = true;
    for (const listener of stopListeners) listener();
  };

  return {
    async fetchImpl(input: string, init: RequestInit = {}): Promise<Response> {
      const headers: Record<string, string> = {};
      new Headers(init.headers ?? {}).forEach((value, name) => {
        headers[name] = value;
      });
      const response = await call('/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input,
          method: init.method ?? 'GET',
          headers,
          body: serializeBody(init.body),
        }),
      });
      if (!response.ok) throw new Error(`the local Snug runner answered ${response.status}`);
      const envelope = (await response.json()) as FetchEnvelope;
      // A proxy refusal is thrown, so the executor names it exactly as it names any other
      // transport failure — its own gates having already run.
      if (!envelope.ok) throw new Error(envelope.message ?? envelope.code ?? 'the request was refused');
      return responseFromEnvelope(envelope);
    },

    fs: {
      async readFile(path: string): Promise<Uint8Array | undefined> {
        const name = path.slice(path.lastIndexOf('/') + 1);
        const response = await call(`/userdb/${encodeURIComponent(name)}`);
        // 404 is absence and ONLY absence. Anything else must throw, or a transient failure
        // opens an empty database over the user's real file.
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error(`reading your file failed (${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async writeFileAtomic(path: string, bytes: Uint8Array): Promise<void> {
        // K7: the db swallows a failed save, so THIS is where a write to a runner that has
        // gone must be noticed. Once it is, nothing more is sent: the page is showing "the
        // runner stopped", and a late debounced save must not knock on a successor's door
        // with a dead bearer.
        if (stopped) throw new Error(RUNNER_STOPPED_MESSAGE);
        const name = path.slice(path.lastIndexOf('/') + 1);
        const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        let response: Response;
        try {
          response = await call(`/userdb/${encodeURIComponent(name)}`, { method: 'PUT', body: payload });
        } catch {
          // Nothing is listening where the runner was.
          markStopped();
          throw new Error(RUNNER_STOPPED_MESSAGE);
        }
        if (response.ok) return;
        // The runner's own "no": its bearer changed (a restart), or it is draining on its
        // way out — both carry the marker. Any other status is a failed save by a runner
        // that is still there (a held file, a disk error), and says so as before.
        if (response.status === 401 || isRunnerRefusal(response)) {
          markStopped();
          throw new Error(RUNNER_STOPPED_MESSAGE);
        }
        throw new Error(`saving your file failed (${response.status})`);
      },
    },

    events(onEvent): () => void {
      const controller = new AbortController();
      /** When the stream was last seen lost; cleared each time it opens. */
      let lostAt: number | undefined;
      /** One open stream, read to its end. Resolves when the stream closes; rejects when it cannot be opened or read. */
      const follow = async (): Promise<void> => {
        // `fetch` rather than `EventSource`: EventSource cannot carry an Authorization
        // header, and the bearer rule has no exceptions.
        const response = await call('/events', { signal: controller.signal });
        if (response.status === 401 || isRunnerRefusal(response)) {
          // A runner answered and does not know this page: it is a NEW runner, with a new
          // bearer. Waiting out the bound would only delay saying so.
          markStopped();
          return;
        }
        const reader = response.ok ? response.body?.getReader() : undefined;
        if (reader === undefined) throw new Error('the event stream could not be opened');
        lostAt = undefined;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const name = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (name === 'shutdown') {
              // The runner said it is going. Its own word, so no bound is waited out.
              markStopped();
              return;
            }
            if (name !== undefined && data !== undefined) {
              try {
                onEvent(name, JSON.parse(data));
              } catch {
                /* a frame we cannot read is not a reason to drop the stream */
              }
            }
            split = buffer.indexOf('\n\n');
          }
        }
      };
      void (async () => {
        while (!controller.signal.aborted && !stopped) {
          await follow().catch(() => undefined);
          if (controller.signal.aborted || stopped) return;
          // The stream ended or could not be opened. That is a runner that went away — or a
          // connection that dropped (a sleeping laptop). Only time tells them apart.
          lostAt ??= now();
          if (now() - lostAt >= reconnectBoundMs) {
            markStopped();
            return;
          }
          await sleep(retryMs);
        }
      })();
      return () => controller.abort();
    },

    async reportHandIn(report: HandInReport): Promise<void> {
      await call('/hand-in/outcome', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) }).catch(() => undefined);
    },

    async recheckBrain(): Promise<void> {
      await call('/brain/recheck', { method: 'POST' }).catch(() => undefined);
    },

    stopped: {
      get: () => stopped,
      subscribe(listener) {
        stopListeners.add(listener);
        return () => stopListeners.delete(listener);
      },
    },
  };
}
