// schedule/appRun.ts — the *Run [app]* executor and the kv handshake
// (TASK-20261009-scheduling-framework A2, A3, A5; ADR-0074 §3, §5, §6; security F5, F8, F16;
// Gate-5 PR-B S1/M1, M9, M12, M18, M22; TASK-20261010-host-broker PR-1 — ADR-0077, one instance
// per app).
//
// THE SHAPE OF A RUN. The host writes the step's input into the app's OWN kv under
// `snug:schedule:<runId>` (`scheduleKey.ts` — the input is ≤ 1 KiB by the task schema; the
// driver's host-side seat caps the whole payload), rings the EXISTING `host-event` channel with
// a hint that carries ids and nothing else (`schedule-run { taskId, runId }` — R7: hints, never
// content), and reads the app's `app-event 'schedule-result'`. No new frame, no `host-ready`
// flag, no new error code. The key is written per dispatch (the same key) and cleared ONCE in the
// executor's outer `finally`; the stale-claim sweep clears the key of any claim a dead tab left
// behind (`clearScheduleKey`, from `scheduler.ts`).
//
// ONE INSTANCE PER APP — PLACEMENT (ADR-0077 §1–§2). At any moment an app has at most one running
// instance in this tab: the visible frame when the app is open, the hidden frame otherwise. For an
// unattended trigger (`due` · `late` · `catch-up`) `runPlacement.ts` decides by one rule — the
// registry HAS the app → DELEGATED to the live frame (`dispatchLive`), else the ONE hidden
// `SnugAppFrame` (`dispatchHidden`, through `hiddenMountStore`; `ScheduledRunHost.tsx` renders it)
// with the runtime `run/appRuntime.ts` composes, the STANDALONE refusing gate and the counting
// transport. Two frames of one app never share the connection again (R-70 retired for this case).
//
// A DELEGATED RUN RIDES THE RUN-SCOPED ASK GATE (ADR-0077 §3). What PR-B's Gate-5 fold (S1) guarded
// against stays guarded — "presence is not consent": the live frame's net handler defaults to the
// run-scoped gate (`state/net.ts`), which consults the placement store per request. While this run
// is in flight (`beginDelegatedRun` … `endDelegatedRun`) a mutating call never reaches a remembered
// or armed grant: the present user is asked once through the ordinary dialog under a host-composed
// title; no answer in a minute, a decline, or a second ask is a refusal RECORDED on the run — and
// the record outranks what the app reports (`outcomeOf` says WHICH of the three happened). The
// frame generation that hosted a delegated run stays ask-only afterwards (the sticky posture,
// `touchedGeneration`), so a handler cannot post its result first and POST afterwards. The access
// handler closes the same way for the window (D-PR1-8). The live frame's transport, db binding
// and replies are the open app's own — the powers it already has for the user's clicks (D-PR1-7).
//
// COUNTING FOLLOWS THE RUN (ADR-0077 §4). The hidden frame's transport is wrapped by
// `scheduledTransport.ts` (every send asked of the day's AI ceiling; `onCounted` reports each call
// that reached the brain into this executor's own count) and its net handler's `onNetCall` asks
// the network ceiling before every request — both read the counters in the file PLUS what this run
// already spent (`ctx.spent`) PLUS the step's earlier attempts. The live frame counts on the run's
// record instead (`run/appRuntime.ts`'s decorators) and never refuses mid-window: the ceiling is
// asked BEFORE a delegated dispatch — either counter without headroom for one more call →
// `refused`, `capped: true`, nothing dispatched (D-PR1-6) — and a tally that crosses a ceiling
// inside the window marks the outcome `capped` without stopping app code. Tallies are SUMMED across
// attempts; the counts ride the outcome's `calls`.
//
// A RUN FOLLOWS THE APP — ONCE, AND NEVER AFTER THE USER ANSWERED (ADR-0077 §5). Opening the app
// mid-hidden-run cuts that attempt and re-dispatches the SAME `runId` to the live frame once the
// hidden frame has reported unmounted (`HIDDEN_UNMOUNT_WAIT_MS`, bounded by the deadline) and the
// live one has announced; closing the app mid-delegated-run re-dispatches hidden. At most
// `MAX_HANDOVERS` per run — a second ends the step `failed` (`copy.handedOverTwice`). A delegated
// attempt in which the user ANSWERED is never handed over (Gate-5 F-7): after an ALLOWED call a
// retraction ends the step `failed` (`copy.closedAfterChange`) rather than running a handler whose
// POST already went out; after a DECISIVE refusal (declined, or the minute passed) it ends the
// attempt `failed` and `outcomeOf` reads the record first, so the step says what the user said — a
// hidden re-dispatch would re-run the handler and overwrite that answer with the generic line. A
// retraction or a registration that lands DURING the kv write is honoured before the hint (F-3): a
// frame whose handover is decided is never rung. One deadline per step (D-PR1-10): fixed at the
// first dispatch, every announce, result and unmount wait is bounded by what it has left, so a
// handover never runs past the queue's 120 s bound. A `frameEpoch` remount mid-run is not a
// handover in PR-1 — the attempt ends by the result bound (R-84).
//
// READINESS (ADR-0077 §6). Every live hint — `manual` too — waits for the frame to be READY
// (registered AND announced at its current generation, `awaitAppHostReady`) ≤ the announce bound;
// a frame that never announces is `no-handler`, a frame that retracts is a handover (unattended) or
// `the app was closed` (manual, M18). A `schedule-result` settles a delegated run ONLY from the
// generation that was hinted (security 5).
//
// `manual` (the user pressed *run now* / *run now and review*) is otherwise untouched (D-PR1-2):
// delivered ONLY to the LIVE frame under the page's ordinary gate, uncounted; with the app not
// open it is `refused` by name (`openAndRunAgain`) — the view navigates to the app BEFORE it calls
// `runNow`, so this is the answer only to a manual run nobody is looking at.
//
// THE RESULT IS BOUND, ONCE, CAPPED (F8). A result is accepted only from the frame that
// received the hint (the mount's own closure, or the live registry's events at the hinted
// generation), only after the hint was posted, only once, only for this `runId` when the result
// names one; its serialised length is capped BEFORE the strict parse (`scheduleResultSchema`).
// Anything else is dropped without a word: an unsolicited, duplicate, forged or oversized result is
// the one thing an app can send that the host must not act on.
//
// REFUSED WITHOUT A SEAT. A platform that composes no `scheduler` seat (every shipped host
// composes one — web, desktop, both kit bindings) gets no hidden frame: the step is `blocked`
// by name. No read of the platform's `kind` (the S4 lint). A unit fake that wants exactly that
// answer composes `blockedAppRunDeps()` (M12) rather than leaving the seams out.
//
// Timers are `setTimeout` + `Date.now()` only — never `AbortSignal.timeout`, never `performance.now()`
// (vitest's fake clock drives the suites).

import { z } from 'zod';

import type { NetConfirmGate } from '@snugprotocol/auth';
import type { AppRecord, SnugDbDriver } from '@snugprotocol/db';
import { SCHEDULE_NOTIFY_BODY_MAX_CHARS, SCHEDULE_STEP_SUMMARY_MAX_CHARS, SCHEDULE_TITLE_MAX_CHARS, type ScheduleStep } from '@snugprotocol/protocol';
import type { AgentTransport, RunnerHost } from '@snugprotocol/runner';

import { getPlatform, type SnugPlatform } from '../platform/platform.js';
import { composeAppRuntime, type FrameCapabilityProps } from '../run/appRuntime.js';
import { awaitAppHostReady, hasLiveAppHost, liveAppHostGeneration, notifyAppHost, subscribeAppEvents, subscribeAppHosts } from '../state/appHosts.js';
import { modeStore, providerStore } from '../state/mode.js';
import { createStore, type Store } from '../state/store.js';
import { CANCELLED_SUMMARY } from './appThink.js';
import {
  APP_UNREACHABLE_SUMMARY,
  appMissing,
  blockedHere,
  capped,
  closedAfterChange,
  handedOverTwice,
  needsYou,
  needsYouAlreadyAsked,
  needsYouDeclined,
  needsYouUnanswered,
  noHandler,
  type CappedWhat,
} from './copy.js';
import type { StepContext, StepOutcome } from './engine-types.js';
import { dailyCounters, wouldExceedCeiling, type DailyCounters } from './protection.js';
import { MAX_HANDOVERS, beginDelegatedRun, endDelegatedRun, placeRun, type DelegatedRun, type Placement, type ScheduledRefusal } from './runPlacement.js';
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
/** After a hidden → live handover, how long the live hint waits for the hidden frame to report unmounted. */
export const HIDDEN_UNMOUNT_WAIT_MS = 1_000;

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
  /** The frame is GONE (the host component's effect cleanup, keyed by `runId`) — a handover's live hint waits for it (ADR-0077 §5). */
  onUnmounted(): void;
}

/** ONE hidden mount at a time (the queue runs one step at a time). The host component renders it. */
export const hiddenMountStore: Store<HiddenMount | undefined> = createStore<HiddenMount | undefined>(undefined);

// ----------------------------------------------------------------------- the deps

/** The live-host registry as the executor sees it (`state/appHosts.ts` in production). */
export interface LiveAppHosts {
  /** Registered in this tab — what placement reads. */
  has(appId: string): boolean;
  notify(appId: string, event: string, data: unknown): boolean;
  /** Fires on every registration (`live: true`) and retraction. */
  subscribe(listener: (appId: string, live: boolean) => void): () => void;
  /** The app-events the live view forwards for `appId`, each with the frame generation it came from. */
  subscribeEvents(appId: string, listener: (event: string, data: unknown, generation: number) => void): () => void;
  /** Registered AND announced at the current generation within `ms` — true; false on the bound or a retraction. */
  awaitReady(appId: string, ms: number): Promise<boolean>;
  /** The registered view's frame generation. */
  generation(appId: string): number | undefined;
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
      // Nobody is looking (TASK-20261010-cross-app-access AC20): an access ask is refused
      // `ACCESS_UNATTENDED`, and a read needs the grant's *also while I'm away*.
      const runtime = composeAppRuntime({ appId, attended: false, mode: modeStore.get(), provider: providerStore.get(), driver, confirmGate, onNetCall });
      return { transport: runtime.transport, frameProps: runtime.frameProps };
    },
    mounts: hiddenMountStore,
    live: {
      has: hasLiveAppHost,
      notify: notifyAppHost,
      subscribe: subscribeAppHosts,
      subscribeEvents: subscribeAppEvents,
      awaitReady: awaitAppHostReady,
      generation: liveAppHostGeneration,
    },
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
    live: {
      has: () => false,
      notify: () => false,
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
      awaitReady: () => Promise.resolve(false),
      generation: () => undefined,
    },
    announceTimeoutMs: 0,
    resultTimeoutMs: 0,
  };
}

// ------------------------------------------------------------------ the executor

type Calls = StepOutcome['calls'];
const none = (): Calls => ({ ai: 0, net: 0 });

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

/** How one dispatch of the step ended. `handover` is the loop's to act on; everything else is `outcomeOf`'s. */
type DispatchEnd =
  | { kind: 'result'; result: ScheduleResult }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'failed'; message: string }
  | { kind: 'blocked'; message: string }
  | { kind: 'no-handler' }
  | { kind: 'handover'; to: Placement };

/** How the hidden frame's announce phase ends. */
type AnnouncePhase = { kind: 'announced' } | DispatchEnd;

/** One attempt of the step: how it ended, what it spent, what its gate refused (the hidden gate says what was tried; the ask gate says why nothing was sent). */
interface Attempt {
  end: DispatchEnd;
  calls: Calls;
  refused: readonly ScheduledRefusal[];
}

/** What every dispatch of one step shares. */
interface Dispatch {
  mode: 'manual' | 'unattended';
  app: AppRecord;
  step: AppRunStep;
  ctx: StepContext;
  deps: AppRunDeps;
  key: string;
  payload: { taskId: string; runId: string; input?: unknown };
  /** The step's one deadline (D-PR1-10): every wait inside a dispatch is bounded by what it has left. */
  deadline: number;
  /** What the step's EARLIER attempts spent — the ceiling questions count it. */
  spent: Calls;
  /** This dispatch follows a handover: its announce wait is bounded by the deadline alone (D-PR1-10). */
  afterHandover: boolean;
}

/** What the deadline has left, never negative. */
const remaining = (d: Dispatch): number => Math.max(0, d.deadline - Date.now());

/**
 * How long a dispatch waits for the frame to announce: the first dispatch the announce window
 * (≤ 10 s, else `no-handler` — the app has no hook), capped by the deadline; a re-dispatch what the
 * deadline has left (D-PR1-10's "bounded by `deadline − now`") — the step already began on this app,
 * and what remains of its one deadline is the honest bound for the instance it moved to.
 */
const announceBoundMs = (d: Dispatch): number => (d.afterHandover ? remaining(d) : Math.min(d.deps.announceTimeoutMs, remaining(d)));

/** The queue's abort as an end, whenever it fires. */
function abortedEnd(signal: AbortSignal): Promise<DispatchEnd> {
  return new Promise<DispatchEnd>((resolve) => {
    const settle = (): void => resolve({ kind: 'aborted' });
    if (signal.aborted) settle();
    else signal.addEventListener('abort', settle, { once: true });
  });
}

/** The result phase shared by both frames: the first of the app's answer, the bound, the abort, or an interruption. */
async function awaitResult(ctx: StepContext, boundMs: number, result: Promise<ScheduleResult>, interrupted: Promise<DispatchEnd>): Promise<DispatchEnd> {
  const bound = timer(boundMs);
  try {
    return await Promise.race<DispatchEnd>([
      result.then((value) => ({ kind: 'result', result: value })),
      bound.promise.then(() => ({ kind: 'timeout' })),
      abortedEnd(ctx.signal),
      interrupted,
    ]);
  } finally {
    bound.stop();
  }
}

// ------------------------------------------------------------------ the ceilings

/** The file's counters for today, plus what the run already spent, plus what this step spent so far. */
function countersSoFar(ctx: StepContext, soFar: Calls): DailyCounters {
  const nowIso = ctx.now().toISOString();
  const state = ctx.db.getSchedulerState();
  const daily = state === undefined ? { date: nowIso.slice(0, 10), ai: 0, net: 0 } : dailyCounters(state, nowIso);
  const spent = ctx.spent?.() ?? { ai: 0, net: 0 };
  return { date: daily.date, ai: daily.ai + spent.ai + soFar.ai, net: daily.net + spent.net + soFar.net };
}

/** The ceiling question the hidden frame asks per call. */
function ceilingAllows(ctx: StepContext, soFar: Calls, add: { ai?: number; net?: number }): boolean {
  return wouldExceedCeiling(countersSoFar(ctx, soFar), add) === undefined;
}

/** Which ceiling has no headroom for ONE more call — asked BEFORE a delegated dispatch (D-PR1-6). */
function ceilingWithoutHeadroom(ctx: StepContext, soFar: Calls): CappedWhat | undefined {
  switch (wouldExceedCeiling(countersSoFar(ctx, soFar), { ai: 1, net: 1 })) {
    case 'ai':
      return 'AI call';
    case 'net':
      return 'network call';
    case undefined:
      return undefined;
  }
}

/** Did the step's summed tally CROSS a ceiling inside its window? The row says so; app code was not stopped (R-80). */
function crossedCeiling(ctx: StepContext, calls: Calls): boolean {
  return wouldExceedCeiling(countersSoFar(ctx, calls), {}) !== undefined;
}

// ------------------------------------------------------------------ the outcome

/** The user ANSWERED this one — declined it, or let the minute pass (contract v2.2; F-7). */
const isDecisive = (refusal: ScheduledRefusal): boolean => refusal.why === 'declined' || refusal.why === 'timed-out';

/**
 * The refusal the step names (contract v2.2): the first DECISIVE one — the user declined, or
 * nobody answered — outranks an `already-asked` one parked behind it; only when every refusal is
 * `already-asked` does the step say the app asked again. The hidden gate's refusals carry no `why`.
 */
function refusalToName(refused: readonly ScheduledRefusal[]): ScheduledRefusal | undefined {
  if (refused.length === 0) return undefined;
  return refused.find(isDecisive) ?? refused[0];
}

function refusalSentence(appName: string, refusal: ScheduledRefusal): string {
  const verb = scheduledRefusalVerb(refusal);
  switch (refusal.why) {
    case 'declined':
      return needsYouDeclined(appName, verb).text;
    case 'timed-out':
      return needsYouUnanswered(appName, verb).text;
    case 'already-asked':
      return needsYouAlreadyAsked(appName, verb).text;
    case undefined:
      return needsYou(appName, verb).text;
  }
}

/**
 * The step outcome once an attempt ended (never on a handover): the gate's record outranks what the
 * app reports — and what ended the attempt (a `failed` end after a retraction included, F-7), so a
 * decisive refusal reads as the user's own sentence whatever happened to the frame afterwards.
 */
function outcomeOf(app: AppRecord, attempt: Attempt, resultTimeoutMs: number): StepOutcome {
  const { end, calls } = attempt;
  const refusal = refusalToName(attempt.refused);
  if (refusal !== undefined) return { status: 'refused', summary: refusalSentence(app.displayName, refusal), calls };
  switch (end.kind) {
    case 'result': {
      const { result } = end;
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
      return { status: 'failed', summary: end.message, calls };
    case 'blocked':
      return { status: 'blocked', summary: end.message, calls };
    case 'no-handler':
      return { status: 'no-handler', summary: noHandler(app.displayName).text, calls };
    case 'handover':
      // The loop acts on every handover it may; one it may not is said by name.
      return { status: 'failed', summary: handedOverTwice(app.displayName), calls };
    default: {
      const never: never = end;
      return never;
    }
  }
}

export async function executeAppRun(step: AppRunStep, ctx: StepContext, deps: AppRunDeps): Promise<StepOutcome> {
  if (ctx.signal.aborted) return { status: 'failed', summary: CANCELLED_SUMMARY, calls: none() };
  const app = ctx.db.getApp(step.appId);
  if (app === undefined) return { status: 'blocked', summary: appMissing.text, calls: none() };
  if (deps.platform().scheduler === undefined) return { status: 'blocked', summary: blockedHere(NO_HIDDEN_FRAME).text, calls: none() };

  const { appId } = step;
  const key = scheduleKvKey(ctx.run.id);
  const payload = { taskId: ctx.run.taskId, runId: ctx.run.id, ...(step.input !== undefined ? { input: step.input } : {}) };
  const shared = { app, step, ctx, deps, key, payload };

  if (ctx.run.trigger === 'manual') {
    // The user asked, so the user is at the app — or the view brings them there first. The live
    // frame's own gate and transport answer its calls: nothing here to count (R-62).
    if (!deps.live.has(appId)) return { status: 'refused', summary: openAndRunAgain(app.displayName), calls: none() };
    try {
      const attempt = await dispatchLive({ ...shared, mode: 'manual', deadline: Date.now() + deps.resultTimeoutMs, spent: none(), afterHandover: false });
      return outcomeOf(app, { ...attempt, calls: none() }, deps.resultTimeoutMs);
    } finally {
      await ctx.db.driver.kvSet(appId, key, null);
    }
  }

  // Unattended: where the app lives (ADR-0077 §2), one deadline (D-PR1-10), at most one handover (§5).
  const deadline = Date.now() + deps.resultTimeoutMs;
  let placement = placeRun(deps.live, appId);
  let handovers = 0;
  const calls = none();
  const withCap = (outcome: StepOutcome): StepOutcome => (crossedCeiling(ctx, calls) ? { ...outcome, capped: true } : outcome);
  try {
    for (;;) {
      if (placement === 'live') {
        // The ceiling is asked BEFORE a delegated dispatch (D-PR1-6): inside the window calls are counted, never refused.
        const limit = ceilingWithoutHeadroom(ctx, calls);
        if (limit !== undefined) return { status: 'refused', capped: true, summary: capped(limit), calls: { ...calls } };
      }
      const dispatch: Dispatch = { ...shared, mode: 'unattended', deadline, spent: { ...calls }, afterHandover: handovers > 0 };
      const attempt = placement === 'live' ? await dispatchLive(dispatch) : await dispatchHidden(dispatch, createScheduledConfirmGate());
      calls.ai += attempt.calls.ai;
      calls.net += attempt.calls.net;
      if (attempt.end.kind === 'handover') {
        if (handovers >= MAX_HANDOVERS) return withCap({ status: 'failed', summary: handedOverTwice(app.displayName), calls: { ...calls } });
        handovers += 1;
        placement = attempt.end.to;
        continue;
      }
      return withCap(outcomeOf(app, { ...attempt, calls: { ...calls } }, deps.resultTimeoutMs));
    }
  } finally {
    await ctx.db.driver.kvSet(appId, key, null);
  }
}

// ------------------------------------------------------------------ the live frame

/**
 * A run delivered to the app ON SCREEN. Waits for the frame to be READY (bounded by the announce
 * window and the deadline); an unattended run then begins its delegated record (the ask gate, the
 * counting seams and the access door all read it), writes the key, re-checks that the frame is
 * still there (F-3), hints through the registry and reads the result from the forwarded events —
 * the hinted generation's only. The app closing mid-run: `manual` → `failed` (M18); unattended → a
 * handover to the hidden frame, unless the user ANSWERED in this attempt (F-7) — an ALLOWED change
 * → `failed` by name, never a re-run; a DECISIVE refusal → `failed`, and the record carries the
 * user's answer for `outcomeOf`. The record is ended in `finally`, whatever happened, and is what
 * the attempt reports.
 */
async function dispatchLive(d: Dispatch): Promise<Attempt> {
  const { appId } = d.step;
  const { live } = d.deps;
  const runId = d.ctx.run.id;

  const ready = await Promise.race<boolean | 'aborted'>([live.awaitReady(appId, announceBoundMs(d)), abortedEnd(d.ctx.signal).then(() => 'aborted' as const)]);
  if (ready === 'aborted') return { end: { kind: 'aborted' }, calls: none(), refused: [] };
  const generation = live.generation(appId);
  if (!ready || generation === undefined) {
    if (live.has(appId) && generation !== undefined) {
      // Registered, never announced: the app has no listener — unless the deadline, not the announce window, ran out.
      return { end: remaining(d) <= 0 ? { kind: 'timeout' } : { kind: 'no-handler' }, calls: none(), refused: [] };
    }
    return { end: d.mode === 'unattended' ? { kind: 'handover', to: 'hidden' } : { kind: 'failed', message: APP_CLOSED_SUMMARY }, calls: none(), refused: [] };
  }

  let run: DelegatedRun | undefined;
  if (d.mode === 'unattended') {
    const begun = beginDelegatedRun({ appId, appName: d.app.displayName, runId, taskId: d.ctx.run.taskId, title: d.ctx.task.title, generation });
    if (!begun.ok) return { end: { kind: 'failed', message: begun.reason }, calls: none(), refused: [] };
    run = begun.run;
  }

  const result = deferred<ScheduleResult>();
  const interrupted = deferred<DispatchEnd>();
  /**
   * How the frame retracting ends THIS attempt, read at the moment it is needed (F-7): a manual run
   * `the app was closed` (M18); a delegated run after an ALLOWED call `closedAfterChange` and after
   * a DECISIVE refusal `the app was closed` — the record then carries the user's answer, which
   * `outcomeOf` reads first; a handover to the hidden frame only when the user never answered.
   */
  const retractionEnd = (): DispatchEnd => {
    if (run === undefined) return { kind: 'failed', message: APP_CLOSED_SUMMARY };
    if (run.granted > 0) return { kind: 'failed', message: closedAfterChange(d.app.displayName, run.grantedHost ?? 'the network') };
    if (run.refused.some(isDecisive)) return { kind: 'failed', message: APP_CLOSED_SUMMARY };
    return { kind: 'handover', to: 'hidden' };
  };
  /** What settled `interrupted`, if anything yet — read again after the kv write (F-3). */
  let interruption: DispatchEnd | undefined;
  let hinted = false;
  let seen = false;
  const unsubscribeEvents = live.subscribeEvents(appId, (event, data, from) => {
    // After the hint, once, this run — and ONLY from the generation that was hinted (security 5).
    if (!hinted || seen || event !== SCHEDULE_RESULT_EVENT || from !== generation) return;
    const parsed = parseScheduleResult(data, runId);
    if (parsed === undefined) return;
    seen = true;
    result.resolve(parsed);
  });
  const unwatch = live.subscribe((id, isLive) => {
    if (isLive || id !== appId || interruption !== undefined) return;
    interruption = retractionEnd();
    interrupted.resolve(interruption);
  });

  let end: DispatchEnd;
  let record: Pick<DelegatedRun, 'calls' | 'refused' | 'granted'> | undefined;
  try {
    const wrote = await d.ctx.db.driver.kvSet(appId, d.key, d.payload);
    // The write took time: the app may have closed meanwhile (F-3). A retracted frame is never hinted —
    // the attempt ends as the retraction decided, not `could not be reached`.
    const cut = interruption ?? (live.has(appId) ? undefined : retractionEnd());
    if (!wrote.ok) end = { kind: 'failed', message: wrote.message };
    else if (cut !== undefined) end = cut;
    else {
      hinted = true; // before the ring: an app may answer in the same tick
      if (!live.notify(appId, SCHEDULE_RUN_EVENT, { taskId: d.ctx.run.taskId, runId })) end = { kind: 'failed', message: APP_UNREACHABLE_SUMMARY };
      else end = await awaitResult(d.ctx, remaining(d), result.promise, interrupted.promise);
    }
  } finally {
    unwatch();
    unsubscribeEvents();
    // The run ends with the attempt (result, bound, cancel, handover): every parked scheduled confirm withdraws.
    if (run !== undefined) record = endDelegatedRun(appId, runId);
  }
  return { end, calls: record === undefined ? none() : { ...record.calls }, refused: record?.refused ?? [] };
}

// ---------------------------------------------------------------- the hidden frame

/**
 * An unattended run in the ONE hidden frame, under the refusing gate and the counting transport —
 * only when the app is closed. The app REGISTERING mid-attempt hands the run over to the live
 * frame: the attempt is cut — before the ring when it lands during the kv write (F-3), so a hidden
 * handler never starts after its handover is decided — the mount cleared, and the hidden frame's
 * unmount awaited (≤ 1 s, bounded by the deadline — F-8) so the two instances never overlap.
 */
async function dispatchHidden(d: Dispatch, gate: ScheduledConfirmGate): Promise<Attempt> {
  const { appId } = d.step;
  const runId = d.ctx.run.id;
  const html = d.ctx.db.getAppHtml(appId);
  if (html === undefined) return { end: { kind: 'blocked', message: appMissing.text }, calls: none(), refused: gate.refused };
  if (d.deps.mounts.get() !== undefined) return { end: { kind: 'failed', message: 'another scheduled run is still mounted' }, calls: none(), refused: gate.refused };

  // The counting seams (M22): this executor keeps the step's own count — the transport reports
  // each call that reached the brain (`onCounted`), the net handler asks before each request —
  // and both ceiling questions read it with what the run and the step's earlier attempts spent.
  let ai = 0;
  let net = 0;
  const soFar = (): Calls => ({ ai: d.spent.ai + ai, net: d.spent.net + net });
  const onNetCall = (): boolean => {
    if (!ceilingAllows(d.ctx, soFar(), { net: 1 })) return false;
    net += 1;
    return true;
  };
  // The db binding refuses a transaction or a whole-database import (cheap defence against a crash-stranded transaction).
  const runtime = d.deps.runtimeFor({ appId, driver: scheduledDbDriver(d.ctx.db.driver), confirmGate: gate, onNetCall });
  const transport = createScheduledTransport(runtime.transport, {
    onCall: () => ceilingAllows(d.ctx, soFar(), { ai: 1 }),
    onCounted: () => {
      ai += 1;
    },
  });
  const calls = (): Calls => ({ ai, net });

  const announce = deferred<void>();
  const result = deferred<ScheduleResult>();
  const interrupted = deferred<DispatchEnd>();
  const unmounted = deferred<void>();
  /** What settled `interrupted`, if anything yet — the first cut wins, and it is read again after the kv write (F-3). */
  let interruption: DispatchEnd | undefined;
  const cut = (end: DispatchEnd): void => {
    if (interruption !== undefined) return;
    interruption = end;
    interrupted.resolve(end);
  };
  let announced = false;
  let hinted = false;
  let seen = false;
  const controls: HiddenMount['controls'] = { current: null };
  const mount: HiddenMount = {
    appId,
    runId,
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
      const parsed = parseScheduleResult(data, runId);
      if (parsed === undefined) return;
      seen = true;
      result.resolve(parsed);
    },
    onNavigatedAway: () => cut({ kind: 'failed', message: 'the app left its sandbox' }),
    onBudgetExhausted: () => cut({ kind: 'failed', message: 'the app kept answering off-script' }),
    onUnmounted: () => unmounted.resolve(),
  };
  // The app OPENING hands the run over (ADR-0077 §5) — an unattended run only; a manual run is never hidden.
  const toLive: DispatchEnd = { kind: 'handover', to: 'live' };
  const unwatch =
    d.mode === 'unattended'
      ? d.deps.live.subscribe((id, isLive) => {
          if (isLive && id === appId) cut(toLive);
        })
      : (): void => undefined;
  if (d.mode === 'unattended' && d.deps.live.has(appId)) {
    unwatch();
    return { end: { kind: 'handover', to: 'live' }, calls: calls(), refused: gate.refused };
  }
  d.deps.mounts.set(mount);

  let end: DispatchEnd;
  try {
    const announceBound = timer(announceBoundMs(d));
    let first: AnnouncePhase;
    try {
      first = await Promise.race<AnnouncePhase>([
        announce.promise.then(() => ({ kind: 'announced' })),
        announceBound.promise.then(() => ({ kind: 'timeout' })),
        abortedEnd(d.ctx.signal),
        interrupted.promise,
      ]);
    } finally {
      announceBound.stop();
    }
    if (first.kind === 'timeout') end = remaining(d) <= 0 ? first : { kind: 'no-handler' };
    else if (first.kind !== 'announced') end = first;
    else {
      const wrote = await d.ctx.db.driver.kvSet(appId, d.key, d.payload);
      const host = controls.current;
      // The write took time: the app may have OPENED meanwhile (F-3) — its handover is decided, and a
      // hidden handler must never start after that, so the frame is not rung. (Any other cut that
      // landed during the write — the frame left its sandbox — is honoured the same way.)
      const cutMeanwhile = interruption ?? (d.mode === 'unattended' && d.deps.live.has(appId) ? toLive : undefined);
      if (!wrote.ok) end = { kind: 'failed', message: wrote.message };
      else if (cutMeanwhile !== undefined) end = cutMeanwhile;
      else if (host === null) end = { kind: 'failed', message: 'the hidden frame has no host' };
      else {
        hinted = true; // before the ring: the app may answer in the same tick
        host.notifyEvent(SCHEDULE_RUN_EVENT, { taskId: d.ctx.run.taskId, runId });
        end = await awaitResult(d.ctx, remaining(d), result.promise, interrupted.promise);
      }
    }
  } finally {
    unwatch();
    if (d.deps.mounts.get() === mount) d.deps.mounts.set(undefined);
  }
  if (end.kind === 'handover') {
    // Never two instances at once: the live hint waits for the hidden frame to report gone — bounded
    // by the deadline too (F-8), so the wait can never carry the step past it.
    const bound = timer(Math.min(HIDDEN_UNMOUNT_WAIT_MS, remaining(d)));
    try {
      await Promise.race([unmounted.promise, bound.promise]);
    } finally {
      bound.stop();
    }
  }
  return { end, calls: calls(), refused: gate.refused };
}
