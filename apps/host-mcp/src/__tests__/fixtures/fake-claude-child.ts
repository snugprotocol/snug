// A scripted stand-in for a `claude --input-format stream-json` child (AC5 tests).
//
// It records everything written to its stdin, and answers a user message with the
// stream-json lines a script supplies — by default an `init`, three text deltas, the
// `assistant` echo and a `result`, which is the measured shape of 2026-09-13.

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { ChildLike } from '../../brain-child.js';

export interface FakeChildScript {
  /** Lines to emit, in order, when the first user message arrives. */
  lines?: string[];
  /** Emit nothing on a message (a wedged CLI). */
  silent?: boolean;
  /** Exit with this code as soon as spawned. */
  exitAtOnce?: number;
  /** Emit `error` (and `close`, never `exit`) as soon as spawned — Node's shape for a failed spawn. */
  errorAtOnce?: string;
  /** Ignore SIGTERM; only SIGKILL ends it. */
  ignoresTerm?: boolean;
}

export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const delta = (text: string): string =>
  line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

export const thinkingDelta = (text: string): string =>
  line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: text } } });

export const result = (text: string, extra: Record<string, unknown> = {}): string =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn', num_turns: 1, ...extra });

export const defaultScript = (answer = 'pong'): string[] => [
  line({ type: 'system', subtype: 'init' }),
  ...answer.split(' ').map((word, i) => delta(i === 0 ? word : ` ${word}`)),
  line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } }),
  result(answer),
];

export class FakeClaudeChild extends EventEmitter implements ChildLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  readonly kills: string[] = [];
  readonly args: string[];
  readonly env: Record<string, string>;
  exited = false;
  pid = 4242;

  constructor(args: string[], env: Record<string, string>, private readonly script: FakeChildScript = {}) {
    super();
    this.args = args;
    this.env = env;
    this.stdin.on('data', (chunk: Buffer) => {
      this.written.push(chunk.toString());
      if (this.script.silent) return;
      for (const l of this.script.lines ?? defaultScript()) this.stdout.write(l);
    });
    if (this.script.exitAtOnce !== undefined) {
      const code = this.script.exitAtOnce;
      queueMicrotask(() => this.exit(code));
    }
    if (this.script.errorAtOnce !== undefined) {
      const message = this.script.errorAtOnce;
      queueMicrotask(() => {
        this.stdin.destroy();
        this.emit('error', new Error(message));
        this.emit('close', -2, null);
      });
    }
  }

  /** The user messages this child received, parsed. */
  messages(): Array<{ type: string; message: { content: Array<{ type: string; text: string }> } }> {
    return this.written
      .join('')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; message: { content: Array<{ type: string; text: string }> } });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (this.script.ignoresTerm && signal === 'SIGTERM') return true;
    if (!this.exited) this.exit(null, signal);
    return true;
  }

  /** Node's order: `exit`, then `close` once stdio has drained (here: at once). */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }

  /** `exit` alone — the last stdout line still in flight; `close` follows when the caller says. */
  exitOnly(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, null);
  }

  override on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  override on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}

/** A spawn seam that records every child it made. */
export function fakeSpawner(script: FakeChildScript | ((args: string[]) => FakeChildScript) = {}) {
  const children: FakeClaudeChild[] = [];
  const spawnChild = (args: string[], env: Record<string, string>): FakeClaudeChild => {
    const child = new FakeClaudeChild(args, env, typeof script === 'function' ? script(args) : script);
    children.push(child);
    return child;
  };
  return { spawnChild, children };
}
