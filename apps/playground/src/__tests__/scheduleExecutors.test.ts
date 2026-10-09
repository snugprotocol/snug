// scheduleExecutors.test.ts — TASK-20261009-scheduling-framework E6 (ADR-0074 §5, §6): the step
// executors behind `engine-types.ts`'s `StepExecutor` seam — dispatch by `step.kind`, the outcome
// discipline every executor shares (a throw is a `failed` outcome, an aborted signal is a
// `failed` outcome that says "cancelled", every summary is credential-refused, shape-scrubbed
// and capped), and the PR-A arms: *Remind me* answers an inbox result plus a SUGGESTED alert the
// queue decides on; *Run [app]* is refused by name until PR-B replaces it.
//
// The *Ask the AI* arm is exercised end to end against a real in-memory user db in
// `scheduleAppThink.test.ts`; here it is driven through a FAKE db and a fake transport so the
// shared discipline is proven without a wasm boot.
import type { UserDb } from '@snugprotocol/db';
import { SCHEDULE_STEP_SUMMARY_MAX_CHARS, type ScheduleStep, type ScheduledTask } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';
import { describe, expect, it, vi } from 'vitest';

import { NO_HIDDEN_FRAME, type AppRunDeps } from '../schedule/appRun.js';
import { appMissing, blockedHere } from '../schedule/copy.js';
import type { StepContext } from '../schedule/engine-types.js';
import {
  CANCELLED_SUMMARY,
  WITHHELD_SUMMARY,
  createStepExecutor,
  executeStep,
  finalizeOutcome,
} from '../schedule/executors.js';

const NOW = '2026-10-09T15:00:00.000Z';

function task(steps: ScheduleStep[]): ScheduledTask {
  return {
    id: 'task-1',
    title: 'morning check',
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

/** A db that knows ONE app with no schema and answers every scratch run with no statements. */
function fakeDb(overrides: Partial<UserDb> = {}): UserDb {
  const db: Partial<UserDb> = {
    getApp: (appId) =>
      appId === 'app-1'
        ? { appId, displayName: 'Ledger', usesDb: true, currentVersion: 1, createdAt: NOW, updatedAt: NOW }
        : undefined,
    getAppSchema: () => undefined,
    scratchRun: () => Promise.resolve({ statements: [] }),
    ...overrides,
  };
  return db as UserDb;
}

function context(steps: ScheduleStep[], extra: Partial<StepContext> = {}): StepContext {
  return {
    task: task(steps),
    run: { id: 'run-1', taskId: 'task-1', dueAt: NOW, trigger: 'due' },
    db: fakeDb(),
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    ...extra,
  };
}

/** A transport that answers one fixed text and records every wire it was handed. */
function fakeTransport(text: string): AgentTransport & { wires: string[] } {
  const wires: string[] = [];
  return {
    wires,
    send: (wire) => {
      wires.push(wire);
      return Promise.resolve({ ok: true as const, text });
    },
  };
}

const think: ScheduleStep = { kind: 'app-think', appId: 'app-1', prompt: 'what changed?', context: { maxRows: 50 } };

describe('dispatch — one executor per step kind', () => {
  it('notify → an ok inbox result whose summary is the body, plus the alert the queue may raise; nothing spent', async () => {
    const step: ScheduleStep = { kind: 'notify', title: 'stand up', body: 'time to stretch' };
    const outcome = await executeStep(step, context([step]));
    expect(outcome).toEqual({
      status: 'ok',
      summary: 'time to stretch',
      calls: { ai: 0, net: 0 },
      alert: { title: 'stand up', body: 'time to stretch' },
    });
  });

  it('app-run → the hidden-frame seams (PR-B, `appRun.ts`); a composition WITHOUT them is blocked by name, nothing spent', async () => {
    const step: ScheduleStep = { kind: 'app-run', appId: 'app-1' };
    const without = createStepExecutor({ transportFor: () => undefined });
    expect(await without(step, context([step]))).toEqual({ status: 'blocked', summary: blockedHere(NO_HIDDEN_FRAME).text, calls: { ai: 0, net: 0 } });
    // With them: the seams are reached (the platform is the first thing the arm asks).
    const platform = vi.fn(() => ({ kind: 'web' as const, capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false } }));
    const appRun = { platform } as unknown as AppRunDeps;
    const outcome = await createStepExecutor({ transportFor: () => undefined, appRun })(step, context([step]));
    expect(platform).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe('blocked'); // no scheduler seat on that fake platform — the arm refused by name (appRunHandshake.test.tsx drives the rest)
  });

  it('app-think → the injected transport is asked for the step’s app and its answer is the summary', async () => {
    const transport = fakeTransport(JSON.stringify({ answer: 'nothing changed overnight' }));
    const transportFor = vi.fn(() => transport);
    const execute = createStepExecutor({ transportFor });
    const outcome = await execute(think, context([think]));
    expect(outcome).toEqual({ status: 'ok', summary: 'nothing changed overnight', calls: { ai: 1, net: 0 } });
    expect(transportFor).toHaveBeenCalledWith('app-1');
    expect(transport.wires).toHaveLength(1);
  });

  it('an unknown kind (a row a newer host wrote) is a failed outcome, never a throw', async () => {
    const step = { kind: 'app-dream', appId: 'app-1' } as unknown as ScheduleStep;
    const outcome = await executeStep(step, context([]));
    expect(outcome.status).toBe('failed');
    expect(outcome.calls).toEqual({ ai: 0, net: 0 });
    expect(outcome.summary).toContain('app-dream');
  });
});

describe('the shared discipline', () => {
  it('a throw inside an executor is a failed outcome carrying the message', async () => {
    const execute = createStepExecutor({
      transportFor: () => {
        throw new Error('no transport today');
      },
    });
    const outcome = await execute(think, context([think]));
    expect(outcome).toEqual({ status: 'failed', summary: 'no transport today', calls: { ai: 0, net: 0 } });
  });

  it('a non-Error throw is still a failed outcome with a readable summary', async () => {
    const db = fakeDb({
      getApp: () => {
        throw 'plain string'; // eslint-disable-line @typescript-eslint/only-throw-error -- the point of the test
      },
    });
    const execute = createStepExecutor({ transportFor: () => fakeTransport('{}') });
    const outcome = await execute(think, context([think], { db }));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe('plain string');
  });

  it('a signal aborted BEFORE the step starts → failed, "cancelled", and the transport is never asked', async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = fakeTransport('{"answer":"late"}');
    const execute = createStepExecutor({ transportFor: () => transport });
    const outcome = await execute(think, context([think], { signal: controller.signal }));
    expect(outcome).toEqual({ status: 'failed', summary: CANCELLED_SUMMARY, calls: { ai: 0, net: 0 } });
    expect(CANCELLED_SUMMARY).toBe('cancelled');
    expect(transport.wires).toHaveLength(0);
  });

  it('a signal aborted WHILE the step runs → failed, "cancelled" — the queue records the run as interrupted', async () => {
    const controller = new AbortController();
    const transport: AgentTransport = {
      send: () => {
        controller.abort();
        return Promise.resolve({ ok: true as const, text: '{"answer":"too late to matter"}' });
      },
    };
    const execute = createStepExecutor({ transportFor: () => transport });
    const outcome = await execute(think, context([think], { signal: controller.signal }));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe(CANCELLED_SUMMARY);
  });

  it('a summary is capped at SCHEDULE_STEP_SUMMARY_MAX_CHARS', async () => {
    const long = 'x'.repeat(SCHEDULE_STEP_SUMMARY_MAX_CHARS + 500);
    const execute = createStepExecutor({ transportFor: () => fakeTransport(JSON.stringify({ answer: long })) });
    const outcome = await execute(think, context([think]));
    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toHaveLength(SCHEDULE_STEP_SUMMARY_MAX_CHARS);
  });

  it('a credential-shaped summary is WITHHELD whole — the fixed sentence, never the value', async () => {
    const execute = createStepExecutor({
      transportFor: () => fakeTransport(JSON.stringify({ answer: 'use Bearer eyJhbGciOiJIUzI1NiJ9.abcdef0123456789.0123456789abcdef to call it' })),
    });
    const outcome = await execute(think, context([think]));
    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toBe(WITHHELD_SUMMARY);
    expect(WITHHELD_SUMMARY).toBe('a result was withheld because it looked like a credential');
  });

  it('the credential refusal applies to the alert and to a failure message too — a transport error cannot echo a key', async () => {
    const transport: AgentTransport = {
      send: () => Promise.resolve({ ok: false as const, code: 'HOST_ERROR', message: 'provider said: invalid key sk-ant-api03-0123456789abcdefghijklmnop', retryable: false }),
    };
    const execute = createStepExecutor({ transportFor: () => transport });
    const outcome = await execute(think, context([think]));
    expect(outcome.status).toBe('failed');
    expect(outcome.summary).toBe(WITHHELD_SUMMARY);
  });

  it('a blocked app-think (the app was deleted) reads the copy module’s sentence', async () => {
    const gone: ScheduleStep = { kind: 'app-think', appId: 'app-gone', prompt: 'hi', context: { maxRows: 50 } };
    const execute = createStepExecutor({ transportFor: () => fakeTransport('{}') });
    const outcome = await execute(gone, context([gone]));
    expect(outcome).toEqual({ status: 'blocked', summary: appMissing.text, calls: { ai: 0, net: 0 } });
  });
});

describe('finalizeOutcome — the one place the result text is made safe to store', () => {
  it('shape-scrubs prose that is not refused outright (a long token run) and keeps the rest', () => {
    const token = 'A1'.repeat(30);
    const out = finalizeOutcome({ status: 'ok', summary: `the echo was ${token} and that is all`, calls: { ai: 1, net: 0 } });
    expect(out.summary).toBe('the echo was «redacted» and that is all');
  });

  it('withholds a summary that carries a known key prefix inside prose', () => {
    const out = finalizeOutcome({ status: 'ok', summary: 'try ghp_0123456789abcdefghijABCDEFGHIJ next', calls: { ai: 1, net: 0 } });
    expect(out.summary).toBe(WITHHELD_SUMMARY);
  });

  it('withholds the alert body on the same rule and leaves a clean alert alone', () => {
    const clean = finalizeOutcome({ status: 'ok', calls: { ai: 0, net: 0 }, alert: { title: 'hi', body: 'all good' } });
    expect(clean.alert).toEqual({ title: 'hi', body: 'all good' });
    const dirty = finalizeOutcome({ status: 'ok', calls: { ai: 0, net: 0 }, alert: { title: 'hi', body: 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst' } });
    expect(dirty.alert).toEqual({ title: 'hi', body: WITHHELD_SUMMARY });
  });

  it('drops a pending change whose statement or reason carries a credential — the run row must stay parseable', () => {
    const out = finalizeOutcome({
      status: 'ok',
      summary: 'ok',
      calls: { ai: 1, net: 0 },
      proposals: [
        { appId: 'ledger', sql: 'DELETE FROM t WHERE id = 1', summary: 'stale row', counts: { changes: 1 } },
        { appId: 'ledger', sql: "UPDATE t SET note = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst' WHERE id = 2", summary: 'x', counts: { changes: 1 } },
      ],
    });
    expect(out.proposals).toEqual([{ appId: 'ledger', sql: 'DELETE FROM t WHERE id = 1', summary: 'stale row', counts: { changes: 1 } }]);
  });

  it('an absent summary stays absent and an empty one stays empty — no sentence is invented', () => {
    expect(finalizeOutcome({ status: 'skipped', calls: { ai: 0, net: 0 } })).toEqual({ status: 'skipped', calls: { ai: 0, net: 0 } });
    expect(finalizeOutcome({ status: 'ok', summary: '', calls: { ai: 0, net: 0 } }).summary).toBe('');
  });
});
