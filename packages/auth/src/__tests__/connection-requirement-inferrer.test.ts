// connection-requirement-inferrer.test.ts — TASK-20260812-registry-authoritative-auth,
// P1 (AC1/AC2 registry authority, AC4 order-of-effects, AC5 the ladder still infers,
// AC6 aliases resolve / lookalikes fall through).
//
// EVERY TEST RUNS THE REAL INFERRER. The adapter is a CALL-RECORDING one, and reaching
// it on a registry key is a hard failure: rung 1's whole contract is that a famous
// provider never costs a token and can never be displaced by anything a model says.
//
// AC4 IS RESTATED DELIBERATELY (review MAJOR 7). The naive version — "a throwing
// adapter does not throw" — is a tautology for registry keys, because rung 1 `return`s
// before `deps.complete` is ever referenced. What is asserted instead is the observable
// ORDER OF EFFECTS: zero recorded calls AND provenance 'registry' for every key and
// every alias, plus the mutation case that can actually fail — when rung 1 is bypassed
// (an injected lookup that misses, the exact effect of deleting the rung), the recorder
// DOES see the call. A future refactor that reorders the ladder turns that pair red.

import { describe, expect, it } from 'vitest';

import {
  createConnectionRequirementInferrer,
  type RequirementInferrerComplete,
} from '../connection-requirement-inferrer.js';
import { INFERRER_ALIASES, WELL_KNOWN_PROVIDERS_REGISTRY } from '../well-known-providers.js';

/** A seam that records every call and answers with an honest refusal envelope. */
function recordingComplete(): { complete: RequirementInferrerComplete; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: async (prompt) => {
      calls.push(prompt);
      return '{"requirement":null,"confidence":0.1,"evidence":[]}';
    },
  };
}

const PROMPT = 'rendered-prompt (contents irrelevant to rung 1)';

describe('AC1 — the inferrer emits the ENTRY\'s kind, never a hardcoded one', () => {
  // Two concrete literals FIRST, so this suite can never be satisfied by the inferrer
  // and the registry agreeing on a shared wrong constant.
  it('Coinbase → api_key (the owner\'s founding defect, fixed at the emitting site)', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Coinbase', slot: 'coinbase', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement?.kind).toBe('api_key');
  });

  it('GitHub → bearer_token (D5: kind and endpoints disagree by design)', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'GitHub', slot: 'github', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement?.kind).toBe('bearer_token');
  });

  for (const [key, entry] of Object.entries(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    it(`${key}: emitted kind is the entry's own`, async () => {
      const { complete } = recordingComplete();
      const inferrer = createConnectionRequirementInferrer({ complete });
      const result = await inferrer.infer({ providerName: key, slot: key, prompt: PROMPT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.requirement, `${key}: a shipped entry must compose and parse (AC3)`).not.toBeNull();
      expect(result.requirement?.kind).toBe(entry.kind);
    });
  }
});

describe('AC2 — a registry hit emits the entry\'s pinned fields VERBATIM', () => {
  it('Coinbase: three named, typed fields arrive — not zero, not one generic box', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Coinbase', slot: 'coinbase', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement?.fields).toEqual(WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']?.fields);
    expect(result.requirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'api_secret', 'passphrase']);
  });

  it('an entry with NO fields emits none — no invented input (google)', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Google', slot: 'google', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement?.fields).toBeUndefined();
  });

  it('every seat the entry holds rides through: endpoints, registration, params, pkce, hosts', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Spotify', slot: 'music', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['spotify']!;
    expect(result.requirement?.endpoints).toEqual(entry.endpoints);
    expect(result.requirement?.registration).toEqual(entry.registration);
    expect(result.requirement?.pkce).toBe(entry.pkce);
    expect(result.requirement?.declaredApiHosts).toEqual(entry.apiHosts);
    expect(result.requirement?.slot, 'the slot is the HOST\'s value').toBe('music');
  });
});

describe('AC4 — inference NEVER fires for a registered provider (order of effects)', () => {
  for (const key of Object.keys(WELL_KNOWN_PROVIDERS_REGISTRY)) {
    it(`${key}: zero seam calls, provenance 'registry'`, async () => {
      const { complete, calls } = recordingComplete();
      const inferrer = createConnectionRequirementInferrer({ complete });
      const result = await inferrer.infer({ providerName: key, slot: key, prompt: PROMPT });
      expect(calls.length, `${key} must never reach the model`).toBe(0);
      expect(result.provenance).toBe('registry');
    });
  }

  for (const alias of Object.keys(INFERRER_ALIASES)) {
    it(`alias '${alias}': zero seam calls, provenance 'registry' — alias lookup sits INSIDE rung 1`, async () => {
      // The call site this names (D3): rung 1 consults the exact key THEN the inferrer
      // alias map, both before any seam reference. If alias resolution moved below the
      // seam call, the recorder would see a call and this goes red.
      const { complete, calls } = recordingComplete();
      const inferrer = createConnectionRequirementInferrer({ complete });
      const result = await inferrer.infer({ providerName: alias, slot: 'x', prompt: PROMPT });
      expect(calls.length, `alias '${alias}' must short-circuit before the seam`).toBe(0);
      expect(result.provenance).toBe('registry');
    });
  }

  it('MUTATION — with rung 1 bypassed (injected lookup that misses), the seam IS reached', async () => {
    // The half that can actually fail. Deleting or reordering rung 1 is observationally
    // identical to a lookup that always misses; the recorder must see that call, which
    // proves the zero-call assertions above are measuring the rung and not the recorder.
    const { complete, calls } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete, lookup: () => undefined });
    const result = await inferrer.infer({ providerName: 'nonesuch-provider', slot: 'x', prompt: PROMPT });
    expect(calls.length).toBe(1);
    expect(result.provenance).toBe('inference');
  });
});

describe('AC5 — the registry is a short-circuit, never a whitelist', () => {
  it('an unknown provider still reaches the model rungs (provenance inference)', async () => {
    const { complete, calls } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Fitbit', slot: 'fitbit', prompt: PROMPT });
    expect(calls.length).toBe(1);
    expect(calls[0], 'the prompt is passed through VERBATIM (C1 structural claim)').toBe(PROMPT);
    expect(result.ok).toBe(true);
    expect(result.provenance).toBe('inference');
  });

  it('pasted docs select provenance user_docs on the same rung', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({
      providerName: 'Fitbit',
      slot: 'fitbit',
      prompt: PROMPT,
      fromPastedDocs: true,
    });
    expect(result.provenance).toBe('user_docs');
  });
});

/**
 * TASK-20260812-auth-kind-choice P2 — ALTERNATIVES (AC6/AC11).
 *
 * A provider may genuinely offer more than one way in. The result seat is the SAME for
 * both sources — registry `authOptions` and model-proposed `alternatives` — so every
 * caller (the runtime card, a dev-time authoring flow) reads one seat (AC11 parity;
 * this suite itself is the headless caller). Alternatives are candidates for a USER
 * choice, never rows: persisting one is P3's job, on the `user` channel, after a click.
 */
describe('P2/AC6 — registry hits surface authOptions as alternatives (no model involved)', () => {
  it('coinbase: the OAuth option arrives parsed as an alternative beside the api_key default', async () => {
    const { complete, calls } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Coinbase', slot: 'coinbase', prompt: PROMPT });
    expect(calls.length, 'options come from the ENTRY, never the seam').toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.requirement?.kind).toBe('api_key');
    expect(result.alternatives).toHaveLength(1);
    const alternative = result.alternatives![0]!;
    expect(alternative.kind).toBe('oauth2_auth_code');
    expect(alternative.endpoints?.authorizeUrl).toBe('https://login.coinbase.com/oauth2/auth');
    expect(alternative.slot, 'the HOST\'s slot on every option').toBe('coinbase');
    expect(alternative.declaredApiHosts).toEqual(['api.coinbase.com']);
  });

  it('a single-option entry carries NO alternatives seat (google)', async () => {
    const { complete } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Google', slot: 'google', prompt: PROMPT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alternatives).toBeUndefined();
  });
});

describe('P2/AC6 — model-proposed alternatives: validated like the primary, dropped when unfit', () => {
  const primary = {
    slot: 'x',
    provider: { name: 'TideGauge' },
    kind: 'oauth2_auth_code',
    endpoints: { authorizeUrl: 'https://auth.tidegauge.example/a', tokenUrl: 'https://auth.tidegauge.example/t' },
    declaredApiHosts: ['api.tidegauge.example'],
  };
  const validAlternative = {
    slot: 'x',
    provider: { name: 'TideGauge' },
    kind: 'bearer_token',
    fields: [{ key: 'token', label: 'Access token', type: 'secret' }],
    declaredApiHosts: ['api.tidegauge.example'],
  };

  function replyWith(alternatives: unknown[]): string {
    return JSON.stringify({ requirement: primary, confidence: 0.8, evidence: [], alternatives });
  }

  async function inferWithReply(reply: string) {
    const inferrer = createConnectionRequirementInferrer({ complete: async () => reply });
    return inferrer.infer({ providerName: 'TideGauge', slot: 'tidegauge', prompt: PROMPT });
  }

  it('a valid alternative survives, with the HOST\'s slot and provider name overriding the echo', async () => {
    const result = await inferWithReply(replyWith([{ ...validAlternative, slot: 'model-chosen', provider: { name: 'Evil Rename' } }]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives![0]!.slot).toBe('tidegauge');
    expect(result.alternatives![0]!.provider.name).toBe('TideGauge');
    expect(result.alternatives![0]!.kind).toBe('bearer_token');
  });

  it('unparseable and over-reaching alternatives are DROPPED, never fatal (fail-soft, D5)', async () => {
    const overreaching = {
      ...validAlternative,
      // userLayer is registry-synthesized only — admission refuses it on 'inference'.
      userLayer: {
        kind: 'oauth2_auth_code',
        endpoints: { authorizeUrl: 'https://evil.example/a', tokenUrl: 'https://evil.example/t' },
        declaredApiHosts: ['evil.example'],
      },
    };
    // The valid one sits INSIDE the ≤3 bound — the bound slices before validation,
    // so a valid candidate in position 4 would be (correctly) never considered.
    const result = await inferWithReply(replyWith(['garbage', overreaching, validAlternative, { nonsense: true }]));
    expect(result.ok, 'bad alternatives must never fail the turn').toBe(true);
    if (!result.ok) return;
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives![0]!.kind).toBe('bearer_token');
  });

  it('the bound holds: at most 3 alternatives are even considered', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({
      ...validAlternative,
      fields: [{ key: `token_${index}`, label: `Token ${index}`, type: 'secret' }],
    }));
    const result = await inferWithReply(replyWith(many));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.alternatives ?? []).length).toBeLessThanOrEqual(3);
  });

  it('no alternatives key ⇒ behavior byte-identical to today (regression)', async () => {
    const result = await inferWithReply(JSON.stringify({ requirement: primary, confidence: 0.8, evidence: [] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.alternatives).toBeUndefined();
  });
});

describe('AC6 — aliases are human-authored ONLY; lookalikes fall through', () => {
  it("'Coinbase Pro' resolves to the Coinbase entry with its real kind and fields", async () => {
    const { complete, calls } = recordingComplete();
    const inferrer = createConnectionRequirementInferrer({ complete });
    const result = await inferrer.infer({ providerName: 'Coinbase Pro', slot: 'coinbase', prompt: PROMPT });
    expect(calls.length).toBe(0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toBe('registry');
    expect(result.requirement?.kind).toBe('api_key');
    expect(result.requirement?.provider.name, 'the PINNED display name, never the near-miss').toBe('Coinbase');
    expect(result.requirement?.fields?.map((field) => field.key)).toEqual(['api_key', 'api_secret', 'passphrase']);
  });

  it("'Cooinbase' and 'Sp0tify' do NOT match — ADR-0017's lookalike posture is pinned, not reopened", async () => {
    for (const lookalike of ['Cooinbase', 'Sp0tify']) {
      const { complete, calls } = recordingComplete();
      const inferrer = createConnectionRequirementInferrer({ complete });
      const result = await inferrer.infer({ providerName: lookalike, slot: 'x', prompt: PROMPT });
      expect(calls.length, `${lookalike} must fall through to inference`).toBe(1);
      expect(result.provenance).toBe('inference');
    }
  });
});
