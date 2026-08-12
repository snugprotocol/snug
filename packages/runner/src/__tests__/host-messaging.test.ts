// Request pipeline ACs (F6, F8, F9): envelope building, streaming accumulation,
// terminal taxonomy, PARSE_FAILED strike budget, duplicate/flood guards, cancel,
// THREAD_CONFLICT backoff, and frame-size handling on both directions.
import {
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  SNUG_APP_REQUEST_TAG,
  parseAppRequest,
} from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransportResult } from '../transport.js';
import {
  flush,
  jsonReply,
  messageFrame,
  mountHost,
  postFromApp,
  responsesFor,
  type HostContext,
} from './harness.js';

const contexts: HostContext[] = [];
async function mount(...args: Parameters<typeof mountHost>): Promise<HostContext> {
  const ctx = await mountHost(...args);
  contexts.push(ctx);
  return ctx;
}
afterEach(() => {
  vi.useRealTimers();
  while (contexts.length > 0) contexts.pop()!.destroy();
  vi.restoreAllMocks();
});

const conflict: TransportResult = {
  ok: false,
  code: ERROR_CODES.THREAD_CONFLICT,
  message: 'agent busy',
  retryable: true,
};

describe('app-message → agent envelope → terminal response', () => {
  it('sends the tagged chat envelope built from the validated frame', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(
      ctx.iframe,
      messageFrame('req-1', instanceId, { state: { board: 'fen' }, responseSchema: { kind: 'string' } }),
    );
    await flush();
    expect(ctx.transport.calls).toHaveLength(1);
    const wire = ctx.transport.calls[0]!.wire;
    expect(wire.startsWith(SNUG_APP_REQUEST_TAG)).toBe(true);
    const parsed = parseAppRequest(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope).toMatchObject({
      appId: 'chess',
      instanceId,
      requestId: 'req-1',
      action: 'player_move',
      payload: { from: 'e2', to: 'e4' },
      state: { board: 'fen' },
    });
  });

  it('accumulates transport deltas into cumulative streaming frames, then a terminal success', async () => {
    const ctx = await mount({
      transportHandler: async ({ options }) => {
        options.onDelta?.('Thinking');
        options.onDelta?.(' about e4…');
        return jsonReply({ message: 'Nc6', move: { from: 'b8', to: 'c6' } });
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const frames = responsesFor(ctx, 'req-1');
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ ok: true, streaming: true, text: 'Thinking', seq: 0 });
    expect(frames[1]).toMatchObject({ ok: true, streaming: true, text: 'Thinking about e4…', seq: 1 });
    expect(frames[2]).toMatchObject({ ok: true, streaming: false, data: { message: 'Nc6' } });
  });

  it('forwards a non-conflict transport error as the terminal frame, honoring code and retryable', async () => {
    const ctx = await mount({
      transportHandler: async () => ({
        ok: false,
        code: ERROR_CODES.NETWORK_ERROR,
        message: 'socket closed',
        retryable: true,
      }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.NETWORK_ERROR, message: 'socket closed', retryable: true },
    });
  });

  it('converts a THROWING transport (contract violation) into exactly one HOST_ERROR terminal', async () => {
    const ctx = await mount({
      transportHandler: async () => {
        throw new Error('transport bug');
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const frames = responsesFor(ctx, 'req-1');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, retryable: true } });
  });
});

describe('PARSE_FAILED strike budget (F8, R6)', () => {
  it('a terminal parse failure records a strike with attemptsRemaining and rawExcerpt', async () => {
    const ctx = await mount({ transportHandler: async () => ({ ok: true, text: 'this is not JSON at all' }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(1);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.PARSE_FAILED,
        retryable: true,
        attemptsRemaining: LIMITS.MAX_PARSE_FAILURES - 1,
        rawExcerpt: expect.stringContaining('this is not JSON'),
      },
    });
  });

  it('a successful parse resets the strike count', async () => {
    let fail = true;
    const ctx = await mount({
      transportHandler: async () => (fail ? { ok: true, text: 'garbage' } : jsonReply({ message: 'ok' })),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(1);
    fail = false;
    postFromApp(ctx.iframe, messageFrame('req-2', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(0);
  });

  it('the exhausting strike fires onBudgetExhausted exactly once and marks the error non-retryable', async () => {
    const onBudgetExhausted = vi.fn();
    const ctx = await mount({
      transportHandler: async () => ({ ok: true, text: 'garbage' }),
      options: { onBudgetExhausted },
    });
    const instanceId = await ctx.connect();
    for (const id of ['req-1', 'req-2', 'req-3']) {
      postFromApp(ctx.iframe, messageFrame(id, instanceId));
      await flush();
    }
    expect(ctx.budget.get('test-budget')).toBe(LIMITS.MAX_PARSE_FAILURES);
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
    expect(responsesFor(ctx, 'req-3').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.PARSE_FAILED, retryable: false, attemptsRemaining: 0 },
    });
  });

  it('requests while exhausted get an immediate non-retryable error — never silence (R3) — without reaching the transport', async () => {
    const onBudgetExhausted = vi.fn();
    const ctx = await mount({ options: { onBudgetExhausted } });
    ctx.budget.set('test-budget', LIMITS.MAX_PARSE_FAILURES);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.PARSE_FAILED, retryable: false, attemptsRemaining: 0 },
    });
    expect(onBudgetExhausted).toHaveBeenCalledTimes(1);
  });

  it('re-announce does NOT reset the budget — the key is host-assigned, not app-claimed (F5)', async () => {
    const ctx = await mount({ transportHandler: async () => ({ ok: true, text: 'garbage' }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(1);
    const fresh = await ctx.connect(); // hostile app re-announces (even a new appId would not matter)
    expect(fresh).not.toBe(instanceId);
    expect(ctx.budget.get('test-budget')).toBe(1);
  });

  it('a cap-truncated unparseable reply is NOT a strike and names the cut-off, not the model (TASK-20260812 AC3)', async () => {
    // The owner's unwinnable loop: stopReason max_tokens means the OUTPUT CAP cut the
    // reply off — blaming the model ("not parseable JSON") and charging a strike turns
    // a host-imposed limit into a parse-failure budget exhaustion the app cannot escape.
    const ctx = await mount({
      transportHandler: async () => ({ ok: true, text: '{"rows":[{"day":"Mon","count":3},{"day":"Tu', stopReason: 'max_tokens' }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(0);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({
      ok: false,
      error: {
        code: ERROR_CODES.HOST_ERROR,
        message: expect.stringContaining('cut off'),
        retryable: true,
      },
    });
  });

  it('a cap-truncated reply whose JSON still parses succeeds normally', async () => {
    // max_tokens only matters when the parse fails — a reply that closed its object
    // before the cut is complete enough to serve.
    const ctx = await mount({
      transportHandler: async () => ({ ok: true, text: '{"message":"done"}', stopReason: 'max_tokens' }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(0);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({ ok: true, streaming: false, data: { message: 'done' } });
  });

  it('a transport-level failure is NOT a strike — only terminal parse failures count (F8)', async () => {
    const ctx = await mount({
      transportHandler: async () => ({ ok: false, code: ERROR_CODES.NETWORK_ERROR, message: 'down', retryable: true }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    expect(ctx.budget.get('test-budget')).toBe(0);
  });
});

describe('duplicate & flood guards (F7)', () => {
  it('a duplicate in-flight requestId gets a non-retryable HOST_ERROR and does not reach the transport again', async () => {
    const ctx = await mount({ transportHandler: () => new Promise(() => {}) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-dup', instanceId));
    postFromApp(ctx.iframe, messageFrame('req-dup', instanceId));
    await flush();
    expect(ctx.transport.calls).toHaveLength(1);
    const frames = responsesFor(ctx, 'req-dup');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, retryable: false } });
  });

  it('the 9th concurrent request is rejected with a retryable HOST_ERROR (MAX_IN_FLIGHT = 8)', async () => {
    const ctx = await mount({ transportHandler: () => new Promise(() => {}) });
    const instanceId = await ctx.connect();
    for (let i = 1; i <= 9; i++) postFromApp(ctx.iframe, messageFrame(`req-${i}`, instanceId));
    await flush();
    expect(ctx.transport.calls).toHaveLength(8);
    expect(responsesFor(ctx, 'req-9').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: true },
    });
  });

  it('a settled requestId frees its in-flight slot', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId)); // same id, no longer in flight
    await flush();
    expect(ctx.transport.calls).toHaveLength(2);
    expect(responsesFor(ctx, 'req-1').filter((f) => (f as { ok: boolean }).ok)).toHaveLength(2);
  });
});

describe('app-cancel', () => {
  it('aborts the transport and answers CANCELLED exactly once, ignoring the late settle', async () => {
    let resolveSend: ((r: TransportResult) => void) | undefined;
    const ctx = await mount({
      transportHandler: () => new Promise<TransportResult>((resolve) => (resolveSend = resolve)),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const signal = ctx.transport.calls[0]!.options.signal;
    postFromApp(ctx.iframe, { v: 1, type: FRAME_TYPES.appCancel, requestId: 'req-1', instanceId });
    await flush();
    expect(signal.aborted).toBe(true);
    const frames = responsesFor(ctx, 'req-1');
    expect(frames.at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.CANCELLED, retryable: false } });
    resolveSend?.(jsonReply({ message: 'too late' })); // post-abort settle must be ignored
    await flush();
    expect(responsesFor(ctx, 'req-1')).toHaveLength(frames.length);
  });

  it('cancel for an unknown or stale requestId is a no-op', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: 1, type: FRAME_TYPES.appCancel, requestId: 'req-ghost', instanceId });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });
});

describe('THREAD_CONFLICT backoff (R6)', () => {
  it('retries with 100/250/500 ms backoff and succeeds on a later attempt', async () => {
    const results: TransportResult[] = [conflict, conflict, jsonReply({ message: 'finally' })];
    const ctx = await mount({ transportHandler: async (_call, i) => results[i]! });
    const instanceId = await ctx.connect();
    vi.useFakeTimers();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(ctx.transport.calls).toHaveLength(1); // still sleeping the first 100ms backoff
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.transport.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(ctx.transport.calls).toHaveLength(3);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({ ok: true, streaming: false, data: { message: 'finally' } });
  });

  it('exhausts all backoffs and surfaces the conflict as the terminal error', async () => {
    const ctx = await mount({ transportHandler: async () => conflict });
    const instanceId = await ctx.connect();
    vi.useFakeTimers();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await vi.advanceTimersByTimeAsync(0);
    for (const ms of LIMITS.THREAD_CONFLICT_BACKOFF_MS) await vi.advanceTimersByTimeAsync(ms);
    expect(ctx.transport.calls).toHaveLength(1 + LIMITS.THREAD_CONFLICT_BACKOFF_MS.length);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.THREAD_CONFLICT, retryable: true },
    });
  });

  it('an abort during the backoff sleep stops the retry loop immediately', async () => {
    const ctx = await mount({ transportHandler: async () => conflict });
    const instanceId = await ctx.connect();
    vi.useFakeTimers();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await vi.advanceTimersByTimeAsync(0); // first attempt returns conflict; host starts sleeping
    postFromApp(ctx.iframe, { v: 1, type: FRAME_TYPES.appCancel, requestId: 'req-1', instanceId });
    await vi.advanceTimersByTimeAsync(0);
    expect(responsesFor(ctx, 'req-1').at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.CANCELLED } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(ctx.transport.calls).toHaveLength(1); // no retry after the abort
  });
});

describe('frame-size handling (F9, R6)', () => {
  it('rejects an oversized inbound app-message with a non-retryable HOST_ERROR before forwarding', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-big', instanceId, { payload: { blob: 'A'.repeat(LIMITS.MAX_FRAME_BYTES) } }));
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(responsesFor(ctx, 'req-big').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: false },
    });
  });

  it('skips an oversized cumulative streaming frame silently while the stream continues', async () => {
    const ctx = await mount({
      transportHandler: async ({ options }) => {
        options.onDelta?.('small');
        options.onDelta?.('B'.repeat(LIMITS.MAX_FRAME_BYTES)); // cumulative now oversized — skipped
        return jsonReply({ message: 'done' });
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const frames = responsesFor(ctx, 'req-1');
    const streaming = frames.filter((f) => (f as { streaming?: boolean }).streaming === true);
    expect(streaming).toHaveLength(1);
    expect(streaming[0]).toMatchObject({ text: 'small' });
    expect(frames.at(-1)).toMatchObject({ ok: true, streaming: false, data: { message: 'done' } });
  });

  it('an oversized TERMINAL success becomes a clamped HOST_ERROR — never silence, and not a parse strike', async () => {
    const ctx = await mount({
      transportHandler: async () => jsonReply({ blob: 'C'.repeat(LIMITS.MAX_FRAME_BYTES) }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const terminal = responsesFor(ctx, 'req-1').at(-1) as { ok: boolean; error: { code: string; message: string; retryable: boolean } };
    expect(terminal).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, retryable: false } });
    expect(terminal.error.message.length).toBeLessThanOrEqual(1000);
    expect(ctx.budget.get('test-budget')).toBe(0);
  });
});
