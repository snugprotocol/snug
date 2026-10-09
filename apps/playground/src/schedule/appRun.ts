// schedule/appRun.ts — the *Run [app]* executor and the kv handshake
// (TASK-20261009-scheduling-framework A2, A3, A5; ADR-0074 §3, §5, §6; security F5, F8, F16).
//
// THE SHAPE OF A RUN. The host writes the step's input into the app's OWN kv under
// `snug:schedule:<runId>` (≤ 1 KiB — the task schema's cap, enforced again by the driver's
// host-side seat), rings the EXISTING `host-event` channel with a hint that carries ids and
// nothing else (`schedule-run { taskId, runId }` — R7: hints, never content), and reads the
// app's `app-event 'schedule-result'`. No new frame, no `host-ready` flag, no new error code.
// The key is cleared on EVERY exit path, and the boot sweep clears the key of any claim a dead
// tab left behind (`clearScheduleKey`, called from `scheduler.ts`'s stale-claim sweep).
//
// WHERE THE APP RUNS. If the app is on screen (`hasLiveAppHost`), the run is delivered to the
// LIVE frame — the hint rides the registry's notify, the result comes back through the
// app-events the view forwards (`publishAppEvent`) — and the run spends on the live frame's own
// transport and gate (the user is at the app; its calls are not this executor's to count). Else
// ONE hidden `SnugAppFrame` is mounted through `hiddenMountStore` (`ScheduledRunHost.tsx`
// renders it) with the runtime `run/appRuntime.ts` composes for RunView, and two differences:
// the confirm gate and the counting transport (below). The hidden frame runs the app's
// COMMITTED CURRENT version (`getAppHtml` — the read RunView makes for an owned app).
//
// THE RESULT IS BOUND, ONCE, CAPPED (F8). A result is accepted only from the frame that
// received the hint (the mount's own closure — a visible app's events never reach it), only
// after the hint was posted, only once, only for this `runId` when the result names one; its
// serialised length is capped BEFORE the strict parse (`scheduleResultSchema`). Anything else is
// dropped without a word: an unsolicited, duplicate, forged or oversized result is the one
// thing an app can send that the host must not act on.
//
// THE GATE FOLLOWS THE TRIGGER (A5, §6). A `manual` run has the user present: the ordinary gate
// (RunView's — the confirm dialog is app-level). Every other trigger gets the STANDALONE
// refusing gate (`scheduledConfirmGate.ts`): a mutating call is refused with the existing
// `NET_CONFIRM_DENIED`, the gate RECORDS it, and the step is `refused` with the sentence
// `copy.needsYou` composes from the record — whatever the app then reports. The run folds to
// `needs-you` with *run now and review* as its one act.
//
// WHAT IS COUNTED (A4, A5). The hidden frame's transport is wrapped by `scheduledTransport.ts`
// (every send asked of the day's AI ceiling, one call each, the reply scrubbed); its net
// handler's `onNetCall` seam asks the day's network ceiling before every request. Both read
// the counters in the file PLUS what this run already spent (`ctx.spent`), so a run cannot
// slip past the ceiling by spending inside one step. The counts ride the outcome's `calls`.
//
// A VISIBLE OPEN ABORTS THE HIDDEN RUN (F5). While the hidden frame runs, a RunView mounting
// the same app (`subscribeAppHosts`) asks the queue to interrupt this run (`ctx.interrupt`,
// reason `app opened`); the frame unmounts, the key is cleared, the run is recorded as such.
//
// REFUSED WITHOUT A SEAT. A platform that composes no `scheduler` seat (every shipped host
// composes one — web, desktop, both kit bindings) gets no hidden frame: the step is `blocked`
// by name. No read of the platform's `kind` (the S4 lint).

import { z } from 'zod';

import type { NetConfirmGate } from '@snugprotocol/auth';
import type { AppRecord, SnugDbDriver, UserDb } from '@snugprotocol/db';
import { SCHEDULE_NOTIFY_BODY_MAX_CHARS, SCHEDULE_STEP_SUMMARY_MAX_CHARS, SCHEDULE_TITLE_MAX_CHARS, type ScheduleRun, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';
import type { AgentTransport, RunnerHost } from '@snugprotocol/runner';

import { getPlatform, type SnugPlatform } from '../platform/platform.js';
import { composeAppRuntime, type FrameCapabilityProps } from '../run/appRuntime.js';
import { hasLiveAppHost, notifyAppHost, subscribeAppEvents, subscribeAppHosts } from '../state/appHosts.js';
import { modeStore, providerStore } from '../state/mode.js';
import { createStore, type Store } from '../state/store.js';
import { CANCELLED_SUMMARY } from './appThink.js';
import { appMissing, blockedHere, needsYou, noHandler } from './copy.js';
import type { StepContext, StepOutcome } from './engine-types.js';
import { dailyCounters, wouldExceedCeiling } from './protection.js';
import { createScheduledConfirmGate, scheduledRefusalVerb, type ScheduledConfirmGate } from './scheduledConfirmGate.js';
import { createScheduledTransport, type ScheduledTransport } from './scheduledTransport.js';
import { appIdsOf } from './taskShape.js';

export type AppRunStep = Extract<ScheduleStep, { kind: 'app-run' }>;

/** The host-event that tells the app a scheduled run is waiting in its kv. Ids only. */
export const SCHEDULE_RUN_EVENT = 'schedule-run';
/** The app-event the app answers with. */
export const SCHEDULE_RESULT_EVENT = 'schedule-result';
/** The kv key family the handshake rides; one key per run. */
export const SCHEDULE_KV_KEY_PREFIX = 'snug:schedule:';
export const scheduleKvKey = (runId: string): string => `${SCHEDULE_KV_KEY_PREFIX}${runId}`;

/** No announce within this → `no-handler` (the app never even booted its bridge). */
export const SCHEDULE_ANNOUNCE_TIMEOUT_MS = 10_000;
/** No result within this → `failed`; under the queue's 120 s run bound so the step can say so itself. */
export const SCHEDULE_RESULT_TIMEOUT_MS = 90_000;
/** The serialised length a result may have BEFORE it is parsed at all. */
export const SCHEDULE_RESULT_MAX_CHARS = 8 * 1024;

/** The reason when a composition carries no hidden-frame seams, or the platform no scheduler seat. */
export const NO_HIDDEN_FRAME = 'this host cannot run an app on a schedule';

/**
 * What the app may answer. `runId`/`taskId` are optional echoes (a result that names another
 * run is dropped); `summary` is what the person reads; `notify` is a SUGGESTION the queue
 * honours only when the task's `alert` allows (§6). Strict: an unknown field is a drop.
 */
export const scheduleResultSchema = z.strictObject({
  runId: z.string().min(1).max(64).optional(),
  taskId: z.string().min(1).max(64).optional(),
  ok: z.boolean(),
  summary: z.string().max(SCHEDULE_STEP_SUMMARY_MAX_CHARS).optional(),
  notify: z
    .strictObject({
      title: z.string().min(1).max(SCHEDULE_TITLE_MAX_CHARS),
      body: z.string().min(1).max(SCHEDULE_NOTIFY_BODY_MAX_CHARS),
    })
    .optional(),
});
export type ScheduleResult = z.infer<typeof scheduleResultSchema>;

/** Length-capped BEFORE the strict parse; bound to `runId` when the result names one. `undefined` = drop. */
export function parseScheduleResult(data: unknown, runId: string): ScheduleResult | undefined {
  let serialised: string | undefined;
  try {
    serialised = JSON.stringify(data);
  } catch {
    return undefined;
  }
  if (serialised === undefined || serialised.length > SCHEDULE_RESULT_MAX_CHARS) return undefined;
  const parsed = scheduleResultSchema.safeParse(data);
  if (!parsed.success) return undefined;
  if (parsed.data.runId !== undefined && parsed.data.runId !== runId) return undefined;
  return parsed.data;
}

// ---------------------------------------------------------------------- the mount

/** What `ScheduledRunHost.tsx` renders: the frame's identity, its bindings, and the executor's ears. */
export interface HiddenMount {
  appId: string;
  runId: string;
  /** The app's committed current html. */
  html: string;
  transport: AgentTransport;
  frameProps: FrameCapabilityProps;
  /** The frame lends its controls here; the executor rings `notifyEvent` through it. */
  controls: { current: RunnerHost | null };
  onAnnounce(): void;
  onAppEvent(event: string, data: unknown): void;
  onNavigatedAway(): void;
  onBudgetExhausted(): void;
}

/** ONE hidden mount at a time (the queue runs one step at a time). The host component renders it. */
export const hiddenMountStore: Store<HiddenMount | undefined> = createStore<HiddenMount | undefined>(undefined);

// ----------------------------------------------------------------------- the deps

/** The live-host registry as the executor sees it (`state/appHosts.ts` in production). */
export interface LiveAppHosts {
  has(appId: string): boolean;
  notify(appId: string, event: string, data: unknown): boolean;
  /** Fires on every registration (`live: true`) and retraction. */
  subscribe(listener: (appId: string, live: boolean) => void): () => void;
  /** The app-events the live view forwards for `appId`. */
  subscribeEvents(appId: string, listener: (event: string, data: unknown) => void): () => void;
}

export interface AppRunRuntimeInput {
  appId: string;
  driver: SnugDbDriver;
  /** `undefined` → the page's ordinary gate (a manual run); else the refusing gate. */
  confirmGate: NetConfirmGate | undefined;
  /** The net handler's counting seam. */
  onNetCall: () => boolean;
}

export interface AppRunDeps {
  platform(): SnugPlatform;
  /** The hidden frame's runtime — `composeAppRuntime` over the page stores in production. */
  runtimeFor(input: AppRunRuntimeInput): { transport: AgentTransport; frameProps: FrameCapabilityProps };
  mounts: Store<HiddenMount | undefined>;
  live: LiveAppHosts;
  announceTimeoutMs: number;
  resultTimeoutMs: number;
}

/** The production seams — every store and registry read at the CALL, nothing at load (M20). */
export function defaultAppRunDeps(): AppRunDeps {
  return {
    platform: getPlatform,
    runtimeFor: ({ appId, driver, confirmGate, onNetCall }) => {
      const runtime = composeAppRuntime({ appId, mode: modeStore.get(), provider: providerStore.get(), driver, confirmGate, onNetCall });
      return { transport: runtime.transport, frameProps: runtime.frameProps };
    },
    mounts: hiddenMountStore,
    live: { has: hasLiveAppHost, notify: notifyAppHost, subscribe: subscribeAppHosts, subscribeEvents: subscribeAppEvents },
    announceTimeoutMs: SCHEDULE_ANNOUNCE_TIMEOUT_MS,
    resultTimeoutMs: SCHEDULE_RESULT_TIMEOUT_MS,
  };
}

// --------------------------------------------------------------------- the sweep

/** Clear the handshake key of a run that can no longer answer — the boot's stale-claim sweep. Never throws. */
export async function clearScheduleKey(db: UserDb, run: Pick<ScheduleRun, 'id'>, task: Pick<ScheduledTask, 'steps'> | undefined): Promise<void> {
  if (task === undefined) return;
  const key = scheduleKvKey(run.id);
  for (const appId of appIdsOf(task.steps.filter((step) => step.kind === 'app-run'))) {
    try {
      await db.driver.kvSet(appId, key, null);
    } catch {
      // The driver answers errors as data; a throw here would be a closed driver — nothing to clear.
    }
  }
}

// ------------------------------------------------------------------ the executor

const none = (): StepOutcome['calls'] => ({ ai: 0, net: 0 });

/** One line for a run the app did not answer in time. */
export const appDidNotAnswer = (ms: number): string => `the app didn’t answer within ${Math.round(ms / 1000)} s`;

/** A promise and its resolver in hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A timer as a promise, cleared on `stop()` so a settled phase leaves no handle behind. */
function timer(ms: number): { promise: Promise<void>; stop: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return {
    promise,
    stop: () => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/** What ends a phase of the handshake. */
type Settled = { kind: 'announced' } | { kind: 'result'; result: ScheduleResult } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'failed'; message: string };

/** The step outcome once the app answered (or did not): the gate's record outranks what the app reports. */
function outcomeOf(app: AppRecord, gate: ScheduledConfirmGate | undefined, answer: Settled, calls: StepOutcome['calls'], resultTimeoutMs: number): StepOutcome {
  if (gate !== undefined && gate.refused.length > 0) {
    return { status: 'refused', summary: needsYou(app.displayName, scheduledRefusalVerb(gate.refused[0])).text, calls };
  }
  switch (answer.kind) {
    case 'result': {
      const { result } = answer;
      if (!result.ok) return { status: 'failed', summary: result.summary ?? 'the app reported a failure', calls };
      return {
        status: 'ok',
        ...(result.summary !== undefined ? { summary: result.summary } : {}),
        calls,
        ...(result.notify !== undefined ? { alert: result.notify } : {}),
      };
    }
    case 'timeout':
      return { status: 'failed', summary: appDidNotAnswer(resultTimeoutMs), calls };
    case 'aborted':
      return { status: 'failed', summary: CANCELLED_SUMMARY, calls };
    case 'failed':
      return { status: 'failed', summary: answer.message, calls };
    case 'announced':
      return { status: 'failed', summary: 'the app announced twice', calls };
    default: {
      const never: never = answer;
      return never;
    }
  }
}

/** The ceiling question, asked per call: the file's counters, plus what the run already spent, plus this step so far. */
function ceilingAllows(ctx: StepContext, soFar: { ai: number; net: number }, add: { ai?: number; net?: number }): boolean {
  const nowIso = ctx.now().toISOString();
  const state = ctx.db.getSchedulerState();
  const daily = state === undefined ? { date: nowIso.slice(0, 10), ai: 0, net: 0 } : dailyCounters(state, nowIso);
  const spent = ctx.spent?.() ?? { ai: 0, net: 0 };
  return wouldExceedCeiling({ date: daily.date, ai: daily.ai + spent.ai + soFar.ai, net: daily.net + spent.net + soFar.net }, add) === undefined;
}

export async function executeAppRun(step: AppRunStep, ctx: StepContext, deps: AppRunDeps): Promise<StepOutcome> {
  if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, calls: none() };
  const app = ctx.db.getApp(step.appId);
  if (app === undefined) return { status: 'blocked', summary: appMissing.text, calls: none() };
  if (deps.platform().scheduler === undefined) return { status: 'blocked', summary: blockedHere(NO_HIDDEN_FRAME).text, calls: none() };

  const { appId } = step;
  const runId = ctx.run.id;
  const key = scheduleKvKey(runId);
  const payload = { taskId: ctx.run.taskId, runId, ...(step.input !== undefined ? { input: step.input } : {}) };
  const gate = ctx.run.trigger === 'manual' ? undefined : createScheduledConfirmGate();

  if (deps.live.has(appId)) return runInLiveFrame(app, step, ctx, deps, key, payload, gate);
  return runInHiddenFrame(app, step, ctx, deps, key, payload, gate);
}

/** The result phase shared by both frames: the first of the app's answer, the bound, the abort, or a failure signal. */
async function awaitResult(
  ctx: StepContext,
  resultTimeoutMs: number,
  result: Promise<ScheduleResult>,
  failure: Promise<Settled>,
): Promise<Settled> {
  const bound = timer(resultTimeoutMs);
  const aborted = new Promise<Settled>((resolve) => {
    const settle = (): void => resolve({ kind: 'aborted' });
    if (ctx.signal.aborted) settle();
    else ctx.signal.addEventListener('abort', settle, { once: true });
  });
  try {
    return await Promise.race<Settled>([
      result.then((value) => ({ kind: 'result', result: value })),
      bound.promise.then(() => ({ kind: 'timeout' })),
      aborted,
      failure,
    ]);
  } finally {
    bound.stop();
  }
}

async function runInLiveFrame(
  app: AppRecord,
  step: AppRunStep,
  ctx: StepContext,
  deps: AppRunDeps,
  key: string,
  payload: { taskId: string; runId: string; input?: unknown },
  gate: ScheduledConfirmGate | undefined,
): Promise<StepOutcome> {
  const { appId } = step;
  const result = deferred<ScheduleResult>();
  const failure = deferred<Settled>();
  let hinted = false;
  let seen = false;
  const unsubscribe = deps.live.subscribeEvents(appId, (event, data) => {
    if (!hinted || seen || event !== SCHEDULE_RESULT_EVENT) return;
    const parsed = parseScheduleResult(data, ctx.run.id);
    if (parsed === undefined) return;
    seen = true;
    result.resolve(parsed);
  });
  try {
    const wrote = await ctx.db.driver.kvSet(appId, key, payload);
    if (!wrote.ok) return { status: 'failed', summary: wrote.message, calls: none() };
    hinted = true; // before the ring: an app may answer in the same tick
    if (!deps.live.notify(appId, SCHEDULE_RUN_EVENT, { taskId: ctx.run.taskId, runId: ctx.run.id })) {
      return { status: 'failed', summary: 'the open app could not be reached', calls: none() };
    }
    const answer = await awaitResult(ctx, deps.resultTimeoutMs, result.promise, failure.promise);
    // The live frame's calls ride its own transport and gate — nothing here to count.
    return outcomeOf(app, gate, answer, none(), deps.resultTimeoutMs);
  } finally {
    unsubscribe();
    await ctx.db.driver.kvSet(appId, key, null);
  }
}

async function runInHiddenFrame(
  app: AppRecord,
  step: AppRunStep,
  ctx: StepContext,
  deps: AppRunDeps,
  key: string,
  payload: { taskId: string; runId: string; input?: unknown },
  gate: ScheduledConfirmGate | undefined,
): Promise<StepOutcome> {
  const { appId } = step;
  const html = ctx.db.getAppHtml(appId);
  if (html === undefined) return { status: 'blocked', summary: appMissing.text, calls: none() };
  if (deps.mounts.get() !== undefined) return { status: 'failed', summary: 'another scheduled run is still mounted', calls: none() };

  // The counting seams: the transport's `onCall` and the handler's `onNetCall` both ask the
  // ceiling with what THIS step spent so far (the transport's own count, this counter).
  let net = 0;
  let transport: ScheduledTransport | undefined;
  const soFar = (): { ai: number; net: number } => ({ ai: transport?.calls ?? 0, net });
  const onNetCall = (): boolean => {
    if (!ceilingAllows(ctx, soFar(), { net: 1 })) return false;
    net += 1;
    return true;
  };
  const runtime = deps.runtimeFor({ appId, driver: ctx.db.driver, confirmGate: gate, onNetCall });
  transport = createScheduledTransport(runtime.transport, { onCall: () => ceilingAllows(ctx, soFar(), { ai: 1 }) });
  const calls = (): StepOutcome['calls'] => ({ ai: transport?.calls ?? 0, net });

  const announce = deferred<void>();
  const result = deferred<ScheduleResult>();
  const failure = deferred<Settled>();
  let announced = false;
  let hinted = false;
  let seen = false;
  const controls: HiddenMount['controls'] = { current: null };
  const mount: HiddenMount = {
    appId,
    runId: ctx.run.id,
    html,
    transport,
    frameProps: runtime.frameProps,
    controls,
    onAnnounce: () => {
      if (announced) return;
      announced = true;
      announce.resolve();
    },
    onAppEvent: (event, data) => {
      // Bound to THIS closure (the frame that received the hint), after the hint, once, this run.
      if (!hinted || seen || event !== SCHEDULE_RESULT_EVENT) return;
      const parsed = parseScheduleResult(data, ctx.run.id);
      if (parsed === undefined) return;
      seen = true;
      result.resolve(parsed);
    },
    onNavigatedAway: () => failure.resolve({ kind: 'failed', message: 'the app left its sandbox' }),
    onBudgetExhausted: () => failure.resolve({ kind: 'failed', message: 'the app kept answering off-script' }),
  };
  // A visible open of the same app aborts the hidden run (F5): the queue records it `interrupted`.
  const unwatch = deps.live.subscribe((id, live) => {
    if (live && id === appId) {
      ctx.interrupt?.('app opened');
      failure.resolve({ kind: 'failed', message: 'app opened' });
    }
  });
  deps.mounts.set(mount);
  try {
    const announceBound = timer(deps.announceTimeoutMs);
    const aborted = new Promise<Settled>((resolve) => {
      const settle = (): void => resolve({ kind: 'aborted' });
      if (ctx.signal.aborted) settle();
      else ctx.signal.addEventListener('abort', settle, { once: true });
    });
    let first: Settled;
    try {
      first = await Promise.race<Settled>([
        announce.promise.then(() => ({ kind: 'announced' })),
        announceBound.promise.then(() => ({ kind: 'timeout' })),
        aborted,
        failure.promise,
      ]);
    } finally {
      announceBound.stop();
    }
    if (first.kind === 'timeout') return { status: 'no-handler', summary: noHandler(app.displayName).text, calls: calls() };
    if (first.kind !== 'announced') return outcomeOf(app, gate, first, calls(), deps.resultTimeoutMs);

    const wrote = await ctx.db.driver.kvSet(appId, key, payload);
    if (!wrote.ok) return { status: 'failed', summary: wrote.message, calls: calls() };
    const host = controls.current;
    if (host === null) return { status: 'failed', summary: 'the hidden frame has no host', calls: calls() };
    hinted = true; // before the ring: the app may answer in the same tick
    host.notifyEvent(SCHEDULE_RUN_EVENT, { taskId: ctx.run.taskId, runId: ctx.run.id });

    const answer = await awaitResult(ctx, deps.resultTimeoutMs, result.promise, failure.promise);
    return outcomeOf(app, gate, answer, calls(), deps.resultTimeoutMs);
  } finally {
    unwatch();
    if (deps.mounts.get() === mount) deps.mounts.set(undefined);
    await ctx.db.driver.kvSet(appId, key, null);
  }
}
