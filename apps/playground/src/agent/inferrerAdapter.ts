// inferrerAdapter.ts — the playground side of the auth-spec-inferrer seam (AL-04
// plan D2/M6). The inference turn lives at the AgentAdapter layer, NOT the
// transport layer: the direct app transport hard-codes the app-builder host system
// prompt plus the F15 CONSENT_REQUIRED short-circuit inside send, so the D8 prompt
// would ride beneath a contradictory system prompt. Here the adapter is built with
// `createTurnAdapter(config, 'chat')` and called DIRECTLY via
// `adapter.complete(request)` — no agent-turn loop, because the inference turn
// offers no tools (JSON-only mode). A source lint pins all of this.
//
// Wire placement (D2 pin): `AdapterRequest.system` = the rendered D8 instruction
// sections (trusted, static); the SINGLE user message = the delimited
// <provider_docs> DATA block (untrusted). `cache` is NEVER set (ADR-0012: a
// one-shot below every cacheable-prefix minimum — a breakpoint would be a pure
// write premium). The adapter is constructed WITHOUT any inspector event hook
// (D10): pasted docs must never reach LLM-inspector state.

import type { AgentAdapter } from '@snugprotocol/adapters';
import { buildAuthSpecInferrerPrompt } from '@snugprotocol/knowledge';
import {
  createAuthSpecInferrer,
  type InferAuthSpecResult,
  type InferrerComplete,
} from '@snugprotocol/auth';

import { getByokKey, localUrlStore, modelStore, modeStore, providerStore } from '../state/mode.js';
import { currentBrain } from '../state/webllm.js';
import { createTurnAdapter, type DirectMode } from './adapter.js';

export interface RunAuthSpecInferenceInput {
  providerName: string;
  kindHint?: string;
  docsText?: string;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to the live settings-configured adapter. */
  adapter?: AgentAdapter;
}

/** Resolve the settings-configured adapter, brain override included (per CALL, not creation). */
async function liveAdapter(): Promise<AgentAdapter> {
  const brain = currentBrain();
  if (brain.kind === 'webllm') return createTurnAdapter({ mode: 'webllm', provider: providerStore.get() }, 'chat');
  if (brain.kind === 'demo') return createTurnAdapter({ mode: 'byok', provider: 'mock' }, 'chat');
  const mode = modeStore.get();
  const provider = providerStore.get();
  // Subscription has no browser-side adapter; the inference turn is a direct
  // browser call, so it runs on the byok/local settings (mock when keyless).
  const direct: DirectMode = mode === 'subscription' ? 'byok' : mode;
  const key = direct === 'local' ? undefined : await getByokKey(provider);
  const model = modelStore.get();
  return createTurnAdapter(
    {
      mode: direct,
      provider,
      ...(key !== undefined ? { key } : {}),
      ...(model !== undefined ? { model } : {}),
      localUrl: localUrlStore.get(),
    },
    'chat',
  );
}

/**
 * Build the completion seam over a concrete adapter: system bound in the closure,
 * the seam's `prompt` argument IS the user message (the docs data block). Errors
 * come back as data from the adapter (`!ok`) and are re-thrown typed so the
 * inferrer maps them to `completion_failed`.
 */
export function completeWithAdapter(adapter: AgentAdapter, system: string): InferrerComplete {
  return async (prompt, { signal }) => {
    const result = await adapter.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      ...(signal !== undefined ? { signal } : {}),
      // NO `cache` (ADR-0012) and NO event hook (D10) — asserted by tests.
    });
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result.text;
  };
}

/**
 * The wizard's inference entry: render the D8 prompt (knowledge store), bind the
 * system slot into the seam, and run the DI-pure inferrer from @snugprotocol/auth
 * — whose registry rung never touches the seam at all.
 */
export async function runAuthSpecInference(input: RunAuthSpecInferenceInput): Promise<InferAuthSpecResult> {
  const { system, user } = buildAuthSpecInferrerPrompt({
    providerName: input.providerName,
    ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
    ...(input.docsText !== undefined ? { docsText: input.docsText } : {}),
  });
  const adapter = input.adapter ?? (await liveAdapter());
  const inferrer = createAuthSpecInferrer({ complete: completeWithAdapter(adapter, system) });
  return inferrer.infer({
    providerName: input.providerName,
    ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
    ...(input.docsText !== undefined ? { docsText: input.docsText } : {}),
    prompt: user,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}
