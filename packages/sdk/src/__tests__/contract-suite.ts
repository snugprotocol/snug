// The ONE behavioral contract for both SDK forms (task AC-2). This suite is registered
// twice: contract-module.test.ts runs it against the typed ESM hooks; contract-embedded.test.ts
// runs it against embedded/snug-hooks.js evaluated via `new Function` in jsdom. Any
// behavioral drift between the forms fails exactly one of the two registrations.
import { act } from 'react';
import { ERROR_CODES, FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { drainMessageQueue, flush, hostStub, renderProbe, type HostStub, type Probe } from './app-harness.js';

export interface ContractMeta {
  appId: string;
  displayName: string;
  description?: string;
  iconEmoji?: string;
  iconColor?: string;
}

export interface ContractSendResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean; [k: string]: unknown };
}

/** The surface both forms must expose. Method syntax on purpose: forms may narrow params. */
export interface ContractHookApi {
  useSnugApp(meta: ContractMeta): {
    isReady: boolean;
    theme: string;
    isWaiting: boolean;
    lastResponse: ContractSendResult | null;
    sendMessage(action: string, payload?: unknown, opts?: Record<string, unknown>): Promise<ContractSendResult>;
  };
  usePersistedState(key: string, initial: unknown): [unknown, (value: unknown) => void];
  useAppDB(): {
    exec(sql: string, params?: unknown[]): Promise<{ rows: unknown[][]; columns: string[] }>;
    exportDb(): Promise<string>;
    importDb(bytesBase64: string): Promise<void>;
  };
  useConnectedFetch(): {
    fetch(url: string, opts?: Record<string, unknown>): Promise<ContractNetResult>;
  };
}

export interface ContractNetResult {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  truncated?: boolean;
  error?: { code: string; message: string; retryable: boolean; [k: string]: unknown };
}

const META: ContractMeta = {
  appId: 'test-app',
  displayName: 'Test App',
  description: 'contract test app',
  iconEmoji: '🎯',
  iconColor: '#6c5ce7',
};

export function registerContractSuite(formName: string, freshHooks: () => ContractHookApi): void {
  describe(`SDK contract — ${formName}`, () => {
    let host: HostStub;
    const probes: Probe<unknown>[] = [];

    const mount = async <T,>(body: () => T): Promise<Probe<T>> => {
      const probe = await renderProbe(body);
      probes.push(probe as Probe<unknown>);
      return probe;
    };

    beforeEach(async () => {
      await drainMessageQueue(); // previous-test postMessage stragglers must not reach this host
      host = hostStub();
    });

    afterEach(() => {
      while (probes.length > 0) probes.pop()?.unmount();
      host.dispose();
    });

    /** Mounts useSnugApp and completes the handshake. */
    const connectedApp = async (hooks: ContractHookApi) => {
      const probe = await mount(() => hooks.useSnugApp(META));
      await flush();
      host.ready();
      await flush();
      return probe;
    };

    it('announces on mount with the app metadata and flips isReady/theme on host-ready', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useSnugApp(META));
      await flush();
      const announces = host.frames(FRAME_TYPES.announce);
      expect(announces).toHaveLength(1);
      expect(announces[0]).toMatchObject({
        v: PROTOCOL_VERSION,
        appId: 'test-app',
        displayName: 'Test App',
        description: 'contract test app',
        iconEmoji: '🎯',
        iconColor: '#6c5ce7',
      });
      expect(probe.result.current.isReady).toBe(false);
      expect(probe.result.current.theme).toBe('light');

      host.ready({ theme: 'dark' });
      await flush();
      expect(probe.result.current.isReady).toBe(true);
      expect(probe.result.current.theme).toBe('dark');
    });

    it('guards sendMessage pre-ready: resolves a retryable HOST_ERROR result and posts nothing', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useSnugApp(META));
      await flush();
      const result = await probe.result.current.sendMessage('go', {});
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(ERROR_CODES.HOST_ERROR);
      expect(result.error?.retryable).toBe(true);
      expect(result.error?.message).toContain('not connected');
      await flush();
      expect(host.frames(FRAME_TYPES.appMessage)).toHaveLength(0);
      expect(probe.result.current.isWaiting).toBe(false);
    });

    it('sendMessage posts a self-contained app-message and resolves on the terminal data frame', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      let promise: Promise<ContractSendResult> | undefined;
      await act(async () => {
        promise = probe.result.current.sendMessage(
          'player_move',
          { from: 'e2', to: 'e4' },
          { state: { turn: 3 }, responseSchema: { kind: 'string' } },
        );
      });
      await flush();
      const message = host.frames(FRAME_TYPES.appMessage)[0];
      expect(message).toMatchObject({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        appId: 'test-app',
        action: 'player_move',
        payload: { from: 'e2', to: 'e4' },
        state: { turn: 3 },
        responseSchema: { kind: 'string' },
      });
      expect(typeof message?.requestId).toBe('string');
      expect(message?.requestId?.length).toBeGreaterThan(0);
      expect(probe.result.current.isWaiting).toBe(true);

      host.succeed(message!.requestId!, { message: 'done', move: 'e5' });
      await flush();
      await expect(promise).resolves.toEqual({ ok: true, data: { message: 'done', move: 'e5' } });
      expect(probe.result.current.isWaiting).toBe(false);
      expect(probe.result.current.lastResponse).toEqual({ ok: true, data: { message: 'done', move: 'e5' } });
    });

    it('streams CUMULATIVE text via onStream without resolving; only the terminal frame resolves', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      const chunks: string[] = [];
      let settled = false;
      let promise: Promise<ContractSendResult> | undefined;
      await act(async () => {
        promise = probe.result.current.sendMessage('think', {}, { onStream: (text: string) => chunks.push(text) });
      });
      await flush();
      const requestId = host.frames(FRAME_TYPES.appMessage)[0]!.requestId!;
      void promise?.then(() => {
        settled = true;
      });

      host.streaming(requestId, 'Thin', 0);
      host.streaming(requestId, 'Thinking…', 1);
      await flush();
      expect(chunks).toEqual(['Thin', 'Thinking…']);
      expect(settled).toBe(false); // streaming frames NEVER resolve
      expect(probe.result.current.isWaiting).toBe(true);

      host.succeed(requestId, { message: 'final' });
      await flush();
      expect(settled).toBe(true);
      await expect(promise).resolves.toEqual({ ok: true, data: { message: 'final' } });
    });

    it('passes terminal error frames through as {ok:false, error}', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      let promise: Promise<ContractSendResult> | undefined;
      await act(async () => {
        promise = probe.result.current.sendMessage('go', {});
      });
      await flush();
      const requestId = host.frames(FRAME_TYPES.appMessage)[0]!.requestId!;
      host.failRequest(requestId, {
        code: ERROR_CODES.PARSE_FAILED,
        message: 'could not parse the reply',
        retryable: true,
      });
      await flush();
      const result = await promise!;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({
        code: ERROR_CODES.PARSE_FAILED,
        message: 'could not parse the reply',
        retryable: true,
      });
      expect(probe.result.current.isWaiting).toBe(false);
      expect(probe.result.current.lastResponse).toEqual(result);
    });

    it('supports multiple in-flight requests: fresh requestIds, out-of-order resolution, isWaiting until the last settles', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      let first: Promise<ContractSendResult> | undefined;
      let second: Promise<ContractSendResult> | undefined;
      await act(async () => {
        first = probe.result.current.sendMessage('one', {});
        second = probe.result.current.sendMessage('two', {});
      });
      await flush();
      const messages = host.frames(FRAME_TYPES.appMessage);
      expect(messages).toHaveLength(2);
      expect(messages[0]!.requestId).not.toBe(messages[1]!.requestId);
      expect(probe.result.current.isWaiting).toBe(true);

      host.succeed(messages[1]!.requestId!, { n: 2 });
      await flush();
      await expect(second).resolves.toEqual({ ok: true, data: { n: 2 } });
      expect(probe.result.current.isWaiting).toBe(true); // the first is still in flight

      host.succeed(messages[0]!.requestId!, { n: 1 });
      await flush();
      await expect(first).resolves.toEqual({ ok: true, data: { n: 1 } });
      expect(probe.result.current.isWaiting).toBe(false);
    });

    it('ignores responses for unknown requestIds', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      host.succeed('never-issued', { message: 'stray' });
      await flush();
      expect(probe.result.current.lastResponse).toBeNull();
      expect(probe.result.current.isWaiting).toBe(false);
    });

    it('updates theme on the theme-change host-event and ignores unknown host events', async () => {
      const hooks = freshHooks();
      const probe = await connectedApp(hooks);
      expect(probe.result.current.theme).toBe('light');

      host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'totally-new-event', data: { theme: 'dark' } });
      await flush();
      expect(probe.result.current.theme).toBe('light'); // unknown events are ignored (additive protocol)

      host.post({ v: PROTOCOL_VERSION, type: FRAME_TYPES.hostEvent, event: 'theme-change', data: { theme: 'dark' } });
      await flush();
      expect(probe.result.current.theme).toBe('dark');
    });

    it('useAppDB.exec resolves {rows, columns} read from TOP-LEVEL db-response fields', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useAppDB());
      host.ready();
      await flush();
      const promise = probe.result.current.exec('SELECT a FROM t WHERE x = ?', [1]);
      await flush();
      const request = host.dbRequests('exec')[0];
      expect(request).toMatchObject({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        op: 'exec',
        sql: 'SELECT a FROM t WHERE x = ?',
        params: [1],
      });
      host.dbSucceed(request!.requestId!, { rows: [[42]], columns: ['a'] });
      await expect(promise).resolves.toEqual({ rows: [[42]], columns: ['a'] });

      const failing = probe.result.current.exec('SELECT nope', []);
      await flush();
      const failedRequest = host.dbRequests('exec')[1];
      host.dbFail(failedRequest!.requestId!, { code: 'DB_SQL_ERROR', message: 'no such table: nope' });
      await expect(failing).rejects.toThrow('no such table: nope');
    });

    it('useConnectedFetch posts a net-request and resolves the terminal net-response (AL-03)', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useConnectedFetch());
      host.ready();
      await flush();
      const promise = probe.result.current.fetch('https://api.example.com/v1/data', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: '{"a":1}',
      });
      await flush();
      const request = host.netRequests()[0];
      expect(request).toMatchObject({
        v: PROTOCOL_VERSION,
        instanceId: 'ins-1',
        type: FRAME_TYPES.netRequest,
        url: 'https://api.example.com/v1/data',
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: '{"a":1}',
      });
      // R5: the app-side hook never stamps an appId onto the frame (host-assigned binding).
      expect(request!.appId).toBeUndefined();
      expect(typeof request!.requestId).toBe('string');

      host.netSucceed(request!.requestId!, { status: 201, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
      await expect(promise).resolves.toEqual({
        ok: true,
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
      });
    });

    it('useConnectedFetch defaults to GET and passes an envelope error through as {ok:false, error}', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useConnectedFetch());
      host.ready();
      await flush();
      const promise = probe.result.current.fetch('https://api.example.com/v1/data');
      await flush();
      const request = host.netRequests()[0];
      expect(request).toMatchObject({ method: 'GET', url: 'https://api.example.com/v1/data' });
      expect(request!.body).toBeUndefined();

      host.netFail(request!.requestId!, { code: 'NET_HOST_BLOCKED', message: 'off ceiling', retryable: false });
      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'NET_HOST_BLOCKED', message: 'off ceiling', retryable: false });
    });

    it('useConnectedFetch resolves a retryable HOST_ERROR before host-ready — nothing posted', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useConnectedFetch());
      await flush();
      const result = await probe.result.current.fetch('https://api.example.com/v1/data');
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe(ERROR_CODES.HOST_ERROR);
      expect(result.error?.retryable).toBe(true);
      await flush();
      expect(host.netRequests()).toHaveLength(0);
    });

    it('useAppDB exportDb/importDb resolve bytesBase64/void; failures throw Error(message)', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.useAppDB());
      host.ready();
      await flush();

      const exported = probe.result.current.exportDb();
      await flush();
      host.dbSucceed(host.dbRequests('export')[0]!.requestId!, { bytesBase64: 'QUJD' });
      await expect(exported).resolves.toBe('QUJD');

      const imported = probe.result.current.importDb('QUJD');
      await flush();
      const importRequest = host.dbRequests('import')[0];
      expect(importRequest).toMatchObject({ op: 'import', bytesBase64: 'QUJD' });
      host.dbSucceed(importRequest!.requestId!);
      await expect(imported).resolves.toBeUndefined();

      const rejected = probe.result.current.importDb('!!!');
      await flush();
      host.dbFail(host.dbRequests('import')[1]!.requestId!, { code: 'DB_BAD_IMPORT', message: 'bad bytes' });
      await expect(rejected).rejects.toThrow('bad bytes');
    });

    it('usePersistedState waits for ready, then hydrates — merging stored objects over defaults', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.usePersistedState('save-slot', { score: 0, level: 1 }));
      await flush();
      expect(host.dbRequests('kvGet')).toHaveLength(0); // no storage traffic before host-ready

      host.ready();
      await flush();
      const get = host.dbRequests('kvGet')[0];
      expect(get).toMatchObject({ op: 'kvGet', key: 'save-slot' });
      host.dbSucceed(get!.requestId!, { value: { score: 7 } });
      await flush();
      expect(probe.result.current[0]).toEqual({ score: 7, level: 1 }); // merged with defaults

      // non-object stored values pass through unmerged
      const plain = await mount(() => hooks.usePersistedState('plain', 0));
      await flush();
      const plainGet = host.dbRequests('kvGet').find((f) => f.key === 'plain');
      host.dbSucceed(plainGet!.requestId!, { value: 5 });
      await flush();
      expect(plain.result.current[0]).toBe(5);
    });

    it('usePersistedState writes back on change only after hydration', async () => {
      const hooks = freshHooks();
      const probe = await mount(() => hooks.usePersistedState('w', { n: 0 }));
      await flush();
      host.ready();
      await flush();
      expect(host.dbRequests('kvSet')).toHaveLength(0); // nothing written before hydration completes

      host.dbSucceed(host.dbRequests('kvGet')[0]!.requestId!, {}); // nothing stored
      await flush();
      expect(probe.result.current[0]).toEqual({ n: 0 });
      const afterHydration = host.dbRequests('kvSet');
      expect(afterHydration).toHaveLength(1); // the post-hydration write-back
      expect(afterHydration[0]).toMatchObject({ key: 'w', value: { n: 0 } });

      await act(async () => {
        probe.result.current[1]({ n: 5 });
      });
      await flush();
      const sets = host.dbRequests('kvSet');
      expect(sets.at(-1)).toMatchObject({ key: 'w', value: { n: 5 } });
    });

    it('usePersistedState key change re-hydrates before writing — the old state never clobbers the new key', async () => {
      const hooks = freshHooks();
      let key = 'slot-a';
      const probe = await mount(() => hooks.usePersistedState(key, { from: 'init' }));
      await flush();
      host.ready();
      await flush();
      const getA = host.dbRequests('kvGet').find((f) => f.key === 'slot-a');
      host.dbSucceed(getA!.requestId!, { value: { from: 'slot-a' } });
      await flush();
      expect(probe.result.current[0]).toEqual({ from: 'slot-a' });

      key = 'slot-b';
      await probe.rerender();
      await flush();
      // REGRESSION (fixed in KB + both SDK forms): the write-back effect must not fire
      // for slot-b while it still holds slot-a's state.
      expect(host.dbRequests('kvSet').filter((f) => f.key === 'slot-b')).toHaveLength(0);

      const getB = host.dbRequests('kvGet').find((f) => f.key === 'slot-b');
      expect(getB).toBeDefined();
      host.dbSucceed(getB!.requestId!, {}); // nothing stored under slot-b
      await flush();
      expect(probe.result.current[0]).toEqual({ from: 'init' }); // reset to defaults, not slot-a leftovers
      const writes = host.dbRequests('kvSet').filter((f) => f.key === 'slot-b');
      expect(writes.map((f) => f.value)).toEqual([{ from: 'init' }]);
    });
  });
}
