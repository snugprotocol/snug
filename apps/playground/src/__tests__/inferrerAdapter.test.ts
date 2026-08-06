// AL-04 D2/M6 — the inference turn sits at the AgentAdapter layer: direct
// `adapter.complete`, D8 instructions in `AdapterRequest.system`, the untrusted
// docs block as the single user message, NO tools, NO cache (ADR-0012), NO
// buildHostSystemPrompt, and NO inspector event hook (D10 — mutation M18).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { AdapterRequest, AgentAdapter } from '@snugprotocol/adapters';

import { runAuthSpecInference } from '../agent/inferrerAdapter.js';

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
