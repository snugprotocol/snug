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

import { docsTripwire, runWizardInference, __setWizardHooksForTests } from '../state/wizard.js';
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
              provider: { name: 'Coinbase Exchange' },
              kind: 'api_key',
              fields: [{ key: 'api_key', label: 'API Key', type: 'text', required: true }],
              declaredApiHosts: ['api.exchange.coinbase.com'],
            },
            confidence: 0.8,
            evidence: [],
          }),
        );
      },
    });

    await inferrer.infer({
      providerName: 'Coinbase Exchange',
      slot: 'coinbase',
      prompt: 'INFER the connection requirement for Coinbase Exchange.',
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
      providerName: 'Coinbase Exchange',
      slot: 'coinbase',
      prompt: 'INFER',
      credentials: { api_secret: REAL_API_SECRET },
    } as unknown as Parameters<typeof inferrer.infer>[0]);

    expect(seen.join('\n')).not.toContain(REAL_API_SECRET);
    expect(JSON.stringify(result)).not.toContain(REAL_API_SECRET);
  });
});

describe('P2-AC7(b) — the docs-paste tripwire STILL fires before the completion seam (D10/M2, unchanged by P2)', () => {
  it('a pasted credential blocks the call: the seam is never invoked', async () => {
    const runInference = vi.fn();
    __setWizardHooksForTests({ runInference });

    const outcome = await runWizardInference({
      providerName: 'Coinbase Exchange',
      docsText: `Authorization: Bearer sk-live-${REAL_PASSPHRASE}abcdef1234567890`,
    });

    expect(outcome).toEqual({ blocked: 'tripwire' });
    expect(runInference, 'the completion seam ran despite the tripwire').not.toHaveBeenCalled();
    __setWizardHooksForTests({});
  });

  it('the tripwire patterns themselves still catch the shapes P2 must not regress', () => {
    expect(docsTripwire(`the secret is ${REAL_API_SECRET}`)).toBe(true);
    expect(docsTripwire('ghp_abcdefghijklmnop1234567890abcdef')).toBe(true);
    // ...and ordinary provider docs stay clean, so the warning keeps its meaning.
    expect(docsTripwire('Pass your API key in the CB-ACCESS-KEY header. Requests go to https://api.exchange.coinbase.com.')).toBe(false);
  });
});
