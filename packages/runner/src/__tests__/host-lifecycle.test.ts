// Identity & lifecycle ACs (F2, F4, F5, F7, F12): announce/ready handshake, per-load
// instanceId, source identity, supersede on re-announce/reload, navigation cutoff,
// destroy/reset, host-event/app-event, onFrame observation, wire answers for
// unparseable-but-recoverable frames.
import { ERROR_CODES, FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  announceFrame,
  flush,
  fakeTransport,
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
  while (contexts.length > 0) contexts.pop()!.destroy();
  vi.restoreAllMocks();
});

describe('announce → host-ready handshake', () => {
  it('acks announce with host-ready carrying instanceId, protocolVersions [1], theme, and capabilities', async () => {
    const onAnnounce = vi.fn();
    const ctx = await mount({ options: { onAnnounce, theme: 'dark' } });
    const instanceId = await ctx.connect();
    expect(onAnnounce).toHaveBeenCalledWith(expect.objectContaining({ appId: 'chess', displayName: 'Chess' }));
    const ready = ctx.readies().at(-1)!;
    expect(ready).toMatchObject({
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.hostReady,
      instanceId,
      protocolVersions: [PROTOCOL_VERSION],
      theme: 'dark',
      capabilities: { streaming: true, db: false, auth: false },
    });
  });

  it('advertises db capability if and only if a driver is configured; auth is always false; net iff a handler is configured', async () => {
    const withDb = await mount({
      options: { db: { handle: async () => ({ ok: true as const }) }, dbNamespace: 'ns' },
    });
    await withDb.connect();
    expect(withDb.readies().at(-1)!.capabilities).toEqual({ streaming: true, db: true, auth: false, net: false });

    const withoutDb = await mount();
    await withoutDb.connect();
    expect(withoutDb.readies().at(-1)!.capabilities).toEqual({ streaming: true, db: false, auth: false, net: false });

    const withNet = await mount({
      options: { net: { handle: async () => ({ ok: true as const, status: 200, headers: {}, body: '' }) }, netAppId: 'app' },
    });
    await withNet.connect();
    expect(withNet.readies().at(-1)!.capabilities).toEqual({ streaming: true, db: false, auth: false, net: true });
  });

  it('ready-ack is idempotent: a duplicate announce in the same load supersedes and re-acks', async () => {
    const ctx = await mount();
    const first = await ctx.connect();
    const second = await ctx.connect();
    expect(ctx.readies().length).toBeGreaterThanOrEqual(2);
    expect(second).not.toBe(first); // re-announce mints a fresh instance (R4)
  });
});

describe('listener-before-srcDoc contract', () => {
  it('createRunnerHost never assigns srcDoc itself and handles frames before any srcDoc exists', async () => {
    const ctx = await mount({ load: false });
    expect(ctx.iframe.hasAttribute('srcdoc')).toBe(false);
    const instanceId = await ctx.connect(); // listener already attached at create
    expect(instanceId).toBeTruthy();
  });
});

describe('source identity (R4)', () => {
  it('ignores snug frames whose source is not the app iframe contentWindow', async () => {
    const ctx = await mount();
    const event = new MessageEvent('message', { data: announceFrame(), source: window });
    window.dispatchEvent(event);
    const nullSource = new MessageEvent('message', { data: announceFrame() });
    window.dispatchEvent(nullSource);
    await flush();
    expect(ctx.readies()).toHaveLength(1); // only the proactive on-load ready; no announce acks
    expect(ctx.observed.filter((o) => o.direction === 'inbound')).toHaveLength(0);
  });
});

describe('per-load instanceId & supersede (F4)', () => {
  it('re-announce aborts in-flight work with SUPERSEDED and mints a new instanceId', async () => {
    let seenSignal: AbortSignal | undefined;
    const ctx = await mount({
      transportHandler: ({ options }) => {
        seenSignal = options.signal;
        return new Promise(() => {}); // never settles
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const next = await ctx.connect();
    expect(next).not.toBe(instanceId);
    expect(seenSignal?.aborted).toBe(true);
    const terminal = responsesFor(ctx, 'req-1').at(-1);
    expect(terminal).toMatchObject({ ok: false, error: { code: ERROR_CODES.SUPERSEDED, retryable: false } });
  });

  it('a document reload supersedes in-flight work and issues a fresh ready with a new instanceId', async () => {
    let seenSignal: AbortSignal | undefined;
    const ctx = await mount({
      transportHandler: ({ options }) => {
        seenSignal = options.signal;
        return new Promise(() => {});
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    // Expected reload: srcdoc reassignment (counted) then the load event.
    ctx.iframe.srcdoc = '<p>app v2</p>';
    await flush(); // let the srcdoc mutation record deliver
    ctx.fireLoad();
    await flush();
    expect(seenSignal?.aborted).toBe(true);
    const readyAfter = ctx.readies().at(-1)!;
    expect(readyAfter.instanceId).not.toBe(instanceId);
  });

  it('drops frames carrying a stale instanceId silently', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-stale', `${instanceId}-old`));
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(responsesFor(ctx, 'req-stale')).toHaveLength(0);
  });
});

describe('navigation cutoff (F2, C2)', () => {
  it('an unexpected load permanently cuts off posting and fires onNavigatedAway', async () => {
    const onNavigatedAway = vi.fn();
    let seenSignal: AbortSignal | undefined;
    const ctx = await mount({
      transportHandler: ({ options }) => {
        seenSignal = options.signal;
        return new Promise(() => {});
      },
      options: { onNavigatedAway },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const postedBefore = ctx.posted.length;

    ctx.fireLoad(); // no srcdoc assignment preceded it → navigation escape
    await flush();
    expect(onNavigatedAway).toHaveBeenCalledTimes(1);
    expect(seenSignal?.aborted).toBe(true);
    expect(ctx.posted.length).toBe(postedBefore); // not even a SUPERSEDED frame crosses the cutoff

    postFromApp(ctx.iframe, announceFrame());
    await flush();
    expect(ctx.posted.length).toBe(postedBefore); // permanently silent
  });

  it('loads on an iframe that never had srcdoc are not navigation escapes', async () => {
    const onNavigatedAway = vi.fn();
    const ctx = await mount({ load: false, options: { onNavigatedAway } });
    ctx.fireLoad(); // the initial about:blank load — no app document exists yet
    await flush();
    expect(onNavigatedAway).not.toHaveBeenCalled();
  });
});

describe('unparseable frames — wire answers only when requestId is recoverable', () => {
  it('answers a version-mismatched app-message with UNSUPPORTED_VERSION on the wire', async () => {
    const ctx = await mount();
    await ctx.connect();
    postFromApp(ctx.iframe, { v: 2, type: FRAME_TYPES.appMessage, requestId: 'req-v2' });
    await flush();
    expect(responsesFor(ctx, 'req-v2').at(-1)).toMatchObject({
      ok: false,
      error: { code: ERROR_CODES.UNSUPPORTED_VERSION, retryable: false },
    });
  });

  it('answers a malformed db-request as a db-response error', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, {
      v: PROTOCOL_VERSION,
      type: FRAME_TYPES.dbRequest,
      requestId: 'req-db-bad',
      instanceId,
      op: 'no-such-op',
    });
    await flush();
    const answer = ctx.posted.find(
      (f) => (f as { type?: string }).type === FRAME_TYPES.dbResponse && (f as { requestId?: string }).requestId === 'req-db-bad',
    );
    expect(answer).toMatchObject({ ok: false, error: { code: 'MALFORMED', retryable: false } });
  });

  it('drops version mismatches with no recoverable requestId', async () => {
    const ctx = await mount();
    await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: 99, type: FRAME_TYPES.announce, appId: 'x', displayName: 'X' });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });

  it('drops unknown snug:* types silently even when they carry a requestId (R2)', async () => {
    const ctx = await mount();
    await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: 'snug:future-thing', requestId: 'req-f' });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });

  it('never reflects wire answers for host-frame types, even with a recoverable requestId (Gate-5 F3)', async () => {
    const ctx = await mount();
    await ctx.connect();
    const before = ctx.posted.length;
    // A hostile app echoing host-frame types must not conjure app-response error frames.
    postFromApp(ctx.iframe, { v: 2, type: FRAME_TYPES.appResponse, requestId: 'req-reflect' });
    postFromApp(ctx.iframe, { v: 2, type: FRAME_TYPES.dbResponse, requestId: 'req-reflect-db' });
    postFromApp(ctx.iframe, { v: 2, type: FRAME_TYPES.hostReady, requestId: 'req-reflect-hr' });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });

  it('drops an unanswerable app-origin type (app-cancel) even when malformed with a requestId (Gate-5 F3)', async () => {
    const ctx = await mount();
    const instanceId = await ctx.connect();
    const before = ctx.posted.length;
    postFromApp(ctx.iframe, { v: 2, type: FRAME_TYPES.appCancel, requestId: 'req-c', instanceId });
    await flush();
    expect(ctx.posted.length).toBe(before);
  });
});

describe('host-event / app-event / observation (F12)', () => {
  it('setTheme posts a theme-change host-event and updates later ready frames', async () => {
    const ctx = await mount();
    await ctx.connect();
    ctx.host.setTheme('dark');
    const themeEvent = ctx.posted.at(-1);
    expect(themeEvent).toMatchObject({
      type: FRAME_TYPES.hostEvent,
      event: 'theme-change',
      data: { theme: 'dark' },
    });
    await ctx.connect(); // re-announce → fresh ready must carry the new theme
    expect(ctx.readies().at(-1)!.theme).toBe('dark');
  });

  it('notifyEvent posts an arbitrary host-event', async () => {
    const ctx = await mount();
    await ctx.connect();
    ctx.host.notifyEvent('visibility', { visible: false });
    expect(ctx.posted.at(-1)).toMatchObject({
      type: FRAME_TYPES.hostEvent,
      event: 'visibility',
      data: { visible: false },
    });
  });

  it('forwards app-event frames to onAppEvent', async () => {
    const onAppEvent = vi.fn();
    const ctx = await mount({ options: { onAppEvent } });
    await ctx.connect();
    postFromApp(ctx.iframe, { v: PROTOCOL_VERSION, type: FRAME_TYPES.appEvent, event: 'resize', data: { height: 480 } });
    await flush();
    expect(onAppEvent).toHaveBeenCalledWith('resize', { height: 480 });
  });

  it('onFrame observes every accepted inbound and every posted outbound frame in order', async () => {
    const ctx = await mount();
    await ctx.connect();
    const types = ctx.observed.map((o) => `${o.direction}:${o.type}`);
    expect(types).toContain(`inbound:${FRAME_TYPES.announce}`);
    expect(types).toContain(`outbound:${FRAME_TYPES.hostReady}`);
    expect(types.indexOf(`inbound:${FRAME_TYPES.announce}`)).toBeLessThan(
      types.lastIndexOf(`outbound:${FRAME_TYPES.hostReady}`),
    );
  });
});

describe('destroy & reset', () => {
  it('destroy removes the listener, aborts in-flight work, and never posts again', async () => {
    let seenSignal: AbortSignal | undefined;
    const ctx = await mount({
      transportHandler: ({ options }) => {
        seenSignal = options.signal;
        return new Promise(() => {});
      },
    });
    const instanceId = await ctx.connect();
    postFromApp(ctx.iframe, messageFrame('req-1', instanceId));
    await flush();
    const before = ctx.posted.length;
    ctx.host.destroy();
    expect(seenSignal?.aborted).toBe(true);
    postFromApp(ctx.iframe, announceFrame());
    await flush();
    expect(ctx.posted.length).toBe(before);
    expect(() => ctx.host.destroy()).not.toThrow(); // idempotent
  });

  it('reset() clears the parse budget; reset(false) preserves it', async () => {
    const ctx = await mount();
    ctx.budget.set('test-budget', 2);
    ctx.host.reset(false);
    expect(ctx.budget.get('test-budget')).toBe(2);
    ctx.host.reset();
    expect(ctx.budget.get('test-budget')).toBe(0);
  });

  it('reset reloads srcDoc and that reload counts as expected (no cutoff)', async () => {
    const onNavigatedAway = vi.fn();
    const ctx = await mount({ options: { onNavigatedAway } });
    await ctx.connect();
    ctx.host.reset();
    await flush(); // deliver the srcdoc mutation record
    ctx.fireLoad(); // the reload triggered by reset's reassignment
    await flush();
    expect(onNavigatedAway).not.toHaveBeenCalled();
    const instanceId = await ctx.connect(); // app re-announces after reload
    expect(instanceId).toBeTruthy();
  });
});
