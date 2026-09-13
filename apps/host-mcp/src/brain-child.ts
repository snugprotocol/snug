// A `claude` child on `--input-format stream-json`, and the small pool that keeps one warm
// per system prompt (ADR-0069 §5).
//
// MEASURED 2026-09-13 on the owner's Mac, CLI 2.1.270: a cold `claude -p` costs ~3.5 s of
// process overhead on top of the model's time; a stream-json child left idle for five
// seconds and then sent its first message answers in 1.7 s wall — the model's time alone.
// The CLI does its start-up before any input arrives, at ~257 MB of idle memory per child.
//
// EVERY CHILD SERVES EXACTLY ONE REQUEST. The plan review established that on this binding
// nothing sends a conversation a child could continue: the builder's system prompt carries
// the app's whole html and changes on every build, the wire text differs from what the page
// persists, and the history window drops whole rows. So a child holds nothing but its
// system prompt until its one request arrives, answers it, and is reaped — which is also
// what makes the pool leak-free by construction. What the pool buys is that the NEXT request
// for the same system prompt (an app's next think, the inferrer, the synthesis) finds a child
// already started.
//
// BOUNDS, all named: at most `maxWarm` pre-warmed keys (least recently used evicted), an
// idle TTL on a unused child, and a reap on stop, on abort, on error, on exit.

import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/** What the pool needs of a child process — `node:child_process`'s shape, and a fake's. */
export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable | null;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export type SpawnChild = (args: string[], env: Record<string, string>) => ChildLike;

export interface TurnSink {
  /** Called for every `text_delta` as it arrives, in order. */
  onDelta(text: string): void;
}

export interface TurnResult {
  text: string;
  stopReason: string;
}

/** The one stream-json line shape the child reads; everything else is ignored. */
interface CliEvent {
  type?: unknown;
  subtype?: unknown;
  event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
  result?: unknown;
  is_error?: unknown;
  stop_reason?: unknown;
}

/** The stream-json user message: one turn, one text block. */
export function userMessageLine(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

/** SIGTERM first so the CLI can exit cleanly; SIGKILL only if it ignores us. */
const KILL_GRACE_MS = 2_000;

export class ClaudeChild {
  /** Set once `send` is called; a child never takes a second request. */
  used = false;

  private buffer = '';
  private text = '';
  private deltas = 0;
  private stderrTail = '';
  private exited = false;
  private pending: { resolve(result: TurnResult): void; reject(error: Error): void; sink: TurnSink } | undefined;

  constructor(readonly process: ChildLike) {
    process.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk.toString()));
    process.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-300);
    });
    process.on('exit', (code) => {
      this.exited = true;
      // A child that dies before its result is an answer of its own: the stderr tail is the
      // only thing that says why, so it must reach the user.
      this.fail(new Error(`the Claude CLI exited (${code ?? 'signal'}) before answering${this.stderrTail.trim() !== '' ? `: ${this.stderrTail.trim()}` : ''}`));
    });
    process.on('error', (error) => this.fail(new Error(`could not start the Claude CLI: ${error.message}`)));
  }

  /** Send the one request; resolves on the CLI's `result`, streaming text deltas meanwhile. */
  send(prompt: string, sink: TurnSink): Promise<TurnResult> {
    if (this.used) return Promise.reject(new Error('a child answers exactly one request'));
    this.used = true;
    if (this.exited) return Promise.reject(new Error('the Claude CLI exited before the request was sent'));
    return new Promise<TurnResult>((resolve, reject) => {
      this.pending = { resolve, reject, sink };
      this.process.stdin.write(userMessageLine(prompt));
    });
  }

  /** Reap. Safe to call twice; fails a pending request as aborted. */
  kill(): void {
    // The caller's reason FIRST: the child's exit follows the signal, and a pending request
    // must read "aborted", not "the CLI exited".
    this.fail(new Error('aborted'));
    if (!this.exited) {
      this.process.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!this.exited) this.process.kill('SIGKILL');
      }, KILL_GRACE_MS);
      timer.unref?.();
    }
  }

  get alive(): boolean {
    return !this.exited;
  }

  private fail(error: Error): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    pending.reject(error);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line === '') continue;
      let event: CliEvent;
      try {
        event = JSON.parse(line) as CliEvent;
      } catch {
        continue; // the CLI's stdout is the wire; a non-JSON line is noise, not an answer
      }
      this.onEvent(event);
    }
  }

  private onEvent(event: CliEvent): void {
    const pending = this.pending;
    if (pending === undefined) return;
    if (event.type === 'stream_event') {
      // ONLY text deltas. A user's own extended-thinking setting (the child is never
      // `--bare`) emits `thinking_delta`s, which stay private; the later `assistant`
      // event repeats the text and is not forwarded again.
      const delta = event.event?.delta;
      if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.deltas += 1;
        this.text += delta.text;
        pending.sink.onDelta(delta.text);
      }
      return;
    }
    if (event.type === 'result') {
      this.pending = undefined;
      const resultText = typeof event.result === 'string' ? event.result : '';
      if (event.is_error === true) {
        pending.reject(new Error(resultText === '' ? 'the Claude CLI reported an error' : resultText));
        return;
      }
      // The deltas are the answer when they came; the result's text is the fallback for a
      // CLI that streamed nothing (the two are the same content, never both).
      pending.resolve({
        text: this.deltas > 0 ? this.text : resultText,
        stopReason: typeof event.stop_reason === 'string' ? event.stop_reason : 'end_turn',
      });
    }
  }
}

export interface ChildPoolOptions {
  spawnChild: SpawnChild;
  /** The argv for a child serving this system prompt. */
  argsFor(system: string): string[];
  /** The child environment, built by allowlist once by the caller (never `process.env`). */
  env: Record<string, string>;
  /** Pre-warmed keys kept at once; the least recently used is evicted beyond it. */
  maxWarm?: number;
  /** How long a unused child may sit unused before it is reaped. */
  idleMs?: number;
  now?: () => number;
}

/** The defaults, sized from the measurement: ~257 MB idle per child. */
export const POOL_MAX_WARM = 2;
export const POOL_IDLE_MS = 5 * 60_000;

export function poolKey(system: string): string {
  return createHash('sha256').update(system).digest('hex');
}

export class ChildPool {
  /** Virgin children by key; Map order is the LRU order (oldest first). */
  private readonly warm = new Map<string, { child: ClaudeChild; timer: ReturnType<typeof setTimeout> }>();
  /** Children serving a request right now. */
  private readonly live = new Set<ClaudeChild>();
  private readonly maxWarm: number;
  private readonly idleMs: number;
  private stopped = false;

  constructor(private readonly options: ChildPoolOptions) {
    this.maxWarm = options.maxWarm ?? POOL_MAX_WARM;
    this.idleMs = options.idleMs ?? POOL_IDLE_MS;
  }

  /**
   * A child for this system prompt: the pre-warmed one if there is one, else a fresh spawn.
   * Either way a replacement is pre-warmed at once, so the next request for the same prompt
   * skips the start-up.
   */
  acquire(system: string): ClaudeChild {
    if (this.stopped) throw new Error('the runner is stopping');
    const key = poolKey(system);
    const entry = this.warm.get(key);
    let child: ClaudeChild;
    if (entry !== undefined && entry.child.alive) {
      this.warm.delete(key);
      clearTimeout(entry.timer);
      child = entry.child;
    } else {
      if (entry !== undefined) this.warm.delete(key);
      child = this.spawn(system);
    }
    this.live.add(child);
    // A replacement that cannot start is not this request's failure; the next request
    // will spawn for itself and name the problem then.
    try {
      this.prewarm(key, system);
    } catch {
      /* named by the next acquire */
    }
    return child;
  }

  /** Every child serves exactly one request: releasing it reaps it. */
  release(child: ClaudeChild): void {
    this.live.delete(child);
    child.kill();
  }

  /** Start a unused child for this key now, unless one is already waiting. */
  prewarm(key: string, system: string): void {
    if (this.stopped) return;
    const existing = this.warm.get(key);
    if (existing !== undefined && existing.child.alive) {
      // Touch: most recently used moves to the end of the LRU order.
      this.warm.delete(key);
      this.warm.set(key, existing);
      return;
    }
    if (existing !== undefined) this.warm.delete(key);
    while (this.warm.size >= this.maxWarm) {
      const oldest = this.warm.keys().next().value;
      if (oldest === undefined) break;
      this.evict(oldest);
    }
    const child = this.spawn(system);
    const timer = setTimeout(() => this.evict(key), this.idleMs);
    timer.unref?.();
    this.warm.set(key, { child, timer });
  }

  /** Reap everything — the runner is stopping, or its parent went away. */
  stop(): void {
    this.stopped = true;
    for (const key of [...this.warm.keys()]) this.evict(key);
    for (const child of [...this.live]) this.release(child);
  }

  stats(): { warm: number; live: number } {
    return { warm: this.warm.size, live: this.live.size };
  }

  private evict(key: string): void {
    const entry = this.warm.get(key);
    if (entry === undefined) return;
    this.warm.delete(key);
    clearTimeout(entry.timer);
    entry.child.kill();
  }

  private spawn(system: string): ClaudeChild {
    return new ClaudeChild(this.options.spawnChild(this.options.argsFor(system), this.options.env));
  }
}
