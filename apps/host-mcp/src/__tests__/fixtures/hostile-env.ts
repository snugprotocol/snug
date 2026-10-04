// THE HOSTILE PARENT (B4) — one list for every child this process starts.
//
// The twelve `CLAUDE_*` names were measured in a live Claude Code session on 2026-09-07 — the
// messaging token and socket are a live IPC channel back into it — and the keys are every
// credential variable either vendor's CLI reads. A brain on a key is not "the user's own
// agent" (D15), and a key that reached a child would be one process away from an app's think.
//
// Shared since Gate 5 (security/F2): the browser opener is a child too, and on Linux the
// browser it starts inherits what the opener was given. One list means the brains' test and
// the opener's test cannot drift apart.

/** The variables a child may legitimately carry — every one of them on the brains' allowlist. */
export const BENIGN_PARENT: Readonly<Record<string, string>> = {
  HOME: '/Users/x',
  PATH: '/usr/bin',
  SHELL: '/bin/zsh',
  USER: 'x',
  LANG: 'en_US.UTF-8',
  TMPDIR: '/tmp/x',
  TERM: 'xterm-256color',
};

/** What no child may inherit: a canary in every value, so a leak is a string search away. */
export const HOSTILE_ONLY: Readonly<Record<string, string>> = {
  CLAUDECODE: 'canary-1',
  CLAUDE_CODE_ENTRYPOINT: 'canary-2',
  CLAUDE_CODE_SESSION_ID: 'canary-3',
  CLAUDE_CODE_CHILD_SESSION: 'canary-4',
  CLAUDE_CODE_EXECPATH: 'canary-5',
  CLAUDE_CODE_MESSAGING_SOCKET: 'canary-6',
  CLAUDE_CODE_MESSAGING_TOKEN: 'canary-7',
  CLAUDE_CODE_ENABLE_TASKS: 'canary-8',
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'canary-9',
  CLAUDE_AGENT_SDK_VERSION: 'canary-10',
  CLAUDE_PID: 'canary-11',
  CLAUDE_EFFORT: 'canary-12',
  ANTHROPIC_API_KEY: 'canary-sk-ant',
  ANTHROPIC_AUTH_TOKEN: 'canary-ant-token',
  ANTHROPIC_BASE_URL: 'https://canary.example',
  OPENAI_API_KEY: 'canary-sk-openai',
  OPENAI_BASE_URL: 'https://canary.example',
  CODEX_API_KEY: 'canary-codex-key',
  CODEX_ACCESS_TOKEN: 'canary-codex-token',
  CODEX_HOME: '/Users/x/canary-codex-home',
  SNUG_HOME: '/Users/x/canary-snug-home',
  NODE_OPTIONS: '--require /canary.js',
};

export const HOSTILE_PARENT: Readonly<Record<string, string>> = { ...BENIGN_PARENT, ...HOSTILE_ONLY };
