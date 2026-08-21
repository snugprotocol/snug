// transport.ts — the Run view's AgentTransport, identical interface in every mode so
// the Run view code never branches:
//   subscription → createHttpTransport('/invoke') (SSE; the hub server owns the LLM)
//   byok/local   → runAgentTurn in-browser (JSON-only mode — the wire envelope goes
//                  straight to the provider; keys from the user DB, mock needs none)
// F15 guard: after an import/first-pull, byok/local turns are refused until the user
// re-confirms endpoint settings — an imported DB is executable config.

import { createHttpTransport, runAgentTurn, type AgentTurnEvent } from '@snugprotocol/adapters';
import { buildHostSystemPrompt, renderRuntimeContract, SYSTEM_BLOCK_SEPARATOR } from '@snugprotocol/knowledge';
import { ERROR_CODES, parseAppRequest, type RuntimeContract } from '@snugprotocol/protocol';
import type { AgentTransport } from '@snugprotocol/runner';

import { getPlatform } from '../platform/platform.js';
import { appProviderPinFor, resolveModelForApp } from '../state/appModel.js';
import {
  endpointsNeedConfirmStore,
  getByokKey,
  localUrlStore,
  providerStore,
  type ByokProvider,
  type PlaygroundMode,
} from '../state/mode.js';
import { getUserDb } from '../state/userdb.js';
import { currentBrain } from '../state/webllm.js';
import { createTurnAdapter, type DirectMode } from './adapter.js';
import { guardWireForApp } from './pseudonymizeEgress.js';

export function createServerAppTransport(model?: string, appId?: string): AgentTransport {
  // App-path requests are self-contained envelopes — no threadId, no history.
  //
  // The runtime contract IS forwarded (ADR-0018 D3): the hub cannot look one up, so an
  // app running in subscription mode would otherwise silently lose the framing its
  // byok/local twin gets. Read per send, like every other value on this path.
  const inner = createHttpTransport('/invoke', {
    ...(model !== undefined ? { model } : {}),
    ...(appId !== undefined ? { getContract: () => readRuntimeContract(appId) } : {}),
  });
  // R-9 EGRESS SCRUB (TASK-20260820), guarded at the LEAF producer so any caller of this
  // export is bound — the /invoke body is provider-bound exactly like the BYOK wire.
  // Per send, fail closed (see guardWireForApp).
  return {
    async send(wire, options) {
      const guarded = await guardWireForApp(appId, wire);
      if (!guarded.ok) {
        return { ok: false, code: guarded.code, message: guarded.message, retryable: guarded.retryable };
      }
      return inner.send(guarded.wire, options);
    },
  };
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
  /**
   * The installed app this transport serves, when there is one (ADR-0018 P1).
   *
   * Absent for an UNINSTALLED starter, which RunView runs against an ephemeral memory DB
   * with no app row — those turns simply run contract-less on the lean generic layers.
   */
  appId?: string;
  /** Injectable for tests; default reads the contract from the user DB per send. */
  getRuntimeContract?: (appId: string) => Promise<RuntimeContract | undefined>;
}

/**
 * Read the app's runtime contract. Failures degrade to `undefined` — a hub whose DB is
 * unavailable must still run the app's turn on generic layers rather than fail the move
 * (AC-F1-4).
 */
async function readRuntimeContract(appId: string): Promise<RuntimeContract | undefined> {
  try {
    const db = await getUserDb();
    return db.getRuntimeContract(appId);
  } catch {
    return undefined;
  }
}

export function createDirectAppTransport(options: DirectTransportOptions): AgentTransport {
  const readKey = options.getKey ?? getByokKey;
  const needsConfirm = options.needsConfirm ?? ((): boolean => endpointsNeedConfirmStore.get());
  const readContract = options.getRuntimeContract ?? readRuntimeContract;
  // The RUNTIME assembly (ADR-0018 D1) — identity + runtime doctrine + response format.
  // The app-builder layers and the inlined KB summary used to ride every app turn here;
  // a move cannot act on authoring instructions, so they are gone (~1.26 KB/turn).
  // TASK-20260812 P2 (AC1): on desktop the 95-platform-desktop layer is appended after
  // the runtime layers (still BEFORE the volatile contract suffix, so ADR-0012's
  // end-of-system rule holds); with no platform set the bytes are unchanged.
  const baseSystem = buildHostSystemPrompt({
    appBuilder: false,
    artifacts: false,
    appRuntime: true,
    platform: getPlatform().kind,
  });
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
      // R-9 EGRESS SCRUB (TASK-20260820), guarded at the LEAF producer so any caller of
      // this export is bound — not only the RunView wrapper (Gate-5 review, altitude
      // finding 5). Per send, like the brain and contract reads below and for the same
      // stale-capture reason: a sidecar connection approved while RunView is mounted
      // must bind the very next send. Fails closed — a refusal, never a raw wire.
      const guarded = await guardWireForApp(options.appId, wire);
      if (!guarded.ok) {
        return { ok: false, code: guarded.code, message: guarded.message, retryable: guarded.retryable };
      }
      const outbound = guarded.wire;
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
      // PER SEND, never at creation (fold F-M1, and the same rule the brain/settings
      // stores follow for the reason recorded in the 2026-08-06 adversarial review):
      // RunView memoizes this transport, so a contract captured at construction would be
      // frozen for the life of the view — an edit or revert would keep serving the old
      // one. The contract is appended as a system SUFFIX after the stable layers, per
      // ADR-0012's end-of-system rule.
      const contract = options.appId === undefined ? undefined : await readContract(options.appId);
      const system = contract === undefined ? baseSystem : `${baseSystem}${SYSTEM_BLOCK_SEPARATOR}${renderRuntimeContract(contract)}`;
      // Owner rule (TASK-20260812 AC1): a request carrying a responseSchema is NEVER
      // bound by the contract's maxOutputTokens — a structured reply cut off mid-JSON
      // is unparseable, and the bridge would blame the model for the host's cap. The
      // wire self-describes, so the seam that applies the cap decides here.
      const parsedWire = parseAppRequest(outbound);
      const schemaBound = parsedWire.ok && parsedWire.envelope.responseSchema !== undefined;
      const result = await runAgentTurn({
        adapter,
        system,
        messages: [{ role: 'user', content: outbound }],
        // Contract-driven output bound (D4). OPT-IN: absent leaves today's default
        // exactly, so a contract-less legacy app is never silently truncated.
        ...(!schemaBound && contract?.maxOutputTokens !== undefined
          ? { maxOutputTokens: contract.maxOutputTokens }
          : {}),
        signal,
        ...(onDelta !== undefined ? { onDelta } : {}),
        // The app-frame LLM feed. Every event is forwarded — an app turn offers no
        // tools, so in practice this is the start/complete pair, which is exactly what
        // makes the call visible WHILE it runs rather than only after (AC8).
        // Forwarding nothing at all was the original bug.
        ...(options.onLlmEvent !== undefined ? { onEvent: options.onLlmEvent } : {}),
      });
      return result.ok
        ? // stopReason rides along so the runner bridge can tell a cap-truncated reply
          // from model non-compliance (TASK-20260812 AC3).
          { ok: true, text: result.text, stopReason: result.stopReason }
        : { ok: false, code: result.code, message: result.message, retryable: result.retryable };
    },
  };
}

/**
 * The active transport for the current settings.
 *
 * `onLlmEvent` is threaded through so the Run view's LLM surface sees the turns an
 * APP makes, not just the ones the builder chat makes — the owner-reported gap where
 * a Chess move populated the frame inspector and nothing else. Subscription mode
 * ignores it: those round trips never leave the hub.
 *
 * The brain and settings stores are read PER SEND, not at creation (adversarial
 * review 2026-08-06, finding 1): RunView memoizes this transport on [mode, provider],
 * and on a hard load of /run/:id?webllm=1 it is constructed BEFORE the async
 * `initWebllm()` probe lands — a creation-time `currentBrain()` froze the brain at
 * 'settings' for the lifetime of the view, so every app turn routed on the configured
 * mode while the banner claimed in-tab thinking. Same defect class as the
 * useBuilderChat stale-discriminator bug this task already fixed once: when a
 * behavior is conditional, evaluate the condition where the CALL happens.
 */
export function createAppTransport(
  mode: PlaygroundMode,
  provider: ByokProvider,
  onLlmEvent?: (event: AgentTurnEvent) => void,
  appId?: string,
  /**
   * Fired when an APP's turn begins — the same seam `useBuilderChat` gives the builder
   * (TASK-20260813, owner repro 2026-08-13).
   *
   * Without it the inspector was reset by builder turns ONLY, so an app's own turns
   * (a Chess move) appended forever. Since `agent-turn.ts` numbers round trips from 0
   * per turn, those accumulated entries collided on index with every later turn, and a
   * stale `pending` entry could keep its timer ticking under finished calls. The
   * reducer now settles pending-first as a backstop; this closes the accumulation that
   * made collisions likely in the first place.
   */
  onTurnStart?: () => void,
): AgentTransport {
  return {
    send(wire, options) {
      onTurnStart?.();
      // The R-9 egress scrub deliberately does NOT live here: it guards inside BOTH leaf
      // producers (`createDirectAppTransport`, `createServerAppTransport`), so a caller
      // reaching a lower export is bound too (Gate-5 review, altitude finding 5).
      return resolveAppTransport(mode, provider, onLlmEvent, appId).send(wire, options);
    },
  };
}

/**
 * The brain/settings decision, evaluated per send (see createAppTransport).
 * Exported for the consumer-altitude tests only.
 */
export function resolveAppTransport(
  mode: PlaygroundMode,
  provider: ByokProvider,
  onLlmEvent?: (event: AgentTurnEvent) => void,
  appId?: string,
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
      ...(appId !== undefined ? { appId } : {}),
      ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
    });
  }
  if (brain.kind === 'demo') {
    return createDirectAppTransport({
      mode: 'byok',
      provider: 'mock',
      ...(appId !== undefined ? { appId } : {}),
      ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
    });
  }
  // The per-app pick, falling back to the Settings default (ADR-0036). Read HERE rather
  // than in createDirectAppTransport for the same reason the brain is: resolveAppTransport
  // runs per send, so a model chosen mid-session takes effect on the next turn without a
  // remount — RunView memoizes the transport it wraps.
  //
  // The PROVIDER pin resolves per send too (TASK-20260821, plan review finding 7): the
  // `provider` parameter is CAPTURED by createAppTransport's closure at mount, so a pin
  // to the other provider made mid-session would otherwise route on the old provider
  // with the old key until a remount. The pin overrides only in byok mode and only when
  // an app id exists — the demo/webllm arms above and every explicit test construction
  // keep the provider they were handed.
  const model = resolveModelForApp(appId);
  if (mode === 'subscription') return createServerAppTransport(model, appId);
  const pinnedProvider = mode === 'byok' && provider !== 'mock' && appId !== undefined ? appProviderPinFor(appId) : undefined;
  return createDirectAppTransport({
    mode,
    provider: pinnedProvider ?? provider,
    ...(appId !== undefined ? { appId } : {}),
    ...(model !== undefined ? { model } : {}),
    localUrl: localUrlStore.get(),
    ...(onLlmEvent !== undefined ? { onLlmEvent } : {}),
  });
}
