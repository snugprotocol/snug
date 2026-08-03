// transport.ts — the Run view's AgentTransport, identical interface in every mode so
// the Run view code never branches:
//   subscription → createHttpTransport('/invoke') (SSE; the hub server owns the LLM)
//   byok/local   → runAgentTurn in-browser (JSON-only mode — the wire envelope goes
//                  straight to the provider; keys from the user DB, mock needs none)
// F15 guard: after an import/first-pull, byok/local turns are refused until the user
// re-confirms endpoint settings — an imported DB is executable config.

import { createHttpTransport, runAgentTurn } from '@snugprotocol/adapters';
import { buildHostSystemPrompt } from '@snugprotocol/knowledge';
import { ERROR_CODES } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

import {
  endpointsNeedConfirmStore,
  getByokKey,
  localUrlStore,
  modelStore,
  providerStore,
  type ByokProvider,
  type PlaygroundMode,
} from '../state/mode.js';
import { createTurnAdapter } from './adapter.js';

export function createServerAppTransport(model?: string): AgentTransport {
  // App-path requests are self-contained envelopes — no threadId, no history.
  return createHttpTransport('/invoke', model !== undefined ? { model } : {});
}

export interface DirectTransportOptions {
  mode: Exclude<PlaygroundMode, 'subscription'>;
  provider: ByokProvider;
  /** Injectable for tests; default reads the user DB secret for the provider. */
  getKey?: (provider: ByokProvider) => Promise<string | undefined>;
  model?: string;
  localUrl?: string;
  /** Injectable for tests; default reads the F15 confirm-guard store. */
  needsConfirm?: () => boolean;
}

export function createDirectAppTransport(options: DirectTransportOptions): AgentTransport {
  const readKey = options.getKey ?? getByokKey;
  const needsConfirm = options.needsConfirm ?? ((): boolean => endpointsNeedConfirmStore.get());
  // Mirrors the server's app path: app-builder KB summary in, artifact tools out.
  const system = buildHostSystemPrompt({ appBuilder: true, artifacts: false });
  return {
    async send(wire, { signal, onDelta }) {
      if (needsConfirm()) {
        return {
          ok: false,
          code: ERROR_CODES.CONSENT_REQUIRED,
          message: 'endpoint settings came from an imported or synced file — confirm them in Settings before running',
          retryable: false,
        };
      }
      const key = options.mode === 'local' ? undefined : await readKey(options.provider);
      const adapter = createTurnAdapter(
        {
          mode: options.mode,
          provider: options.provider,
          ...(key !== undefined ? { key } : {}),
          ...(options.model !== undefined ? { model: options.model } : {}),
          ...(options.localUrl !== undefined ? { localUrl: options.localUrl } : {}),
        },
        'app',
      );
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

/** The active transport for the current settings (stores read at creation time). */
export function createAppTransport(mode: PlaygroundMode, provider: ByokProvider): AgentTransport {
  const model = modelStore.get();
  if (mode === 'subscription') return createServerAppTransport(model);
  return createDirectAppTransport({
    mode,
    provider,
    ...(model !== undefined ? { model } : {}),
    localUrl: localUrlStore.get(),
  });
}
