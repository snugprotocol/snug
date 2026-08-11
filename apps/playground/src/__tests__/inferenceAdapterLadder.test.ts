// inferenceAdapterLadder.test.ts — TASK-20260810-p4-starters, P4-AC13 (RED-FIRST).
//
// RESTORED COVERAGE FOR THE THREE EXPORTS THAT SURVIVED THE v3 DELETION.
//
// P4 deleted `runAuthSpecInference` — legitimately: it was the named exit item, had no
// production caller after P3, and was the last thing holding the v3
// `createAuthSpecInferrer`/`llmProposalSchema` pair alive. But the whole test FILE went
// with it, and the file also guarded three exports that STILL SHIP:
//
//   `decideWire` (via the two below), `liveInferenceAdapter`, `completeWithAdapter`
//
// all imported by `connectionInferrerAdapter.ts` — the v4 path. That is 19 tests deleted
// for one removed function, and it is the exact P3 lesson repeating ("14 shipped behaviors
// silently losing their test guard").
//
// THE GATE THAT MATTERED MOST, and the mutation that proved it unguarded. The deleted
// `nonBlocking 2` block asserted that a REAL inference never runs on the MOCK DEMO BRAIN
// (AL-05). The demo brain returns scripted chat replies, so an inference turn routed to it
// produces a guaranteed-misleading "the model reply was not a parseable JSON object"
// instead of the honest "you need a key" the user can act on. `inferrerAdapter.ts`'s own
// surviving comment names this hazard: two copies of the wire ladder "would eventually
// disagree, and the disagreement would surface as an inference turn quietly running on the
// mock brain".
//
// MUTATION-PROVEN BEFORE THIS FILE EXISTED: deleting the demo-brain guard outright
// (`if (brain.kind === 'demo') return { kind: 'unavailable' };`) left `pnpm test --force`
// at 19/19 tasks green. The gate could be removed entirely and nothing noticed.
//
// WHY THIS IS NOT A RESURRECTION OF DELETED CODE. Nothing here imports or reinstates
// `runAuthSpecInference`. Every assertion drives an export reachable in the shipped v4
// build, through the ladder the v4 inferrer actually calls. The deleted tests' SUBJECT was
// the v3 entry point; their PROPERTY was the wire decision, and the wire decision survived.
//
// C1 — the BYOK keys here are obvious non-secrets written by the test. `completeWithAdapter`
// is exercised against a fake adapter; no key reaches any wire.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LOCAL_DEFAULT_BASE_URL, type AdapterRequest, type AgentAdapter } from '@snugprotocol/adapters';

import { localUrlStore, modeStore, providerStore, setByokKey } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { completeWithAdapter, inferenceWireCopy, liveInferenceAdapter } from '../agent/inferrerAdapter.js';
import { installTestUserDb } from './userdbTestHelper.js';

const DOCS_CANARY = 'CANARY-docs-2f8a71c39b';

function capturingAdapter(replyText = '{"requirement":null,"confidence":0.1,"evidence":[]}'): {
  adapter: AgentAdapter;
  requests: AdapterRequest[];
} {
  const requests: AdapterRequest[] = [];
  return {
    requests,
    adapter: {
      complete: async (request) => {
        requests.push(request);
        return { ok: true, text: replyText, toolCalls: [], stopReason: 'end' };
      },
    },
  };
}

afterEach(() => {
  modeStore.set('byok');
  providerStore.set('mock');
  localUrlStore.set(LOCAL_DEFAULT_BASE_URL);
  // The WebLLM brain override is global state; leaving it on would silently reroute every
  // later test's wire decision through `currentBrain()`.
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
});

/**
 * Put `currentBrain()` into the DEMO state: the WebLLM flag on, WebGPU absent.
 *
 * This is the branch `decideWire` guards with `if (brain.kind === 'demo')`, and it is
 * reachable in production exactly this way — a user enables the local-model flag on a
 * machine with no usable GPU adapter, and `resolveBrain` falls back to the scripted mock.
 *
 * Setting these two stores is what the deleted suite never had to think about (it drove the
 * v3 entry point) and what a naive port MISSES: without them `currentBrain()` returns
 * `{kind:'settings'}`, the demo branch is never entered, and a test asserting the gate
 * passes for an unrelated reason — which is exactly what the first draft of this file did,
 * caught by re-running the gate mutation.
 */
function useDemoBrain(): void {
  webllmFlagStore.set(true);
  webgpuStore.set('no');
}

describe('P4-AC13 / AL-05 gate — a REAL inference never runs on the mock demo brain', () => {
  // THE RESTORED SECURITY GATE. Each case asserts `liveInferenceAdapter` FAILS HONESTLY
  // (`ok:false`) rather than handing back an adapter backed by the mock. A resolution that
  // succeeds here is the defect: `createTurnAdapter` would silently return the mock brain
  // and the user would be shown a parse failure for a question they could have answered by
  // adding a key.

  it('THE DEMO BRAIN ITSELF: resolves UNAVAILABLE even with a real provider AND a stored key', async () => {
    // THE MUTATION-KILLING CASE, and the one a naive port of the deleted tests misses.
    //
    // Every OTHER refusal in this block is reachable through a second cause (no key, mock
    // provider), so each would still pass with the demo-brain gate deleted. This one is
    // arranged so the gate is the ONLY thing that can refuse: byok mode, a real provider,
    // and a key actually stored — a configuration that resolves an adapter successfully
    // whenever `currentBrain()` is not `demo`.
    //
    // Mutation-proven: commenting out `if (brain.kind === 'demo') return {kind:'unavailable'}`
    // in `inferrerAdapter.ts` turns THIS test red and no other.
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-test-not-a-real-key');
    modeStore.set('byok');
    providerStore.set('anthropic');
    useDemoBrain();

    const resolution = await liveInferenceAdapter();

    expect(
      resolution.ok,
      'the demo brain returns scripted chat replies — an inference turn on it yields a guaranteed-misleading parse failure',
    ).toBe(false);
  });

  it('the demo brain also silences the WIRE COPY — no claim of a wire that cannot run', async () => {
    // The disclosure half of the same gate: `inferenceWireCopy` shares `decideWire`, so a
    // deleted gate would have the paste-box promise a real provider wire while the turn ran
    // on the mock. Kills the same mutation from the copy side.
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-test-disclosure');
    modeStore.set('byok');
    providerStore.set('anthropic');
    useDemoBrain();

    const copy = await inferenceWireCopy();

    expect(copy).toMatch(/needs a real model|add an api key/i);
    expect(copy, 'the copy must not name a provider wire the demo brain will not use').not.toMatch(/anthropic/i);
  });

  it('byok mode with the demo-brain PROVIDER selected: resolves UNAVAILABLE too', async () => {
    // A separate cause from the brain override above: `providerStore === 'mock'` is the
    // demo-brain PROVIDER, which has no real model behind it.
    await installTestUserDb();
    modeStore.set('byok');
    providerStore.set('mock');

    const resolution = await liveInferenceAdapter();

    expect(resolution.ok, 'the demo brain cannot read docs — this must fail honestly').toBe(false);
  });

  it('keyless SUBSCRIPTION mode: resolves UNAVAILABLE (there is no browser-side subscription wire)', async () => {
    // Subscription has no browser-side adapter, so the inference turn runs on the BYOK
    // direct settings. With no key stored, `createTurnAdapter` would silently hand back the
    // mock — which is precisely the state this refuses.
    await installTestUserDb(); // no BYOK key stored anywhere
    modeStore.set('subscription');
    providerStore.set('anthropic');

    const resolution = await liveInferenceAdapter();

    expect(resolution.ok).toBe(false);
  });

  it('keyless BYOK mode: resolves UNAVAILABLE rather than falling through to the mock', async () => {
    await installTestUserDb();
    modeStore.set('byok');
    providerStore.set('anthropic'); // a real provider, but no key for it

    const resolution = await liveInferenceAdapter();

    expect(resolution.ok).toBe(false);
  });

  it('BYOK with a stored key: resolves an adapter — the gate refuses the mock, not every wire', async () => {
    // The counterweight. A gate that failed on EVERY configuration would also pass the
    // three assertions above while making inference permanently unavailable, so the
    // positive case is what proves the refusals are discriminating.
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-test-not-a-real-key');
    modeStore.set('byok');
    providerStore.set('anthropic');

    const resolution = await liveInferenceAdapter();

    expect(resolution.ok).toBe(true);
  });

  it('LOCAL mode resolves an adapter without any key — the endpoint IS the wire', async () => {
    await installTestUserDb();
    modeStore.set('local');
    providerStore.set('mock'); // local ignores provider entirely

    const resolution = await liveInferenceAdapter();

    expect(resolution.ok, 'local mode needs no key and must not be caught by the mock guard').toBe(true);
  });
});

describe('P4-AC13 / AL-05 AC7 — inferenceWireCopy names the wire the turn ACTUALLY uses (M55)', () => {
  // The disclosure half of the same ladder. `inferenceWireCopy` and `liveInferenceAdapter`
  // share `decideWire` precisely so the copy cannot claim a wire the turn does not use;
  // these cases pin the claims the shared ladder produces.

  it('SUBSCRIPTION with a stored key: says browser-direct to the provider — not "your configured model"', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-test-disclosure');
    modeStore.set('subscription');
    providerStore.set('anthropic');

    const copy = await inferenceWireCopy();

    expect(copy).toMatch(/subscription/i);
    expect(copy).toMatch(/directly from this browser to anthropic/i);
    expect(copy).not.toMatch(/configured model/i);
  });

  it('byok with a stored key: names the provider and the browser-direct wire', async () => {
    await installTestUserDb();
    await setByokKey('openai', 'sk-test-disclosure');
    modeStore.set('byok');
    providerStore.set('openai');

    const copy = await inferenceWireCopy();

    expect(copy).toMatch(/directly from this browser to openai/i);
    expect(copy).not.toMatch(/subscription/i);
  });

  it('keyless subscription: says inference is unavailable — makes NO wire claim', async () => {
    await installTestUserDb();
    modeStore.set('subscription');
    providerStore.set('anthropic');

    const copy = await inferenceWireCopy();

    expect(copy).toMatch(/needs a real model|add an api key/i);
    expect(copy).not.toMatch(/directly from this browser/i);
  });

  it('local mode: names the configured endpoint, never the provider (M65)', async () => {
    await installTestUserDb();
    modeStore.set('local');
    providerStore.set('anthropic');

    const copy = await inferenceWireCopy();

    expect(copy).toContain(LOCAL_DEFAULT_BASE_URL);
    // Local mode ignores provider/key entirely (agent/adapter.ts) — the copy must not
    // attribute the wire to a provider the local adapter never reads.
    expect(copy).not.toMatch(/anthropic/i);
  });

  it('local mode with the DEFAULT provider: never invents a "mock server" (M65)', async () => {
    await installTestUserDb();
    modeStore.set('local');
    providerStore.set('mock');

    const copy = await inferenceWireCopy();

    expect(copy).not.toMatch(/mock/i);
    expect(copy).toContain(LOCAL_DEFAULT_BASE_URL);
  });

  it('local mode with a custom endpoint: the copy follows localUrlStore, not the default', async () => {
    await installTestUserDb();
    modeStore.set('local');
    providerStore.set('mock');
    localUrlStore.set('http://127.0.0.1:1234/v1');

    const copy = await inferenceWireCopy();

    expect(copy).toContain('http://127.0.0.1:1234/v1');
  });
});

describe('P4-AC13 — completeWithAdapter: the completion seam binds system and carries no extras', () => {
  it('binds the system prompt in the closure and sends the prompt as the SINGLE user message', async () => {
    // The D2 wire placement, restated on the surviving seam: trusted instructions in
    // `system`, the untrusted docs block as the one user message. A docs block that leaked
    // into the system slot would be untrusted text in a trusted position.
    const { adapter, requests } = capturingAdapter();

    await completeWithAdapter(adapter, '## Output contract')(`<provider_docs>${DOCS_CANARY}</provider_docs>`, {});

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.system).toContain('## Output contract');
    expect(request.system).not.toContain(DOCS_CANARY);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({ role: 'user' });
    expect('content' in request.messages[0]! ? request.messages[0]!.content : '').toContain(DOCS_CANARY);
  });

  it('offers NO tools (JSON-only) and NEVER sets cache (ADR-0012)', async () => {
    // A cache breakpoint on a one-shot below every cacheable-prefix minimum is a pure
    // write premium — ADR-0012 pins its absence.
    const { adapter, requests } = capturingAdapter();

    await completeWithAdapter(adapter, 'sys')('docs', {});

    const request = requests[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.cache).toBeUndefined();
    expect('onDelta' in request && request.onDelta !== undefined).toBe(false);
  });

  it('threads the abort signal through to the adapter request', async () => {
    const { adapter, requests } = capturingAdapter();
    const controller = new AbortController();

    await completeWithAdapter(adapter, 'sys')('docs', { signal: controller.signal });

    expect(requests[0]!.signal).toBe(controller.signal);
  });

  it('an errors-as-data adapter failure is RE-THROWN typed, carrying the code', async () => {
    // The inferrer maps a throw here to `completion_failed`. Swallowing it would report a
    // successful inference over an empty reply.
    const adapter: AgentAdapter = {
      complete: async () => ({ ok: false, code: 'RATE_LIMITED', message: 'slow down', retryable: true }),
    };

    await expect(completeWithAdapter(adapter, 'sys')('docs', {})).rejects.toThrow(/RATE_LIMITED/);
  });

  it('returns the adapter text verbatim on success — no reshaping in the seam', async () => {
    const { adapter } = capturingAdapter('{"requirement":null,"confidence":0.1,"evidence":[]}');

    const text = await completeWithAdapter(adapter, 'sys')('docs', {});

    expect(text).toBe('{"requirement":null,"confidence":0.1,"evidence":[]}');
  });
});

describe('P4-AC13 / D10+M6 — source lint: the inference path carries no transport, loop or inspector wiring', () => {
  // Restored verbatim in intent from the deleted file (mutation M18). Pasted provider docs
  // must never reach LLM-inspector state, and the inference turn must not ride the agent
  // loop or the app-builder transport — both would put the D8 prompt beneath a
  // contradictory system prompt.

  it('inferrerAdapter.ts uses createTurnAdapter + direct complete and nothing it must not', () => {
    const text = readFileSync(join(__dirname, '..', 'agent', 'inferrerAdapter.ts'), 'utf8');
    expect(text).toContain('createTurnAdapter');
    for (const forbidden of [
      'runAgentTurn',
      'buildHostSystemPrompt',
      'createDirectAppTransport',
      'onLlmEvent',
      'llmInspector',
      'AgentTurnEvent',
    ]) {
      expect(text.includes(forbidden), `inferrerAdapter.ts must not reference ${forbidden}`).toBe(false);
    }
  });

  it('the connection wizard surface and the v2 inferrer adapter are likewise inspector-free', () => {
    for (const rel of [
      ['state', 'connectionWizard.ts'],
      ['connections', 'ConnectionWizardSheet.tsx'],
      ['agent', 'connectionInferrerAdapter.ts'],
    ] as const) {
      const text = readFileSync(join(__dirname, '..', ...rel), 'utf8');
      for (const forbidden of ['onLlmEvent', 'llmInspector', 'AgentTurnEvent']) {
        expect(text.includes(forbidden), `${rel.join('/')} must not reference ${forbidden}`).toBe(false);
      }
    }
  });

  it('the run-time wizard surface offers NO paste-docs box to disclose a wire for (Q5)', () => {
    // P3/Q5 removed run-time inference outright, so the honest successor to the original
    // M61 disclosure pin is that no such affordance exists. Asserted at the source rather
    // than trusted.
    for (const rel of [
      ['state', 'connectionWizard.ts'],
      ['connections', 'ConnectionWizardSheet.tsx'],
    ] as const) {
      const source = readFileSync(join(__dirname, '..', ...rel), 'utf8');
      expect(source, `${rel.join('/')} must carry no paste-docs affordance`).not.toMatch(
        /provider docs \(optional|inferenceWireCopy|docsText/,
      );
    }
  });

  it('runAuthSpecInference stays DELETED — this file restores coverage, not the v3 entry point', () => {
    // Guards against a well-meaning "restore the deleted tests" that also restores the
    // deleted function. The export is gone and must stay gone.
    const text = readFileSync(join(__dirname, '..', 'agent', 'inferrerAdapter.ts'), 'utf8');
    expect(text).not.toMatch(/export\s+(async\s+)?function\s+runAuthSpecInference/);
  });
});
