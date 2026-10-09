// brainFollowsRevision.test.tsx — TASK-20261003 D4 (ADR-0071 §4, ADR-0072 §3): when no brain
// is ready the DEMO brain answers, and when one comes back the host brain does — with no
// reload, no second `setPlatform`, and nothing thrown in between.
//
// THE MECHANISM UNDER TEST. The platform is set once, before boot, so a host that learns
// late that its brain went away cannot swap the platform. It carries `brain` as a GETTER
// instead (the runner's composition, apps/host `compose-local.ts`) and bumps `brainRevision`
// when what the getter answers has changed. Three readers have to follow:
//
//   useBrain()            — a hook that memoized on the platform's brain as "a static input"
//                           never looked again, so the chip kept its boot label for ever;
//   currentBrain()        — per send; it reads the getter each time;
//   createTurnAdapter()   — its `host` arm THREW when the pin was no longer a host brain,
//                           which is exactly the instant a brain goes away mid-turn.
//
// "ready → absent → ready": the chip, `currentBrain()`, the builder arm and an app think all
// follow, nothing throws, and the turn's tag says demo while the demo brain answers.
import type { AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';
import { createMemoryBackend } from '@snugprotocol/db';
import { createRequire } from 'node:module';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostCapabilities } from '../platform/hostCapabilities.js';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Each case cold-imports the app's module graph after `vi.resetModules()` (the
// hubAvailability.test.tsx budget, for the same measured reason).
vi.setConfig({ testTimeout: 20_000 });

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const HOST_LABEL = 'Claude · your CLI';
const HOST_REPLY = '{"message":"from the host brain"}';
const WIRE = 'move e4';

function fakeAdapter(): { adapter: AgentAdapter; calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    adapter: {
      complete: async (request) => {
        calls.push(request);
        request.onDelta?.(HOST_REPLY);
        return { ok: true, text: HOST_REPLY, toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

/** The runner's shape: ONE platform object whose `brain` is read through a getter. */
function runnerPlatform(host: AgentAdapter): { platform: SnugPlatform; set(ready: boolean): void } {
  // Both arms are STABLE references, as the real composition's are: a fresh object per read
  // would make every `useMemo` keyed on it recompute on every render.
  const hostArm: PlatformBrain = { kind: 'host', label: HOST_LABEL, adapter: host, streaming: false, tools: false };
  const demoArm: PlatformBrain = { kind: 'demo' };
  let ready = true;
  const platform: SnugPlatform = {
    kind: 'host',
    binding: 'local-host',
    userdbBackend: createMemoryBackend(),
    capabilities: hostCapabilities({ connections: true }),
  };
  Object.defineProperty(platform, 'brain', { enumerable: true, get: () => (ready ? hostArm : demoArm) });
  return { platform, set: (next) => void (ready = next) };
}

interface Graph {
  signals: typeof import('../platform/signals.js');
  webllm: typeof import('../state/webllm.js');
  activeBrain: typeof import('../state/activeBrain.js');
  adapter: typeof import('../agent/adapter.js');
  transport: typeof import('../agent/transport.js');
  builder: typeof import('../agent/builder.js');
  chip: typeof import('../views/BrainChip.js');
}

async function fresh(platform: SnugPlatform): Promise<Graph> {
  vi.resetModules();
  vi.doMock('../run/wasm.js', () => ({ locateWasm }));
  const platformModule = await import('../platform/platform.js');
  platformModule.setPlatform(platform);
  return {
    signals: await import('../platform/signals.js'),
    webllm: await import('../state/webllm.js'),
    activeBrain: await import('../state/activeBrain.js'),
    adapter: await import('../agent/adapter.js'),
    transport: await import('../agent/transport.js'),
    builder: await import('../agent/builder.js'),
    chip: await import('../views/BrainChip.js'),
  };
}

const fakeSink = {
  write: async () => ({ id: 'app-1', displayName: 'app', version: 1 }),
  ensureTargetId: async () => 'app-1',
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.resetModules();
  vi.doUnmock('../run/wasm.js');
});

const chip = (): HTMLElement => {
  const el = container?.querySelector<HTMLElement>('[data-testid="brain-chip"]');
  if (el == null) throw new Error('the brain chip is not rendered');
  return el;
};
const chipLabel = (): string => chip().querySelector('.brain-chip-label')?.textContent ?? '';

describe('ready → absent → ready (D4)', () => {
  it('the chip follows a brainRevision bump — with no reload and no second setPlatform', async () => {
    const runner = runnerPlatform(fakeAdapter().adapter);
    const g = await fresh(runner.platform);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <MemoryRouter>
          <g.chip.BrainChip />
        </MemoryRouter>,
      );
    });
    expect(chip().getAttribute('data-brain')).toBe('host');
    expect(chipLabel()).toBe(HOST_LABEL);

    // The CLI went away (the runner's probe said `absent`): the SAME platform now answers demo.
    runner.set(false);
    act(() => g.signals.bumpBrainRevision());
    expect(chip().getAttribute('data-brain')).toBe('demo');
    expect(chipLabel()).toBe('demo brain');

    // …and it came back.
    runner.set(true);
    act(() => g.signals.bumpBrainRevision());
    expect(chip().getAttribute('data-brain')).toBe('host');
    expect(chipLabel()).toBe(HOST_LABEL);
  });

  it('a label that changes UNDER the same host arm reaches the chip on a bump — the revision is a memo DEPENDENCY, not only a re-render', async () => {
    // The runner's host arm is ONE object for the life of the page; what changes is what
    // its `label` getter answers (the probe's verdict, the model that answered). A hook
    // that re-rendered on the bump but memoized on the arm's reference would hand back the
    // brain it resolved at boot, label and all.
    let label = HOST_LABEL;
    const hostArm = { kind: 'host' as const, adapter: fakeAdapter().adapter, streaming: false, tools: false } as PlatformBrain;
    Object.defineProperty(hostArm, 'label', { enumerable: true, get: () => label });
    const platform: SnugPlatform = { kind: 'host', binding: 'local-host', userdbBackend: createMemoryBackend(), capabilities: hostCapabilities({ connections: true }), brain: hostArm };
    const g = await fresh(platform);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <MemoryRouter>
          <g.chip.BrainChip />
        </MemoryRouter>,
      );
    });
    expect(chipLabel()).toBe(HOST_LABEL);
    // A resolved-brain reader that is NOT the chip's own platform read: the active brain.
    const resolved: string[] = [];
    function Probe(): null {
      const brain = g.webllm.useBrain();
      resolved.push(brain.kind === 'host' ? brain.label : brain.kind);
      return null;
    }
    const probeContainer = document.createElement('div');
    document.body.appendChild(probeContainer);
    const probeRoot = createRoot(probeContainer);
    act(() => probeRoot.render(<Probe />));
    expect(resolved.at(-1)).toBe(HOST_LABEL);

    label = 'Claude · Sonnet 5';
    act(() => g.signals.bumpBrainRevision());
    expect(chipLabel()).toBe('Claude · Sonnet 5');
    expect(resolved.at(-1), 'useBrain() itself hands back the new label').toBe('Claude · Sonnet 5');
    act(() => probeRoot.unmount());
    probeContainer.remove();
  });

  it('without a bump nothing re-renders — the revision is the signal, the getter is the truth', async () => {
    // The negative twin: a getter alone moves no React tree. If this ever passes on the
    // changed state, something is polling the platform.
    const runner = runnerPlatform(fakeAdapter().adapter);
    const g = await fresh(runner.platform);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <MemoryRouter>
          <g.chip.BrainChip />
        </MemoryRouter>,
      );
    });
    runner.set(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(chip().getAttribute('data-brain')).toBe('host');
  });

  it('currentBrain() and the active-brain derivation follow at once — they read the platform per call', async () => {
    const runner = runnerPlatform(fakeAdapter().adapter);
    const g = await fresh(runner.platform);
    expect(g.webllm.currentBrain()).toEqual({ kind: 'host', label: HOST_LABEL, streaming: false, tools: false });
    expect(g.activeBrain.resolveActiveBrain()).toBe('host');
    runner.set(false);
    expect(g.webllm.currentBrain()).toEqual({ kind: 'demo', reason: 'host' });
    expect(g.activeBrain.resolveActiveBrain()).toBe('demo');
    runner.set(true);
    expect(g.webllm.currentBrain()).toMatchObject({ kind: 'host' });
    expect(g.activeBrain.resolveActiveBrain()).toBe('host');
  });

  it('an APP think follows: the host brain, then the demo script — never the gone brain — then the host brain again', async () => {
    const fake = fakeAdapter();
    const runner = runnerPlatform(fake.adapter);
    const g = await fresh(runner.platform);
    // ONE transport for the whole session, as RunView memoizes it: the brain is decided per send.
    const transport = g.transport.createAppTransport('byok', 'mock');
    const send = () => transport.send(WIRE, { signal: new AbortController().signal });

    expect(await send()).toMatchObject({ ok: true, text: HOST_REPLY });
    expect(fake.calls).toHaveLength(1);

    runner.set(false);
    const demo = await send();
    expect(demo.ok).toBe(true);
    expect(demo).not.toMatchObject({ text: HOST_REPLY });
    expect(fake.calls, 'the brain that went away must not be asked').toHaveLength(1);

    runner.set(true);
    expect(await send()).toMatchObject({ ok: true, text: HOST_REPLY });
    expect(fake.calls).toHaveLength(2);
  });

  it('the BUILDER arm follows, and the turn’s tag says demo while the demo brain answers', async () => {
    const fake = fakeAdapter();
    const runner = runnerPlatform(fake.adapter);
    const g = await fresh(runner.platform);
    // What useBuilderChat constructs for each `useBrain()` answer (its agent memo is keyed on it).
    const build = async (): Promise<{ ok: boolean; tag: string | undefined }> => {
      const brain = g.webllm.currentBrain();
      const agent = g.builder.createDirectBuilder(
        brain.kind === 'host' ? { mode: 'host', provider: 'mock', sink: fakeSink } : { mode: 'byok', provider: 'mock', sink: fakeSink },
      );
      let tag: string | undefined;
      const result = await agent.send('build me a tiny app', { onBrain: (kind) => void (tag = kind) }, new AbortController().signal);
      return { ok: result.ok, tag };
    };

    expect(await build()).toEqual({ ok: true, tag: 'host' });
    expect(fake.calls).toHaveLength(1);

    runner.set(false);
    expect(await build()).toEqual({ ok: true, tag: 'demo' });
    expect(fake.calls, 'a demo-tagged turn never reaches the host brain').toHaveLength(1);

    runner.set(true);
    expect(await build()).toEqual({ ok: true, tag: 'host' });
    expect(fake.calls).toHaveLength(2);
  });
});

describe('a brain that goes away MID-TURN is a named error, never a throw and never a substitution', () => {
  it('createTurnAdapter’s host arm answers a result when the pin is no longer a host brain', async () => {
    const fake = fakeAdapter();
    const runner = runnerPlatform(fake.adapter);
    const g = await fresh(runner.platform);
    // The turn was routed while the brain was ready (`mode: 'host'`)…
    runner.set(false);
    // …and the adapter is built after it went away. This used to throw
    // "adapterKindFor said 'host' without a platform-pinned host brain".
    let adapter: AgentAdapter | undefined;
    expect(() => {
      adapter = g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'app');
    }).not.toThrow();
    const result = await adapter!.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toEqual({
      ok: false,
      code: g.adapter.HOST_BRAIN_GONE_CODE,
      message: expect.stringMatching(/went away/),
      retryable: true,
    });
    // NOT the demo script standing in for the brain the turn was promised: the next turn
    // is demo, this one says what happened.
    expect(fake.calls).toHaveLength(0);
  });

  it('the same for the builder’s purpose — and an app transport that raced the flip reports it as an error result', async () => {
    const fake = fakeAdapter();
    const runner = runnerPlatform(fake.adapter);
    const g = await fresh(runner.platform);
    runner.set(false);
    const chat = await g.adapter.createTurnAdapter({ mode: 'host', provider: 'mock' }, 'chat').complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat).toMatchObject({ ok: false, code: g.adapter.HOST_BRAIN_GONE_CODE });

    // The transport's own leaf, pinned to `host` as `resolveAppTransport` pins it when the
    // brain was ready at decision time.
    const raced = await g.transport.createDirectAppTransport({ mode: 'host', provider: 'mock' }).send(WIRE, { signal: new AbortController().signal });
    expect(raced).toMatchObject({ ok: false, code: g.adapter.HOST_BRAIN_GONE_CODE, retryable: true });
  });
});
