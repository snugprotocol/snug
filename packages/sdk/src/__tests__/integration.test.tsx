// Cross-package integration (task plan): runner createRunnerHost + sdk MODULE hooks +
// db createDbDriver in ONE jsdom harness with a scripted mock AgentTransport.
//
// jsdom cannot execute srcdoc documents, so the hooks run in the SAME window as the
// host (the runner test approach): app→host frames are re-dispatched with the iframe's
// contentWindow forged as `source` (the host routes by source identity, R4), and
// host→app frames posted at contentWindow are re-dispatched onto the top window where
// the sdk bridge listens. The load-after-srcdoc simulation follows the quirks documented
// in packages/runner/src/__tests__/harness.ts.
import { createRequire } from 'node:module';
import { act } from 'react';
import { SNUG_APP_REQUEST_TAG } from '@snugprotocol/protocol';
import { createDbDriver, createMemoryBackend, type MemoryBackend, type SnugDbDriver } from '@snugprotocol/db';
import {
  createRunnerHost,
  type AgentTransportOptions,
  type RunnerHost,
  type TransportResult,
} from '@snugprotocol/runner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetSnugBridgeForTests } from '../bridge.js';
import { useAppDB, usePersistedState, useSnugApp } from '../index.js';
import type { AppDb, SendMessageResult, UseSnugAppResult } from '../types.js';
import { flush, renderProbe, type Probe } from './app-harness.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

interface AppApi {
  snug: UseSnugAppResult;
  persisted: [{ count: number }, (value: { count: number }) => void];
  db: AppDb;
}

interface IntegrationCtx {
  iframe: HTMLIFrameElement;
  host: RunnerHost;
  driver: SnugDbDriver;
  backend: MemoryBackend;
  transportCalls: string[];
  announces: string[];
  probe: Probe<AppApi>;
  /** Renders a fresh app instance against the SAME host + driver (simulated reload). */
  remountApp(): Promise<Probe<AppApi>>;
  destroy(): Promise<void>;
}

const contexts: IntegrationCtx[] = [];
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()?.destroy();
  vi.restoreAllMocks();
});

const appBody = (): AppApi => ({
  snug: useSnugApp({ appId: 'itest-app', displayName: 'Integration Test App' }),
  persisted: usePersistedState('save', { count: 0 }) as AppApi['persisted'],
  db: useAppDB(),
});

async function mountIntegration(): Promise<IntegrationCtx> {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  document.body.appendChild(iframe);

  const backend = createMemoryBackend();
  const driver = createDbDriver({ backend, locateWasm, persistDebounceMs: 10 });

  const transportCalls: string[] = [];
  const announces: string[] = [];
  const host = createRunnerHost({
    iframe,
    transport: {
      async send(wire: string, options: AgentTransportOptions): Promise<TransportResult> {
        transportCalls.push(wire);
        options.onDelta?.('Consider');
        options.onDelta?.('ing…');
        return { ok: true, text: JSON.stringify({ message: 'move accepted', san: 'e4' }) };
      },
    },
    budgetKey: 'itest-budget',
    db: driver,
    dbNamespace: 'itest-ns', // HOST-assigned, never the app-claimed appId
    onAnnounce: (frame) => announces.push(frame.appId),
  });

  const target = iframe.contentWindow;
  if (!target) throw new Error('jsdom iframe has no contentWindow');

  // host → app: frames posted at the iframe surface on the top window, async like real postMessage
  vi.spyOn(target, 'postMessage').mockImplementation(((data: unknown) => {
    setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data })), 0);
  }) as never);
  // app → host: forge the iframe as `source` so the host's R4 source check accepts them
  vi.spyOn(window, 'postMessage').mockImplementation(((data: unknown) => {
    setTimeout(() => {
      let event: MessageEvent;
      try {
        event = new MessageEvent('message', { data, source: target });
      } catch {
        event = new MessageEvent('message', { data });
        Object.defineProperty(event, 'source', { value: target });
      }
      window.dispatchEvent(event);
    }, 0);
  }) as never);

  // The EMBEDDER assigns srcdoc AFTER createRunnerHost; jsdom never fires srcdoc loads,
  // so the load is simulated explicitly (runner harness notes).
  iframe.srcdoc = '<p>app</p>';
  await new Promise((resolve) => setTimeout(resolve, 0)); // deliver the srcdoc mutation record
  iframe.dispatchEvent(new Event('load'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const mountApp = async (): Promise<Probe<AppApi>> => {
    __resetSnugBridgeForTests(); // a fresh app document starts with a fresh bridge
    const probe = await renderProbe<AppApi>(appBody);
    await flush(); // announce → host-ready → hydration round-trips
    return probe;
  };

  const ctx: IntegrationCtx = {
    iframe,
    host,
    driver,
    backend,
    transportCalls,
    announces,
    probe: await mountApp(),
    remountApp: async () => {
      ctx.probe.unmount();
      ctx.probe = await mountApp();
      return ctx.probe;
    },
    destroy: async () => {
      ctx.probe.unmount();
      host.destroy();
      await driver.close();
      iframe.remove();
    },
  };
  contexts.push(ctx);
  return ctx;
}

describe('integration: runner host × sdk module hooks × db driver (one jsdom harness)', () => {
  it('completes the handshake: announce reaches the host, host-ready flips the hooks live', async () => {
    const ctx = await mountIntegration();
    expect(ctx.announces).toEqual(['itest-app']);
    expect(ctx.probe.result.current.snug.isReady).toBe(true);
    expect(ctx.probe.result.current.snug.theme).toBe('light');
  });

  it('sendMessage round-trips through the real host: envelope wire, cumulative streaming deltas, terminal data', async () => {
    const ctx = await mountIntegration();
    const chunks: string[] = [];
    let promise: Promise<SendMessageResult> | undefined;
    await act(async () => {
      promise = ctx.probe.result.current.snug.sendMessage(
        'player_move',
        { from: 'e2', to: 'e4' },
        { state: { count: 0 }, responseSchema: { message: 'string' }, onStream: (text) => chunks.push(text) },
      );
    });
    await flush();

    expect(ctx.transportCalls).toHaveLength(1);
    expect(ctx.transportCalls[0]).toContain(SNUG_APP_REQUEST_TAG); // the host-built chat envelope
    expect(ctx.transportCalls[0]).toContain('player_move');

    // the host accumulates transport DELTAS into cumulative streaming frames (R3)
    expect(chunks).toEqual(['Consider', 'Considering…']);
    await expect(promise).resolves.toEqual({ ok: true, data: { message: 'move accepted', san: 'e4' } });
    expect(ctx.probe.result.current.snug.isWaiting).toBe(false);
  });

  it('usePersistedState writes through the db driver and survives an app reload (kvSet → restore)', async () => {
    const ctx = await mountIntegration();
    expect(ctx.probe.result.current.persisted[0]).toEqual({ count: 0 });

    await act(async () => {
      ctx.probe.result.current.persisted[1]({ count: 3 });
    });
    await flush();
    await ctx.driver.flush();
    expect(ctx.backend.files.size).toBe(1); // the namespace really persisted through the backend

    const reloaded = await ctx.remountApp();
    expect(reloaded.result.current.snug.isReady).toBe(true);
    expect(reloaded.result.current.persisted[0]).toEqual({ count: 3 }); // hydrated from snug_kv
  });

  it('useAppDB exec/export/import run real SQL through the host into sql.js', async () => {
    const ctx = await mountIntegration();
    const db = ctx.probe.result.current.db;

    await db.exec('CREATE TABLE notes (id INTEGER, body TEXT)');
    await db.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [1, 'hello']);
    const select = await db.exec('SELECT id, body FROM notes');
    expect(select).toEqual({ rows: [[1, 'hello']], columns: ['id', 'body'] });

    const snapshot = await db.exportDb();
    const bytes = atob(snapshot);
    expect(bytes.slice(0, 15)).toBe('SQLite format 3'); // a real .sqlite file
    expect(bytes.charCodeAt(15)).toBe(0);

    await db.exec('INSERT INTO notes (id, body) VALUES (?, ?)', [2, 'bye']);
    await db.importDb(snapshot); // replace with the earlier snapshot
    const after = await db.exec('SELECT count(*) FROM notes');
    expect(after.rows).toEqual([[1]]);

    // SQL failures surface as thrown Errors carrying the driver's message
    await expect(db.exec('SELECT * FROM missing')).rejects.toThrow(/missing/);
  });
});
