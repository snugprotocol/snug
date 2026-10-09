// The `claude` brain (program D5, ADR-0068 §5, ADR-0069 §5), behind the driver contract
// (ADR-0071 §1): the user's OWN CLI as a pre-warmed, single-use child on `--input-format
// stream-json`. No third-party login is offered and no key of ours exists — the usage is the
// user's, on their own subscription, which is what the brain chip's "Claude · your CLI"
// promises.
//
// It was the only brain until TASK-20261003 and was hard-wired into the runner. Moving it
// behind `BrainDriver` changed where it is built and nothing it does: the argv, the pool
// key, the readiness sentences and every frame of a think are pinned by tests that were
// green before the move.

import { spawn } from 'node:child_process';

import { ensureDirectory } from '../home.js';
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
  type BrainReadiness,
} from './brain.js';
import type { CatalogModel } from './claude-catalog.js';
import { BRAIN_EFFORTS, ChildPool, ClaudeChild, isEffort, type BrainEffort, type BrainSpec, type ChildLike, type SpawnChild } from './claude-child.js';

// THE REMEDIES end "check again", not "reopen Snug": the page picks a mended brain up when
// the user presses the dock's "check again" or comes back to the window (TASK-20261003 R4),
// so reopening is a step nobody needs. The browser specs' fixture is held to these three
// sentences (apps/host/src/__tests__/localSetup.test.ts).

/** The remedy when there is no CLI at all — a page to visit, then two commands. Never a curl pipe. */
export const INSTALL_REMEDY =
  'No `claude` CLI found on this machine — Snug is using its demo brain. Install Claude Code (https://code.claude.com/docs/en/quickstart), then run `claude` and `/login`, and check again.';
/** Each is followed, in brackets, by what the CLI itself said. */
export const LOGGED_OUT_REMEDY = 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.';
export const OUTDATED_REMEDY = 'Your Claude CLI is out of date — run `claude update`, then check again.';

/**
 * The system prompt rides argv (`--system-prompt`), and a kernel caps a command line
 * (`argvPromptLimit`). Past the cap the spawn fails `E2BIG`; said as what it is, because
 * "spawn E2BIG" tells a person nothing and reads to the page like a broken CLI.
 */
export const PROMPT_TOO_LARGE = 'This think is too large for your Claude CLI — an app’s instructions ride its command line, and the system refused one this long.';

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
export function buildStreamArgs(spec: BrainSpec): string[] {
  // The model and the effort are OPTIONAL and additive: with neither chosen the argv is
  // byte-identical to the one this binding shipped with (AC1, pinned by a frozen literal in
  // the tests), so the default path is provably unchanged by this task. Both ride BEFORE the
  // posture, which stays last and whole — neither flag may displace or reorder it (AC7).
  const choice: string[] = [];
  // Free text, validated by the CLI itself: it has no machine-readable model list (measured,
  // 2.1.278) but refuses an unknown model BY NAME rather than answering on another, so the
  // check that matters happens where the truth is. Empty/blank is "no choice", not a model.
  if (spec.model !== undefined) {
    const model = typeof spec.model === 'string' ? spec.model.trim() : spec.model;
    if (model !== '') {
      // The route refuses a bad id at the boundary; this is the defence behind it, and it fails
      // LOUD rather than quietly running the default model.
      if (!isModelId(model)) throw new Error(`"${String(model)}" is not a model id`);
      choice.push('--model', model);
    }
  }
  // An effort outside the five the CLI documents never reaches argv: the child would reject
  // the flag, which would turn a slower think into a refused one.
  if (spec.effort !== undefined && isEffort(spec.effort)) choice.push('--effort', spec.effort);
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--system-prompt', spec.system, ...choice, ...POSTURE];
}

/**
 * The bound a request's FIRST delta must arrive within — sized against the slowest
 * legitimate cold start rather than a comfortable number (lesson 2026-08-18) …
 */
export const SHIM_FIRST_DELTA_MS = 180_000;
/** … and, once a child is answering, the bound between deltas. Both name themselves when they fire. */
export const SHIM_IDLE_MS = 60_000;

/** The CLI's `stop_reason` in OpenAI's vocabulary. */
function finishReasonFor(stopReason: string): string {
  return stopReason === 'max_tokens' ? 'length' : 'stop';
}

// ------------------------------------------------------------------- the spawn

/** The spawn of a RESOLVED binary; injected so tests never launch a real CLI. */
export type SpawnBinary = (binary: string, args: string[], env: Record<string, string>, cwd?: string) => ChildLike;

const nodeSpawn: SpawnBinary = (binary, args, env, cwd) => spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], ...(cwd !== undefined ? { cwd } : {}) });

interface BinaryDeps {
  /**
   * The child's environment: the registry's ONE allowlisted read of the process's own
   * (ADR-0071 §3), handed in. This module cannot read the environment itself, so a caller
   * that hands it nothing gets a child with nothing — never the parent's.
   */
  env: Record<string, string>;
  /**
   * Where the CLI is (ADR-0069 §6): PATH, then the installers' known directories, because a
   * GUI-spawned process has no user PATH. Injected so tests never touch the real filesystem.
   */
  resolveBinary(): string | undefined;
  /**
   * The child's working directory — a neutral one under the Snug home, never the agent
   * host's project (whose CLAUDE.md and settings would otherwise be discovered).
   */
  cwd?: string;
  spawnBinary?: SpawnBinary;
}

/**
 * Resolved PER SPAWN, so a CLI installed after boot answers the next think without a
 * restart (the chip catches up at the next re-check).
 */
function spawnChildWith(deps: BinaryDeps): SpawnChild {
  const spawnBinary = deps.spawnBinary ?? nodeSpawn;
  return (args, env) => {
    const binary = deps.resolveBinary();
    if (binary === undefined) throw new Error(INSTALL_REMEDY);
    try {
      return spawnBinary(binary, args, env, deps.cwd);
    } catch (error) {
      // Node THROWS this one rather than emitting it on the child (measured: a 2 MiB
      // argument, `spawn E2BIG`).
      if (isArgvTooBig(error)) throw new Error(PROMPT_TOO_LARGE);
      throw error;
    }
  };
}

// ------------------------------------------------------------------- the brain

export interface BrainDeps extends BinaryDeps {
  /** The cold-start bound for a request's first delta. */
  firstDeltaMs?: number;
  /** The bound between deltas once a child is answering. */
  idleMs?: number;
  /**
   * The user's per-machine model and effort choice, read AT CALL TIME on every request —
   * never captured when the brain is built (ADR-0036 rule 3: a value read once would freeze
   * the choice until a reload, and "switch mid-session, the next think uses it" would be a
   * lie). Absent, or returning `{}`, is the pre-task behaviour exactly.
   */
  brainChoice?: () => { model?: string | undefined; effort?: BrainEffort | undefined };
}

export function createClaudeBrain(deps: BrainDeps): Brain {
  const firstDeltaMs = deps.firstDeltaMs ?? SHIM_FIRST_DELTA_MS;
  const idleMs = deps.idleMs ?? SHIM_IDLE_MS;
  const pool = new ChildPool({ spawnChild: spawnChildWith(deps), argsFor: buildStreamArgs, env: deps.env });

  const brain: Brain = {
    async stream(request, sink) {
      const { system, prompt } = splitChatRequest(request);
      // The user's choice, read now rather than at construction, so a switch lands on THIS
      // think. The page's own choice wins where it sent one; `deps.brainChoice` is the
      // fallback for callers that hold the choice process-side. `claude` is the page's
      // historical placeholder, never a model id: the route strips it before any driver,
      // and it is refused here too, so it cannot become a `--model` by another door.
      const fallback = deps.brainChoice?.() ?? {};
      const asked = request.model !== undefined && request.model !== '' && request.model !== 'claude' ? request.model : fallback.model;
      const effort = isEffort(request.effort) ? request.effort : fallback.effort;
      const child = pool.acquire({ system, model: asked, effort });
      // The placeholder until the CLI says what answered — NEVER the requested id: the page reads
      // the final frame's model as "what ran", and a turn whose init frame was missing must not
      // turn the request into a claim (review, 2026-10-03; ADR-0070 D2).
      let model = 'claude';
      const frames = chatFrames(model);

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
            sink.write(frames.content(text));
          },
        });
        // A CLI that streamed nothing still answered: its text rides as the one delta.
        if (deltas === 0 && result.text !== '') sink.write(frames.content(result.text));
        // What ANSWERED, never what was asked (AC5). Only on a turn that succeeded: the CLI
        // emits its init frame BEFORE validating the model against its catalogue, so on a
        // refused turn `resolvedModel` is the asked id echoed back, and announcing it would
        // name a model that never ran (measured 2026-09-22; ADR-0059 rule 2).
        if (result.resolvedModel !== undefined && result.resolvedModel !== '') model = result.resolvedModel;
        sink.write(frames.finish(model, finishReasonFor(result.stopReason)));
        sink.write(frames.done);
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
 * MEASURED 2026-09-13 on the owner's Mac: CLI 2.1.211 answered EVERY `-p` call with
 * `API Error: 400 Claude Code 2.1.211 does not support this model; version 2.1.251 or newer
 * is required. Run 'claude update' …`, `is_error: true`. A CLI's default model moves under a
 * pinned CLI version, so a brain that worked last week can be a 400 today with nobody
 * touching Snug. The old probe called this `unknown`; the CLI's own sentence names the
 * remedy, so the state does too.
 */
const OUTDATED_RE = /or newer is required|run 'claude update'/i;

export interface ProbeDeps extends BinaryDeps {
  /** How long the startup check may take before it is `unknown`. */
  timeoutMs?: number;
}

const PROBE_SYSTEM = 'Answer with the single word ok.';
const PROBE_PROMPT = 'ok';

/**
 * What the user's own CLI can actually do, decided before the first think rather than by it.
 *
 * WHY. The owner's walk on 2026-09-08 found the CLI logged out. The child answered
 * `Not logged in · Please run /login`, which reached the page as a generic HTTP 502 the
 * first time the user asked an app to think — no remedy, no hint that the BRAIN was the
 * problem rather than the app. A chip reading "Claude · your CLI" while the CLI cannot
 * answer is a promise the product does not keep.
 *
 * `logged-out` — the remedy is `claude` then `/login`. `outdated` — the remedy is `claude
 * update`. `absent` — no binary anywhere; the chip says how to install one. `unknown` — it
 * answered something unreadable; never reported as ready.
 *
 * THE PROBE RUNS THE BRAIN'S OWN WIRE: the same argv, the same child class. A probe down a
 * different path proves the wrong thing — `--version` would call a logged-out CLI ready,
 * and a one-shot `--output-format json` would vouch for a stream-json wire it never used.
 * MEASURED 2026-09-08: a logged-out CLI fails before any API call (`duration_api_ms: 0`),
 * so the honest probe is also the free one in the case that matters.
 */
export async function probeBrain(deps: ProbeDeps): Promise<BrainReadiness> {
  // No binary anywhere is decided WITHOUT a spawn: it is the cheapest answer and the one a
  // GUI-spawned process with no user PATH would otherwise get wrong (ADR-0069 §6).
  const binary = deps.resolveBinary();
  if (binary === undefined) return { state: 'absent', detail: INSTALL_REMEDY };

  let child: ClaudeChild | undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child?.kill();
  }, deps.timeoutMs ?? 20_000);
  timer.unref?.();
  try {
    child = new ClaudeChild((deps.spawnBinary ?? nodeSpawn)(binary, buildStreamArgs({ system: PROBE_SYSTEM }), deps.env, deps.cwd));
    await child.send(PROBE_PROMPT, { onDelta() {} });
    return { state: 'ready' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (timedOut) return { state: 'unknown', detail: 'your Claude CLI did not answer the startup check in time' };
    // Checked FIRST: the outdated sentence names a version, never a login.
    if (OUTDATED_RE.test(message)) {
      return { state: 'outdated', detail: `${OUTDATED_REMEDY} (${message})` };
    }
    // The CLI's own words carry the remedy ("Please run /login"), so they are passed
    // through rather than replaced with a sentence of ours that says less.
    if (/not logged in|\/login|authenticat/i.test(message)) {
      return { state: 'logged-out', detail: `${LOGGED_OUT_REMEDY} (${message})` };
    }
    // A resolved path that still cannot start (a half-removed install) reads as absent too.
    if (/ENOENT|could not start/i.test(message)) return { state: 'absent', detail: INSTALL_REMEDY };
    return { state: 'unknown', detail: message };
  } finally {
    clearTimeout(timer);
    child?.kill();
  }
}

// ------------------------------------------------------------------- the driver

export interface ClaudeDriverDeps extends BinaryDeps {
  /** The children's working directory. Created here, on first use: nobody else knows it exists. */
  cwd: string;
  /**
   * The CLI's own model catalogue (ADR-0070 amendment), read per ask so a CLI update
   * between two page loads is picked up without restarting the runner.
   */
  models(): readonly CatalogModel[];
}

export function createClaudeDriver(deps: ClaudeDriverDeps): BrainDriver {
  const catalog = (): BrainCatalog => ({
    efforts: BRAIN_EFFORTS,
    // The catalogue says whether a model HAS a thinking axis (Haiku 4.5 does not, measured);
    // the levels themselves are the CLI's five, the same for every model that has one.
    models: deps.models().map(({ id, name, effort }) => ({ id, name, efforts: effort ? BRAIN_EFFORTS : [] })),
  });

  return {
    id: 'claude',
    name: 'Claude',
    via: 'your Claude Code CLI',
    // The posture was walked on the real, logged-in CLI (ADR-0068 §5: `tools: []`, `num_turns: 1`).
    verified: true,
    streaming: true,
    maxPromptBytes: argvPromptLimit(),
    async probe() {
      ensureDirectory(deps.cwd);
      return probeBrain(deps);
    },
    catalog,
    // Free text, validated by the CLI itself (ADR-0070 §4): it has no machine-readable list
    // of everything it will take, and refuses an unknown model by name. What is checked
    // here is only that the id can ride argv.
    acceptsModel: isModelId,
    acceptsEffort(model, effort) {
      if (!isEffort(effort)) return false;
      // A model the catalogue lists WITHOUT a thinking axis takes no level; one it does not
      // list (free text, or no catalogue at all) is the CLI's to judge.
      const listed = model === undefined ? undefined : deps.models().find((entry) => entry.id === model);
      return listed === undefined || listed.effort;
    },
    create() {
      ensureDirectory(deps.cwd);
      return createClaudeBrain(deps);
    },
  };
}
