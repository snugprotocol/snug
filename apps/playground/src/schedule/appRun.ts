// schedule/appRun.ts — the *Run [app]* executor and the kv handshake
// (TASK-20261009-scheduling-framework A2, A3, A5; ADR-0074 §3, §5, §6; security F5, F8, F16;
// Gate-5 PR-B S1/M1, M9, M12, M18, M22).
//
// THE SHAPE OF A RUN. The host writes the step's input into the app's OWN kv under
// `snug:schedule:<runId>` (`scheduleKey.ts` — the input is ≤ 1 KiB by the task schema; the
// driver's host-side seat caps the whole payload), rings the EXISTING `host-event` channel with
// a hint that carries ids and nothing else (`schedule-run { taskId, runId }` — R7: hints, never
// content), and reads the app's `app-event 'schedule-result'`. No new frame, no `host-ready`
// flag, no new error code. The key is cleared on EVERY exit path, and the stale-claim sweep
// clears the key of any claim a dead tab left behind (`clearScheduleKey`, from `scheduler.ts`).
//
// WHERE THE APP RUNS — THE TRIGGER DECIDES; A TIMER NEVER DRIVES THE LIVE FRAME.
//   `due` / `late` / `catch-up` (nobody asked right now): ONE hidden `SnugAppFrame` is mounted
//   through `hiddenMountStore` (`ScheduledRunHost.tsx` renders it) with the runtime
//   `run/appRuntime.ts` composes for RunView, and two differences — the STANDALONE refusing
//   gate and the counting transport (below). The hidden frame runs the app's COMMITTED CURRENT
//   version (`getAppHtml`). It runs WHETHER OR NOT the app is on screen, and opening the app
//   mid-run does not stop it (owner decision 2026-10-09, TASK-20261009-scheduled-run-open-app —
//   a schedule runs on time, without asking). What PR-B's Gate-5 fold (S1) guarded against
//   stays guarded: the run never rides the LIVE frame, whose gate is the ordinary one armed by
//   whatever the user remembered — it gets its own frame, its own refusing gate and its own
//   count. The accepted cost: two instances of one app (the visible one and this one) may run at
//   once over the app's one store — each db/kv request is atomic at the host, the race is the
//   app's (two read-modify-writes), as with the app open in two tabs (threat model R-62).
//   `manual` (the user pressed *run now* / *run now and review*): the run is delivered ONLY to
//   the LIVE frame — the hint rides the registry's notify, the result comes back through the
//   app-events the view forwards (`publishAppEvent`) — under the page's ordinary gate, because
//   the user is at the app, and its calls ride the live frame's own transport (not this
//   executor's to count). When the app is not open the step is `refused` by name
//   (`openAndRunAgain`): the view navigates to the app BEFORE it calls `runNow`, so this is the
//   answer only to a manual run nobody is looking at — never a hidden frame under the ordinary
//   gate. The app closing mid-run ends the step `failed` at once (M18).
//
// THE RESULT IS BOUND, ONCE, CAPPED (F8). A result is accepted only from the frame that
// received the hint (the mount's own closure, or the live registry's events for that app),
// only after the hint was posted, only once, only for this `runId` when the result names one;
// its serialised length is capped BEFORE the strict parse (`scheduleResultSchema`). Anything
// else is dropped without a word: an unsolicited, duplicate, forged or oversized result is the
// one thing an app can send that the host must not act on.
//
// THE GATE (A5, §6). Every hidden-frame run carries the STANDALONE refusing gate
// (`scheduledConfirmGate.ts`): a mutating call is refused with the existing
// `NET_CONFIRM_DENIED`, the gate RECORDS it, and the step is `refused` with the sentence
// `copy.needsYou` composes from the record — whatever the app then reports. The run folds to
// `needs-you` with *run now and review* as its one act.
//
// WHAT IS COUNTED (A4, A5). The hidden frame's transport is wrapped by `scheduledTransport.ts`
// (every send asked of the day's AI ceiling; `onCounted` reports each call that reached the
// brain into this executor's own count); its net handler's `onNetCall` seam asks the day's
// network ceiling before every request. Both read the counters in the file PLUS what this run
// already spent (`ctx.spent`), so a run cannot slip past the ceiling by spending inside one
// step. The counts ride the outcome's `calls`.
//
// A VISIBLE OPEN DOES NOT ABORT THE HIDDEN RUN. PR-B's F5 interrupted the run when a RunView
// mounted the same app; the owner's 2026-10-09 decision (a schedule runs on time, open app or
// not) retired that, so the two frames simply coexist until the hidden one answers.
//
// REFUSED WITHOUT A SEAT. A platform that composes no `scheduler` seat (every shipped host
// composes one — web, desktop, both kit bindings) gets no hidden frame: the step is `blocked`
// by name. No read of the platform's `kind` (the S4 lint). A unit fake that wants exactly that
// answer composes `blockedAppRunDeps()` (M12) rather than leaving the seams out.

import { z } from 'zod';

import type { NetConfirmGate } from '@snugprotocol/auth';
import type { AppRecord, SnugDbDriver } from '@snugprotocol/db';
import { SCHEDULE_NOTIFY_BODY_MAX_CHARS, SCHEDULE_STEP_SUMMARY_MAX_CHARS, SCHEDULE_TITLE_MAX_CHARS, type ScheduleStep } from '@snugprotocol/protocol';
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
import { SCHEDULE_RESULT_EVENT, SCHEDULE_RUN_EVENT, scheduleKvKey } from './scheduleKey.js';
import { scheduledDbDriver } from './scheduledDbDriver.js';
import { createScheduledConfirmGate, scheduledRefusalVerb, type ScheduledConfirmGate } from './scheduledConfirmGate.js';
import { createScheduledTransport } from './scheduledTransport.js';

export type AppRunStep = Extract<ScheduleStep, { kind: 'app-run' }>;

/** No announce within this → `no-handler` (the app never even booted its bridge). */
export const SCHEDULE_ANNOUNCE_TIMEOUT_MS = 10_000;
/** No result within this → `failed`; under the queue's 120 s run bound so the step can say so itself. */
export const SCHEDULE_RESULT_TIMEOUT_MS = 90_000;
/** The serialised length a result may have BEFORE it is parsed at all. */
export const SCHEDULE_RESULT_MAX_CHARS = 8 * 1024;

/** The reason when a composition carries no hidden-frame seams, or the platform no scheduler seat. */
export const NO_HIDDEN_FRAME = 'this host cannot run an app on a schedule';


/** A manual run with the app NOT on screen: refused by name — the view opens the app first, then runs. */
export const openAndRunAgain = (appName: string): string => `open ${appName} and run it again`;

/** A manual run whose live frame went away mid-run (M18). */
export const APP_CLOSED_SUMMARY = 'the app was closed';

/**
 * What the app may answer. `runId`/`taskId` are optional echoes (a result that names another
 * run is dropped); `summary` is what the person reads; `notify` is a SUGGESTION the queue
 * honours only when the task's `alert` allows (§6) — and the queue decides the title. Strict:
 * an unknown field is a drop.
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
  /** The STANDALONE refusing gate — a hidden frame never runs under the page's gate. */
  confirmGate: NetConfirmGate;
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

/**
 * The composition a unit fake passes when it wants every app-run step `blocked` by name (M12):
 * a platform with no scheduler seat, so the arm refuses before any mount, runtime or registry
 * is touched. Nothing here can run anything.
 */
export function blockedAppRunDeps(): AppRunDeps {
  const noSeat: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false } };
  return {
    platform: () => noSeat,
    runtimeFor: () => {
      throw new Error('a blocked composition composes no runtime');
    },
    mounts: createStore<HiddenMount | undefined>(undefined),
    live: { has: () => false, notify: () => false, subscribe: () => () => undefined, subscribeEvents: () => () => undefined },
    announceTimeoutMs: 0,
    resultTimeoutMs: 0,
  };
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

/** What can end EITHER phase from outside the app's own answer: the queue's abort, or a failure the frame or the registry signalled. */
type Interrupted = { kind: 'aborted' } | { kind: 'failed'; message: string };
/** How the announce phase ends (the hidden frame only). */
type AnnouncePhase = { kind: 'announced' } | { kind: 'timeout' } | Interrupted;
/** How the result phase ends (both frames). */
type ResultPhase = { kind: 'result'; result: ScheduleResult } | { kind: 'timeout' } | Interrupted;

/** The step outcome once the app answered (or did not): the gate's record outranks what the app reports. */
function outcomeOf(app: AppRecord, gate: ScheduledConfirmGate | undefined, answer: ResultPhase, calls: StepOutcome['calls'], resultTimeoutMs: number): StepOutcome {
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
  const key = scheduleKvKey(ctx.run.id);
  const payload = { taskId: ctx.run.taskId, runId: ctx.run.id, ...(step.input !== undefined ? { input: step.input } : {}) };
  const live = deps.live.has(appId);

  if (ctx.run.trigger === 'manual') {
    // The user asked, so the user is at the app — or the view brings them there first.
    if (!live) return { status: 'refused', summary: openAndRunAgain(app.displayName), calls: none() };
    return runInLiveFrame(app, step, ctx, deps, key, payload);
  }
  // Unattended: the hidden frame under the refusing gate — open app or not; never the live frame.
  return runInHiddenFrame(app, step, ctx, deps, key, payload, createScheduledConfirmGate());
}

/** The result phase shared by both frames: the first of the app's answer, the bound, the abort, or an interruption. */
async function awaitResult(ctx: StepContext, resultTimeoutMs: number, result: Promise<ScheduleResult>, interrupted: Promise<Interrupted>): Promise<ResultPhase> {
  const bound = timer(resultTimeoutMs);
  const aborted = new Promise<ResultPhase>((resolve) => {
    const settle = (): void => resolve({ kind: 'aborted' });
    if (ctx.signal.aborted) settle();
    else ctx.signal.addEventListener('abort', settle, { once: true });
  });
  try {
    return await Promise.race<ResultPhase>([
      result.then((value) => ({ kind: 'result', result: value })),
      bound.promise.then(() => ({ kind: 'timeout' })),
      aborted,
      interrupted,
    ]);
  } finally {
    bound.stop();
  }
}

/** A manual run delivered to the app ON SCREEN, under the page's own gate; the app closing ends it (M18). */
async function runInLiveFrame(
  app: AppRecord,
  step: AppRunStep,
  ctx: StepContext,
  deps: AppRunDeps,
  key: string,
  payload: { taskId: string; runId: string; input?: unknown },
): Promise<StepOutcome> {
  const { appId } = step;
  const result = deferred<ScheduleResult>();
  const interrupted = deferred<Interrupted>();
  let hinted = false;
  let seen = false;
  const unsubscribeEvents = deps.live.subscribeEvents(appId, (event, data) => {
    if (!hinted || seen || event !== SCHEDULE_RESULT_EVENT) return;
    const parsed = parseScheduleResult(data, ctx.run.id);
    if (parsed === undefined) return;
    seen = true;
    result.resolve(parsed);
  });
  const unwatch = deps.live.subscribe((id, isLive) => {
    if (!isLive && id === appId) interrupted.resolve({ kind: 'failed', message: APP_CLOSED_SUMMARY });
  });
  try {
    const wrote = await ctx.db.driver.kvSet(appId, key, payload);
    if (!wrote.ok) return { status: 'failed', summary: wrote.message, calls: none() };
    hinted = true; // before the ring: an app may answer in the same tick
    if (!deps.live.notify(appId, SCHEDULE_RUN_EVENT, { taskId: ctx.run.taskId, runId: ctx.run.id })) {
      return { status: 'failed', summary: 'the open app could not be reached', calls: none() };
    }
    const answer = await awaitResult(ctx, deps.resultTimeoutMs, result.promise, interrupted.promise);
    // The live frame's calls ride its own transport and gate — nothing here to count.
    return outcomeOf(app, undefined, answer, none(), deps.resultTimeoutMs);
  } finally {
    unwatch();
    unsubscribeEvents();
    await ctx.db.driver.kvSet(appId, key, null);
  }
}

/** An unattended run in the ONE hidden frame, under the refusing gate and the counting transport. */
async function runInHiddenFrame(
  app: AppRecord,
  step: AppRunStep,
  ctx: StepContext,
  deps: AppRunDeps,
  key: string,
  payload: { taskId: string; runId: string; input?: unknown },
  gate: ScheduledConfirmGate,
): Promise<StepOutcome> {
  const { appId } = step;
  const html = ctx.db.getAppHtml(appId);
  if (html === undefined) return { status: 'blocked', summary: appMissing.text, calls: none() };
  if (deps.mounts.get() !== undefined) return { status: 'failed', summary: 'another scheduled run is still mounted', calls: none() };

  // The counting seams (M22): this executor keeps the step's own count — the transport reports
  // each call that reached the brain (`onCounted`), the net handler asks before each request —
  // and both ceiling questions read it with what the run already spent.
  let ai = 0;
  let net = 0;
  const soFar = (): { ai: number; net: number } => ({ ai, net });
  const onNetCall = (): boolean => {
    if (!ceilingAllows(ctx, soFar(), { net: 1 })) return false;
    net += 1;
    return true;
  };
  // The db binding refuses a transaction or a whole-database import: the visible copy shares the connection.
  const runtime = deps.runtimeFor({ appId, driver: scheduledDbDriver(ctx.db.driver), confirmGate: gate, onNetCall });
  const transport = createScheduledTransport(runtime.transport, {
    onCall: () => ceilingAllows(ctx, soFar(), { ai: 1 }),
    onCounted: () => {
      ai += 1;
    },
  });
  const calls = (): StepOutcome['calls'] => ({ ai, net });

  const announce = deferred<void>();
  const result = deferred<ScheduleResult>();
  const interrupted = deferred<Interrupted>();
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
    onNavigatedAway: () => interrupted.resolve({ kind: 'failed', message: 'the app left its sandbox' }),
    onBudgetExhausted: () => interrupted.resolve({ kind: 'failed', message: 'the app kept answering off-script' }),
  };
  deps.mounts.set(mount);
  try {
    const announceBound = timer(deps.announceTimeoutMs);
    const aborted = new Promise<AnnouncePhase>((resolve) => {
      const settle = (): void => resolve({ kind: 'aborted' });
      if (ctx.signal.aborted) settle();
      else ctx.signal.addEventListener('abort', settle, { once: true });
    });
    let first: AnnouncePhase;
    try {
      first = await Promise.race<AnnouncePhase>([
        announce.promise.then(() => ({ kind: 'announced' })),
        announceBound.promise.then(() => ({ kind: 'timeout' })),
        aborted,
        interrupted.promise,
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

    const answer = await awaitResult(ctx, deps.resultTimeoutMs, result.promise, interrupted.promise);
    return outcomeOf(app, gate, answer, calls(), deps.resultTimeoutMs);
  } finally {
    if (deps.mounts.get() === mount) deps.mounts.set(undefined);
    await ctx.db.driver.kvSet(appId, key, null);
  }
}
