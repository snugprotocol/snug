// appRunHandshake.test.tsx — TASK-20261009-scheduling-framework A2/A3/A5 (ADR-0074 §3, §5, §6;
// security F5, F8, F16): the *Run [app]* executor and the kv handshake, over a REAL memory-backed
// user db with the frame FAKED — the test plays the hidden frame (announce, the lent controls,
// the app-event) and the live-host registry.
//
// What is pinned: the host writes EXACTLY `{ taskId, runId, input }` into the app's own kv and
// rings `schedule-run { taskId, runId }` (ids, never content); the committed CURRENT html runs;
// a result is accepted only from the frame that received the hint, after the hint, once, for
// this run, under a length cap and a strict parse — an unsolicited, duplicate, forged or
// oversized one is DROPPED; no announce → `no-handler`, no result → `failed`; the key is cleared
// on every exit; an unattended run runs in the hidden frame whether or not the app is open, and opening it mid-run does not interrupt it (owner decision 2026-10-09); the gate follows the trigger
// and its record outranks the app's answer; the day's ceilings count what the run spent; the
// live frame gets the hint without a hidden mount; no scheduler seat → blocked by name; the C1
// negatives; and the PRODUCTION wire (`executeStep` → the real hidden mount store) — whose
// runtime composes `attended: false` (TASK-20261010-cross-app-access AC20: the hidden frame's
// access handler tells an ask that nobody is there, and never notes a reader generation).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ACCESS_ERROR_CODES, FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
import { ERROR_CODES, SCHEDULE_DAILY_CEILINGS, SCHEDULE_STEP_SUMMARY_MAX_CHARS, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions, RunnerHost } from '@snugprotocol/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';
import {
  APP_CLOSED_SUMMARY,
  NO_HIDDEN_FRAME,
  SCHEDULE_RESULT_MAX_CHARS,
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
import { appMissing, blockedHere, needsYou, noHandler } from '../schedule/copy.js';
import type { StepContext } from '../schedule/engine-types.js';
import { CANCELLED_SUMMARY, WITHHELD_SUMMARY, createStepExecutor, executeStep } from '../schedule/executors.js';
import { SCHEDULE_RESULT_EVENT, SCHEDULE_RUN_EVENT, scheduleKvKey } from '../schedule/scheduleKey.js';
import type { ScheduledConfirmGate } from '../schedule/scheduledConfirmGate.js';
import { SCHEDULED_AI_LIMIT_MESSAGE } from '../schedule/scheduledTransport.js';
import { readerGeneration } from '../access/grants.js';
import { __resetAppHostsForTest } from '../state/appHosts.js';
import { createStore } from '../state/store.js';
import { installTestUserDb } from './userdbTestHelper.js';

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

function ctx(step: ScheduleStep, over: { trigger?: StepContext['run']['trigger']; spent?: () => { ai: number; net: number }; runId?: string } = {}): Ctx {
  const interrupt = vi.fn();
  const controller = new AbortController();
  const context: StepContext = {
    task: task([step]),
    run: { id: over.runId ?? RUN_ID, taskId: 'task-1', dueAt: NOW, trigger: over.trigger ?? 'due' },
    db,
    signal: controller.signal,
    now: () => new Date(NOW),
    interrupt,
    ...(over.spent !== undefined ? { spent: over.spent } : {}),
  };
  return { context, interrupt, controller };
}

interface FakeLive extends LiveAppHosts {
  notified: Array<{ appId: string; event: string; data: unknown }>;
  open(appId: string): void;
  close(appId: string): void;
  emit(appId: string, event: string, data: unknown): void;
}

function fakeLive(): FakeLive {
  const live = new Set<string>();
  const hostListeners = new Set<(appId: string, live: boolean) => void>();
  const eventListeners = new Map<string, Set<(event: string, data: unknown) => void>>();
  const notified: FakeLive['notified'] = [];
  return {
    notified,
    has: (id) => live.has(id),
    notify: (id, event, data) => {
      if (!live.has(id)) return false;
      notified.push({ appId: id, event, data });
      return true;
    },
    subscribe: (listener) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
    subscribeEvents: (id, listener) => {
      const set = eventListeners.get(id) ?? new Set();
      eventListeners.set(id, set);
      set.add(listener);
      return () => set.delete(listener);
    },
    open: (id) => {
      live.add(id);
      for (const listener of hostListeners) listener(id, true);
    },
    close: (id) => {
      live.delete(id);
      for (const listener of hostListeners) listener(id, false);
    },
    emit: (id, event, data) => {
      for (const listener of eventListeners.get(id) ?? []) listener(event, data);
    },
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
  it('a RunView mounting the same app mid-run does NOT interrupt it: no `interrupt`, the hidden frame stays, the result lands, the key is cleared', async () => {
    const deps = fakeDeps();
    const step: AppRunStep = { kind: 'app-run', appId };
    const { context, interrupt } = ctx(step);
    const pending = executeAppRun(step, context, deps);
    const { mount } = await hinted(deps);
    deps.live.open(appId);
    expect(interrupt).not.toHaveBeenCalled();
    expect(deps.mounts.get()).toBe(mount);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'ran while you looked' });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'ran while you looked' });
    expect(deps.mounts.get()).toBeUndefined();
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
  it('every unattended trigger (due, late, catch-up) composes the hidden frame with the refusing gate', async () => {
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

describe('an unattended run of an OPEN app still runs — in the hidden frame, never the live one (owner decision 2026-10-09)', () => {
  it('due / late / catch-up with the app LIVE → the hidden frame mounts under the scheduled gate, the live frame is never hinted, and the app’s result is recorded', async () => {
    for (const trigger of ['due', 'late', 'catch-up'] as const) {
      hiddenMountStore.set(undefined);
      const deps = fakeDeps();
      deps.live.open(appId);
      const step: AppRunStep = { kind: 'app-run', appId, input: { city: 'Oslo' } };
      const pending = executeAppRun(step, ctx(step, { trigger }).context, deps);
      const { mount, host } = await hinted(deps);
      expect(deps.runtimeCalls, trigger).toHaveLength(1);
      expect(deps.runtimeCalls[0]!.confirmGate, trigger).toBeDefined();
      expect(host.notifyEvent, trigger).toHaveBeenCalledWith(SCHEDULE_RUN_EVENT, { taskId: 'task-1', runId: RUN_ID });
      expect(deps.live.notified, trigger).toEqual([]); // the open app is never driven by a timer
      mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'Oslo: dry until noon' });
      expect(await pending, trigger).toMatchObject({ status: 'ok', summary: 'Oslo: dry until noon' });
    }
  });

  it('a mutating call in that run is still refused by the scheduled gate → `refused` with the needs-you sentence, app open or not', async () => {
    const deps = fakeDeps();
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId };
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps);
    const { mount } = await hinted(deps);
    const gate = deps.runtimeCalls[0]!.confirmGate as ScheduledConfirmGate;
    expect(gate.confirm({ appId, host: 'api.github.com', method: 'POST', url: 'https://api.github.com/repos/x/issues' })).toBe(false);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'posted' });
    expect(await pending).toEqual({ status: 'refused', summary: needsYou('Weather', 'post to api.github.com').text, calls: { ai: 0, net: 0 } });
  });

  it('a result the VISIBLE copy posts is never taken for the hidden run — only the hidden frame’s own answer settles it', async () => {
    const deps = fakeDeps({ resultTimeoutMs: 5_000 }); // long enough that only an answer can settle it
    deps.live.open(appId);
    const step: AppRunStep = { kind: 'app-run', appId };
    let settled = false;
    const pending = executeAppRun(step, ctx(step, { trigger: 'due' }).context, deps).then((o) => {
      settled = true;
      return o;
    });
    const { mount } = await hinted(deps);
    deps.live.emit(appId, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from the open copy', runId: RUN_ID });
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'from the hidden copy' });
    expect(await pending).toMatchObject({ status: 'ok', summary: 'from the hidden copy' });
  });

  it('the hidden run’s db binding is the scheduled guard: a BEGIN is refused by name, a plain read passes', async () => {
    const deps = fakeDeps();
    deps.live.open(appId);
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

  it('the old open-app refusal is gone from the executor’s exports', async () => {
    const mod = await import('../schedule/appRun.js');
    expect('APP_OPEN_REFUSAL' in mod).toBe(false);
  });
});

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
