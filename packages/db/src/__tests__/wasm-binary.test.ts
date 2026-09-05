// `wasmBinary` reaches BOTH initSqlJs sites (TASK-20260905-host-kit P4 / AC8). The host
// kit carries the sql.js engine as bytes because the artifact viewer's `connect-src
// 'self'` blocks every wasm fetch (T1, S1) — so the bytes must arrive at whichever call
// boots sql.js first.
//
// sql.js memoizes the FIRST initSqlJs per process (plan review #0), and vitest loads it
// externalized, so `vi.resetModules()` cannot hand a test a fresh engine — one real boot
// per test FILE. The design here mirrors that fact instead of fighting it:
//   1. the FIRST case is the one real boot — bytes in, a locator that can never resolve:
//      if the bytes were ignored, sql.js reads '/nonexistent/…' and boot fails loudly;
//   2. every later case proves the option ARRIVES at its seam (lesson 2026-08-12 — a
//      guard expressed as an option is voided by a caller that does not forward it)
//      through the `sql.js` module wrapped to RECORD the config each caller handed it.
// Declaration order is load-bearing (vitest runs a file's cases in order).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBackend } from '../persistence.js';
import { createDbDriver } from '../driver.js';
import { openUserDb } from '../userdb/userdb.js';
import { execFrame, locateWasm } from './helpers.js';

const recorded = vi.hoisted(() => ({ configs: [] as Array<Record<string, unknown> | undefined> }));

vi.mock('sql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('sql.js')>();
  const wrapped = (config?: Record<string, unknown>) => {
    recorded.configs.push(config);
    return actual.default(config as Parameters<typeof actual.default>[0]);
  };
  return { default: wrapped };
});

const require = createRequire(import.meta.url);
const wasmBytes = new Uint8Array(readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm')));
/** A locator that can never resolve: if the one real boot routes through it, it fails loudly. */
const poisonedLocator = vi.fn((): string => '/nonexistent/sql-wasm.wasm');

beforeEach(() => {
  recorded.configs.length = 0;
  poisonedLocator.mockClear();
});

describe('sql.js engine from bytes (wasmBinary)', () => {
  it('createDbDriver boots the engine from wasmBinary and never asks the locator (the one real boot)', async () => {
    const driver = createDbDriver({ backend: createMemoryBackend(), wasmBinary: wasmBytes, locateWasm: poisonedLocator });
    const result = await driver.handle('ns', execFrame('SELECT 1 AS one'));
    expect(result).toMatchObject({ ok: true, rows: [[1]] });
    expect(poisonedLocator).not.toHaveBeenCalled();
    expect(recorded.configs).toHaveLength(1);
    expect(recorded.configs[0]).toHaveProperty('wasmBinary');
    expect(recorded.configs[0]).not.toHaveProperty('locateFile');
    await driver.close();
  });

  it('openUserDb hands wasmBinary to its own initSqlJs AND forwards it to the inner per-app driver (both sites)', async () => {
    const opened = await openUserDb({
      backend: createMemoryBackend(),
      wasmBinary: wasmBytes,
      locateWasm: poisonedLocator,
      persistDebounceMs: 1,
    });
    if (opened.status !== 'ok') throw new Error(`open failed: ${opened.status}`);
    // The inner driver calls initSqlJs on its first request — the second recorded config.
    const exec = await opened.userDb.driver.handle('app-1', execFrame('SELECT 2 AS two'));
    expect(exec).toMatchObject({ ok: true, rows: [[2]] });
    expect(poisonedLocator).not.toHaveBeenCalled();
    expect(recorded.configs).toHaveLength(2);
    for (const config of recorded.configs) {
      expect(config).toHaveProperty('wasmBinary');
      expect(config).not.toHaveProperty('locateFile');
    }
  });

  it("without wasmBinary both sites keep today's shape — a locateFile config and nothing else (positive twin)", async () => {
    // The locator PATH itself is exercised by every other db test file (each boots sql.js
    // through `locateWasm` in its own worker); this pins the seam's shape.
    const driver = createDbDriver({ backend: createMemoryBackend(), locateWasm });
    await driver.handle('ns', execFrame('SELECT 1'));
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error(`open failed: ${opened.status}`);
    await opened.userDb.driver.handle('app-1', execFrame('SELECT 1'));
    expect(recorded.configs).toHaveLength(3);
    for (const config of recorded.configs) {
      expect(config).toHaveProperty('locateFile');
      expect(config).not.toHaveProperty('wasmBinary');
    }
    await driver.close();
  });

  it('a config with neither option is passed as undefined — sql.js resolves the asset itself, as before', async () => {
    const driver = createDbDriver({ backend: createMemoryBackend() });
    await driver.handle('ns', execFrame('SELECT 1'));
    expect(recorded.configs).toEqual([undefined]);
    await driver.close();
  });
});
