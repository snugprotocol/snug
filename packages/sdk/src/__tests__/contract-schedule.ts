// The ONE scheduled-run contract for both SDK forms (TASK-20261010-host-broker PR-6, AC40b; ADR-0074
// §3/§4; D-PR6-3). Registered twice: contract-module.test.ts (the typed `schedule.ts`) and
// contract-embedded.test.ts (section 6 of embedded/snug-hooks.js). A fake host plays the other side
// on the same jsdom window: it posts the `schedule-run` hint (ids only), answers the kv read with the
// record the real host writes (`{ taskId, runId, input }`), and collects the ONE `schedule-result`
// app-event per runId — and the `schedule-request` a `proposeSchedule` posts.
//
// Module-only rows stay in schedule.test.ts: `normalizeScheduleResult` (a module export) and every
// proposal only zod refuses (a credential-shaped input — D-PR6-14: shared `proposeSchedule` rows use
// STRUCTURALLY wrong proposals only).
import { act } from 'react';
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
} from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneFaithfulPostMessage, drainMessageQueue, flush, hostStub, renderProbe, type HostStub, type Probe } from './app-harness.js';
import { hostEventFrame, need, readyFrame, type ContractForm, type ContractScheduledRun } from './contract-host-events.js';
import type { ContractMeta } from './contract-suite.js';

const META: ContractMeta = { appId: 'sched-app', displayName: 'Schedule App' };

/** The sentence a throw without a usable message answers (D-PR6-3, both forms). */
const RUN_FAILED = 'the scheduled run failed';

/** A proposal both forms admit: the protocol's `scheduleProposalSchema` and the embedded structural check. */
const PROPOSAL = {
  title: 'Morning forecast',
  steps: [{ kind: 'app-run', appId: 'sched-app', input: { fetch: true } }],
  spec: { kind: 'daily', time: '07:00', tz: 'device' },
} as const;

export function registerScheduleContract(formName: string, fresh: () => ContractForm): void {
  describe(`SDK schedule contract — ${formName}`, () => {
    let host: HostStub;
    const probes: Probe<unknown>[] = [];

    const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
      const probe = await renderProbe(body);
      probes.push(probe as Probe<unknown>);
      return probe;
    };

    /** The host's hint, exactly as ADR-0074 §3 has it: ids only — the content rides the kv. */
    const hint = (runId: string, taskId = 'task-1'): void => host.post(hostEventFrame('schedule-run', { taskId, runId }));
    const results = () => host.frames(FRAME_TYPES.appEvent).filter((f) => f.event === 'schedule-result');
    const requests = () => host.frames(FRAME_TYPES.appEvent).filter((f) => f.event === 'schedule-request');
    const kvGets = (runId: string) => host.dbRequests('kvGet').filter((f) => f.key === `snug:schedule:${runId}`);

    /** Answers the one outstanding kvGet for `runId` with the record the host writes (undefined → nothing stored). */
    const answerKv = async (runId: string, record: unknown): Promise<void> => {
      const get = kvGets(runId)[0];
      expect(get, `a kvGet for snug:schedule:${runId}`).toBeDefined();
      host.dbSucceed(get!.requestId!, record === undefined ? {} : { value: record });
      await flush();
    };

    /** Mounts useSnugApp + useSnugSchedule(handler) and completes the handshake. */
    const connected = async (api: ContractForm, handler: (run: ContractScheduledRun) => unknown) => {
      const useSnugSchedule = need(api, 'useSnugSchedule');
      const probe = await mount(() => {
        useSnugSchedule(handler);
        return api.useSnugApp(META);
      });
      await flush();
      host.ready();
      await flush();
      return probe;
    };

    /** Mounts useSnugApp only and completes the handshake (proposeSchedule needs host-ready). */
    const readyApp = async (api: ContractForm) => {
      const probe = await mount(() => api.useSnugApp(META));
      await flush();
      host.ready();
      await flush();
      return probe;
    };

    // RC-1 (Gate 5): jsdom CATCHES an exception thrown inside a message listener (the bridge's),
    // reports it as a window 'error' event and carries on — so a guard that throws would pass any
    // row asserting only "nothing happened". Every such report fails the row that caused it.
    const errors: string[] = [];
    const onError = (e: ErrorEvent): void => {
      errors.push(String(e.error ?? e.message));
      e.preventDefault();
    };

    beforeEach(async () => {
      await drainMessageQueue();
      host = hostStub();
      errors.length = 0;
      window.addEventListener('error', onError);
    });

    afterEach(() => {
      while (probes.length > 0) probes.pop()?.unmount();
      host.dispose();
      vi.restoreAllMocks();
      window.removeEventListener('error', onError);
      expect(errors, 'an exception thrown inside a listener (jsdom reported it and carried on)').toEqual([]);
    });

    describe('useSnugSchedule — the app side of a scheduled run', () => {
      it('a hint → the kv input is read under scheduleInputKey(runId) → the handler runs ONCE with it → ONE schedule-result app-event', async () => {
        const api = fresh();
        expect(need(api, 'scheduleInputKey')('run-1')).toBe('snug:schedule:run-1');
        const seen: ContractScheduledRun[] = [];
        await connected(api, async (run) => {
          seen.push(run);
          return { ok: true, summary: 'fetched 3 rows', notify: { title: 'Schedule App', body: '3 new' } };
        });
        hint('run-1');
        await flush();
        const gets = host.dbRequests('kvGet');
        expect(gets).toHaveLength(1);
        expect(gets[0]).toMatchObject({ v: PROTOCOL_VERSION, instanceId: 'ins-1', type: FRAME_TYPES.dbRequest, op: 'kvGet', key: 'snug:schedule:run-1' });
        expect(seen).toHaveLength(0); // nothing runs before the input is back

        await answerKv('run-1', { taskId: 'task-1', runId: 'run-1', input: { fetch: true } });
        expect(seen).toEqual([{ runId: 'run-1', taskId: 'task-1', input: { fetch: true } }]);
        const posted = results();
        expect(posted).toHaveLength(1);
        expect(posted[0]).toEqual({
          v: PROTOCOL_VERSION,
          instanceId: 'ins-1',
          type: FRAME_TYPES.appEvent,
          event: 'schedule-result',
          data: { ok: true, summary: 'fetched 3 rows', notify: { title: 'Schedule App', body: '3 new' } },
        });
      });

      it('a repeated hint for the same runId is ignored — even mid-flight: one kv read, one handler run, one result', async () => {
        const api = fresh();
        const handler = vi.fn(async () => ({ ok: true, summary: 'once' }));
        await connected(api, handler);
        hint('run-dup');
        hint('run-dup'); // while the kv read is still outstanding
        await flush();
        expect(kvGets('run-dup')).toHaveLength(1);
        await answerKv('run-dup', { taskId: 'task-1', runId: 'run-dup', input: 1 });
        hint('run-dup'); // after the answer
        await flush();
        expect(kvGets('run-dup')).toHaveLength(1);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(results()).toHaveLength(1);
      });

      // RS-1 (Gate 5): the page remembers 128 answered runIds and forgets the OLDEST — never the
      // newest, never all of them (both mutants passed every other row).
      it('the 128-runId memory forgets the OLDEST: after run-0…run-128, run-1…run-128 stay answered and only run-0 is read and run again', async () => {
        const api = fresh();
        const handler = vi.fn(async (run: ContractScheduledRun) => ({ ok: true, summary: run.runId }));
        await connected(api, handler);
        const ids = Array.from({ length: 129 }, (_, i) => `run-${i}`);
        for (const runId of ids) hint(runId);
        await flush();
        expect(host.dbRequests('kvGet')).toHaveLength(129);
        for (const runId of ids) host.dbSucceed(kvGets(runId)[0]!.requestId!, { value: { taskId: 'task-1', runId } });
        await flush();
        expect(handler).toHaveBeenCalledTimes(129);
        expect(results()).toHaveLength(129);

        for (const runId of ids.slice(1)) hint(runId); // the 128 newest: still remembered
        await flush();
        expect(host.dbRequests('kvGet')).toHaveLength(129);
        expect(results()).toHaveLength(129);

        hint('run-0'); // the oldest: forgotten when run-128 arrived
        await flush();
        expect(kvGets('run-0')).toHaveLength(2);
        expect(host.dbRequests('kvGet')).toHaveLength(130);
        host.dbSucceed(kvGets('run-0')[1]!.requestId!, { value: { taskId: 'task-1', runId: 'run-0' } });
        await flush();
        expect(handler).toHaveBeenCalledTimes(130);
        expect(results()).toHaveLength(130);
        expect(results().at(-1)!.data).toEqual({ ok: true, summary: 'run-0' });
      });

      it('distinct runIds each get their own read, run and result', async () => {
        const api = fresh();
        const handler = vi.fn(async (run: ContractScheduledRun) => ({ ok: true, summary: `did ${run.runId}` }));
        await connected(api, handler);
        hint('a');
        hint('b', 'task-2');
        await flush();
        await answerKv('a', { taskId: 'task-1', runId: 'a' });
        await answerKv('b', { taskId: 'task-2', runId: 'b', input: 'x' });
        expect(handler.mock.calls.map(([run]) => run)).toEqual([
          { runId: 'a', taskId: 'task-1' },
          { runId: 'b', taskId: 'task-2', input: 'x' },
        ]);
        expect(results().map((f) => (f.data as { summary?: string }).summary)).toEqual(['did a', 'did b']);
      });

      it('a missing kv record, a non-object record and a failed kv read each still run the handler — with NO input key', async () => {
        const api = fresh();
        const runs: ContractScheduledRun[] = [];
        await connected(api, (run) => {
          runs.push(run);
          return { ok: true };
        });
        hint('run-bare');
        hint('run-array');
        hint('run-failed');
        await flush();
        await answerKv('run-bare', undefined);
        await answerKv('run-array', ['not', 'a', 'record']);
        host.dbFail(kvGets('run-failed')[0]!.requestId!, { code: 'DB_ERROR', message: 'kv unavailable' });
        await flush();
        expect(runs).toEqual([
          { runId: 'run-bare', taskId: 'task-1' },
          { runId: 'run-array', taskId: 'task-1' },
          { runId: 'run-failed', taskId: 'task-1' },
        ]);
        for (const run of runs) expect('input' in run, run.runId).toBe(false);
        expect(results().map((f) => f.data)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
      });

      it('a malformed hint (no runId, an empty runId, no taskId, a non-object, a number runId, no data) is ignored — the channel is additive', async () => {
        const api = fresh();
        const handler = vi.fn(() => ({ ok: true }));
        await connected(api, handler);
        for (const data of [{ taskId: 'task-1' }, { taskId: 'task-1', runId: '' }, { runId: 'run-1' }, { taskId: '', runId: 'run-1' }, 'run-1', { taskId: 'task-1', runId: 7 }, null]) {
          host.post(hostEventFrame('schedule-run', data));
        }
        host.post(hostEventFrame('schedule-run'));
        await flush();
        expect(host.dbRequests('kvGet')).toHaveLength(0);
        expect(handler).not.toHaveBeenCalled();
        expect(results()).toHaveLength(0);
      });

      // D-PR6-3 [S7, F13]: the throw path is BOUNDED in both forms — m = err && err.message; a
      // non-empty string message is cut to the step-summary bound, anything else answers the fixed sentence.
      it('a handler that throws answers ONE { ok: false, summary } — the message cut to the protocol’s bound, the fixed sentence when there is no usable message', async () => {
        const api = fresh();
        const long = 'x'.repeat(5000);
        const throws: Record<string, () => unknown> = {
          'run-error': () => {
            throw new Error('the API said no');
          },
          'run-long': () => {
            throw new Error(long);
          },
          'run-number-message': () => {
            throw { message: 5 };
          },
          'run-plain-object': () => {
            throw { message: 'a plain object said no' };
          },
          'run-empty': () => {
            throw new Error('');
          },
          'run-string': () => {
            throw 'a bare string';
          },
          'run-null': () => {
            throw null;
          },
          'run-reject': () => Promise.reject(new Error('rejected later')),
        };
        await connected(api, (run) => throws[run.runId]!());
        const runIds = Object.keys(throws);
        for (const runId of runIds) hint(runId);
        await flush();
        for (const runId of runIds) await answerKv(runId, { taskId: 'task-1', runId });
        const byRun = results().map((f) => f.data);
        expect(byRun).toHaveLength(runIds.length);
        expect(byRun).toEqual([
          { ok: false, summary: 'the API said no' },
          { ok: false, summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS) },
          { ok: false, summary: RUN_FAILED },
          { ok: false, summary: 'a plain object said no' },
          { ok: false, summary: RUN_FAILED },
          { ok: false, summary: RUN_FAILED },
          { ok: false, summary: RUN_FAILED },
          { ok: false, summary: 'rejected later' },
        ]);
        expect(SCHEDULE_STEP_SUMMARY_MAX_CHARS).toBe(4096);
        expect((byRun[1] as { summary: string }).summary).toHaveLength(4096);
      });

      it('the result is a summary, not data: extra keys dropped, the protocol’s bounds applied, notify only with both halves, a non-object answers the fixed sentence', async () => {
        const api = fresh();
        const answers: Record<string, unknown> = {
          'run-cap': {
            ok: true,
            summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS + 50),
            notify: { title: 't'.repeat(SCHEDULE_TITLE_MAX_CHARS + 5), body: 'b'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS + 5), extra: 1 },
            rows: [[1, 2, 3]],
          },
          'run-title-only': { ok: true, notify: { title: 'only a title' } },
          'run-empty-body': { ok: true, notify: { title: 'a title', body: '' } },
          'run-not-true': { ok: 'yes', summary: '' },
          'run-undefined': undefined,
          'run-array': [{ ok: true, summary: 'in an array' }],
          'run-string': 'done',
        };
        await connected(api, (run) => answers[run.runId]);
        const runIds = Object.keys(answers);
        for (const runId of runIds) hint(runId);
        await flush();
        for (const runId of runIds) await answerKv(runId, { taskId: 'task-1', runId });
        const data = results().map((f) => f.data);
        expect(data).toEqual([
          {
            ok: true,
            summary: 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS),
            notify: { title: 't'.repeat(SCHEDULE_TITLE_MAX_CHARS), body: 'b'.repeat(SCHEDULE_NOTIFY_BODY_MAX_CHARS) },
          },
          { ok: true },
          { ok: true },
          { ok: false },
          { ok: false, summary: 'the handler returned no result' },
          { ok: false, summary: 'the handler returned no result' },
          { ok: false, summary: 'the handler returned no result' },
        ]);
        expect(Object.keys(data[0] as object).sort()).toEqual(['notify', 'ok', 'summary']);
        expect(Object.keys((data[0] as { notify: object }).notify).sort()).toEqual(['body', 'title']);
      });

      it('the LATEST render’s handler runs (a stale closure never answers), and an unmounted hook answers nothing', async () => {
        const api = fresh();
        const useSnugSchedule = need(api, 'useSnugSchedule');
        let label = 'first';
        const calls: string[] = [];
        const probe = await mount(() => {
          const current = label;
          useSnugSchedule(() => {
            calls.push(current);
            return { ok: true, summary: current };
          });
          return api.useSnugApp(META);
        });
        await flush();
        host.ready();
        await flush();
        label = 'second';
        await probe.rerender();
        hint('run-latest');
        await flush();
        await answerKv('run-latest', { taskId: 'task-1', runId: 'run-latest' });
        expect(calls).toEqual(['second']);
        expect(results()[0]!.data).toEqual({ ok: true, summary: 'second' });

        probe.unmount();
        probes.pop();
        hint('run-after-unmount');
        await flush();
        expect(kvGets('run-after-unmount')).toHaveLength(0);
        expect(results()).toHaveLength(1);
      });

      it('useSnugSchedule may be the FIRST (and only) hook to mount: host-ready and the hint still arrive', async () => {
        const api = fresh();
        const useSnugSchedule = need(api, 'useSnugSchedule');
        const seen: string[] = [];
        await mount(() => {
          useSnugSchedule((run) => {
            seen.push(run.runId);
            return { ok: true, summary: 'solo' };
          });
        });
        await flush();
        host.ready();
        await flush();
        expect(api.bridge.ready).toBe(true);
        hint('run-solo');
        await flush();
        await answerKv('run-solo', undefined);
        expect(seen).toEqual(['run-solo']);
        expect(results()).toHaveLength(1);
        expect(results()[0]).toMatchObject({ instanceId: 'ins-1', data: { ok: true, summary: 'solo' } });
      });

      it('a hint never touches theme, and theme-change never reaches the handler', async () => {
        const api = fresh();
        const handler = vi.fn(() => ({ ok: true }));
        const probe = await connected(api, handler);
        hint('run-theme');
        await flush();
        expect(probe.result.current.theme).toBe('light');
        host.post(hostEventFrame('theme-change', { theme: 'dark', runId: 'run-x', taskId: 'task-1' }));
        await flush();
        expect(probe.result.current.theme).toBe('dark');
        expect(kvGets('run-x')).toHaveLength(0);
      });

      // D-PR6-2: a sibling frame can drive no schedule handler toward a remembered approval (ADR-0077).
      it('a schedule-run from a SIBLING frame triggers no kv read and is NOT remembered — the later real hint for the same runId IS answered', async () => {
        const api = fresh();
        const handler = vi.fn(() => ({ ok: true, summary: 'real' }));
        await connected(api, handler);
        host.foreign(hostEventFrame('schedule-run', { taskId: 'task-1', runId: 'run-sib' }));
        await flush();
        expect(host.dbRequests('kvGet')).toHaveLength(0);
        expect(handler).not.toHaveBeenCalled();

        hint('run-sib'); // the positive twin, same runId
        await flush();
        expect(kvGets('run-sib')).toHaveLength(1);
        await answerKv('run-sib', { taskId: 'task-1', runId: 'run-sib' });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(results()).toHaveLength(1);
        expect(results()[0]!.data).toEqual({ ok: true, summary: 'real' });
      });
    });

    describe('proposeSchedule — the app SUGGESTS, once per page (D-PR6-3 v2)', () => {
      it('before host-ready: false, nothing posted', async () => {
        const api = fresh();
        const proposeSchedule = need(api, 'proposeSchedule');
        await mount(() => api.useSnugApp(META));
        await flush();
        expect(proposeSchedule(PROPOSAL)).toBe(false);
        await flush();
        expect(requests()).toHaveLength(0);
      });

      it('after host-ready: posts ONE app-event schedule-request carrying the proposal and answers true; a second call answers false and posts nothing', async () => {
        const api = fresh();
        const proposeSchedule = need(api, 'proposeSchedule');
        await readyApp(api);
        let first: boolean | undefined;
        await act(async () => {
          first = proposeSchedule(PROPOSAL);
        });
        await flush();
        expect(first).toBe(true);
        expect(proposeSchedule({ ...PROPOSAL, title: 'Evening forecast' })).toBe(false);
        await flush();
        const posted = requests();
        expect(posted).toHaveLength(1);
        expect(posted[0]).toEqual({
          v: PROTOCOL_VERSION,
          instanceId: 'ins-1',
          type: FRAME_TYPES.appEvent,
          event: 'schedule-request',
          data: PROPOSAL,
        });
      });

      it('a STRUCTURALLY wrong proposal is never posted and never spends the page’s one request (no steps; empty or non-object steps; an extra top-level key; a non-object spec; no title; not an object)', async () => {
        const api = fresh();
        const proposeSchedule = need(api, 'proposeSchedule');
        await readyApp(api);
        const { steps: _steps, ...noSteps } = PROPOSAL;
        const { spec: _spec, ...noSpec } = PROPOSAL;
        const { title: _title, ...noTitle } = PROPOSAL;
        const wrong: unknown[] = [
          noSteps,
          { ...PROPOSAL, steps: [] },
          { ...PROPOSAL, steps: 'app-run' },
          { ...PROPOSAL, steps: [null] },
          { ...PROPOSAL, steps: ['app-run'] },
          { ...PROPOSAL, enabled: true }, // an extra top-level key — strict at the top level (D13)
          { ...PROPOSAL, spec: 'daily at 7' },
          { ...PROPOSAL, spec: null },
          noSpec,
          noTitle,
          { ...PROPOSAL, title: '' },
          { ...PROPOSAL, title: 7 },
          null,
          undefined,
          'Morning forecast',
          [PROPOSAL],
        ];
        for (const proposal of wrong) expect(proposeSchedule(proposal), JSON.stringify(proposal) ?? String(proposal)).toBe(false);
        await flush();
        expect(requests()).toHaveLength(0);
        expect(proposeSchedule(PROPOSAL)).toBe(true); // no refusal spent the page's one request
        await flush();
        expect(requests()).toHaveLength(1);
      });

      it('a proposal carrying an uncloneable value answers false, posts nothing and leaves the slot free (true means POSTED)', async () => {
        const api = fresh();
        const proposeSchedule = need(api, 'proposeSchedule');
        await readyApp(api);
        cloneFaithfulPostMessage();
        const uncloneable = { ...PROPOSAL, steps: [{ kind: 'app-run', appId: 'sched-app', input: { later: () => 1 } }] };
        let answer: boolean | undefined;
        expect(() => {
          answer = proposeSchedule(uncloneable);
        }).not.toThrow();
        expect(answer).toBe(false);
        await flush();
        expect(requests()).toHaveLength(0);
        expect(proposeSchedule(PROPOSAL)).toBe(true); // the slot is still free
        await flush();
        expect(requests()).toHaveLength(1);
      });

      it('a host-ready from a SIBLING frame does not arm it: false and nothing posted — the twin from window.parent does', async () => {
        const api = fresh();
        const proposeSchedule = need(api, 'proposeSchedule');
        await mount(() => api.useSnugApp(META));
        await flush();
        host.foreign(readyFrame());
        await flush();
        expect(proposeSchedule(PROPOSAL)).toBe(false);
        await flush();
        expect(requests()).toHaveLength(0);
        host.ready(); // the positive twin
        await flush();
        expect(proposeSchedule(PROPOSAL)).toBe(true);
        await flush();
        expect(requests()).toHaveLength(1);
      });
    });
  });
}
