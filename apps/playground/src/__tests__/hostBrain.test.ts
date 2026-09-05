// hostBrain.test.ts — TASK-20260905-host-kit P2 / AC3: the platform brain seat is honoured
// by the ONE brain derivation AHEAD of the webllm flag and ahead of whatever the user file
// says. A file imported with mode 'local' / 'subscription' / a BYOK key must still route
// every APP turn and every BUILDER turn to the pinned host brain; F15's endpoint-confirm
// must not block them (the file's endpoints are irrelevant to a pinned brain); and the
// disclosure derivation must name 'host' (ADR-0059 rule 2 — one derivation, never two).
//
// Fresh module graph per case (setPlatform is set-once): the openFileRecovery harness
// pattern. The user DB boots over a memory backend so the egress guard has a real db.
import type { AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';
import { createMemoryBackend } from '@snugprotocol/db';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const HOST_LABEL = 'Claude · this artifact’s viewer';
const REPLY = '{"message":"from the host brain"}';
const WIRE = 'move e4';

interface Graph {
  platform: typeof import('../platform/platform.js');
  mode: typeof import('../state/mode.js');
  webllm: typeof import('../state/webllm.js');
  activeBrain: typeof import('../state/activeBrain.js');
  transport: typeof import('../agent/transport.js');
  builder: typeof import('../agent/builder.js');
}

function fakeAdapter(): { adapter: AgentAdapter; calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    adapter: {
      complete: async (request) => {
        calls.push(request);
        request.onDelta?.(REPLY);
        return { ok: true, text: REPLY, toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

function hostPlatform(brain: PlatformBrain): SnugPlatform {
  return {
    kind: 'host',
    binding: 'artifact',
    brain,
    userdbBackend: createMemoryBackend(),
    capabilities: {
      subscriptionMode: false,
      hubSyncOrigin: false,
      lanHttpPrivate: false,
      hubAuth: false,
      brainSettings: false,
      account: false,
      sync: false,
      connections: false,
      share: false,
    },
  };
}

/** A fresh graph; `install` runs against the fresh platform module BEFORE anything reads it. */
async function fresh(install?: (platform: Graph['platform']) => void): Promise<Graph> {
  vi.resetModules();
  vi.doMock('../run/wasm.js', () => ({ locateWasm }));
  const platform = await import('../platform/platform.js');
  install?.(platform);
  return {
    platform,
    mode: await import('../state/mode.js'),
    webllm: await import('../state/webllm.js'),
    activeBrain: await import('../state/activeBrain.js'),
    transport: await import('../agent/transport.js'),
    builder: await import('../agent/builder.js'),
  };
}

const fakeSink = {
  write: async () => ({ id: 'app-1', displayName: 'app', version: 1 }),
  ensureTargetId: async () => 'app-1',
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../run/wasm.js');
});

type FileSetting = { label: string; apply: (g: Graph) => void };
const FILE_SETTINGS: FileSetting[] = [
  { label: "mode 'local'", apply: (g) => g.mode.modeStore.set('local') },
  { label: "mode 'subscription'", apply: (g) => g.mode.modeStore.set('subscription') },
  {
    label: 'byok with an Anthropic key present',
    apply: (g) => {
      g.mode.modeStore.set('byok');
      g.mode.providerStore.set('anthropic');
      g.mode.byokKeyPresenceStore.set({ anthropic: true, openai: false });
    },
  },
];

describe('a pinned host brain outranks the user file (P2, AC3)', () => {
  for (const setting of FILE_SETTINGS) {
    it(`app turns route to the pinned adapter under ${setting.label}, F15 armed and ignored`, async () => {
      const fake = fakeAdapter();
      const g = await fresh((p) =>
        p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: true, tools: true })),
      );
      setting.apply(g);
      g.mode.endpointsNeedConfirmStore.set(true); // F15: an imported file's endpoints would normally block direct turns

      expect(g.webllm.currentBrain()).toEqual({ kind: 'host', label: HOST_LABEL, streaming: true, tools: true });
      expect(g.activeBrain.resolveActiveBrain()).toBe('host');

      const transport = g.transport.resolveAppTransport(g.mode.modeStore.get(), g.mode.providerStore.get());
      const result = await transport.send(WIRE, { signal: new AbortController().signal });
      expect(result).toMatchObject({ ok: true, text: REPLY });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: WIRE });
    });
  }

  it('builder turns route to the pinned adapter too, stamped as host, with tools when the brain has them', async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: true, tools: true })),
    );
    g.mode.modeStore.set('local');
    g.mode.endpointsNeedConfirmStore.set(true);
    const onBrain = vi.fn();
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const result = await agent.send('build me a tiny app', { onBrain }, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(onBrain).toHaveBeenCalledWith('host');
    expect(fake.calls).toHaveLength(1);
    expect((fake.calls[0]!.tools ?? []).length).toBeGreaterThan(0);
  });

  it('a host brain without tools builds TOOL-FREE (the webllm arm, generalised)', async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: false, tools: false })),
    );
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    await agent.send('build me a tiny app', {}, new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.tools ?? []).toHaveLength(0);
    expect(g.webllm.currentBrain()).toMatchObject({ kind: 'host', streaming: false, tools: false });
  });

  it("resolveTurnMode names 'host' — never 'subscription' — under a pinned brain", async () => {
    const g = await fresh();
    expect(g.webllm.resolveTurnMode({ kind: 'host', label: HOST_LABEL, streaming: true, tools: true }, 'subscription')).toBe('host');
  });

  it("a pinned DEMO brain is the demo brain with reason 'host', and app turns run the mock adapter (never the file's local endpoint)", async () => {
    const g = await fresh((p) => p.setPlatform(hostPlatform({ kind: 'demo' })));
    g.mode.modeStore.set('local');
    expect(g.webllm.currentBrain()).toEqual({ kind: 'demo', reason: 'host' });
    expect(g.activeBrain.resolveActiveBrain()).toBe('demo');
    const result = await g.transport
      .resolveAppTransport('local', 'mock')
      .send(WIRE, { signal: new AbortController().signal });
    expect(result.ok).toBe(true); // the local adapter would have failed against a closed loopback port
  });

  it("positive twin: with no pinned brain the file decides, exactly as today ('local' → local; brain 'settings')", async () => {
    const g = await fresh();
    g.mode.modeStore.set('local');
    expect(g.webllm.currentBrain()).toEqual({ kind: 'settings' });
    expect(g.activeBrain.resolveActiveBrain()).toBe('local');
    expect(g.webllm.resolveTurnMode({ kind: 'settings' }, 'local')).toBe('local');
  });
});
