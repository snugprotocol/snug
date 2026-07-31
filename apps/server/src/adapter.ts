// adapter.ts — adapter selection from config. The mock adapter ships a small scripted
// demo flow (offline dev/demo + smoke test): one artifact write, then a closing reply.
// App-path turns (a RUNNING app's sendMessage) are answered separately with a JSON-only
// body so the demo never dead-ends in HOST_ERROR (Gate-5).

import {
  anthropicAdapter,
  mockAdapter,
  openaiAdapter,
  type AgentAdapter,
  type MockTurn,
} from '@snugprotocol/adapters';
import { parseAppRequest } from '@snugprotocol/protocol';

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

/** The JSON-only reply the demo brain gives a running app's agent request. */
export function demoAppPathReply(action: string): string {
  return JSON.stringify({
    message: 'the demo brain waves back — bring your own key for real play',
    echo: action,
  });
}

/**
 * The scripted mock consumes its turns strictly in order — but a RUNNING app's
 * sendMessage arrives at the same adapter as an app-request envelope. Answer those
 * with a valid JSON-only body (parseable by the runner) WITHOUT consuming the chat
 * script, so the offline demo can both build apps and answer them.
 */
function withDemoAppPath(chat: AgentAdapter): AgentAdapter {
  return {
    async complete(request) {
      const last = request.messages.at(-1);
      const parsed = last?.role === 'user' ? parseAppRequest(last.content) : undefined;
      if (parsed?.ok === true) {
        const text = demoAppPathReply(parsed.envelope.action);
        request.onDelta?.(text);
        return { ok: true, text, toolCalls: [], stopReason: 'end' };
      }
      return chat.complete(request);
    },
  };
}

export function createAdapterFromConfig(config: ServerConfig): AgentAdapter {
  switch (config.adapter) {
    case 'anthropic':
      return anthropicAdapter({ apiKey: config.anthropicApiKey ?? '', model: config.model });
    case 'openai':
      return openaiAdapter({ apiKey: config.openaiApiKey ?? '', model: config.model });
    case 'mock':
      return withDemoAppPath(mockAdapter(demoMockScript()));
  }
}
