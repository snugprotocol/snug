// The host platform (TASK-20260905-host-kit P2/P3): every seat the probe decided, every
// surface flag OFF, the four launch booleans explicit — and, through the playground's own
// readers, `allows()` false for each surface and `secretsUsable()` false (AC9). The web
// default is the positive twin: absence means every surface renders.
//
// TASK-20261010-cross-app-access AC20/AC23 (ADR-0075; ADR-0072 §4): access between apps is ON in
// the kit's table, and the boot probes a blob Worker ONCE — where none constructs, the page is
// composed `access: false` (capability truth: the read runs in that Worker). Both arms are pinned
// with the probe's answer injected, at the platform and through `planBoot` for both compositions.
import { createMemoryBackend } from '@snugprotocol/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostCapabilities } from '@playground/platform/hostCapabilities';
import type { SchedulerSeat } from '@playground/platform/platform';

import { planBoot, type BootWindow } from '../boot.js';
import type { ComposeDocument } from '../compose.js';
import type { LocalClient } from '../local/client.js';
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

  it('sets the four launch booleans explicitly false and every host surface flag false — except appExport, which stays ON (T4 AC6: the bundle download is how a kit-edited app goes back to the agent), schedule, which is ON (TASK-20261009 C7: the scheduler runs while the page is open), and access, which is ON (TASK-20261010-cross-app-access AC20: where the boot’s Worker probe constructed one)', () => {
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
      access: true,
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

// ------------------------------------------------------------- access between apps — the Worker probe

const wasmOf = (): Uint8Array => wasm;
const emptyDoc: ComposeDocument = { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] };

/** A page at an origin no runner serves: the boot goes straight to the probe (no `/status` asked). */
function hostedWindow(): BootWindow {
  return {
    location: { protocol: 'https:', hostname: 'claude.ai', pathname: '/', hash: '', search: '', href: 'https://claude.ai/' },
    history: { state: null, replaceState: () => undefined },
    fetch: async () => new Response('', { status: 404 }),
  } as unknown as BootWindow;
}

const RUNNER_TOKEN = 'a'.repeat(64);
/** The runner's own origin, with its launch token and a `/status` it answers. */
function runnerWindow(): BootWindow {
  const stored = new Map<string, string>();
  return {
    location: { protocol: 'http:', hostname: '127.0.0.1', pathname: '/', hash: `#token=${RUNNER_TOKEN}`, search: '', href: `http://127.0.0.1:43127/#token=${RUNNER_TOKEN}` },
    history: { state: null, replaceState: () => undefined },
    sessionStorage: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v), removeItem: (k: string) => void stored.delete(k) },
    fetch: async () => new Response(JSON.stringify({ binding: 'local-host', port: 43127, pages: 1, brains: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
  } as unknown as BootWindow;
}

const fakeClient = (): LocalClient => ({
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  events: () => () => {},
  reportHandIn: async () => {},
  recheckBrain: async () => {},
  stopped: { get: () => false, subscribe: () => () => {} },
});

describe('access between apps — the kit’s Worker probe (TASK-20261010-cross-app-access AC20/AC23; ADR-0072 §4)', () => {
  it('a page whose probe could not construct a Worker is composed `access: false` — the ONE table with the one override, nothing else moves', () => {
    const { capabilities } = createHostPlatform(probe(), wasm, { access: false });
    expect(capabilities).toEqual(hostCapabilities({ access: false }));
    expect(capabilities.access).toBe(false);
  });

  it('twin: where the probe constructed one (or said nothing), the table stands — `access: true`', () => {
    expect(createHostPlatform(probe(), wasm, { access: true }).capabilities).toEqual(hostCapabilities());
    expect(createHostPlatform(probe(), wasm).capabilities.access).toBe(true);
  });

  it("through the playground's reader: allows('access') follows the probe", async () => {
    const off = await import('@playground/platform/platform');
    off.setPlatform(createHostPlatform(probe(), wasm, { access: false }));
    expect(off.allows('access')).toBe(false);
    vi.resetModules(); // the platform is set once per page — a fresh module is a fresh page
    const on = await import('@playground/platform/platform');
    on.setPlatform(createHostPlatform(probe(), wasm, { access: true }));
    expect(on.allows('access')).toBe(true);
  });

  for (const constructs of [false, true]) {
    it(`planBoot (the probe path) asks the Worker probe ONCE and composes access: ${String(constructs)}`, async () => {
      const canConstructWorker = vi.fn(() => constructs);
      const plan = await planBoot(hostedWindow(), emptyDoc, { probe: async () => probe(), wasm: wasmOf, canConstructWorker });
      expect(plan.kind).toBe('hosted');
      if (plan.kind !== 'hosted') return;
      expect(canConstructWorker).toHaveBeenCalledTimes(1);
      expect(plan.composition.platform.capabilities.access).toBe(constructs);
    });

    it(`planBoot (the runner's page) asks the Worker probe ONCE and composes access: ${String(constructs)}`, async () => {
      const canConstructWorker = vi.fn(() => constructs);
      const plan = await planBoot(runnerWindow(), emptyDoc, { probe: async () => probe(), wasm: wasmOf, createClient: fakeClient, canConstructWorker, ask: { boundMs: 500 } });
      expect(plan.kind).toBe('runner');
      if (plan.kind !== 'runner') return;
      expect(canConstructWorker).toHaveBeenCalledTimes(1);
      expect(plan.composition.platform.capabilities.access).toBe(constructs);
      expect(plan.composition.platform.capabilities.connections).toBe(true); // the runner's one difference still stands
    });
  }

  it('the oauth callback page asks nothing — not even the Worker probe', async () => {
    const canConstructWorker = vi.fn(() => true);
    const win = hostedWindow();
    (win.location as { pathname: string }).pathname = '/oauth/callback';
    expect((await planBoot(win, emptyDoc, { probe: async () => probe(), wasm: wasmOf, canConstructWorker })).kind).toBe('oauth-callback');
    expect(canConstructWorker).not.toHaveBeenCalled();
  });
});
