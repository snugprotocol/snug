// The ONE host-event contract for both SDK forms (TASK-20261010-host-broker PR-6, AC40b; ADR-0034's
// promised `useHostEvents`; D-PR6-2's source guard). Registered twice, like contract-suite.ts:
// contract-module.test.ts runs it against the typed ESM exports, contract-embedded.test.ts against
// embedded/snug-hooks.js evaluated with `new Function`. Section 6 of the embedded block and
// `hostEvents.ts` + `bridge.ts` of the module form are the implementations under test.
//
// The factories (D-PR6-14) return the four hooks of contract-suite.ts PLUS the new names and the
// form's bridge (`SnugBridge` / `bridge`), so a row can read the subscriber map and the access
// pending map. A name a form does not define yet is `undefined` — `need()` turns that into ONE
// clear red row instead of a suite that fails to load.
//
// The NEGATIVE source rows: a frame dispatched with `source` = a sibling frame's window (a jsdom
// <iframe>'s contentWindow — `hostStub().foreign`) changes NOTHING; each has its positive twin from
// `window` (= `window.parent` in jsdom — `hostStub().post`).
import { act } from 'react';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainMessageQueue, flush, hostStub, renderProbe, type HostStub, type Probe } from './app-harness.js';
import type { ContractHookApi, ContractMeta, ContractSendResult } from './contract-suite.js';

export type ContractFormName = 'embedded' | 'module';

/** A subscriber to one named host-event: receives the frame's `data` seat. */
export type ContractHostEventListener = (data: unknown) => void;

/** The bridge seats the rows read — `SnugBridge` (embedded) or `bridge` (module). */
export interface ContractBridge {
  readonly ready: boolean;
  readonly instanceId: string | null;
  readonly theme: string;
  readonly capabilities: object;
  /** requestId → settle (section 7 / `accessRequest`). Absent until the embedded block gains it. */
  readonly accessPending?: ReadonlyMap<string, unknown>;
  /** event → the subscriber set (section 6 / `onHostEvent`). Absent until the embedded block gains it. */
  readonly hostEventListeners?: ReadonlyMap<string, ReadonlySet<unknown>>;
}

/** What `useSnugSchedule`'s handler is given. */
export interface ContractScheduledRun {
  runId: string;
  taskId: string;
  input?: unknown;
}

/** `useSnugAccess()` — the eleven, loosely typed (both forms' results are compared with `toEqual`). */
export interface ContractAccess {
  request(purpose: string, opts?: object): Promise<unknown>;
  query(grantId: string, sql: string, params?: unknown[]): Promise<unknown>;
  write(grantId: string, sql: string, params?: unknown[]): Promise<unknown>;
  refresh(grantId: string): Promise<unknown>;
  list(): Promise<unknown>;
  release(grantId: string): Promise<unknown>;
  discover(hints?: object): Promise<unknown>;
  onChange(listener: (data: { grantId: string }) => void): () => void;
  onSourceChanged(listener: (data: { grantId: string }) => void): () => void;
  onDataChanged(listener: (data: { table?: string }) => void): () => void;
  onRead(listener: (data: { grantId: string }) => void): () => void;
}

/**
 * One form under test (D-PR6-14): the four hooks, the PR-6 names (each `undefined` until the form
 * defines it), the form's bridge, and which form it is (a few rows are one form's only — D-PR6-4).
 */
export interface ContractForm extends ContractHookApi {
  readonly form: ContractFormName;
  readonly bridge: ContractBridge;
  onHostEvent?(event: string, listener: ContractHostEventListener): () => void;
  useHostEvents?(handlers: Readonly<Record<string, unknown>>): void;
  useSnugSchedule?(handler: (run: ContractScheduledRun) => unknown): void;
  proposeSchedule?(proposal: unknown): boolean;
  scheduleInputKey?(runId: string): string;
  useSnugAccess?(): ContractAccess;
}

/** The PR-6 names a factory looks up (the embedded factory tolerates each one missing). */
export const PR6_NAMES = ['onHostEvent', 'useHostEvents', 'useSnugSchedule', 'proposeSchedule', 'scheduleInputKey', 'useSnugAccess'] as const;

type Pr6Name = (typeof PR6_NAMES)[number];

/** The named function of the form under test — or a clear failure naming what the form lacks. */
export function need<K extends Pr6Name>(api: ContractForm, name: K): NonNullable<ContractForm[K]> {
  const value = api[name];
  if (typeof value !== 'function') throw new Error(`the ${api.form} form defines no ${name} yet (PR-6 AC40b)`);
  return value as NonNullable<ContractForm[K]>;
}

/** The form bridge's subscriber map — or a clear failure when the bridge has no such seat. */
export function hostEventListenersOf(api: ContractForm): ReadonlyMap<string, ReadonlySet<unknown>> {
  const map = api.bridge.hostEventListeners;
  if (!(map instanceof Map)) throw new Error(`the ${api.form} form's bridge has no hostEventListeners map yet (D-PR6-2)`);
  return map;
}

/** The form bridge's access pending map — or a clear failure when the bridge has no such seat. */
export function accessPendingOf(api: ContractForm): ReadonlyMap<string, unknown> {
  const map = api.bridge.accessPending;
  if (!(map instanceof Map)) throw new Error(`the ${api.form} form's bridge has no accessPending map yet (D-PR6-2)`);
  return map;
}

/** A host-ready frame exactly as `hostStub().ready()` posts it, for the foreign twin. */
export const readyFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.hostReady,
  instanceId: 'ins-1',
  protocolVersions: [PROTOCOL_VERSION],
  capabilities: { streaming: true, db: true, auth: false },
  theme: 'light',
  ...over,
});

/** A host-event frame: `{ event, data? }` (data absent when not given). */
export const hostEventFrame = (event: string, data?: unknown): Record<string, unknown> => ({
  v: PROTOCOL_VERSION,
  type: FRAME_TYPES.hostEvent,
  event,
  ...(data !== undefined ? { data } : {}),
});

const META: ContractMeta = { appId: 'events-app', displayName: 'Events App' };

export function registerHostEventsContract(formName: string, fresh: () => ContractForm): void {
  describe(`SDK host-events contract — ${formName}`, () => {
    let host: HostStub;
    const probes: Probe<unknown>[] = [];

    const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
      const probe = await renderProbe(body);
      probes.push(probe as Probe<unknown>);
      return probe;
    };

    const hostEvent = (event: string, data?: unknown): void => host.post(hostEventFrame(event, data));
    const foreignEvent = (event: string, data?: unknown): void => host.foreign(hostEventFrame(event, data));

    beforeEach(async () => {
      await drainMessageQueue();
      host = hostStub();
    });

    afterEach(() => {
      while (probes.length > 0) probes.pop()?.unmount();
      host.dispose();
      vi.restoreAllMocks();
    });

    describe('useHostEvents — a component subscribes to several named host-events', () => {
      it('subscribes each named event to its own handler, which receives the frame’s data seat — that event only', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const alpha: unknown[] = [];
        const beta: unknown[] = [];
        await mount(() =>
          useHostEvents({
            alpha: (data: unknown) => alpha.push(data),
            beta: (data: unknown) => beta.push(data),
          }),
        );
        hostEvent('alpha', { n: 1 });
        hostEvent('beta', 'two');
        hostEvent('alpha'); // no data seat → undefined
        hostEvent('gamma', { n: 3 });
        expect(alpha).toEqual([{ n: 1 }, undefined]);
        expect(beta).toEqual(['two']);
        const listeners = hostEventListenersOf(api);
        expect(listeners.get('alpha')?.size).toBe(1);
        expect(listeners.get('beta')?.size).toBe(1);
        expect(listeners.has('gamma')).toBe(false);
      });

      it('the LATEST render’s handler runs — a stale closure never answers', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        let label = 'first';
        const calls: string[] = [];
        const probe = await mount(() => {
          const current = label; // captured at render time
          useHostEvents({ ping: () => calls.push(current) });
        });
        label = 'second';
        await probe.rerender();
        hostEvent('ping');
        expect(calls).toEqual(['second']);
      });

      it('unmount unsubscribes every key: no handler runs and the bridge keeps no empty subscriber set', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const seen: string[] = [];
        const probe = await mount(() => useHostEvents({ alpha: () => seen.push('alpha'), beta: () => seen.push('beta') }));
        hostEvent('alpha');
        expect(seen).toEqual(['alpha']);
        probe.unmount();
        probes.pop();
        hostEvent('alpha');
        hostEvent('beta');
        expect(seen).toEqual(['alpha']);
        const listeners = hostEventListenersOf(api);
        expect(listeners.has('alpha')).toBe(false);
        expect(listeners.has('beta')).toBe(false);
      });

      it('a re-render with the SAME keys does not re-subscribe; a CHANGED key set does', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const seen: string[] = [];
        let handlers: Record<string, unknown> = { alpha: () => seen.push('alpha-1'), beta: () => seen.push('beta-1') };
        const probe = await mount(() => useHostEvents(handlers));
        const listeners = hostEventListenersOf(api);
        const alphaSet = listeners.get('alpha');
        const alphaMember = [...(alphaSet ?? [])][0];
        expect(alphaSet?.size).toBe(1);

        handlers = { alpha: () => seen.push('alpha-2'), beta: () => seen.push('beta-2') }; // a new object, the same keys
        await probe.rerender();
        expect(listeners.get('alpha')).toBe(alphaSet); // the same subscriber set …
        expect([...(listeners.get('alpha') ?? [])][0]).toBe(alphaMember); // … holding the same subscriber
        expect(listeners.get('alpha')?.size).toBe(1);
        hostEvent('alpha');
        expect(seen).toEqual(['alpha-2']); // the latest handler, through the subscription that stayed

        handlers = { alpha: () => seen.push('alpha-3'), gamma: () => seen.push('gamma-3') }; // beta out, gamma in
        await probe.rerender();
        expect(listeners.has('beta')).toBe(false);
        expect(listeners.get('gamma')?.size).toBe(1);
        expect(listeners.get('alpha')?.size).toBe(1); // never two subscriptions for one key
        hostEvent('beta');
        hostEvent('gamma');
        hostEvent('alpha');
        expect(seen).toEqual(['alpha-2', 'gamma-3', 'alpha-3']);
      });

      it('a non-function value is ignored — at mount and when a handler later becomes one — and never breaks the other keys', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const seen: unknown[] = [];
        let alpha: unknown = 'not a function';
        const probe = await mount(() => useHostEvents({ alpha, beta: null, gamma: (data: unknown) => seen.push(data) }));
        hostEvent('alpha', 1);
        hostEvent('beta', 2);
        hostEvent('gamma', 3);
        expect(seen).toEqual([3]);

        alpha = (data: unknown) => seen.push(['alpha', data]);
        await probe.rerender();
        hostEvent('alpha', 4);
        alpha = undefined;
        await probe.rerender();
        hostEvent('alpha', 5);
        hostEvent('gamma', 6);
        expect(seen).toEqual([3, ['alpha', 4], 6]);
      });

      it('the bridge still flips theme with a subscriber mounted, and a theme-change subscriber observes — after the flip', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const observed: unknown[] = [];
        const themeAtCall: string[] = [];
        const probe = await mount(() => {
          useHostEvents({
            'theme-change': (data: unknown) => {
              observed.push(data);
              themeAtCall.push(api.bridge.theme);
            },
          });
          return api.useSnugApp(META);
        });
        await flush();
        host.ready();
        await flush();
        expect(probe.result.current.theme).toBe('light');
        hostEvent('theme-change', { theme: 'dark' });
        await flush();
        expect(probe.result.current.theme).toBe('dark');
        expect(observed).toEqual([{ theme: 'dark' }]);
        expect(themeAtCall).toEqual(['dark']); // the bridge's own theme code runs FIRST
      });

      it('an unknown event reaches nobody and changes nothing', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const seen: unknown[] = [];
        const probe = await mount(() => {
          useHostEvents({ alpha: (data: unknown) => seen.push(data), 'theme-change': (data: unknown) => seen.push(data) });
          return api.useSnugApp(META);
        });
        await flush();
        host.ready();
        await flush();
        hostEvent('nobody-listens', { theme: 'dark' });
        await flush();
        expect(seen).toEqual([]);
        expect(probe.result.current.theme).toBe('light');
        expect(hostEventListenersOf(api).has('nobody-listens')).toBe(false);
      });
    });

    describe('onHostEvent — the primitive', () => {
      it('delivers the data seat to that event’s subscribers; the returned unsubscribe stops one, and the last one deletes the empty set', () => {
        const api = fresh();
        const onHostEvent = need(api, 'onHostEvent');
        const a: unknown[] = [];
        const b: unknown[] = [];
        const offA = onHostEvent('visibility', (data) => a.push(data));
        const offB = onHostEvent('visibility', (data) => b.push(data));
        const listeners = hostEventListenersOf(api);
        expect(listeners.get('visibility')?.size).toBe(2);
        hostEvent('visibility', { hidden: true });
        hostEvent('visibility');
        expect(a).toEqual([{ hidden: true }, undefined]);
        expect(b).toEqual([{ hidden: true }, undefined]);
        offA();
        expect(listeners.get('visibility')?.size).toBe(1);
        hostEvent('visibility', 2);
        expect(a).toHaveLength(2);
        expect(b).toEqual([{ hidden: true }, undefined, 2]);
        offB();
        expect(listeners.has('visibility')).toBe(false);
        hostEvent('visibility', 3);
        expect(b).toHaveLength(3);
      });

      it('a subscriber that unsubscribes mid-dispatch does not break delivery to the others', () => {
        const api = fresh();
        const onHostEvent = need(api, 'onHostEvent');
        const seen: string[] = [];
        const offA = onHostEvent('ping', () => {
          seen.push('a');
          offA();
        });
        onHostEvent('ping', () => seen.push('b'));
        hostEvent('ping');
        hostEvent('ping');
        expect(seen).toEqual(['a', 'b', 'b']);
      });

      it('a subscription needs no host-ready: it delivers before the handshake', () => {
        const api = fresh();
        const onHostEvent = need(api, 'onHostEvent');
        const seen: unknown[] = [];
        expect(api.bridge.ready).toBe(false);
        const off = onHostEvent('early', (data) => seen.push(data));
        hostEvent('early', 1);
        off();
        expect(seen).toEqual([1]);
      });
    });

    // D-PR6-2 (security S1, the blocker): the bridge accepts a frame ONLY from window.parent. A
    // sibling frame in the same document (`parent.frames[i].postMessage`) changes nothing.
    describe('the source guard — a frame from a SIBLING frame changes nothing (D-PR6-2)', () => {
      it('a host-ready from a sibling is ignored: isReady stays false and calls stay guarded — the twin from window.parent connects', async () => {
        const api = fresh();
        const probe = await mount(() => api.useSnugApp(META));
        await flush();
        host.foreign(readyFrame({ instanceId: 'ins-sibling', theme: 'dark' }));
        await flush();
        expect(probe.result.current.isReady).toBe(false);
        expect(api.bridge.ready).toBe(false);
        expect(api.bridge.instanceId).toBeNull();
        expect(probe.result.current.theme).toBe('light');
        const guarded = await probe.result.current.sendMessage('go', {});
        expect(guarded.ok).toBe(false);
        expect(guarded.error?.message).toContain('not connected');
        await flush();
        expect(host.frames(FRAME_TYPES.appMessage)).toHaveLength(0);

        host.ready(); // the positive twin
        await flush();
        expect(probe.result.current.isReady).toBe(true);
        expect(api.bridge.instanceId).toBe('ins-1');
      });

      it('a sibling’s host-ready after the real one rewrites no instanceId, theme or capabilities', async () => {
        const api = fresh();
        const probe = await mount(() => api.useSnugApp(META));
        await flush();
        host.ready({ capabilities: { streaming: true, db: true, auth: false, access: false } });
        await flush();
        host.foreign(readyFrame({ instanceId: 'ins-sibling', theme: 'dark', capabilities: { streaming: true, db: true, auth: false, access: true } }));
        await flush();
        expect(api.bridge.instanceId).toBe('ins-1');
        expect(api.bridge.theme).toBe('light');
        expect((api.bridge.capabilities as { access?: unknown }).access).toBe(false);
        expect(probe.result.current.theme).toBe('light');
        let sent: Promise<ContractSendResult> | undefined;
        await act(async () => {
          sent = probe.result.current.sendMessage('go', {});
        });
        await flush();
        expect(host.frames(FRAME_TYPES.appMessage)[0]).toMatchObject({ instanceId: 'ins-1' });
        void sent;
      });

      it('a sibling’s theme-change is ignored — the twin from window.parent flips the theme', async () => {
        const api = fresh();
        const probe = await mount(() => api.useSnugApp(META));
        await flush();
        host.ready();
        await flush();
        foreignEvent('theme-change', { theme: 'dark' });
        await flush();
        expect(probe.result.current.theme).toBe('light');
        expect(api.bridge.theme).toBe('light');
        hostEvent('theme-change', { theme: 'dark' }); // the positive twin
        await flush();
        expect(probe.result.current.theme).toBe('dark');
      });

      it('a sibling’s host-event reaches no subscriber (useHostEvents nor onHostEvent) — the twin from window.parent does', async () => {
        const api = fresh();
        const useHostEvents = need(api, 'useHostEvents');
        const onHostEvent = need(api, 'onHostEvent');
        const viaHook: unknown[] = [];
        const viaPrimitive: unknown[] = [];
        await mount(() => useHostEvents({ 'connection-event': (data: unknown) => viaHook.push(data) }));
        const off = onHostEvent('connection-event', (data) => viaPrimitive.push(data));
        const payload = { slot: 'gmail', verified: true, requestRefresh: true };
        foreignEvent('connection-event', payload);
        await flush();
        expect(viaHook).toEqual([]);
        expect(viaPrimitive).toEqual([]);
        hostEvent('connection-event', payload); // the positive twin
        expect(viaHook).toEqual([payload]);
        expect(viaPrimitive).toEqual([payload]);
        off();
      });

      it('a sibling’s app-response or db-response carrying a LIVE requestId settles nothing — the real answer settles once', async () => {
        const api = fresh();
        const probe = await mount(() => ({ app: api.useSnugApp(META), db: api.useAppDB() }));
        await flush();
        host.ready();
        await flush();
        let message: Promise<ContractSendResult> | undefined;
        let messageSettled = false;
        await act(async () => {
          message = probe.result.current.app.sendMessage('go', {});
        });
        void message?.then(() => {
          messageSettled = true;
        });
        let dbSettled = false;
        const exec = probe.result.current.db.exec('SELECT 1', []);
        void exec.then(
          () => (dbSettled = true),
          () => (dbSettled = true),
        );
        await flush();
        const messageId = host.frames(FRAME_TYPES.appMessage)[0]!.requestId!;
        const dbId = host.dbRequests('exec')[0]!.requestId!;

        host.foreign({ v: PROTOCOL_VERSION, type: FRAME_TYPES.appResponse, requestId: messageId, ok: true, streaming: false, data: { forged: true } });
        host.foreign({ v: PROTOCOL_VERSION, type: FRAME_TYPES.dbResponse, requestId: dbId, ok: true, rows: [['forged']], columns: ['x'] });
        await flush();
        expect(messageSettled).toBe(false);
        expect(dbSettled).toBe(false);
        expect(probe.result.current.app.isWaiting).toBe(true);

        host.succeed(messageId, { message: 'real' }); // the positive twins
        host.dbSucceed(dbId, { rows: [[1]], columns: ['1'] });
        await flush();
        await expect(message).resolves.toEqual({ ok: true, data: { message: 'real' } });
        await expect(exec).resolves.toEqual({ rows: [[1]], columns: ['1'] });
      });
    });
  });
}
