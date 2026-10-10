// appRunHandshake.test.tsx — TASK-20261009-scheduling-framework A2/A3/A5 (ADR-0074 §3, §5, §6;
// security F5, F8, F16) and TASK-20261010-host-broker PR-1 (ADR-0077, one instance per app): the
// *Run [app]* executor and the kv handshake, over a REAL memory-backed user db with the frames
// FAKED — the test plays the hidden frame (announce, the lent controls, the app-event, the
// unmount) and the LIVE frame through the REAL registry (`state/appHosts.ts` — `fakeLive()`
// delegates to it, so the fake cannot drift from what RunView registers).
//
// What is pinned: the host writes EXACTLY `{ taskId, runId, input }` into the app's own kv and
// rings `schedule-run { taskId, runId }` (ids, never content); the committed CURRENT html runs;
// a result is accepted only from the frame that received the hint, after the hint, once, for
// this run, under a length cap and a strict parse — an unsolicited, duplicate, forged or
// oversized one is DROPPED; no announce → `no-handler`, no result → `failed`; the key is cleared
// on every exit, ONCE; an unattended run of a CLOSED app runs in the hidden frame under the
// refusing gate, and of an OPEN app is DELEGATED to the live frame (ADR-0077): hinted through the
// registry once the frame is ready, its mutating calls asked through the run-scoped gate (the
// REAL `state/net.ts` default — never a remembered or armed grant), its calls counted, the day's
// ceiling asked BEFORE dispatch, handed over between the frames at most once and never after a
// change went out, one deadline per step, the access door closed for the run's window; a manual
// run waits for the live frame to be ready; no scheduler seat → blocked by name; the C1
// negatives; and the PRODUCTION wire (`executeStep` → the real hidden mount store) — whose
// runtime composes `attended: false` (TASK-20261010-cross-app-access AC20: the hidden frame's
// access handler tells an ask that nobody is there, and never notes a reader generation).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ACCESS_ERROR_CODES, FRAME_TYPES, NET_ERROR_CODES, PROTOCOL_VERSION, type AccessRequestFrame } from '@snugprotocol/protocol';
import { ERROR_CODES, SCHEDULE_DAILY_CEILINGS, SCHEDULE_STEP_SUMMARY_MAX_CHARS, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions, RunnerHost } from '@snugprotocol/runner';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import {
  APP_CLOSED_SUMMARY,
  NO_HIDDEN_FRAME,
  SCHEDULE_ANNOUNCE_TIMEOUT_MS,
  SCHEDULE_RESULT_MAX_CHARS,
  SCHEDULE_RESULT_TIMEOUT_MS,
  appDidNotAnswer,
  blockedAppRunDeps,
  executeAppRun,
  hiddenMountStore,
  openAndRunAgain,
  parseScheduleResult,
  type AppRunDeps,
  type AppRunRuntimeInput,
  type AppRunStep,
  type HiddenMount,
  type LiveAppHosts,
} from '../schedule/appRun.js';
import {
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
} from '../schedule/copy.js';
import type { StepContext } from '../schedule/engine-types.js';
import { CANCELLED_SUMMARY, WITHHELD_SUMMARY, createStepExecutor, executeStep } from '../schedule/executors.js';
import { DEFAULT_RUN_BOUNDS } from '../schedule/queue.js';
import { SCHEDULE_RESULT_EVENT, SCHEDULE_RUN_EVENT, scheduleKvKey } from '../schedule/scheduleKey.js';
import { scheduledRefusalVerb, type ScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { SCHEDULED_AI_LIMIT_MESSAGE } from '../schedule/scheduledTransport.js';
import { createAccessHandlerFor } from '../access/accessHandler.js';
import { collectSources } from '../access/consent.js';
import { ACCESS_APP_MESSAGES } from '../access/copy.js';
import { __setAccessDepsForTests, createGrantFromDecision, readerGeneration, resetAccessSession, type AnyAccessGrant } from '../access/grants.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import { composeAppRuntime } from '../run/appRuntime.js';
import {
  __resetAppHostsForTest,
  awaitAppHostReady,
  hasLiveAppHost,
  liveAppHostGeneration,
  markAppHostAnnounced,
  notifyAppHost,
  publishAppEvent,
  registerAppHost,
  setAppHostGeneration,
  subscribeAppEvents,
  subscribeAppHosts,
} from '../state/appHosts.js';
import { modeStore, providerStore } from '../state/mode.js';
import { __resetNetStateForTests, armStandingApproval, netConfirmStore, resolveNetConfirm } from '../state/net.js';
import { createStore } from '../state/store.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

const NOW = '2026-10-09T15:00:00.000Z';
const RUN_ID = 'run-1';
const SEAT: SnugPlatform = {
  kind: 'web',
  scheduler: { wakeMode: 'page', hostLabel: 'this tab' },
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
};
const NO_SEAT: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };

let db: UserDb;
let appId: string;

function task(steps: ScheduleStep[]): ScheduledTask {
  return {
    id: 'task-1',
    title: 'morning weather',
    enabled: true,
    enabledAt: NOW,
    provenance: 'user',
    steps,
    spec: { kind: 'daily', time: '08:00', tz: 'device' },
    cron: '0 8 * * *',
    missedPolicy: 'ask',
    staleAfterMs: 60_000,
    alert: 'inbox',
    appVersions: {},
    createdAt: NOW,
    updatedAt: NOW,
    consecutiveFailures: 0,
    unseenResults: 0,
  };
}

interface Ctx {
  context: StepContext;
  interrupt: ReturnType<typeof vi.fn>;
  controller: AbortController;
}

function ctx(
  step: ScheduleStep,
  over: { trigger?: StepContext['run']['trigger']; spent?: () => { ai: number; net: number }; runId?: string; now?: () => Date } = {},
): Ctx {
  const interrupt = vi.fn();
  const controller = new AbortController();
  const context: StepContext = {
    task: task([step]),
    run: { id: over.runId ?? RUN_ID, taskId: 'task-1', dueAt: NOW, trigger: over.trigger ?? 'due' },
    db,
    signal: controller.signal,
    now: over.now ?? (() => new Date(NOW)),
    interrupt,
    ...(over.spent !== undefined ? { spent: over.spent } : {}),
  };
  return { context, interrupt, controller };
}

/** The generation RunView's `frameEpoch` gives the open app in these tests (not 0, so a missed `setAppHostGeneration` shows). */
const LIVE_GENERATION = 1;

interface FakeLive extends LiveAppHosts {
  /** What the LIVE frame was rung with — recorded by the notify RunView lends the registry. */
  notified: Array<{ appId: string; event: string; data: unknown }>;
  /** RunView mounting: register on `[id]`, set the generation on `[id, frameEpoch]`, and (by default) the frame's announce. */
  open(appId: string, options?: { generation?: number; announce?: boolean }): void;
  /** The open frame's `onAnnounce` (deps gain `frameEpoch`). */
  announce(appId: string): void;
  /** RunView unmounting: the token-scoped unregister — a retraction. */
  close(appId: string): void;
  /** The open frame's `onAppEvent` → `publishAppEvent(id, event, data, frameEpoch)`; another generation may be named. */
  emit(appId: string, event: string, data: unknown, generation?: number): void;
}

/**
 * The live frame, played through the REAL `state/appHosts.ts` (ADR-0077 contract: the fake
 * DELEGATES so it cannot drift). Only what RunView itself holds lives here: its notify (which
 * records the hint) and its unregister.
 */
function fakeLive(): FakeLive {
  const notified: FakeLive['notified'] = [];
  const views = new Map<string, { unregister: () => void; generation: number }>();
  const generationOf = (id: string): number => views.get(id)?.generation ?? LIVE_GENERATION;
  return {
    notified,
    has: (id) => hasLiveAppHost(id),
    notify: (id, event, data) => notifyAppHost(id, event, data),
    subscribe: (listener) => subscribeAppHosts(listener),
    subscribeEvents: (id, listener) => subscribeAppEvents(id, listener),
    awaitReady: (id, ms) => awaitAppHostReady(id, ms),
    generation: (id) => liveAppHostGeneration(id),
    open: (id, { generation = LIVE_GENERATION, announce = true } = {}) => {
      const unregister = registerAppHost(id, (event, data) => {
        notified.push({ appId: id, event, data });
      });
      views.set(id, { unregister, generation });
      setAppHostGeneration(id, generation);
      if (announce) markAppHostAnnounced(id, generation);
    },
    announce: (id) => markAppHostAnnounced(id, generationOf(id)),
    close: (id) => {
      views.get(id)?.unregister();
      views.delete(id);
    },
    emit: (id, event, data, generation = generationOf(id)) => publishAppEvent(id, event, data, generation),
  };
}

interface Inner extends AgentTransport {
  sends: Array<{ wire: string; options: AgentTransportOptions }>;
}

interface Fake extends AppRunDeps {
  live: FakeLive;
  runtimeCalls: AppRunRuntimeInput[];
  brain: Inner;
}

function fakeDeps(over: Partial<Omit<AppRunDeps, 'live'>> = {}, reply = '{"answer":"ok"}'): Fake {
  const sends: Inner['sends'] = [];
  const brain: Inner = {
    sends,
    send: async (wire, options) => {
      sends.push({ wire, options });
      return { ok: true, text: reply };
    },
  };
  const runtimeCalls: AppRunRuntimeInput[] = [];
  const live = fakeLive();
  return {
    brain,
    runtimeCalls,
    live,
    platform: () => SEAT,
    runtimeFor: (input) => {
      runtimeCalls.push(input);
      return { transport: brain, frameProps: { db: db.driver, dbNamespace: input.appId } };
    },
    mounts: createStore<HiddenMount | undefined>(undefined),
    announceTimeoutMs: 40,
    resultTimeoutMs: 60,
    ...over,
  };
}

/** The frame the test plays: waits for the executor's mount request and lends it recording controls. */
async function mounted(deps: AppRunDeps): Promise<{ mount: HiddenMount; host: RunnerHost & { notifyEvent: ReturnType<typeof vi.fn> } }> {
  await vi.waitFor(() => expect(deps.mounts.get()).toBeDefined());
  const mount = deps.mounts.get()!;
  const host = { notifyEvent: vi.fn(), destroy: vi.fn(), reset: vi.fn(), setTheme: vi.fn() } as RunnerHost & { notifyEvent: ReturnType<typeof vi.fn> };
  mount.controls.current = host;
  return { mount, host };
}

/** Announce, then wait for the hint — the point from which the app may answer. */
async function hinted(deps: AppRunDeps): Promise<{ mount: HiddenMount; host: RunnerHost & { notifyEvent: ReturnType<typeof vi.fn> } }> {
  const frame = await mounted(deps);
  frame.mount.onAnnounce();
  await vi.waitFor(() => expect(frame.host.notifyEvent).toHaveBeenCalled());
  return frame;
}

const kv = async (id = appId, runId = RUN_ID) => db.driver.kvGet(id, scheduleKvKey(runId));
const kvValue = async (id = appId, runId = RUN_ID): Promise<unknown> => {
  const read = await kv(id, runId);
  return read.ok ? read.value : read;
};
const send = (transport: AgentTransport) => transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: new AbortController().signal });

// ---------------------------------------------------------------- the delegated-run harness (ADR-0077)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every hidden mount the executor ever set on this composition — "never mounted" means this stays empty. */
function watchMounts(deps: AppRunDeps): HiddenMount[] {
  const seen: HiddenMount[] = [];
  deps.mounts.subscribe(() => {
    const mount = deps.mounts.get();
    if (mount !== undefined) seen.push(mount);
  });
  return seen;
}

type KvSpy = MockInstance<UserDb['driver']['kvSet']>;
/** The executor's kv calls for THIS run's key (it calls the file's driver directly, never the frame's binding). */
const spyKv = (): KvSpy => vi.spyOn(db.driver, 'kvSet');
const runKeyCalls = (spy: KvSpy, runId = RUN_ID) => spy.mock.calls.filter(([id, key]) => id === appId && key === scheduleKvKey(runId));
const writesOf = (spy: KvSpy, runId = RUN_ID) => runKeyCalls(spy, runId).filter(([, , value]) => value !== null);
const clearsOf = (spy: KvSpy, runId = RUN_ID) => runKeyCalls(spy, runId).filter(([, , value]) => value === null);

/** The delegated run's hint reached the LIVE frame (through the registry's notify). */
async function delegatedHint(deps: Fake): Promise<void> {
  await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
  expect(deps.live.notified[0]).toEqual({ appId, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: RUN_ID } });
}

const SLOT = 'example';
const API_HOST = 'api.example.com';
const requirement = {
  slot: SLOT,
  kind: 'api_key' as const,
  provider: { name: 'Example' },
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: [API_HOST],
};

/** Weather gets an approved connection to the example host (the `scheduledGate.test.ts` seed). */
function connectWeather(): void {
  db.setSecret(`auth:${appId}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(appId, SLOT, requirement, 'inference');
  db.approveConnection(appId, SLOT);
}

const THREAD_JID = 'thread-1';
const netFrame = (method: 'GET' | 'POST', url = `https://${API_HOST}/v1/items`, body = '{}') => ({
  v: 1 as const,
  type: 'snug:net-request' as const,
  requestId: `r-${method}-${Math.random().toString(36).slice(2)}`,
  instanceId: 'live-1',
  url,
  method,
  ...(method === 'POST' ? { body } : {}),
});
/**
 * A send into the armed thread — what an ARMED standing grant answers yes to on the ordinary gate.
 * Symbolic (`snug-connection://<slot>/…`): only that path hands the gate a `slot`, and a standing
 * grant never answers a request without one (`standing-approval.ts`).
 */
const threadPost = () => netFrame('POST', `snug-connection://${SLOT}/chats/${THREAD_JID}/messages`, JSON.stringify({ jid: THREAD_JID, text: 'hi' }));
const POST_VERB = scheduledRefusalVerb({ host: API_HOST, method: 'POST' }); // "post to api.example.com"

function recordingFetch(): { fetched: string[]; fetchImpl: (url: string, init?: RequestInit) => Promise<Response> } {
  const fetched: string[] = [];
  return {
    fetched,
    fetchImpl: async (url) => {
      fetched.push(url);
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

/**
 * The LIVE frame's runtime exactly as RunView composes it — `attended: true` at its generation, NO
 * confirm gate passed (so the net handler carries `state/net.ts`'s DEFAULT, the run-scoped gate),
 * no counting seam passed (so the composition's own default counts into the delegated run).
 */
function liveRuntime(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, generation = LIVE_GENERATION) {
  const runtime = composeAppRuntime({ appId, attended: true, generation, mode: modeStore.get(), provider: providerStore.get(), driver: db.driver, fetchImpl });
  const { net } = runtime.frameProps;
  if (net === undefined) throw new Error('an owned app on this platform reaches the network');
  return { ...runtime, net };
}

/** Fake timers for the minute-long bounds: timers and `Date` only (sql.js and promises keep running). */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date(NOW));
}
const clockNow = (): Date => new Date(Date.now());

beforeEach(async () => {
  __resetAppHostsForTest();
  hiddenMountStore.set(undefined);
  db = await installTestUserDb();
  appId = db.installApp({ displayName: 'Weather', html: '<html>v1</html>' }).appId;
});

afterEach(() => {
  hiddenMountStore.set(undefined);
  __resetAppHostsForTest();
});

describe('the hidden frame — the handshake end to end (A2, A3)', () => {
  it('mounts the app’s CURRENT html, writes exactly { taskId, runId, input } on announce, rings ids only, reads ONE result, clears the key, unmounts', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId, input: { city: 'Oslo' } };
    const { context } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    const { mount, host } = await mounted(deps);
    expect(mount).toMatchObject({ appId, runId: RUN_ID, html: '<html>v1</html>' });
    expect(mount.frameProps).toEqual({ db: db.driver, dbNamespace: appId });
    expect('value' in (await kv())).toBe(false); // nothing written before the app is there to read it

    mount.onAnnounce();
    await vi.waitFor(() => expect(host.notifyEvent).toHaveBeenCalledTimes(1));
    expect(host.notifyEvent).toHaveBeenCalledWith(SCHEDULE_RUN_EVENT, { taskId: 'task-1', runId: RUN_ID });
    const written = await kvValue();
    expect(written).toEqual({ taskId: 'task-1', runId: RUN_ID, input: { city: 'Oslo' } });
    expect(Object.keys(written as object).sort()).toEqual(['input', 'runId', 'taskId']); // C1: nothing else from the task or the file rides the kv

    expect((await send(mount.transport)).ok).toBe(true); // the app thinks once
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { runId: RUN_ID, ok: true, summary: 'sunny, 18°', notify: { title: 'Weather', body: 'sunny, 18°' } });
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'ok', summary: 'sunny, 18°', calls: { ai: 1, net: 0 }, alert: { title: 'Weather', body: 'sunny, 18°' } });
    expect('value' in (await kv())).toBe(false);
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('only the committed CURRENT version runs — a newer saved version is what mounts', async () => {
    db.saveAppVersion(appId, '<html>v2</html>', 'an edit');
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, controller } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    const { mount } = await mounted(deps);
    expect(mount.html).toBe('<html>v2</html>');
    controller.abort();
    await pending;
  });

  it('a step without input writes { taskId, runId } — no `input` key invented', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    expect(await kvValue()).toEqual({ taskId: 'task-1', runId: RUN_ID });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    expect((await pending).status).toBe('ok');
  });

  it('no announce within the bound → `no-handler` with the copy’s sentence; nothing was written; the frame is gone', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    await mounted(deps);
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'no-handler', summary: noHandler('Weather').text, calls: { ai: 0, net: 0 } });
    expect('value' in (await kv())).toBe(false);
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('announced but never answered → `failed` with the bound named; the key is cleared', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    await hinted(deps);
    expect(await kvValue()).toEqual({ taskId: 'task-1', runId: RUN_ID });
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'failed', summary: appDidNotAnswer(60), calls: { ai: 0, net: 0 } });
    expect(appDidNotAnswer(90_000)).toBe('the app didn’t answer within 90 s'); // what the production bound reads as
    expect('value' in (await kv())).toBe(false);
  });

  it('an app that reports ok:false is a `failed` step carrying its summary', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: false, summary: 'the forecast service is down' });
    expect(await pending).toEqual({ status: 'failed', summary: 'the forecast service is down', calls: { ai: 0, net: 0 } });
  });

  it('the frame’s failure signals end the run as `failed` by name: navigated away, budget exhausted', async () => {
    for (const [signal, message] of [
      ['onNavigatedAway', 'the app left its sandbox'],
      ['onBudgetExhausted', 'the app kept answering off-script'],
    ] as const) {
      const deps = fakeDeps();
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step).context, deps);
      const { mount } = await mounted(deps);
      mount[signal]();
      expect((await pending).summary, signal).toBe(message);
      expect(deps.mounts.get()).toBeUndefined();
    }
  });
});

describe('the result is bound to the frame and the run, once, capped (F8)', () => {
  it('UNSOLICITED: a result before the hint is dropped; the one after lands', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount, host } = await mounted(deps);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'early' });
    mount.onAnnounce();
    await vi.waitFor(() => expect(host.notifyEvent).toHaveBeenCalled());
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'late' });
    expect((await pending).summary).toBe('late');
  });

  it('DUPLICATE: the second result is dropped — the first is the outcome', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'first' });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: false, summary: 'second' });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'first' });
  });

  it('FORGED: a result through another frame’s closure, or naming another run, never lands on this run', async () => {
    const deps = fakeDeps();
    const stepA: AppRunStep = { kind: 'app-run', appId };
    const first = executeAppRun(stepA, ctx(stepA, { runId: 'run-a' }).context, deps);
    const frameA = await hinted(deps);
    frameA.mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'a done' });
    await first;

    const second = executeAppRun(stepA, ctx(stepA, { runId: 'run-b' }).context, deps);
    const frameB = await hinted(deps);
    frameA.mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'forged through the old frame' }); // a stale closure (a visible app's events never reach this one either)
    frameB.mount.onAppEvent(SCHEDULE_RESULT_EVENT, { runId: 'run-a', ok: true, summary: 'forged for another run' });
    frameB.mount.onAppEvent(SCHEDULE_RESULT_EVENT, { runId: 'run-b', ok: true, summary: 'real' });
    expect((await second).summary).toBe('real');
  });

  it('OVERSIZED: a result past the serialised cap, or past a field’s cap, is dropped before and at the strict parse', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'x'.repeat(SCHEDULE_RESULT_MAX_CHARS + 1) });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'y'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS + 1) });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'fits', extra: 'an unknown field is a drop too' });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'fits' });
    expect((await pending).summary).toBe('fits');
  });

  it('parseScheduleResult: the cap runs BEFORE the parse, the parse is strict, a runId that disagrees is a drop', () => {
    expect(parseScheduleResult({ ok: true }, RUN_ID)).toEqual({ ok: true });
    expect(parseScheduleResult({ ok: true, runId: RUN_ID }, RUN_ID)).toEqual({ ok: true, runId: RUN_ID });
    expect(parseScheduleResult({ ok: true, runId: 'other' }, RUN_ID)).toBeUndefined();
    expect(parseScheduleResult({ ok: 'yes' }, RUN_ID)).toBeUndefined();
    expect(parseScheduleResult({ ok: true, notify: { title: '', body: 'x' } }, RUN_ID)).toBeUndefined();
    expect(parseScheduleResult({ ok: true, notify: { title: 't', body: 'b'.repeat(121) } }, RUN_ID)).toBeUndefined();
    expect(parseScheduleResult('a string', RUN_ID)).toBeUndefined();
    expect(parseScheduleResult(undefined, RUN_ID)).toBeUndefined();
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    expect(parseScheduleResult(circular, RUN_ID)).toBeUndefined();
  });

  it('other app-events are ignored — only `schedule-result` is read', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    mount.onAppEvent('resize', { ok: true, summary: 'not a result' });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'the result' });
    expect((await pending).summary).toBe('the result');
  });
});

describe('opening the app does not stop its scheduled run (owner decision 2026-10-09, TASK-20261009-scheduled-run-open-app)', () => {
  it('a RunView mounting the same app mid-run HANDS THE RUN OVER (ADR-0077 §5): no `interrupt`; the hidden attempt is cut and its frame cleared; the SAME runId is hinted to the live frame only AFTER the hidden frame reports unmounted; the live result lands; the key is written per dispatch and cleared once', async () => {
    const deps = fakeDeps({ resultTimeoutMs: 5_000 });
    const kvSet = spyKv();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, interrupt } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    const { mount } = await hinted(deps);
    deps.live.open(appId);
    expect(interrupt).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(deps.mounts.get()).toBeUndefined());
    await sleep(30);
    expect(deps.live.notified, 'no live hint while the hidden instance may still be running').toEqual([]);
    mount.onUnmounted();
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
    expect(deps.live.notified[0]).toEqual({ appId, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: RUN_ID } });
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from the cut hidden attempt' }); // its closure no longer settles anything
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'ran while you looked' });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'ran while you looked' });
    expect(deps.mounts.get()).toBeUndefined();
    expect(writesOf(kvSet)).toHaveLength(2);
    expect(clearsOf(kvSet)).toHaveLength(1);
    expect('value' in (await kv())).toBe(false);
  });

  it('ANOTHER app opening does not touch the run', async () => {
    const other = db.installApp({ displayName: 'Ledger', html: '<html>l</html>' }).appId;
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, interrupt } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    const { mount } = await hinted(deps);
    deps.live.open(other);
    expect(interrupt).not.toHaveBeenCalled();
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'done' });
    expect((await pending).status).toBe('ok');
  });

  it('the queue’s own abort (the bound, a cancel, a file swap) ends the step as cancelled and clears everything', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, controller } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    await hinted(deps);
    controller.abort();
    expect(await pending).toEqual({ status: 'failed', summary: CANCELLED_SUMMARY, calls: { ai: 0, net: 0 } });
    expect(deps.mounts.get()).toBeUndefined();
    expect('value' in (await kv())).toBe(false);
  });
});

describe('the gate follows the trigger, and its record outranks the app’s answer (A5)', () => {
  it('every unattended trigger (due, late, catch-up) composes the hidden frame with the refusing gate WHEN THE APP IS CLOSED', async () => {
    for (const trigger of ['due', 'late', 'catch-up'] as const) {
      const deps = fakeDeps();
      const step: AppRunStep = { kind: 'app-run', appId };
      const { context, controller } = ctx(step, { trigger });
      const pending = executeAppRun(step, context, deps);
      await mounted(deps);
      const gate = deps.runtimeCalls[0]!.confirmGate;
      expect(gate, trigger).toBeDefined();
      expect((gate as ScheduledConfirmGate).refused, trigger).toEqual([]);
      expect(gate!.confirm({ appId, host: 'api.github.com', method: 'POST', url: 'https://api.github.com/x' }), trigger).toBe(false);
      controller.abort();
      await pending;
    }
  });

  it('a manual run NEVER gets a hidden frame: with the app closed it is refused by name — "open Weather and run it again" — nothing mounted, nothing composed, nothing written', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId, input: { city: 'Oslo' } };
    const outcome = await executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    expect(outcome).toEqual({ status: 'refused', summary: openAndRunAgain('Weather'), calls: { ai: 0, net: 0 } });
    expect(outcome.summary).toBe('open Weather and run it again');
    expect(deps.mounts.get()).toBeUndefined();
    expect(deps.runtimeCalls).toEqual([]);
    expect(deps.live.notified).toEqual([]);
    expect('value' in (await kv())).toBe(false);
  });

  it('a refused mutating call makes the step `refused` with the needs-you sentence — even when the app then reports ok', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    const gate = deps.runtimeCalls[0]!.confirmGate as ScheduledConfirmGate;
    expect(gate.confirm({ appId, host: 'api.github.com', method: 'POST', url: 'https://api.github.com/repos/x/issues' })).toBe(false);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'posted the issue' });
    const outcome = await pending;
    expect(outcome).toEqual({ status: 'refused', summary: needsYou('Weather', 'post to api.github.com').text, calls: { ai: 0, net: 0 } });
    expect(outcome.summary).toBe('Weather needs your OK — Snug doesn’t post to api.github.com while you’re away');
  });

  it('a refusal followed by silence is still `refused`, not `failed` — the user is told what to review', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    await hinted(deps);
    (deps.runtimeCalls[0]!.confirmGate as ScheduledConfirmGate).confirm({ appId, host: 'hooks.slack.com', method: 'POST', url: 'https://hooks.slack.com/x' });
    expect((await pending).status).toBe('refused');
  });
});

describe('what the run spends is counted and capped (A4, A5)', () => {
  it('net calls the handler reports ride the outcome; the day’s ceiling, PLUS what the run already spent, refuses the next', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const spentBefore = { ai: 0, net: SCHEDULE_DAILY_CEILINGS.net - 2 };
    const pending = executeAppRun(step, ctx(step, { spent: () => spentBefore }).context, deps);
    const { mount } = await hinted(deps);
    const { onNetCall } = deps.runtimeCalls[0]!;
    expect(onNetCall()).toBe(true);
    expect(onNetCall()).toBe(true); // reaching the ceiling exactly is allowed
    expect(onNetCall()).toBe(false); // one past it is not
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'fetched' });
    expect((await pending).calls).toEqual({ ai: 0, net: 2 });
  });

  it('the file’s counters count too: a day already at the net ceiling refuses the first call', async () => {
    db.setSchedulerState({ watermark: NOW, globalPause: false, daily: { date: NOW.slice(0, 10), ai: 0, net: SCHEDULE_DAILY_CEILINGS.net } });
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    expect(deps.runtimeCalls[0]!.onNetCall()).toBe(false);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    expect((await pending).calls).toEqual({ ai: 0, net: 0 });
  });

  it('AI calls through the hidden frame’s transport are counted on the outcome and refused at the ceiling', async () => {
    db.setSchedulerState({ watermark: NOW, globalPause: false, daily: { date: NOW.slice(0, 10), ai: SCHEDULE_DAILY_CEILINGS.ai - 1, net: 0 } });
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    expect((await send(mount.transport)).ok).toBe(true);
    expect(await send(mount.transport)).toEqual({ ok: false, code: ERROR_CODES.HOST_ERROR, message: SCHEDULED_AI_LIMIT_MESSAGE, retryable: false });
    expect(deps.brain.sends).toHaveLength(1);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    expect((await pending).calls).toEqual({ ai: 1, net: 0 });
  });
});

describe('the app CLOSED — the hidden frame alone, the one instance (ADR-0077 §1, §7)', () => {
  it('a result published through the live registry is never taken for the hidden run — only the hidden frame’s own answer settles it', async () => {
    const deps = fakeDeps({ resultTimeoutMs: 5_000 }); // long enough that only an answer can settle it
    const step: AppRunStep = { kind: 'app-run', appId };
    let settled = false;
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps).then((o) => {
      settled = true;
      return o;
    });
    const { mount } = await hinted(deps);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'through the registry', runId: RUN_ID });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from the hidden copy' });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'from the hidden copy' });
  });

  it('the hidden run’s db binding is the scheduled guard: a BEGIN is refused by name, a plain read passes', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
    const { mount } = await hinted(deps);
    const driver = deps.runtimeCalls[0]!.driver;
    expect(driver).not.toBe(db.driver);
    const req = (over: Record<string, unknown>) => ({ v: 1, type: 'snug:db-request', requestId: 'r', instanceId: 'i', ...over }) as never;
    expect(await driver.handle(appId, req({ op: 'exec', sql: 'BEGIN' }))).toMatchObject({ ok: false });
    expect((await driver.handle(appId, req({ op: 'exec', sql: 'SELECT 1' }))).ok).toBe(true);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
  });
});

describe('an unattended run of an OPEN app is DELEGATED to the live frame — no second copy (ADR-0077, amending the owner decision 2026-10-09)', () => {
  it('due / late / catch-up with the app LIVE → DELEGATED: the live frame is hinted through the registry, no hidden mount ever, no runtime of ours composed, the app’s result recorded, the key written and cleared once', async () => {
    for (const trigger of ['due', 'late', 'catch-up'] as const) {
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      const mounts = watchMounts(deps);
      const kvSet = spyKv();
      deps.live.open(appId);
      const step: AppRunStep = { kind: 'app-run', appId, input: { city: 'Oslo' } };
      const pending = executeAppRun(step, ctx(step, { trigger }).context, deps);
      await vi.waitFor(() => expect(deps.live.notified, trigger).toHaveLength(1));
      expect(deps.live.notified[0], trigger).toEqual({ appId, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: RUN_ID } });
      expect(await kvValue(), trigger).toEqual({ taskId: 'task-1', runId: RUN_ID, input: { city: 'Oslo' } });
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'Oslo: dry until noon' });
      expect(await pending, trigger).toMatchObject({ status: 'ok', summary: 'Oslo: dry until noon', calls: { ai: 0, net: 0 } });
      expect(mounts, trigger).toEqual([]);
      expect(deps.runtimeCalls, trigger).toEqual([]); // the open app's own runtime, not one of ours
      expect(writesOf(kvSet), trigger).toHaveLength(1);
      expect(clearsOf(kvSet), trigger).toHaveLength(1);
      expect('value' in (await kv()), trigger).toBe(false);
      kvSet.mockRestore();
      deps.live.close(appId);
    }
  });

  it('a mutating call in that run reaches the ASK gate (the real `state/net.ts` default): a confirm parks tagged with the schedule; “don’t send” → `refused` with the declined sentence — even when the app then reports ok', async () => {
    connectWeather();
    const deps = fakeDeps({ resultTimeoutMs: 5_000 });
    deps.live.open(appId);
    const { fetched, fetchImpl } = recordingFetch();
    const live = liveRuntime(fetchImpl);
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
    await delegatedHint(deps);
    const post = live.net.handle(appId, netFrame('POST', `https://${API_HOST}/repos/x/issues`));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    expect(netConfirmStore.get()!.scheduled).toEqual({ title: 'morning weather', appName: 'Weather', runId: RUN_ID });
    resolveNetConfirm({ granted: false });
    expect(await post).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(fetched).toEqual([]);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'posted' });
    const outcome = await pending;
    expect(outcome.status).toBe('refused');
    expect(outcome.summary).toBe(needsYouDeclined('Weather', POST_VERB).text);
  });

  it('the old open-app refusal is gone from the executor’s exports', async () => {
    const mod = await import('../schedule/appRun.js');
    expect('APP_OPEN_REFUSAL' in mod).toBe(false);
  });
});

// ADR-0077 / TASK-20261010-host-broker PR-1 (Gate-2 contract v2): what a DELEGATED run promises
// beyond the inverted pins above. The live frame is played through the REAL registry and, where a
// call leaves the app, through the runtime RunView composes — so the gate under test is the page's
// own default (`state/net.ts`), never a stand-in.
describe('a delegated run — the app is OPEN (ADR-0077)', () => {
  beforeEach(() => {
    __resetNetStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetNetStateForTests();
    resetAccessSession();
    resetScopedReadForTests();
    __setAccessDepsForTests();
    vi.restoreAllMocks();
  });

  describe('AC2 — a mutating call asks the person at the app, never a remembered or armed grant', () => {
    it('nobody answers within 60 s → the parked confirm is WITHDRAWN, the app is told no, nothing is sent, and the step is `refused` with the unanswered sentence', async () => {
      fakeClock();
      connectWeather();
      const deps = fakeDeps({ resultTimeoutMs: SCHEDULE_RESULT_TIMEOUT_MS });
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due', now: clockNow }).context, deps);
      await delegatedHint(deps);
      let answered = false;
      const post = live.net.handle(appId, netFrame('POST')).then((result) => {
        answered = true;
        return result;
      });
      await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toEqual({ title: 'morning weather', appName: 'Weather', runId: RUN_ID }));
      await vi.advanceTimersByTimeAsync(55_000);
      expect(answered, 'still asking inside the minute').toBe(false);
      expect(netConfirmStore.get()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(answered, 'the minute is up').toBe(true);
      expect(await post).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
      expect(netConfirmStore.get(), 'the timed-out ask no longer blocks the dialog queue').toBeNull();
      expect(fetched).toEqual([]);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'posted' });
      const outcome = await pending;
      expect(outcome.status).toBe('refused');
      expect(outcome.summary).toBe(needsYouUnanswered('Weather', POST_VERB).text);
    });

    it('NEGATIVE: a REMEMBERED session grant for the same host and method is not consulted — the open app’s POST passes unasked before the run, and still parks a scheduled confirm during it', async () => {
      connectWeather();
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      // The user, present, remembers a POST to the host for the session (the real dialog's act).
      const first = live.net.handle(appId, netFrame('POST'));
      await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
      expect(netConfirmStore.get()!.scheduled).toBeUndefined();
      resolveNetConfirm({ granted: true, rememberSession: true });
      expect((await first).ok).toBe(true);
      expect((await live.net.handle(appId, netFrame('POST'))).ok, 'the remembered grant answers the open app').toBe(true);
      expect(netConfirmStore.get()).toBeNull();
      const sentBefore = fetched.length;

      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await delegatedHint(deps);
      const during = live.net.handle(appId, netFrame('POST')); // the SAME handler: the gate consults the run store per request
      await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toEqual({ title: 'morning weather', appName: 'Weather', runId: RUN_ID }));
      resolveNetConfirm({ granted: false });
      expect(await during).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
      expect(fetched).toHaveLength(sentBefore);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true });
      expect((await pending).summary).toBe(needsYouDeclined('Weather', POST_VERB).text);
    });

    it('NEGATIVE: an ARMED standing grant for the thread is not consulted — it answers the open app’s POST before the run, and the scheduled confirm still parks during it', async () => {
      connectWeather();
      armStandingApproval({ appId, slot: SLOT, threadJid: THREAD_JID, trigger: 'all', maxPerWindow: 10, windowMs: 60_000, armedAt: Date.now(), sends: [] });
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      expect((await live.net.handle(appId, threadPost())).ok, 'the armed grant answers the open app').toBe(true);
      expect(netConfirmStore.get()).toBeNull();
      const sentBefore = fetched.length;

      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await delegatedHint(deps);
      const during = live.net.handle(appId, threadPost());
      await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toEqual({ title: 'morning weather', appName: 'Weather', runId: RUN_ID }));
      resolveNetConfirm({ granted: false });
      expect(await during).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
      expect(fetched).toHaveLength(sentBefore);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true });
      expect((await pending).status).toBe('refused');
    });

    it('D-PR1-9: a second mutating call while the first is parked is refused AT ONCE and recorded `already-asked` — no second dialog queues behind the first', async () => {
      connectWeather();
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await delegatedHint(deps);
      const first = live.net.handle(appId, netFrame('POST'));
      await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toBeDefined());
      const head = netConfirmStore.get();
      const second = await Promise.race([live.net.handle(appId, netFrame('POST', `https://${API_HOST}/v1/other`)), sleep(500).then(() => 'still parked' as const)]);
      expect(second, 'refused at once, never parked').toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
      expect(netConfirmStore.get()).toBe(head);
      resolveNetConfirm({ granted: true });
      expect((await first).ok).toBe(true);
      expect(netConfirmStore.get(), 'nothing was queued behind the first ask').toBeNull();
      expect(fetched).toEqual([`https://${API_HOST}/v1/items`]);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true });
      const outcome = await pending;
      expect(outcome.status).toBe('refused');
      expect(outcome.summary).toBe(needsYouAlreadyAsked('Weather', POST_VERB).text);
    });
  });

  describe('AC4 — the run follows the app: once, and never after a change went out', () => {
    it('live → hidden: the app CLOSING mid-run (nothing granted) re-dispatches the SAME runId to the hidden frame under the refusing gate; its result lands; the key is written per dispatch and cleared once', async () => {
      // announceTimeoutMs as the AC5 tests: the default 40 ms is shorter than `vi.waitFor`'s 50 ms
      // poll, so the re-dispatched hidden mount could time out before the test announces it.
      const deps = fakeDeps({ announceTimeoutMs: 2_000, resultTimeoutMs: 5_000 });
      const kvSet = spyKv();
      deps.live.open(appId);
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await delegatedHint(deps);
      deps.live.close(appId);
      const { mount, host } = await hinted(deps);
      expect(host.notifyEvent).toHaveBeenCalledWith(SCHEDULE_RUN_EVENT, { taskId: 'task-1', runId: RUN_ID });
      expect(deps.runtimeCalls).toHaveLength(1);
      expect((deps.runtimeCalls[0]!.confirmGate as ScheduledConfirmGate).refused).toEqual([]);
      mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'finished out of sight' });
      expect(await pending).toMatchObject({ status: 'ok', summary: 'finished out of sight' });
      expect(writesOf(kvSet)).toHaveLength(2);
      expect(clearsOf(kvSet)).toHaveLength(1);
      expect('value' in (await kv())).toBe(false);
    });

    it('a GRANTED mutating call, then the app closing → `failed` (closed after a change was sent) — never re-run hidden', async () => {
      connectWeather();
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      const mounts = watchMounts(deps);
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await delegatedHint(deps);
      const post = live.net.handle(appId, netFrame('POST'));
      await vi.waitFor(() => expect(netConfirmStore.get()?.scheduled).toBeDefined());
      resolveNetConfirm({ granted: true });
      expect((await post).ok).toBe(true);
      expect(fetched).toHaveLength(1);
      deps.live.close(appId);
      const outcome = await pending;
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toBe(closedAfterChange('Weather', API_HOST));
      expect(mounts, 'the handler whose POST went out is never run again').toEqual([]);
      expect(deps.runtimeCalls).toEqual([]);
    });

    it('a SECOND handover (hidden → live → hidden) ends the step `failed` by name; no second hidden frame', async () => {
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      const mounts = watchMounts(deps);
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      const { mount } = await hinted(deps);
      deps.live.open(appId);
      await vi.waitFor(() => expect(deps.mounts.get()).toBeUndefined());
      mount.onUnmounted();
      await delegatedHint(deps);
      deps.live.close(appId);
      const outcome = await pending;
      expect(outcome.status).toBe('failed');
      expect(outcome.summary).toBe(handedOverTwice('Weather'));
      expect(mounts).toHaveLength(1);
      expect(deps.runtimeCalls).toHaveLength(1);
      expect(deps.mounts.get()).toBeUndefined();
    });

    it('tallies are SUMMED across attempts: an AI call in the hidden attempt and a network call in the live one both ride the outcome', async () => {
      connectWeather();
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      const { mount } = await hinted(deps);
      expect((await send(mount.transport)).ok).toBe(true); // counted by the hidden attempt
      deps.live.open(appId);
      await vi.waitFor(() => expect(deps.mounts.get()).toBeUndefined());
      mount.onUnmounted();
      await delegatedHint(deps);
      const { fetchImpl } = recordingFetch();
      expect((await liveRuntime(fetchImpl).net.handle(appId, netFrame('GET'))).ok).toBe(true); // counted into the delegated run
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'both halves' });
      expect(await pending).toMatchObject({ status: 'ok', summary: 'both halves', calls: { ai: 1, net: 1 } });
    });

    it('D-PR1-10 one deadline per step: a handover at 80 s re-dispatches inside what is left of it — the step settles by the 90 s deadline, inside the queue’s 120 s bound', async () => {
      fakeClock();
      const deps = fakeDeps({ announceTimeoutMs: SCHEDULE_ANNOUNCE_TIMEOUT_MS, resultTimeoutMs: SCHEDULE_RESULT_TIMEOUT_MS });
      const step: AppRunStep = { kind: 'app-run', appId };
      const startedAt = Date.now();
      let settledAt: number | undefined;
      const pending = executeAppRun(step, ctx(step, { trigger: 'due', now: clockNow }).context, deps).then((outcome) => {
        settledAt = Date.now();
        return outcome;
      });
      const { mount } = await hinted(deps);
      await vi.advanceTimersByTimeAsync(80_000 - (Date.now() - startedAt));
      expect(settledAt).toBeUndefined();
      deps.live.open(appId);
      await vi.waitFor(() => expect(deps.mounts.get()).toBeUndefined());
      mount.onUnmounted();
      await delegatedHint(deps);
      await vi.advanceTimersByTimeAsync(SCHEDULE_RESULT_TIMEOUT_MS + 1_000 - (Date.now() - startedAt));
      expect(settledAt, 'the live attempt waited only what the first dispatch left').toBeDefined();
      expect(settledAt! - startedAt).toBeLessThan(DEFAULT_RUN_BOUNDS.runMs);
      expect((await pending).status).toBe('failed');
    });
  });

  describe('AC5 — readiness: the hint waits for the frame to announce', () => {
    it('registered but NOT announced → placed live (no hidden mount) and the hint WAITS; the announce → the hint; the result lands', async () => {
      const deps = fakeDeps({ announceTimeoutMs: 2_000, resultTimeoutMs: 5_000 });
      const mounts = watchMounts(deps);
      deps.live.open(appId, { announce: false });
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      await sleep(40);
      expect(deps.live.notified, 'no hint before the listener exists').toEqual([]);
      expect(mounts).toEqual([]);
      deps.live.announce(appId);
      await delegatedHint(deps);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'ready, then ran' });
      expect(await pending).toMatchObject({ status: 'ok', summary: 'ready, then ran' });
      expect(mounts).toEqual([]);
    });

    it('registered and NEVER announced within the bound → `no-handler` with the copy’s sentence; no hint, no hidden mount, nothing left in the kv', async () => {
      const deps = fakeDeps();
      const mounts = watchMounts(deps);
      deps.live.open(appId, { announce: false });
      const step: AppRunStep = { kind: 'app-run', appId };
      const outcome = await executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
      expect(outcome).toMatchObject({ status: 'no-handler', summary: noHandler('Weather').text, calls: { ai: 0, net: 0 } });
      expect(deps.live.notified).toEqual([]);
      expect(mounts).toEqual([]);
      expect('value' in (await kv())).toBe(false);
    });
  });

  describe('AC6 — counted, never refused mid-window; the ceiling is asked BEFORE dispatch', () => {
    it('a day with no headroom for one more AI or network call → `refused`, `capped: true`, the limit named — nothing dispatched; `capped` survives `createStepExecutor`', async () => {
      for (const [counter, what] of [
        ['ai', 'AI call'],
        ['net', 'network call'],
      ] as const) {
        db.setSchedulerState({
          watermark: NOW,
          globalPause: false,
          daily: { date: NOW.slice(0, 10), ai: counter === 'ai' ? SCHEDULE_DAILY_CEILINGS.ai : 0, net: counter === 'net' ? SCHEDULE_DAILY_CEILINGS.net : 0 },
        });
        const deps = fakeDeps({ resultTimeoutMs: 5_000 });
        const mounts = watchMounts(deps);
        const kvSet = spyKv();
        deps.live.open(appId);
        const execute = createStepExecutor({ transportFor: () => undefined, appRun: deps });
        const step: AppRunStep = { kind: 'app-run', appId };
        const outcome = await execute(step, ctx(step, { trigger: 'due' }).context);
        expect(outcome.status, counter).toBe('refused');
        expect(outcome.capped, counter).toBe(true);
        expect(outcome.summary, counter).toBe(capped(what));
        expect(deps.live.notified, counter).toEqual([]);
        expect(mounts, counter).toEqual([]);
        expect(deps.runtimeCalls, counter).toEqual([]);
        expect(writesOf(kvSet), counter).toEqual([]);
        kvSet.mockRestore();
        deps.live.close(appId);
      }
    });

    it('a tally that CROSSES the ceiling inside the window is not refused — every call goes through, and the outcome is marked `capped: true`', async () => {
      connectWeather();
      db.setSchedulerState({ watermark: NOW, globalPause: false, daily: { date: NOW.slice(0, 10), ai: 0, net: SCHEDULE_DAILY_CEILINGS.net - 1 } });
      const deps = fakeDeps({ resultTimeoutMs: 5_000 });
      deps.live.open(appId);
      const { fetched, fetchImpl } = recordingFetch();
      const live = liveRuntime(fetchImpl);
      const execute = createStepExecutor({ transportFor: () => undefined, appRun: deps });
      const step: AppRunStep = { kind: 'app-run', appId };
      const pending = execute(step, ctx(step, { trigger: 'due' }).context);
      await delegatedHint(deps);
      expect((await live.net.handle(appId, netFrame('GET'))).ok).toBe(true);
      expect((await live.net.handle(appId, netFrame('GET'))).ok, 'past the ceiling, still not refused mid-window').toBe(true);
      expect(fetched).toHaveLength(2);
      deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'fetched twice' });
      expect(await pending).toMatchObject({ status: 'ok', summary: 'fetched twice', calls: { ai: 0, net: 2 }, capped: true });
    });
  });

  it('D-PR1-8: while the run is in flight the app’s ATTENDED access handler takes the hidden frame’s posture — an ask is told nobody is there, a session grant is not readable (a `refused` line, attended: false), a grant allowed *also while I’m away* reads with `attended: false`; after the run the door reopens', async () => {
    const at = Date.parse(NOW);
    __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => at });
    configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() }, now: () => at });
    const ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>' }).appId;
    const pantry = db.installApp({ displayName: 'Pantry', html: '<!doctype html><title>p</title>' }).appId;
    await seedTable(ledger, 'CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)', "INSERT INTO transactions (amount, category) VALUES (450, 'food')");
    await seedTable(pantry, 'CREATE TABLE items (name TEXT, qty INTEGER)', "INSERT INTO items VALUES ('rice', 2)");
    const deps = fakeDeps({ resultTimeoutMs: 5_000 });
    deps.live.open(appId);
    const access = createAccessHandlerFor(appId, { attended: true, generation: LIVE_GENERATION });
    const session = await grantFrom(ledger, 'transactions', { duration: 'session', unattended: false, at });
    const away = await grantFrom(pantry, 'items', { duration: 'day', unattended: true, at });
    const lastLine = (source: string) => db.listAccessLog(source)[0]; // the history is newest-first

    // Before the run: the open app reads its session grant, attended.
    expect((await access.handle(appId, accessQuery(session.id, 'SELECT amount FROM transactions'))).ok).toBe(true);
    expect(lastLine(ledger)).toMatchObject({ kind: 'read', attended: true });

    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
    await delegatedHint(deps);
    const ask = await Promise.race([access.handle(appId, accessAsk()), sleep(500).then(() => 'held — a consent strip was parked' as const)]);
    expect(ask).toEqual({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_UNATTENDED, message: ACCESS_APP_MESSAGES.unattended, retryable: true });
    expect(await access.handle(appId, accessQuery(session.id, 'SELECT amount FROM transactions'))).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED });
    expect(lastLine(ledger)).toMatchObject({ kind: 'refused', grantId: session.id, attended: false });
    expect((await access.handle(appId, accessQuery(away.id, 'SELECT name FROM items'))).ok).toBe(true);
    expect(lastLine(pantry)).toMatchObject({ kind: 'read', grantId: away.id, attended: false });

    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true });
    expect((await pending).status).toBe('ok');
    // After the run: the user's own session grant reads again, attended.
    expect((await access.handle(appId, accessQuery(session.id, 'SELECT amount FROM transactions'))).ok).toBe(true);
    expect(lastLine(ledger)).toMatchObject({ kind: 'read', attended: true });
  });

  it('S5: a `schedule-result` published from ANOTHER generation than the hinted one never settles the run — the hinted generation’s does (the live twin of the closed-app pin)', async () => {
    const deps = fakeDeps({ resultTimeoutMs: 5_000 });
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId };
    let settled = false;
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps).then((o) => {
      settled = true;
      return o;
    });
    await delegatedHint(deps);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from another generation', runId: RUN_ID }, LIVE_GENERATION + 1);
    await sleep(20);
    expect(settled).toBe(false);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from the hinted generation', runId: RUN_ID });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'from the hinted generation' });
  });
});

// ------------------------------------------------------------------ the access-door harness (D-PR1-8)

function inlineWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        void respond(msg).then((answer) => {
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        });
      },
      terminate() {},
    };
    return worker;
  };
}

async function seedTable(id: string, ddl: string, insert: string): Promise<void> {
  await db.applyAppDdl(id, [ddl]);
  await db.driver.handle(id, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `seed-${id}`, instanceId: 'seed', op: 'exec', sql: insert });
}

/** A grant to Weather (the reader) on `source`, through the real candidate collection and grant factory. */
async function grantFrom(source: string, table: string, over: { duration: 'session' | 'day'; unattended: boolean; at: number }): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, appId);
  const candidate = [...ranked.matched, ...ranked.rest].find((entry) => entry.appId === source);
  if (candidate === undefined) throw new Error('no such source');
  return createGrantFromDecision(db, {
    readerAppId: appId,
    source: candidate,
    tables: [table],
    duration: over.duration,
    unattended: over.unattended,
    purpose: 'to show spending by category',
    provenance: 'app',
    generation: LIVE_GENERATION,
    now: over.at,
  });
}

let accessSeq = 0;
const accessBase = () => ({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, requestId: `acc-${++accessSeq}`, instanceId: 'live-1' }) as const;
const accessAsk = (): AccessRequestFrame => ({ ...accessBase(), op: 'request', purpose: 'to show spending by category', hints: { tables: ['transactions'] } });
const accessQuery = (grantId: string, sql: string): AccessRequestFrame => ({ ...accessBase(), op: 'query', grantId, sql });

describe('the live frame — a MANUAL run with the app on screen', () => {
  it('delivers to the LIVE frame under the page’s own gate: no hidden mount, no runtime of ours, the key written, the hint rung through the registry, the result read from the forwarded events', async () => {
    const deps = fakeDeps();
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId, input: 1 };
    const pending = executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
    expect(deps.mounts.get()).toBeUndefined();
    expect(deps.runtimeCalls).toEqual([]); // the live frame's own runtime and gate (the user is at the app), not ours
    expect(deps.live.notified[0]).toEqual({ appId, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: RUN_ID } });
    expect(await kvValue()).toEqual({ taskId: 'task-1', runId: RUN_ID, input: 1 });
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'refreshed on screen' });
    expect(await pending).toEqual({ status: 'ok', summary: 'refreshed on screen', calls: { ai: 0, net: 0 } });
    expect('value' in (await kv())).toBe(false);
  });

  it('a live frame that never answers → `failed`, the key cleared', async () => {
    const deps = fakeDeps();
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId };
    const outcome = await executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    expect(outcome).toEqual({ status: 'failed', summary: appDidNotAnswer(60), calls: { ai: 0, net: 0 } });
    expect('value' in (await kv())).toBe(false);
  });

  it('M18: the app CLOSING mid-run settles the step `failed: "the app was closed"` at once — no wait for the bound; the key cleared', async () => {
    const deps = fakeDeps({ resultTimeoutMs: 10_000 });
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
    deps.live.close(appId);
    expect(await pending).toEqual({ status: 'failed', summary: APP_CLOSED_SUMMARY, calls: { ai: 0, net: 0 } });
    expect(APP_CLOSED_SUMMARY).toBe('the app was closed');
    expect('value' in (await kv())).toBe(false);
  });

  it('ANOTHER app closing does not touch the run; a result after that still lands', async () => {
    const other = db.installApp({ displayName: 'Ledger', html: '<html>l</html>' }).appId;
    const deps = fakeDeps();
    deps.live.open(appId);
    deps.live.open(other);
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
    deps.live.close(other);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'still here' });
    expect((await pending).summary).toBe('still here');
  });

  it('the hint WAITS for the live frame to be ready (ADR-0077 §6, the *run now* race): registered but not announced → no hint yet; the announce → the hint; the result lands', async () => {
    const deps = fakeDeps({ announceTimeoutMs: 2_000, resultTimeoutMs: 5_000 });
    deps.live.open(appId, { announce: false });
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'manual' }).context, deps);
    await new Promise((r) => setTimeout(r, 40));
    expect(deps.live.notified, 'no hint before the app’s listener exists').toEqual([]);
    expect(deps.mounts.get()).toBeUndefined();
    deps.live.announce(appId);
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
    expect(deps.live.notified[0]).toEqual({ appId, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: RUN_ID } });
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'ran once it was ready' });
    expect(await pending).toEqual({ status: 'ok', summary: 'ran once it was ready', calls: { ai: 0, net: 0 } });
  });
});

describe('refusals before anything mounts', () => {
  it('no scheduler seat on this platform → blocked by name, no mount, nothing written', async () => {
    const deps = fakeDeps({ platform: () => NO_SEAT });
    const step: AppRunStep = { kind: 'app-run', appId };
    expect(await executeAppRun(step, ctx(step).context, deps)).toEqual({ status: 'blocked', summary: blockedHere(NO_HIDDEN_FRAME).text, calls: { ai: 0, net: 0 } });
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('an app the file no longer holds → blocked, app missing', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId: 'gone' };
    expect(await executeAppRun(step, ctx(step).context, deps)).toEqual({ status: 'blocked', summary: appMissing.text, calls: { ai: 0, net: 0 } });
  });

  it('an already-aborted signal → cancelled, nothing touched', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, controller } = ctx(step);
    controller.abort();
    expect(await executeAppRun(step, context, deps)).toEqual({ status: 'failed', summary: CANCELLED_SUMMARY, calls: { ai: 0, net: 0 } });
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('M12: `blockedAppRunDeps()` — the composition a unit fake passes — answers an app-run step blocked by name: no mount, no runtime, no registry', async () => {
    const blocked = blockedAppRunDeps();
    const execute = createStepExecutor({ transportFor: () => undefined, appRun: blocked });
    const step: AppRunStep = { kind: 'app-run', appId };
    expect(await execute(step, ctx(step).context)).toEqual({ status: 'blocked', summary: blockedHere(NO_HIDDEN_FRAME).text, calls: { ai: 0, net: 0 } });
    expect(blocked.mounts.get()).toBeUndefined();
    expect(blocked.live.has(appId)).toBe(false);
  });
});

describe('C1 — no credential crosses the handshake', () => {
  it('a result summary that looks like a credential is WITHHELD whole by the executor’s finalize (the fixed sentence, never the value)', async () => {
    const deps = fakeDeps();
    const execute = createStepExecutor({ transportFor: () => undefined, appRun: deps });
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = execute(step, ctx(step).context);
    const { mount } = await hinted(deps);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'use https://alice:hunter2@api.example.com/v1 next time' });
    const outcome = await pending;
    expect(outcome.summary).toBe(WITHHELD_SUMMARY);
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });

  it('the kv value is the step’s own input and ids — the file’s secrets are not on the path at all', async () => {
    db.setSecret(`auth:${appId}:example:api_key`, 'stored-key-abc123');
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId, input: { q: 'weather' } };
    const pending = executeAppRun(step, ctx(step).context, deps);
    const { mount } = await hinted(deps);
    expect(JSON.stringify(await kvValue())).not.toContain('stored-key');
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
  });
});

describe('the production wire', () => {
  it('`executeStep` dispatches an app-run step to the REAL hidden mount store (the host component’s), with the page’s seat', async () => {
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, controller } = ctx(step);
    const pending = executeStep(step, context);
    await vi.waitFor(() => expect(hiddenMountStore.get()).toBeDefined());
    const mount = hiddenMountStore.get()!;
    expect(mount.appId).toBe(appId);
    expect(mount.frameProps.dbNamespace).toBe(appId);
    expect(mount.frameProps.netAppId).toBe(appId); // an owned app on the web platform may reach the network
    controller.abort();
    expect((await pending).status).toBe('failed');
    expect(hiddenMountStore.get()).toBeUndefined();
  });

  it('the hidden frame composes `attended: false` (AC20): its access handler is bound to the app’s own id, an ask is told nobody is there, and no reader generation is noted', async () => {
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, controller } = ctx(step);
    const pending = executeStep(step, context);
    await vi.waitFor(() => expect(hiddenMountStore.get()).toBeDefined());
    const mount = hiddenMountStore.get()!;
    expect(mount.frameProps.accessAppId).toBe(appId);
    const access = mount.frameProps.access;
    expect(access).toBeDefined();
    const answer = await access!.handle(appId, {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessRequest,
      requestId: 'a1',
      instanceId: 'hidden-1',
      op: 'request',
      purpose: 'to show spending by category',
    });
    expect(answer).toMatchObject({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_UNATTENDED, retryable: true });
    expect(readerGeneration(appId)).toBeUndefined();
    controller.abort();
    await pending;
  });

  it('`defaultAppRunDeps` says it in the source: the composition is `attended: false` — never left to a default', () => {
    const code = readFileSync(path.resolve(__dirname, '..', 'schedule', 'appRun.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/composeAppRuntime\(\{[^}]*\battended: false\b/);
    expect(code).not.toMatch(/\battended: true\b/);
  });
});
