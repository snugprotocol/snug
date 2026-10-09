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
// attach failed, freezing the session count that decides when to exit. So only a
// proven-dead owner's socket is removed, and that decision lives in `lock.ts`.
//
// THE WIRE (L3). One JSON object per line, each way. A request names an `op` from the list
// below. EVERY answer to a known op carries a positive ack — `{ ok: true, op }` — or
// `{ ok: false, op, error }`; an op this build does not know answers `{ error: 'unknown op' }`
// and reaches no handler. The plan review found why that matters: the socket used to answer
// every line with the same success-shaped hello, so a client asking an older primary to do
// something it had never heard of read `running: true` and called it done. `acked()` is the
// one test a client applies, and an older build's hello does not pass it.
//
// PRESENCE (L7). A connection that sent `attach` is a SESSION: it is held open, and counted
// until it closes. Everything else is a transient question — a status poll must not look
// like a second window, or `snug status` in a loop would keep the runner alive for ever.

import { chmodSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import { createLineFramer, MAX_RPC_LINE_BYTES } from './mcp/jsonrpc.js';

/** `sun_path` is 104 bytes on macOS and Node TRUNCATES rather than refusing (lesson 2026-08-26). */
export const MAX_SOCKET_PATH_BYTES = 100;

/**
 * The largest line either side will buffer. An attached session forwards `snug_hand_in`
 * over this socket, so the cap must not be SMALLER than the stdio transport's — a bundle
 * the pipe admitted would then be refused one hop later. The headroom is the `call`
 * wrapper and the handful of bytes re-serialising a number can add.
 */
export const MAX_CONTROL_LINE_BYTES = MAX_RPC_LINE_BYTES + 64 * 1024;

/**
 * Every op, and the only ops:
 *   hello       who is this — the token hash the lock records, the port, the build
 *   status      what `snug status` and `snug_status` report
 *   open        the primary opens the browser; answers the port, NEVER the address with its token
 *   launch-url  the ONE op that answers the bearer — the human CLI's, printed only to a terminal (L5)
 *   call        run one tool in the primary, so an attached session and the primary cannot drift
 *   attach      this connection is a session: hold it, count it
 *   stop        shut the primary down
 */
export const CONTROL_OPS = ['hello', 'status', 'open', 'launch-url', 'call', 'attach', 'stop'] as const;
export type ControlOp = (typeof CONTROL_OPS)[number];

/** A request as it arrives: `op` is one of ours; every other field is the op's own to narrow. */
export interface ControlRequest {
  op: ControlOp;
  [field: string]: unknown;
}

/** What a handler answers. The ack is added by the socket, so a handler cannot forge one. */
export type ControlBody = Record<string, unknown>;

/** An answer as a client reads it — untrusted until narrowed. */
export interface ControlAnswer {
  ok?: unknown;
  op?: unknown;
  error?: unknown;
  [field: string]: unknown;
}

/** Whether an answer is the positive ack of THAT op. An older build's hello never is. */
export const acked = (answer: ControlAnswer | undefined, op: ControlOp): answer is ControlAnswer & { ok: true } => answer?.ok === true && answer.op === op;

export interface ControlConnection {
  /**
   * Run once the answer has been written — for an op whose effect would cut its own answer
   * off (`stop` closes this very socket, and a hang-up is indistinguishable from a crash).
   */
  afterAnswer(run: () => void): void;
}

export interface ControlSocketDeps {
  /** Answers one request for a known op. A thrown error becomes that op's error answer. */
  handle(request: ControlRequest, connection: ControlConnection): Promise<ControlBody>;
  /** Called when the number of attached SESSIONS changes: the exit decision reads it (L7). */
  onPersistentCountChange?(count: number): void;
}

export interface ControlSocket {
  listen(path: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Attached sessions: connections that said `attach` and are still open. The ONLY count
   * there is — a count of every open connection used to sit beside it, and a second number
   * that includes status polls is one somebody will read as presence.
   */
  persistentCount(): number;
}

const isOp = (value: unknown): value is ControlOp => typeof value === 'string' && (CONTROL_OPS as readonly string[]).includes(value);

export function createControlSocket(deps: ControlSocketDeps): ControlSocket {
  /** Every open connection — kept only so `close()` can end them. Not counted, not reported. */
  const clients = new Set<Socket>();
  const persistent = new Set<Socket>();
  let server: Server | undefined;
  let socketPath: string | undefined;

  const answerFor = async (line: string, socket: Socket, afterAnswer: Array<() => void>): Promise<ControlAnswer> => {
    let request: unknown;
    try {
      request = JSON.parse(line);
    } catch {
      return { error: 'not a control request' };
    }
    if (typeof request !== 'object' || request === null || Array.isArray(request)) return { error: 'not a control request' };
    const { op } = request as { op?: unknown };
    if (typeof op !== 'string') return { error: 'not a control request' };
    // Checked against the LIST, not a lookup on an object: `constructor` is not an op.
    if (!isOp(op)) return { error: 'unknown op' };

    let body: ControlBody;
    try {
      body = await deps.handle(request as ControlRequest, { afterAnswer: (run) => afterAnswer.push(run) });
    } catch (error) {
      return { ok: false, op, error: error instanceof Error ? error.message : String(error) };
    }
    // The ack is written LAST so a handler's own `ok`/`op` fields cannot stand in for it.
    if (typeof body.error === 'string') return { ...body, ok: false, op };
    if (op === 'attach' && !socket.destroyed && !persistent.has(socket)) {
      persistent.add(socket);
      deps.onPersistentCountChange?.(persistent.size);
    }
    return { ...body, ok: true, op };
  };

  return {
    async listen(path: string): Promise<void> {
      if (Buffer.byteLength(path, 'utf8') > MAX_SOCKET_PATH_BYTES) {
        // Node truncates silently, so the helper would bind at a name nobody can compute
        // and look perfectly healthy.
        throw new Error(`the control socket path is too long (${Buffer.byteLength(path, 'utf8')} bytes): ${path}`);
      }
      const listening = createServer((socket) => {
        clients.add(socket);
        const forget = (): void => {
          clients.delete(socket);
          if (persistent.delete(socket)) deps.onPersistentCountChange?.(persistent.size);
        };
        socket.on('close', forget);
        // Errors on a peer socket are that peer's problem, never ours to crash on.
        socket.on('error', forget);

        const framer = createLineFramer(
          (line) => {
            void (async () => {
              const afterAnswer: Array<() => void> = [];
              const answer = await answerFor(line, socket, afterAnswer);
              if (socket.destroyed) return;
              socket.write(`${JSON.stringify(answer)}\n`, () => {
                for (const run of afterAnswer) run();
              });
            })();
          },
          {
            maxBytes: MAX_CONTROL_LINE_BYTES,
            // A peer that floods is told once and cut off — never resynchronised, because
            // whatever follows an over-long line on THIS socket is not a session worth keeping.
            onOverflow: () => socket.end(`${JSON.stringify({ error: 'line too long' })}\n`, () => socket.destroy()),
          },
        );
        socket.on('data', (chunk: Buffer) => framer.push(chunk));
      });

      await new Promise<void>((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(path, () => {
          try {
            // The access-control decision, applied the moment the socket exists.
            chmodSync(path, 0o600);
          } catch (error) {
            // The path went from under the bind (another process's take-over unlinks it).
            // A REJECTION, which the caller turns into a refusal after giving its lock back:
            // thrown from this callback it is an uncaught exception, and the process dies
            // holding that lock. Closed at once, while the name is still nobody's (closing
            // a unix listener unlinks the path it bound) — and rejected only once it IS
            // closed, so a failed listen never leaves a listener behind.
            listening.close(() => reject(error));
            return;
          }
          resolve();
        });
      });
      // Recorded only once it is OURS: a failed listen must leave `close()` nothing to
      // unlink — the path may be a live primary's.
      server = listening;
      socketPath = path;
    },

    async close(): Promise<void> {
      for (const client of clients) client.destroy();
      clients.clear();
      const current = server;
      server = undefined;
      if (current !== undefined) await new Promise<void>((resolve) => current.close(() => resolve()));
      if (socketPath !== undefined) rmSync(socketPath, { force: true });
      socketPath = undefined;
    },

    persistentCount(): number {
      return persistent.size;
    },
  };
}

// ------------------------------------------------------------------- the client

/** What a client sends. Not narrowed to the op list: asking an op the peer may not know is the point of the ack. */
export type ControlCallRequest = { op: string } & Record<string, unknown>;

/**
 * Connect, send one line, and hand each complete answer line to `onLine`. The socket is
 * returned so the caller decides whether to keep it (a session) or drop it (a question).
 */
function speak(path: string, request: ControlCallRequest, onLine: (answer: ControlAnswer | undefined) => void, onGone: () => void): Socket {
  const socket = createConnection(path);
  const framer = createLineFramer(
    (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      onLine(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as ControlAnswer) : undefined);
    },
    { maxBytes: MAX_CONTROL_LINE_BYTES, onOverflow: () => onLine(undefined) },
  );
  socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  socket.on('data', (chunk: Buffer) => framer.push(chunk));
  socket.on('error', onGone);
  socket.on('close', onGone);
  return socket;
}

/**
 * THE one client (L3): ask one question, read one answer, hang up. `undefined` when nothing
 * answered in time or the answer was not a JSON object — never a guess.
 *
 * It replaced three hand-rolled copies (the attached session's `open`, the CLI's, and the
 * lock's probe), each of which read the FIRST CHUNK as if it were a line.
 */
export function controlCall(path: string, request: ControlCallRequest, options: { timeoutMs?: number } = {}): Promise<ControlAnswer | undefined> {
  return new Promise<ControlAnswer | undefined>((resolve) => {
    let settled = false;
    const done = (answer: ControlAnswer | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const socket = speak(path, request, done, () => done(undefined));
    const timer = setTimeout(() => done(undefined), options.timeoutMs ?? 1_500);
    timer.unref?.();
  });
}

/** Ask a socket who it is — the attach handshake's identity check. */
export const probeControlSocket = (path: string, timeoutMs = 1_500): Promise<ControlAnswer | undefined> => controlCall(path, { op: 'hello' }, { timeoutMs });

export type AttachOutcome =
  /** The primary took the session; `close()` ends it. */
  | { kind: 'held'; answer: ControlAnswer; close(): void }
  /** Something answered, but not with the attach ack — an older build, or a primary on its way out. */
  | { kind: 'refused'; answer: ControlAnswer }
  /** Nothing answered. */
  | { kind: 'silent' };

/**
 * A session's presence (L7): one connection, held open for as long as the session lives.
 * The primary counts it; when it closes from the primary's side `onLost` says the primary
 * is gone, and the session re-runs `acquire` on its next tool call.
 */
export function attachControl(path: string, options: { timeoutMs?: number; onLost(): void }): Promise<AttachOutcome> {
  return new Promise<AttachOutcome>((resolve) => {
    let held = false;
    let closedByUs = false;
    let settled = false;
    const settle = (outcome: AttachOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.kind !== 'held') socket.destroy();
      resolve(outcome);
    };
    const socket = speak(
      path,
      { op: 'attach' },
      (answer) => {
        if (settled) return;
        if (answer === undefined) return settle({ kind: 'silent' });
        if (!acked(answer, 'attach')) return settle({ kind: 'refused', answer });
        held = true;
        settle({
          kind: 'held',
          answer,
          close: () => {
            closedByUs = true;
            socket.destroy();
          },
        });
      },
      () => {
        if (!settled) return settle({ kind: 'silent' });
        if (held && !closedByUs) {
          held = false;
          options.onLost();
        }
      },
    );
    const timer = setTimeout(() => settle({ kind: 'silent' }), options.timeoutMs ?? 1_500);
    timer.unref?.();
  });
}
