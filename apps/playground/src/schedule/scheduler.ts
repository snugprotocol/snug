// schedule/scheduler.ts — the scheduler's module store and composition root
// (TASK-20261009-scheduling-framework E1, E4, E5, E7, E8; ADR-0074 §5–§6).
//
// ONE ENGINE PER PAGE, OUTLIVING EVERY VIEW (ADR-0062, the `threadSessions` discipline). The
// pure pieces — `plan`, `protection`, `floors`, `leader`, `tick`, `queue` — are composed HERE
// and nowhere else, over the page-wide user db, and the result is a store any view reads with
// `useScheduler()`. Nothing in this file decides what a run does (`engine-types.ts` is that
// seam) or what the file says (`packages/db`'s accessors are that); it decides when.
//
// BOOT (E1). `initScheduler()` is IDEMPOTENT — the same promise for every call, so
// StrictMode's doubled effect, the boot chain and the re-init chains may all call it — and
// exported as its own act (the `initAppUpdateLaunchCheck` precedent) so the composition-root
// test can spy the wire. It: loads the file's tasks, runs and state, creating `schedulerState`
// with `watermark = now` when there is none (the first open NEVER fabricates a backlog: nothing
// before this instant was ever due here); sweeps `running` claims older than their bound to
// `interrupted` (reason `stale claim` — a tab that died mid-run); elects a leader under
// `snug-scheduler:<file id>`; starts the minute ticker; reconciles once; and resolves when
// that first reconcile is done. Where the host says `allows('schedule') === false` it resolves
// at once and the store stays `ready: false` — no ticker, no election, no row written.
//
// LEADER AND FOLLOWER (E2). Only the LEADER reconciles and runs. A follower keeps its view
// fresh by re-reading the file on the revision signals and on the wake ticks (`visible`,
// `focus`, `online`); the minute tick does nothing for it. A follower promoted when the leader
// tab closes reconciles at once.
//
// RECONCILE (E4). Leader only, SERIALISED — one in flight, one coalesced behind it. It runs
// `plan()` over the file as it is now and applies the actions in order: `pending` and `skip`
// become rows at once, `supersede` marks the older pending row `skipped` (`superseded`; the
// accessor has no delete), `run` goes to the queue (which claims it before anything executes),
// `advance` moves the task's `ranThrough`. The watermark is written LAST, after every candidate
// row — a throw before it leaves the watermark where it was, so the next reconcile finds the
// same misses and the rows already written dedupe them ("a crash between candidate rows loses
// nothing"). One residual, by design: a `run` action's claim is the queue's first write, a
// microtask after the watermark; both land in the same persist window.
//
// THE SWAP SEAMS (E1, lesson 2026-08-20). The engine mirrors rows of the CURRENT user file, so
// it resets wherever the thread sessions reset: this module subscribes to `threadSessions`'
// `registryEpochStore` (bumped by every `resetThreadSessions` call — the file-swap seams in
// `state/userdb.ts` and `state/sync.ts`, and also the app-delete and thread-delete resets,
// which over-approximate: a run in flight then is recorded `interrupted` with reason
// `file swap`) and on each bump stops the ticker and the election, aborts the queue, clears the
// store and drops the init promise. It then RE-INITS once the user db reports `ready` — from a
// microtask, so a seam that resets and swaps in the same synchronous breath (the test helper's
// reset-then-install; a restore's reset-then-open) is seen only after the swap, never bound to
// the file that was just dropped. The two re-init chains (`App.tsx` recover-fresh and
// `restoreUserDbFromBytes`) ALSO call `initScheduler()` explicitly — the pinned wire — and
// find the same promise. A generation counter lets a boot that outlived its engine stand down.
//
// USER ACTS. Every act validates through the protocol's strict schema, stamps `updatedAt`,
// writes through the accessor and bumps `scheduleRevision`. `createTask` compiles the spec,
// applies the frequency floor, derives the catch-up default and the freshness window, and
// records every named app's version — a missing app refuses by name; nothing here sets
// `enabled` but the user's own act (ADR-0074 §4). `noteAppVersion` is the E8 hook: a SHARED or
// AGENT update of a named app pauses every schedule that names it (its callers land in PR-B).
//
// THE LOCK NAME. The election wants `snug-scheduler:<file db uuid>` so two files in one origin
// elect independently: the default `fileId` reads `db.getFileId()` (the file's `db_id` in
// `snug_meta`); the constant `snug-scheduler` is the fallback for a file whose meta row is
// missing (`seedMeta` repairs it on the next open).

import type { UserDb } from '@snugprotocol/db';
import {
  scheduledTaskSchema,
  type AlertKind,
  type MissedPolicy,
  type RunStatus,
  type ScheduleRun,
  type ScheduleSpec,
  type ScheduleStep,
  type ScheduledTask,
  type SchedulerState,
  type TaskProvenance,
} from '@snugprotocol/protocol';

import { registryEpochStore } from '../agent/threadSessions.js';
import { allows, getPlatform, type SnugPlatform } from '../platform/platform.js';
import { bumpScheduleRevision, libraryRevisionStore, scheduleRevisionStore } from '../platform/signals.js';
import { createStore, useStore, type Store } from '../state/store.js';
import { getUserDb, userDbStatusStore } from '../state/userdb.js';
import { globalPaused, hostHonesty } from './copy.js';
import { compileSpec } from './cron.js';
import type { StepExecutor } from './engine-types.js';
import { executeStep } from './executors.js';
import { defaultMissedPolicy, frequencyFloorRefusal, freshnessWindowMs } from './floors.js';
import { createLeaderElection, pageLocks, type LeaderElection, type LeaderLocks, type LeaderState } from './leader.js';
import { plan } from './plan.js';
import { markSeen as markTaskSeen, pauseForAppUpdate, resumeTask } from './protection.js';
import {
  DEFAULT_RUN_BOUNDS,
  createRunQueue,
  laterInstant,
  runBoundMs,
  type RunBounds,
  type RunHost,
  type RunQueue,
  type RunQueueState,
} from './queue.js';
import { createTicker, type Tick, type Ticker } from './tick.js';

// ------------------------------------------------------------------------- types

export type ReconcileTrigger = 'boot' | 'tick' | 'late' | 'visible' | 'focus' | 'online' | 'manual';

/** Builds the ticker over the given handler and clock — the page's timers by default, a fake in tests. */
export type TickerFactory = (onTick: (tick: Tick) => void, now: () => number) => Ticker;

export interface SchedulerDeps {
  db: () => Promise<UserDb>;
  execute: StepExecutor;
  locks: LeaderLocks | undefined;
  ticker: TickerFactory;
  now: () => Date;
  platform: () => SnugPlatform;
  /** `allows('schedule')` — injectable because `getPlatform()` locks on its first read. */
  allows: () => boolean;
  bounds: RunBounds;
  /** The per-file id for the lock name; `undefined` → the fallback name (see the header). */
  fileId: (db: UserDb) => string | undefined;
}

export interface SchedulerView {
  /** The engine is up: elected, ticking, reconciled once. */
  ready: boolean;
  leader: LeaderState | undefined;
  tasks: ScheduledTask[];
  runsByTask: Record<string, ScheduleRun[]>;
  state: SchedulerState | undefined;
  /** Persisted catch-up candidates (`pending` rows) — what the missed card shows. */
  pending: number;
  /** Results nobody opened yet (no `seenAt`). */
  unseen: number;
  running: RunQueueState['running'];
  queued: number;
  lastReconcileAt?: string;
  /** The one sentence about what THIS host can do, for the surfaces where the user decides. */
  honesty?: string;
  /** The last refused read or write, in one line; cleared by the next clean reconcile. */
  lastError?: string;
}

export interface CreateTaskInput {
  title: string;
  steps: ScheduleStep[];
  spec: ScheduleSpec;
  missedPolicy?: MissedPolicy;
  alert?: AlertKind;
  provenance: TaskProvenance;
  ownerAppId?: string;
  startsAt?: string;
  endsAt?: string;
}

export type TaskPatch = Partial<Pick<CreateTaskInput, 'title' | 'steps' | 'spec' | 'missedPolicy' | 'alert' | 'startsAt' | 'endsAt'>>;

export type TaskResult = { ok: true; task: ScheduledTask } | { ok: false; reason: string };
export type ActResult = { ok: true } | { ok: false; reason: string };

/** Who changed an app's version — only `shared` and `agent` updates pause the schedules that name it (E8). */
export type AppVersionSource = 'own' | 'shared' | 'agent';

// ---------------------------------------------------------------------- the store

export const SCHEDULER_LOCK_PREFIX = 'snug-scheduler:';
/** The lock name when the file's own id is not available (see the header). */
export const SCHEDULER_LOCK_NAME_FALLBACK = 'snug-scheduler';

/** The statuses that are a RESULT the user may open — never a candidate, a claim or a skip. */
const RESULT_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['ok', 'failed', 'needs-you', 'interrupted', 'capped', 'no-handler']);

const ZERO_CALLS = { ai: 0, net: 0 } as const;

export function initialSchedulerView(): SchedulerView {
  return { ready: false, leader: undefined, tasks: [], runsByTask: {}, state: undefined, pending: 0, unseen: 0, running: undefined, queued: 0 };
}

export const schedulerStore: Store<SchedulerView> = createStore<SchedulerView>(initialSchedulerView());

export function useScheduler(): SchedulerView {
  return useStore(schedulerStore);
}

// ------------------------------------------------------------------- the helpers

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const refuse = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** The first scheduler row of a file: nothing before `nowIso` was ever due here. */
export function freshSchedulerState(nowIso: string): SchedulerState {
  return { watermark: nowIso, globalPause: false, daily: { date: nowIso.slice(0, 10), ai: 0, net: 0 } };
}

export function lockNameFor(db: UserDb, fileId: SchedulerDeps['fileId']): string {
  const id = fileId(db);
  return id === undefined ? SCHEDULER_LOCK_NAME_FALLBACK : `${SCHEDULER_LOCK_PREFIX}${id}`;
}

function hostInfoOf(platform: SnugPlatform): RunHost {
  return { kind: platform.kind, ...(platform.binding !== undefined ? { binding: platform.binding } : {}) };
}

function notifyOf(platform: SnugPlatform): ((n: { title: string; body: string }) => Promise<'shown' | 'denied' | 'unavailable'>) | undefined {
  const seat = platform.scheduler;
  const notify = seat?.notify;
  if (seat === undefined || notify === undefined) return undefined;
  return (n) => notify.call(seat, n);
}

function honestyOf(platform: SnugPlatform, leader: LeaderState | undefined): string {
  const seat = platform.scheduler;
  return hostHonesty({
    kind: platform.kind,
    ...(seat?.hostLabel !== undefined ? { hostLabel: seat.hostLabel } : {}),
    ...(seat?.wakeMode !== undefined ? { wakeMode: seat.wakeMode } : {}),
    ...(leader !== undefined ? { canSeeSiblingTabs: leader.canSeeSiblings } : {}),
  });
}

/**
 * `running` rows older than their bound become `interrupted` (`stale claim`): the tab that
 * claimed them is gone. A claim still inside its bound may belong to a live sibling tab and is
 * left alone; one without `startedAt` has no bound to be inside of.
 */
export function sweepStaleClaims(db: UserDb, now: Date, bounds: RunBounds = DEFAULT_RUN_BOUNDS): number {
  const nowIso = now.toISOString();
  const tasksById = new Map(db.listScheduledTasks().map((task) => [task.id, task] as const));
  let swept = 0;
  for (const [taskId, runs] of Object.entries(db.listAllScheduleRuns())) {
    for (const run of runs) {
      if (run.status !== 'running') continue;
      const task = tasksById.get(taskId);
      const bound = task === undefined ? bounds.thinkMs : runBoundMs(task.steps, bounds);
      const started = run.startedAt === undefined ? Number.NaN : Date.parse(run.startedAt);
      if (!Number.isNaN(started) && now.getTime() - started <= bound) continue;
      try {
        db.putScheduleRun({ ...run, status: 'interrupted', reason: 'stale claim', finishedAt: nowIso });
        swept += 1;
      } catch {
        // An orphan history (no schedule row) cannot be rewritten; the cascade removes it.
      }
    }
  }
  return swept;
}

function countRows(runsByTask: Record<string, ScheduleRun[]>): { pending: number; unseen: number } {
  let pending = 0;
  let unseen = 0;
  for (const runs of Object.values(runsByTask)) {
    for (const run of runs) {
      if (run.status === 'pending') pending += 1;
      else if (RESULT_STATUSES.has(run.status) && run.seenAt === undefined) unseen += 1;
    }
  }
  return { pending, unseen };
}

const appIdsOf = (steps: readonly ScheduleStep[]): string[] => [...new Set(steps.flatMap((step) => (step.kind === 'notify' ? [] : [step.appId])))];

/** Each named app's current version — or the refusal naming the first app the file does not hold. */
function appVersionsFor(db: UserDb, steps: readonly ScheduleStep[]): { ok: true; versions: ScheduledTask['appVersions'] } | { ok: false; reason: string } {
  const versions: ScheduledTask['appVersions'] = {};
  for (const appId of appIdsOf(steps)) {
    const app = db.getApp(appId);
    if (app === undefined) return refuse(`app "${appId}" is not installed in this file`);
    versions[appId] = app.currentVersion;
  }
  return { ok: true, versions };
}

function commitTask(db: UserDb, draft: ScheduledTask): TaskResult {
  const parsed = scheduledTaskSchema.safeParse(draft);
  if (!parsed.success) {
    return refuse(
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  try {
    db.putScheduledTask(parsed.data);
  } catch (err) {
    return refuse(messageOf(err));
  }
  bumpScheduleRevision();
  return { ok: true, task: parsed.data };
}

const sameOccurrence = (row: ScheduleRun, dueAt: string): boolean => row.dueAt === dueAt || Date.parse(row.dueAt) === Date.parse(dueAt);

// ------------------------------------------------------------------ the engine

interface Engine {
  gen: number;
  db: UserDb;
  queue: RunQueue;
  election: LeaderElection;
  ticker: Ticker;
  stop(): void;
}

let engine: Engine | undefined;
let initPromise: Promise<void> | undefined;
let generation = 0;
let epochUnsubscribe: (() => void) | undefined;
let reinitStop: (() => void) | undefined;

const hasDom = (): boolean => typeof document !== 'undefined' && typeof window !== 'undefined';

/** The page's ticker: the real timers, `visibilitychange` on `document`, `focus`/`online` on `window`. */
export const pageTicker: TickerFactory = (onTick, now) =>
  createTicker({
    now,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    ...(hasDom()
      ? {
          addEventListener: (type, listener) => (type === 'visibilitychange' ? document : window).addEventListener(type, listener),
          removeEventListener: (type, listener) => (type === 'visibilitychange' ? document : window).removeEventListener(type, listener),
          isVisible: () => document.visibilityState === 'visible',
        }
      : {}),
    onTick,
  });

function defaultDeps(): SchedulerDeps {
  return {
    db: getUserDb,
    execute: executeStep,
    locks: pageLocks(),
    ticker: pageTicker,
    now: () => new Date(),
    platform: getPlatform,
    allows: () => allows('schedule'),
    bounds: DEFAULT_RUN_BOUNDS,
    fileId: (db) => db.getFileId(),
  };
}

let currentDeps: SchedulerDeps = defaultDeps();

function patchView(patch: Partial<SchedulerView>): void {
  schedulerStore.set({ ...schedulerStore.get(), ...patch });
}

/** Re-read the file into the view. Synchronous: the engine holds the open handle. */
export function refreshScheduler(): void {
  const eng = engine;
  if (eng === undefined) return;
  const db = eng.db;
  let runsByTask: Record<string, ScheduleRun[]>;
  let tasks: ScheduledTask[];
  let state: SchedulerState | undefined;
  try {
    tasks = db.listScheduledTasks();
    runsByTask = db.listAllScheduleRuns();
    state = db.getSchedulerState();
  } catch (err) {
    patchView({ lastError: messageOf(err) });
    return;
  }
  const leader = eng.election.state.get();
  const { pending, unseen } = countRows(runsByTask);
  const queue = eng.queue.state.get();
  patchView({
    tasks,
    runsByTask,
    state,
    pending,
    unseen,
    leader,
    running: queue.running,
    queued: queue.queued,
    honesty: honestyOf(currentDeps.platform(), leader),
  });
}

function reconcileNow(): void {
  const eng = engine;
  if (eng === undefined) return;
  if (!eng.election.state.get().leader) {
    refreshScheduler();
    return;
  }
  const deps = currentDeps;
  const db = eng.db;
  const now = deps.now();
  const nowIso = now.toISOString();
  let wrote = false;
  let lastError: string | undefined;
  try {
    const tasks = db.listScheduledTasks();
    const runsByTask = db.listAllScheduleRuns();
    const state = db.getSchedulerState() ?? freshSchedulerState(nowIso);
    const { actions, watermark } = plan({ tasks, runsByTask, state, now });
    const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
    const host = hostInfoOf(deps.platform());
    for (const action of actions) {
      const task = tasksById.get(action.taskId);
      if (task === undefined) continue;
      switch (action.kind) {
        case 'pending':
          db.putScheduleRun({
            id: crypto.randomUUID(),
            taskId: task.id,
            dueAt: action.dueAt,
            trigger: 'catch-up',
            collapsedCount: action.collapsedCount,
            status: 'pending',
            host,
            steps: [],
            calls: { ...ZERO_CALLS },
          });
          wrote = true;
          break;
        case 'skip':
          db.putScheduleRun({
            id: crypto.randomUUID(),
            taskId: task.id,
            dueAt: action.dueAt,
            trigger: 'catch-up',
            collapsedCount: action.collapsedCount,
            status: 'skipped',
            finishedAt: nowIso,
            host,
            steps: [],
            calls: { ...ZERO_CALLS },
            reason: action.reason,
          });
          wrote = true;
          break;
        case 'supersede': {
          const older = (runsByTask[task.id] ?? []).find((row) => row.status === 'pending' && sameOccurrence(row, action.dueAt));
          if (older !== undefined) {
            db.putScheduleRun({ ...older, status: 'skipped', reason: 'superseded', finishedAt: nowIso });
            wrote = true;
          }
          break;
        }
        case 'run':
          eng.queue.enqueue({ task, dueAt: action.dueAt, trigger: action.trigger, collapsedCount: action.collapsedCount });
          break;
        case 'advance': {
          const fresh = db.getScheduledTask(task.id);
          if (fresh !== undefined) {
            db.putScheduledTask({ ...fresh, ranThrough: laterInstant(fresh.ranThrough, action.ranThrough), updatedAt: nowIso });
            wrote = true;
          }
          break;
        }
        default: {
          const never: never = action;
          return never;
        }
      }
    }
    // LAST, and only when it moved (a global pause keeps it where it was): every row above landed.
    const latest = db.getSchedulerState() ?? state;
    if (latest.watermark !== watermark) {
      db.setSchedulerState({ ...latest, watermark });
      wrote = true;
    }
  } catch (err) {
    lastError = messageOf(err);
  }
  patchView({ lastReconcileAt: nowIso, ...(lastError !== undefined ? { lastError } : { lastError: undefined }) });
  if (wrote) bumpScheduleRevision(); // the revision listener re-reads the view
  else refreshScheduler();
}

let inFlight: Promise<void> | undefined;
let coalesced: Promise<void> | undefined;

/**
 * Plan and apply what the file says is due (see the header). Leader only — a follower just
 * re-reads. Serialised: a reconcile in flight is never overlapped; a second request while one
 * runs is COALESCED into the one that follows it, whatever its trigger.
 */
export function reconcile(trigger: ReconcileTrigger): Promise<void> {
  if (inFlight === undefined) {
    inFlight = Promise.resolve()
      .then(() => reconcileNow())
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }
  if (coalesced === undefined) {
    coalesced = inFlight.then(() => {
      coalesced = undefined;
      return reconcile(trigger);
    });
  }
  return coalesced;
}

function onTick(tick: Tick): void {
  const eng = engine;
  if (eng === undefined) return;
  if (eng.election.state.get().leader) {
    void reconcile(tick.kind === 'minute' ? 'tick' : tick.kind);
  } else if (tick.kind !== 'minute') {
    refreshScheduler();
  }
}

/** Once the user db says `ready` (now, or when it next does), init again — unless something already has. */
function reinitWhenReady(): void {
  if (initPromise !== undefined || engine !== undefined || reinitStop !== undefined) return;
  const attempt = (): boolean => {
    if (userDbStatusStore.get().state !== 'ready') return false;
    reinitStop?.();
    reinitStop = undefined;
    void initScheduler();
    return true;
  };
  reinitStop = userDbStatusStore.subscribe(() => {
    attempt();
  });
  attempt();
}

function onRegistryEpoch(): void {
  resetScheduler();
  queueMicrotask(reinitWhenReady);
}

async function boot(): Promise<void> {
  const deps = currentDeps;
  if (!deps.allows()) return;
  const gen = ++generation;
  const db = await deps.db();
  if (gen !== generation) return;

  const now = deps.now();
  const nowIso = now.toISOString();
  if (db.getSchedulerState() === undefined) db.setSchedulerState(freshSchedulerState(nowIso));
  sweepStaleClaims(db, now, deps.bounds);

  const queue = createRunQueue({
    db: deps.db,
    execute: deps.execute,
    now: deps.now,
    hostInfo: () => hostInfoOf(deps.platform()),
    notify: () => notifyOf(deps.platform()),
    bounds: deps.bounds,
  });
  const election = createLeaderElection({ name: lockNameFor(db, deps.fileId), locks: deps.locks });
  const ticker = deps.ticker(onTick, () => deps.now().getTime());
  const unsubscribes: Array<() => void> = [];
  const eng: Engine = {
    gen,
    db,
    queue,
    election,
    ticker,
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      unsubscribes.length = 0;
      ticker.stop();
      election.stop();
      queue.abortAll('file swap');
    },
  };
  engine = eng;

  let wasLeader = false;
  unsubscribes.push(
    election.state.subscribe(() => {
      const leader = election.state.get();
      patchView({ leader, honesty: honestyOf(deps.platform(), leader) });
      if (leader.leader && !wasLeader && schedulerStore.get().ready) void reconcile('boot'); // promoted: the leader's first look
      wasLeader = leader.leader;
    }),
    queue.state.subscribe(() => {
      const state = queue.state.get();
      patchView({ running: state.running, queued: state.queued });
    }),
    scheduleRevisionStore.subscribe(() => refreshScheduler()),
    libraryRevisionStore.subscribe(() => refreshScheduler()),
  );
  if (epochUnsubscribe === undefined) epochUnsubscribe = registryEpochStore.subscribe(onRegistryEpoch);

  await election.start();
  if (gen !== generation) return;
  wasLeader = election.state.get().leader;
  ticker.start();
  await reconcile('boot');
  if (gen !== generation) return;
  patchView({ ready: true, leader: election.state.get(), honesty: honestyOf(deps.platform(), election.state.get()) });
}

/**
 * Boot the engine once (see the header). `overrides` are the test seams and are REMEMBERED
 * across the swap-seam re-inits, so a test's fake clock and executor survive a reset.
 */
export function initScheduler(overrides: Partial<SchedulerDeps> = {}): Promise<void> {
  if (initPromise !== undefined) return initPromise;
  currentDeps = { ...currentDeps, ...overrides };
  const started = boot().catch((err: unknown) => {
    patchView({ lastError: messageOf(err) });
    initPromise = undefined; // a failed boot may be tried again
  });
  initPromise = started;
  return started;
}

/**
 * Stop everything and forget the file: ticker, election, the queue (a run in flight is
 * recorded `interrupted`, reason `file swap`; waiting items are dropped unclaimed), the view.
 * The swap seams call this through the registry epoch; the next `initScheduler()` boots afresh.
 */
export function resetScheduler(): void {
  generation += 1;
  const eng = engine;
  engine = undefined;
  initPromise = undefined;
  eng?.stop();
  schedulerStore.set(initialSchedulerView());
}

/** Test seam: a full teardown — the epoch subscription and any pending re-init go too, and the deps return to the page's. */
export function __resetSchedulerForTests(): void {
  resetScheduler();
  epochUnsubscribe?.();
  epochUnsubscribe = undefined;
  reinitStop?.();
  reinitStop = undefined;
  inFlight = undefined;
  coalesced = undefined;
  currentDeps = defaultDeps();
}

// ---------------------------------------------------------------- user acts

export async function createTask(input: CreateTaskInput): Promise<TaskResult> {
  const db = await currentDeps.db();
  const now = currentDeps.now();
  const nowIso = now.toISOString();
  const cron = compileSpec(input.spec, now);
  if (cron === undefined) return refuse('this schedule cannot be compiled — check the when');
  const floor = frequencyFloorRefusal(input.spec, input.provenance, now);
  if (floor !== undefined) return refuse(floor);
  const versions = appVersionsFor(db, input.steps);
  if (!versions.ok) return versions;
  const draft: ScheduledTask = {
    id: crypto.randomUUID(),
    title: input.title,
    enabled: true,
    enabledAt: nowIso,
    provenance: input.provenance,
    ...(input.ownerAppId !== undefined ? { ownerAppId: input.ownerAppId } : {}),
    steps: input.steps,
    spec: input.spec,
    cron,
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    missedPolicy: input.missedPolicy ?? defaultMissedPolicy(input.steps),
    staleAfterMs: freshnessWindowMs(input.spec, now),
    alert: input.alert ?? 'inbox',
    appVersions: versions.versions,
    createdAt: nowIso,
    updatedAt: nowIso,
    consecutiveFailures: 0,
    unseenResults: 0,
  };
  return commitTask(db, draft);
}

export async function updateTask(taskId: string, patch: TaskPatch): Promise<TaskResult> {
  const db = await currentDeps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const now = currentDeps.now();
  const nowIso = now.toISOString();
  let { cron, staleAfterMs, appVersions } = task;
  const spec = patch.spec ?? task.spec;
  const steps = patch.steps ?? task.steps;
  if (patch.spec !== undefined) {
    const compiled = compileSpec(spec, now);
    if (compiled === undefined) return refuse('this schedule cannot be compiled — check the when');
    const floor = frequencyFloorRefusal(spec, task.provenance, now);
    if (floor !== undefined) return refuse(floor);
    cron = compiled;
    staleAfterMs = freshnessWindowMs(spec, now);
  }
  if (patch.steps !== undefined) {
    const versions = appVersionsFor(db, steps);
    if (!versions.ok) return versions;
    appVersions = versions.versions;
  }
  const next: ScheduledTask = {
    ...task,
    title: patch.title ?? task.title,
    steps,
    spec,
    cron,
    staleAfterMs,
    appVersions,
    missedPolicy: patch.missedPolicy ?? task.missedPolicy,
    alert: patch.alert ?? task.alert,
    ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
    ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
    updatedAt: nowIso,
  };
  return commitTask(db, next);
}

/** Enable = the user's *Resume* or *on* (`resumeTask`: pause cleared, window from now, fresh app versions); disable = off, pause reason cleared. */
export async function setTaskEnabled(taskId: string, enabled: boolean): Promise<TaskResult> {
  const db = await currentDeps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const nowIso = currentDeps.now().toISOString();
  let next: ScheduledTask;
  if (enabled) {
    const versions = appVersionsFor(db, task.steps);
    if (!versions.ok) return versions;
    next = resumeTask(task, nowIso, versions.versions);
  } else {
    next = { ...task, enabled: false };
    delete next.pausedReason;
  }
  return commitTask(db, { ...next, updatedAt: nowIso });
}

export async function deleteTask(taskId: string): Promise<void> {
  const db = await currentDeps.db();
  if (engine?.queue.state.get().running?.taskId === taskId) engine.queue.cancelCurrent();
  db.deleteScheduledTask(taskId);
  bumpScheduleRevision();
}

function enqueueOrRefuse(db: UserDb, task: ScheduledTask, dueAt: string, trigger: 'manual' | 'catch-up', collapsedCount: number): ActResult {
  const eng = engine;
  if (eng === undefined) return refuse('scheduling is not running here');
  if (db.getSchedulerState()?.globalPause === true) return refuse(globalPaused);
  eng.queue.enqueue({ task, dueAt, trigger, collapsedCount });
  return { ok: true };
}

/** The user's *run now*: one manual run, due this instant. Held by the global pause like every other. */
export async function runNow(taskId: string): Promise<ActResult> {
  const db = await currentDeps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  return enqueueOrRefuse(db, task, currentDeps.now().toISOString(), 'manual', 1);
}

function pendingRow(db: UserDb, taskId: string, dueAt: string): ScheduleRun | undefined {
  return db.listScheduleRuns(taskId).find((row) => row.status === 'pending' && sameOccurrence(row, dueAt));
}

/** The missed card's *run*: the pending candidate goes to the queue, which replaces the row with its claim. */
export async function runPending(taskId: string, dueAt: string): Promise<ActResult> {
  const db = await currentDeps.db();
  const task = db.getScheduledTask(taskId);
  if (task === undefined) return refuse('no such schedule');
  const row = pendingRow(db, taskId, dueAt);
  if (row === undefined) return refuse('nothing is waiting for that time');
  return enqueueOrRefuse(db, task, row.dueAt, 'catch-up', row.collapsedCount);
}

/** The missed card's *skip*: the candidate is recorded `skipped` (reason `user`) — permanent, like any other skip. */
export async function skipPending(taskId: string, dueAt: string): Promise<ActResult> {
  const db = await currentDeps.db();
  const row = pendingRow(db, taskId, dueAt);
  if (row === undefined) return refuse('nothing is waiting for that time');
  db.putScheduleRun({ ...row, status: 'skipped', reason: 'user', finishedAt: currentDeps.now().toISOString() });
  bumpScheduleRevision();
  return { ok: true };
}

export async function runAllPending(): Promise<number> {
  const db = await currentDeps.db();
  let queued = 0;
  for (const task of db.listScheduledTasks()) {
    for (const row of db.listScheduleRuns(task.id)) {
      if (row.status !== 'pending') continue;
      if (enqueueOrRefuse(db, task, row.dueAt, 'catch-up', row.collapsedCount).ok) queued += 1;
    }
  }
  return queued;
}

export async function skipAllPending(): Promise<number> {
  const db = await currentDeps.db();
  const finishedAt = currentDeps.now().toISOString();
  let skipped = 0;
  for (const [taskId, runs] of Object.entries(db.listAllScheduleRuns())) {
    if (db.getScheduledTask(taskId) === undefined) continue;
    for (const row of runs) {
      if (row.status !== 'pending') continue;
      db.putScheduleRun({ ...row, status: 'skipped', reason: 'user', finishedAt });
      skipped += 1;
    }
  }
  if (skipped > 0) bumpScheduleRevision();
  return skipped;
}

/** A user GESTURE on one result (E7): stamps `seenAt` and takes one off the task's unseen count. Never app-derived. */
export async function markSeen(taskId: string, dueAt: string): Promise<void> {
  const db = await currentDeps.db();
  const row = db.listScheduleRuns(taskId).find((entry) => sameOccurrence(entry, dueAt));
  if (row === undefined || row.seenAt !== undefined) return;
  const nowIso = currentDeps.now().toISOString();
  db.markScheduleRunSeen(taskId, row.dueAt, nowIso);
  const task = db.getScheduledTask(taskId);
  if (task !== undefined) db.putScheduledTask({ ...markTaskSeen(task), updatedAt: nowIso });
  bumpScheduleRevision();
}

/** *Mark all read*: every unseen result, every schedule — one gesture. */
export async function markAllSeen(): Promise<number> {
  const db = await currentDeps.db();
  const nowIso = currentDeps.now().toISOString();
  let marked = 0;
  for (const task of db.listScheduledTasks()) {
    let seen = 0;
    for (const row of db.listScheduleRuns(task.id)) {
      if (!RESULT_STATUSES.has(row.status) || row.seenAt !== undefined) continue;
      db.markScheduleRunSeen(task.id, row.dueAt, nowIso);
      seen += 1;
    }
    if (seen > 0) {
      db.putScheduledTask({ ...markTaskSeen(task, seen), updatedAt: nowIso });
      marked += seen;
    }
  }
  if (marked > 0) bumpScheduleRevision();
  return marked;
}

/** Settings' *Clear history* (one schedule, or all): the accessor keeps what is not yet dealt with. */
export async function clearHistory(taskId?: string): Promise<void> {
  const db = await currentDeps.db();
  db.clearScheduleHistory(taskId);
  bumpScheduleRevision();
}

/**
 * The global pause (E7). On: nothing is planned (the planner holds the watermark, so held
 * occurrences come back `late`, then missed like any other), waiting items are dropped
 * unclaimed and a run in flight is recorded `interrupted` (reason `paused`). Off: reconcile now.
 */
export async function setGlobalPause(on: boolean): Promise<void> {
  const db = await currentDeps.db();
  const state = db.getSchedulerState() ?? freshSchedulerState(currentDeps.now().toISOString());
  db.setSchedulerState({ ...state, globalPause: on });
  if (on) engine?.queue.abortAll('paused');
  bumpScheduleRevision();
  if (!on) await reconcile('manual');
}

/** The running chip's *cancel*: the run in flight is recorded `interrupted` (reason `cancelled`). */
export function cancelRunning(): void {
  engine?.queue.cancelCurrent();
}

/**
 * The E8 hook. An app's version changed: for a SHARED or AGENT update, every schedule naming
 * the app at another version is paused `app-updated` (its recorded versions kept, so the
 * resume card can name the change); the user's OWN edits change nothing. Answers how many
 * schedules were paused. Its callers land in PR-B.
 */
export async function noteAppVersion(appId: string, version: number, source: AppVersionSource): Promise<number> {
  if (source === 'own') return 0;
  const db = await currentDeps.db();
  const nowIso = currentDeps.now().toISOString();
  let paused = 0;
  for (const task of db.listScheduledTasks()) {
    const next = pauseForAppUpdate(task, appId, version);
    if (next === task) continue;
    db.putScheduledTask({ ...next, updatedAt: nowIso });
    paused += 1;
  }
  if (paused > 0) bumpScheduleRevision();
  return paused;
}
