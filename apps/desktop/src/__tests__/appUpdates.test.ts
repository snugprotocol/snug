// appUpdates.test.ts — TASK-20260821-hardening-polish AC13 (desktop half, ADR-0047).
//
// Three claims, each of a class this repo has been burned by:
//  1. REAP BEFORE RELAUNCH, pinned by a CALL-ORDER SPY (lessons 2026-08-15: pin an
//     ordering with a spy, never a comment) — AppHandle::restart() skips
//     RunEvent::Exit on the main thread, so this ordering is the only thing standing
//     between an update and an orphaned WhatsApp helper.
//  2. check() semantics the playground leans on: undefined when current, a REJECTION
//     (not a swallow) when the manifest is unreachable — the caller owns the
//     temperature, so a seat that swallowed here would make the Settings button lie.
//  3. The wiring: createDesktopPlatform().appUpdates exists (every injected
//     dependency is an untested wire — lessons 2026-08-17).

import { describe, expect, it, vi } from 'vitest';

import { createAppUpdates, type AppUpdatesDeps } from '../app-updates.js';

function makeDeps(overrides: Partial<AppUpdatesDeps> = {}): AppUpdatesDeps & { calls: string[] } {
  const calls: string[] = [];
  const update = {
    version: '0.2.0',
    date: '2026-09-01',
    body: 'notes text',
    downloadAndInstall: vi.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } });
      onEvent?.({ event: 'Progress', data: { chunkLength: 50 } });
      onEvent?.({ event: 'Finished' });
    }),
  };
  return {
    calls,
    getVersion: vi.fn(async () => '0.1.0'),
    check: vi.fn(async () => update as never),
    relaunch: vi.fn(async () => {
      calls.push('relaunch');
    }),
    sidecarCtl: vi.fn(async () => {
      calls.push('sidecarCtl:stop');
      return { running: false };
    }),
    ...overrides,
  };
}

describe('createAppUpdates (ADR-0047 §10)', () => {
  it('relaunch REAPS the sidecar BEFORE relaunching — call order, not prose', async () => {
    const deps = makeDeps();
    const updates = createAppUpdates(deps);
    await updates.relaunch();
    expect(deps.calls).toEqual(['sidecarCtl:stop', 'relaunch']);
    expect(deps.sidecarCtl).toHaveBeenCalledWith('stop');
  });

  it('a reap failure never blocks the update — relaunch still runs', async () => {
    const deps = makeDeps({
      sidecarCtl: vi.fn(async () => {
        throw new Error('no helper');
      }),
    });
    const updates = createAppUpdates(deps);
    await updates.relaunch();
    expect(deps.calls).toEqual(['relaunch']);
  });

  it('check() maps the plugin answer and returns undefined when current', async () => {
    const deps = makeDeps();
    const updates = createAppUpdates(deps);
    expect(await updates.check()).toEqual({ version: '0.2.0', date: '2026-09-01', notes: 'notes text' });
    const current = makeDeps({ check: vi.fn(async () => null as never) });
    expect(await createAppUpdates(current).check()).toBeUndefined();
  });

  it('check() REJECTS on an unreachable manifest — the caller owns the temperature', async () => {
    const deps = makeDeps({
      check: vi.fn(async () => {
        throw new Error('error sending request');
      }),
    });
    await expect(createAppUpdates(deps).check()).rejects.toThrow('error sending request');
  });

  it('downloadAndInstall reports monotonic progress and refuses without a prior check', async () => {
    const deps = makeDeps();
    const updates = createAppUpdates(deps);
    await expect(updates.downloadAndInstall()).rejects.toThrow('run check() first');
    await updates.check();
    const seen: Array<number | undefined> = [];
    await updates.downloadAndInstall((f) => seen.push(f));
    expect(seen).toEqual([0, 0.5, 1, 1]);
  });

  it('currentVersion reads the shell version', async () => {
    expect(await createAppUpdates(makeDeps()).currentVersion()).toBe('0.1.0');
  });
});

describe('the shipping wiring', () => {
  it('createDesktopPlatform threads the seat (the untested-wire rule)', async () => {
    // Import inside the test: platform-desktop pulls Tauri plugin modules that need
    // mocking before evaluation in jsdom.
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
    vi.doMock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
    vi.doMock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.0.0') }));
    vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }));
    vi.doMock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
    vi.doMock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
    const { createDesktopPlatform } = await import('../platform-desktop.js');
    const platform = createDesktopPlatform();
    expect(platform.appUpdates).toBeDefined();
    expect(typeof platform.appUpdates!.check).toBe('function');
    expect(typeof platform.appUpdates!.relaunch).toBe('function');
    expect(typeof platform.appUpdates!.currentVersion).toBe('function');
  });
});
