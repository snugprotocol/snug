// The host platform (TASK-20260905-host-kit P2/P3): every seat the probe decided, every
// surface flag OFF, the four launch booleans explicit — and, through the playground's own
// readers, `allows()` false for each surface and `secretsUsable()` false (AC9). The web
// default is the positive twin: absence means every surface renders.
import { createMemoryBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHostPlatform } from '../platform-host.js';
import type { ProbeResult } from '../probe.js';

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const probe = (): ProbeResult => ({
  binding: 'artifact',
  storage: { backend: createMemoryBackend(), kind: 'memory' },
  brain: { brain: { kind: 'demo' }, legs: { sample: 'detected', complete: 'absent', local: 'absent' } },
});

afterEach(() => {
  vi.resetModules();
});

describe('createHostPlatform', () => {
  it('carries the probe: kind host, the binding, the pinned brain, the tried backend, the engine bytes', () => {
    const p = probe();
    const platform = createHostPlatform(p, wasm);
    expect(platform.kind).toBe('host');
    expect(platform.binding).toBe('artifact');
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(platform.userdbBackend).toBe(p.storage.backend);
    expect(platform.sqlJsWasmBinary).toBe(wasm);
  });

  it('sets the four launch booleans explicitly false and every host surface flag false', () => {
    const { capabilities } = createHostPlatform(probe(), wasm);
    expect(capabilities).toEqual({
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
    });
  });

  it('supplies no transport seats a host cannot honour (no fetch, LAN, sidecar, helper, oauth, update seats)', () => {
    const platform = createHostPlatform(probe(), wasm) as unknown as Record<string, unknown>;
    for (const seat of [
      'fetchImpl',
      'lanFetch',
      'lanPair',
      'sidecarCtl',
      'sidecarFetch',
      'sidecarWizardFetch',
      'helperStatus',
      'helperInstall',
      'oauth',
      'probeOllama',
      'onOpenSnugFile',
      'onOpenShareLink',
      'appUpdates',
    ]) {
      expect(platform[seat], seat).toBeUndefined();
    }
  });

  it("through the playground's readers: allows() is false for every surface and secretsUsable() is false", async () => {
    const mod = await import('@playground/platform/platform');
    mod.setPlatform(createHostPlatform(probe(), wasm));
    for (const surface of ['brainSettings', 'account', 'sync', 'connections', 'share'] as const) {
      expect(mod.allows(surface), surface).toBe(false);
    }
    expect(mod.secretsUsable()).toBe(false);
  });

  it('positive twin — the web default allows every surface and can use secrets', async () => {
    const mod = await import('@playground/platform/platform');
    for (const surface of ['brainSettings', 'account', 'sync', 'connections', 'share'] as const) {
      expect(mod.allows(surface), surface).toBe(true);
    }
    expect(mod.secretsUsable()).toBe(true);
  });
});
