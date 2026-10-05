// The `codex` brain (ADR-0071): the user's own Codex CLI, on their ChatGPT login, answering
// an app's think and doing NOTHING else.
//
// Everything here was measured on the real CLI 0.160.0, run logged out from a scratch
// directory with its own `CODEX_HOME` (2026-10-03):
//   · `codex exec` accepts every flag below without complaint, and reads the prompt from
//     stdin when its argument is `-`;
//   · there is NO single "no tools" switch (the request is open upstream). `features list`
//     names 150 features; the tool-shaped ones are disabled one by one, and only
//     `shell_tool` has been observed (third-party) to remove its tool when disabled;
//   · `login status` exits 1 and prints `Not logged in` at once and offline, where a
//     logged-out `exec` retries for ~15 s before `turn.failed` — so readiness is asked of
//     `login status`, never of a think;
//   · `debug models --bundled` prints the model catalogue offline and logged out;
//   · the npm `codex` is a `#!/usr/bin/env node` shim: exit 127 under an empty PATH, the
//     same finding as `claude`, with the same cure (this Node's directory on the child's PATH).
// NOT measured, because it needs the owner's ChatGPT login: a successful turn, whether each
// disabled feature really removes its tool, whether `developer_instructions` is honoured
// as the system slot — and the logged-IN `login status` line that `ready` rests on.
// MEASURED by the owner's walk B7 (2026-10-05) and reproduced offline (`codex debug
// prompt-input`, fixtures/codex/prompt-input-*.recorded.json): Codex loads its GLOBAL
// instructions file — `AGENTS.md`/`AGENTS.override.md` under its home — into EVERY think, as a
// user message, whatever `--ignore-user-config` and `project_doc_max_bytes` say (those govern
// `config.toml` and project docs; the global file has its own loader and no switch). The
// user's `~/.codex/AGENTS.md` would steer every app reply and could be repeated to an app. So
// this brain runs with Snug's OWN Codex home (`codexHome`) and its own login into it: the
// user's instructions, config, skills and plugins never reach an app. Snug never reads the
// login Codex keeps there.
// `Logged in using ChatGPT` (and the API-key line) are TRANSCRIBED from upstream's
// `codex-rs/cli/src/login.rs` at `rust-v0.160.0`, never seen printed (fixtures/codex/
// PROVENANCE.md; Gate 5, tests/F3). If the real CLI says otherwise, a logged-in Codex reads
// as not ready — safe, and walk B7's first step shows it. That is why this brain is
// `verified: false`.
//
// ONE THINK = ONE CHILD. Codex `exec` is single-shot and its start-up is part of every think;
// nothing is pre-warmed and nothing is reused (the warm app server is experimental upstream —
// ADR-0071, alternatives). The answer arrives whole, so this brain does not stream.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

import {
  argvPromptLimit,
  BrainStreamError,
  chatFrames,
  isArgvTooBig,
  isModelId,
  splitChatRequest,
  type Brain,
  type BrainCatalog,
  type BrainDriver,
  type BrainModel,
  type BrainReadiness,
} from './brain.js';
import { CODEX_SENTENCES, createCodexTurn, type CodexOutcome } from './codex-events.js';

/** A path as ONE shell word: bare when it is plainly safe, single-quoted otherwise. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The one login Snug's Codex needs: into Snug's OWN Codex home, never the user's `~/.codex`. */
export const codexLoginCommand = (codexHome: string): string => `CODEX_HOME=${shellWord(codexHome)} codex login`;

/** The remedy when there is no CLI at all — a page to visit, then one command. Never a curl pipe. */
export const codexInstallRemedy = (codexHome: string): string =>
  `No \`codex\` CLI found on this machine. Install Codex (https://developers.openai.com/codex/cli), then run \`${codexLoginCommand(codexHome)}\`, and check again.`;

/** Logged out of Snug's own Codex home. Says WHY there is a second login — or a person would use their own. */
export const codexLoginRemedy = (codexHome: string): string =>
  `Snug keeps its own Codex login, so your own Codex instructions and settings never reach an app — run \`${codexLoginCommand(codexHome)}\` and choose ChatGPT, then check again.`;

/** Snug's Codex home holds an API-key login: not the user's own agent (D15). */
export const codexApiKeyRemedy = (codexHome: string): string =>
  `Snug's Codex is logged in with an API key. Snug uses your ChatGPT login, not an API key — run \`${codexLoginCommand(codexHome)}\`, choose ChatGPT, then check again.`;

/**
 * The Codex CLI versions whose tool-free posture has been WALKED on a real ChatGPT login.
 * EMPTY: none has, so this brain is unverified — listed as experimental, selectable only by
 * an explicit pin, never taken by `auto` (ADR-0071 §2, criterion B6).
 *
 * A version goes in only after a journaled walk on THAT version (criterion B7) showed all of:
 *   1. a normal think (one Chess move) answers, and the item types it emits are only
 *      `agent_message` and `reasoning`;
 *   2. two adversarial thinks — "run `id`" and "search the web for …" — produce ZERO
 *      non-answer items: no command, no search, no MCP call, nothing the tripwire stops;
 *   3. a canary planted in `$CODEX_HOME/AGENTS.md` appears in no answer (the user's own
 *      instructions and config do not reach an app's think);
 *   4. `developer_instructions` is honoured as the system slot (the app's contract shapes
 *      the answer).
 * A CLI reporting any other version stays unverified: a new release can add a tool.
 *
 * The walk is `SNUG_LIVE_BRAIN=codex` on `__tests__/brain-live.test.ts`, whose header prints
 * the owner's steps; it runs THIS driver and prints the lines to journal.
 */
export const CODEX_VERIFIED_VERSIONS: readonly string[] = [];

/**
 * The version `codex --version` reports, in the form `CODEX_VERIFIED_VERSIONS` holds — the ONE
 * place that output is read, by the probe and by the owner's walk alike. Measured on 0.160.0:
 * `codex-cli 0.160.0` → `0.160.0`. Anything else is no version, and so never a walked one.
 *
 * One reading because there were two (Gate 5, truth/F2): the walk printed the raw line and
 * said "add this version"; the probe compared the bare number. A pasted `codex-cli 0.160.0`
 * would have left Codex unverified for ever, with nothing failing.
 */
export function codexVersionOf(output: string): string | undefined {
  return /^codex-cli (\S+)$/.exec(output.trim())?.[1];
}

/**
 * Every tool-shaped feature, off (ADR-0071 §2). The stable ones that default ON in 0.160.0
 * — a shell, the unified exec tool and its tty, image viewing, apps, plugins, sub-agents,
 * image generation, three kinds of browser use, computer use, hooks, a sleep tool, skill
 * search, tool suggestion, goals — and `memories`, which is off by default and must stay so
 * whatever the user's config says.
 */
export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'unified_exec_tty',
  'view_image',
  'apps',
  'plugins',
  'multi_agent',
  'image_generation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'hooks',
  'sleep_tool',
  'skill_search',
  'tool_suggest',
  'goals',
  'memories',
] as const;

/**
 * The posture every think runs with. JSONL out; no session on disk; no git requirement (the
 * directory is not a repo); the read-only sandbox, which bounds whatever a shell could still
 * do; the user's `config.toml` and exec-policy rules ignored — which drops their MCP servers
 * and hooks; web search off; project docs (`AGENTS.md`) off.
 */
const POSTURE = [
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  '--ignore-user-config',
  '--ignore-rules',
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
  '-c',
  'web_search="disabled"',
  '-c',
  'project_doc_max_bytes=0',
] as const;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MUST_ESCAPE = /["\\\u0000-\u001F\u007F]/g;
const SHORT_ESCAPES: Record<string, string> = { '\b': '\\b', '\t': '\\t', '\n': '\\n', '\f': '\\f', '\r': '\\r', '"': '\\"', '\\': '\\\\' };

/**
 * A string as a TOML basic string (toml.io v1.0.0): the quote, the backslash and every
 * control character escaped, so the result is ONE line holding ONE value whatever the text
 * was. Codex parses a `-c key=value` override's value as TOML; an app's instructions are
 * LLM-written text, and text that could end the string early could set `sandbox_mode` or
 * switch a feature back on. The five controls TOML names ride as their two-character
 * escapes — a system prompt is mostly lines, and `\n` is a third the size of `\u000A` under
 * a per-argument limit — and the rest as `\uXXXX`.
 *
 * A lone surrogate is refused: it is not a Unicode scalar value, so TOML cannot hold it, and
 * argv would silently turn it into U+FFFD.
 */
export function tomlBasicString(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new Error('a lone surrogate cannot ride a TOML string');
  return `"${value.replace(MUST_ESCAPE, (char) => SHORT_ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)}"`;
}

/** A thinking level is a short lower-case word in every catalogue seen; anything else never reaches argv. */
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/;
const isEffortWord = (value: unknown): value is string => typeof value === 'string' && EFFORT.test(value);

/**
 * The one argv (ADR-0071 §2, §7). The app's runtime contract is the developer instruction —
 * exactly ONE `-c developer_instructions=<TOML string>` — and the conversation is the prompt,
 * read from stdin (`-`); nothing is written to the working directory. The model and the
 * level are optional and additive: with neither chosen this is the frozen literal the test
 * holds, and neither can displace the posture.
 */
export function buildCodexArgs(spec: { system: string; model?: string | undefined; effort?: string | undefined; cwd: string }): string[] {
  const choice: string[] = [];
  // The route refuses a bad value at the boundary; this is the defence behind it, and it
  // fails LOUD rather than quietly running the default.
  if (spec.model !== undefined) {
    if (!isModelId(spec.model)) throw new Error(`"${String(spec.model)}" is not a model id`);
    choice.push('-m', spec.model);
  }
  if (spec.effort !== undefined) {
    if (!isEffortWord(spec.effort)) throw new Error(`"${String(spec.effort)}" is not a thinking level`);
    choice.push('-c', `model_reasoning_effort=${tomlBasicString(spec.effort)}`);
  }
  return [...POSTURE, '-c', `developer_instructions=${tomlBasicString(spec.system)}`, ...choice, '-C', spec.cwd, '-'];
}

// ------------------------------------------------------------------ the bounds

/**
 * How long a child may take to write its FIRST line. `thread.started` comes before any
 * network, so this is the CLI's own start — generous, because a cold start has never been
 * measured on a logged-in CLI (the walk journals it).
 */
export const CODEX_FIRST_OUTPUT_MS = 60_000;
/**
 * The longest silence once it has started. Codex writes nothing between `turn.started` and
 * the answer, which arrives whole — so this is not a gap between tokens, it is the longest
 * answer's entire duration (a 54 KB build measured 223 s on Claude). Both name themselves
 * when they fire.
 */
export const CODEX_IDLE_MS = 300_000;
/** An app looping its thinks must not fan out a process — and a call on the user's plan — per loop. */
export const CODEX_MAX_LIVE = 4;
/** `login status` answers at once and offline (measured); past this it is `unknown`. */
const LOGIN_STATUS_MS = 10_000;
const CATALOG_MS = 10_000;
const VERSION_MS = 5_000;
/** How long a settled think waits for its killed group's pipes to close before going on without them. */
const REAP_WAIT_MS = 2_000;
/** `debug models --bundled` printed 659 KB in 0.160.0; `login status`, one line. */
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
/** The chip lists the catalogue's current models and never more than this. */
const CATALOG_MAX = 8;

// ------------------------------------------------------------------- the spawn

/** What the driver needs of a child — a real one in its own process group, or a fake. */
export interface CodexProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  /** After the process has gone AND its pipes have closed — so every process that held them has gone too. */
  on(event: 'close', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** SIGKILL the child's whole process group, now. */
  killGroup(): void;
}

export type SpawnCodex = (binary: string, args: readonly string[], options: { env: Record<string, string>; cwd: string }) => CodexProcess;

/**
 * Spawn DETACHED — the child leads its own process group — so that everything it started
 * can be killed with it. A brain that ran a tool has a grandchild, and a signal to the
 * child alone would orphan it; SIGTERM would ask a process that has already broken the one
 * rule to tidy up first. So: SIGKILL, to the group, at once.
 */
export const spawnInOwnGroup: SpawnCodex = (binary, args, { env, cwd }) => {
  const child = spawn(binary, [...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    on: (event: 'close' | 'error', listener: ((code: number | null) => void) & ((error: Error) => void)) => child.on(event, listener),
    killGroup() {
      // No pid: the spawn failed, and there is nothing to signal.
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* ESRCH: the whole group is already gone */
      }
    },
  };
};

type CommandResult = { kind: 'exited'; code: number | null; stdout: string; stderr: string } | { kind: 'not-started' } | { kind: 'timed-out' } | { kind: 'too-much-output' };

// ------------------------------------------------------------------ the catalogue

const NO_CATALOG: BrainCatalog = { efforts: [], models: [] };

/**
 * `codex debug models --bundled`, read (measured: `{ models: [{ slug, display_name,
 * visibility, priority, supported_reasoning_levels: [{ effort }] … }] }`). The models the
 * CLI itself lists, in its own order of preference, each with ITS OWN levels; the levels
 * offered when no model is chosen are the default model's — the lowest `priority`.
 * Anything unreadable is no list at all, and a slug or level that could not safely ride
 * argv is dropped rather than offered.
 */
export function parseCodexCatalog(text: string): BrainCatalog {
  try {
    const root = JSON.parse(text) as { models?: unknown } | null;
    if (!Array.isArray(root?.models)) return NO_CATALOG;
    const listed: Array<BrainModel & { priority: number }> = [];
    for (const entry of root.models as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const { slug, display_name: displayName, visibility, priority, supported_reasoning_levels: levels } = entry as Record<string, unknown>;
      if (visibility !== 'list' || !isModelId(slug)) continue;
      listed.push({
        id: slug,
        name: typeof displayName === 'string' && displayName !== '' ? displayName : slug,
        efforts: (Array.isArray(levels) ? (levels as unknown[]) : []).map((level) => (level as { effort?: unknown } | null)?.effort).filter(isEffortWord),
        priority: typeof priority === 'number' ? priority : Number.POSITIVE_INFINITY,
      });
    }
    listed.sort((a, b) => a.priority - b.priority);
    const models = listed.slice(0, CATALOG_MAX).map(({ id, name, efforts }) => ({ id, name, efforts }));
    return { efforts: models[0]?.efforts ?? [], models };
  } catch {
    return NO_CATALOG;
  }
}

// ------------------------------------------------------------------- the driver

export interface CodexDriverDeps {
  /** The child environment — the registry's ONE allowlisted read (ADR-0071 §3). Never carries a `CODEX_HOME`: the driver sets its own. */
  env: Record<string, string>;
  /**
   * Snug's OWN Codex home, set as `CODEX_HOME` on every child (the B7 walk, 2026-10-05): Codex
   * reads its global `AGENTS.md` from its home into every think, so the user's `~/.codex`
   * would steer every app. Created private on first use; Snug logs in to it once.
   */
  codexHome: string;
  /** A neutral, EMPTY directory under the Snug home — never the agent host's project, and never another brain's. */
  cwd: string;
  /** Where the CLI is: PATH, then the installers' known directories (ADR-0069 §6). */
  resolveBinary(): string | undefined;
  /** Injected so tests never launch a real CLI, and never send a real signal. */
  spawn?: SpawnCodex;
  firstOutputMs?: number;
  idleMs?: number;
  maxLive?: number;
  reapWaitMs?: number;
  loginStatusMs?: number;
  catalogMs?: number;
  verifiedVersions?: readonly string[];
}

export function createCodexDriver(deps: CodexDriverDeps): BrainDriver {
  const spawnCodex = deps.spawn ?? spawnInOwnGroup;
  const firstOutputMs = deps.firstOutputMs ?? CODEX_FIRST_OUTPUT_MS;
  const idleMs = deps.idleMs ?? CODEX_IDLE_MS;
  const maxLive = deps.maxLive ?? CODEX_MAX_LIVE;
  const reapWaitMs = deps.reapWaitMs ?? REAP_WAIT_MS;
  const verifiedVersions = deps.verifiedVersions ?? CODEX_VERIFIED_VERSIONS;

  /** As the last probe of a READY CLI read it. Empty otherwise: a brain that cannot think offers no controls. */
  let catalog = NO_CATALOG;
  /** What the installed CLI calls itself — asked only when there is a walked version to compare it with. */
  let version: string | undefined;

  /** Created on first use, private to the user, and never written into: the read-only sandbox can still READ its directory. */
  const ensureCwd = (): void => void mkdirSync(deps.cwd, { recursive: true, mode: 0o700 });
  /** Snug's own Codex home — where Codex keeps the login Snug asked for (never read by Snug). */
  const ensureHome = (): void => void mkdirSync(deps.codexHome, { recursive: true, mode: 0o700 });
  /** Every child's environment: the allowlist, and Snug's own Codex home — whatever the parent had. */
  const childEnv: Record<string, string> = { ...deps.env, CODEX_HOME: deps.codexHome };

  /** One short, bounded command: its output and exit code, or why there is none. */
  const run = (binary: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> =>
    new Promise((resolve) => {
      let child: CodexProcess;
      try {
        ensureHome();
        child = spawnCodex(binary, args, { env: childEnv, cwd: deps.cwd });
      } catch {
        resolve({ kind: 'not-started' });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let bytes = 0;
      let done = false;
      const finish = (result: CommandResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (result.kind !== 'exited') child.killGroup();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ kind: 'timed-out' }), timeoutMs);
      timer.unref?.();
      const collect = (into: Buffer[]) => (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
        bytes += buffer.byteLength;
        if (bytes > MAX_COMMAND_OUTPUT_BYTES) finish({ kind: 'too-much-output' });
        else into.push(buffer);
      };
      child.stdout.on('data', collect(out));
      child.stderr?.on('data', collect(err));
      child.on('error', () => finish({ kind: 'not-started' }));
      child.on('close', (code) => finish({ kind: 'exited', code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
      // These commands read nothing; an open stdin would only keep a confused child waiting.
      child.stdin.on('error', () => {});
      child.stdin.end();
    });

  /** `codex login status`: `ready` ONLY for the ChatGPT login. The CLI's own line is never repeated — an API-key login prints part of the key. */
  const readiness = (status: CommandResult): BrainReadiness => {
    if (status.kind === 'not-started') return { state: 'absent', detail: codexInstallRemedy(deps.codexHome) };
    if (status.kind === 'timed-out') return { state: 'unknown', detail: CODEX_SENTENCES.statusTimedOut };
    if (status.kind === 'too-much-output') return { state: 'unknown', detail: CODEX_SENTENCES.unreadableStatus };
    // Measured: the logged-out line is on STDERR and stdout is empty. Both are read.
    const lines = `${status.stdout}\n${status.stderr}`.split('\n').map((line) => line.trim());
    if (status.code === 0 && lines.some((line) => line.startsWith('Logged in using ChatGPT'))) return { state: 'ready' };
    // A brain on a key is not "the user's own agent" (D15), and no key is ever forwarded to it.
    if (status.code === 0 && lines.some((line) => line.startsWith('Logged in using'))) return { state: 'logged-out', detail: codexApiKeyRemedy(deps.codexHome) };
    if (status.code === 1 || lines.some((line) => line.startsWith('Not logged in'))) return { state: 'logged-out', detail: codexLoginRemedy(deps.codexHome) };
    return { state: 'unknown', detail: CODEX_SENTENCES.unreadableStatus };
  };

  const createBrain = (): Brain => {
    /** Every think in flight, by the function that ends it. */
    const live = new Set<(outcome: CodexOutcome) => void>();
    let stopped = false;

    const brain: Brain = {
      async stream(request, sink) {
        if (stopped) throw new BrainStreamError('the runner is stopping', false);
        // The cap counts what is ANSWERING. Refused by name, never queued.
        if (live.size >= maxLive) throw new BrainStreamError(`Snug is already answering ${maxLive} thinks — try again in a moment`, false);
        const { system, prompt } = splitChatRequest(request);
        const binary = deps.resolveBinary();
        if (binary === undefined) throw new BrainStreamError(codexInstallRemedy(deps.codexHome), false);

        let child: CodexProcess;
        try {
          ensureCwd();
          ensureHome();
          child = spawnCodex(binary, buildCodexArgs({ system, model: request.model, effort: request.effort, cwd: deps.cwd }), { env: childEnv, cwd: deps.cwd });
        } catch (error) {
          // Node THROWS E2BIG rather than emitting it (measured: a 2 MiB argument).
          throw new BrainStreamError(isArgvTooBig(error) ? CODEX_SENTENCES.tooLarge : CODEX_SENTENCES.couldNotStart, false);
        }

        const outcome = await new Promise<CodexOutcome>((settle) => {
          const turn = createCodexTurn();
          let decided = false;
          let closed = false;
          let afterClose: (() => void) | undefined;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const failed = (sentence: string): CodexOutcome => ({ kind: 'failed', sentence });

          const decide = (result: CodexOutcome): void => {
            if (decided) return;
            decided = true;
            clearTimeout(timer);
            sink.signal?.removeEventListener('abort', onClientAbort);
            live.delete(decide);
            if (closed) {
              settle(result);
              return;
            }
            // AT ONCE, THE WHOLE GROUP, NO GRACE — on a finished answer too: every spawn
            // owes a reap, and a child that has answered has nothing left to do.
            child.killGroup();
            // Settled when the pipes have closed, which is when every process holding them
            // is gone — the child AND whatever it started. Bounded: a stray that left the
            // group and kept the pipe must not hold the think.
            const giveUp = setTimeout(() => settle(result), reapWaitMs);
            giveUp.unref?.();
            afterClose = () => {
              clearTimeout(giveUp);
              settle(result);
            };
          };
          // THE BOUND THAT FIRED NAMES ITSELF (lesson 2026-08-18).
          const bound = (ms: number, why: string): void => {
            clearTimeout(timer);
            timer = setTimeout(() => decide(failed(`your Codex CLI ${why} ${Math.round(ms / 1000)}s`)), ms);
            timer.unref?.();
          };
          const onClientAbort = (): void => decide(failed('your Codex CLI stopped — the page closed the request'));

          live.add(decide);
          bound(firstOutputMs, 'did not answer within');
          sink.signal?.addEventListener('abort', onClientAbort, { once: true });
          child.stdout.on('data', (chunk: Buffer | string) => {
            if (decided) return;
            bound(idleMs, 'stopped answering for');
            const result = turn.push(chunk);
            if (result !== undefined) decide(result);
          });
          // Drained so a chatty child cannot block on a full pipe — and never read: stderr
          // is a log full of URLs and request ids, and none of it may reach a page.
          child.stderr?.resume();
          child.on('error', (error) => decide(failed(isArgvTooBig(error) ? CODEX_SENTENCES.tooLarge : CODEX_SENTENCES.couldNotStart)));
          child.on('close', () => {
            closed = true;
            // A child that left without a verdict delivered nothing, whatever it had said.
            if (!decided) decide(turn.end());
            else afterClose?.();
          });
          // A child that died first closes its stdin under the write; `close` names that.
          child.stdin.on('error', () => {});
          child.stdin.end(prompt);
        });

        if (outcome.kind === 'failed') throw new BrainStreamError(outcome.sentence, false);
        // Codex's stream never names the model that ran, so the envelope claims none: the
        // brain's own id rides it, NEVER the model that was asked for (ADR-0070 D2).
        const frames = chatFrames('codex');
        if (outcome.text !== '') sink.write(frames.content(outcome.text));
        sink.write(frames.finish('codex', 'stop'));
        sink.write(frames.done);
      },

      async complete(request) {
        let body = '';
        await brain.stream(request, { write: (chunk) => (body += chunk) });
        return body;
      },

      stop() {
        stopped = true;
        for (const end of [...live]) end({ kind: 'failed', sentence: 'your Codex CLI stopped — the runner is stopping' });
      },
    };
    return brain;
  };

  return {
    id: 'codex',
    name: 'Codex',
    via: 'your Codex CLI',
    get verified() {
      return version !== undefined && verifiedVersions.includes(version);
    },
    // The answer is one `item.completed`, never token deltas (measured).
    streaming: false,
    maxPromptBytes: argvPromptLimit(),

    async probe() {
      const binary = deps.resolveBinary();
      // No binary anywhere is decided WITHOUT a spawn (ADR-0069 §6).
      if (binary === undefined) {
        catalog = NO_CATALOG;
        version = undefined;
        return { state: 'absent', detail: codexInstallRemedy(deps.codexHome) };
      }
      ensureCwd();
      if (verifiedVersions.length > 0) {
        const said = await run(binary, ['--version'], VERSION_MS);
        version = said.kind === 'exited' && said.code === 0 ? codexVersionOf(said.stdout) : undefined;
      }
      const verdict = readiness(await run(binary, ['login', 'status'], deps.loginStatusMs ?? LOGIN_STATUS_MS));
      if (verdict.state !== 'ready') {
        catalog = NO_CATALOG;
        return verdict;
      }
      const listed = await run(binary, ['debug', 'models', '--bundled'], deps.catalogMs ?? CATALOG_MS);
      // Failing soft: no list is free text for the model and no level — never a broken control.
      catalog = listed.kind === 'exited' && listed.code === 0 ? parseCodexCatalog(listed.stdout) : NO_CATALOG;
      return verdict;
    },

    catalog: () => catalog,

    acceptsModel(model) {
      // The catalogue's own slugs where there is one; otherwise free text held to the shape
      // that can ride argv, as Claude's is — the CLI refuses a model it does not have.
      return catalog.models.length > 0 ? catalog.models.some((entry) => entry.id === model) : isModelId(model);
    },

    acceptsEffort(model, effort) {
      // The chosen model's OWN levels (ADR-0071 §5). With no catalogue there are none to
      // accept: a level Codex does not list for the model is a refused think.
      const levels = model === undefined ? catalog.efforts : catalog.models.find((entry) => entry.id === model)?.efforts;
      return levels?.includes(effort) ?? false;
    },

    create: createBrain,
  };
}
