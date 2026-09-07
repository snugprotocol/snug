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
