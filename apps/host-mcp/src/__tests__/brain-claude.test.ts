// AC9 — the `claude -p` shim (program D5, ADR-0068 §5).
//
// Two things this file exists to hold still.
//
// 1. THE CHILD'S ENVIRONMENT IS AN ALLOWLIST, NOT A DENYLIST (D-B21). Measured inside a
//    real Claude Code session on 2026-09-07, the inherited environment carried twelve
//    CLAUDE_* variables including `CLAUDE_CODE_MESSAGING_TOKEN` and
//    `CLAUDE_CODE_MESSAGING_SOCKET` — a live IPC channel back into the running session.
//    A denylist against an undocumented, version-varying namespace drifts silently the
//    next time the CLI adds a variable, so the child gets a scratch environment and
//    falls back to the user's own keychain — which is what the brain chip's "your CLI"
//    promises.
//
// 2. THE SHIM SPEAKS SSE (D-B15). `openaiAdapter` writes `stream: true` unconditionally
//    and parses with `parseSse`; a plain-JSON answer yields no events, `finishReason`
//    stays null, and EVERY turn comes back as a dropped stream. The CLI underneath is
//    non-streaming (`--output-format json`), so the shim buffers the child and then emits
//    a single-chunk stream.

import { describe, expect, it, vi } from 'vitest';

import { buildClaudeArgs, childEnvFor, CHILD_ENV_ALLOWLIST, completionToSseBody, createClaudeBrain, parseClaudeOutput, SHIM_TIMEOUT_MS, splitChatRequest, probeBrain } from '../brain-claude.js';

/** The names measured in a live Claude Code session — none may reach the child. */
const MEASURED_INHERITED = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENABLE_TASKS',
  'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
];

describe('the child environment', () => {
  it('is built from an allowlist, so an unknown variable is dropped by construction', () => {
    const parent = { HOME: '/Users/x', PATH: '/usr/bin', SOME_FUTURE_CLAUDE_VAR: 'v', UNRELATED: 'u' };
    const env = childEnvFor(parent);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });

  it('drops every CLAUDE_* name measured in a live session, the messaging token included', () => {
    const parent: Record<string, string> = { HOME: '/Users/x', PATH: '/usr/bin' };
    for (const name of MEASURED_INHERITED) parent[name] = 'leaked';
    const env = childEnvFor(parent);
    for (const name of MEASURED_INHERITED) expect(env, `${name} must not reach the child`).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain('leaked');
  });

  it('drops every Anthropic credential and endpoint override', () => {
    const parent = {
      HOME: '/Users/x',
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-ant-leak',
      ANTHROPIC_AUTH_TOKEN: 'tok-leak',
      ANTHROPIC_BASE_URL: 'https://evil.example',
    };
    expect(JSON.stringify(childEnvFor(parent))).not.toMatch(/leak|evil/);
  });

  it('never lets the allowlist itself grow a credential-shaped name', () => {
    // The allowlist is the guard; this is the guard on the guard.
    for (const name of CHILD_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|AUTH|CLAUDE|ANTHROPIC/i);
    }
  });

  it('passes HOME through, so the CLI finds the user’s own credentials', () => {
    expect(childEnvFor({ HOME: '/Users/x', PATH: '/usr/bin' }).HOME).toBe('/Users/x');
  });
});

describe('the pinned argv', () => {
  const args = () => buildClaudeArgs({ system: 'you are a brain', maxTokens: 1024 });

  it('runs headless with a JSON result', () => {
    expect(args()).toEqual(expect.arrayContaining(['-p', '--output-format', 'json']));
  });

  it('disables every tool, which is what forces a single turn', () => {
    // Verified on the installed CLI: `--tools ""` is the documented spelling for "disable
    // all tools", and a run with no tools reported num_turns 1 / stop_reason end_turn.
    const a = args();
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a).toEqual(expect.arrayContaining(['--disallowedTools', '*']));
  });

  it('never passes --bare (program D5)', () => {
    expect(args()).not.toContain('--bare');
  });

  it('does not persist a session', () => {
    expect(args()).toContain('--no-session-persistence');
  });

  it('carries the system prompt as an argument, never as an env var', () => {
    expect(args()).toEqual(expect.arrayContaining(['--system-prompt', 'you are a brain']));
  });
});

describe('the shim answers as a stream', () => {
  it('emits SSE with a content delta, a finish reason and a terminator', () => {
    const body = completionToSseBody({ text: 'hello', stopReason: 'end_turn', model: 'claude' });
    expect(body).toMatch(/^data: /m);
    expect(body).toContain('"content":"hello"');
    expect(body).toContain('"finish_reason"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('maps the CLI’s stop_reason onto an OpenAI finish_reason', () => {
    expect(completionToSseBody({ text: 'x', stopReason: 'end_turn', model: 'claude' })).toContain('"finish_reason":"stop"');
    expect(completionToSseBody({ text: 'x', stopReason: 'max_tokens', model: 'claude' })).toContain('"finish_reason":"length"');
  });

  it('emits a finish_reason even for an empty answer, so the adapter never reports a dropped stream', () => {
    const body = completionToSseBody({ text: '', stopReason: 'end_turn', model: 'claude' });
    expect(body).toContain('"finish_reason"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('escapes a payload that would otherwise break the framing', () => {
    const body = completionToSseBody({ text: 'line\n\ndata: not-a-frame', stopReason: 'end_turn', model: 'claude' });
    const frames = body.split('\n').filter((l) => l.startsWith('data: '));
    // The newline rides inside the JSON string, so it never becomes a second frame.
    expect(frames.some((f) => f.includes('not-a-frame') && f.includes('\\n'))).toBe(true);
  });
});

describe('the timeout names itself and is sized from a cold start', () => {
  it('is well above a cold `claude -p` (lesson 2026-08-18)', () => {
    expect(SHIM_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});

describe('the OpenAI-shaped request the page sends', () => {
  it('flattens system and user turns into one prompt, system first', () => {
    const { system, prompt } = splitChatRequest({
      messages: [
        { role: 'system', content: 'you are a brain' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(system).toBe('you are a brain');
    expect(prompt).toBe('hello');
  });

  it('keeps a multi-turn conversation in order, labelled', () => {
    const { prompt } = splitChatRequest({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'second' },
      ],
    });
    // The CLI takes ONE prompt, so a conversation has to be rendered into it; losing the
    // assistant turns would make every follow-up read as a fresh question.
    expect(prompt).toMatch(/first[\s\S]*answer[\s\S]*second/);
  });

  it('joins multiple system messages rather than dropping all but one', () => {
    const { system } = splitChatRequest({
      messages: [
        { role: 'system', content: 'rule one' },
        { role: 'system', content: 'rule two' },
        { role: 'user', content: 'go' },
      ],
    });
    expect(system).toContain('rule one');
    expect(system).toContain('rule two');
  });

  it('refuses a request with no user turn, by name', () => {
    expect(() => splitChatRequest({ messages: [{ role: 'system', content: 'only rules' }] })).toThrow(/no user/i);
  });

  it('reads array-shaped content (the OpenAI content-parts form)', () => {
    const { prompt } = splitChatRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] as never }],
    });
    expect(prompt).toContain('part one');
    expect(prompt).toContain('part two');
  });
});

describe('reading the CLI’s answer', () => {
  it('takes the result field and the stop reason', () => {
    const parsed = parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'pong', stop_reason: 'end_turn' }));
    expect(parsed).toEqual({ text: 'pong', stopReason: 'end_turn' });
  });

  it('surfaces an is_error result as an error rather than as an empty answer', () => {
    // An empty answer would look to the page like a model that had nothing to say.
    expect(() => parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached' }))).toThrow(/usage limit reached/);
  });

  it('refuses output that is not the CLI’s JSON at all', () => {
    expect(() => parseClaudeOutput('command not found: claude')).toThrow(/could not read/i);
  });

  it('defaults a missing stop_reason rather than throwing', () => {
    expect(parseClaudeOutput(JSON.stringify({ result: 'hi' })).stopReason).toBe('end_turn');
  });
});

describe('the brain end to end, with a fake CLI', () => {
  const fakeRun = (stdout: string) => vi.fn(async () => stdout);
  const okOutput = JSON.stringify({ type: 'result', is_error: false, result: 'pong', stop_reason: 'end_turn' });

  it('answers a chat request as an SSE body the adapter can read', async () => {
    const brain = createClaudeBrain({ run: fakeRun(okOutput) });
    const body = await brain.complete({ messages: [{ role: 'user', content: 'ping' }] });
    expect(body).toContain('"content":"pong"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('feeds the prompt on stdin and the system prompt in argv', async () => {
    const run = vi.fn(async () => okOutput);
    const brain = createClaudeBrain({ run });
    await brain.complete({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'ping' }] });
    const call = run.mock.calls[0] as unknown as [string[], Record<string, string>, string, AbortSignal];
    expect(call[0]).toEqual(expect.arrayContaining(['--system-prompt', 'be brief']));
    expect(call[2]).toBe('ping');
    // The env the child gets is the allowlist, not this process's.
    expect(Object.keys(call[1]).every((k) => (CHILD_ENV_ALLOWLIST as readonly string[]).includes(k))).toBe(true);
  });

  it('names its own timeout rather than passing on the transport’s spelling', async () => {
    const brain = createClaudeBrain({
      timeoutMs: 20,
      run: (_a, _e, _p, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('killed')), { once: true })),
    });
    await expect(brain.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/did not answer within 0s|did not answer within/);
  });

  it('surfaces a CLI that could not start, with its reason', async () => {
    const brain = createClaudeBrain({ run: async () => { throw new Error('could not start claude: ENOENT'); } });
    await expect(brain.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/ENOENT/);
  });
});

// ------------------------------------------------------- the readiness probe (D-B35)

describe('probeBrain — is the user’s CLI actually able to answer?', () => {
  // WHY THIS EXISTS. The owner's walk found the CLI logged out: the child answered
  // `Not logged in · Please run /login`, which reached the page as a generic HTTP 502 at
  // the FIRST THINK, with no remedy shown and no hint that the brain was the problem. A
  // brain chip that says "Claude · your CLI" while the CLI cannot answer is a lie the user
  // pays for with a confusing failure — so the state is probed at boot and named.

  it('reports ready when the CLI answers normally', async () => {
    const state = await probeBrain({ run: async () => JSON.stringify({ is_error: false, result: 'ok' }) });
    expect(state).toMatchObject({ state: 'ready' });
  });

  it('names a LOGGED-OUT cli, with the remedy — the exact string the owner’s walk hit', async () => {
    // Measured 2026-09-08 against the real CLI, not invented.
    const state = await probeBrain({
      run: async () => JSON.stringify({ is_error: true, result: 'Not logged in · Please run /login' }),
    });
    expect(state.state).toBe('logged-out');
    // The remedy must be in the words the user reads, not only in a log.
    expect(state.detail).toMatch(/login/i);
  });

  it('names a MISSING binary rather than reporting a logged-out CLI', async () => {
    // A machine with no `claude` at all is a different story with a different remedy, and
    // conflating the two sends the user to run /login on a CLI they do not have.
    const state = await probeBrain({ run: async () => { throw new Error('could not start claude: ENOENT'); } });
    expect(state.state).toBe('absent');
  });

  it('does not spend the user’s quota — the logged-out answer costs nothing', async () => {
    // MEASURED 2026-09-08 against the real CLI: a logged-out `claude -p` returns
    // `duration_api_ms: 0` and `total_cost_usd: 0` — it fails BEFORE any API call. So the
    // probe can use the real code path (the only thing that proves the brain can actually
    // answer) without spending anything when it is going to fail, and a logged-IN CLI pays
    // for one trivial prompt once per boot.
    const calls: string[][] = [];
    await probeBrain({ run: async (args) => { calls.push(args); return JSON.stringify({ is_error: false, result: 'ok' }); } });
    // The probe must run the SAME shape the brain does — a probe down a different path
    // proves the wrong thing — and must carry no tools.
    expect(calls[0]).toContain('-p');
    expect(calls[0]).toEqual(expect.arrayContaining(['--tools', '']));
  });

  it('treats an unreadable answer as unknown rather than claiming the brain is ready', async () => {
    const state = await probeBrain({ run: async () => 'not json at all' });
    expect(state.state).not.toBe('ready');
  });
});
