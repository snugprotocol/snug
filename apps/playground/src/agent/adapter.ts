// adapter.ts — BYOK adapter selection. The key comes from sessionStorage (mode.ts)
// and goes DIRECTLY to the provider from the browser — never through the reference
// server (task AC-5). No key? The demo brain (mock adapter) is always available.

import {
  anthropicAdapter,
  mockAdapter,
  openaiAdapter,
  type AgentAdapter,
  type MockTurn,
} from '@snugprotocol/adapters';

import type { ByokProvider } from '../state/mode.js';
import { DEMO_APP_HTML, DEMO_APP_REPLY, DEMO_APP_TITLE } from './demoApp.js';
import { ARTIFACT_WRITE_TOOL_NAME } from './tools.js';
import { APP_BUILDER_TOOL_NAME } from '@snugprotocol/knowledge';

export type ByokPurpose = 'chat' | 'app';

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
 * `key` is required for anthropic/openai; mock ignores it.
 */
export function createByokAdapter(provider: ByokProvider, key: string | undefined, purpose: ByokPurpose): AgentAdapter {
  if (provider === 'anthropic' && key !== undefined) return anthropicAdapter({ apiKey: key });
  if (provider === 'openai' && key !== undefined) return openaiAdapter({ apiKey: key });
  return mockAdapter(purpose === 'chat' ? demoChatScript() : demoAppScript());
}
