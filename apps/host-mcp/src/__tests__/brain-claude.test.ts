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

import { buildClaudeArgs, childEnvFor, CHILD_ENV_ALLOWLIST, completionToSseBody, SHIM_TIMEOUT_MS } from '../brain-claude.js';

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
