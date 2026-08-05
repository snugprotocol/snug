// transport.ts — the Run view's AgentTransport, identical interface in every mode so
// the Run view code never branches:
//   subscription → createHttpTransport('/invoke') (SSE; the hub server owns the LLM)
//   byok/local   → runAgentTurn in-browser (JSON-only mode — the wire envelope goes
//                  straight to the provider; keys from the user DB, mock needs none)
// F15 guard: after an import/first-pull, byok/local turns are refused until the user
// re-confirms endpoint settings — an imported DB is executable config.

import { createHttpTransport, runAgentTurn, type AgentRoundTrip } from '@snugprotocol/adapters';
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
  onRoundTrip?: (trip: AgentRoundTrip) => void;
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
        // The app-frame LLM feed. `round_trip` is the only event we forward: the
        // others describe tool activity this path does not have (no tools are
        // offered to an app turn), and forwarding nothing was the bug.
        ...(options.onRoundTrip !== undefined
          ? {
              onEvent: (event): void => {
                if (event.type !== 'round_trip') return;
                const { type: _type, ...trip } = event;
                options.onRoundTrip?.(trip satisfies AgentRoundTrip);
              },
            }
          : {}),
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
 * `onRoundTrip` is threaded through so the Run view's LLM surface sees the turns an
 * APP makes, not just the ones the builder chat makes — the owner-reported gap where
 * a Chess move populated the frame inspector and nothing else. Subscription mode
 * ignores it: those round trips never leave the hub.
 */
export function createAppTransport(
  mode: PlaygroundMode,
  provider: ByokProvider,
  onRoundTrip?: (trip: AgentRoundTrip) => void,
): AgentTransport {
  const model = modelStore.get();
  if (mode === 'subscription') return createServerAppTransport(model);
  return createDirectAppTransport({
    mode,
    provider,
    ...(model !== undefined ? { model } : {}),
    localUrl: localUrlStore.get(),
    ...(onRoundTrip !== undefined ? { onRoundTrip } : {}),
  });
}
