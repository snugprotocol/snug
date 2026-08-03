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
import { DEMO_APP_HTML, DEMO_APP_REPLY, DEMO_APP_TITLE } from './demoApp.js';
import { ARTIFACT_WRITE_TOOL_NAME } from './tools.js';
import { APP_BUILDER_TOOL_NAME } from '@snugprotocol/knowledge';

export type ByokPurpose = 'chat' | 'app';

export interface TurnAdapterConfig {
  mode: Exclude<PlaygroundMode, 'subscription'>;
  provider: ByokProvider;
  key?: string;
  model?: string;
  localUrl?: string;
}

/** The demo brain's chat script: consult the KB, write the artifact, sign off. */
function demoChatScript(): MockTurn[] {
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
