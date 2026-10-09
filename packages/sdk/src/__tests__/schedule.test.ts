// The scheduled-run handshake, app side (TASK-20261009-scheduling-framework A7; ADR-0074 §3,
// §4). MODULE-ONLY rows: the embedded form has no hook (Q7 — the copy-exactly block changes in
// the starter release wave), so these do not join the shared contract suite. A fake host plays
// the other side on the same jsdom window (app-harness.ts): it posts the `schedule-run` hint,
// answers the kv read with the record the real host writes (`{ taskId, runId, input }`), and
// collects the one `schedule-result` app-event the hook must post — exactly once per runId.
import { act } from 'react';
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  type ScheduleProposal,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSnugBridgeForTests, bridge, onHostEvent } from '../bridge.js';
import {
  SCHEDULE_REQUEST_EVENT,
  SCHEDULE_RESULT_EVENT,
  SCHEDULE_RUN_EVENT,
  __resetSnugScheduleForTests,
  normalizeScheduleResult,
  proposeSchedule,
  scheduleInputKey,
  useSnugSchedule,
  type SnugScheduleHandler,
  type SnugScheduleResult,
  type SnugScheduledRun,
} from '../schedule.js';
import { useSnugApp } from '../hooks.js';
import { drainMessageQueue, flush, hostStub, renderProbe, type HostStub, type Probe } from './app-harness.js';

const META = { appId: 'sched-app', displayName: 'Schedule App' };

/** The host's hint, exactly as ADR-0074 §3 has it: ids only — the content rides the kv. */
const hint = (host: HostStub, runId: string, taskId = 'task-1'): void =>
  host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: SCHEDULE_RUN_EVENT, data: { taskId, runId } });

const results = (host: HostStub) => host.frames(FRAME_TYPES.appEvent).filter((f) => f.event === SCHEDULE_RESULT_EVENT);
const requests = (host: HostStub) => host.frames(FRAME_TYPES.appEvent).filter((f) => f.event === SCHEDULE_REQUEST_EVENT);

describe('useSnugSchedule — the app side of a scheduled run (module form)', () => {
  let host: HostStub;
  const probes: Probe<unknown>[] = [];

  const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
    const probe = await renderProbe(body);
    probes.push(probe as Probe<unknown>);
    return probe;
  };

  /** Mounts useSnugApp + useSnugSchedule(handler) and completes the handshake. */
  const connected = async (handler: SnugScheduleHandler) => {
    const probe = await mount(() => {
      useSnugSchedule(handler);
      return useSnugApp(META);
    });
    await flush();
    host.ready();
    await flush();
    return probe;
  };

  /** Answers the one outstanding kvGet for `runId` with the record the host writes. */
  const answerKv = async (runId: string, record: unknown): Promise<void> => {
    const get = host.dbRequests('kvGet').find((f) => f.key === scheduleInputKey(runId));
    expect(get, `a kvGet for ${scheduleInputKey(runId)}`).toBeDefined();
    host.dbSucceed(get!.requestId!, record === undefined ? {} : { value: record });
    await flush();
  };

  beforeEach(async () => {
    await drainMessageQueue();
    __resetSnugBridgeForTests();
    __resetSnugScheduleForTests();
    host = hostStub();
  });

  afterEach(() => {
    while (probes.length > 0) probes.pop()?.unmount();
    host.dispose();
  });

  it('a hint → the kv input is read under snug:schedule:<runId> → the handler runs with it → ONE schedule-result app-event', async () => {
    const seen: SnugScheduledRun[] = [];
    await connected(async (run) => {
      seen.push(run);
      return { ok: true, summary: 'fetched 3 rows', notify: { title: 'Schedule App', body: '3 new' } };
    });
    hint(host, 'run-1');
    await flush();
    const get = host.dbRequests('kvGet');
    expect(get).toHaveLength(1);
    expect(get[0]).toMatchObject({ v: PROTOCOL_VERSION, instanceId: 'ins-1', op: 'kvGet', key: 'snug:schedule:run-1' });
    expect(seen).toHaveLength(0); // nothing runs before the input is back

    await answerKv('run-1', { taskId: 'task-1', runId: 'run-1', input: { fetch: true } });
    expect(seen).toEqual([{ runId: 'run-1', taskId: 'task-1', input: { fetch: true } }]);
    const posted = results(host);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      v: PROTOCOL_VERSION,
      instanceId: 'ins-1',
      type: FRAME_TYPES.appEvent,
      event: SCHEDULE_RESULT_EVENT,
      data: { ok: true, summary: 'fetched 3 rows', notify: { title: 'Schedule App', body: '3 new' } },
    });
  });

  it('a second hint for the same runId is ignored — one kv read, one handler run, one result (even mid-flight)', async () => {
    const handler = vi.fn<SnugScheduleHandler>(async () => ({ ok: true, summary: 'once' }));
    await connected(handler);
    hint(host, 'run-dup');
    hint(host, 'run-dup'); // while the kv read is still outstanding
    await flush();
    expect(host.dbRequests('kvGet')).toHaveLength(1);
    await answerKv('run-dup', { taskId: 'task-1', runId: 'run-dup', input: 1 });
    hint(host, 'run-dup'); // after the answer
    await flush();
    expect(host.dbRequests('kvGet')).toHaveLength(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(results(host)).toHaveLength(1);
  });

  it('distinct runIds each get their own read, run and result', async () => {
    const handler = vi.fn<SnugScheduleHandler>(async (run) => ({ ok: true, summary: `did ${run.runId}` }));
    await connected(handler);
    hint(host, 'a');
    hint(host, 'b', 'task-2');
    await flush();
    await answerKv('a', { taskId: 'task-1', runId: 'a' });
    await answerKv('b', { taskId: 'task-2', runId: 'b', input: 'x' });
    expect(handler.mock.calls.map(([run]) => run)).toEqual([
      { runId: 'a', taskId: 'task-1' },
      { runId: 'b', taskId: 'task-2', input: 'x' },
    ]);
    expect(results(host).map((f) => (f.data as SnugScheduleResult).summary)).toEqual(['did a', 'did b']);
  });

  it('a missing kv record (the host wrote none) still runs the handler, with no input', async () => {
    const handler = vi.fn<SnugScheduleHandler>(() => ({ ok: true }));
    await connected(handler);
    hint(host, 'run-bare');
    await flush();
    await answerKv('run-bare', undefined);
    expect(handler).toHaveBeenCalledWith({ runId: 'run-bare', taskId: 'task-1' });
    expect(results(host)[0]!.data).toEqual({ ok: true });
  });

  it('a handler that throws answers { ok:false, summary: <message> } — nothing escapes, the host still gets its one result', async () => {
    await connected(() => {
      throw new Error('the API said no');
    });
    hint(host, 'run-throw');
    await flush();
    await answerKv('run-throw', { taskId: 'task-1', runId: 'run-throw' });
    expect(results(host)).toHaveLength(1);
    expect(results(host)[0]!.data).toEqual({ ok: false, summary: 'the API said no' });
  });

  it('a malformed hint (no runId, a non-object, a number) is ignored — the channel is additive', async () => {
    const handler = vi.fn<SnugScheduleHandler>(() => ({ ok: true }));
    await connected(handler);
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1' } });
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: SCHEDULE_RUN_EVENT, data: 'run-1' });
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: SCHEDULE_RUN_EVENT, data: { taskId: 'task-1', runId: 7 } });
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: SCHEDULE_RUN_EVENT });
    await flush();
    expect(host.dbRequests('kvGet')).toHaveLength(0);
    expect(handler).not.toHaveBeenCalled();
    expect(results(host)).toHaveLength(0);
  });

  it('the result is a summary, not data: extra keys are dropped, bounds are the protocol’s, notify needs both halves', async () => {
    await connected(() => ({
      ok: true,
      summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS + 50),
      notify: { title: 't'.repeat(SCHEDULE_TITLE_MAX_CHARS + 5), body: 'b'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS + 5) },
      rows: [[1, 2, 3]],
    } as unknown as SnugScheduleResult));
    hint(host, 'run-cap');
    await flush();
    await answerKv('run-cap', { taskId: 'task-1', runId: 'run-cap' });
    const data = results(host)[0]!.data as SnugScheduleResult & { rows?: unknown };
    expect(Object.keys(data).sort()).toEqual(['notify', 'ok', 'summary']);
    expect(data.summary).toHaveLength(SCHEDULE_STEP_SUMMARY_MAX_CHARS);
    expect(data.notify).toEqual({ title: 't'.repeat(SCHEDULE_TITLE_MAX_CHARS), body: 'b'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS) });

    expect(normalizeScheduleResult({ ok: true, notify: { title: 'only a title' } })).toEqual({ ok: true });
    expect(normalizeScheduleResult({ ok: 'yes', summary: '' })).toEqual({ ok: false });
    expect(normalizeScheduleResult(undefined)).toEqual({ ok: false, summary: 'the handler returned no result' });
  });

  it('the LATEST render’s handler runs (a stale closure never answers), and an unmounted hook answers nothing', async () => {
    let label = 'first';
    const calls: string[] = [];
    const probe = await mount(() => {
      useSnugSchedule(() => {
        calls.push(label);
        return { ok: true, summary: label };
      });
      return useSnugApp(META);
    });
    await flush();
    host.ready();
    await flush();
    label = 'second';
    await probe.rerender();
    hint(host, 'run-latest');
    await flush();
    await answerKv('run-latest', { taskId: 'task-1', runId: 'run-latest' });
    expect(calls).toEqual(['second']);

    probe.unmount();
    probes.pop();
    hint(host, 'run-after-unmount');
    await flush();
    expect(host.dbRequests('kvGet').filter((f) => f.key === scheduleInputKey('run-after-unmount'))).toHaveLength(0);
    expect(results(host)).toHaveLength(1);
  });

  it('theme-change is untouched: the bridge still flips theme with the hook mounted, and a schedule-run hint never touches it', async () => {
    const probe = await connected(() => ({ ok: true }));
    expect(probe.result.current.theme).toBe('light');
    hint(host, 'run-theme');
    await flush();
    expect(probe.result.current.theme).toBe('light');
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'theme-change', data: { theme: 'dark' } });
    await flush();
    expect(probe.result.current.theme).toBe('dark');
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'totally-new-event', data: { theme: 'light' } });
    await flush();
    expect(probe.result.current.theme).toBe('dark'); // unknown events are still ignored
  });
});

describe('proposeSchedule — the app SUGGESTS, once per page (ADR-0074 §4)', () => {
  let host: HostStub;
  const probes: Probe<unknown>[] = [];

  const proposal: ScheduleProposal = {
    title: 'Morning forecast',
    steps: [{ kind: 'app-run', appId: 'sched-app', input: { fetch: true } }],
    spec: { kind: 'daily', time: '07:00', tz: 'device' },
  };

  beforeEach(async () => {
    await drainMessageQueue();
    __resetSnugBridgeForTests();
    __resetSnugScheduleForTests();
    host = hostStub();
  });

  afterEach(() => {
    while (probes.length > 0) probes.pop()?.unmount();
    host.dispose();
  });

  it('before host-ready: false, nothing posted', async () => {
    expect(proposeSchedule(proposal)).toBe(false);
    await flush();
    expect(requests(host)).toHaveLength(0);
  });

  it('after host-ready: posts ONE app-event schedule-request carrying the parsed proposal, and answers true', async () => {
    const probe = await renderProbe(() => useSnugApp(META));
    probes.push(probe as Probe<unknown>);
    await flush();
    host.ready();
    await flush();
    let answer: boolean | undefined;
    await act(async () => {
      answer = proposeSchedule(proposal);
    });
    await flush();
    expect(answer).toBe(true);
    const posted = requests(host);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({
      v: PROTOCOL_VERSION,
      instanceId: 'ins-1',
      type: FRAME_TYPES.appEvent,
      event: SCHEDULE_REQUEST_EVENT,
      data: proposal,
    });
  });

  it('a second call on the same page is dropped and answered false — one request per page', async () => {
    const probe = await renderProbe(() => useSnugApp(META));
    probes.push(probe as Probe<unknown>);
    await flush();
    host.ready();
    await flush();
    expect(proposeSchedule(proposal)).toBe(true);
    expect(proposeSchedule({ ...proposal, title: 'Evening forecast' })).toBe(false);
    await flush();
    expect(requests(host)).toHaveLength(1);
  });

  it('a proposal the protocol shape refuses (no steps; a credential-shaped input) is never posted', async () => {
    const probe = await renderProbe(() => useSnugApp(META));
    probes.push(probe as Probe<unknown>);
    await flush();
    host.ready();
    await flush();
    expect(proposeSchedule({ ...proposal, steps: [] })).toBe(false);
    expect(proposeSchedule({ ...proposal, steps: [{ kind: 'app-run', appId: 'sched-app', input: { token: 'sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' } }] })).toBe(false);
    await flush();
    expect(requests(host)).toHaveLength(0);
    expect(proposeSchedule(proposal)).toBe(true); // a refusal did not spend the page's one request
  });
});

describe('onHostEvent — the bridge’s named subscription', () => {
  beforeEach(async () => {
    await drainMessageQueue();
    __resetSnugBridgeForTests();
  });

  it('delivers the frame’s data to subscribers of that event only; unsubscribe stops it; reset clears every subscriber', async () => {
    const host = hostStub();
    const got: unknown[] = [];
    const other: unknown[] = [];
    const off = onHostEvent('visibility', (data) => got.push(data));
    onHostEvent('resize', (data) => other.push(data));
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'visibility', data: { hidden: true } });
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'visibility' });
    expect(got).toEqual([{ hidden: true }, undefined]);
    expect(other).toEqual([]);
    off();
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'visibility', data: 2 });
    expect(got).toHaveLength(2);
    expect(bridge.hostEventListeners.has('visibility')).toBe(false);
    __resetSnugBridgeForTests();
    expect(bridge.hostEventListeners.size).toBe(0);
    host.dispose();
  });

  it('a subscriber that unsubscribes mid-dispatch does not break delivery to the others', () => {
    const host = hostStub();
    const seen: string[] = [];
    const offA = onHostEvent('ping', () => {
      seen.push('a');
      offA();
    });
    onHostEvent('ping', () => seen.push('b'));
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'ping' });
    host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'ping' });
    expect(seen).toEqual(['a', 'b', 'b']);
    host.dispose();
  });
});
