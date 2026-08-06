// adapter.ts — browser-direct adapter selection (ADR-0008). BYOK keys come from the
// user DB's snug_secrets (mode.ts) and go DIRECTLY to the provider from the page —
// never through the hub server. Local mode targets an OpenAI-compatible localhost
// endpoint. No key / mock provider? The demo brain is always available.

import {
  anthropicAdapter,
  localAdapter,
  mockAdapter,
  openaiAdapter,
  type AgentAdapter,
  type MockTurn,
} from '@snugprotocol/adapters';

import type { ByokProvider, PlaygroundMode } from '../state/mode.js';
import { demoAuthChatScript, demoAuthVariant } from './demoAuth.js';
import { DEMO_APP_HTML, DEMO_APP_REPLY, DEMO_APP_TITLE } from './demoApp.js';
import { ARTIFACT_WRITE_TOOL_NAME } from './tools.js';
import { webllmAdapter } from './webllm/webllmAdapter.js';
import { APP_BUILDER_TOOL_NAME } from '@snugprotocol/knowledge';

export type ByokPurpose = 'chat' | 'app';

/**
 * `'webllm'` is a DIRECT mode here but NOT a `PlaygroundMode`: it is reachable only
 * through the experimental `?webllm=1` brain override (state/webllm.ts) and must not
 * join the persisted mode union until GA (AL-07).
 */
export type DirectMode = Exclude<PlaygroundMode, 'subscription'> | 'webllm';

export interface TurnAdapterConfig {
  mode: DirectMode;
  provider: ByokProvider;
  key?: string;
  model?: string;
  localUrl?: string;
}

/** The demo brain's chat script: consult the KB, write the artifact, sign off. */
function demoChatScript(): MockTurn[] {
  // AL-04 e2e seam (`?demoauth=<variant>`, the ?webllm=1 URL-flag precedent):
  // a deterministic auth-directive script; zero footprint when the flag is absent.
  const authVariant = demoAuthVariant();
  if (authVariant !== null) return demoAuthChatScript(authVariant);
  return [
    {
      deltas: ['let me check the app template first…'],
      text: 'let me check the app template first…',
      toolCalls: [{ name: APP_BUILDER_TOOL_NAME, input: { query: 'mandatory html template bridge hooks' } }],
    },
    {
      deltas: ['\n\nwriting your app now.'],
      text: '\n\nwriting your app now.',
      toolCalls: [{ name: ARTIFACT_WRITE_TOOL_NAME, input: { content: DEMO_APP_HTML, title: DEMO_APP_TITLE } }],
    },
    {
      deltas: ['\n\ndone — I built you a tiny oracle. run it and ask it something.'],
      text: '\n\ndone — I built you a tiny oracle. run it and ask it something.',
    },
  ];
}

/** The demo brain's app-mode script: one JSON-only reply per request. */
function demoAppScript(): MockTurn[] {
  return [{ deltas: [DEMO_APP_REPLY], text: DEMO_APP_REPLY }];
}

/**
 * A FRESH adapter per turn (the mock adapter consumes its script sequentially).
 * local mode ignores provider/key; byok needs a key for anthropic/openai.
 */
export function createTurnAdapter(config: TurnAdapterConfig, purpose: ByokPurpose): AgentAdapter {
  if (config.mode === 'webllm') {
    // The shared `model` setting holds byok/local wire ids (e.g. "llama3.2") — a
    // different namespace from web-llm prebuilt ids, so it is deliberately IGNORED:
    // the spike always loads the ADR-0015 default; the model picker is GA scope.
    return webllmAdapter();
  }
  if (config.mode === 'local') {
    return localAdapter({
      ...(config.localUrl !== undefined ? { baseUrl: config.localUrl } : {}),
      ...(config.model !== undefined ? { model: config.model } : {}),
    });
  }
  if (config.provider === 'anthropic' && config.key !== undefined) {
    return anthropicAdapter({ apiKey: config.key, ...(config.model !== undefined ? { model: config.model } : {}) });
  }
  if (config.provider === 'openai' && config.key !== undefined) {
    return openaiAdapter({ apiKey: config.key, ...(config.model !== undefined ? { model: config.model } : {}) });
  }
  return mockAdapter(purpose === 'chat' ? demoChatScript() : demoAppScript());
}
