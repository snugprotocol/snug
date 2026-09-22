// The `claude` brain shim (program D5, ADR-0068 §5, ADR-0069 §5): an OpenAI-compatible
// `/v1/chat/completions` on the same loopback origin, answered by the user's OWN CLI as a
// pre-warmed, single-use child on `--input-format stream-json`. No third-party login is
// offered and no key of ours exists — the usage is the user's, on their own subscription,
// which is what the brain chip's "Claude · your CLI" promises.

import { spawn } from 'node:child_process';
import path from 'node:path';

import { ChildPool, ClaudeChild, type ChildLike, type SpawnChild } from './brain-child.js';
import { defaultResolveDeps, resolveBinary } from './brain-resolve.js';

/**
 * The child's environment, built from NOTHING (D-B21).
 *
 * Measured inside a live Claude Code session on 2026-09-07, the environment an MCP server
 * inherits carries twelve `CLAUDE_*` variables — `CLAUDE_CODE_MESSAGING_TOKEN` and
 * `CLAUDE_CODE_MESSAGING_SOCKET` among them, which together are a live IPC channel back
 * into the running session. A denylist against that namespace is a losing game: it is
 * undocumented and it grows between CLI versions, so the first variable added after this
 * ships would leak silently. An allowlist cannot drift that way.
 *
 * Passing HOME is what lets the CLI find the user's own credentials, which is the point.
 */
export const CHILD_ENV_ALLOWLIST = ['HOME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'] as const;

/**
 * @param execDir the directory of the Node running this process, prepended to the child's
 *   PATH: under a desktop host PATH is empty, and an npm-installed `claude` is a
 *   `#!/usr/bin/env node` shim that would exit 127 without one (measured). The launcher
 *   found this Node; the child inherits the find.
 */
export function childEnvFor(parent: Record<string, string | undefined>, execDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  if (execDir !== undefined && execDir !== '') {
    env.PATH = env.PATH === undefined || env.PATH === '' ? execDir : `${execDir}${path.delimiter}${env.PATH}`;
  }
  return env;
}

/**
 * Where the CLI is (ADR-0069 §6). A GUI-spawned process has no user PATH (measured
 * 2026-09-13: `launchctl getenv PATH` is empty on the owner's Mac), so the bare name is
 * resolved against PATH AND the installers' known directories, from the one list in
 * `install-roots.json`. HOME and PATH are read by NAME — the release gate counts whole-env
 * reads and this must not add one.
 */
export function resolveClaudeBinary(): string | undefined {
  return resolveBinary('claude', defaultResolveDeps({ HOME: process.env.HOME, PATH: process.env.PATH }));
}

/** The remedy when there is no CLI at all — a page to visit, then two commands. Never a curl pipe. */
export const INSTALL_REMEDY =
  'No `claude` CLI found on this machine — Snug is using its demo brain. Install Claude Code (https://code.claude.com/docs/en/quickstart), then run `claude` and `/login`, and reopen Snug.';

/**
 * The posture every child runs with (program D5): no tools — which makes a single turn by
 * construction (verified: `num_turns: 1`) — `--max-turns 1` as belt and braces (accepted by
 * the parser though absent from `--help`), no persisted session, and never `--bare`, which
 * would skip the hooks and settings the user's own CLI runs with and make this a different
 * brain than the one the chip names.
 */
const POSTURE = [
  '--tools',
  '',
  '--disallowedTools',
  '*',
  '--max-turns',
  '1',
  '--no-session-persistence',
  // ONLY the child's own working directory's settings — which is a neutral, empty dir under
  // the Snug home — so neither the project the agent happened to be in NOR the user's own
  // CLAUDE.md, hooks and MCP servers reach an app's think. MEASURED 2026-09-13: with
  // `user` the owner's ~/.claude/CLAUDE.md rode into every think (1,319 input tokens for a
  // one-word answer; "PINEAPPLE" from a project CLAUDE.md); with `local` it does not
  // (446 tokens) and the keychain login still works. `--bare` would also skip the keychain
  // (measured: "Not logged in"), which is why D5 forbids it. The login is what "the user's
  // own CLI" means here; the settings are not.
  '--setting-sources',
  'local',
  '--strict-mcp-config',
] as const;

/**
 * The one argv (ADR-0069 §5). `--input-format stream-json` is what lets a child start
 * BEFORE its request arrives (measured 2026-09-13: 1.7 s to answer after a five-second
 * idle, against ~5 s cold); `--verbose` is what the CLI requires for stream-json output;
 * `--include-partial-messages` is the token stream the page shows. The system prompt rides
 * as an argument, never as an environment variable. The probe and the brain share it, so
 * the probe proves the wire the brain uses.
 */
export function buildStreamArgs(system: string): string[] {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--system-prompt', system, ...POSTURE];
}

/**
 * The bound a request's FIRST delta must arrive within — sized against the slowest
 * legitimate cold start rather than a comfortable number (lesson 2026-08-18) …
 */
export const SHIM_FIRST_DELTA_MS = 180_000;
/** … and, once a child is answering, the bound between deltas. Both name themselves when they fire. */
export const SHIM_IDLE_MS = 60_000;

// ---------------------------------------------------------------- the wire shapes

export interface ChatMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
}

/** OpenAI allows content as a string OR as an array of parts; the page's adapter uses both. */
function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => part.text ?? '')
    .filter((text) => text !== '')
    .join('\n');
}

/**
 * Turn an OpenAI-shaped conversation into the ONE system prompt and ONE user prompt a child
 * takes. The assistant turns are rendered into the prompt rather than dropped: without them
 * every follow-up would reach the model as a fresh question with no memory of its own last
 * answer.
 */
export function splitChatRequest(request: ChatRequest): { system: string; prompt: string } {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => textOf(message.content))
    .join('\n\n');

  const turns = request.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
  if (!turns.some((message) => message.role === 'user')) {
    throw new Error('this request carries no user turn — there is nothing to answer');
  }
  // A single user turn rides bare; a conversation is labelled so the model can tell the
  // voices apart.
  const prompt =
    turns.length === 1 && turns[0] !== undefined
      ? textOf(turns[0].content)
      : turns.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${textOf(message.content)}`).join('\n\n');

  return { system, prompt };
}

/** The CLI's `stop_reason` in OpenAI's vocabulary. */
function finishReasonFor(stopReason: string): string {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

// ------------------------------------------------------------------- the spawn

/** The spawn of a RESOLVED binary; injected so tests never launch a real CLI. */
export type SpawnBinary = (binary: string, args: string[], env: Record<string, string>, cwd?: string) => ChildLike;

const nodeSpawn: SpawnBinary = (binary, args, env, cwd) => spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd !== undefined ? { cwd } : {}) });

/** Where the Node running this process lives — what the launcher found, handed on. */
const EXEC_DIR = path.dirname(process.execPath);

interface BinaryDeps {
  /** A fixed path, which skips resolution entirely. */
  binary?: string;
  /** Where the CLI is; injected so tests never touch the real filesystem. */
  resolveBinary?(): string | undefined;
  /**
   * The child's working directory — a neutral one under the Snug home, never the agent
   * host's project (whose CLAUDE.md and settings would otherwise be discovered).
   */
  cwd?: string;
}

/** The binary to spawn: a fixed one, else the resolver's answer, else nothing. */
function binaryFor(deps: BinaryDeps): string | undefined {
  if (deps.binary !== undefined) return deps.binary;
  return (deps.resolveBinary ?? resolveClaudeBinary)();
}

/**
 * Resolved PER SPAWN, so a CLI installed after boot answers the next think without a
 * restart (the chip stays on its boot verdict until then — a known, smaller gap).
 */
function spawnChildWith(deps: BinaryDeps & { spawnBinary?: SpawnBinary }): SpawnChild {
  const spawnBinary = deps.spawnBinary ?? nodeSpawn;
  return (args, env) => {
    const binary = binaryFor(deps);
    if (binary === undefined) throw new Error(INSTALL_REMEDY);
    return spawnBinary(binary, args, env, deps.cwd);
  };
}

// ------------------------------------------------------------------- the brain

export interface BrainDeps extends BinaryDeps {
  spawnBinary?: SpawnBinary;
  /** The cold-start bound for a request's first delta. */
  firstDeltaMs?: number;
  /** The bound between deltas once a child is answering. */
  idleMs?: number;
}

/** Where a streamed answer goes: the route's response, or a string in tests. */
export interface StreamSink {
  write(chunk: string): void;
  /** The page giving up on the request (the route's `close`); the child is reaped. */
  signal?: AbortSignal;
}

/**
 * A failed stream, and whether any of it reached the sink. The route answers a failure
 * BEFORE the first delta with a 502 the page can read; after it, the only honest move is
 * to close the stream with no finish, which the page's adapter reports as dropped.
 */
export class BrainStreamError extends Error {
  constructor(
    message: string,
    readonly partial: boolean,
  ) {
    super(message);
    this.name = 'BrainStreamError';
  }
}

export interface Brain {
  /** Answer one OpenAI-shaped chat request, writing SSE chunks as the deltas arrive. */
  stream(request: ChatRequest, sink: StreamSink): Promise<void>;
  /** The same answer as one SSE body — the buffered form, for tests and the live check. */
  complete(request: ChatRequest): Promise<string>;
  /** Reap every child, warm or busy. */
  stop(): void;
}

export function createClaudeBrain(deps: BrainDeps = {}): Brain {
  const firstDeltaMs = deps.firstDeltaMs ?? SHIM_FIRST_DELTA_MS;
  const idleMs = deps.idleMs ?? SHIM_IDLE_MS;
  // The ONE whole-environment read of the brain (the release gate counts them): the child
  // env by allowlist, built once and handed to every child.
  const env = childEnvFor(process.env, EXEC_DIR);
  const pool = new ChildPool({ spawnChild: spawnChildWith(deps), argsFor: buildStreamArgs, env });

  const brain: Brain = {
    async stream(request, sink) {
      const { system, prompt } = splitChatRequest(request);
      const model = request.model ?? 'claude';
      // The page sends no model today (it always says `claude`), so the key is the system
      // prompt alone; a different model would be a different child.
      const child = pool.acquire(system);
      const base = { id: `chatcmpl-snug-${Date.now().toString(36)}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model };
      // EVERY FRAME IS ONE JSON.stringify OF THE WHOLE PAYLOAD: a delta's text is a string
      // value inside it, so a delta containing "\n\ndata:" rides inside its frame and can
      // never forge a second (pinned by a test with exactly that text).
      const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
      const contentFrame = (content: string): string => frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] });

      let deltas = 0;
      let abortReason: string | undefined;
      const abort = (why: string): void => {
        abortReason = why;
        child.kill();
      };
      // THE BOUND THAT FIRED NAMES ITSELF (lesson 2026-08-18): the cold-start bound until the
      // first delta, then the idle bound between deltas.
      let timer = setTimeout(() => abort(`did not answer within ${Math.round(firstDeltaMs / 1000)}s`), firstDeltaMs);
      timer.unref?.();
      const onClientAbort = (): void => abort('stopped — the page closed the request');
      sink.signal?.addEventListener('abort', onClientAbort, { once: true });
      try {
        const result = await child.send(prompt, {
          onDelta(text) {
            deltas += 1;
            clearTimeout(timer);
            timer = setTimeout(() => abort(`stopped answering for ${Math.round(idleMs / 1000)}s`), idleMs);
            timer.unref?.();
            sink.write(contentFrame(text));
          },
        });
        // A CLI that streamed nothing still answered: its text rides as the one delta.
        if (deltas === 0 && result.text !== '') sink.write(contentFrame(result.text));
        sink.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReasonFor(result.stopReason) }] }));
        sink.write('data: [DONE]\n\n');
      } catch (error) {
        const message = abortReason !== undefined ? `your Claude CLI ${abortReason}` : error instanceof Error ? error.message : String(error);
        throw new BrainStreamError(message, deltas > 0);
      } finally {
        clearTimeout(timer);
        sink.signal?.removeEventListener('abort', onClientAbort);
        pool.release(child);
      }
    },

    async complete(request) {
      let body = '';
      await brain.stream(request, { write: (chunk) => (body += chunk) });
      return body;
    },

    stop() {
      pool.stop();
    },
  };
  return brain;
}

// ------------------------------------------------------- the readiness probe (D-B35)

/**
 * What the user's own CLI can actually do, decided at boot rather than at the first think.
 *
 * WHY. The owner's walk on 2026-09-08 found the CLI logged out. The child answered
 * `Not logged in · Please run /login`, which reached the page as a generic HTTP 502 the
 * first time the user asked an app to think — no remedy, no hint that the BRAIN was the
 * problem rather than the app. A chip reading "Claude · your CLI" while the CLI cannot
 * answer is a promise the product does not keep.
 *
 * `ready` — the CLI answered. `logged-out` — installed, no session; the remedy is
 * `claude` then `/login`. `outdated` — the CLI names a newer version it needs; the remedy
 * is `claude update`. `absent` — no binary anywhere; the page falls back to the demo brain
 * and the chip says how to install one. `unknown` — it answered something unreadable; the
 * honest state, and never reported as ready.
 *
 * THE PROBE RUNS THE BRAIN'S OWN WIRE: the same argv, the same child class. A probe down a
 * different path proves the wrong thing — `--version` would call a logged-out CLI ready,
 * and a one-shot `--output-format json` would vouch for a stream-json wire it never used.
 * MEASURED 2026-09-08: a logged-out CLI fails before any API call (`duration_api_ms: 0`),
 * so the honest probe is also the free one in the case that matters.
 */
export type BrainState = 'ready' | 'logged-out' | 'outdated' | 'absent' | 'unknown';

export interface BrainReadiness {
  state: BrainState;
  /** One sentence for the chip: what is wrong and what to do. Never a stack trace. */
  detail?: string;
}

/**
 * MEASURED 2026-09-13 on the owner's Mac: CLI 2.1.211 answered EVERY `-p` call with
 * `API Error: 400 Claude Code 2.1.211 does not support this model; version 2.1.251 or newer
 * is required. Run 'claude update' …`, `is_error: true`. A CLI's default model moves under a
 * pinned CLI version, so a brain that worked last week can be a 400 today with nobody
 * touching Snug. The old probe called this `unknown`; the CLI's own sentence names the
 * remedy, so the state does too.
 */
const OUTDATED_RE = /or newer is required|run 'claude update'/i;

export interface ProbeDeps extends BinaryDeps {
  spawnBinary?: SpawnBinary;
  /** How long the startup check may take before it is `unknown`. */
  timeoutMs?: number;
}

const PROBE_SYSTEM = 'Answer with the single word ok.';
const PROBE_PROMPT = 'ok';

export async function probeBrain(deps: ProbeDeps = {}): Promise<BrainReadiness> {
  // No binary anywhere is decided WITHOUT a spawn: it is the cheapest answer and the one a
  // GUI-spawned process with no user PATH would otherwise get wrong (ADR-0069 §6).
  const binary = binaryFor(deps);
  if (binary === undefined) return { state: 'absent', detail: INSTALL_REMEDY };

  let child: ClaudeChild | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child?.kill();
  }, deps.timeoutMs ?? 20_000);
  timer.unref?.();
  try {
    child = new ClaudeChild((deps.spawnBinary ?? nodeSpawn)(binary, buildStreamArgs(PROBE_SYSTEM), childEnvFor(process.env, EXEC_DIR), deps.cwd));
    await child.send(PROBE_PROMPT, { onDelta() {} });
    return { state: 'ready' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) return { state: 'unknown', detail: 'your Claude CLI did not answer the startup check in time' };
    // Checked FIRST: the outdated sentence names a version, never a login.
    if (OUTDATED_RE.test(message)) {
      return { state: 'outdated', detail: `Your Claude CLI is out of date — run \`claude update\`, then reopen Snug. (${message})` };
    }
    // The CLI's own words carry the remedy ("Please run /login"), so they are passed
    // through rather than replaced with a sentence of ours that says less.
    if (/not logged in|\/login|authenticat/i.test(message)) {
      return { state: 'logged-out', detail: `Your Claude CLI is not logged in — run \`claude\` and \`/login\`, then reopen Snug. (${message})` };
    }
    // A resolved path that still cannot start (a half-removed install) reads as absent too.
    if (/ENOENT|could not start/i.test(message)) return { state: 'absent', detail: INSTALL_REMEDY };
    return { state: 'unknown', detail: message };
  } finally {
    clearTimeout(timer);
    child?.kill();
  }
}
