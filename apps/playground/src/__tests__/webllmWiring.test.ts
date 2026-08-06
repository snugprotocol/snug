// AL-07 AC2/AC3/AC6: the webllm brain WIRED through the real consumers — the
// fenced-HTML extractor, the direct builder's webllm branch, and the app-frame
// transport factory that reads the brain stores. The engine is faked through the
// loader seam; the demo fallback is proven by the demo script ANSWERING (not by a
// flag flip nothing reads — lessons 2026-08-05).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDirectBuilder, type BuilderAgent } from '../agent/builder.js';
import { createAppTransport } from '../agent/transport.js';
import {
  resetWebllmEngineForTests,
  setWebllmEngineLoaderForTests,
  type WebllmChatRequest,
  type WebllmChunk,
  type WebllmEngineLike,
} from '../agent/webllm/engine.js';
import { extractAppHtml, WEBLLM_BUILD_SUFFIX } from '../agent/webllm/appHtml.js';
import { WEBLLM_DEFAULT_MODEL } from '../agent/webllm/model.js';
import type { ArtifactSink, ArtifactWriteResult } from '../agent/artifactSink.js';
import { DEMO_APP_REPLY } from '../agent/demoApp.js';
import { modeStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP_HTML = '<!doctype html>\n<html><head><title>Tiny Timer</title></head><body>app</body></html>';

function scriptedEngine(reply: string): { engine: WebllmEngineLike; requests: WebllmChatRequest[] } {
  const requests: WebllmChatRequest[] = [];
  const engine: WebllmEngineLike = {
    chat: {
      completions: {
        create(request) {
          requests.push(request);
          async function* generate(): AsyncGenerator<WebllmChunk> {
            yield { model: WEBLLM_DEFAULT_MODEL, choices: [{ delta: { content: reply }, finish_reason: null }] };
            yield { model: WEBLLM_DEFAULT_MODEL, choices: [{ delta: {}, finish_reason: 'stop' }] };
          }
          return Promise.resolve(generate());
        },
      },
    },
  };
  return { engine, requests };
}

function recordingSink(): { sink: ArtifactSink; writes: { html: string; title?: string }[] } {
  const writes: { html: string; title?: string }[] = [];
  const sink: ArtifactSink = {
    write(html, title) {
      writes.push({ html, ...(title !== undefined ? { title } : {}) });
      const result: ArtifactWriteResult = { id: 'app-webllm-test', displayName: title ?? 'your app', version: 1 };
      return Promise.resolve(result);
    },
    ensureTargetId: () => Promise.resolve('app-webllm-test'),
  };
  return { sink, writes };
}

async function sendTurn(agent: BuilderAgent, message: string): ReturnType<BuilderAgent['send']> {
  return agent.send(message, {}, new AbortController().signal);
}

beforeEach(async () => {
  resetWebllmEngineForTests();
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  modeStore.set('byok');
  providerStore.set('mock');
  await installTestUserDb();
});

afterEach(() => {
  setWebllmEngineLoaderForTests(undefined);
  resetWebllmEngineForTests();
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  vi.restoreAllMocks();
});

describe('extractAppHtml (AC6 — the fenced-HTML envelope)', () => {
  it('extracts a complete document from an ```html fence, with its <title>', () => {
    const text = `here is your app:\n\n\`\`\`html\n${APP_HTML}\n\`\`\`\n\nenjoy!`;
    expect(extractAppHtml(text)).toEqual({ html: APP_HTML, title: 'Tiny Timer' });
  });

  it('takes the LAST complete document when the reply contains several fences', () => {
    const first = '<!doctype html><html><head><title>Old</title></head><body>1</body></html>';
    const text = `\`\`\`html\n${first}\n\`\`\`\nrevised:\n\`\`\`html\n${APP_HTML}\n\`\`\``;
    expect(extractAppHtml(text)?.title).toBe('Tiny Timer');
  });

  it('accepts a bare (unfenced) document — small models forget fences', () => {
    const text = `Sure! ${APP_HTML}`;
    expect(extractAppHtml(text)).toEqual({ html: APP_HTML, title: 'Tiny Timer' });
  });

  it('falls back to the default title when the document has none', () => {
    const html = '<!doctype html><html><body>no title</body></html>';
    expect(extractAppHtml(`\`\`\`html\n${html}\n\`\`\``)).toEqual({ html, title: 'your app' });
  });

  it('returns undefined for prose, snippets, and incomplete documents', () => {
    expect(extractAppHtml('just chatting, no app here')).toBeUndefined();
    expect(extractAppHtml('```html\n<button>snippet</button>\n```')).toBeUndefined();
    expect(extractAppHtml('<!doctype html><html><body>never closed')).toBeUndefined();
  });
});

describe('createDirectBuilder in webllm mode (AC6)', () => {
  it('offers NO tools, appends the fenced-HTML instruction, and loads the DEFAULT model even when a model is configured', async () => {
    const { engine, requests } = scriptedEngine('no app this turn.');
    const loader = vi.fn(() => Promise.resolve(engine));
    setWebllmEngineLoaderForTests(loader);
    const { sink } = recordingSink();
    const agent = createDirectBuilder({
      mode: 'webllm',
      provider: 'mock',
      sink,
      // The shared model setting belongs to byok/local wire ids — webllm must ignore it.
      model: 'llama3.2',
      needsConfirm: () => false,
    });
    const result = await sendTurn(agent, 'build me a timer');
    expect(result.ok).toBe(true);
    expect(loader).toHaveBeenCalledWith(WEBLLM_DEFAULT_MODEL, expect.any(Function));
    expect(requests).toHaveLength(1);
    const system = requests[0]?.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content).toContain(WEBLLM_BUILD_SUFFIX);
    // No tool plumbing anywhere in the request: the engine API would throw on `tools`.
    expect(requests[0]).not.toHaveProperty('tools');
  });

  it('a reply containing a complete single-file app lands in the sink and fires onArtifact', async () => {
    const { engine } = scriptedEngine(`writing your app now.\n\`\`\`html\n${APP_HTML}\n\`\`\`\ndone!`);
    setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
    const { sink, writes } = recordingSink();
    const artifacts: { artifactId: string; displayName: string; version?: number }[] = [];
    const agent = createDirectBuilder({ mode: 'webllm', provider: 'mock', sink, needsConfirm: () => false });
    const result = await agent.send(
      'build me a timer',
      { onArtifact: (artifact) => artifacts.push(artifact) },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(writes).toEqual([{ html: APP_HTML, title: 'Tiny Timer' }]);
    expect(artifacts).toEqual([{ artifactId: 'app-webllm-test', displayName: 'Tiny Timer', version: 1 }]);
  });

  it('a plain chat reply writes NO artifact', async () => {
    const { engine } = scriptedEngine('a timer counts down. want me to build one?');
    setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
    const { sink, writes } = recordingSink();
    const agent = createDirectBuilder({ mode: 'webllm', provider: 'mock', sink, needsConfirm: () => false });
    const result = await sendTurn(agent, 'what is a timer?');
    expect(result.ok).toBe(true);
    expect(writes).toHaveLength(0);
  });

  it('F15 confirm-guard still gates webllm turns (a synced file remains executable config)', async () => {
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const { sink } = recordingSink();
    const agent = createDirectBuilder({ mode: 'webllm', provider: 'mock', sink, needsConfirm: () => true });
    const result = await sendTurn(agent, 'build me a timer');
    expect(result).toMatchObject({ ok: false, code: 'CONSENT_REQUIRED' });
    expect(loader).not.toHaveBeenCalled();
  });
});

describe('createAppTransport reads the brain (AC2/AC3 at the factory that decides)', () => {
  it('flag on + WebGPU ⇒ the app-frame turn reaches the webllm engine', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    const { engine, requests } = scriptedEngine('{"message":"from the local model"}');
    setWebllmEngineLoaderForTests(() => Promise.resolve(engine));
    const transport = createAppTransport('byok', 'anthropic');
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });
    expect(result).toMatchObject({ ok: true, text: '{"message":"from the local model"}' });
    expect(requests).toHaveLength(1);
  });

  it('flag on + NO WebGPU ⇒ the demo brain answers and the engine is never loaded (AC3)', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('no');
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const transport = createAppTransport('byok', 'anthropic');
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, text: DEMO_APP_REPLY });
    expect(loader).not.toHaveBeenCalled();
  });

  it('flag on overrides SUBSCRIPTION mode too — no server fetch happens', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('no');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('server must not be reached'));
    const transport = createAppTransport('subscription', 'mock');
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, text: DEMO_APP_REPLY });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flag OFF ⇒ settings decide exactly as before, and the engine loader is never touched (AC1)', async () => {
    webllmFlagStore.set(false);
    webgpuStore.set('yes'); // even with WebGPU present
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const transport = createAppTransport('byok', 'mock');
    const result = await transport.send('[SNUG_APP_REQUEST] {"snug":1}', { signal: new AbortController().signal });
    expect(result).toEqual({ ok: true, text: DEMO_APP_REPLY });
    expect(loader).not.toHaveBeenCalled();
  });
});
