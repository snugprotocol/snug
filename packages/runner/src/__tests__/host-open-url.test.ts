// TASK-20260818-ledger-starter Phase C (ADR-0038 D5) — the runner's OpenUrlHandler seam.
//
// Mirrors the net seam's discipline where it applies, and departs where the capability
// differs: no id binding (the frame carries only a URL; the handler IS the host's
// confirm surface), ONE pending request per instance (each open is a modal human
// decision — a queue is a dialog-spam primitive), and the no-capability path is a
// NAMED `refused` result rather than the router's silent unknown-frame drop, because
// an app must render its copy-the-link fallback on a fact, not a timeout. The runner
// never opens a window itself — it holds no navigation primitive.
import { FRAME_TYPES, PROTOCOL_VERSION, openUrlResultSchema } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenUrlHandler } from '../transport.js';
import { announceFrame, flush, mountHost, type HostContext } from './harness.js';
import { postFromApp } from './harness.js';

const contexts: HostContext[] = [];
async function mountWithOpenUrl(handler?: OpenUrlHandler): Promise<HostContext> {
  const ctx = await mountHost({ options: handler === undefined ? {} : { openUrl: handler } });
  contexts.push(ctx);
  return ctx;
}
afterEach(() => {
  while (contexts.length > 0) contexts.pop()!.destroy();
  vi.restoreAllMocks();
});

const openUrlRequest = (requestId: string, instanceId: string, url = 'https://example.com/account/cancel') => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.openUrlRequest,
  requestId,
  instanceId,
  url,
});

function results(ctx: HostContext, requestId: string): unknown[] {
  return ctx.posted.filter(
    (f) => (f as { type?: string }).type === FRAME_TYPES.openUrlResult && (f as { requestId?: string }).requestId === requestId,
  );
}

describe('capability truth', () => {
  it('host-ready advertises openUrl true only when a handler is supplied', async () => {
    const withHandler = await mountWithOpenUrl({ open: async () => 'opened' });
    postFromApp(withHandler.iframe, announceFrame());
    await flush();
    expect(withHandler.readies().at(-1)!.capabilities.openUrl).toBe(true);

    const without = await mountWithOpenUrl(undefined);
    postFromApp(without.iframe, announceFrame());
    await flush();
    expect(without.readies().at(-1)!.capabilities.openUrl).toBe(false);
  });

  it('NO capability ⇒ a NAMED refused result — never the silent unknown-frame drop', async () => {
    const ctx = await mountWithOpenUrl(undefined);
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId));
    await flush();
    const frame = results(ctx, 'ou-1').at(-1)!;
    expect(frame).toMatchObject({ status: 'refused' });
    expect((frame as { reason?: string }).reason).toMatch(/capability/i);
    expect(openUrlResultSchema.safeParse(frame).success).toBe(true);
  });
});

describe('routing and outcomes', () => {
  it('routes the URL to the handler and posts opened on confirm', async () => {
    const open = vi.fn<OpenUrlHandler['open']>(async () => 'opened');
    const ctx = await mountWithOpenUrl({ open });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId, 'https://merchant.example/cancel'));
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe('https://merchant.example/cancel');
    expect(results(ctx, 'ou-1').at(-1)).toMatchObject({ status: 'opened' });
  });

  it('posts declined when the user says no — and the app hears it', async () => {
    const ctx = await mountWithOpenUrl({ open: async () => 'declined' });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId));
    await flush();
    expect(results(ctx, 'ou-1').at(-1)).toMatchObject({ status: 'declined' });
  });

  it('a handler throw becomes refused with a clamped reason, never an unhandled rejection', async () => {
    const ctx = await mountWithOpenUrl({
      open: async () => {
        throw new Error('opener exploded');
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId));
    await flush();
    expect(results(ctx, 'ou-1').at(-1)).toMatchObject({ status: 'refused', reason: 'opener exploded' });
  });
});

describe('the schema refusals arrive as MALFORMED silence, not handler calls', () => {
  it('an http URL never reaches the handler', async () => {
    // The schema refuses at parse; there is no answerable mapping for open-url in
    // answerUnparseable, so nothing is posted — and crucially the handler never runs.
    const open = vi.fn<OpenUrlHandler['open']>(async () => 'opened');
    const ctx = await mountWithOpenUrl({ open });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId, 'http://merchant.example/cancel'));
    await flush();
    expect(open).not.toHaveBeenCalled();
  });

  it('a userinfo-bearing URL never reaches the handler', async () => {
    const open = vi.fn<OpenUrlHandler['open']>(async () => 'opened');
    const ctx = await mountWithOpenUrl({ open });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId, 'https://a:b@merchant.example/'));
    await flush();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('single-pending discipline', () => {
  it('a second request while one waits on the user is refused; the first still resolves', async () => {
    let release: (value: 'opened') => void = () => undefined;
    const ctx = await mountWithOpenUrl({
      open: () => new Promise((resolve) => (release = resolve)),
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', instanceId));
    await flush();
    postFromApp(ctx.iframe, openUrlRequest('ou-2', instanceId));
    await flush();
    expect(results(ctx, 'ou-2').at(-1)).toMatchObject({ status: 'refused' });
    expect((results(ctx, 'ou-2').at(-1) as { reason?: string }).reason).toMatch(/already/i);

    release('opened');
    await flush();
    expect(results(ctx, 'ou-1').at(-1)).toMatchObject({ status: 'opened' });
  });

  it('a stale-instance request is dropped silently, exactly like the net seam', async () => {
    const open = vi.fn<OpenUrlHandler['open']>(async () => 'opened');
    const ctx = await mountWithOpenUrl({ open });
    await ctx.connect();
    postFromApp(ctx.iframe, openUrlRequest('ou-1', 'ins-someone-elses'));
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(results(ctx, 'ou-1')).toHaveLength(0);
  });
});
