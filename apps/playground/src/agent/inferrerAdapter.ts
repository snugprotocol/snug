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
import type { AuthProvenance } from '@snugprotocol/protocol';

import { getByokKey, localUrlStore, modelStore, modeStore, providerStore, type ByokProvider } from '../state/mode.js';
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

/**
 * A live-adapter resolution that can honestly FAIL: a real inference must never
 * run on the mock demo brain (nonBlocking 2, AL-05 gate) — its scripted chat
 * replies guarantee a misleading 'not parseable' failure, so a keyless
 * subscription/byok configuration (or the demo-brain provider) surfaces a
 * visible needs-BYOK state instead. The `?demoauth` e2e seam is untouched: it
 * scripts the BUILDER chat turn through the demo brain, never this inference turn.
 */
type LiveAdapterResolution = { ok: true; adapter: AgentAdapter } | { ok: false };

/**
 * The wire the inference turn will actually use — ONE decision ladder shared by
 * the adapter construction below and the paste-box disclosure copy (AL-05 AC7),
 * so the copy structurally cannot drift from the wire. Never carries a key.
 */
type WireDecision =
  | { kind: 'webllm' }
  // No `provider`: local mode ignores provider/key entirely (adapter.ts) — the
  // endpoint IS the wire, so carrying a provider here would only license copy that
  // names something the local adapter never reads.
  | { kind: 'local'; localUrl: string }
  | { kind: 'byok'; provider: ByokProvider; viaSubscription: boolean }
  | { kind: 'unavailable' };

async function decideWire(): Promise<WireDecision> {
  const brain = currentBrain();
  if (brain.kind === 'webllm') return { kind: 'webllm' };
  if (brain.kind === 'demo') return { kind: 'unavailable' }; // the demo brain cannot read docs
  const mode = modeStore.get();
  const provider = providerStore.get();
  // Subscription has no browser-side adapter; the inference turn is a direct
  // browser call, so it runs on the byok/local DIRECT settings — never the mock.
  const direct: DirectMode = mode === 'subscription' ? 'byok' : mode;
  if (direct === 'local') return { kind: 'local', localUrl: localUrlStore.get() };
  if (provider === 'mock') return { kind: 'unavailable' }; // the demo-brain provider — no real model behind it
  const key = await getByokKey(provider);
  if (key === undefined) return { kind: 'unavailable' }; // keyless byok/subscription — createTurnAdapter would silently hand back the mock
  return { kind: 'byok', provider, viaSubscription: mode === 'subscription' };
}

/**
 * Honest paste-box disclosure (AL-05 AC7): the docs label names the wire the
 * inference turn will actually use. The keyed-subscription case is the point —
 * a subscription user with a stored BYOK key gets a browser-direct call to that
 * provider for THIS turn, and the copy says so instead of "your configured model".
 */
export async function inferenceWireCopy(): Promise<string> {
  const wire = await decideWire();
  switch (wire.kind) {
    case 'webllm':
      return 'pasted text stays in this browser (local WebLLM model)';
    case 'local':
      return `pasted text goes to your local model at ${wire.localUrl}`;
    case 'byok':
      return wire.viaSubscription
        ? `even in subscription mode, pasted text goes directly from this browser to ${wire.provider} using your saved key`
        : `pasted text goes directly from this browser to ${wire.provider} using your saved key`;
    case 'unavailable':
      return 'docs inference needs a real model — add an API key in settings';
  }
}

/** Resolve the settings-configured adapter, brain override included (per CALL, not creation). */
async function liveAdapter(): Promise<LiveAdapterResolution> {
  const wire = await decideWire();
  if (wire.kind === 'unavailable') return { ok: false };
  if (wire.kind === 'webllm') {
    return { ok: true, adapter: createTurnAdapter({ mode: 'webllm', provider: providerStore.get() }, 'chat') };
  }
  const model = modelStore.get();
  if (wire.kind === 'local') {
    return {
      ok: true,
      adapter: createTurnAdapter(
        // `provider` is a required slot on TurnAdapterConfig that local mode ignores;
        // the endpoint from the wire decision is what actually gets called.
        { mode: 'local', provider: providerStore.get(), ...(model !== undefined ? { model } : {}), localUrl: wire.localUrl },
        'chat',
      ),
    };
  }
  const key = await getByokKey(wire.provider);
  if (key === undefined) return { ok: false }; // key cleared between decision and use — same honest failure
  return {
    ok: true,
    adapter: createTurnAdapter(
      { mode: 'byok', provider: wire.provider, key, ...(model !== undefined ? { model } : {}), localUrl: localUrlStore.get() },
      'chat',
    ),
  };
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
  let adapter = input.adapter;
  if (adapter === undefined) {
    const live = await liveAdapter();
    if (!live.ok) {
      // Visible, honest, and BEFORE any seam call: no mock run, no wire touched.
      const provenance: AuthProvenance = input.docsText !== undefined ? 'user_docs' : 'inference';
      return {
        ok: false,
        provenance,
        code: 'completion_failed',
        message:
          'inference needs a bring-your-own-key model — the demo brain cannot read provider docs. Add a provider key (or a local model) in Settings, then try again.',
      };
    }
    adapter = live.adapter;
  }
  const inferrer = createAuthSpecInferrer({ complete: completeWithAdapter(adapter, system) });
  return inferrer.infer({
    providerName: input.providerName,
    ...(input.kindHint !== undefined ? { kindHint: input.kindHint } : {}),
    ...(input.docsText !== undefined ? { docsText: input.docsText } : {}),
    prompt: user,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
}
