// adapter.ts — adapter selection from config. The mock adapter ships a small scripted
// demo flow (offline dev/demo + smoke test): one artifact write, then a closing reply.

import {
  anthropicAdapter,
  mockAdapter,
  openaiAdapter,
  type AgentAdapter,
  type MockTurn,
} from '@snugprotocol/adapters';

import type { ServerConfig } from './config.js';
import { ARTIFACT_WRITE_TOOL_NAME, artifactUrl } from './tools.js';

/** Tiny canned app (content, not prompt text — safe outside the knowledge store). */
export const DEMO_APP_HTML = [
  '<!doctype html><html><head><title>Snug Demo Counter</title></head><body>',
  '<button id="b">clicks: 0</button>',
  '<script>let n=0;const b=document.getElementById("b");b.onclick=()=>{b.textContent="clicks: "+ ++n};</script>',
  '</body></html>',
].join('');

export function demoMockScript(): MockTurn[] {
  return [
    {
      deltas: ['Building', ' a demo app…'],
      text: 'Building a demo app…',
      toolCalls: [{ name: ARTIFACT_WRITE_TOOL_NAME, input: { content: DEMO_APP_HTML, title: 'Snug Demo Counter' } }],
    },
    {
      deltas: [' Done — your demo app is ready at ', artifactUrl('(see artifact event)'), '.'],
      text: ` Done — your demo app is ready at ${artifactUrl('(see artifact event)')}.`,
    },
  ];
}

export function createAdapterFromConfig(config: ServerConfig): AgentAdapter {
  switch (config.adapter) {
    case 'anthropic':
      return anthropicAdapter({ apiKey: config.anthropicApiKey ?? '', model: config.model });
    case 'openai':
      return openaiAdapter({ apiKey: config.openaiApiKey ?? '', model: config.model });
    case 'mock':
      return mockAdapter(demoMockScript());
  }
}
