// AL-03 (TASK-20260806-connected-fetch) — the runner's NetHandler seam. Mirrors the db
// bridge exactly (F5): the net binding is HOST-assigned (`netAppId`, never app-claimed),
// the runner ROUTES net-request frames to the handler and posts the net-response it
// returns, the net frame size class governs both directions (B1 — an oversized response
// is a terminal NET_SIZE_EXCEEDED, never silence), and the runner itself is value-blind
// (it never reads credential values — proven structurally by the dependency lint in
// net-value-blind.test.ts, R4). Stale-instance and no-handler paths match db discipline.
import { ERROR_CODES, FRAME_TYPES, LIMITS, NET_ERROR_CODES, PROTOCOL_VERSION, netResponseSchema } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetHandler, NetHandlerResult } from '../transport.js';
import { announceFrame, flush, mountHost, postFromApp, type HostContext } from './harness.js';

const contexts: HostContext[] = [];
async function mountWithNet(handler: NetHandler, netAppId = 'host-assigned-app'): Promise<HostContext> {
  const ctx = await mountHost({ options: { net: handler, netAppId } });
  contexts.push(ctx);
  return ctx;
}
async function mount(...args: Parameters<typeof mountHost>): Promise<HostContext> {
  const ctx = await mountHost(...args);
  contexts.push(ctx);
  return ctx;
}
afterEach(() => {
  while (contexts.length > 0) contexts.pop()!.destroy();
  vi.restoreAllMocks();
});

const netRequest = (requestId: string, instanceId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.netRequest,
  requestId,
  instanceId,
  url: 'https://api.example.com/v1/data',
  method: 'GET',
  ...over,
});

function netResponses(ctx: HostContext, requestId: string): unknown[] {
  return ctx.posted.filter(
    (f) => (f as { type?: string }).type === FRAME_TYPES.netResponse && (f as { requestId?: string }).requestId === requestId,
  );
}

const okResult: NetHandlerResult = { ok: true, status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };

describe('net-request routing (mirrors the db bridge, F5)', () => {
  it('routes to the handler with the HOST-assigned netAppId — never the app-claimed appId', async () => {
    const handle = vi.fn<NetHandler['handle']>(async () => okResult);
    const ctx = await mountWithNet({ handle }, 'host-assigned-app');
    postFromApp(ctx.iframe, announceFrame({ appId: 'evil-impersonator' }));
    await flush();
    const instanceId = ctx.readies().at(-1)!.instanceId;
    postFromApp(ctx.iframe, netRequest('net-1', instanceId, { method: 'POST', body: '{}' }));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe('host-assigned-app');
    expect(handle.mock.calls[0]![1]).toMatchObject({ url: 'https://api.example.com/v1/data', method: 'POST', body: '{}' });
  });

  it('posts a valid net-response frame built from the handler result', async () => {
    const ctx = await mountWithNet({ handle: async () => okResult });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    const frame = netResponses(ctx, 'net-1').at(-1)!;
    expect(frame).toMatchObject({ v: 1, type: FRAME_TYPES.netResponse, requestId: 'net-1', ok: true, status: 200 });
    expect(netResponseSchema.safeParse(frame).success).toBe(true);
  });

  it('maps a handler error result onto a net-response error frame', async () => {
    const ctx = await mountWithNet({
      handle: async () => ({ ok: false, code: NET_ERROR_CODES.NET_HOST_BLOCKED, message: 'off ceiling', retryable: false }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    expect(netResponses(ctx, 'net-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: NET_ERROR_CODES.NET_HOST_BLOCKED, message: 'off ceiling', retryable: false },
    });
  });

  it('a thrown handler becomes a HOST_ERROR net-response, never an unhandled rejection', async () => {
    const ctx = await mountWithNet({
      handle: async () => {
        throw new Error('handler blew up');
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    expect(netResponses(ctx, 'net-1').at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR } });
  });
});

describe('net capability gating + malformed frames', () => {
  it('a host without a net handler answers NET-capable=false and errors net-requests', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    expect(ctx.readies().at(-1)!.capabilities.net).toBe(false);
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    expect(netResponses(ctx, 'net-1').at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR } });
  });

  it('a host WITH a net handler advertises net=true', async () => {
    const ctx = await mountWithNet({ handle: async () => okResult });
    const instanceId = await ctx.connect();
    expect(ctx.readies().at(-1)!.capabilities.net).toBe(true);
    void instanceId;
  });

  it('a credential-carrying net-request is answered MALFORMED on the wire, handler never called', async () => {
    const handle = vi.fn<NetHandler['handle']>(async () => okResult);
    const ctx = await mountWithNet({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId, { headers: { Authorization: 'Bearer stolen' } }));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(netResponses(ctx, 'net-1').at(-1)).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
  });

  it('drops a net-request bound to a stale instance (post-reload)', async () => {
    const handle = vi.fn<NetHandler['handle']>(async () => okResult);
    const ctx = await mountWithNet({ handle });
    await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', 'ins-stale-999'));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(netResponses(ctx, 'net-1')).toHaveLength(0);
  });

  it('rejects a duplicate in-flight net requestId', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = await mountWithNet({
      handle: async () => {
        await gate;
        return okResult;
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-dup', instanceId));
    await flush();
    postFromApp(ctx.iframe, netRequest('net-dup', instanceId));
    await flush();
    expect(netResponses(ctx, 'net-dup').at(-1)).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR } });
    release();
    await flush();
  });
});

describe('B1 — the net frame size class governs the RESPONSE (never a silent drop)', () => {
  it('an over-cap handler body becomes a terminal NET_SIZE_EXCEEDED net-response', async () => {
    const oversized = 'x'.repeat(LIMITS.MAX_NET_FRAME_BYTES + 1);
    const ctx = await mountWithNet({ handle: async () => ({ ...okResult, body: oversized }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    const frame = netResponses(ctx, 'net-1').at(-1);
    expect(frame).toBeDefined(); // NEVER silence
    expect(frame).toMatchObject({ ok: false, error: { code: NET_ERROR_CODES.NET_SIZE_EXCEEDED } });
  });

  it('a cap-sized handler body still crosses (the executor caps before this; the frame class has envelope margin)', async () => {
    // 1 MiB body — well under MAX_NET_FRAME_BYTES; must be delivered whole.
    const body = 'y'.repeat(LIMITS.MAX_NET_RESPONSE_BODY_BYTES);
    const ctx = await mountWithNet({ handle: async () => ({ ...okResult, body }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId));
    await flush();
    const frame = netResponses(ctx, 'net-1').at(-1) as { ok: boolean; body?: string };
    expect(frame.ok).toBe(true);
    expect(frame.body).toHaveLength(LIMITS.MAX_NET_RESPONSE_BODY_BYTES);
  });

  it('an oversized net-REQUEST is rejected with an error, not silently dropped', async () => {
    const handle = vi.fn<NetHandler['handle']>(async () => okResult);
    const ctx = await mountWithNet({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, netRequest('net-1', instanceId, { method: 'POST', body: 'z'.repeat(LIMITS.MAX_NET_FRAME_BYTES + 1) }));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(netResponses(ctx, 'net-1').at(-1)).toMatchObject({ ok: false });
  });
});
