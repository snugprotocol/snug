// TASK-20261010-cross-app-access AC3 — the runner's AccessHandler seam (ADR-0075 §1). The
// fourth routed capability beside db and net, expressed through the SAME `routeCapability`
// ladder: the access binding is HOST-assigned (`accessAppId`, ≡ the dbNamespace discipline —
// the announce appId never identifies anyone), the runner ROUTES the validated
// access-request to the handler and posts the access-response it returns (value-blind: no
// grant, scope or SQL is read here), stale instances are dropped, duplicates and floods
// refused, a thrown handler is a HOST_ERROR, and an over-cap answer can only ever become a
// SMALL terminal ACCESS_SIZE_EXCEEDED — never silence. Every refusal has its passing twin.
import {
  ACCESS_ERROR_CODES,
  ACCESS_MAX_RESULT_BYTES,
  ERROR_CODES,
  FRAME_TYPES,
  LIMITS,
  PROTOCOL_VERSION,
  accessResponseSchema,
  frameWithinLimits,
  type AccessGrantView,
  type Frame,
} from '@snugprotocol/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IN_FLIGHT } from '../host.js';
import type { AccessHandler, AccessHandlerResult } from '../transport.js';
import { announceFrame, flush, mountHost, postFromApp, type HostContext } from './harness.js';

const contexts: HostContext[] = [];
async function mountWithAccess(handler: AccessHandler, accessAppId = 'host-assigned-reader'): Promise<HostContext> {
  const ctx = await mountHost({ options: { access: handler, accessAppId } });
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

const GRANT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const grantView: AccessGrantView = {
  id: GRANT_ID,
  access: 'read',
  source: { displayName: 'Ledger', iconEmoji: '📒' },
  tables: [{ name: 'transactions', columns: ['amount', 'category', 'date'] }],
  duration: 'session',
  unattended: false,
};

/** The op-specific body of each access-request (the request frame is STRICT per op). */
const OP_BODIES = {
  request: { op: 'request', purpose: 'to show spending by category' },
  query: { op: 'query', grantId: GRANT_ID, sql: 'SELECT amount, category FROM transactions' },
  list: { op: 'list' },
  release: { op: 'release', grantId: GRANT_ID },
} as const;

type Op = keyof typeof OP_BODIES;

const accessRequest = (
  requestId: string,
  instanceId: unknown,
  body: Record<string, unknown> = OP_BODIES.query,
): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.accessRequest,
  requestId,
  instanceId,
  ...body,
});

/** The handler's success answer for each op (no v/type/requestId — the runner adds them). */
const OK_RESULTS: Record<Op, AccessHandlerResult> = {
  request: { ok: true, op: 'request', grant: grantView },
  query: { ok: true, op: 'query', columns: ['amount', 'category'], rows: [[12.5, 'food'], [40, 'rent']], truncated: true, totalRows: 900 },
  list: { ok: true, op: 'list', grants: [grantView] },
  release: { ok: true, op: 'release' },
};

function accessResponses(ctx: HostContext, requestId: string): Frame[] {
  return ctx.posted.filter(
    (f) => (f as { type?: string }).type === FRAME_TYPES.accessResponse && (f as { requestId?: string }).requestId === requestId,
  );
}

function allAccessResponses(ctx: HostContext): Frame[] {
  return ctx.posted.filter((f) => (f as { type?: string }).type === FRAME_TYPES.accessResponse);
}

/** A handler whose answers wait until `release()` — the in-flight window made observable. */
function gatedHandler(result: AccessHandlerResult = OK_RESULTS.query) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const handle = vi.fn<AccessHandler['handle']>(async () => {
    await gate;
    return result;
  });
  return { handler: { handle }, handle, release: () => open() };
}

describe('access-request routing — the HOST-assigned binding (C2: the announce never identifies anyone)', () => {
  it('routes to the handler with the HOST-assigned accessAppId — the announce appId "evil" is ignored', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle }, 'host-assigned-reader');
    postFromApp(ctx.iframe, announceFrame({ appId: 'evil' }));
    await flush();
    const instanceId = ctx.readies().at(-1)!.instanceId;
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe('host-assigned-reader');
    expect(handle.mock.calls[0]![0]).not.toBe('evil');
    expect(handle.mock.calls[0]![1]).toMatchObject({ requestId: 'acc-1', op: 'query', grantId: GRANT_ID, sql: OP_BODIES.query.sql });
  });

  it('the binding follows the embedder, not the app: a second host with another accessAppId hands THAT id over for the same frame', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.list);
    const ctx = await mountWithAccess({ handle }, 'another-reader');
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.list));
    await flush();
    expect(handle.mock.calls[0]![0]).toBe('another-reader');
  });

  it('an accepted access-request is observed inbound (onFrame) like every admitted app-origin frame', async () => {
    const ctx = await mountWithAccess({ handle: async () => OK_RESULTS.list });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.list));
    await flush();
    expect(ctx.observed).toContainEqual({ direction: 'inbound', type: FRAME_TYPES.accessRequest });
    expect(ctx.observed).toContainEqual({ direction: 'outbound', type: FRAME_TYPES.accessResponse });
  });

  it.each(Object.keys(OP_BODIES) as Op[])(
    'op %s: the posted access-response is built from the handler result and parses against accessResponseSchema',
    async (op) => {
      const ctx = await mountWithAccess({ handle: async () => OK_RESULTS[op] });
      const instanceId = await ctx.connect();
      postFromApp(ctx.iframe, accessRequest(`acc-${op}`, instanceId, OP_BODIES[op]));
      await flush();
      const frames = accessResponses(ctx, `acc-${op}`);
      expect(frames).toHaveLength(1); // exactly one terminal
      const frame = frames[0]!;
      expect(frame).toEqual({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: `acc-${op}`, ...OK_RESULTS[op] });
      expect(accessResponseSchema.safeParse(frame).success).toBe(true);
    },
  );

  it('a query answer without truncated/totalRows carries neither key (absent stays absent)', async () => {
    const ctx = await mountWithAccess({ handle: async () => ({ ok: true, op: 'query', columns: ['n'], rows: [[1]] }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    const frame = accessResponses(ctx, 'acc-1').at(-1) as Record<string, unknown>;
    expect(frame).toEqual({ v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: 'acc-1', ok: true, op: 'query', columns: ['n'], rows: [[1]] });
    expect('truncated' in frame).toBe(false);
    expect('totalRows' in frame).toBe(false);
  });

  it('maps a handler error result onto an access-response error frame { code, message, retryable } — not retryable', async () => {
    const ctx = await mountWithAccess({
      handle: async () => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, message: 'no live grant', retryable: false }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    const frame = accessResponses(ctx, 'acc-1').at(-1);
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'acc-1',
      ok: false,
      error: { code: ACCESS_ERROR_CODES.ACCESS_NOT_GRANTED, message: 'no live grant', retryable: false },
    });
    expect(accessResponseSchema.safeParse(frame).success).toBe(true);
  });

  it('maps a retryable handler error (ACCESS_PENDING) with retryable: true intact', async () => {
    const ctx = await mountWithAccess({
      handle: async () => ({ ok: false, code: ACCESS_ERROR_CODES.ACCESS_PENDING, message: 'already waiting on the user', retryable: true }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.request));
    await flush();
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ACCESS_ERROR_CODES.ACCESS_PENDING, retryable: true },
    });
  });

  it('a thrown handler becomes a retryable HOST_ERROR access-response, never an unhandled rejection or silence', async () => {
    const ctx = await mountWithAccess({
      handle: async () => {
        throw new Error('handler blew up');
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(1);
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'handler blew up', retryable: true },
    });
  });

  it('a handler that throws a non-Error still answers HOST_ERROR with a named message', async () => {
    const ctx = await mountWithAccess({
      handle: () => Promise.reject('nope' as unknown as Error),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'access handler threw', retryable: true },
    });
  });
});

describe('access capability gating', () => {
  it('a host WITHOUT an access handler advertises access: false and answers an access-request HOST_ERROR (named, not retryable)', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    expect(ctx.readies().at(-1)!.capabilities.access).toBe(false);
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.request));
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(1); // answered, never hung
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'this host has no access capability', retryable: false },
    });
  });

  it('twin: a host WITH an access handler advertises access: true and routes the same request', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.request);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    expect(ctx.readies().at(-1)!.capabilities.access).toBe(true);
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.request));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({ ok: true, op: 'request' });
  });

  it('a db-only host does not grow an access capability (each seat is gated by its own handler)', async () => {
    const ctx = await mount({ options: { db: { handle: async () => ({ ok: true as const }) }, dbNamespace: 'ns' } });
    await ctx.connect();
    expect(ctx.readies().at(-1)!.capabilities).toMatchObject({ db: true, access: false });
  });
});

describe('the shared ladder — stale, duplicate, flood, superseded', () => {
  it('drops an access-request bound to a stale instance: handler never called, nothing posted', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', 'ins-stale-999'));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(0);
  });

  it('twin: the same request on the CURRENT instance is routed and answered', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(1);
  });

  it('a request from the PREVIOUS instance after a re-announce is dropped (the instance rolled)', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const first = await ctx.connect();
    const second = await ctx.connect(); // re-announce mints a fresh instance
    expect(second).not.toBe(first);
    postFromApp(ctx.iframe, accessRequest('acc-old', first));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(accessResponses(ctx, 'acc-old')).toHaveLength(0);
  });

  it('refuses a duplicate in-flight access requestId with a non-retryable HOST_ERROR; the handler is called once', async () => {
    const { handler, handle, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-dup', instanceId));
    await flush();
    postFromApp(ctx.iframe, accessRequest('acc-dup', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(accessResponses(ctx, 'acc-dup').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'access requestId acc-dup is already in flight', retryable: false },
    });
    release();
    await flush();
    expect(accessResponses(ctx, 'acc-dup').at(-1)).toMatchObject({ ok: true, op: 'query' });
  });

  it('twin: two DISTINCT concurrent requestIds are both routed and both answered ok', async () => {
    const { handler, handle, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-a', instanceId));
    postFromApp(ctx.iframe, accessRequest('acc-b', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(2);
    release();
    await flush();
    expect(accessResponses(ctx, 'acc-a')).toEqual([expect.objectContaining({ ok: true })]);
    expect(accessResponses(ctx, 'acc-b')).toEqual([expect.objectContaining({ ok: true })]);
  });

  it(`refuses the (MAX_IN_FLIGHT + 1)th concurrent access-request with a RETRYABLE HOST_ERROR`, async () => {
    const { handler, handle, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    for (let i = 0; i < MAX_IN_FLIGHT; i++) postFromApp(ctx.iframe, accessRequest(`acc-${i}`, instanceId));
    await flush();
    postFromApp(ctx.iframe, accessRequest('acc-over', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    expect(accessResponses(ctx, 'acc-over').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: `too many concurrent access requests (max ${MAX_IN_FLIGHT})`, retryable: true },
    });
    release();
    await flush();
  });

  it('twin: once the in-flight seat drains, a new access-request is accepted again', async () => {
    const { handler, handle, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    for (let i = 0; i < MAX_IN_FLIGHT; i++) postFromApp(ctx.iframe, accessRequest(`acc-${i}`, instanceId));
    await flush();
    release();
    await flush();
    postFromApp(ctx.iframe, accessRequest('acc-after', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
    expect(accessResponses(ctx, 'acc-after').at(-1)).toMatchObject({ ok: true });
  });

  it('the access seat is its own: a full access seat does not refuse a db-request', async () => {
    const { handler, release } = gatedHandler();
    const dbHandle = vi.fn(async () => ({ ok: true as const, rows: [[1]] }));
    const ctx = await mount({ options: { access: handler, accessAppId: 'reader', db: { handle: dbHandle }, dbNamespace: 'ns' } });
    const instanceId = await ctx.connect();
    for (let i = 0; i < MAX_IN_FLIGHT; i++) postFromApp(ctx.iframe, accessRequest(`acc-${i}`, instanceId));
    await flush();
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: 'db-1', instanceId, op: 'exec', sql: 'SELECT 1' });
    await flush();
    expect(dbHandle).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });

  it('a response whose instance was superseded meanwhile (re-announce) is dropped — the runner posts nothing for it', async () => {
    const { handler, handle, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    await ctx.connect(); // re-announce supersedes the instance the request was bound to
    release();
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(0);
  });

  it('twin: the same gated response with no re-announce in between is posted', async () => {
    const { handler, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    release();
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(1);
  });

  it('a response pending when the host is destroyed is never posted', async () => {
    const { handler, release } = gatedHandler();
    const ctx = await mountWithAccess(handler);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    ctx.host.destroy();
    release();
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(0);
  });
});

describe('the frame size class — access rides LIMITS.MAX_FRAME_BYTES both ways', () => {
  it('an over-cap handler result becomes a SMALL terminal ACCESS_SIZE_EXCEEDED access-response — never silence', async () => {
    // The engine truncates in band at ACCESS_MAX_RESULT_BYTES; this is the runner's belt for
    // a handler whose cap was lowered ABOVE the class (the AC's stated method).
    const oversized = 'x'.repeat(LIMITS.MAX_FRAME_BYTES + 1);
    const ctx = await mountWithAccess({ handle: async () => ({ ok: true, op: 'query', columns: ['note'], rows: [[oversized]] }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    const frames = accessResponses(ctx, 'acc-1');
    expect(frames).toHaveLength(1); // NEVER silence
    const frame = frames[0]!;
    expect(frame).toEqual({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'acc-1',
      ok: false,
      error: { code: ACCESS_ERROR_CODES.ACCESS_SIZE_EXCEEDED, message: 'access result exceeds the frame size limit', retryable: false },
    });
    expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeLessThan(1024); // SMALL
    expect(accessResponseSchema.safeParse(frame).success).toBe(true);
  });

  it('an over-cap LIST answer is the same terminal ACCESS_SIZE_EXCEEDED (the belt is per capability, not per op)', async () => {
    const many: AccessGrantView[] = Array.from({ length: 2000 }, (_, i) => ({
      ...grantView,
      id: `grant-${i}`,
      source: { displayName: 'L'.repeat(60) },
      tables: [{ name: 'transactions', columns: Array.from({ length: 20 }, (_, c) => `column_${c}_${'c'.repeat(20)}`) }],
    }));
    const ctx = await mountWithAccess({ handle: async () => ({ ok: true, op: 'list', grants: many }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, OP_BODIES.list));
    await flush();
    expect(accessResponses(ctx, 'acc-1')).toEqual([
      expect.objectContaining({ ok: false, error: expect.objectContaining({ code: ACCESS_ERROR_CODES.ACCESS_SIZE_EXCEEDED }) }),
    ]);
  });

  it('twin: an engine-cap-sized result (ACCESS_MAX_RESULT_BYTES of cells) crosses whole', async () => {
    const cell = 'y'.repeat(ACCESS_MAX_RESULT_BYTES);
    const ctx = await mountWithAccess({ handle: async () => ({ ok: true, op: 'query', columns: ['note'], rows: [[cell]] }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId));
    await flush();
    const frame = accessResponses(ctx, 'acc-1').at(-1) as { ok: boolean; rows?: unknown[][] };
    expect(frame.ok).toBe(true);
    expect((frame.rows![0]![0] as string).length).toBe(ACCESS_MAX_RESULT_BYTES);
  });

  it('an oversized access-REQUEST (schema-valid, over MAX_FRAME_BYTES) is refused HOST_ERROR; the handler is never called', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    // 64 params × 4096 chars is schema-valid and > 256 KiB once framed.
    const params = Array.from({ length: 64 }, () => 'p'.repeat(4096));
    const frame = accessRequest('acc-big', instanceId, { ...OP_BODIES.query, params });
    expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength).toBeGreaterThan(LIMITS.MAX_FRAME_BYTES);
    postFromApp(ctx.iframe, frame);
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(accessResponses(ctx, 'acc-big').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'access-request exceeds the frame size limit', retryable: false },
    });
  });

  it('twin: a request with 32 such params (under the class) is routed', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    const params = Array.from({ length: 32 }, () => 'p'.repeat(4096));
    postFromApp(ctx.iframe, accessRequest('acc-ok', instanceId, { ...OP_BODIES.query, params }));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(accessResponses(ctx, 'acc-ok').at(-1)).toMatchObject({ ok: true });
  });

  it('the ACCESS_SIZE_EXCEEDED terminal itself fits the class (an error frame can never exceed limits)', () => {
    const frame = {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'r'.repeat(LIMITS.ID_CHARS),
      ok: false as const,
      error: { code: ACCESS_ERROR_CODES.ACCESS_SIZE_EXCEEDED, message: 'access result exceeds the frame size limit', retryable: false },
    };
    expect(frameWithinLimits(frame)).toBe(true);
  });
});

describe('malformed and unparseable access-requests are ANSWERED (answerUnparseable arm) — never hung', () => {
  it('a pre-ready request carrying instanceId: null (MALFORMED, requestId recovered) is answered MALFORMED, not retryable', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.request);
    const ctx = await mountWithAccess({ handle });
    // No announce yet: an SDK that asks before host-ready has no instance to name.
    postFromApp(ctx.iframe, accessRequest('acc-pre', null, OP_BODIES.request));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    const frames = accessResponses(ctx, 'acc-pre');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.accessResponse,
      requestId: 'acc-pre',
      ok: false,
      error: { code: 'MALFORMED', retryable: false },
    });
    expect(accessResponseSchema.safeParse(frames[0]).success).toBe(true);
  });

  it('a strict-schema violation (an unknown key on a query) is answered MALFORMED; the handler is never called', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, accessRequest('acc-1', instanceId, { ...OP_BODIES.query, sourceAppId: 'ledger' }));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({ ok: false, error: { code: 'MALFORMED', retryable: false } });
  });

  it('a request on an unsupported protocol version is answered UNSUPPORTED_VERSION as an access-response', async () => {
    const ctx = await mountWithAccess({ handle: async () => OK_RESULTS.query });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, { ...accessRequest('acc-1', instanceId), v: 99 });
    await flush();
    expect(accessResponses(ctx, 'acc-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.UNSUPPORTED_VERSION, retryable: false },
    });
  });

  it('a host without the capability ALSO answers a malformed access-request (the arm does not depend on the handler)', async () => {
    const ctx = await mount();
    postFromApp(ctx.iframe, accessRequest('acc-pre', null, OP_BODIES.list));
    await flush();
    expect(accessResponses(ctx, 'acc-pre').at(-1)).toMatchObject({ ok: false, error: { code: 'MALFORMED' } });
  });

  it('twin: a malformed access-request WITHOUT a recoverable requestId is dropped — nothing is conjured', async () => {
    const ctx = await mountWithAccess({ handle: async () => OK_RESULTS.query });
    await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessRequest, instanceId: null, op: 'list' });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });

  it('an access-RESPONSE reflected back by the app is dropped — never routed, never answered (no reflected frames)', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: 'acc-1', ok: true, op: 'release' });
    // and a MALFORMED response-typed frame with a requestId: still no reflected answer
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.accessResponse, requestId: 'acc-2', ok: 'yes' });
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(ctx.posted.length).toBe(before);
    expect(allAccessResponses(ctx)).toHaveLength(0);
  });

  it('an access-request from a window other than the app iframe is ignored (routing by event.source only)', async () => {
    const handle = vi.fn<AccessHandler['handle']>(async () => OK_RESULTS.query);
    const ctx = await mountWithAccess({ handle });
    const instanceId = await ctx.connect();
    window.dispatchEvent(new MessageEvent('message', { data: accessRequest('acc-1', instanceId), source: window }));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(accessResponses(ctx, 'acc-1')).toHaveLength(0);
  });
});

describe('db, net and access are ONE ladder (routeCapability) — a structural pin on host.ts', () => {
  const hostSource = readFileSync(join(__dirname, '..', 'host.ts'), 'utf8');

  it('defines routeCapability exactly once and routes db, net and access through it', () => {
    expect(hostSource.match(/function\s+routeCapability\b/g) ?? []).toHaveLength(1);
    for (const seat of ['dbSeat', 'netSeat', 'accessSeat']) {
      expect(hostSource, `${seat} is routed through routeCapability`).toMatch(new RegExp(`routeCapability\\(\\s*${seat}\\b`));
    }
  });

  it('no capability keeps a hand-rolled copy of the ladder: one in-flight flood check for app messages, one for capabilities', () => {
    expect(hostSource.match(/\.size\s*>=\s*MAX_IN_FLIGHT/g) ?? []).toHaveLength(2);
    expect(hostSource).not.toMatch(/function\s+handle(Db|Net|Access)Request\b/);
  });
});
