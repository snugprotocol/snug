// refresh.test.ts — TASK-20261010-host-broker PR-3 (ADR-0076 §6; contract v2 D-PR3-17, D-PR3-18,
// D-PR3-19; the spec's §24.6 (25)–(27) and §24.7 (28); AC22). RED-FIRST: `access/refresh.ts` does
// not exist yet, so it is loaded through a VARIABLE specifier (a literal dynamic import would fail
// the whole file at transform time — lesson 2026-10-11); every test is red at that load until the
// engine lands. A second, independent red sits under it by design: the grant these tests persist
// carries `refresh: true`, a v2 seat of the RECORD (D-PR3-2) — until the protocol lands, the strict
// `accessGrantSchema` REFUSES it (`Unrecognized key: "refresh"`).
//
// WHAT A REFRESH IS. A reader holding a grant with `refresh: true` asks the SOURCE to fetch new data
// before reading it. The host runs the source's OWN code — where it lives (one instance, §24.7
// (28)): the live frame when the source is open, else the ONE hidden frame — over the schedule
// handshake (`schedule-run { taskId: 'access-refresh', runId }`, the kv input `{ kind: 'refresh',
// requestedBy }`), under the unattended posture (a mutating connected call is REFUSED, never
// asked; nothing is remembered), counted on the FILE's daily ceilings, at most once per source per
// five minutes, and writes `refreshed` on the source's history before the answer. The handler's own
// text never reaches the reader: the answer is exactly `{ ok: true, op: 'refresh', fresh: true }`.
//
// THE HARNESS is the handshake suite's (`appRunHandshake.test.tsx`), LIFTED by copy — the helpers
// are file-local there and that suite stays untouched: `fakeLive()` plays the live frame through
// the REAL registry (`state/appHosts.ts`), `fakeDeps()` is the executor's composition with the
// hidden frame played by the test, `liveRuntime()` is the runtime RunView composes (its net handler
// carries `state/net.ts`'s DEFAULT gate — the run-scoped gate — so the posture under test is the
// page's own), and a REAL memory-backed user db.
import { ACCESS_ERROR_CODES, ACCESS_REFRESH_COOLDOWN_MS, ACCESS_REFRESH_REASONS, NET_ERROR_CODES, SCHEDULE_DAILY_CEILINGS, accessGrantSchema, type AccessGrant } from '@snugprotocol/protocol';
import type { AgentTransport, AgentTransportOptions, RunnerHost } from '@snugprotocol/runner';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { ACCESS_APP_MESSAGES } from '../access/copy.js';
import { __setAccessDepsForTests, resetAccessSession } from '../access/grants.js';
import { oneLine } from '../agent/sharedDdl.js';
import type { SnugPlatform } from '../platform/platform.js';
import { composeAppRuntime } from '../run/appRuntime.js';
import { SCHEDULE_RESULT_TIMEOUT_MS, hiddenMountStore, type AppRunDeps, type AppRunRuntimeInput, type HiddenMount, type LiveAppHosts } from '../schedule/appRun.js';
import { REFRESH_RUN } from '../schedule/copy.js';
import { beginDelegatedRun, delegatedRunFor, endDelegatedRun, type DelegatedRun } from '../schedule/runPlacement.js';
import { SCHEDULE_RESULT_EVENT, SCHEDULE_RUN_EVENT, scheduleKvKey } from '../schedule/scheduleKey.js';
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
import { __resetNetStateForTests, netConfirmStore, resolveNetConfirm } from '../state/net.js';
import { createStore } from '../state/store.js';
import { installTestUserDb } from './userdbTestHelper.js';

// ---------------------------------------------------------------- the module under test

/** The engine's own surface (`refreshSource`, `RefreshOutcome`, `__resetRefreshForTests`) — the real exports; the implementation lane swapped the local stand-ins. */
type RefreshModule = typeof import('../access/refresh.js');
type RefreshOutcome = Awaited<ReturnType<RefreshModule['refreshSource']>>;
const REFRESH_MODULE = '../access/refresh.js';
const loadRefresh = (): Promise<RefreshModule> => import(/* @vite-ignore */ REFRESH_MODULE) as Promise<RefreshModule>;

/** `clearSourceReadCaches(db, sourceAppId)` lives in the Write Broker (D-PR3-15); the refresh engine calls it after a result. */
interface WriteBrokerModule {
  clearSourceReadCaches(db: UserDb, sourceAppId: string): void;
}
const WRITE_BROKER_MODULE = '../access/writeBroker.js';
const loadWriteBroker = (): Promise<WriteBrokerModule> => import(/* @vite-ignore */ WRITE_BROKER_MODULE) as Promise<WriteBrokerModule>;

/** The delegated record, posture included (D-PR3-19 — the real field). */
const runOf = (id: string): DelegatedRun | undefined => delegatedRunFor(id);

// ------------------------------------------------------------------------------------- fixtures

const NOW = '2026-10-11T15:00:00.000Z';
const REFRESH_TASK_ID = 'access-refresh';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEAT: SnugPlatform = {
  kind: 'web',
  scheduler: { wakeMode: 'page', hostLabel: 'this tab' },
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
};
const NO_SEAT: SnugPlatform = { kind: 'web', capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } };
/** `allows('schedule') === false` — the host turned every scheduling surface off (TASK-20261009 C7). */
const SCHEDULE_OFF: SnugPlatform = { ...SEAT, capabilities: { ...SEAT.capabilities, schedule: false } };

let db: UserDb;
/** Ledger — the SOURCE, the app asked to fetch. */
let source: string;
/** Budget — the READER, the app that asked. */
let reader: string;
let refresh: RefreshModule;

/** The grant the reader holds on the source, persisted through the db's own accessor (its strict parse included). */
function refreshGrant(over: { readerAppId?: string; sourceAppId?: string } = {}): AccessGrant {
  const at = new Date(Date.now()).toISOString();
  const grant = accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId: over.readerAppId ?? reader,
    sourceAppId: over.sourceAppId ?? source,
    scope: { tables: [{ name: 'transactions', columns: ['id', 'amount', 'category'] }] },
    access: 'read',
    purpose: 'to show spending by category',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: at,
    updatedAt: at,
    reads: 0,
    timeouts: 0,
    // D-PR3-2: a v2 seat. Until the protocol lands this line is a strict-parse REFUSAL — red by design.
    refresh: true,
  });
  db.putAccessGrant(grant);
  return grant;
}

/** Schedules are on for this file: the `schedulerState` row exists (the scheduler's boot writes it), today's counters as given. */
function schedulesOn(daily: { ai?: number; net?: number } = {}, globalPause = false): void {
  const nowIso = new Date(Date.now()).toISOString();
  db.setSchedulerState({ watermark: nowIso, globalPause, daily: { date: nowIso.slice(0, 10), ai: daily.ai ?? 0, net: daily.net ?? 0 } });
}

// ------------------------------------------------------- the handshake suite's harness, lifted

/** The generation RunView's `frameEpoch` gives the open app in these tests (not 0, so a missed `setAppHostGeneration` shows). */
const LIVE_GENERATION = 1;

interface FakeLive extends LiveAppHosts {
  notified: Array<{ appId: string; event: string; data: unknown }>;
  open(appId: string, options?: { generation?: number; announce?: boolean }): void;
  announce(appId: string): void;
  close(appId: string): void;
  emit(appId: string, event: string, data: unknown, generation?: number): void;
}

/** The live frame, played through the REAL `state/appHosts.ts` (lifted from `appRunHandshake.test.tsx`). */
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

/** The handshake suite's bounds (far past `vi.waitFor`'s 50 ms polls); a test that asserts a bound passes its own. */
const HARNESS_ANNOUNCE_MS = 2_000;
const HARNESS_RESULT_MS = 5_000;
/** A no-announce test's window: short, so the end reads `no-handler`. */
const SHORT_ANNOUNCE_MS = 40;

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
    announceTimeoutMs: HARNESS_ANNOUNCE_MS,
    resultTimeoutMs: HARNESS_RESULT_MS,
    ...over,
  };
}

type HiddenHost = RunnerHost & { notifyEvent: ReturnType<typeof vi.fn> };

/** The hidden frame the test plays: waits for the mount request and lends it recording controls. */
async function mounted(deps: AppRunDeps): Promise<{ mount: HiddenMount; host: HiddenHost }> {
  await vi.waitFor(() => expect(deps.mounts.get()).toBeDefined());
  const mount = deps.mounts.get()!;
  const host = { notifyEvent: vi.fn(), destroy: vi.fn(), reset: vi.fn(), setTheme: vi.fn() } as HiddenHost;
  mount.controls.current = host;
  return { mount, host };
}

/** Announce, then wait for the hint; answers the runId the hint carried. */
async function hinted(deps: AppRunDeps): Promise<{ mount: HiddenMount; host: HiddenHost; runId: string }> {
  const frame = await mounted(deps);
  frame.mount.onAnnounce();
  await vi.waitFor(() => expect(frame.host.notifyEvent).toHaveBeenCalled());
  const [event, data] = frame.host.notifyEvent.mock.calls[0]! as [string, { taskId: string; runId: string }];
  expect(event).toBe(SCHEDULE_RUN_EVENT);
  expect(data.taskId).toBe(REFRESH_TASK_ID);
  return { ...frame, runId: data.runId };
}

/** The refresh's hint reached the LIVE source frame — ids only — and answers its runId. */
async function liveHint(deps: Fake): Promise<string> {
  await vi.waitFor(() => expect(deps.live.notified).toHaveLength(1));
  const hint = deps.live.notified[0]!;
  expect(hint.appId).toBe(source);
  expect(hint.event).toBe(SCHEDULE_RUN_EVENT);
  const data = hint.data as { taskId: string; runId: string };
  expect(Object.keys(data).sort()).toEqual(['runId', 'taskId']); // R7: ids, never content
  expect(data.taskId).toBe(REFRESH_TASK_ID);
  expect(data.runId).toMatch(UUID);
  return data.runId;
}

const kvValue = async (id: string, runId: string): Promise<unknown> => {
  const read = await db.driver.kvGet(id, scheduleKvKey(runId));
  return read.ok ? read.value : read;
};
const kvHolds = async (id: string, runId: string): Promise<boolean> => 'value' in (await db.driver.kvGet(id, scheduleKvKey(runId)));
const send = (transport: AgentTransport) => transport.send('[SNUG_APP_REQUEST] {"v":1}', { signal: new AbortController().signal });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every hidden mount ever set on this composition — "never mounted" means this stays empty. */
function watchMounts(deps: AppRunDeps): HiddenMount[] {
  const seen: HiddenMount[] = [];
  deps.mounts.subscribe(() => {
    const mount = deps.mounts.get();
    if (mount !== undefined) seen.push(mount);
  });
  return seen;
}

type KvSpy = MockInstance<UserDb['driver']['kvSet']>;
/** Every host-side kv call into the SOURCE's namespace (the engine calls the file's driver, never the frame's binding). */
const spyKv = (): KvSpy => vi.spyOn(db.driver, 'kvSet');
const sourceKvCalls = (spy: KvSpy) => spy.mock.calls.filter(([id]) => id === source);
const writesOf = (spy: KvSpy, runId?: string) =>
  sourceKvCalls(spy).filter(([, key, value]) => value !== null && (runId === undefined || key === scheduleKvKey(runId)));
const clearsOf = (spy: KvSpy, runId: string) => sourceKvCalls(spy).filter(([, key, value]) => key === scheduleKvKey(runId) && value === null);

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

/** The source gets an approved connection to the example host (the handshake suite's seed). */
function connectSource(): void {
  db.setSecret(`auth:${source}:${SLOT}:api_key`, 'stored-key-abc123');
  db.putDeclaredConnection(source, SLOT, requirement, 'inference');
  db.approveConnection(source, SLOT);
}

const netFrame = (method: 'GET' | 'POST', url = `https://${API_HOST}/v1/items`, body = '{}') => ({
  v: 1 as const,
  type: 'snug:net-request' as const,
  requestId: `r-${method}-${Math.random().toString(36).slice(2)}`,
  instanceId: 'live-1',
  url,
  method,
  ...(method === 'POST' ? { body } : {}),
});

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

/** The SOURCE's live runtime exactly as RunView composes it — `attended: true`, NO gate passed (so `state/net.ts`'s default), no counting seam passed. */
function liveRuntime(appId: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, generation = LIVE_GENERATION) {
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

/** The source's history, newest first. */
const history = (id = source) => db.listAccessLog(id);
const refreshedLines = (id = source) => history(id).filter((entry) => entry.kind === 'refreshed');

const failed = (code: string, retryable: boolean) => ({ ok: false, code, retryable });

/** "Nothing dispatched": no live hint, no hidden mount, no runtime of ours, no kv write into the source. */
function expectNothingDispatched(deps: Fake, mounts: HiddenMount[], kvSet: KvSpy): void {
  expect(deps.live.notified, 'no hint').toEqual([]);
  expect(mounts, 'no hidden mount').toEqual([]);
  expect(deps.mounts.get()).toBeUndefined();
  expect(deps.runtimeCalls, 'no runtime composed').toEqual([]);
  expect(writesOf(kvSet), 'no kv input written').toEqual([]);
}

beforeEach(async () => {
  __resetAppHostsForTest();
  __resetNetStateForTests();
  hiddenMountStore.set(undefined);
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.now() });
  source = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
  reader = db.installApp({ displayName: 'Budget', html: '<html>budget</html>' }).appId;
  refresh = await loadRefresh();
  refresh.__resetRefreshForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  refresh?.__resetRefreshForTests();
  __resetNetStateForTests();
  resetAccessSession();
  __setAccessDepsForTests();
  hiddenMountStore.set(undefined);
  __resetAppHostsForTest();
});

// ============================================================================================

describe('the three gates — refused before anything runs (D-PR3-17 (1); §24.6 (25); S7)', () => {
  it('NO `schedulerState` row → ACCESS_REFRESH_FAILED "schedules are off for this file", not retryable — nothing dispatched: no hint, no hidden mount, no kv write, no line', async () => {
    const grant = refreshGrant();
    expect(db.getSchedulerState(), 'precondition: the scheduler never booted on this file').toBeUndefined();
    const deps = fakeDeps();
    const mounts = watchMounts(deps);
    const kvSet = spyKv();
    deps.live.open(source); // open, so a dispatch WOULD hint the live frame
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toEqual({ ...failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false), message: ACCESS_APP_MESSAGES.refreshOff });
    expectNothingDispatched(deps, mounts, kvSet);
    expect(refreshedLines()).toEqual([]);
  });

  it('`globalPause` (the user paused everything unattended) → the same refusal, nothing dispatched', async () => {
    const grant = refreshGrant();
    schedulesOn({}, true);
    const deps = fakeDeps();
    const mounts = watchMounts(deps);
    const kvSet = spyKv();
    deps.live.open(source);
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toEqual({ ...failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false), message: ACCESS_APP_MESSAGES.refreshOff });
    expectNothingDispatched(deps, mounts, kvSet);
    expect(refreshedLines()).toEqual([]);
  });

  it('`allows(\'schedule\')` false on this host → the same refusal, nothing dispatched — even with the state row present', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps({ platform: () => SCHEDULE_OFF });
    const mounts = watchMounts(deps);
    const kvSet = spyKv();
    deps.live.open(source);
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toEqual({ ...failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false), message: ACCESS_APP_MESSAGES.refreshOff });
    expectNothingDispatched(deps, mounts, kvSet);
    expect(refreshedLines()).toEqual([]);
  });

  it('a gate refusal does not stamp the cooldown — once schedules are on, the next ask runs (the stamp is AT DISPATCH)', async () => {
    const grant = refreshGrant();
    const deps = fakeDeps();
    deps.live.open(source);
    expect((await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' })).ok).toBe(false);
    schedulesOn();
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
  });

  it('a host with NO scheduler seat → ACCESS_REFRESH_FAILED, not retryable — nothing dispatched', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps({ platform: () => NO_SEAT });
    const mounts = watchMounts(deps);
    const kvSet = spyKv();
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expectNothingDispatched(deps, mounts, kvSet);
  });
});

describe('placement — the source runs where it lives, one instance (§24.7 (28); D-PR3-17 (6))', () => {
  it('the source OPEN → its LIVE frame is hinted `schedule-run { taskId: "access-refresh", runId }` (a fresh uuid); the kv input is exactly { taskId, runId, input: { kind: "refresh", requestedBy } }; no hidden mount, no runtime of ours; the answer is { ok, op, fresh: true }', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const mounts = watchMounts(deps);
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const runId = await liveHint(deps);
    const written = await kvValue(source, runId);
    expect(written).toEqual({ taskId: REFRESH_TASK_ID, runId, input: { kind: 'refresh', requestedBy: 'Budget' } });
    expect(Object.keys(written as object).sort()).toEqual(['input', 'runId', 'taskId']);
    expect(mounts).toEqual([]);
    expect(deps.runtimeCalls).toEqual([]); // the open app's own runtime, not one of ours
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('the live run is a DELEGATED run with posture "refresh" — the record the gate and the chip read: the source’s name, `taskId: "access-refresh"`, the title `REFRESH_RUN.title(requestedBy)`; it ends with the refresh', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const runId = await liveHint(deps);
    const run = runOf(source);
    expect(run).toBeDefined();
    expect(run).toMatchObject({ appId: source, appName: 'Ledger', runId, taskId: REFRESH_TASK_ID, title: REFRESH_RUN.title('Budget'), generation: LIVE_GENERATION, posture: 'refresh' });
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
    expect(delegatedRunFor(source)).toBeUndefined();
  });

  it('the source CLOSED → the ONE hidden frame (the current html), under the refusing gate and the scheduled db binding; the hint carries ids only; the live registry is never rung', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const { mount, host, runId } = await hinted(deps);
    expect(mount).toMatchObject({ appId: source, runId, html: '<html>ledger</html>' });
    expect(runId).toMatch(UUID);
    expect(host.notifyEvent).toHaveBeenCalledWith(SCHEDULE_RUN_EVENT, { taskId: REFRESH_TASK_ID, runId });
    expect(await kvValue(source, runId)).toEqual({ taskId: REFRESH_TASK_ID, runId, input: { kind: 'refresh', requestedBy: 'Budget' } });
    expect(deps.runtimeCalls).toHaveLength(1);
    const composed = deps.runtimeCalls[0]!;
    expect(composed.appId).toBe(source);
    expect(composed.driver, 'the scheduled db binding, never the open driver').not.toBe(db.driver);
    expect(deps.live.notified).toEqual([]);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(deps.mounts.get()).toBeUndefined();
  });

  it('hidden: the refusing gate says no to a mutating call (no dialog — nobody is there), the counting transport counts the think; a refusal on the record makes the refresh fail `refused`', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const { mount } = await hinted(deps);
    const gate = deps.runtimeCalls[0]!.confirmGate;
    expect(await gate.confirm({ appId: source, host: API_HOST, method: 'POST', url: `https://${API_HOST}/v1/items` })).toBe(false);
    expect(netConfirmStore.get(), 'the hidden frame never parks a dialog').toBeNull();
    expect((await send(mount.transport)).ok).toBe(true);
    expect(deps.brain.sends).toHaveLength(1);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true, summary: 'fetched anyway' });
    const answer = await pending;
    expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expect(refreshedLines()[0]).toMatchObject({ kind: 'refreshed', reason: 'refused' });
  });
});

describe('the refusing posture on the LIVE frame — refused, never asked (D-PR3-19; §24.6 (25))', () => {
  it('a POST from the source’s frame DURING the refresh is REFUSED at once: no dialog parked, the remembered session grant (an inner that WOULD say yes) never consulted, nothing sent; the record carries { host, method, why: "refused" }; the refresh then fails `refused`', async () => {
    connectSource();
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const { fetched, fetchImpl } = recordingFetch();
    const live = liveRuntime(source, fetchImpl);
    // Before the refresh, the user — present — remembers a POST to the host for the session.
    const first = live.net.handle(source, netFrame('POST'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: true, rememberSession: true });
    expect((await first).ok).toBe(true);
    expect((await live.net.handle(source, netFrame('POST'))).ok, 'the remembered grant answers the open app').toBe(true);
    const sentBefore = fetched.length;

    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    const during = await Promise.race([live.net.handle(source, netFrame('POST')), sleep(500).then(() => 'parked — a dialog was asked' as const)]);
    expect(during, 'refused at once, never parked').toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(netConfirmStore.get(), 'no dialog parked').toBeNull();
    expect(fetched, 'nothing sent').toHaveLength(sentBefore);
    expect(runOf(source)?.refused).toEqual([{ host: API_HOST, method: 'POST', why: 'refused' }]);

    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'posted' });
    expect(await pending).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expect(refreshedLines()[0]).toMatchObject({ kind: 'refreshed', grantId: grant.id, reason: 'refused' });
  });

  it('a GET during the refresh passes (GET-only) and is counted on the run', async () => {
    connectSource();
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const { fetched, fetchImpl } = recordingFetch();
    const live = liveRuntime(source, fetchImpl);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    expect((await live.net.handle(source, netFrame('GET'))).ok).toBe(true);
    expect(fetched).toEqual([`https://${API_HOST}/v1/items`]);
    expect(runOf(source)?.calls.net).toBe(1);
    expect(netConfirmStore.get()).toBeNull();
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
  });

  it('the STICKY posture afterwards (D-PR1-3 applies to a refresh): after it ends, a POST from the same frame generation parks an ask tagged `afterRun` — never answered by the remembered session grant', async () => {
    connectSource();
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const { fetched, fetchImpl } = recordingFetch();
    const live = liveRuntime(source, fetchImpl);
    const first = live.net.handle(source, netFrame('POST'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    resolveNetConfirm({ granted: true, rememberSession: true });
    expect((await first).ok).toBe(true);
    const sentBefore = fetched.length;

    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(delegatedRunFor(source)).toBeUndefined();

    const after = live.net.handle(source, netFrame('POST'));
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    expect(netConfirmStore.get()!.scheduled, 'asked once, as after any delegated run').toEqual({ afterRun: true, appName: 'Ledger' });
    resolveNetConfirm({ granted: false });
    expect(await after).toMatchObject({ ok: false, code: NET_ERROR_CODES.NET_CONFIRM_DENIED });
    expect(fetched, 'the remembered grant never answered it').toHaveLength(sentBefore);
  });
});

describe('busy — one instance, never a second copy (D-PR3-17 (9); AC22 "source busy → retryable")', () => {
  it('a delegated run already in flight for the source (its schedule) → ACCESS_BUSY, retryable; the source’s run is untouched; no hint', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const scheduled = beginDelegatedRun({ appId: source, appName: 'Ledger', runId: 'schedule-run-1', taskId: 'task-1', title: 'morning sync', generation: LIVE_GENERATION });
    expect(scheduled.ok).toBe(true);
    try {
      const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
      expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_BUSY, true));
      expect(delegatedRunFor(source)?.runId, 'the schedule’s run is still the one in flight').toBe('schedule-run-1');
      expect(deps.live.notified).toEqual([]);
    } finally {
      endDelegatedRun(source, 'schedule-run-1');
    }
  });

  it('the hidden frame already holds another run (a second hidden mount) → ACCESS_BUSY, retryable; the other mount untouched', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const other = { appId: 'another-app', runId: 'run-other' } as HiddenMount;
    deps.mounts.set(other);
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_BUSY, true));
    expect(deps.mounts.get()).toBe(other);
    expect(deps.runtimeCalls).toEqual([]);
  });
});

describe('the handover — the run follows the source (ADR-0077 §5 applies to a refresh)', () => {
  it('hidden → live: the source OPENING mid-refresh cuts the hidden attempt; the SAME runId is hinted to the live frame after the hidden frame reports unmounted; the live answer lands; the key is written per dispatch and cleared once', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const kvSet = spyKv();
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const { mount, runId } = await hinted(deps);
    deps.live.open(source);
    await vi.waitFor(() => expect(deps.mounts.get()).toBeUndefined());
    await sleep(30);
    expect(deps.live.notified, 'no live hint while the hidden instance may still be running').toEqual([]);
    mount.onUnmounted();
    expect(await liveHint(deps)).toBe(runId);
    expect(runOf(source)?.posture).toBe('refresh');
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(writesOf(kvSet, runId)).toHaveLength(2);
    expect(clearsOf(kvSet, runId)).toHaveLength(1);
    expect(await kvHolds(source, runId)).toBe(false);
  });
});

describe('counting — the file’s day (D-PR3-17 (3), (7); §24.6 (25))', () => {
  it('hidden: the attempt’s AI and network calls are FOLDED into `schedulerState.daily`', async () => {
    const grant = refreshGrant();
    schedulesOn({ ai: 3, net: 7 });
    const deps = fakeDeps();
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const { mount } = await hinted(deps);
    expect((await send(mount.transport)).ok).toBe(true);
    expect(deps.runtimeCalls[0]!.onNetCall()).toBe(true);
    mount.onAppEvent(SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(db.getSchedulerState()?.daily).toMatchObject({ ai: 4, net: 8 });
  });

  it('live: a GET through the open frame is folded into the day too', async () => {
    connectSource();
    const grant = refreshGrant();
    schedulesOn({ ai: 0, net: 2 });
    const deps = fakeDeps();
    deps.live.open(source);
    const { fetchImpl } = recordingFetch();
    const live = liveRuntime(source, fetchImpl);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    expect((await live.net.handle(source, netFrame('GET'))).ok).toBe(true);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
    expect(db.getSchedulerState()?.daily).toMatchObject({ ai: 0, net: 3 });
  });

  it('the ceiling is asked BEFORE dispatch over the FILE’s day: no headroom for one more AI or network call → ACCESS_REFRESH_FAILED reason `capped`, the `refreshed` line written with reason `capped`, nothing dispatched — and no cooldown stamped', async () => {
    for (const counter of ['ai', 'net'] as const) {
      // A source of its own per round: the first round's last ask stamps ITS cooldown.
      source = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
      const grant = refreshGrant();
      schedulesOn({ [counter]: SCHEDULE_DAILY_CEILINGS[counter] });
      const deps = fakeDeps();
      const mounts = watchMounts(deps);
      const kvSet = spyKv();
      deps.live.open(source);
      const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
      expect(answer, counter).toEqual({ ...failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false), message: ACCESS_APP_MESSAGES.refreshFailed('capped') });
      expectNothingDispatched(deps, mounts, kvSet);
      expect(refreshedLines()[0], counter).toMatchObject({ kind: 'refreshed', grantId: grant.id, readerAppId: reader, readerName: 'Budget', via: 'app', reason: 'capped' });

      // Capped is decided before the stamp (D-PR3-17 (3) before (4)): with headroom again, the next ask runs.
      schedulesOn();
      const again = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
      await liveHint(deps);
      deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
      expect(await again, counter).toEqual({ ok: true, op: 'refresh', fresh: true });
      kvSet.mockRestore();
      deps.live.close(source);
    }
  });
});

describe('the cooldown — at most once per source per five minutes, stamped AT DISPATCH (§24.6 (26); D-PR3-17 (2), (4))', () => {
  it('ACCESS_REFRESH_COOLDOWN_MS is five minutes', () => {
    expect(ACCESS_REFRESH_COOLDOWN_MS).toBe(5 * 60_000);
  });

  it('a second ask WHILE the first is still in flight → { fresh: false, reason: "recent" } at once — nothing dispatched, no line; within the window after it ended, still recent; after the window a NEW dispatch with a new runId', async () => {
    fakeClock();
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const first = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const firstRunId = await liveHint(deps);

    const inFlight = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(inFlight).toEqual({ ok: true, op: 'refresh', fresh: false, reason: 'recent' });
    expect(deps.live.notified, 'nothing dispatched for the second ask').toHaveLength(1);

    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await first).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(refreshedLines(), 'one line — the recent answer writes none').toHaveLength(1);

    await vi.advanceTimersByTimeAsync(ACCESS_REFRESH_COOLDOWN_MS - 60_000);
    expect(await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' })).toEqual({ ok: true, op: 'refresh', fresh: false, reason: 'recent' });
    expect(deps.live.notified).toHaveLength(1);
    expect(refreshedLines()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000 + 1);
    const third = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(2));
    const thirdRunId = (deps.live.notified[1]!.data as { runId: string }).runId;
    expect(thirdRunId).toMatch(UUID);
    expect(thirdRunId, 'a fresh runId per dispatch').not.toBe(firstRunId);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await third).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(refreshedLines()).toHaveLength(2);
  });

  it('a dispatch that ENDED in failure (no handler) still stamped the cooldown — the next ask within the window is `recent`', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps({ announceTimeoutMs: SHORT_ANNOUNCE_MS });
    const answer = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expect(await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' })).toEqual({ ok: true, op: 'refresh', fresh: false, reason: 'recent' });
  });

  it('the cooldown is PER SOURCE: another source asked within the window runs', async () => {
    const grant = refreshGrant();
    const pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
    const pantryGrant = refreshGrant({ sourceAppId: pantry });
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    deps.live.open(pantry);
    const first = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await first).toEqual({ ok: true, op: 'refresh', fresh: true });
    const other = refresh.refreshSource(db, deps, { grant: pantryGrant, requestedBy: 'Budget', via: 'app' });
    await vi.waitFor(() => expect(deps.live.notified).toHaveLength(2));
    expect(deps.live.notified[1]!.appId).toBe(pantry);
    deps.live.emit(pantry, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await other).toEqual({ ok: true, op: 'refresh', fresh: true });
  });
});

describe('the `refreshed` line on the SOURCE’s history (§24.6 (27); D-PR3-6, D-PR3-17 (8))', () => {
  it('success: { kind: "refreshed", grantId, readerAppId, readerName, via } — NO reason — written BEFORE the answer resolves; the reader’s own history has none', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' }).then((answer) => ({ answer, newestAtAnswer: history()[0] }));
    await liveHint(deps);
    expect(refreshedLines(), 'not before the run ends').toEqual([]);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    const { answer, newestAtAnswer } = await pending;
    expect(answer).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(newestAtAnswer).toMatchObject({ kind: 'refreshed', grantId: grant.id, readerAppId: reader, readerName: 'Budget', via: 'app' });
    expect(newestAtAnswer).not.toHaveProperty('reason');
    expect(history(reader).filter((entry) => entry.kind === 'refreshed')).toEqual([]);
  });

  it('`via` is the door that asked — carried onto the line as given', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'chat' });
    await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
    expect(refreshedLines()[0]).toMatchObject({ kind: 'refreshed', via: 'chat' });
  });

  it('no handler (the source never announces) → ACCESS_REFRESH_FAILED "the other app does not fetch on request", not retryable; the line’s reason `no-handler`', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps({ announceTimeoutMs: SHORT_ANNOUNCE_MS });
    // The source is closed: the hidden frame mounts and never announces (nobody plays it here).
    const { answer, newestAtAnswer } = await refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' }).then((outcome) => ({ answer: outcome, newestAtAnswer: history()[0] }));
    expect(answer).toEqual({ ...failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false), message: ACCESS_APP_MESSAGES.refreshNoHandler });
    expect(newestAtAnswer).toMatchObject({ kind: 'refreshed', grantId: grant.id, reason: 'no-handler' });
  });

  it('no answer within the bound → ACCESS_REFRESH_FAILED, not retryable; the line’s reason `timeout`; the key cleared', async () => {
    fakeClock();
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps({ resultTimeoutMs: SCHEDULE_RESULT_TIMEOUT_MS });
    const kvSet = spyKv();
    deps.live.open(source);
    let settled: RefreshOutcome | undefined;
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' }).then((answer) => {
      settled = answer;
      return answer;
    });
    const runId = await liveHint(deps);
    expect(await kvHolds(source, runId)).toBe(true);
    await vi.advanceTimersByTimeAsync(SCHEDULE_RESULT_TIMEOUT_MS + 1_000);
    expect(settled, 'the bound settled it').toBeDefined();
    expect(await pending).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expect(refreshedLines()[0]).toMatchObject({ kind: 'refreshed', reason: 'timeout' });
    expect(clearsOf(kvSet, runId)).toHaveLength(1);
    expect(await kvHolds(source, runId)).toBe(false);
  });

  it('the source reporting `ok: false` → ACCESS_REFRESH_FAILED, not retryable; the line’s reason `failed` — its own summary nowhere', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: false, summary: 'LEDGER-SECRET-FAILURE-TEXT' });
    const answer = await pending;
    expect(answer).toMatchObject(failed(ACCESS_ERROR_CODES.ACCESS_REFRESH_FAILED, false));
    expect(JSON.stringify(answer)).not.toContain('LEDGER-SECRET-FAILURE-TEXT');
    expect(refreshedLines()[0]).toMatchObject({ kind: 'refreshed', reason: 'failed' });
    expect(JSON.stringify(history())).not.toContain('LEDGER-SECRET-FAILURE-TEXT');
  });

  it('every reason a line carries is from the fixed set `ACCESS_REFRESH_REASONS`', () => {
    expect([...ACCESS_REFRESH_REASONS]).toEqual(['no-handler', 'timeout', 'capped', 'refused', 'failed']);
  });
});

describe('what crosses — ids in, `fresh` out (S10, S17; §24.6 (27))', () => {
  it('`requestedBy` is folded to ONE line where the input is built: a library name holding a newline reaches the kv input (and the run’s title) without one', async () => {
    const multiLine = db.installApp({ displayName: 'Budget\nplanner\r\n  2026', html: '<html>budget planner</html>' }).appId;
    const raw = db.getApp(multiLine)!.displayName;
    expect(raw, 'precondition: the library keeps the name as given').toContain('\n');
    const grant = refreshGrant({ readerAppId: multiLine });
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: raw, via: 'app' });
    const runId = await liveHint(deps);
    const input = ((await kvValue(source, runId)) as { input: { kind: string; requestedBy: string } }).input;
    expect(input).toEqual({ kind: 'refresh', requestedBy: oneLine(raw) });
    expect(input.requestedBy).not.toMatch(/[\r\n]/);
    expect(runOf(source)?.title).toBe(REFRESH_RUN.title(oneLine(raw)));
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    await pending;
  });

  it('a handler’s summary and notify NEVER reach the answer — it is exactly { ok: true, op: "refresh", fresh: true } — nor the line; the key is written once and cleared once', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const kvSet = spyKv();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const runId = await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true, summary: 'LEDGER-PRIVATE-SUMMARY 4 new rows', notify: { title: 'Ledger', body: 'LEDGER-PRIVATE-NOTIFY' } });
    const answer = await pending;
    expect(answer).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(Object.keys(answer).sort()).toEqual(['fresh', 'ok', 'op']);
    expect(JSON.stringify(history())).not.toMatch(/LEDGER-PRIVATE/);
    expect(writesOf(kvSet, runId)).toHaveLength(1);
    expect(clearsOf(kvSet, runId)).toHaveLength(1);
    expect(await kvHolds(source, runId)).toBe(false);
  });

  it('the kv key is cleared on a FAILED run too (the engine’s finally)', async () => {
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    const kvSet = spyKv();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    const runId = await liveHint(deps);
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: false });
    expect((await pending).ok).toBe(false);
    expect(clearsOf(kvSet, runId)).toHaveLength(1);
    expect(await kvHolds(source, runId)).toBe(false);
  });

  it('after a result the source’s read caches are dropped — `clearSourceReadCaches(db, source)` once; never on a failed run', async () => {
    const broker = await loadWriteBroker();
    const clear = vi.spyOn(broker, 'clearSourceReadCaches');
    const grant = refreshGrant();
    schedulesOn();
    const deps = fakeDeps();
    deps.live.open(source);
    const pending = refresh.refreshSource(db, deps, { grant, requestedBy: 'Budget', via: 'app' });
    await liveHint(deps);
    expect(clear).not.toHaveBeenCalled();
    deps.live.emit(source, SCHEDULE_RESULT_EVENT, { ok: true });
    expect(await pending).toEqual({ ok: true, op: 'refresh', fresh: true });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(expect.anything(), source);

    clear.mockClear();
    const pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
    const failing = fakeDeps({ announceTimeoutMs: SHORT_ANNOUNCE_MS });
    expect((await refresh.refreshSource(db, failing, { grant: refreshGrant({ sourceAppId: pantry }), requestedBy: 'Budget', via: 'app' })).ok).toBe(false);
    expect(clear).not.toHaveBeenCalled();
  });
});
