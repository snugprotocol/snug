// AL-07 AC2/AC3 at the LAST call site: useBuilderChat's agent selection. The
// playground has two turn entry points (builder chat + app-frame transport); the
// transport factory is covered in webllmWiring.test.ts — this file proves the builder
// HOOK consults the brain too, in both directions (webllm engine answers; demo
// fallback answers with subscription mode configured and the server untouched).
// Lessons 2026-08-05: an unwired call site is exactly the bug class this catches.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import {
  resetWebllmEngineForTests,
  setWebllmEngineLoaderForTests,
  type WebllmChunk,
  type WebllmEngineLike,
} from '../agent/webllm/engine.js';
import { modeStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function scriptedEngine(reply: string): WebllmEngineLike {
  return {
    chat: {
      completions: {
        create() {
          async function* generate(): AsyncGenerator<WebllmChunk> {
            yield { model: 'loaded-model', choices: [{ delta: { content: reply }, finish_reason: null }] };
            yield { model: 'loaded-model', choices: [{ delta: {}, finish_reason: 'stop' }] };
          }
          return Promise.resolve(generate());
        },
      },
    },
  };
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat('thr-webllm-test');
    return <span />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return {
    chat: () => {
      if (holder.current === null) throw new Error('hook not rendered');
      return holder.current;
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  setWebllmEngineLoaderForTests(undefined);
  resetWebllmEngineForTests();
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  vi.restoreAllMocks();
});

describe('useBuilderChat consults the webllm brain (AC2/AC3)', () => {
  it('flag on + WebGPU: the builder turn is answered by the webllm engine', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('yes');
    setWebllmEngineLoaderForTests(() => Promise.resolve(scriptedEngine('the local model says hi')));
    const r = renderChat();
    act(() => {
      r.chat().send('build me a timer');
    });
    await settle();
    await settle();
    const agentMessage = r.chat().messages.find((m) => m.role === 'agent');
    expect(agentMessage?.displayText).toBe('the local model says hi');
    expect(agentMessage?.error).toBeUndefined();
  });

  it('flag on + NO WebGPU while subscription mode is configured: the demo brain answers, the server is never called', async () => {
    webllmFlagStore.set(true);
    webgpuStore.set('no');
    modeStore.set('subscription');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('server must not be reached'));
    const loader = vi.fn();
    setWebllmEngineLoaderForTests(loader);
    const r = renderChat();
    act(() => {
      r.chat().send('build me a timer');
    });
    await settle();
    await settle();
    const agentMessage = r.chat().messages.find((m) => m.role === 'agent');
    // The demo chat script's first turn streams its KB-consult line; any non-error
    // agent text here proves the DEMO brain answered (the server mock would throw).
    expect(agentMessage?.error).toBeUndefined();
    expect(agentMessage?.displayText ?? '').not.toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });
});
