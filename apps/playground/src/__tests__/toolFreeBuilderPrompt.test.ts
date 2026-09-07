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
import { APP_BUILDER_TOOL_NAME, SYSTEM_BLOCK_SEPARATOR, buildHostSystemPrompt } from '@snugprotocol/knowledge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformBrain, SnugPlatform } from '../platform/platform.js';
import { hostPlatform as hostFixture } from './fixtures/hostPlatform.js';
import { locateWasm } from './userdbTestHelper.js';

const HOST_LABEL = 'Claude · this artifact’s viewer';
/** The prose forms an EDIT turn's context block used to carry (appContext.ts) — the wire names are pinned in the knowledge package. */
const CONTEXT_TOOL_PHRASES = ['artifact write tool', 'schema tool', APP_BUILDER_TOOL_NAME];

interface Graph {
  platform: typeof import('../platform/platform.js');
  mode: typeof import('../state/mode.js');
  webllm: typeof import('../state/webllm.js');
  engine: typeof import('../agent/webllm/engine.js');
  appHtml: typeof import('../agent/webllm/appHtml.js');
  appContext: typeof import('../agent/appContext.js');
  budget: typeof import('../agent/promptBudget.js');
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
    appContext: await import('../agent/appContext.js'),
    budget: await import('../agent/promptBudget.js'),
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
    // Exactly the assembly the knowledge package produces for this arm + the suffix — the
    // assembly's CONTENT (template, hooks, persistence rule, no tool name) is pinned once,
    // in the knowledge package's tool-free-assembly.test.ts; this pins the call site.
    expect(fake.calls[0]!.system).toBe(
      `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host', knowledge: 'inline' })}${SYSTEM_BLOCK_SEPARATOR}${g.appHtml.WEBLLM_BUILD_SUFFIX}`,
    );
  });

  it('an EDIT turn under the host brain carries the app context with NO tool sentence (Gate-5 fold: the context block cited the artifact write tool)', async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: false, tools: false })),
    );
    const db = await g.userdb.installTestUserDb();
    const { appId } = db.installApp({ displayName: 'Counter', usesDb: false, html: '<!doctype html><html><body>counter</body></html>' });
    const { contextBlock } = await g.appContext.buildAppTurnContext(db, appId, 'thread-1', g.budget.HOST_CONTEXT_CAPS, { toolFree: true });
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    await agent.send({ message: 'make the button blue', contextBlock }, {}, new AbortController().signal);
    expect(fake.calls).toHaveLength(1);
    const system = fake.calls[0]!.system;
    expect(system).toContain('### Current app code');
    expect(system).toContain('reply with the ENTIRE updated file as one complete HTML document');
    for (const phrase of CONTEXT_TOOL_PHRASES) expect(system, phrase).not.toContain(phrase);
    // The tooled wording is what the same block says for a brain that has the tools.
    const tooled = await g.appContext.buildAppTurnContext(db, appId, 'thread-1');
    expect(tooled.contextBlock).toContain('artifact write tool');
    expect(tooled.contextBlock).toContain('schema tool');
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
      `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'web', knowledge: 'none' })}${SYSTEM_BLOCK_SEPARATOR}${g.appHtml.WEBLLM_BUILD_SUFFIX}`,
    );
    g.engine.setWebllmEngineLoaderForTests(undefined);
    g.engine.resetWebllmEngineForTests();
  });

  it('a tool-less host brain whose declared cap cannot hold the core gets the unaided layer, not a first build refused before any call', async () => {
    const fake = fakeAdapter();
    const g = await fresh((p) =>
      p.setPlatform(
        hostPlatform({ kind: 'host', label: HOST_LABEL, adapter: fake.adapter, streaming: false, tools: false, maxPromptBytes: 32_768, promptBytes: (system, messages) => system.length + messages.reduce((n, m) => n + m.content.length, 0) }),
      ),
    );
    const agent = g.builder.createDirectBuilder({ mode: 'host', provider: 'mock', sink: fakeSink });
    const result = await agent.send('build me a tiny app', {}, new AbortController().signal);
    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.system).toBe(
      `${buildHostSystemPrompt({ appBuilder: true, artifacts: false, platform: 'host', knowledge: 'none' })}${SYSTEM_BLOCK_SEPARATOR}${g.appHtml.WEBLLM_BUILD_SUFFIX}`,
    );
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
