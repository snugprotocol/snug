// toolFreeBuilderPrompt.test.ts — TASK-20260906-tool-free-kb-inlining AC4 (and AC2 at the
// call site): what the builder's tool-free arm ACTUALLY SENDS. The host tests already pin
// which adapter a purpose routes to; none read the prompt as the model would — and that is
// how a pinned host brain shipped a system prompt telling it to call `snug_app_builder`
// (T4's hosted walk, 2026-09-06). Three arms, one assembly:
//
//   host brain (tools: false)  → knowledge 'inline' — the five-file core rides in the prompt
//   webllm                     → knowledge 'none'   — 4,096-token window; the honest layer
//   tooled (byok/local/host+tools) → today's bytes, untouched
//
// Both tool-free arms keep WEBLLM_BUILD_SUFFIX (the artifact-write mechanism — it was
// never the knowledge-base consult). Fresh module graph per case (setPlatform is
// set-once) — the hostBrain.test.ts harness.
import type { AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';
import { createMemoryBackend } from '@snugprotocol/db';
import { APP_BUILDER_TOOL_NAME, APP_DOC_WRITE_TOOL_NAME, SCHEMA_APPLY_TOOL_NAME, buildHostSystemPrompt } from '@snugprotocol/knowledge';
import { FRAME_TYPES } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const HOST_LABEL = 'Claude · this artifact’s viewer';
const TOOL_NAMES = [APP_BUILDER_TOOL_NAME, SCHEMA_APPLY_TOOL_NAME, APP_DOC_WRITE_TOOL_NAME, 'artifact_write', 'artifact write tool'];

interface Graph {
  platform: typeof import('../platform/platform.js');
  mode: typeof import('../state/mode.js');
  webllm: typeof import('../state/webllm.js');
  engine: typeof import('../agent/webllm/engine.js');
  appHtml: typeof import('../agent/webllm/appHtml.js');
  builder: typeof import('../agent/builder.js');
  userdb: typeof import('./userdbTestHelper.js');
}

function fakeAdapter(): { adapter: AgentAdapter; calls: AdapterRequest[] } {
  const calls: AdapterRequest[] = [];
  return {
    calls,
    adapter: {
      complete: async (request) => {
        calls.push(request);
        return { ok: true, text: 'no app this turn.', toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

const hostPlatform = (brain: PlatformBrain): SnugPlatform => hostFixture({ brain, userdbBackend: createMemoryBackend() });

async function fresh(install?: (platform: Graph['platform']) => void): Promise<Graph> {
  vi.resetModules();
  vi.doMock('../run/wasm.js', () => ({ locateWasm }));
  const platform = await import('../platform/platform.js');
  install?.(platform);
  return {
    platform,
    mode: await import('../state/mode.js'),
    webllm: await import('../state/webllm.js'),
    engine: await import('../agent/webllm/engine.js'),
    appHtml: await import('../agent/webllm/appHtml.js'),
    builder: await import('../agent/builder.js'),
    userdb: await import('./userdbTestHelper.js'),
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

describe('AC4 — the tool-free arms carry knowledge the brain can actually use', () => {
  it("the pinned host brain builds on knowledge 'inline': the template, the hooks, the persistence rule — and no tool name", async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: false, tools: false })),
    );
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    await agent.send('build me a tiny app', {}, new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    const system = fake.calls[0]!.system;
    // Exactly the assembly the knowledge package produces for this arm + the suffix.
    expect(system).toBe(
      `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host', knowledge: 'inline' })}\n\n---\n\n${g.appHtml.WEBLLM_BUILD_SUFFIX}`,
    );
    expect(system).toContain('## Full Template');
    expect(system).toContain(FRAME_TYPES.announce);
    expect(system).toContain(FRAME_TYPES.appMessage);
    expect(system).toContain('## Storage Is Host-Brokered');
    for (const name of TOOL_NAMES) expect(system, name).not.toContain(name);
    expect(system).not.toMatch(/Never write an app from memory/);
  });

  it("webllm builds on knowledge 'none': the honest unaided layer + the fenced-HTML suffix, no tool name, no 37 KB core", async () => {
    const g = await fresh();
    await g.userdb.installTestUserDb();
    g.mode.modeStore.set('byok');
    g.mode.providerStore.set('mock');
    const requests: { messages: { role: string; content: string }[] }[] = [];
    g.engine.setWebllmEngineLoaderForTests(() =>
      Promise.resolve({
        chat: {
          completions: {
            create(request: { messages: { role: string; content: string }[] }) {
              requests.push(request);
              async function* generate(): AsyncGenerator<{ model: string; choices: { delta: { content?: string }; finish_reason: string | null }[] }> {
                yield { model: 'x', choices: [{ delta: { content: 'no app this turn.' }, finish_reason: null }] };
                yield { model: 'x', choices: [{ delta: {}, finish_reason: 'stop' }] };
              }
              return Promise.resolve(generate());
            },
          },
        },
      }),
    );
    const agent = g.builder.createDirectBuilder({ mode: 'webllm', provider: 'mock', sink: fakeSink, needsConfirm: () => false });
    const result = await agent.send('build me a timer', {}, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const system = requests[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toBe(
      `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'web', knowledge: 'none' })}\n\n---\n\n${g.appHtml.WEBLLM_BUILD_SUFFIX}`,
    );
    expect(system.content).not.toContain('## Full Template');
    for (const name of TOOL_NAMES) expect(system.content, name).not.toContain(name);
    expect(system.content).toMatch(/knowledge base/i);
    g.engine.setWebllmEngineLoaderForTests(undefined);
    g.engine.resetWebllmEngineForTests();
  });

  it('negative twin: a host brain WITH tools, and byok, still get the tooled assembly byte-for-byte', async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: true, tools: true })),
    );
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    await agent.send('build me a tiny app', {}, new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.system).toBe(buildHostSystemPrompt({ appBuilder: true, artifacts: true, platform: 'host' }));
    expect(fake.calls[0]!.system).toContain(APP_BUILDER_TOOL_NAME);
  });
});
