// The `claude -p` brain shim (program D5, ADR-0068 §5): an OpenAI-compatible
// `/v1/chat/completions` on the same loopback origin, spawning the user's OWN CLI. No
// third-party login is offered and no key of ours exists — the usage is the user's, on
// their own subscription, which is what the brain chip's "Claude · your CLI" promises.

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

export function childEnvFor(parent: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parent[name];
    if (typeof value === 'string') env[name] = value;
  }
  return env;
}

/**
 * A cold `claude -p` is slow, and a bound that fires must be sized against the slowest
 * LEGITIMATE call rather than a comfortable number (lesson 2026-08-18).
 */
export const SHIM_TIMEOUT_MS = 180_000;

export interface ClaudeArgsOptions {
  system: string;
  maxTokens?: number;
  model?: string;
}

/**
 * The pinned argv. `--tools ""` is the CLI's own documented spelling for "disable all
 * tools", and a run with no tools is a single turn by construction — verified against the
 * installed CLI, which reported `num_turns: 1` and `stop_reason: "end_turn"`.
 * `--max-turns` is absent from `--help` on 2.1.211 but accepted by the parser, so it rides
 * as belt-and-braces rather than as the mechanism.
 *
 * Never `--bare` (program D5): it skips the hooks and settings the user's own CLI runs
 * with, which would make this a different brain than the one the chip names.
 */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--system-prompt',
    options.system,
    '--tools',
    '',
    '--disallowedTools',
    '*',
    '--max-turns',
    '1',
    '--no-session-persistence',
  ];
  if (options.model !== undefined) args.push('--model', options.model);
  return args;
}

export interface CliCompletion {
  text: string;
  stopReason: string;
  model: string;
}

/** The CLI's `stop_reason` in OpenAI's vocabulary. */
function finishReasonFor(stopReason: string): string {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

/**
 * The answer as Server-Sent Events (D-B15).
 *
 * `openaiAdapter` writes `stream: true` into every request unconditionally and reads the
 * reply with `parseSse`; a plain JSON body yields no events, `finishReason` stays null, and
 * the adapter reports a DROPPED STREAM for every turn — a brain that looks permanently
 * broken. The CLI underneath is not streaming (`--output-format json`), so the shim buffers
 * the child and emits a single content chunk followed by a finish reason and the
 * terminator. The seat still declares `streaming: false`, because that flag is an
 * app-facing declaration in `host-ready`, not a transport switch.
 */
export function completionToSseBody(completion: CliCompletion): string {
  const id = `chatcmpl-snug-${Date.now().toString(36)}`;
  const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: completion.model };
  const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
  // JSON.stringify escapes newlines inside the string, so a payload containing "\n\ndata:"
  // rides INSIDE one frame and can never forge a second.
  return (
    frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: completion.text }, finish_reason: null }] }) +
    frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReasonFor(completion.stopReason) }] }) +
    'data: [DONE]\n\n'
  );
}

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
 * Turn an OpenAI-shaped conversation into the ONE system prompt and ONE user prompt the CLI
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

/**
 * Read `claude -p --output-format json`. An `is_error` result becomes a thrown error rather
 * than an empty answer: the page would render "" as a model with nothing to say, hiding a
 * usage limit or an auth failure the user could act on.
 */
export function parseClaudeOutput(stdout: string): { text: string; stopReason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`could not read the CLI's answer: ${stdout.trim().slice(0, 200)}`);
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('could not read the CLI’s answer');
  const result = parsed as { is_error?: unknown; result?: unknown; stop_reason?: unknown };
  const text = typeof result.result === 'string' ? result.result : '';
  if (result.is_error === true) throw new Error(text === '' ? 'the CLI reported an error' : text);
  return { text, stopReason: typeof result.stop_reason === 'string' ? result.stop_reason : 'end_turn' };
}

// ------------------------------------------------------------------- the spawn

export interface BrainDeps {
  /** Injected so tests never launch a real CLI. */
  run?(args: string[], env: Record<string, string>, prompt: string, signal: AbortSignal): Promise<string>;
  timeoutMs?: number;
  binary?: string;
}

export interface Brain {
  /** Answer one OpenAI-shaped chat request as an SSE body. */
  complete(request: ChatRequest): Promise<string>;
}

/** The default runner: spawn the user's own CLI, feed the prompt on stdin, read stdout. */
function spawnClaude(binary: string) {
  return async function run(args: string[], env: Record<string, string>, prompt: string, signal: AbortSignal): Promise<string> {
    const { spawn } = await import('node:child_process');
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      // EVERY SPAWN OWES A REAP (lessons 2026-08-18/19). An abort — the wall clock, or the
      // page giving up — must not leave a `claude` running against the user's quota.
      const onAbort = (): void => {
        child.kill('SIGTERM');
        // TERM first so the CLI can exit cleanly; KILL only if it ignores us.
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref?.();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`could not start ${binary}: ${error.message}`));
      });
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        // A non-zero exit with nothing on stdout is the CLI failing to start or refusing;
        // its stderr is the only thing that says why, so it must reach the user.
        if (code !== 0 && stdout.trim() === '') {
          reject(new Error(`${binary} exited ${code}: ${stderr.trim().slice(0, 300) || 'no output'}`));
          return;
        }
        resolve(stdout);
      });
      child.stdin.end(prompt);
    });
  };
}

export function createClaudeBrain(deps: BrainDeps = {}): Brain {
  const timeoutMs = deps.timeoutMs ?? SHIM_TIMEOUT_MS;
  const binary = deps.binary ?? 'claude';
  const run = deps.run ?? spawnClaude(binary);

  return {
    async complete(request: ChatRequest): Promise<string> {
      const { system, prompt } = splitChatRequest(request);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const stdout = await run(
          buildClaudeArgs({ system, ...(request.model !== undefined && request.model !== 'claude' ? { model: request.model } : {}) }),
          childEnvFor(process.env),
          prompt,
          controller.signal,
        );
        const { text, stopReason } = parseClaudeOutput(stdout);
        return completionToSseBody({ text, stopReason, model: request.model ?? 'claude' });
      } catch (error) {
        // THE BOUND THAT FIRED NAMES ITSELF (lesson 2026-08-18): an aborted spawn spells
        // itself differently on every platform, and that spelling points nowhere.
        if (controller.signal.aborted) {
          throw new Error(`your Claude CLI did not answer within ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
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
 * `ready` — the CLI answered. `logged-out` — it is installed but has no session; the
 * remedy is `claude` then `/login`. `absent` — no binary on PATH; the page falls back to
 * the demo brain, which is a different story with a different remedy, so conflating the two
 * would send the user to log into a CLI they do not have. `unknown` — it answered
 * something unreadable; the honest state, and never reported as ready.
 */
export type BrainState = 'ready' | 'logged-out' | 'absent' | 'unknown';

export interface BrainReadiness {
  state: BrainState;
  /** One sentence for the chip: what is wrong and what to do. Never a stack trace. */
  detail?: string;
}

/**
 * MEASURED 2026-09-08 against CLI 2.1.211: a logged-out `claude -p` returns
 * `is_error: true`, `result: "Not logged in · Please run /login"`, `duration_api_ms: 0` and
 * `total_cost_usd: 0` — it fails before any API call. So probing down the REAL path costs
 * nothing in the case that matters, and proves what `--version` cannot: that the brain can
 * actually answer, not merely that a binary exists.
 */
const PROBE_PROMPT = 'ok';

export async function probeBrain(deps: BrainDeps = {}): Promise<BrainReadiness> {
  const binary = deps.binary ?? 'claude';
  const run = deps.run ?? spawnClaude(binary);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  timer.unref?.();

  try {
    const stdout = await run(
      buildClaudeArgs({ system: 'Answer with the single word ok.' }),
      childEnvFor(process.env),
      PROBE_PROMPT,
      controller.signal,
    );
    try {
      parseClaudeOutput(stdout);
      return { state: 'ready' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The CLI's own words carry the remedy ("Please run /login"), so they are passed
      // through rather than replaced with a sentence of ours that says less.
      if (/not logged in|\/login|authenticat/i.test(message)) {
        return { state: 'logged-out', detail: `Your Claude CLI is not logged in — run \`claude\` and \`/login\`, then reopen Snug. (${message})` };
      }
      return { state: 'unknown', detail: message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (controller.signal.aborted) return { state: 'unknown', detail: 'your Claude CLI did not answer the startup check in time' };
    // A missing binary is not a logged-out one.
    if (/ENOENT|could not start/i.test(message)) {
      return { state: 'absent', detail: 'No `claude` CLI found on PATH — Snug is using its demo brain.' };
    }
    return { state: 'unknown', detail: message };
  } finally {
    clearTimeout(timer);
  }
}
