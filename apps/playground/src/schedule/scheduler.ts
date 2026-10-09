// schedule/scheduler.ts — the scheduler's module store and composition root
// (TASK-20261009-scheduling-framework E1, E4, E5, E7, E8; ADR-0074 §5–§6).
//
// ONE ENGINE PER PAGE, OUTLIVING EVERY VIEW (ADR-0062, the `threadSessions` discipline). The
// pure pieces — `plan`, `protection`, `floors`, `leader`, `tick`, `queue` — are composed HERE
// and nowhere else, over the page-wide user db, and the result is a store any view reads with
// `useScheduler()`. Nothing in this file decides what a run does (`engine-types.ts` is that
// seam) or what the file says (`packages/db`'s accessors are that); it decides when. The user's
// ACTS live in `acts.ts` (Gate-5 M14) and are re-exported from here, so every importer keeps
// its one import; they reach the engine through two accessors, `currentDeps()` and `engine()`.
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
// at once and the store stays `ready: false` — no ticker, no election, no row written. The
// same sweep runs again on every `late` and `visible` reconcile (Gate-5 S5): a sibling tab
// that died mid-run leaves its claim behind while this one keeps ticking.
//
// LEADER AND FOLLOWER (E2). Only the LEADER reconciles and runs. A follower keeps its view
// fresh by re-reading the file on the revision signals and on the wake ticks (`visible`,
// `focus`, `online`); the minute tick does nothing for it.
//
// PROMOTION ASKS FOR A RELOAD (Gate-5 S3, PR-A). A follower promoted when the leader tab
// closes holds the sql.js handle it opened at BOOT — stale after every row the leader wrote
// since — so planning over it would re-run recorded occurrences and persist the stale copy
// over the leader's. So a promotion does NOT reconcile: it sets `needsReload` on the view and
// the engine stays idle (the ticker runs, `reconcile` is refused, the view still reads) until
// the page reloads — the strip the view renders says so. The residual, queued for its own
// task: the proper fix is a writer lock on the file plus a re-open seam so a promoted tab can
// swap in the leader's bytes without a reload.
//
// RECONCILE (E4). Leader only, SERIALISED — one in flight, one coalesced behind it. It runs
// `plan()` over the file as it is now and applies the actions in order: `pending` and `skip`
// become rows at once, `supersede` marks the older pending row `skipped` (`superseded`; the
// accessor has no delete), `run` goes to the queue (which claims it before anything executes),
// `advance` moves the task's `ranThrough` — bookkeeping, never an `updatedAt` stamp (Gate-5
// M16: a backup compares by intent, and a run must not change it). The watermark is written
// LAST, after every candidate row — a throw before it leaves the watermark where it was, so the
// next reconcile finds the same misses and the rows already written dedupe them ("a crash
// between candidate rows loses nothing"). One residual, by design: a `run` action's claim is
// the queue's first write, a microtask after the watermark; both land in the same persist
// window. THE ROWS IT PLANS OVER (Gate-5 M3): the ones the last `refreshScheduler()` read,
// when nothing has been written since — every writer bumps `scheduleRevision` (or
// `libraryRevision`) and the refresh runs on the bump, so an unchanged revision means an
// unchanged file; otherwise it reads afresh. With the accessor's own memo under it, a minute
// tick over an idle file parses nothing.
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
// THE LOCK NAME. The election wants `snug-scheduler:<file db uuid>` so two files in one origin
// elect independently: the default `fileId` reads `db.getFileId()` (the file's `db_id` in
// `snug_meta`); the constant `snug-scheduler` is the fallback for a file whose meta row is
// missing (`seedMeta` repairs it on the next open).
//
// THE MODULE CYCLE (Gate-5 M20, verified benign). `state/userdb.ts → scheduler → executors →
// appThink → state/mode → state/userdb` is a cycle, and `scheduler ↔ acts` another. Every
// cross edge is reached through a hoisted function (`initScheduler`, `getUserDb`,
// `defaultTransportFor`, `executeStep` is read inside `defaultDeps()`, the acts read
// `currentDeps()`/`engine()`), and NOTHING here dereferences an imported const at module
// evaluation: the deps are built lazily on first use (`currentDeps()`), never at load. Whichever
// module the bundle enters the cycle by, the bindings are live by the time they are read.

import type { UserDb } from '@snugprotocol/db';
import type { ScheduleRun, ScheduledTask, SchedulerState } from '@snugprotocol/protocol';

import { registryEpochStore } from '../agent/threadSessions.js';
import { allows, getPlatform, type SnugPlatform } from '../platform/platform.js';
import { bumpScheduleRevision, libraryRevisionStore, scheduleRevisionStore } from '../platform/signals.js';
import { createStore, useStore, type Store } from '../state/store.js';
import { getUserDb, userDbStatusStore } from '../state/userdb.js';
import { hostHonesty } from './copy.js';
import { honestyInputFor } from './honesty.js';
import type { StepExecutor } from './engine-types.js';
import { executeStep } from './executors.js';
import { createLeaderElection, pageLocks, type LeaderElection, type LeaderLocks, type LeaderState } from './leader.js';
import { plan } from './plan.js';
import { DEFAULT_RUN_BOUNDS, createRunQueue, laterInstant, runBoundMs, type RunBounds, type RunHost, type RunQueue, type RunQueueState } from './queue.js';
import { RESULT_STATUSES, messageOf, sameOccurrence } from './taskShape.js';
import { createTicker, type Tick, type Ticker } from './tick.js';

// The user's acts (acts.ts) — re-exported so every importer keeps its one import.
export {
  IMPORTED_NEEDS_REVIEW,
  cancelRunning,
  clearHistory,
  createTask,
  deleteTask,
  markAllSeen,
  markSeen,
  noteAppVersion,
  runAllPending,
  runNow,
  runPending,
  scheduleOff,
  setGlobalPause,
  setTaskEnabled,
  skipAllPending,
  skipPending,
  updateTask,
} from './acts.js';
export type { ActResult, AppVersionSource, CreateTaskInput, EnableOptions, TaskPatch, TaskRefusal, TaskResult } from './acts.js';

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
  /** Promoted over a boot-time copy of the file (S3): the engine stays idle until the page reloads. */
  needsReload: boolean;
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
  /** The last refused read, write or claim, in one line; cleared by the next clean reconcile. */
  lastError?: string;
}

// ---------------------------------------------------------------------- the store

export const SCHEDULER_LOCK_PREFIX = 'snug-scheduler:';
/** The lock name when the file's own id is not available (see the header). */
export const SCHEDULER_LOCK_NAME_FALLBACK = 'snug-scheduler';

const ZERO_CALLS = { ai: 0, net: 0 } as const;

export function initialSchedulerView(): SchedulerView {
  return { ready: false, leader: undefined, needsReload: false, tasks: [], runsByTask: {}, state: undefined, pending: 0, unseen: 0, running: undefined, queued: 0 };
}

export const schedulerStore: Store<SchedulerView> = createStore<SchedulerView>(initialSchedulerView());

export function useScheduler(): SchedulerView {
  return useStore(schedulerStore);
}

// ------------------------------------------------------------------- the helpers

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
  // ONE derivation with the Settings card and the editor footer (`honesty.ts`): the seat, the
  // storage rung (a memory bucket says so) and whether sibling tabs can be seen.
  return hostHonesty(honestyInputFor(platform, leader !== undefined ? { canSeeSiblings: leader.canSeeSiblings } : undefined));
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

// ------------------------------------------------------------------ the engine

export interface Engine {
  gen: number;
  db: UserDb;
  queue: RunQueue;
  election: LeaderElection;
  ticker: Ticker;
  stop(): void;
}

let current: Engine | undefined;
let initPromise: Promise<void> | undefined;
let generation = 0;
let epochUnsubscribe: (() => void) | undefined;
let reinitStop: (() => void) | undefined;

/** The live engine, or `undefined` before boot and after a reset — the acts' seam to the queue. */
export function engine(): Engine | undefined {
  return current;
}

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

let deps: SchedulerDeps | undefined;

/** The engine's dependencies — the page's by default, built on FIRST USE (never at load: M20), with any test overrides remembered. */
export function currentDeps(): SchedulerDeps {
  deps ??= defaultDeps();
  return deps;
}

function patchView(patch: Partial<SchedulerView>): void {
  schedulerStore.set({ ...schedulerStore.get(), ...patch });
}

/** The rows the last refresh read, with the revisions they were read at — reused by a reconcile when nothing was written since (M3). */
interface RowsSnapshot {
  gen: number;
  scheduleRevision: number;
  libraryRevision: number;
  tasks: ScheduledTask[];
  runsByTask: Record<string, ScheduleRun[]>;
  state: SchedulerState | undefined;
}

/** What one read of the file answers — the snapshot without its revision stamps. */
type Rows = Omit<RowsSnapshot, 'gen' | 'scheduleRevision' | 'libraryRevision'>;

let snapshot: RowsSnapshot | undefined;

function readRows(db: UserDb): Rows {
  return { tasks: db.listScheduledTasks(), runsByTask: db.listAllScheduleRuns(), state: db.getSchedulerState() };
}

function snapshotUsable(eng: Engine): boolean {
  return (
    snapshot !== undefined &&
    snapshot.gen === eng.gen &&
    snapshot.scheduleRevision === scheduleRevisionStore.get() &&
    snapshot.libraryRevision === libraryRevisionStore.get()
  );
}

/** Rows just read from the file become the view and the snapshot a later reconcile may reuse. */
function publishRows(eng: Engine, rows: Rows): void {
  snapshot = { gen: eng.gen, scheduleRevision: scheduleRevisionStore.get(), libraryRevision: libraryRevisionStore.get(), ...rows };
  const leader = eng.election.state.get();
  const { pending, unseen } = countRows(rows.runsByTask);
  const queue = eng.queue.state.get();
  patchView({
    tasks: rows.tasks,
    runsByTask: rows.runsByTask,
    state: rows.state,
    pending,
    unseen,
    leader,
    running: queue.running,
    queued: queue.queued,
    honesty: honestyOf(currentDeps().platform(), leader),
  });
}

/** Re-read the file into the view. Synchronous: the engine holds the open handle. */
export function refreshScheduler(): void {
  const eng = current;
  if (eng === undefined) return;
  let rows: Rows;
  try {
    rows = readRows(eng.db);
  } catch (err) {
    patchView({ lastError: messageOf(err) });
    return;
  }
  publishRows(eng, rows);
}

function reconcileNow(trigger: ReconcileTrigger): void {
  const eng = current;
  if (eng === undefined) return;
  if (!eng.election.state.get().leader || schedulerStore.get().needsReload) {
    refreshScheduler(); // a follower — or a promoted tab over its stale handle (S3) — only reads
    return;
  }
  const d = currentDeps();
  const db = eng.db;
  const now = d.now();
  const nowIso = now.toISOString();
  let wrote = false; // a task or run row changed: every view re-reads
  let movedTo: SchedulerState | undefined; // only the watermark moved: the view takes it in place
  let lastError: string | undefined;
  let freshlyRead: Rows | undefined;
  try {
    // A wake after a gap: a sibling tab may have died mid-run since boot (S5).
    if ((trigger === 'late' || trigger === 'visible') && sweepStaleClaims(db, now, d.bounds) > 0) wrote = true;
    const rows = !wrote && snapshotUsable(eng) ? (snapshot as RowsSnapshot) : (freshlyRead = readRows(db));
    const state = rows.state ?? freshSchedulerState(nowIso);
    const { actions, watermark } = plan({ tasks: rows.tasks, runsByTask: rows.runsByTask, state, now });
    const tasksById = new Map(rows.tasks.map((task) => [task.id, task] as const));
    const host = hostInfoOf(d.platform());
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
          const older = (rows.runsByTask[task.id] ?? []).find((row) => row.status === 'pending' && sameOccurrence(row, action.dueAt));
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
            db.putScheduledTask({ ...fresh, ranThrough: laterInstant(fresh.ranThrough, action.ranThrough) }); // bookkeeping, never `updatedAt` (M16)
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
      movedTo = { ...latest, watermark };
      db.setSchedulerState(movedTo);
    }
  } catch (err) {
    lastError = messageOf(err);
  }
  patchView({ lastReconcileAt: nowIso, ...(lastError !== undefined ? { lastError } : { lastError: undefined }) });
  if (wrote) {
    bumpScheduleRevision(); // the revision listener re-reads the view
  } else if (freshlyRead !== undefined) {
    publishRows(eng, { ...freshlyRead, state: movedTo ?? freshlyRead.state }); // read once: the view takes what the plan saw
  } else if (movedTo !== undefined) {
    // The plan ran over the view's own rows and only the watermark moved: no row to re-read (M3).
    if (snapshot !== undefined) snapshot = { ...snapshot, state: movedTo };
    patchView({ state: movedTo });
  }
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
      .then(() => reconcileNow(trigger))
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
  const eng = current;
  if (eng === undefined) return;
  if (eng.election.state.get().leader) {
    void reconcile(tick.kind === 'minute' ? 'tick' : tick.kind);
  } else if (tick.kind !== 'minute') {
    refreshScheduler();
  }
}

/** Once the user db says `ready` (now, or when it next does), init again — unless something already has. */
function reinitWhenReady(): void {
  if (initPromise !== undefined || current !== undefined || reinitStop !== undefined) return;
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
  const d = currentDeps();
  if (!d.allows()) return;
  const gen = ++generation;
  const db = await d.db();
  if (gen !== generation) return;

  const now = d.now();
  const nowIso = now.toISOString();
  if (db.getSchedulerState() === undefined) db.setSchedulerState(freshSchedulerState(nowIso));
  sweepStaleClaims(db, now, d.bounds);

  const queue = createRunQueue({
    db: d.db,
    execute: d.execute,
    now: d.now,
    hostInfo: () => hostInfoOf(d.platform()),
    notify: () => notifyOf(d.platform()),
    bounds: d.bounds,
  });
  const election = createLeaderElection({ name: lockNameFor(db, d.fileId), locks: d.locks });
  const ticker = d.ticker(onTick, () => d.now().getTime());
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
  current = eng;

  let wasLeader = false;
  unsubscribes.push(
    election.state.subscribe(() => {
      const leader = election.state.get();
      patchView({ leader, honesty: honestyOf(d.platform(), leader) });
      // Promoted after boot: this tab's handle is a stale copy (S3) — ask for a reload, plan nothing.
      if (leader.leader && !wasLeader && schedulerStore.get().ready) patchView({ needsReload: true });
      wasLeader = leader.leader;
    }),
    queue.state.subscribe(() => {
      const state = queue.state.get();
      patchView({ running: state.running, queued: state.queued, ...(state.lastError !== undefined ? { lastError: state.lastError } : {}) });
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
  patchView({ ready: true, leader: election.state.get(), honesty: honestyOf(d.platform(), election.state.get()) });
}

/**
 * Boot the engine once (see the header). `overrides` are the test seams and are REMEMBERED
 * across the swap-seam re-inits, so a test's fake clock and executor survive a reset.
 */
export function initScheduler(overrides: Partial<SchedulerDeps> = {}): Promise<void> {
  if (initPromise !== undefined) return initPromise;
  deps = { ...currentDeps(), ...overrides };
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
  const eng = current;
  current = undefined;
  initPromise = undefined;
  snapshot = undefined;
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
  deps = undefined;
}
