// TASK-20261023-siwc-chatgpt-plan L0 (plan §2, D5, F6): the L1↔L2 seam. `BearerSource`
// lives HERE because adapters cannot depend on auth; the auth keeper is adapted to it in the
// playground (L4). The four host-level codes are strings apps may see — R5: an app renders an
// unknown code as HOST_ERROR honouring `retryable` — so their VALUES are pinned, not just
// their keys.
import { describe, expect, expectTypeOf, it } from 'vitest';

import { CHATGPT_ERROR_CODES, type BearerFailureCode, type BearerResult, type BearerSource, type ChatgptErrorCode } from '../index.js';

describe('L0 — CHATGPT_* codes (D5): named results, never a reroute', () => {
  it('pins the four wire strings', () => {
    expect(CHATGPT_ERROR_CODES).toEqual({
      SIGN_IN_NEEDED: 'CHATGPT_SIGN_IN_NEEDED',
      PLAN_NOT_GRANTED: 'CHATGPT_PLAN_NOT_GRANTED',
      USAGE_LIMIT: 'CHATGPT_USAGE_LIMIT',
      USAGE_UNAVAILABLE: 'CHATGPT_USAGE_UNAVAILABLE',
    });
  });

  it('every value is upper-snake and CHATGPT_-prefixed (the host-level namespace apps classify as HOST_ERROR)', () => {
    for (const code of Object.values(CHATGPT_ERROR_CODES)) expect(code).toMatch(/^CHATGPT_[A-Z_]+$/);
  });

  it('the union type is exactly the four values', () => {
    expectTypeOf<ChatgptErrorCode>().toEqualTypeOf<
      'CHATGPT_SIGN_IN_NEEDED' | 'CHATGPT_PLAN_NOT_GRANTED' | 'CHATGPT_USAGE_LIMIT' | 'CHATGPT_USAGE_UNAVAILABLE'
    >();
  });
});

describe('L0 — BearerSource / BearerResult (§2): the seam the Responses adapter is built against', () => {
  it('a conforming source type-checks: get, refresh(stale) and redact(text)', async () => {
    const source: BearerSource = {
      get: async () => ({ ok: true, token: 'eyJ.a.b' }),
      refresh: async (stale) => (stale === 'eyJ.a.b' ? { ok: true, token: 'eyJ.c.d' } : { ok: false, code: 'sign_in_needed', retryable: false }),
      redact: (text) => text.replaceAll('eyJ.a.b', '***'),
    };
    expect(await source.get()).toEqual({ ok: true, token: 'eyJ.a.b' });
    expect(await source.refresh('eyJ.a.b')).toEqual({ ok: true, token: 'eyJ.c.d' });
    expect(await source.refresh('other')).toEqual({ ok: false, code: 'sign_in_needed', retryable: false });
    expect(source.redact('bearer eyJ.a.b here')).toBe('bearer *** here');
  });

  it('the failure codes are the five the keeper can answer with; a failure never carries a token', () => {
    expectTypeOf<BearerFailureCode>().toEqualTypeOf<'sign_in_needed' | 'plan_not_granted' | 'usage_unavailable' | 'network' | 'refresh_not_ready'>();
    expectTypeOf<Extract<BearerResult, { ok: false }>>().not.toHaveProperty('token');
    expectTypeOf<Extract<BearerResult, { ok: true }>>().toHaveProperty('token');
  });
});
