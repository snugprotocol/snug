// Platform fetch at the LLM choke point (TASK-20260812 W2a; P0 amendment 8).
// `createTurnAdapter` is the ONE construction site every turn goes through, so sourcing
// its default fetch from the platform covers all five call sites with zero edits — and
// `config.fetch` stays a test override that wins over the platform.
//
// The adapters are MOCKED to record their construction options: what is under test is
// the THREADING (which fetch reaches the adapter), not the adapters' own use of it —
// each adapter's `fetch ?? globalThis.fetch` fallback is pinned in packages/adapters.
import { describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

const created = vi.hoisted(() => [] as Array<{ adapter: string; options: Record<string, unknown> }>);

vi.mock('@snugprotocol/adapters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snugprotocol/adapters')>();
  const record =
    (adapter: string) =>
    (options: Record<string, unknown> = {}) => {
      created.push({ adapter, options });
      return { run: async () => Promise.reject(new Error('not runnable in this test')) };
    };
  return {
    ...actual,
    localAdapter: record('local'),
    anthropicAdapter: record('anthropic'),
    openaiAdapter: record('openai'),
  };
});

async function fresh(platform?: SnugPlatform): Promise<typeof import('../agent/adapter.js')> {
  vi.resetModules();
  created.length = 0;
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  return import('../agent/adapter.js');
}

const platformFetch = async (): Promise<Response> => new Response('platform');

function desktopPlatform(): SnugPlatform {
  return {
    kind: 'desktop',
    fetchImpl: platformFetch,
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

describe('createTurnAdapter — platform fetch reaches every provider adapter', () => {
  it('local mode receives the platform fetch', async () => {
    const { createTurnAdapter } = await fresh(desktopPlatform());
    createTurnAdapter({ mode: 'local', provider: 'mock', localUrl: 'http://127.0.0.1:11434/v1' }, 'chat');
    expect(created).toHaveLength(1);
    expect(created[0]!.adapter).toBe('local');
    expect(created[0]!.options['fetch']).toBe(platformFetch);
  });

  it('anthropic byok receives the platform fetch', async () => {
    const { createTurnAdapter } = await fresh(desktopPlatform());
    createTurnAdapter({ mode: 'byok', provider: 'anthropic', key: 'k1' }, 'chat');
    expect(created[0]!.adapter).toBe('anthropic');
    expect(created[0]!.options['fetch']).toBe(platformFetch);
  });

  it('openai byok receives the platform fetch', async () => {
    const { createTurnAdapter } = await fresh(desktopPlatform());
    createTurnAdapter({ mode: 'byok', provider: 'openai', key: 'k1' }, 'chat');
    expect(created[0]!.adapter).toBe('openai');
    expect(created[0]!.options['fetch']).toBe(platformFetch);
  });

  it('config.fetch (the test override) wins over the platform fetch', async () => {
    const { createTurnAdapter } = await fresh(desktopPlatform());
    const override = async (): Promise<Response> => new Response('override');
    createTurnAdapter({ mode: 'local', provider: 'mock', fetch: override }, 'chat');
    expect(created[0]!.options['fetch']).toBe(override);
  });

  it('web default unchanged: no platform → NO fetch option, the adapters keep their own default (AC10)', async () => {
    const { createTurnAdapter } = await fresh();
    createTurnAdapter({ mode: 'byok', provider: 'anthropic', key: 'k1' }, 'chat');
    expect(created[0]!.options['fetch']).toBeUndefined();
  });
});
