// A scripted stand-in for a `codex` child (ADR-0071; criterion B5).
//
// It records what it was started with and what was written to its stdin, and — once stdin
// is closed, which is when the real CLI has its whole prompt — writes the stdout bytes a
// script supplies and exits. `killGroup` is recorded and ends it, so a test can see that a
// think reaped its child without any real process (or any real signal) existing.
//
// Where the bytes come from is in `fixtures/codex/PROVENANCE.md`: `*.recorded.*` files are
// the real CLI 0.160.0, logged out; `*.transcribed.jsonl` are written from the upstream
// event definitions and marked so.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import type { CodexProcess, SpawnCodex } from '../../brains/codex.js';

const fixture = (name: string): Buffer => readFileSync(path.join(__dirname, 'codex', name));

/** RECORDED: `codex exec --json`, logged out — retries, an `error` item, then `turn.failed`. */
export const CODEX_LOGGED_OUT_STREAM = fixture('exec-logged-out.recorded.jsonl');
/** RECORDED: its stderr — which must never reach a page. */
export const CODEX_LOGGED_OUT_STDERR = fixture('exec-logged-out.recorded.stderr');
/** TRANSCRIBED from `exec_events.rs`: reasoning, one agent message, `turn.completed`. */
export const CODEX_SUCCESS_STREAM = fixture('exec-success.transcribed.jsonl');
/** What the transcribed success stream's one agent message says. */
export const CODEX_SUCCESS_TEXT = '{"move":"e7e5","message":"Classical — your move ♞ 🙂"}';
/** TRANSCRIBED: a shell command runs, and THEN the model answers from its output. */
export const CODEX_TOOL_ATTEMPT_STREAM = fixture('exec-tool-attempt.transcribed.jsonl');
/** RECORDED: `codex login status`, logged out (exit 1; the line is on stderr). */
export const CODEX_LOGIN_STATUS_LOGGED_OUT = { stdout: fixture('login-status.recorded.stdout'), stderr: fixture('login-status.recorded.stderr'), exitCode: 1 };
/** RECORDED, trimmed: `codex debug models --bundled`. */
export const CODEX_MODELS_BUNDLED = fixture('debug-models-bundled.trimmed.json');
/** RECORDED: `codex features list`. */
export const CODEX_FEATURES_LIST = fixture('features-list.recorded.txt').toString('utf8');

/** One JSONL stream from event objects — for the cases no file holds. */
export const jsonl = (...events: unknown[]): Buffer => Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');

export interface FakeCodexScript {
  /** What the child writes to stdout once its stdin is closed — one `data` event per entry. */
  stdout?: Buffer | string | Array<Buffer | string>;
  stderr?: Buffer | string;
  /** The code it exits with after writing. Default 0. */
  exitCode?: number;
  /** Write the output and then stay alive — a CLI that has answered but not left. */
  lingers?: boolean;
  /** Write nothing and never exit — a wedged CLI. */
  silent?: boolean;
  /** Emit `error` and `close` at once and never run — Node's shape for a spawn that failed. */
  spawnError?: NodeJS.ErrnoException;
  /** Never emit `close` after being killed — a group whose pipe a stray process holds open. */
  neverCloses?: boolean;
}

export class FakeCodexChild extends EventEmitter implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** How many times the group was killed. */
  kills = 0;
  closed = false;
  private readonly written: Buffer[] = [];

  constructor(
    readonly binary: string,
    readonly args: readonly string[],
    readonly options: { env: Record<string, string>; cwd: string },
    private readonly script: FakeCodexScript,
  ) {
    super();
    this.stdin.on('data', (chunk: Buffer) => this.written.push(chunk));
    if (script.spawnError !== undefined) {
      const error = script.spawnError;
      setImmediate(() => {
        this.emit('error', error);
        this.close(null);
      });
      return;
    }
    this.stdin.on('end', () => void this.run());
  }

  /** Everything the driver wrote to stdin — the prompt. */
  stdinText(): string {
    return Buffer.concat(this.written).toString('utf8');
  }

  killGroup(): void {
    this.kills += 1;
    if (this.script.neverCloses === true) return;
    // A signal is delivered, not obeyed in the same tick.
    setImmediate(() => this.close(null));
  }

  override on(event: 'close', listener: (code: number | null) => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  private async run(): Promise<void> {
    if (this.script.silent === true) return;
    const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    if (this.script.stderr !== undefined) this.stderr.write(this.script.stderr);
    const chunks = this.script.stdout === undefined ? [] : Array.isArray(this.script.stdout) ? this.script.stdout : [this.script.stdout];
    for (const chunk of chunks) {
      if (this.closed) return;
      if (chunk.length > 0) this.stdout.write(chunk);
      await tick();
    }
    await tick();
    if (this.script.lingers !== true) this.close(this.script.exitCode ?? 0);
  }

  private close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    // After stdio has drained, as Node orders it.
    setImmediate(() => this.emit('close', code));
  }
}

/** A spawn seam that records every child it made; the script may depend on the argv. */
export function fakeCodexSpawner(script: FakeCodexScript | ((args: readonly string[]) => FakeCodexScript) = {}) {
  const children: FakeCodexChild[] = [];
  const spawn: SpawnCodex = (binary, args, options) => {
    const child = new FakeCodexChild(binary, args, options, typeof script === 'function' ? script(args) : script);
    children.push(child);
    return child;
  };
  return { spawn, children };
}
