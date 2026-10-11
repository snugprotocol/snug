// runScopedGate.test.ts — TASK-20261010-host-broker PR-1 (ADR-0077 §3; contract v2 D-PR1-3,
// D-PR1-9). RED-FIRST: `schedule/runScopedGate.ts` does not exist yet.
//
// THE HAZARD THIS GATE CLOSES. The live frame's net handler is composed ONCE, at mount, with the
// page's standing→session chain. A delegated run on that frame would otherwise have a remembered
// *remember for this session* grant — or an armed standing grant — answer a write nobody was
// watching. "Presence is not consent" (lesson :211): the run-scoped gate consults a module store
// PER REQUEST and, while a run owns the app, never asks `inner` at all. It asks the present user
// through the SAME confirm queue under a host-composed tag, once per run, never remembering.
//
// THE CASES (the contract's `confirm(request)`, in order):
//   (1) a run in flight → `asking || refused.length > 0` → `already-asked` at once; else prompt
//       once: granted → `granted += 1`, true; denied → `declined`; the timeout → `timed-out` and
//       the prompt's signal aborted (that is what withdraws the parked dialog).
//   (2) no run, but the frame generation a run touched is still the live one → the sticky
//       after-run ask: prompt with `run: undefined`, record nothing, remember nothing.
//   (3) otherwise → `inner.confirm(request)`, byte-for-byte today's chain.
//
// All deps are injected; the prompt is a fake that parks until the test answers it and settles
// `{granted:false}` when its signal aborts (what `state/net.ts`'s withdraw-by-reference does).
// LOAD-BEARING NEGATIVE: with a run in flight, an `inner` that would say YES is never consulted.
import type { NetConfirmDecision, NetConfirmGate, NetConfirmRequest } from '@snugprotocol/auth';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { DelegatedRun } from '../schedule/runPlacement.js';
import { DELEGATED_CONFIRM_TIMEOUT_MS, createRunScopedGate, type RunScopedGateDeps, type ScheduledPrompt } from '../schedule/runScopedGate.js';

const APP = 'weather';

const post = (over: Partial<NetConfirmRequest> = {}): NetConfirmRequest => ({
  appId: APP,
  host: 'api.example.com',
  method: 'POST',
  url: 'https://api.example.com/v1/items',
  ...over,
});

/** A run record as `runPlacement.ts` keeps it — hand-built so the gate is tested alone. */
function fakeRun(over: Partial<DelegatedRun> = {}): DelegatedRun & { end(): void } {
  const controller = new AbortController();
  return {
    appId: APP,
    appName: 'Weather',
    runId: 'run-1',
    taskId: 't1',
    title: 'Morning forecast',
    generation: 1,
    calls: { ai: 0, net: 0 },
    refused: [],
    granted: 0,
    asking: false,
    signal: controller.signal,
    end: () => controller.abort(),
    ...over,
  };
}

interface Parked {
  ask: ScheduledPrompt;
  answer(decision: NetConfirmDecision): void;
}

/** The confirm queue, faked: parks every ask; an aborted signal withdraws it as a denial. */
type PromptMock = Mock<(ask: ScheduledPrompt) => Promise<NetConfirmDecision>>;

function parkingPrompt(): { prompt: PromptMock; parked: Parked[] } {
  const parked: Parked[] = [];
  const prompt: PromptMock = vi.fn(
    (ask: ScheduledPrompt) =>
      new Promise<NetConfirmDecision>((resolve) => {
        parked.push({ ask, answer: resolve });
        if (ask.signal.aborted) resolve({ granted: false });
        else ask.signal.addEventListener('abort', () => resolve({ granted: false }), { once: true });
      }),
  );
  return { prompt, parked };
}

/** An inner gate that would ALLOW — the page's remembered/armed chain at its most permissive. */
type InnerMock = { confirm: Mock<(request: NetConfirmRequest) => Promise<boolean>> };
const yesInner = (): InnerMock => ({ confirm: vi.fn(async (_request: NetConfirmRequest) => true) });

interface Harness {
  gate: NetConfirmGate;
  inner: InnerMock;
  prompt: PromptMock;
  parked: Parked[];
}

function harness(state: { run?: DelegatedRun; touched?: number; live?: number; timeoutMs?: number | null } = {}): Harness {
  const inner = yesInner();
  const { prompt, parked } = parkingPrompt();
  const deps: RunScopedGateDeps = {
    inner,
    delegated: (appId: string) => (appId === APP ? state.run : undefined),
    touched: (appId: string) => (appId === APP ? state.touched : undefined),
    liveGeneration: (appId: string) => (appId === APP ? state.live : undefined),
    prompt,
    ...(state.timeoutMs === null ? {} : { timeoutMs: state.timeoutMs ?? 1_000 }),
  };
  return { gate: createRunScopedGate(deps), inner, prompt, parked };
}

/** Start a confirm and watch it settle without awaiting it (fake timers stay in charge). */
function start(gate: NetConfirmGate, request: NetConfirmRequest): { result: () => boolean | undefined; settled: Promise<boolean> } {
  let value: boolean | undefined;
  const settled = Promise.resolve(gate.confirm(request)).then((answer) => {
    value = answer;
    return answer;
  });
  return { result: () => value, settled };
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('(3) no run and no touched frame → today’s chain, unchanged', () => {
  it('consults inner (and ONLY inner) with the very request, and answers what inner answers', async () => {
    const h = harness();
    const request = post();
    const call = start(h.gate, request);
    await flush();
    expect(call.result()).toBe(true);
    expect(h.inner.confirm).toHaveBeenCalledTimes(1);
    expect(h.inner.confirm).toHaveBeenCalledWith(request);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('an inner refusal is passed through as a refusal', async () => {
    const h = harness();
    h.inner.confirm.mockImplementation(async () => false);
    const call = start(h.gate, post());
    await flush();
    expect(call.result()).toBe(false);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('a run in flight for ANOTHER app changes nothing for this one', async () => {
    const h = harness({ run: fakeRun() });
    const call = start(h.gate, post({ appId: 'ledger' }));
    await flush();
    expect(call.result()).toBe(true);
    expect(h.inner.confirm).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('a touched generation that is no longer the live one (the frame remounted) → inner', async () => {
    const h = harness({ touched: 1, live: 2 });
    const call = start(h.gate, post());
    await flush();
    expect(call.result()).toBe(true);
    expect(h.inner.confirm).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
  });

  it('a touched generation with NO live frame (the app closed) → inner', async () => {
    const h = harness({ touched: 1, live: undefined });
    const call = start(h.gate, post());
    await flush();
    expect(h.inner.confirm).toHaveBeenCalledTimes(1);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(call.result()).toBe(true);
  });
});

describe('(1) a run in flight — the ask gate', () => {
  it('NEGATIVE: inner is NEVER consulted, even though it would say yes — the dialog is parked instead', async () => {
    const run = fakeRun();
    const h = harness({ run, touched: 1, live: 1 });
    const call = start(h.gate, post());
    await flush();
    expect(h.inner.confirm).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(call.result()).toBeUndefined(); // parked, waiting on the user
    expect(run.asking).toBe(true);
  });

  it('the prompt carries the VERY request object (the withdraw is by reference), the run’s identity, and a live signal', async () => {
    const run = fakeRun();
    const h = harness({ run });
    const request = post();
    start(h.gate, request);
    await flush();
    const ask = h.parked[0]!.ask;
    expect(ask.request).toBe(request);
    expect(ask.run).toMatchObject({ runId: 'run-1', title: 'Morning forecast', appName: 'Weather' });
    expect(ask.signal.aborted).toBe(false);
  });

  it('granted → true, `granted` incremented, nothing refused, and NOTHING REMEMBERED (the next call asks again)', async () => {
    const run = fakeRun();
    const h = harness({ run });
    const first = start(h.gate, post());
    await flush();
    h.parked[0]!.answer({ granted: true, rememberSession: true }); // even a decision that says "remember"
    await flush();
    expect(first.result()).toBe(true);
    expect(run.granted).toBe(1);
    expect(run.refused).toEqual([]);
    expect(run.asking).toBe(false);

    const second = start(h.gate, post());
    await flush();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(second.result()).toBeUndefined();
    expect(h.inner.confirm).not.toHaveBeenCalled();
  });

  it('denied → false and the refusal is recorded `declined` with the host and method', async () => {
    const run = fakeRun();
    const h = harness({ run });
    const call = start(h.gate, post({ method: 'DELETE', host: 'api.example.com' }));
    await flush();
    h.parked[0]!.answer({ granted: false });
    await flush();
    expect(call.result()).toBe(false);
    expect(run.refused).toEqual([{ host: 'api.example.com', method: 'DELETE', why: 'declined' }]);
    expect(run.granted).toBe(0);
    expect(run.asking).toBe(false);
  });

  it('no answer within the bound → false, recorded `timed-out`, and the prompt’s signal is ABORTED (the dialog is withdrawn)', async () => {
    const run = fakeRun();
    const h = harness({ run, timeoutMs: 1_000 });
    const call = start(h.gate, post());
    await flush();
    const ask = h.parked[0]!.ask;
    await vi.advanceTimersByTimeAsync(999);
    expect(call.result()).toBeUndefined();
    expect(ask.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask.signal.aborted).toBe(true);
    expect(call.result()).toBe(false);
    expect(run.refused).toEqual([{ host: 'api.example.com', method: 'POST', why: 'timed-out' }]);
    expect(run.asking).toBe(false);
  });

  it('the default bound is ONE minute (DELEGATED_CONFIRM_TIMEOUT_MS = 60 s) — the dialog says “no answer in a minute”', async () => {
    expect(DELEGATED_CONFIRM_TIMEOUT_MS).toBe(60_000);
    const run = fakeRun();
    const h = harness({ run, timeoutMs: null });
    const call = start(h.gate, post());
    await flush();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(call.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.result()).toBe(false);
    expect(run.refused[0]?.why).toBe('timed-out');
  });

  it('the run ENDING (its signal aborts) withdraws the parked prompt — the confirm settles false', async () => {
    const run = fakeRun();
    const h = harness({ run, timeoutMs: 60_000 });
    const call = start(h.gate, post());
    await flush();
    const ask = h.parked[0]!.ask;
    run.end();
    await flush();
    expect(ask.signal.aborted).toBe(true);
    expect(call.result()).toBe(false);
  });

  it('ONE outstanding ask per run: a second mutating call while one is parked is refused AT ONCE, `already-asked`, no second dialog', async () => {
    const run = fakeRun();
    const h = harness({ run });
    const first = start(h.gate, post({ url: 'https://api.example.com/v1/a' }));
    await flush();
    const second = start(h.gate, post({ url: 'https://api.example.com/v1/b', method: 'PUT' }));
    await flush();
    expect(second.result()).toBe(false);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(run.refused).toEqual([{ host: 'api.example.com', method: 'PUT', why: 'already-asked' }]);
    expect(first.result()).toBeUndefined(); // the first is still with the user
    expect(h.inner.confirm).not.toHaveBeenCalled();
  });

  it('after a refusal, EVERY later ask in the window is `already-asked` at once — a handler cannot park N dialogs', async () => {
    const run = fakeRun();
    const h = harness({ run });
    const first = start(h.gate, post());
    await flush();
    h.parked[0]!.answer({ granted: false });
    await flush();
    expect(first.result()).toBe(false);

    const second = start(h.gate, post());
    const third = start(h.gate, post({ method: 'PATCH' }));
    await flush();
    expect(second.result()).toBe(false);
    expect(third.result()).toBe(false);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(run.refused.map((refusal) => refusal.why)).toEqual(['declined', 'already-asked', 'already-asked']);
    expect(h.inner.confirm).not.toHaveBeenCalled();
  });

  it('after a TIMED-OUT ask, later asks are `already-asked` too', async () => {
    const run = fakeRun();
    const h = harness({ run, timeoutMs: 1_000 });
    start(h.gate, post());
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    const later = start(h.gate, post());
    await flush();
    expect(later.result()).toBe(false);
    expect(h.prompt).toHaveBeenCalledTimes(1);
    expect(run.refused.map((refusal) => refusal.why)).toEqual(['timed-out', 'already-asked']);
  });
});

describe('(2) the sticky after-run ask — the frame a run touched stays ask-only (D-PR1-3)', () => {
  it('touched === live generation and no run → the prompt with `run: undefined`; inner NEVER consulted', async () => {
    const h = harness({ touched: 4, live: 4 });
    const request = post();
    const call = start(h.gate, request);
    await flush();
    expect(h.inner.confirm).not.toHaveBeenCalled();
    expect(h.prompt).toHaveBeenCalledTimes(1);
    const ask = h.parked[0]!.ask;
    expect(ask.run).toBeUndefined();
    expect(ask.request).toBe(request);
    h.parked[0]!.answer({ granted: true });
    await flush();
    expect(call.result()).toBe(true);
  });

  it('a grant is never remembered — even one whose decision says `rememberSession` — the next call asks again', async () => {
    const h = harness({ touched: 4, live: 4 });
    const first = start(h.gate, post());
    await flush();
    h.parked[0]!.answer({ granted: true, rememberSession: true });
    await flush();
    expect(first.result()).toBe(true);
    start(h.gate, post());
    await flush();
    expect(h.prompt).toHaveBeenCalledTimes(2);
    expect(h.inner.confirm).not.toHaveBeenCalled();
  });

  it('a denial answers false, and records nothing (there is no run to record on) — the next call asks again rather than refusing', async () => {
    const h = harness({ touched: 4, live: 4 });
    const first = start(h.gate, post());
    await flush();
    h.parked[0]!.answer({ granted: false });
    await flush();
    expect(first.result()).toBe(false);
    start(h.gate, post());
    await flush();
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it('the after-run ask is bounded too: no answer in the bound → false, and its signal aborts', async () => {
    const h = harness({ touched: 4, live: 4, timeoutMs: 1_000 });
    const call = start(h.gate, post());
    await flush();
    const ask = h.parked[0]!.ask;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ask.signal.aborted).toBe(true);
    expect(call.result()).toBe(false);
    expect(h.inner.confirm).not.toHaveBeenCalled();
  });
});
