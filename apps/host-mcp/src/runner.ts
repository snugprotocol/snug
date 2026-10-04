// The composition root: lock → listener → control socket → tools (ADR-0068 §3).
//
// LIFETIME (D-B9, L7). Two agent windows are one Snug: the second ATTACHES over the control
// socket instead of spawning a rival. Presence is a held connection — an attached session
// keeps ONE open for as long as it lives, and the primary counts those. The primary exits,
// after a grace, only when its OWN session is gone AND no attached session remains; the
// decision is re-made on every change to either. A transient op (a status poll, a hand-in
// forwarded by another window) is not presence: it neither holds the runner nor resets its
// grace.
//
// SUCCESSION. When the primary goes, an attached session notices its held connection close.
// It does nothing until its agent next calls a tool; then it runs the same start a new
// process would, becomes the primary, and says the page must be opened again — a new runner
// is a new bearer, and the old page cannot talk to it.
//
// HANDSHAKE FIRST (L2). Nothing here throws at start. A runner that can neither lead nor
// attach is DEGRADED: it holds a row of the refusal table, `snug_status` returns that row,
// every other tool returns its sentence, and each tool call re-runs the start (rate-bounded)
// so a cause the user has fixed clears without restarting the agent. Before this, every one
// of those failures killed the process ahead of the MCP handshake and the host could say
// only "Connection closed" (measured 2026-10-03, with a healthy runner holding the lock).

import { randomBytes, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';

import { parseAppBundle } from '@snugprotocol/protocol';

import type { BrainRegistry } from './brains/registry.js';
import { buildId, VERSION } from './build.js';
import {
  acked,
  attachControl,
  controlCall,
  createControlSocket,
  MAX_SOCKET_PATH_BYTES,
  probeControlSocket,
  type ControlAnswer,
  type ControlBody,
  type ControlConnection,
  type ControlRequest,
  type ControlSocket,
} from './control-socket.js';
import { createFetchProxy, type FetchProxy } from './fetch-proxy.js';
import { ensureDirectory, RealHomeRefusedError } from './home.js';
import { askToStop, isAlive, readCommandLine } from './identity.js';
import { acquireLock, controlSocketPath, reassertLock, recordBoundPort, releaseLock, type LockDeps } from './lock.js';
import { createLoopbackServer, type HandInReport, type LoopbackServer } from './loopback-server.js';
import { nodeHttpsSend } from './node-transport.js';
import { refusalFor, refusalSentence, type Refusal, type RefusalCode, type RefusalFacts } from './refusals.js';
import { TOOL_NAMES, type ToolName } from './tools.js';
import { createUserFileStore } from './userdb-fs.js';

/**
 * The fixed port (D-B13). The OAuth redirect URI is `${origin}/oauth/callback` and the user
 * registers that exact string in a provider's dashboard, so the origin must survive a
 * restart. A busy port falls back to an ephemeral one and DISABLES the OAuth rows with a
 * reason — never silently changes a URI the user has already registered somewhere.
 */
export const SNUG_LOCAL_PORT = 43127;

/** How long a degraded runner waits before a tool call may re-run the start. */
const RETRY_FLOOR_MS = 1_000;
/**
 * How long the page's first request waits for the brain probe. A probe that needs no spawn
 * (no CLI anywhere) answers at once and rides that very read; one that has to start the
 * user's CLI takes seconds and arrives as a `status` event instead — the kit must not wait
 * to open on it.
 */
const FIRST_CONTACT_WAIT_MS = 250;
/** A forwarded tool call: `snug_open` in the primary may spend its whole opener bound. */
const CALL_TIMEOUT_MS = 15_000;
/** How long a stop waits for `/userdb` writes already in flight before it releases the lock. */
const DRAIN_WRITES_MS = 2_000;
/**
 * How long `snug_hand_in` waits for the page to say what it did with the bundle (K6). A
 * page that is open answers in well under a second (it parses, installs and reports); past
 * this the tool says "sent — not confirmed" rather than claiming a delivery or holding the
 * agent. Well inside `CALL_TIMEOUT_MS`, so an attached session's forwarded call still gets
 * the primary's own answer.
 */
const HAND_IN_WAIT_MS = 5_000;

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface RunnerOptions {
  /**
   * The user's own agents that may answer a think (ADR-0071). REQUIRED, and never built
   * here: a runner that made its own would probe the real machine, which is how the unit
   * suite and the browser suite came to spawn the developer's real `claude` (found
   * 2026-10-03). The release entry hands in the machine's drivers, the test entry fakes,
   * a unit test its own. Probed LAZILY — at the first page contact, never at start (B1): a
   * session that only speaks over stdio must spawn no CLI.
   */
  brains: BrainRegistry;
  /**
   * Where this runner keeps its state. REQUIRED (D-B34): it used to default to the live
   * `~/Snug`, which is how a test destroyed the owner's user file. A caller that wants the
   * real home resolves it deliberately with `resolveHome({ allowRealHome: true })`.
   */
  home: string;
  /** The kit page's bytes. */
  page: () => string;
  /** Opens a URL in the user's browser. Injected so tests never launch one. */
  openBrowser?(url: string): Promise<void>;
  /** Names the product holding the user file, when one does (D-B10). */
  heldBy?(): string | undefined;
  lockDeps?: Partial<LockDeps>;
  /**
   * The outbound transport, injected. The release entry passes nothing and gets
   * `nodeHttpsSend`; the TEST entry passes one carrying a resolver so a stub on 127.0.0.1
   * can answer for a public-looking hostname (D-B11). The hook lives in the second build,
   * never here — `check-host-mcp` sweeps the release bundle for its env names.
   */
  proxy?: { handle: FetchProxy['handle'] };
  /** How long after its own session leaves — with no other attached — before exiting. */
  graceMs?: number;
  /** The ports to try, in order. The fixed one, then any. */
  ports?: readonly number[];
  /** How long a degraded runner waits before a tool call re-runs the start. */
  retryFloorMs?: number;
  /** How long an attached session waits for the primary to answer a forwarded tool call. */
  callTimeoutMs?: number;
  /** How the human CLI is run on this install — the launcher's real path, for every remedy (L5). */
  cli?: string;
  /** `stop` arrived over the control socket: shut the PROCESS down. Defaults to stopping this runner. */
  onStopRequested?(): void;
  /** How long `snug_hand_in` waits for the page's report. Tests shorten it. */
  handInWaitMs?: number;
}

export interface RunnerStart {
  role: 'primary' | 'attached' | 'degraded';
  /** The port the runner serves on; 0 while degraded. */
  port: number;
  /** The launch URL — with its fragment only for the primary, which is the one that holds the bearer. */
  url: string;
  /** Why it is degraded. */
  refusal?: Refusal;
}

export interface Runner {
  /** Never rejects: a start that cannot succeed resolves `degraded` with the reason. */
  start(): Promise<RunnerStart>;
  callTool(name: ToolName, args: Record<string, unknown>): Promise<ToolCallResult>;
  /**
   * This runner's OWN session is gone (stdin closed, or the parent went away). An attached
   * or degraded runner leaves at once; a primary leaves after the grace, once no attached
   * session remains.
   */
  beginGrace(onExit: () => void): void;
  stop(): Promise<void>;
  /** The launch URL, fragment included. Never crosses an MCP message (D-B8). */
  launchUrl(): string;
}

const text = (value: string, isError = false): ToolCallResult => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) });

/** What a status leads with, degraded or not: which Snug this is. */
const whoami = (): { version: string; build: string; pid: number; platform: string } => ({
  version: VERSION,
  build: buildId(),
  pid: process.pid,
  platform: process.platform,
});

const refusedStatus = (refusal: Refusal): ToolCallResult => text(JSON.stringify({ running: false, ...whoami(), refusal }));

/**
 * `snug_hand_in`'s answer, from what the page reported (K6) — or, with no report inside the
 * bound, the one thing that is known: it was sent. The app's name is the one THIS process
 * parsed out of the bundle; of the page's words only the (already flattened and bounded)
 * reason is quoted.
 */
export function handInAnswer(displayName: string, report: HandInReport | undefined): ToolCallResult {
  const name = JSON.stringify(displayName);
  if (report === undefined) return text(`sent ${name} to the open runner — not confirmed`);
  switch (report.outcome) {
    case 'installed':
      return text(`installed ${name} in the open runner`);
    case 'updated':
      return text(`updated ${name}${report.version !== undefined ? ` to v${report.version}` : ''} in the open runner`);
    case 'current':
      return text(`${name} is already current in the open runner — nothing changed`);
    case 'offered':
      return text(`offered — the user edited ${name}, so the update waits for them`);
    case 'refused':
      return text(`refused: ${report.reason === undefined || report.reason === '' ? 'the open runner gave no reason' : report.reason}`, true);
  }
}

const errnoOf = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
};

const isToolName = (value: unknown): value is ToolName => typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);

/** A tool result as it comes back over the socket — narrowed, because the peer is another process. */
const isToolResult = (value: unknown): value is ToolCallResult => {
  if (typeof value !== 'object' || value === null) return false;
  const { content } = value as { content?: unknown };
  return Array.isArray(content) && content.every((part) => typeof part === 'object' && part !== null && typeof (part as { text?: unknown }).text === 'string');
};

/** Whether ANYTHING answers HTTP on a loopback port. Any status counts: the question is "is it serving". */
const portAnswers = async (port: number): Promise<boolean> => {
  try {
    await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
};

/** Whether a unix socket path has a listener behind it — a connect, not a conversation. */
const somethingListens = (socketPath: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    // Unsure is LIVE: the answer decides an unlink, and a live socket must never be unlinked.
    const timer = setTimeout(() => finish(true), 1_000);
    const finish = (live: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(live);
    };
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });

/**
 * A CURRENT runner answering on a control socket: its hello carries the ack, a build, a port
 * and a pid. An older build's hello has no ack, and a squatter's has nothing.
 */
const runnerOn = async (socketPath: string): Promise<{ port: number; pid: number } | undefined> => {
  const hello = await probeControlSocket(socketPath);
  return acked(hello, 'hello') && typeof hello.build === 'string' && typeof hello.port === 'number' && typeof hello.pid === 'number'
    ? { port: hello.port, pid: hello.pid }
    : undefined;
};

type State =
  /** Never started, or stopped. */
  | { role: 'idle' }
  | { role: 'primary'; server: LoopbackServer; control: ControlSocket; port: number }
  | { role: 'attached'; port: number; socket: string; pid: number; presence: { lost: boolean }; leave(): void }
  | { role: 'degraded'; refusal: Refusal; at: number };

/**
 * A runner that was refused before it could exist — no home to give it, or a damaged
 * install. It answers exactly as a degraded one does and never retries: neither cause can
 * change inside a running process.
 *
 * IT BINDS NOTHING (D8, decided 2026-10-03): no lock, no control socket, no listener. Its
 * answers are its whole channel. A damaged install used to serve one fixed document from a
 * bare listener on the fixed port; with no lock behind it, a healthy install started beside
 * it lost that port to it and came up on an ephemeral one with its OAuth rows disabled.
 */
export function createRefusedRunner(refusal: Refusal): Runner {
  return {
    start: async () => ({ role: 'degraded', port: 0, url: '', refusal }),
    callTool: async (name) => (name === 'snug_status' ? refusedStatus(refusal) : text(refusalSentence(refusal), true)),
    beginGrace: (onExit) => onExit(),
    stop: async () => {},
    launchUrl: () => '',
  };
}

export function createRunner(options: RunnerOptions): Runner {
  // Types stop a caller inside this repo; this stops a JS caller, a stale build and a
  // `as any` — the guard has to hold at runtime because the failure it prevents is silent.
  const home = options.home;
  if (typeof home !== 'string' || home === '') {
    throw new RealHomeRefusedError('createRunner needs an explicit home; it no longer defaults to the real ~/Snug (D-B34)');
  }
  // The same kind of guard, for the same kind of reason: a default here would be the real
  // machine's CLIs, and a forgotten option would spend the user's subscription.
  const brains = options.brains;
  if (typeof brains !== 'object' || brains === null) {
    throw new Error('createRunner needs an explicit brain registry; it never builds one that probes the real machine (ADR-0071)');
  }
  const hostDir = path.join(home, 'host');
  const graceMs = options.graceMs ?? 3_000;
  const retryFloorMs = options.retryFloorMs ?? RETRY_FLOOR_MS;
  const callTimeoutMs = options.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const ports = options.ports ?? [SNUG_LOCAL_PORT, 0];
  const cli = options.cli ?? 'sh <plugin>/scripts/snug';
  const open = options.openBrowser ?? (async (): Promise<void> => {});
  const handInWaitMs = options.handInWaitMs ?? HAND_IN_WAIT_MS;

  // 256 bits, memory only. It reaches the page in the launch URL's fragment and is written
  // nowhere: the lock keeps only its hash.
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const socketPath = controlSocketPath(hostDir);

  let state: State = { role: 'idle' };
  /** The start in flight. Every tool call waits for it rather than answering from a half-built runner. */
  let pending: Promise<void> | undefined;
  let stopped = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once this runner's own session is gone; called when the runner may go too. */
  let exitHook: (() => void) | undefined;
  /** This runner took over from a primary that went away: the agent must open the page again. */
  let reopenNote = false;
  /** Whether the listener holds the port a user registers as their OAuth redirect (D-B13). */
  let boundFixedPort = false;
  /** Hand-ins sent to the page and not yet reported on, by the id their event carried (K6). */
  const awaitingOutcome = new Map<string, (report: HandInReport) => void>();

  const lockDeps: LockDeps = {
    pid: process.pid,
    isAlive,
    commandLineOf: readCommandLine,
    // The control socket answers a general shape; the lock needs a definite identity.
    // Narrowing HERE rather than widening the lock's contract keeps "an answer without
    // an identity is not an answer" true at the one place that decides take-over.
    probeSocket: async (target) => {
      const answer = await probeControlSocket(target);
      return typeof answer?.tokenHash === 'string' && typeof answer.port === 'number' ? { tokenHash: answer.tokenHash, port: answer.port } : undefined;
    },
    probePort: portAnswers,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    kill: askToStop,
    now: () => Date.now(),
    ...options.lockDeps,
  };

  const facts = (extra: Partial<RefusalFacts> = {}): RefusalFacts => ({ cli, home, ...extra });
  const degrade = (code: RefusalCode, extra: Partial<RefusalFacts> = {}): void => {
    state = { role: 'degraded', refusal: refusalFor(code, facts(extra)), at: Date.now() };
  };
  const pidFact = (pid: number | undefined): Partial<RefusalFacts> => (pid === undefined ? {} : { pid });

  /** Read through a call: TypeScript keeps a narrowing of `state` across an `await` that changed it. */
  const roleNow = (): State['role'] => state.role;

  const url = (): string => (state.role === 'primary' ? `http://127.0.0.1:${state.port}/#token=${token}` : state.role === 'attached' ? `http://127.0.0.1:${state.port}/` : '');

  // ------------------------------------------------------------------ the exit decision

  const clearGrace = (): void => {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    graceTimer = undefined;
  };
  const leaveNow = (): void => {
    const exit = exitHook;
    exitHook = undefined;
    exit?.();
  };
  /** Whether a primary has nobody left: its own session gone and no attached one. */
  const alone = (): boolean => state.role === 'primary' && state.control.persistentCount() === 0;

  /** Re-made on every change: the own session ending, an attached session arriving or leaving. */
  const reevaluate = (): void => {
    if (exitHook === undefined || stopped) return;
    if (state.role !== 'primary') {
      // An attached or degraded runner holds nothing another session depends on.
      leaveNow();
      return;
    }
    if (!alone()) {
      // Somebody attached during the grace: the runner belongs to whoever is still here.
      clearGrace();
      return;
    }
    // Armed only while alone, and CLEARED the moment that stops being true (above) — so a
    // timer that fires is a grace nobody interrupted.
    graceTimer ??= setTimeout(() => {
      graceTimer = undefined;
      leaveNow();
    }, graceMs);
    graceTimer.unref?.();
  };

  // ------------------------------------------------------------------ the tools, as primary

  const statusDoc = (primary: Extract<State, { role: 'primary' }>): Record<string, unknown> => {
    const held = options.heldBy?.();
    // READ, never probed: a status asked over stdio or the control socket must spawn no CLI
    // (B1), so before the first page contact every brain says it has not been checked yet.
    const { active, brains: known } = brains.statuses();
    return {
      running: true,
      ...whoami(),
      home,
      file: path.join(home, 'user.snug'),
      port: primary.port,
      pages: primary.server.subscriberCount(),
      clients: primary.control.persistentCount(),
      ...(held !== undefined ? { heldBy: held } : {}),
      binding: 'local-host',
      // Which of the user's own agents answers their apps — or `active` absent: none is
      // ready, and the page's demo brain answers with the remedy shown.
      ...(active !== undefined ? { active } : {}),
      brains: known.map(({ id, name, state, detail, verified }) => ({ id, name, state, ...(detail !== undefined ? { detail } : {}), verified })),
      ...(reopenNote ? { note: 'The Snug runner this session was attached to went away, so this session now runs Snug. Call snug_open to open the page again.' } : {}),
    };
  };

  const openPage = async (): Promise<void> => {
    await open(url());
    reopenNote = false;
  };

  const callAsPrimary = async (primary: Extract<State, { role: 'primary' }>, name: ToolName, args: Record<string, unknown>): Promise<ToolCallResult> => {
    const { server } = primary;
    switch (name) {
      case 'snug_status':
        return text(JSON.stringify(statusDoc(primary)));

      case 'snug_open': {
        try {
          await openPage();
          // The address WITHOUT the fragment: the token never rides an MCP message.
          return text(`Snug is open at http://127.0.0.1:${primary.port}/`);
        } catch {
          // The one way the address reaches a person without a browser: their own terminal.
          return text(`could not open a browser here. Ask the user to run: ${cli} open --print`, true);
        }
      }

      case 'snug_hand_in': {
        const bundle = args.bundle;
        if (bundle === undefined) return text('snug_hand_in needs a bundle', true);
        const parsed = parseAppBundle(typeof bundle === 'string' ? bundle : JSON.stringify(bundle));
        if (!parsed.ok) {
          // `reason` is the parser's own vocabulary; its `issues` name the field when the
          // shape is close but wrong, which is the case an agent can actually fix.
          const detail = parsed.reason === 'invalid' ? (parsed.issues ?? []).map((i) => `${i.path}: ${i.message}`).join('; ') : parsed.reason;
          return text(`that is not a valid snug-app-bundle/1 (${detail})`, true);
        }
        // D4 is the PAGE's decision; refusing here too gives the agent a clear error
        // instead of a silent no-op, and the page refuses again at its own boundary.
        if (parsed.bundle.connections.length > 0) {
          return text(
            `"${parsed.bundle.app.displayName}" asks for a connection. The user connects apps in the runner's own wizard — a bundle cannot bring one.`,
            true,
          );
        }
        if (server.subscriberCount() === 0) {
          return text('no Snug page is open — call snug_open first, then hand the app in', true);
        }
        // The page owns the database, so only the page knows what became of the bundle:
        // installed, updated, offered to a user who edited their copy, or refused. It says
        // so on `POST /hand-in/outcome`, naming this id — and the answer waits for that,
        // bounded. "handed to the open runner" used to be said the moment the event was
        // written, whatever the page then did with it.
        const id = randomBytes(16).toString('hex');
        const report = await new Promise<HandInReport | undefined>((resolve) => {
          const timer = setTimeout(() => {
            awaitingOutcome.delete(id);
            resolve(undefined);
          }, handInWaitMs);
          timer.unref?.();
          awaitingOutcome.set(id, (reported) => {
            clearTimeout(timer);
            awaitingOutcome.delete(id);
            resolve(reported);
          });
          server.emit('hand-in', { id, bundle: parsed.bundle });
        });
        return handInAnswer(parsed.bundle.app.displayName, report);
      }

      case 'snug_list_apps':
        // The page owns the database; the process never opens it. Until the page reports
        // its library over the control plane, saying so is the honest answer.
        return text(JSON.stringify({ apps: [], note: 'the open runner lists the user’s apps; ask them what they have' }));

      default:
        return text(`unknown tool: ${String(name)}`, true);
    }
  };

  // ------------------------------------------------------------------ the control plane

  const requestStop = options.onStopRequested ?? ((): void => void runner.stop());

  const handleControl = async (request: ControlRequest, connection: ControlConnection): Promise<ControlBody> => {
    const primary = state;
    if (primary.role !== 'primary') throw new Error('this runner is not running');
    switch (request.op) {
      case 'hello':
      case 'attach':
        // Somebody is looking for the runner, and found it by its socket. Make sure the
        // lock can find it too (see `lead`: a newcomer that won a lock this runner had lost
        // gives it back just before it attaches).
        holdLock(primary.port);
        return { tokenHash, port: primary.port, ...whoami() };

      case 'status':
        return statusDoc(primary);

      case 'open':
        // The primary opens the browser, because it is the one that holds the bearer. The
        // answer is the PORT: the address with its token is `launch-url`'s alone (L5).
        try {
          await openPage();
          return { port: primary.port };
        } catch {
          return { error: 'could not open a browser', port: primary.port };
        }

      case 'launch-url':
        // THE ONE OP THAT ANSWERS THE BEARER. Only the human CLI asks, and it prints the
        // answer only to a terminal. A canary test sweeps every other op's answers.
        return { url: url() };

      case 'call': {
        // An attached session's tool call, run by the SAME code the primary runs for its
        // own agent — so the two cannot drift, and a hand-in is re-validated here whatever
        // the session did or did not check (C5).
        const { name, args = {} } = request;
        if (!isToolName(name)) return { error: 'unknown tool' };
        if (typeof args !== 'object' || args === null || Array.isArray(args)) return { error: 'arguments must be an object' };
        return { result: await callAsPrimary(primary, name, args as Record<string, unknown>) };
      }

      case 'stop': {
        // A page may hold work the runner has not been given yet, and a stopped runner
        // cannot take it: refuse unless the person said force. Only a literal `true` is.
        const pages = primary.server.subscriberCount();
        if (pages > 0 && request.force !== true) return { error: 'pages-open', pages };
        // Acked FIRST: stopping closes this socket, and a hang-up reads as a crash.
        connection.afterAnswer(requestStop);
        return { pid: process.pid };
      }
    }
  };

  // ------------------------------------------------------------------ the start

  /**
   * The first page contact (B1): start the brains' first probe round, and give a fast answer
   * the chance to ride this read. A round that has to start a CLI lands later, as a
   * `status` event.
   */
  const firstContact = async (): Promise<void> => {
    await Promise.race([
      brains.probe(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, FIRST_CONTACT_WAIT_MS).unref?.();
      }),
    ]);
  };

  // Every probe round — the first contact's and each re-check's — ends by telling the open
  // pages what the brains can do now.
  const unsubscribeBrains = brains.subscribe(() => {
    if (state.role === 'primary') state.server.emitStatus();
  });

  /** Bind the control socket. A path already there is either a live runner's (refuse) or litter (replace). */
  const listenControl = async (control: ControlSocket): Promise<{ code: RefusalCode; detail?: string } | undefined> => {
    try {
      await control.listen(socketPath);
      return undefined;
    } catch (error) {
      if (errnoOf(error) !== 'EADDRINUSE') return { code: 'home-unwritable', detail: errnoOf(error) };
    }
    if (await somethingListens(socketPath)) return { code: 'socket-in-use' };
    // We hold the lock and nothing answers a connect: a dead runner's file. This is the
    // canonical path and its owner is proven gone — the one case an unlink is allowed.
    rmSync(socketPath, { force: true });
    try {
      await control.listen(socketPath);
      return undefined;
    } catch (error) {
      return { code: 'socket-in-use', detail: errnoOf(error) };
    }
  };

  /**
   * The lock names THIS runner for as long as it owns the socket. A lock that went missing
   * under a live runner (removed by hand, or by a newcomer from a build without the
   * take-over mutex) is put back; one that is there is never touched. Best effort: the
   * socket answers either way, and it is the socket a newcomer finally believes.
   */
  const holdLock = (port: number): void => {
    try {
      reassertLock(hostDir, { port, pid: process.pid, tokenHash, startedAt: Date.now(), socket: socketPath });
    } catch {
      /* a home that cannot be written right now; the next hello tries again */
    }
  };

  const lead = async (): Promise<void> => {
    // Out here so `abandon` reaches whatever a start got as far as making.
    let server: LoopbackServer | undefined;
    let control: ControlSocket | undefined;
    /**
     * Nothing of ours may outlive a start that did not finish: the next attempt — this
     * runner's own retry included — must find no lock, no listener and no socket to trip on.
     */
    const abandon = async (): Promise<void> => {
      await control?.close();
      await server?.close();
      await releaseLock(hostDir, tokenHash);
    };

    try {
      server = createLoopbackServer({
        token,
        page: options.page,
        proxy: options.proxy ?? createFetchProxy({ send: nodeHttpsSend }),
        store: createUserFileStore(home),
        brains,
        onFirstContact: firstContact,
        // A think just failed, or the demo brain is answering in a real brain's place (D4).
        // The floor is the registry's: asked in a loop, it is still one round per floor.
        onBrainRecheck: () => brains.recheck(),
        oauthRedirect: () => boundFixedPort,
        onHandInOutcome: (report) => awaitingOutcome.get(report.id)?.(report),
        ...(options.heldBy !== undefined ? { heldBy: options.heldBy } : {}),
      });

      // The fixed port first; an ephemeral fallback keeps the runner usable, and the page
      // is told the OAuth rows are unavailable rather than being handed a changed origin.
      let port: number | undefined;
      let listenError: unknown;
      for (const candidate of ports) {
        try {
          ({ port } = await server.listen(candidate));
          // Only the FIRST candidate is an address a user can have registered, and only
          // when it names a port: "any port" (0) is nobody's redirect URI.
          boundFixedPort = candidate !== 0 && candidate === ports[0];
          break;
        } catch (error) {
          listenError = error;
        }
      }
      if (port === undefined) {
        await abandon();
        degrade('listen-failed', { detail: errnoOf(listenError) });
        return;
      }

      control = createControlSocket({ handle: handleControl, onPersistentCountChange: reevaluate });
      const refused = await listenControl(control);
      if (refused !== undefined) {
        await abandon();
        // THE SOCKET IS THE LAST WORD. This process won the lock and a live runner of this
        // build holds the socket: that one is the runner — it has the user file and maybe
        // open pages — and its lock went missing, or named a process that has since died
        // (`lock.ts` replaces such a record and leaves this socket alone, so that this is
        // where the newcomer lands). Refusing here was permanent (every later process wins
        // the same lock and meets the same socket), so join it instead. The lock was given
        // back FIRST: the runner puts its own record there as we attach.
        const owner = refused.code === 'socket-in-use' ? await runnerOn(socketPath) : undefined;
        if (owner !== undefined) await attach({ ...owner, socket: socketPath });
        else degrade(refused.code, refused.detail !== undefined ? { detail: refused.detail } : {});
        return;
      }
      recordBoundPort(hostDir, tokenHash, port);
      holdLock(port);
      state = { role: 'primary', server, control, port };
    } catch (error) {
      // Whatever threw, it threw with the lock held and perhaps a listener bound. A runner
      // left holding its own lock would contend with ITSELF on its next attempt.
      await abandon().catch(() => {});
      throw error;
    }
  };

  const attach = async (primary: { port: number; socket: string; pid: number }): Promise<void> => {
    const presence = { lost: false };
    const outcome = await attachControl(primary.socket, { onLost: () => void (presence.lost = true) });
    if (outcome.kind === 'held') {
      state = { role: 'attached', ...primary, presence, leave: outcome.close };
      return;
    }
    // It answered the lock's probe a moment ago. If it now answers `attach` with anything
    // but an attach answer, it does not KNOW the op: an older build, which says its hello
    // to every line. Working through it would be a false success (L3) — say so instead.
    if (outcome.kind === 'refused' && outcome.answer.op !== 'attach') degrade('older-build', { pid: primary.pid });
    else degrade('lock-contended', { pid: primary.pid });
  };

  const bringUp = async (): Promise<void> => {
    try {
      try {
        // The lock, the control socket and each brain's own working directory live here.
        ensureDirectory(hostDir);
      } catch (error) {
        degrade('home-unwritable', { detail: errnoOf(error) });
        return;
      }
      // Decided before anything is locked or bound: Node would TRUNCATE the path rather
      // than refuse it, and bind at a name nobody can compute.
      const socketBytes = Buffer.byteLength(socketPath, 'utf8');
      if (socketBytes > MAX_SOCKET_PATH_BYTES) {
        degrade('socket-path-too-long', { detail: `${socketBytes} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}` });
        return;
      }

      const acquired = await acquireLock(hostDir, { port: ports[0] ?? 0, tokenHash, socket: socketPath }, lockDeps);
      if (acquired.role === 'refused') degrade(acquired.code, pidFact(acquired.pid));
      else if (acquired.role === 'attached') await attach(acquired);
      else await lead();
    } catch (error) {
      // What is left to throw here is the filesystem under the home (an unremovable stale
      // lock, a host directory that turned read-only): the same row, with the system's word.
      degrade('home-unwritable', { detail: errnoOf(error) });
    }
  };

  const begin = (): Promise<void> => {
    pending = bringUp().finally(() => {
      pending = undefined;
      reevaluate();
    });
    return pending;
  };

  /** Wait for a start in flight; re-run it when this runner lost its primary, or was refused long enough ago. */
  const settled = async (): Promise<void> => {
    if (pending === undefined && !stopped) {
      if (state.role === 'attached' && state.presence.lost) {
        state.leave();
        await begin();
        // A new runner is a new bearer: the page the old one served cannot talk to this one.
        if (roleNow() === 'primary') reopenNote = true;
        return;
      }
      if (state.role === 'degraded' && Date.now() - state.at >= retryFloorMs) {
        await begin();
        return;
      }
    }
    await pending;
  };

  /**
   * Why a forwarded call did not come back as a tool result — said as what it IS. Only a
   * success-shaped answer with no ack is an older build (its hello, said to every line);
   * an answer that names an error is that error, whoever refused.
   */
  const unackedSentence = (answer: ControlAnswer, pid: number): string => {
    if (typeof answer.error !== 'string') {
      return acked(answer, 'call') ? 'the Snug runner answered something this session cannot read' : refusalSentence(refusalFor('older-build', facts({ pid })));
    }
    // The handler's own refusal (an unknown tool, bad arguments): the primary's words.
    if (answer.op === 'call') return answer.error;
    // The socket's: it never reached a handler.
    if (answer.error === 'line too long') return 'that is too large to send to the Snug runner this session is attached to';
    return `the Snug runner refused the request (${answer.error})`;
  };

  const dispatch = async (name: ToolName, args: Record<string, unknown>, mayRecover: boolean): Promise<ToolCallResult> => {
    const current = state;
    switch (current.role) {
      case 'primary':
        return callAsPrimary(current, name, args);

      case 'degraded':
        return name === 'snug_status' ? refusedStatus(current.refusal) : text(refusalSentence(current.refusal), true);

      case 'attached': {
        const answer = await controlCall(current.socket, { op: 'call', name, args }, { timeoutMs: callTimeoutMs });
        if (answer === undefined) {
          // Nothing came back. That is a primary that is GONE — or one that is alive and
          // slow, and may yet do what was asked. Only the first may be replaced and asked
          // again: a hand-in sent twice is an app installed twice. The held connection says
          // which, and where it has not spoken yet, the socket is asked.
          if (!current.presence.lost && (await probeControlSocket(current.socket)) !== undefined) {
            return text('the Snug runner did not answer in time — it may still be working. Call snug_status before trying again.', true);
          }
          if (!mayRecover) return text('the Snug runner went away — try again', true);
          // Take its place and answer from there.
          current.presence.lost = true;
          await settled();
          return dispatch(name, args, false);
        }
        // An answer that is not this op's ack with a tool result in it is never read as success (L3).
        if (!acked(answer, 'call') || !isToolResult(answer.result)) return text(unackedSentence(answer, current.pid), true);
        if (name !== 'snug_status') return answer.result;
        // The primary's own status, plus the one fact only this side knows.
        try {
          return text(JSON.stringify({ ...(JSON.parse(answer.result.content[0]?.text ?? '') as Record<string, unknown>), attached: true }));
        } catch {
          return answer.result;
        }
      }

      case 'idle':
        return text('the runner is not running', true);
    }
  };

  const snapshot = (): RunnerStart => ({
    role: state.role === 'primary' || state.role === 'attached' ? state.role : 'degraded',
    port: state.role === 'primary' || state.role === 'attached' ? state.port : 0,
    url: url(),
    ...(state.role === 'degraded' ? { refusal: state.refusal } : {}),
  });

  const runner: Runner = {
    async start() {
      if (state.role === 'idle' && pending === undefined && !stopped) await begin();
      else await pending;
      return snapshot();
    },

    async callTool(name, args) {
      await settled();
      return dispatch(name, args, true);
    },

    beginGrace(onExit) {
      exitHook ??= onExit;
      // A start still in flight decides what there is to leave; it re-evaluates when it lands.
      if (pending === undefined) reevaluate();
    },

    async stop() {
      stopped = true;
      clearGrace();
      unsubscribeBrains();
      await pending;
      const current = state;
      state = { role: 'idle' };
      if (current.role === 'attached') current.leave();
      if (current.role !== 'primary') return;
      // EVERY SPAWN OWES A REAP (lessons 2026-08-18/19): every brain's children go first,
      // before the listener that could hand out another — and the registry owes no further
      // probe once it is stopped.
      brains.stop();
      current.server.emit('shutdown', {});
      // THE ORDER IS THE POINT (L4). Writes already in flight land BEFORE the lock goes —
      // a successor that took the lock mid-write would be a second writer on the user file.
      // Then the socket (so the successor finds none to trip on), then the lock, and only
      // then the listener, whose close may linger behind an open response.
      await current.server.drainWrites(DRAIN_WRITES_MS);
      await current.control.close();
      await releaseLock(hostDir, tokenHash);
      await current.server.close();
    },

    launchUrl: url,
  };

  return runner;
}
