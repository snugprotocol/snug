// transport.ts — the Run view's AgentTransport, identical interface in every mode so
// the Run view code never branches:
//   subscription → createHttpTransport('/invoke') (SSE; the hub server owns the LLM)
//   byok/local   → runAgentTurn in-browser (JSON-only mode — the wire envelope goes
//                  straight to the provider; keys from the user DB, mock needs none)
// F15 guard: after an import/first-pull, byok/local turns are refused until the user
// re-confirms endpoint settings — an imported DB is executable config.

import { createHttpTransport, runAgentTurn, type AgentTurnEvent } from '@snugprotocol/adapters';
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
import { currentBrain } from '../state/webllm.js';
import { createTurnAdapter, type DirectMode } from './adapter.js';

export function createServerAppTransport(model?: string): AgentTransport {
  // App-path requests are self-contained envelopes — no threadId, no history.
  return createHttpTransport('/invoke', model !== undefined ? { model } : {});
}

export interface DirectTransportOptions {
  mode: DirectMode;
  provider: ByokProvider;
  /** Injectable for tests; default reads the user DB secret for the provider. */
  getKey?: (provider: ByokProvider) => Promise<string | undefined>;
  model?: string;
  localUrl?: string;
  /** Injectable for tests; default reads the F15 confirm-guard store. */
  needsConfirm?: () => boolean;
  /**
   * One completed LLM round trip for the in-app turn — the SECOND feed into the LLM
   * inspector, alongside the builder's (`agent/builder.ts`).
   *
   * Owner-reported bug (BYOK + a Chess move): the frame inspector populated but the
   * LLM surface stayed empty. There are two `runAgentTurn` call sites in the
   * playground and only the builder's was ever wired, so every turn an APP made —
   * which is what a Chess move is — was invisible. Direct mode only: subscription
   * round trips happen on the hub and are never serialized to the client.
   */
  onLlmEvent?: (event: AgentTurnEvent) => void;
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
      // local talks to an unauthenticated endpoint; webllm runs IN the page — neither
      // reads a provider key (webllm must not touch snug_secrets at all).
      const key = options.mode === 'local' || options.mode === 'webllm' ? undefined : await readKey(options.provider);
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
        // The app-frame LLM feed. Every event is forwarded — an app turn offers no
        // tools, so in practice this is the start/complete pair, which is exactly what
        // makes the call visible WHILE it runs rather than only after (AC8).
        // Forwarding nothing at all was the original bug.
        ...(options.onLlmEvent !== undefined ? { onEvent: options.onLlmEvent } : {}),
      });
      return result.ok
        ? { ok: true, text: result.text }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}

/**
 * The active transport for the current settings (stores read at creation time).
 *
 * `onLlmEvent` is threaded through so the Run view's LLM surface sees the turns an
 * APP makes, not just the ones the builder chat makes — the owner-reported gap where
 * a Chess move populated the frame inspector and nothing else. Subscription mode
 * ignores it: those round trips never leave the hub.
 */
export function createAppTransport(
  mode: PlaygroundMode,
  provider: ByokProvider,
  onLlmEvent?: (event: AgentTurnEvent) => void,
): AgentTransport {
  // AL-07: the experimental webllm brain OVERRIDES the configured mode entirely —
  // including subscription. `'webllm'` runs the in-page engine; `'demo'` is the
  // graceful no-WebGPU fallback (the shell banner explains it). `'settings'` is the
  // pre-existing behavior, byte-for-byte.
  const brain = currentBrain();
  if (brain.kind === 'webllm') {
    return createDirectAppTransport({
      mode: 'webllm',
      provider,
      ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
    });
  }
  if (brain.kind === 'demo') {
    return createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
    });
  }
  const model = modelStore.get();
  if (mode === 'subscription') return createServerAppTransport(model);
  return createDirectAppTransport({
    mode,
    provider,
    ...(model !== undefined ? { model } : {}),
    localUrl: localUrlStore.get(),
    ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
  });
}
