// The `claude` brain shim (program D5, ADR-0068 §5, ADR-0069 §5).
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
// 2. ONE WIRE. The brain and the boot probe both run `--input-format stream-json` through
//    the same child class (ADR-0069 §5): the probe proves the path the brain uses, each
//    delta is its own SSE frame, and every frame is one JSON.stringify of the whole payload.

import { describe, expect, it, vi } from 'vitest';

import { buildStreamArgs, childEnvFor, CHILD_ENV_ALLOWLIST, createClaudeBrain, INSTALL_REMEDY, probeBrain, SHIM_FIRST_DELTA_MS, SHIM_IDLE_MS, splitChatRequest } from '../brain-claude.js';
import { delta, fakeSpawner, result } from './fixtures/fake-claude-child.js';

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

describe('the one argv (ADR-0069 §5)', () => {
  const args = buildStreamArgs('you are a brain');
  it('speaks stream-json both ways, verbose, with partial messages', () => {
    expect(args).toEqual(expect.arrayContaining(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages']));
  });
  it('disables every tool, which is what forces a single turn, with --max-turns 1 as belt and braces', () => {
    expect(args).toEqual(expect.arrayContaining(['--tools', '', '--disallowedTools', '*', '--max-turns', '1']));
  });
  it('never passes --bare (program D5)', () => {
    expect(args).not.toContain('--bare');
  });
  it('does not persist a session', () => {
    expect(args).toContain('--no-session-persistence');
  });
  it('carries the system prompt as an argument, never as an env var', () => {
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('you are a brain');
  });
});

describe('the bounds name themselves and are sized from measurement', () => {
  it('the cold-start bound is well above a cold `claude -p` (lesson 2026-08-18)', () => {
    expect(SHIM_FIRST_DELTA_MS).toBeGreaterThanOrEqual(120_000);
  });
  it('the idle bound is shorter than the cold-start bound — a child that started answering has no start-up left to do', () => {
    expect(SHIM_IDLE_MS).toBeLessThan(SHIM_FIRST_DELTA_MS);
  });
});

describe('the OpenAI-shaped request the page sends', () => {
  it('flattens system and user turns into one prompt, system first', () => {
    const { system, prompt } = splitChatRequest({
      messages: [
        { role: 'system', content: 'be a brain' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(system).toBe('be a brain');
    expect(prompt).toBe('hello');
  });

  it('keeps a multi-turn conversation in order, labelled', () => {
    const { prompt } = splitChatRequest({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(prompt).toBe('User: a\n\nAssistant: b\n\nUser: c');
  });

  it('joins multiple system messages rather than dropping all but one', () => {
    const { system } = splitChatRequest({
      messages: [
        { role: 'system', content: 'one' },
        { role: 'system', content: 'two' },
        { role: 'user', content: 'x' },
      ],
    });
    expect(system).toBe('one\n\ntwo');
  });

  it('refuses a request with no user turn, by name', () => {
    expect(() => splitChatRequest({ messages: [{ role: 'system', content: 'x' }] })).toThrow(/no user turn/);
  });

  it('reads array-shaped content (the OpenAI content-parts form)', () => {
    const { prompt } = splitChatRequest({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'part one' }, { type: 'text', text: 'part two' }] }],
    });
    expect(prompt).toBe('part one\npart two');
  });
});

describe('the brain end to end, with a fake CLI (a pre-warmed child, one request each)', () => {
  const brainWith = (script?: Parameters<typeof fakeSpawner>[0], over: Parameters<typeof createClaudeBrain>[0] = {}) => {
    const { spawnChild, children } = fakeSpawner(script);
    const brain = createClaudeBrain({ resolveBinary: () => '/Users/x/.local/bin/claude', spawnBinary: (_binary, args, env) => spawnChild(args, env), ...over });
    return { brain, children };
  };

  it('answers a chat request as an SSE body the adapter can read', async () => {
    const { brain } = brainWith();
    const body = await brain.complete({ messages: [{ role: 'user', content: 'ping' }] });
    expect(body).toContain('"content":"pong"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    brain.stop();
  });

  it('maps the CLI’s stop_reason onto an OpenAI finish_reason', async () => {
    const { brain } = brainWith({ lines: [delta('cut'), result('cut', { stop_reason: 'max_tokens' })] });
    expect(await brain.complete({ messages: [{ role: 'user', content: 'x' }] })).toContain('"finish_reason":"length"');
    brain.stop();
  });

  it('emits a finish_reason even for an empty answer, so the adapter never reports a dropped stream', async () => {
    const { brain } = brainWith({ lines: [result('')] });
    const body = await brain.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(body).toContain('"finish_reason":"stop"');
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
    brain.stop();
  });

  it('feeds the prompt as ONE stream-json message and the system prompt in argv, on the streaming wire', async () => {
    const { brain, children } = brainWith();
    await brain.complete({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'ping' }] });
    const child = children[0]!;
    expect(child.args).toEqual(expect.arrayContaining(['--system-prompt', 'be brief', '--input-format', 'stream-json', '--include-partial-messages']));
    expect(child.args).not.toContain('--bare');
    expect(child.messages()).toHaveLength(1);
    expect(child.messages()[0]?.message.content[0]?.text).toBe('ping');
    // The env the child gets is the allowlist, not this process's.
    expect(Object.keys(child.env).every((k) => (CHILD_ENV_ALLOWLIST as readonly string[]).includes(k))).toBe(true);
    brain.stop();
  });

  it('streams each delta as its own frame, in order, before the finish', async () => {
    const { brain } = brainWith({ lines: [delta('one'), delta(' two'), delta(' three'), result('one two three')] });
    const chunks: string[] = [];
    await brain.stream({ messages: [{ role: 'user', content: 'count' }] }, { write: (c) => chunks.push(c) });
    const contents = chunks.map((c) => (c.startsWith('data: {') ? (JSON.parse(c.slice(6)) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> }).choices[0] : undefined));
    expect(contents.slice(0, 3).map((x) => x?.delta.content)).toEqual(['one', ' two', ' three']);
    expect(contents[3]?.finish_reason).toBe('stop');
    expect(chunks[4]).toBe('data: [DONE]\n\n');
    brain.stop();
  });

  it('a delta that contains an SSE boundary rides INSIDE its frame and forges nothing', async () => {
    const hostile = 'x\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    const { brain } = brainWith({ lines: [delta(hostile), result(hostile)] });
    const chunks: string[] = [];
    await brain.stream({ messages: [{ role: 'user', content: 'x' }] }, { write: (c) => chunks.push(c) });
    // One delta frame, one finish, one terminator — the hostile text is a string VALUE.
    expect(chunks).toHaveLength(3);
    expect((JSON.parse(chunks[0]!.slice(6)) as { choices: Array<{ delta: { content: string } }> }).choices[0]?.delta.content).toBe(hostile);
    brain.stop();
  });

  it('pre-warms: the second request for the same system prompt finds a started child', async () => {
    const { brain, children } = brainWith();
    await brain.complete({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'a' }] });
    expect(children).toHaveLength(2); // the request's child + the pre-warmed replacement
    expect(children[1]?.written).toEqual([]);
    await brain.complete({ messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'b' }] });
    // The second request used the pre-warmed child (index 1) and a third was pre-warmed.
    expect(children[1]?.messages()[0]?.message.content[0]?.text).toBe('b');
    expect(children).toHaveLength(3);
    expect(children[0]?.exited).toBe(true);
    expect(children[1]?.exited).toBe(true);
    brain.stop();
  });

  it('names its own cold-start bound rather than passing on the transport’s spelling', async () => {
    const { brain } = brainWith({ silent: true }, { firstDeltaMs: 20 });
    await expect(brain.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/did not answer within/);
    brain.stop();
  });

  it('names the idle bound once the child was answering', async () => {
    const { brain } = brainWith({ lines: [delta('partial')] }, { firstDeltaMs: 5_000, idleMs: 20 });
    const chunks: string[] = [];
    await expect(brain.stream({ messages: [{ role: 'user', content: 'x' }] }, { write: (c) => chunks.push(c) })).rejects.toMatchObject({ partial: true, message: expect.stringMatching(/stopped answering/) });
    expect(chunks).toHaveLength(1);
    brain.stop();
  });

  it('a failure before any delta is NOT partial — the route can still answer a 502', async () => {
    const { brain } = brainWith({ lines: [result('Not logged in · Please run /login', { is_error: true })] });
    await expect(brain.stream({ messages: [{ role: 'user', content: 'x' }] }, { write: () => {} })).rejects.toMatchObject({ partial: false, message: expect.stringMatching(/login/) });
    brain.stop();
  });

  it('the page closing its request reaps the child', async () => {
    const { brain, children } = brainWith({ silent: true });
    const controller = new AbortController();
    const pending = brain.stream({ messages: [{ role: 'user', content: 'x' }] }, { write: () => {}, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await expect(pending).rejects.toThrow(/closed the request/);
    expect(children[0]?.exited).toBe(true);
    brain.stop();
  });

  it('surfaces a CLI that could not start, with its reason', async () => {
    const brain = createClaudeBrain({ resolveBinary: () => '/x/claude', spawnBinary: () => { throw new Error('could not start claude: ENOENT'); } });
    await expect(brain.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/ENOENT/);
  });

  it('spawns the RESOLVED path, not the bare name', async () => {
    const seen: string[] = [];
    const { spawnChild } = fakeSpawner();
    const brain = createClaudeBrain({ resolveBinary: () => '/Users/x/.local/bin/claude', spawnBinary: (binary, args, env) => { seen.push(binary); return spawnChild(args, env); } });
    await brain.complete({ messages: [{ role: 'user', content: 'x' }] });
    expect(seen[0]).toBe('/Users/x/.local/bin/claude');
    brain.stop();
  });

  it('a think with no binary fails by name, with the install remedy, rather than ENOENT', async () => {
    const brain = createClaudeBrain({ resolveBinary: () => undefined, spawnBinary: () => { throw new Error('never'); } });
    await expect(brain.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/install/i);
  });

  it('stop() reaps the pre-warmed children', async () => {
    const { brain, children } = brainWith();
    await brain.complete({ messages: [{ role: 'user', content: 'x' }] });
    brain.stop();
    expect(children.every((c) => c.exited)).toBe(true);
  });
});

// ------------------------------------------------------- the readiness probe (D-B35)

describe('probeBrain — is the user’s CLI actually able to answer, on the brain’s own wire?', () => {
  // WHY THIS EXISTS. The owner's walk found the CLI logged out: the child answered
  // `Not logged in · Please run /login`, which reached the page as a generic HTTP 502 at
  // the FIRST THINK, with no remedy shown and no hint that the brain was the problem. A
  // brain chip that says "Claude · your CLI" while the CLI cannot answer is a lie the user
  // pays for with a confusing failure — so the state is probed at boot and named.
  const probeWith = (script?: Parameters<typeof fakeSpawner>[0], over: Parameters<typeof probeBrain>[0] = {}) => {
    const { spawnChild, children } = fakeSpawner(script);
    return { state: probeBrain({ resolveBinary: () => '/Users/x/.local/bin/claude', spawnBinary: (_b, args, env) => spawnChild(args, env), timeoutMs: 200, ...over }), children };
  };

  it('reports ready when the CLI answers normally', async () => {
    expect(await probeWith().state).toMatchObject({ state: 'ready' });
  });

  it('names a LOGGED-OUT cli, with the remedy — the exact string the owner’s walk hit', async () => {
    // Measured 2026-09-08 against the real CLI, not invented.
    const state = await probeWith({ lines: [result('Not logged in · Please run /login', { is_error: true })] }).state;
    expect(state.state).toBe('logged-out');
    // The remedy must be in the words the user reads, not only in a log.
    expect(state.detail).toMatch(/login/i);
  });

  it('names an OUTDATED cli, with `claude update` as the remedy — and never mistakes it for logged-out', async () => {
    // MEASURED 2026-09-13: the owner's CLI (2.1.211) answered EVERY call with this.
    const OUTDATED =
      "API Error: 400 Claude Code 2.1.211 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
    const state = await probeWith({ lines: [result(OUTDATED, { is_error: true })] }).state;
    expect(state.state).toBe('outdated');
    expect(state.detail).toMatch(/claude update/);
  });

  it('reports ABSENT without spawning anything when no binary resolves — a GUI-spawned process has no user PATH', async () => {
    const spawnBinary = vi.fn(() => { throw new Error('never called'); });
    const state = await probeBrain({ resolveBinary: () => undefined, spawnBinary });
    expect(state.state).toBe('absent');
    expect(spawnBinary).not.toHaveBeenCalled();
  });

  it('the absent remedy sends a non-technical user to the install page, never to pipe curl into bash', async () => {
    const state = await probeBrain({ resolveBinary: () => undefined });
    expect(state.detail).toBe(INSTALL_REMEDY);
    expect(state.detail).toMatch(/code\.claude\.com/);
    expect(state.detail).not.toMatch(/curl|\| *bash/);
    expect(state.detail).toMatch(/\/login/);
  });

  it('names a resolved binary that still cannot start as absent, not logged-out', async () => {
    const state = await probeBrain({ resolveBinary: () => '/x/claude', spawnBinary: () => { throw new Error('could not start claude: ENOENT'); } });
    expect(state.state).toBe('absent');
  });

  it('runs the SAME wire the brain does, with no tools — a probe down a different path proves the wrong thing', async () => {
    const { state, children } = probeWith();
    await state;
    expect(children[0]?.args).toEqual(buildStreamArgs('Answer with the single word ok.'));
    expect(children[0]?.args).toEqual(expect.arrayContaining(['--tools', '', '--input-format', 'stream-json']));
  });

  it('treats a CLI that never answers as unknown rather than claiming the brain is ready, and reaps it', async () => {
    const { state, children } = probeWith({ silent: true }, { timeoutMs: 20 });
    expect((await state).state).toBe('unknown');
    expect(children[0]?.exited).toBe(true);
  });

  it('reaps the probe’s child after a ready answer — it is not the brain’s pre-warmed one', async () => {
    const { state, children } = probeWith();
    await state;
    expect(children[0]?.exited).toBe(true);
  });
});

describe('the child is isolated from the agent host’s project and the user’s memory (security review, measured 2026-09-13)', () => {
  it('runs with --setting-sources local and --strict-mcp-config', () => {
    const args = buildStreamArgs('s');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('local');
    expect(args).toContain('--strict-mcp-config');
  });

  it('spawns every child in the neutral cwd the runner hands it — never the agent host’s project', async () => {
    const cwds: Array<string | undefined> = [];
    const { spawnChild } = fakeSpawner();
    const brain = createClaudeBrain({ cwd: '/Users/x/Snug/host/brain', resolveBinary: () => '/x/claude', spawnBinary: (_b, args, env, cwd) => { cwds.push(cwd); return spawnChild(args, env); } });
    await brain.complete({ messages: [{ role: 'user', content: 'x' }] });
    brain.stop();
    expect(cwds.length).toBeGreaterThanOrEqual(2); // the request's child and the pre-warmed one
    expect(new Set(cwds)).toEqual(new Set(['/Users/x/Snug/host/brain']));
  });

  it('the probe runs in the same cwd', async () => {
    const cwds: Array<string | undefined> = [];
    const { spawnChild } = fakeSpawner();
    await probeBrain({ cwd: '/Users/x/Snug/host/brain', resolveBinary: () => '/x/claude', spawnBinary: (_b, args, env, cwd) => { cwds.push(cwd); return spawnChild(args, env); } });
    expect(cwds).toEqual(['/Users/x/Snug/host/brain']);
  });

  it('the child’s PATH starts with the Node that runs the host — an npm-installed `claude` is a `#!/usr/bin/env node` shim', () => {
    expect(childEnvFor({ HOME: '/h', PATH: '/usr/bin' }, '/opt/node/bin').PATH).toBe('/opt/node/bin:/usr/bin');
    expect(childEnvFor({ HOME: '/h' }, '/opt/node/bin').PATH).toBe('/opt/node/bin');
    expect(childEnvFor({ HOME: '/h', PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
    // and it adds no other name
    expect(Object.keys(childEnvFor({ HOME: '/h' }, '/opt/node/bin')).sort()).toEqual(['HOME', 'PATH']);
  });

  it('the outdated regex matches the CLI’s sentence and not a passing mention of an update', async () => {
    const { spawnChild } = fakeSpawner({ lines: [result('Not logged in · Please run /login (tip: claude update is available)', { is_error: true })] });
    const state = await probeBrain({ resolveBinary: () => '/x/claude', spawnBinary: (_b, args, env) => spawnChild(args, env), timeoutMs: 200 });
    expect(state.state).toBe('logged-out');
  });
});
