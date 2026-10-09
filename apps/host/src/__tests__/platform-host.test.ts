// The host platform (TASK-20260905-host-kit P2/P3): every seat the probe decided, every
// surface flag OFF, the four launch booleans explicit — and, through the playground's own
// readers, `allows()` false for each surface and `secretsUsable()` false (AC9). The web
// default is the positive twin: absence means every surface renders.
import { createMemoryBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SchedulerSeat } from '@playground/platform/platform';

import { createHostPlatform, schedulerSeatFor } from '../platform-host.js';
import type { Binding, ProbeResult } from '../probe.js';

const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const probe = (): ProbeResult => ({
  binding: 'artifact',
  storage: { backend: createMemoryBackend(), kind: 'memory' },
  brain: { brain: { kind: 'demo' }, legs: { sample: 'detected', local: 'absent' } },
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

  it('sets the four launch booleans explicitly false and every host surface flag false — except appExport, which stays ON (T4 AC6: the bundle download is how a kit-edited app goes back to the agent), and schedule, which is ON (TASK-20261009 C7: the scheduler runs while the page is open)', () => {
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
      appExport: true,
      schedule: true,
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
    expect(mod.allows('appExport')).toBe(true);
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

describe('the scheduler seat (TASK-20261009 H3; ADR-0074 §7)', () => {
  it('is passed through verbatim when the composition supplies it — and absent otherwise, like every other seat', () => {
    const seat: SchedulerSeat = { wakeMode: 'page', hostLabel: 'this artifact' };
    expect(createHostPlatform(probe(), wasm, { scheduler: seat }).scheduler).toBe(seat);
    expect(createHostPlatform(probe(), wasm).scheduler).toBeUndefined();
  });

  it('schedulerSeatFor names the subject of the honesty line per binding: the two artifact arms say "this artifact", a plain file and the runner’s page say "this page"; every one promises only the page and carries no notify', () => {
    const expected: Record<Binding, string> = {
      artifact: 'this artifact',
      'artifact-static': 'this artifact',
      file: 'this page',
      'local-host': 'this page',
    };
    for (const [binding, hostLabel] of Object.entries(expected) as Array<[Binding, string]>) {
      const seat = schedulerSeatFor(binding);
      expect(seat, binding).toEqual({ wakeMode: 'page', hostLabel });
      expect('notify' in seat, `${binding}: the page cannot raise a notification`).toBe(false);
    }
  });
});
