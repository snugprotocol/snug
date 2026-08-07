// AL-04 D2/M6 — the inference turn sits at the AgentAdapter layer: direct
// `adapter.complete`, D8 instructions in `AdapterRequest.system`, the untrusted
// docs block as the single user message, NO tools, NO cache (ADR-0012), NO
// buildHostSystemPrompt, and NO inspector event hook (D10 — mutation M18).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';

import { modeStore, providerStore, setByokKey } from '../state/mode.js';
import { inferenceWireCopy, runAuthSpecInference } from '../agent/inferrerAdapter.js';
import { installTestUserDb } from './userdbTestHelper.js';

const DOCS_CANARY = 'CANARY-docs-2f8a71c39b';

const cleanReplyText = JSON.stringify({
  proposal: {
    kindHint: 'api_key',
    providerName: 'Acme Weather',
    declaredApiHosts: ['api.acme-weather.example'],
  },
  confidence: 0.8,
  evidence: [],
});

function capturingAdapter(replyText = cleanReplyText): { adapter: AgentAdapter; requests: AdapterRequest[] } {
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

describe('D2 — wire placement: system = D8 instructions, user = the docs block', () => {
  it('the untrusted docs travel ONLY in the single user message, never the system slot', async () => {
    const { adapter, requests } = capturingAdapter();
    const result = await runAuthSpecInference({
      providerName: 'Acme Weather',
      kindHint: 'api_key',
      docsText: `Acme Weather docs: ${DOCS_CANARY}`,
      adapter,
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.system).toContain('## Output contract'); // the rendered D8 sections
    expect(request.system).not.toContain(DOCS_CANARY);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toMatchObject({ role: 'user' });
    const user = request.messages[0]!;
    expect('content' in user ? user.content : '').toContain('<provider_docs>');
    expect('content' in user ? user.content : '').toContain(DOCS_CANARY);
  });

  it('offers NO tools (JSON-only mode) and NEVER sets cache (ADR-0012)', async () => {
    const { adapter, requests } = capturingAdapter();
    await runAuthSpecInference({ providerName: 'Acme Weather', kindHint: 'api_key', adapter });
    const request = requests[0]!;
    expect(request.tools).toBeUndefined();
    expect(request.cache).toBeUndefined();
    expect('onDelta' in request && request.onDelta !== undefined).toBe(false);
  });

  it('threads the abort signal through to the adapter request', async () => {
    const { adapter, requests } = capturingAdapter();
    const controller = new AbortController();
    await runAuthSpecInference({ providerName: 'Acme Weather', kindHint: 'api_key', adapter, signal: controller.signal });
    expect(requests[0]!.signal).toBe(controller.signal);
  });

  it('an AdapterResult error (errors-as-data) becomes the typed completion_failed inferrer error', async () => {
    const adapter: AgentAdapter = {
      complete: async () => ({ ok: false, code: 'RATE_LIMITED', message: 'slow down', retryable: true }),
    };
    const result = await runAuthSpecInference({ providerName: 'Acme Weather', kindHint: 'api_key', adapter });
    expect(result).toMatchObject({ ok: false, code: 'completion_failed' });
    if (!result.ok) expect(result.message).toContain('RATE_LIMITED');
  });

  it('the registry rung never touches the adapter at all (AC2, second seat)', async () => {
    const complete = vi.fn();
    const result = await runAuthSpecInference({
      providerName: 'Spotify',
      kindHint: 'oauth2_auth_code',
      adapter: { complete },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.provenance).toBe('registry');
  });
});

describe('nonBlocking 2 — a REAL inference never runs on the mock demo brain (AL-05 gate)', () => {
  afterEach(() => {
    modeStore.set('byok');
    providerStore.set('mock');
  });

  it('keyless SUBSCRIPTION mode: a visible needs-BYOK error, never the demo brain\'s "not parseable" failure', async () => {
    await installTestUserDb(); // no BYOK key stored anywhere
    modeStore.set('subscription');
    providerStore.set('anthropic');
    const result = await runAuthSpecInference({
      providerName: 'Acme Weather',
      kindHint: 'api_key',
      docsText: 'Acme Weather docs: pass your key in the X-Api-Key header.',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('completion_failed');
    expect(result.provenance).toBe('user_docs');
    // The whole point: an HONEST state, not the mock's guaranteed-misleading
    // 'the model reply was not a parseable JSON object'.
    expect(result.message).toMatch(/bring-your-own-key|byok/i);
    expect(result.message).not.toMatch(/not a parseable/i);
  });

  it('byok mode with the demo-brain provider selected: same guard (the demo brain cannot read docs)', async () => {
    await installTestUserDb();
    modeStore.set('byok');
    providerStore.set('mock');
    const result = await runAuthSpecInference({ providerName: 'Acme Weather', kindHint: 'api_key' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('completion_failed');
    expect(result.provenance).toBe('inference');
    expect(result.message).toMatch(/bring-your-own-key|byok/i);
  });
});

describe('D10/M6 — source lint: the inference path carries no transport, loop, or inspector wiring (mutation M18)', () => {
  it('inferrerAdapter.ts uses createTurnAdapter + direct complete and nothing it must not', () => {
    const text = readFileSync(join(__dirname, '..', 'agent', 'inferrerAdapter.ts'), 'utf8');
    expect(text).toContain('createTurnAdapter');
    for (const forbidden of ['runAgentTurn', 'buildHostSystemPrompt', 'createDirectAppTransport', 'onLlmEvent', 'llmInspector', 'AgentTurnEvent']) {
      expect(text.includes(forbidden), `inferrerAdapter.ts must not reference ${forbidden}`).toBe(false);
    }
  });

  it('the wizard store and sheet are likewise inspector-free (docs never reach inspector state)', () => {
    for (const rel of [['state', 'wizard.ts'], ['connections', 'AuthWizardSheet.tsx']] as const) {
      const text = readFileSync(join(__dirname, '..', ...rel), 'utf8');
      for (const forbidden of ['onLlmEvent', 'llmInspector', 'AgentTurnEvent']) {
        expect(text.includes(forbidden), `${rel.join('/')} must not reference ${forbidden}`).toBe(false);
      }
    }
  });
});

describe('AL-05 AC7 — inferenceWireCopy: the paste-box names the wire the inference turn actually uses (M55)', () => {
  afterEach(() => {
    modeStore.set('byok');
    providerStore.set('mock');
  });

  it('SUBSCRIPTION mode with a stored key: says the pasted text goes browser-direct to the provider — not "your configured model"', async () => {
    await installTestUserDb();
    await setByokKey('anthropic', 'sk-test-disclosure');
    modeStore.set('subscription');
    providerStore.set('anthropic');
    const copy = await inferenceWireCopy();
    expect(copy).toMatch(/subscription/i);
    expect(copy).toMatch(/directly from this browser to anthropic/i);
    expect(copy).not.toMatch(/configured model/i);
  });

  it('byok mode with a stored key: names the provider and the browser-direct wire', async () => {
    await installTestUserDb();
    await setByokKey('openai', 'sk-test-disclosure');
    modeStore.set('byok');
    providerStore.set('openai');
    const copy = await inferenceWireCopy();
    expect(copy).toMatch(/directly from this browser to openai/i);
    expect(copy).not.toMatch(/subscription/i);
  });

  it('keyless subscription: says inference is unavailable without a key — no wire claim at all', async () => {
    await installTestUserDb(); // no key stored
    modeStore.set('subscription');
    providerStore.set('anthropic');
    const copy = await inferenceWireCopy();
    expect(copy).toMatch(/needs a real model|add an api key/i);
    expect(copy).not.toMatch(/directly from this browser/i);
  });

  it('local mode: names the local server wire', async () => {
    await installTestUserDb();
    modeStore.set('local');
    providerStore.set('anthropic');
    const copy = await inferenceWireCopy();
    expect(copy).toMatch(/local anthropic server/i);
  });

  it('the sheet composes the docs label from inferenceWireCopy — the stale "configured model" claim is gone (source pin)', () => {
    const source = readFileSync(
      join(__dirname, '..', 'connections', 'AuthWizardSheet.tsx'),
      'utf8',
    );
    expect(source).toContain('inferenceWireCopy');
    expect(source).not.toContain('your configured model');
  });
});
