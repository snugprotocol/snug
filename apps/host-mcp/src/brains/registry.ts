// The brain registry (ADR-0071 §1, §4): which of the user's own agents answers a think.
//
// It holds the drivers, asks each whether it can answer, and resolves ONE of them — or
// none — for a think. It is handed to the runner, never built by it: the unit suite and the
// browser suite were once spawning the developer's real `claude` because the default was
// the real machine (found 2026-10-03). Now a runner has only the brains it was given.
//
// LAZY. Nothing is probed when the registry is built or when it is read. A probe of a ready
// `claude` is a real, tiny think on the user's subscription, so a session that only ever
// speaks over stdio must cost none: the first round runs at the first page contact, and
// later ones when a page asks — at most one per floor, however often it asks.
//
// SELECTION NEVER CHANGES VENDOR WITHOUT A USER ACT (§4). An app's think carries the user's
// data. `auto` is the default brain when it is ready, else NOTHING — the page's demo brain
// answers and the chip shows the remedy. A pin names one brain; a pinned brain that is not
// ready is nothing too, never another brain. "The first one was logged out, so the second
// answered" is the silent re-route the multi-provider threat model forbids (plan review,
// 2026-10-03). And a brain whose tool-free posture has not been proven on a real login
// (`verified: false`) answers only when it is pinned by id.

import { homedir } from 'node:os';
import path from 'node:path';

import { defaultResolveDeps, resolveBinary } from '../brain-resolve.js';
import { childEnvFor, type Brain, type BrainCatalog, type BrainDriver, type BrainReadiness } from './brain.js';
import { readModelCatalog } from './claude-catalog.js';
import { createClaudeDriver, type ClaudeDriverDeps } from './claude.js';
import { createCodexDriver, type CodexDriverDeps } from './codex.js';

/** The brain `auto` means (ADR-0071 §4). */
export const DEFAULT_BRAIN = 'claude';

/**
 * The least time between two probe rounds a page can cause (D4). A probe of a READY
 * `claude` is a real, tiny think on the user's subscription, and the page may ask after
 * every failed think and while the demo brain is answering — so its eagerness is bounded
 * HERE, where the cost is, and not only by the page's own manners.
 */
export const BRAIN_PROBE_FLOOR_MS = 30_000;

/** What a brain says before anybody has asked it: not ready, and not a claim that it is broken. */
export const NOT_PROBED_DETAIL = 'Snug is still checking this brain.';

/** One brain as the page's wire carries it (`fixtures/status-wire.json`). */
export interface BrainStatus {
  id: string;
  name: string;
  via: string;
  state: string;
  detail?: string;
  verified: boolean;
  streaming: boolean;
  efforts: string[];
  models: Array<{ id: string; name: string; efforts: string[] }>;
  maxPromptBytes?: number;
}

export interface BrainStatuses {
  /** The brain a think sent NOW would run on under `auto`. Absent = none is ready. */
  active?: string;
  brains: BrainStatus[];
}

/** A think placed on a brain — or the one sentence that says why it could not be. */
export type BrainResolution = { ok: true; driver: BrainDriver; brain: Brain } | { ok: false; message: string };

export interface BrainRegistry {
  /** Ask every driver now. A round already in flight is returned rather than doubled. */
  probe(): Promise<void>;
  /** A page asked for another look: at once outside the floor; inside it, OWED — once. */
  recheck(): void;
  statuses(): BrainStatuses;
  /** @param choice `auto` (or nothing), or the id of the one brain the user pinned. */
  resolve(choice: string | undefined): BrainResolution;
  /** Told once per round, when every driver's verdict is in. */
  subscribe(listener: () => void): () => void;
  /** Reap every brain that was made, and owe nothing further. */
  stop(): void;
}

export interface BrainRegistryOptions {
  drivers: readonly BrainDriver[];
  defaultBrain?: string;
  recheckFloorMs?: number;
}

export function createBrainRegistry(options: BrainRegistryOptions): BrainRegistry {
  const drivers = new Map<string, BrainDriver>();
  for (const driver of options.drivers) {
    // The id is the pin and the wire's key: two drivers with one would make both ambiguous.
    if (drivers.has(driver.id)) throw new Error(`two brain drivers are called "${driver.id}"`);
    drivers.set(driver.id, driver);
  }
  const defaultBrain = options.defaultBrain ?? DEFAULT_BRAIN;
  const floorMs = options.recheckFloorMs ?? BRAIN_PROBE_FLOOR_MS;

  const verdicts = new Map<string, BrainReadiness>();
  /** Made on first use, so a brain nobody thinks with never starts a child. */
  const brains = new Map<string, Brain>();
  const listeners = new Set<() => void>();
  let round: Promise<void> | undefined;
  let lastRoundAt = Number.NEGATIVE_INFINITY;
  /** A re-check asked for inside the floor. At most one. */
  let owed: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const readinessOf = (driver: BrainDriver): BrainReadiness => verdicts.get(driver.id) ?? { state: 'unknown', detail: NOT_PROBED_DETAIL };

  const catalogOf = (driver: BrainDriver): BrainCatalog => {
    try {
      return driver.catalog();
    } catch {
      // A driver's catalogue is an internal cache or a CLI's output: it fails soft there,
      // and once more here, because `/status` is how the page learns anything at all.
      return { efforts: [], models: [] };
    }
  };

  /** What `auto` runs on: the default brain, when it is ready AND its posture is proven. */
  const autoDriver = (): BrainDriver | undefined => {
    const driver = drivers.get(defaultBrain);
    return driver !== undefined && driver.verified && readinessOf(driver).state === 'ready' ? driver : undefined;
  };

  const probe = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (round !== undefined) return round;
    lastRoundAt = Date.now();
    const started = Promise.all(
      [...drivers.values()].map(async (driver) => {
        try {
          // Recorded as each lands: a fast driver's verdict is readable while a slow one
          // (a real CLI start) is still being asked.
          verdicts.set(driver.id, await driver.probe());
        } catch {
          // A probe that throws leaves the last verdict standing rather than inventing one.
        }
      }),
    ).then(() => {
      round = undefined;
      if (stopped) return;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          /* a listener's failure is its own; the round has landed */
        }
      }
    });
    round = started;
    return started;
  };

  return {
    probe,

    recheck() {
      // Inside the floor the ask is owed rather than dropped: "a failed think triggers a
      // re-check" has to hold in the seconds after any probe too, which is exactly when a
      // page that just opened meets its first failed think. Asked five times, it is still
      // one round.
      if (stopped || round !== undefined || owed !== undefined) return;
      const wait = lastRoundAt + floorMs - Date.now();
      if (wait <= 0) {
        void probe();
        return;
      }
      owed = setTimeout(() => {
        owed = undefined;
        void probe();
      }, wait);
      owed.unref?.();
    },

    statuses() {
      const active = autoDriver();
      return {
        ...(active !== undefined ? { active: active.id } : {}),
        brains: [...drivers.values()].map((driver) => {
          const { state, detail } = readinessOf(driver);
          const { efforts, models } = catalogOf(driver);
          return {
            id: driver.id,
            name: driver.name,
            via: driver.via,
            state,
            ...(detail !== undefined ? { detail } : {}),
            verified: driver.verified,
            streaming: driver.streaming,
            efforts: [...efforts],
            models: models.map((model) => ({ id: model.id, name: model.name, efforts: [...model.efforts] })),
            ...(driver.maxPromptBytes !== undefined ? { maxPromptBytes: driver.maxPromptBytes } : {}),
          };
        }),
      };
    },

    resolve(choice) {
      if (stopped) return { ok: false, message: 'the runner is stopping' };
      const auto = choice === undefined || choice === 'auto';
      const id = auto ? defaultBrain : choice;
      const driver = drivers.get(id);
      if (driver === undefined) return { ok: false, message: `this runner has no brain called ${JSON.stringify(id)}` };
      const { state, detail } = readinessOf(driver);
      if (state !== 'ready') return { ok: false, message: `${driver.name} is not ready — ${detail ?? state}` };
      // An unverified brain's tool-free posture is unproven on a real login (§2): only an
      // explicit pin may send it a think.
      if (auto && !driver.verified) return { ok: false, message: `${driver.name} is experimental on this machine — it answers only when you choose it` };
      let brain = brains.get(id);
      if (brain === undefined) {
        try {
          brain = driver.create();
        } catch {
          return { ok: false, message: `${driver.name} could not be started` };
        }
        brains.set(id, brain);
      }
      return { ok: true, driver, brain };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    stop() {
      stopped = true;
      if (owed !== undefined) clearTimeout(owed);
      owed = undefined;
      // EVERY SPAWN OWES A REAP (lessons 2026-08-18/19): each brain that was made reaps its
      // own children, warm or busy.
      for (const brain of brains.values()) brain.stop();
      brains.clear();
    },
  };
}

// ---------------------------------------------------------------- the real machine

/** Where the Node running this process lives — what the launcher found, handed on. */
const EXEC_DIR = path.dirname(process.execPath);

/** What a test stands in for. The release entry passes none of it. */
export interface MachineSeams {
  parentEnv?: Record<string, string | undefined>;
  execDir?: string;
  claude?: Partial<Pick<ClaudeDriverDeps, 'resolveBinary' | 'models' | 'spawnBinary'>>;
  codex?: Partial<Pick<CodexDriverDeps, 'resolveBinary' | 'spawn' | 'codexHome'>>;
}

/**
 * THE ONE WHOLE-ENVIRONMENT READ OF THE PROCESS (the release gate counts them, and allows one).
 * The brains below build their children's environment from it, and the browser opener is
 * HANDED it by the release entry (`main.ts`) to build its own child's by allowlist
 * (`opener.ts`, Gate 5 security/F2) — two consumers, one read, so there is still one place to
 * review for "can the parent's environment reach a child?". A reader that needs the
 * environment is handed this, never given a `process.env` of its own.
 */
export const machineEnvironment = (): Readonly<Record<string, string | undefined>> => process.env;

/**
 * The brains of the machine this process runs on: the user's own `claude`, then their own
 * `codex`. Only the release entry calls this without seams.
 *
 * The child environment is built once from `machineEnvironment()`, by allowlist, and the
 * SAME object is handed to every driver — a driver cannot read the parent's environment
 * itself, so a new one cannot leak it by forgetting to filter (ADR-0071 §3). The binary
 * lookup reads HOME and PATH out of the parent object by name: the user's own PATH, not the
 * child's, so adding this process's Node directory for the children did not change where a
 * CLI is looked for.
 *
 * Each driver gets its own neutral directory under the Snug home: a plugin process inherits
 * the agent host's working directory, and a child started there would discover that
 * project's instructions, hooks and MCP servers (ADR-0069 §5).
 */
export function machineDrivers(context: { home: string }, seams: MachineSeams = {}): BrainDriver[] {
  const parent = seams.parentEnv ?? machineEnvironment();
  const env = childEnvFor(parent, seams.execDir ?? EXEC_DIR);
  const lookup = defaultResolveDeps(parent);
  const hostDir = path.join(context.home, 'host');
  return [
    createClaudeDriver({
      env,
      cwd: path.join(hostDir, 'brain'),
      resolveBinary: () => resolveBinary('claude', lookup),
      models: () => readModelCatalog(homedir()),
      ...seams.claude,
    }),
    createCodexDriver({
      env,
      cwd: path.join(hostDir, 'brain-codex'),
      // Snug's OWN Codex home, beside its working directory (the B7 walk, 2026-10-05): Codex
      // reads the global AGENTS.md of whatever home it runs with into every think.
      codexHome: path.join(hostDir, 'codex-home'),
      resolveBinary: () => resolveBinary('codex', lookup),
      ...seams.codex,
    }),
  ];
}
