// adapterKind.test.ts — TASK-20260826-demo-brain-clarity AC1 (ADR-0059 rule 2).
//
// `adapterKindFor` is THE routing decision — the one derivation every disclosure
// surface (brain chip, per-turn provenance tag) consumes — and `createTurnAdapter`
// must route THROUGH it, so the two can never drift. The proof is a full-matrix
// equivalence: for every (mode × provider × key-presence) config, the adapter
// actually constructed is the one `adapterKindFor` names.
//
// The factories are tagged spies because `AgentAdapter` is deliberately anonymous
// (one `complete()` seam, no name field): identifying the constructed adapter any
// other way would mean re-deriving the routing inside the test — the exact
// parallel-derivation drift this suite exists to forbid.

import { describe, expect, it, vi } from 'vitest';

import type { TurnAdapterConfig } from '../agent/adapter.js';

// Tag each factory's product so the matrix can read WHICH one was constructed.
vi.mock('@snugprotocol/adapters', async (importOriginal) => {
  const real = await importOriginal<typeof import('@snugprotocol/adapters')>();
  const tagged = (kind: string) => ({
    complete: async () => {
      throw new Error(`tagged ${kind} adapter — not for calling`);
    },
    __kind: kind,
  });
  return {
    ...real,
    anthropicAdapter: vi.fn(() => tagged('anthropic')),
    openaiAdapter: vi.fn(() => tagged('openai')),
    localAdapter: vi.fn(() => tagged('local')),
    mockAdapter: vi.fn(() => tagged('demo')),
    // TASK-20261023-siwc-chatgpt-plan L4: the plan's Responses adapter, tagged like the rest.
    openaiResponsesAdapter: vi.fn(() => tagged('chatgpt')),
  };
});
vi.mock('../agent/webllm/webllmAdapter.js', () => ({
  webllmAdapter: vi.fn(() => ({
    complete: async () => {
      throw new Error('tagged webllm adapter — not for calling');
    },
    __kind: 'webllm',
  })),
}));

const { ADAPTER_KINDS, HOST_BRAIN_GONE_CODE, adapterKindFor, createTurnAdapter, routeOf } = await import('../agent/adapter.js');

const constructedKind = (config: TurnAdapterConfig): string => {
  const adapter = createTurnAdapter(config, 'chat') as { __kind?: string };
  return adapter.__kind ?? 'untagged';
};

describe('adapterKindFor mirrors createTurnAdapter (AC1)', () => {
  it('agrees with the constructed adapter across the full config matrix', () => {
    // 'chatgpt' joined 2026-10-23 (TASK-20261023-siwc-chatgpt-plan L4-1). Its arm needs a model
    // to build the Responses adapter (no model anywhere is a named RESULT — pinned below), so the
    // chatgpt configs carry one; the other modes' configs are exactly what they always were.
    const modes = ['byok', 'local', 'webllm', 'chatgpt'] as const;
    const providers = ['mock', 'anthropic', 'openai'] as const;
    const keys = [undefined, 'sk-test'] as const;
    for (const mode of modes) {
      for (const provider of providers) {
        for (const key of keys) {
          const config: TurnAdapterConfig = {
            mode,
            provider,
            ...(key !== undefined ? { key } : {}),
            ...(mode === 'chatgpt' ? { model: 'gpt-6.1-sol' } : {}),
          };
          expect(adapterKindFor(routeOf(config)), `mode=${mode} provider=${provider} key=${key ?? 'absent'}`).toBe(
            constructedKind(config),
          );
        }
      }
    }
  });

  it('names the demo brain for a KEYED provider with no key — the silent fall-through', () => {
    // THE trap this task exists for: byok + anthropic chosen, key deleted or never
    // saved ⇒ the mock adapter answers. The derivation must say so. The route input
    // carries key PRESENCE only (a type fact — the derivation can never see a value).
    expect(adapterKindFor({ mode: 'byok', provider: 'anthropic', hasKey: false })).toBe('demo');
    expect(adapterKindFor({ mode: 'byok', provider: 'openai', hasKey: false })).toBe('demo');
  });

  it('names the real provider when its key is present', () => {
    expect(adapterKindFor({ mode: 'byok', provider: 'anthropic', hasKey: true })).toBe('anthropic');
    expect(adapterKindFor({ mode: 'byok', provider: 'openai', hasKey: true })).toBe('openai');
  });

  it('mode outranks provider: local and webllm ignore provider and key entirely', () => {
    expect(adapterKindFor({ mode: 'local', provider: 'anthropic', hasKey: true })).toBe('local');
    expect(adapterKindFor({ mode: 'webllm', provider: 'mock', hasKey: false })).toBe('webllm');
  });

  it('the mock provider is the demo brain even if a stray key rides the config', () => {
    expect(adapterKindFor({ mode: 'byok', provider: 'mock', hasKey: true })).toBe('demo');
  });

  it('routeOf is the ONE config→route mapping: presence, never the value', () => {
    expect(routeOf({ mode: 'byok', provider: 'anthropic', key: 'sk-a' })).toEqual({
      mode: 'byok',
      provider: 'anthropic',
      hasKey: true,
    });
    expect(routeOf({ mode: 'byok', provider: 'anthropic' })).toEqual({
      mode: 'byok',
      provider: 'anthropic',
      hasKey: false,
    });
  });

  it('ADAPTER_KINDS is the single-homed kind vocabulary the meta reader validates against', () => {
    // 'host' joined 2026-09-05 (TASK-20260905-host-kit P2): the platform-pinned host brain.
    // 'chatgpt' joined 2026-10-23 (TASK-20261023-siwc-chatgpt-plan L4-1): the user's ChatGPT plan.
    expect(ADAPTER_KINDS).toEqual(['webllm', 'local', 'anthropic', 'openai', 'demo', 'host', 'chatgpt']);
  });

  it("mode 'host' outranks provider and key entirely — the platform pin is named first", () => {
    expect(adapterKindFor({ mode: 'host', provider: 'anthropic', hasKey: true })).toBe('host');
    expect(adapterKindFor({ mode: 'host', provider: 'mock', hasKey: false })).toBe('host');
  });

  it("a 'host' adapter with NO platform-pinned brain answers a NAMED error result — still never a silent reroute, no longer a throw", async () => {
    // MIGRATED 2026-10-03 (TASK-20261003 D4) from "…throws — loud on drift". The seat used
    // to be a value set once; on the local runner it is a getter that answers `demo` while
    // the user's CLI is known not ready, so "the derivation and the seat disagree" is now an
    // ordinary moment (the brain went away between routing a turn and building its adapter),
    // and a throw there was a crashed turn. What is kept: the turn is NOT rerouted to
    // another brain — it fails by name, retryably. brainFollowsRevision.test.tsx drives the
    // flip itself; the pinned path is proven end-to-end in hostBrain.test.ts.
    const result = await createTurnAdapter({ mode: 'host', provider: 'mock' }, 'chat').complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: HOST_BRAIN_GONE_CODE, retryable: true });
  });

  // TASK-20261023-siwc-chatgpt-plan Gate 3, L4 (§11 L4-1, L4-2; ADR-0078 §5): the plan is the
  // user's explicit choice, so key presence is irrelevant and a missing session is a NAMED result
  // from the adapter — never the demo brain, a key or a local model standing in.
  it("mode 'chatgpt' names the plan for every provider and key presence — the arm sits before every provider/key check", () => {
    for (const provider of ['mock', 'anthropic', 'openai'] as const) {
      for (const hasKey of [true, false]) {
        expect(adapterKindFor({ mode: 'chatgpt', provider, hasKey }), `provider=${provider} hasKey=${String(hasKey)}`).toBe('chatgpt');
      }
    }
    expect(constructedKind({ mode: 'chatgpt', provider: 'openai', key: 'sk-test', model: 'gpt-6.1-sol' })).toBe('chatgpt');
    expect(constructedKind({ mode: 'chatgpt', provider: 'mock', model: 'gpt-6.1-sol' })).toBe('chatgpt');
  });

  it("a 'chatgpt' adapter with NO model anywhere answers a named HOST_ERROR result — never a throw, never another adapter", async () => {
    const adapter = createTurnAdapter({ mode: 'chatgpt', provider: 'openai', key: 'sk-test' }, 'app') as { __kind?: string; complete: (r: unknown) => Promise<unknown> };
    expect(adapter.__kind).toBeUndefined();
    const result = await adapter.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }] });
    expect(result).toMatchObject({ ok: false, code: 'HOST_ERROR' });
    expect((result as { message?: string }).message ?? '').toContain('no ChatGPT model is chosen');
  });
});
