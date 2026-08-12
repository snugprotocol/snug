// TASK-20260810-p2-pipeline (Dynamic Auth v2, P2) AC7 — INFERENCE NEVER SEES CREDENTIALS
// (C1, structural).
//
// The claim is STRUCTURAL, not incidental, and stating why matters more than the asserts:
// inference runs at BUILD time, BEFORE any credential exists. There is no ordering in
// which a credential could be available to hand to it. So the tests below do not merely
// check that today's call site forgot to pass one — they pin the two things that would
// have to be true for the structure to hold:
//
//   1. The requirement-inferrer's INPUT TYPE has no seat a credential could occupy, and
//      the value handed to the completion seam carries no credential bytes even when the
//      user's own DB is full of them (planted canaries, byte-probed).
//   2. The docs-paste tripwire still fires BEFORE the completion seam is invoked — the
//      one path by which a real credential can reach an LLM is a user PASTING one into
//      the docs box, and `docsText` transits to the BYOK provider by design (D10/M2).
//
// P2 re-prompts the inferrer to emit full requirements rather than hints, which moves the
// prompt and the output contract. This file is the guard that the move does not quietly
// widen the input.
//
// Written RED-FIRST at Gate 3 against `packages/auth`'s requirement-inferrer seam, which
// does not exist yet.

import { describe, expect, it, vi } from 'vitest';
import { createConnectionRequirementInferrer } from '@snugprotocol/auth';

import { docsTripwire, runConnectionRequirementInferenceGuarded } from '../agent/connectionInferrerAdapter.js';
import { installTestUserDb } from './userdbTestHelper.js';

/** Credential-shaped canaries. Never `'x'` — a probe for `'x'` proves nothing. */
const REAL_API_KEY = 'ck-live-9f3a7c21b4e05d68a1f2c3b4d5e6f708';
const REAL_API_SECRET = 'AbCdEf0123456789+/aBcDeF9876543210ZmNoPqRsTuVwXyZ01234567==';
const REAL_PASSPHRASE = 'correct-horse-battery-staple-4417';

describe('P2-AC7(a) — the requirement inferrer is handed no credential, structurally', () => {
  it('the completion seam receives no credential bytes even when the user DB holds real ones', async () => {
    const db = await installTestUserDb();
    // Plant real credentials for an ALREADY-connected app. If the inferrer's input were
    // ever assembled from app state rather than from the build conversation, this is the
    // shape that would ride along.
    db.setSecret('auth:other-app:coinbase:api_key', REAL_API_KEY);
    db.setSecret('auth:other-app:coinbase:api_secret', REAL_API_SECRET);
    db.setSecret('auth:other-app:coinbase:passphrase', REAL_PASSPHRASE);

    const seen: string[] = [];
    const inferrer = createConnectionRequirementInferrer({
      complete: (prompt: string) => {
        seen.push(prompt);
        return Promise.resolve(
          JSON.stringify({
            requirement: {
              slot: 'coinbase',
              provider: { name: 'Meridian Exchange' },
              kind: 'api_key',
              fields: [{ key: 'api_key', label: 'API Key', type: 'text', required: true }],
              declaredApiHosts: ['api.meridian-exchange.example'],
            },
            confidence: 0.8,
            evidence: [],
          }),
        );
      },
    });

    await inferrer.infer({
      providerName: 'Meridian Exchange',
      slot: 'coinbase',
      prompt: 'INFER the connection requirement for Meridian Exchange.',
    });

    const wire = seen.join('\n');
    expect(wire).not.toContain(REAL_API_KEY);
    expect(wire).not.toContain(REAL_API_SECRET);
    expect(wire).not.toContain(REAL_PASSPHRASE);
    await db.close();
  });

  it("the input type carries no credential seat: passing one is a rejection, not a passthrough", async () => {
    const seen: string[] = [];
    const inferrer = createConnectionRequirementInferrer({
      complete: (prompt: string) => {
        seen.push(prompt);
        return Promise.resolve('{"requirement":null,"confidence":0,"evidence":[]}');
      },
    });

    // The seam must not accept a credential-shaped seat at all. Cast through `unknown`
    // deliberately: this asserts the RUNTIME behaviour a compile error alone would not
    // cover on an imported/synced call path.
    const result = await inferrer.infer({
      providerName: 'Meridian Exchange',
      slot: 'coinbase',
      prompt: 'INFER',
      credentials: { api_secret: REAL_API_SECRET },
    } as unknown as Parameters<typeof inferrer.infer>[0]);

    expect(seen.join('\n')).not.toContain(REAL_API_SECRET);
    expect(JSON.stringify(result)).not.toContain(REAL_API_SECRET);
  });
});

// P3 CUTOVER: the tripwire moved OFF the deleted v3 wizard store and onto the v2
// requirement-inferrer adapter — the surface that now owns the pasted-docs rung. The
// guarantee is unchanged and is why it was rehomed rather than deleted with its old
// host: `docsText` transits to the user's BYOK provider by design, so this is the last
// moment to catch an accidental secret, and it must fire BEFORE the seam is invoked.
describe('P2-AC7(b) — the docs-paste tripwire STILL fires before the completion seam (D10/M2)', () => {
  it('a pasted credential blocks the call: the seam is never invoked', async () => {
    const complete = vi.fn();
    const adapter = { complete } as unknown as Parameters<
      typeof runConnectionRequirementInferenceGuarded
    >[0]['adapter'];

    const outcome = await runConnectionRequirementInferenceGuarded({
      providerName: 'Meridian Exchange',
      slot: 'coinbase',
      docsText: `Authorization: Bearer sk-live-${REAL_PASSPHRASE}abcdef1234567890`,
      ...(adapter !== undefined ? { adapter } : {}),
    });

    expect(outcome).toEqual({ blocked: 'tripwire' });
    expect(complete, 'the completion seam ran despite the tripwire').not.toHaveBeenCalled();
  });

  it('the tripwire patterns themselves still catch the shapes P2 must not regress', () => {
    expect(docsTripwire(`the secret is ${REAL_API_SECRET}`)).toBe(true);
    expect(docsTripwire('ghp_abcdefghijklmnop1234567890abcdef')).toBe(true);
    // ...and ordinary provider docs stay clean, so the warning keeps its meaning.
    expect(docsTripwire('Pass your API key in the CB-ACCESS-KEY header. Requests go to https://api.meridian-exchange.example.')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P3 fold — the REGISTRY rung must not be gated behind a live model
// ---------------------------------------------------------------------------

describe('P3 fold — a PINNED provider resolves with no model configured at all', () => {
  /**
   * FOUND BY EXECUTION, not by reading. This adapter's own doc comment says "the registry
   * rung short-circuits inside the inferrer and never touches the seam at all, so a
   * well-known provider costs no tokens" — but the adapter resolved a LIVE ADAPTER first
   * and returned `completion_failed` when there was none, so the inferrer was never
   * reached and the registry rung never ran. On the demo brain (or any keyless
   * configuration), recovering a connection to Spotify — a provider WE pin, whose whole
   * requirement is a constant in this repo — failed with "needs a bring-your-own-key
   * model". That is a wrong refusal: nothing about answering from the registry needs a
   * model, and the user was told to go buy one to get a value we already had.
   *
   * The ordering fix is what makes the doc comment true: the adapter is now resolved
   * LAZILY, inside the completion seam, so it is demanded only if a rung actually reaches
   * the model. A keyless configuration still fails honestly for an UNPINNED provider —
   * asserted below, because a fix that swallowed that failure would be worse than the bug.
   */
  it('resolves Spotify from the pinned registry with no key and no live adapter', async () => {
    await installTestUserDb(); // no byok key stored; provider defaults to the mock brain
    // 'spotify', not 'api.spotify.com' — the recovery path derives the RECOGNIZABLE label
    // host-side (`slotFromHost`) precisely because the registry normalizes its key to
    // alphanumerics and a raw host would match nothing. Passing the host here is what the
    // production wire used to do, and it is what silently disabled this rung.
    const outcome = await runConnectionRequirementInferenceGuarded({
      providerName: 'spotify',
      slot: 'spotify',
    });

    expect(outcome.blocked).toBeUndefined();
    if (outcome.blocked !== undefined) return;
    const { result } = outcome;
    expect(result.ok, `a pinned provider must not need a model: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    expect(result.provenance).toBe('registry');
    expect(result.requirement?.provider.name).toMatch(/spotify/i);
    expect(result.requirement?.declaredApiHosts).toContain('api.spotify.com');
  });

  it('an UNPINNED provider with no model still fails honestly — the fix must not swallow that', async () => {
    await installTestUserDb();
    const outcome = await runConnectionRequirementInferenceGuarded({
      providerName: 'api.some-obscure-service.example',
      slot: 'obscure',
    });

    expect(outcome.blocked).toBeUndefined();
    if (outcome.blocked !== undefined) return;
    const { result } = outcome;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('completion_failed');
    // The copy must still name the actual repair — a keyless user needs to know why.
    expect(result.message).toMatch(/bring-your-own-key|provider key|local model/i);
  });
});
