// hostWasmWiring.test.ts — TASK-20260905-host-kit P4 / AC8: the sql.js engine bytes reach
// the playground's callers from ONE platform seat. `sqlJsEngineOptions()` (run/sqlJsEngine.ts)
// is the one place that turns `getPlatform().sqlJsWasmBinary` + the bundler locator into
// the engine options, and the user-db boot passes them to `openUserDb` — the FIRST
// initSqlJs caller, which is the one sql.js memoizes, so the bytes must ride it (db plan
// review #0). The RunView ephemeral driver reads the same seat; its forward is proven on
// the built kit (AC8's e2e abort list: no request for sql-wasm.wasm, ever).
//
// Fresh module graph per case (the platform is set-once) — the platformBackendWiring
// pattern, with `@snugprotocol/db` wrapped so the call's OPTIONS are observable (lesson
// 2026-08-12: test that the option ARRIVES).
import { createRequire } from 'node:module';

import type { PersistenceBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

const require = createRequire(import.meta.url);
const nodeLocateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');
const BYTES = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]); // '\0asm' + version — a marker, never booted here

const recorded = vi.hoisted(() => ({ openUserDb: [] as Array<Record<string, unknown>>, createDbDriver: [] as Array<Record<string, unknown>> }));

function memoryBackend(): PersistenceBackend {
  const files = new Map<string, Uint8Array>();
  return {
    kind: 'memory',
    load: (file) => Promise.resolve(files.get(file)),
    save: (file, bytes) => {
      files.set(file, bytes);
      return Promise.resolve();
    },
  };
}

function hostPlatform(wasm: Uint8Array | undefined): SnugPlatform {
  return {
    kind: 'host',
    userdbBackend: memoryBackend(),
    ...(wasm !== undefined ? { sqlJsWasmBinary: wasm } : {}),
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, hubAuth: false },
  };
}

/** Fresh graph with the platform installed and `@snugprotocol/db` wrapped to record options. */
async function fresh(platform: SnugPlatform | undefined) {
  vi.resetModules();
  recorded.openUserDb.length = 0;
  recorded.createDbDriver.length = 0;
  vi.doMock('../run/wasm.js', () => ({ locateWasm: nodeLocateWasm }));
  vi.doMock('@snugprotocol/db', async (importOriginal) => {
    const real = await importOriginal<typeof import('@snugprotocol/db')>();
    return {
      ...real,
      openUserDb: (options: Record<string, unknown> = {}) => {
        recorded.openUserDb.push(options);
        // The marker bytes are not a real engine: strip them before delegating so the
        // boot completes and the assertion is about what ARRIVED, not about booting.
        const { wasmBinary: _ignored, ...rest } = options;
        return real.openUserDb(rest as Parameters<typeof real.openUserDb>[0]);
      },
      createDbDriver: (options: Record<string, unknown> = {}) => {
        recorded.createDbDriver.push(options);
        const { wasmBinary: _ignored, ...rest } = options;
        return real.createDbDriver(rest as Parameters<typeof real.createDbDriver>[0]);
      },
    };
  });
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  return {
    engine: await import('../run/sqlJsEngine.js'),
    userdb: await import('../state/userdb.js'),
  };
}

afterEach(() => {
  vi.doUnmock('@snugprotocol/db');
  vi.doUnmock('../run/wasm.js');
  vi.resetModules();
});

describe('sqlJsEngineOptions() — the one seat for the engine source', () => {
  it('carries the platform bytes beside the locator when the seat is set', async () => {
    const g = await fresh(hostPlatform(BYTES));
    const options = g.engine.sqlJsEngineOptions();
    expect(options.wasmBinary).toBe(BYTES);
    expect(typeof options.locateWasm).toBe('function');
  });

  it('is the locator alone when the seat is absent (web/desktop — today, byte for byte)', async () => {
    const g = await fresh(undefined);
    const options = g.engine.sqlJsEngineOptions();
    expect(options).not.toHaveProperty('wasmBinary');
    expect(typeof options.locateWasm).toBe('function');
  });
});

describe('the user-db boot hands the bytes to openUserDb (the first initSqlJs caller)', () => {
  it('passes wasmBinary when the platform carries it', async () => {
    const g = await fresh(hostPlatform(BYTES));
    await g.userdb.getUserDb();
    expect(recorded.openUserDb).toHaveLength(1);
    expect(recorded.openUserDb[0]!.wasmBinary).toBe(BYTES);
    expect(typeof recorded.openUserDb[0]!.locateWasm).toBe('function');
  });

  it('passes no wasmBinary when the platform has none (positive twin)', async () => {
    const g = await fresh(hostPlatform(undefined));
    await g.userdb.getUserDb();
    expect(recorded.openUserDb).toHaveLength(1);
    expect(recorded.openUserDb[0]).not.toHaveProperty('wasmBinary');
  });
});
