// transport.ts — the Run view's AgentTransport, identical interface in both modes so
// the Run view code never branches:
//   server → createHttpTransport('/invoke') (SSE; the reference server owns the LLM)
//   byok   → runAgentTurn in-browser (JSON-only mode — the wire envelope goes straight
//            to the selected provider with the sessionStorage key; mock needs no key)

import { createHttpTransport } from '@snugprotocol/adapters';
import { runAgentTurn } from '@snugprotocol/adapters';
import { buildHostSystemPrompt } from '@snugprotocol/knowledge';
import type { AgentTransport } from '@snugprotocol/runner';

import { getByokKey, type ByokProvider, type PlaygroundMode } from '../state/mode.js';
import { createByokAdapter } from './adapter.js';

export function createServerAppTransport(): AgentTransport {
  // App-path requests are self-contained envelopes — no threadId, no history.
  return createHttpTransport('/invoke');
}

export interface ByokTransportOptions {
  provider: ByokProvider;
  /** Injectable for tests; defaults to the sessionStorage-backed key. */
  getKey?: () => string | undefined;
}

export function createByokAppTransport(options: ByokTransportOptions): AgentTransport {
  const readKey = options.getKey ?? getByokKey;
  // Mirrors the server's app path: app-builder KB summary in, artifact tools out.
  const system = buildHostSystemPrompt({ appBuilder: true, artifacts: false });
  return {
    async send(wire, { signal, onDelta }) {
      const adapter = createByokAdapter(options.provider, readKey(), 'app');
      const result = await runAgentTurn({
        adapter,
        system,
        messages: [{ role: 'user', content: wire }],
        signal,
        ...(onDelta !== undefined ? { onDelta } : {}),
      });
      return result.ok
        ? { ok: true, text: result.text }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}

export function createAppTransport(mode: PlaygroundMode, provider: ByokProvider): AgentTransport {
  return mode === 'server' ? createServerAppTransport() : createByokAppTransport({ provider });
}
