// db bridge ACs (F5, F10): host-assigned namespace routing (never app-claimed appId),
// top-level response fields per dbResponseSchema, the 8 MiB db size class, the
// no-driver error path, and stale-instance suppression.
import { ERROR_CODES, FRAME_TYPES, LIMITS, PROTOCOL_VERSION, dbResponseSchema } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbDriver, DbDriverResult } from '../transport.js';
import { announceFrame, flush, mountHost, postFromApp, type HostContext } from './harness.js';

const contexts: HostContext[] = [];
async function mountWithDb(driver: DbDriver, namespace = 'host-assigned-ns'): Promise<HostContext> {
  const ctx = await mountHost({ options: { db: driver, dbNamespace: namespace } });
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

const dbRequest = (requestId: string, instanceId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.dbRequest,
  requestId,
  instanceId,
  op: 'exec',
  sql: 'select 1',
  ...over,
});

function dbResponses(ctx: HostContext, requestId: string): unknown[] {
  return ctx.posted.filter(
    (f) => (f as { type?: string }).type === FRAME_TYPES.dbResponse && (f as { requestId?: string }).requestId === requestId,
  );
}

describe('db-request routing', () => {
  it('routes to the driver with the HOST-assigned namespace — never the app-claimed appId (F5)', async () => {
    const handle = vi.fn<DbDriver['handle']>(async () => ({ ok: true, rows: [[1]], columns: ['n'] }));
    const ctx = await mountWithDb({ handle }, 'host-assigned-ns');
    // Hostile app announces whatever identity it likes; storage identity must not follow it.
    postFromApp(ctx.iframe, announceFrame({ appId: 'evil-impersonator' }));
    await flush();
    const instanceId = ctx.readies().at(-1)!.instanceId;
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle.mock.calls[0]![0]).toBe('host-assigned-ns');
    expect(handle.mock.calls[0]![1]).toMatchObject({ op: 'exec', sql: 'select 1' });
  });

  it('answers with result fields at the TOP LEVEL of the db-response frame (template contract)', async () => {
    const ctx = await mountWithDb({
      handle: async (_ns, req) =>
        req.op === 'kvGet' ? { ok: true, value: { score: 42 } } : { ok: true, rows: [[1]], columns: ['n'] },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId, { op: 'kvGet', key: 'state', sql: undefined }));
    await flush();
    const frame = dbResponses(ctx, 'db-1').at(-1)!;
    expect(frame).toMatchObject({ v: 1, type: FRAME_TYPES.dbResponse, requestId: 'db-1', ok: true, value: { score: 42 } });
    expect(dbResponseSchema.safeParse(frame).success).toBe(true);
  });

  it('maps a driver error onto a db-response error frame', async () => {
    const ctx = await mountWithDb({
      handle: async () => ({ ok: false, code: 'HOST_ERROR', message: 'disk full', retryable: false }) satisfies DbDriverResult as DbDriverResult,
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, message: 'disk full', retryable: false },
    });
  });

  it('a THROWING driver becomes a retryable HOST_ERROR db-response, never an unhandled rejection', async () => {
    const ctx = await mountWithDb({
      handle: async () => {
        throw new Error('driver bug');
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: true },
    });
  });

  it('answers HOST_ERROR when no driver is configured (capability honesty)', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: false },
    });
  });

  it('drops db-requests with a stale instanceId without calling the driver', async () => {
    const handle = vi.fn<DbDriver['handle']>(async () => ({ ok: true }));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', `${instanceId}-stale`));
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(dbResponses(ctx, 'db-1')).toHaveLength(0);
  });

  it('suppresses a driver result that resolves after the instance was superseded', async () => {
    let resolveDriver: ((r: DbDriverResult) => void) | undefined;
    const ctx = await mountWithDb({
      handle: () => new Promise<DbDriverResult>((resolve) => (resolveDriver = resolve)),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    await ctx.connect(); // re-announce supersedes the instance
    resolveDriver?.({ ok: true, rows: [[1]] });
    await flush();
    expect(dbResponses(ctx, 'db-1')).toHaveLength(0);
  });
});

describe('db duplicate & flood guards (Gate-5 F2)', () => {
  it('a duplicate in-flight db requestId gets a non-retryable error and reaches the driver only once', async () => {
    const handle = vi.fn<DbDriver['handle']>(() => new Promise(() => {}));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-dup', instanceId));
    postFromApp(ctx.iframe, dbRequest('db-dup', instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    const frames = dbResponses(ctx, 'db-dup');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ ok: false, error: { code: ERROR_CODES.HOST_ERROR, retryable: false } });
  });

  it('the 9th concurrent db request is rejected with a retryable error (MAX_IN_FLIGHT cap)', async () => {
    const handle = vi.fn<DbDriver['handle']>(() => new Promise(() => {}));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    for (let i = 1; i <= 9; i++) postFromApp(ctx.iframe, dbRequest(`db-${i}`, instanceId));
    await flush();
    expect(handle).toHaveBeenCalledTimes(8);
    expect(dbResponses(ctx, 'db-9').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: true },
    });
  });

  it('a settled db requestId frees its in-flight slot', async () => {
    const handle = vi.fn<DbDriver['handle']>(async () => ({ ok: true, rows: [[1]] }));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId));
    await flush();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId)); // settled — no longer a duplicate
    await flush();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(dbResponses(ctx, 'db-1').filter((f) => (f as { ok: boolean }).ok)).toHaveLength(2);
  });
});

describe('db size class (8 MiB, R6 amendment)', () => {
  const artifactBase64 = 'A'.repeat(Math.ceil((LIMITS.MAX_ARTIFACT_BYTES * 4) / 3));

  it('a db-response carrying a base64 5 MiB artifact export passes the db size class', async () => {
    const ctx = await mountWithDb({ handle: async () => ({ ok: true, bytesBase64: artifactBase64 }) });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId, { op: 'export', sql: undefined }));
    await flush();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({ ok: true, bytesBase64: artifactBase64 });
  });

  it('an inbound import of the same artifact is forwarded (within 8 MiB)', async () => {
    const handle = vi.fn<DbDriver['handle']>(async () => ({ ok: true }));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId, { op: 'import', bytesBase64: artifactBase64, sql: undefined }));
    await flush();
    expect(handle).toHaveBeenCalledTimes(1);
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({ ok: true });
  });

  it('a driver result above 8 MiB becomes a clamped db-response error, never silence', async () => {
    const ctx = await mountWithDb({
      handle: async () => ({ ok: true, bytesBase64: 'B'.repeat(LIMITS.MAX_DB_FRAME_BYTES + 1) }),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, dbRequest('db-1', instanceId, { op: 'export', sql: undefined }));
    await flush();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: false },
    });
  });

  it('an oversized inbound db-request (> 8 MiB) is rejected with a db-response error before the driver', async () => {
    const handle = vi.fn<DbDriver['handle']>(async () => ({ ok: true }));
    const ctx = await mountWithDb({ handle });
    const instanceId = await ctx.connect();
    postFromApp(
      ctx.iframe,
      dbRequest('db-1', instanceId, { op: 'import', bytesBase64: 'C'.repeat(LIMITS.MAX_DB_FRAME_BYTES + 1), sql: undefined }),
    );
    await flush();
    expect(handle).not.toHaveBeenCalled();
    expect(dbResponses(ctx, 'db-1').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.HOST_ERROR, retryable: false },
    });
  });
});
