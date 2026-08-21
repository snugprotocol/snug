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
// `RequirementInferrerComplete` (v4) replaces the deleted v3 `InferrerComplete`. The two
// were structurally identical — `(prompt, { signal }) => Promise<string>` — so this is a
// rename to the surviving contract, not a change of shape.
import { type RequirementInferrerComplete } from '@snugprotocol/auth';

import { resolveModelForApp, resolveProviderForApp } from '../state/appModel.js';
import { getByokKey, localUrlStore, modeStore, providerStore, type ByokProvider } from '../state/mode.js';
import { currentBrain } from '../state/webllm.js';
import { createTurnAdapter, type DirectMode } from './adapter.js';

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

async function decideWire(appId?: string): Promise<WireDecision> {
  const brain = currentBrain();
  if (brain.kind === 'webllm') return { kind: 'webllm' };
  if (brain.kind === 'demo') return { kind: 'unavailable' }; // the demo brain cannot read docs
  const mode = modeStore.get();
  // The app's provider pin routes THIS lane too (TASK-20260821, review finding 8):
  // without it, an app pinned to the other provider would get that provider's model id
  // sent to the GLOBAL provider's adapter with the global provider's key — a guaranteed
  // provider-side error. No appId resolves the Settings default, as before.
  const provider = resolveProviderForApp(appId);
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

/**
 * Resolve the settings-configured adapter, brain override included (per CALL, not
 * creation).
 *
 * EXPORTED for the v2 requirement inferrer (`connectionInferrerAdapter.ts`): the wire
 * decision — which model, which key, and whether there is a real one at all — is a
 * property of the user's SETTINGS, not of which inferrer is asking. Two copies of this
 * ladder would eventually disagree, and the disagreement would show up as an inference
 * turn quietly running on the mock brain.
 */
/**
 * `appId` (TASK-20260817): the app this inference is being run FOR, so its per-app model
 * pick routes the turn like every other app-scoped lane. Optional — a non-app-scoped
 * inference resolves the Settings default, which is the pre-existing behavior exactly.
 */
export async function liveInferenceAdapter(appId?: string): Promise<LiveAdapterResolution> {
  const wire = await decideWire(appId);
  if (wire.kind === 'unavailable') return { ok: false };
  if (wire.kind === 'webllm') {
    return { ok: true, adapter: createTurnAdapter({ mode: 'webllm', provider: providerStore.get() }, 'chat') };
  }
  const model = resolveModelForApp(appId);
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
export function completeWithAdapter(adapter: AgentAdapter, system: string): RequirementInferrerComplete {
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

// `runAuthSpecInference` was DELETED here by TASK-20260810-p4-starters, the named exit
// item. It had no production caller as of P3 (the v4 wizard routes through
// `connectionInferrerAdapter.ts`), and it was the last thing holding the v3
// `createAuthSpecInferrer` / `llmProposalSchema` pair alive. P3 deliberately left it in
// place rather than reaching into this phase's scope; it goes now, with its schema, in one
// reviewable step.
//
// What SURVIVES in this file is shared with the v4 path and is not v3-specific:
// `liveInferenceAdapter` (the settings/wire decision ladder) and `completeWithAdapter`
// (the completion seam), both imported by `connectionInferrerAdapter.ts`. Two copies of
// that ladder would eventually disagree, and the disagreement would surface as an
// inference turn quietly running on the mock brain.
