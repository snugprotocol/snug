// scrub.test.ts — TASK-20261009-scheduling-framework (ADR-0074 §6; security F12; Gate-5 PR-B
// M15): the reply-side C1 wall has ONE home, `schedule/scrub.ts`. Two named policies, because
// the two seats that apply it are pinned to different answers for the same text:
//   `store`   — what lands in the file (`executors.finalizeOutcome`): a text that LOOKS like a
//               credential as received is WITHHELD whole; what survives is shape-scrubbed.
//   `deliver` — what the hidden frame reads back (`scheduledTransport`): the text is
//               shape-scrubbed first, and withheld only when it STILL looks like a credential,
//               so the app keeps a usable answer with the token redacted.
// Plus `countsAsAiCall`: the one rule for what a send charges (F15's `CONSENT_REQUIRED` refused
// before anything left the page, so it is not a call) — `appThink` and the transport agree.
import { ERROR_CODES } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import { countsAsAiCall, scrubOrWithhold } from '../schedule/scrub.js';

const BEARER_PROSE = 'use the header Authorization: Bearer sk-abc123DEF456ghi789JKL012mno345pqr678 for the call';
const USERINFO_URL = 'use https://alice:hunter2@api.example.com/v1 next time';
const TOKEN_RUN = `the echo was ${'A1'.repeat(30)} and that is all`;

describe('scrubOrWithhold — store (what the file keeps)', () => {
  it('withholds whole a text that looks like a credential as received, whatever the scrub could have done', () => {
    expect(scrubOrWithhold(BEARER_PROSE, 'store')).toBeUndefined();
    expect(scrubOrWithhold(USERINFO_URL, 'store')).toBeUndefined();
    expect(scrubOrWithhold('try ghp_0123456789abcdefghijABCDEFGHIJ next', 'store')).toBeUndefined();
  });

  it('shape-scrubs prose that is not refused outright and keeps the rest; a clean text is itself; empty stays empty', () => {
    expect(scrubOrWithhold(TOKEN_RUN, 'store')).toBe('the echo was «redacted» and that is all');
    expect(scrubOrWithhold('sunny, 18°', 'store')).toBe('sunny, 18°');
    expect(scrubOrWithhold('', 'store')).toBe('');
  });
});

describe('scrubOrWithhold — deliver (what the app reads back)', () => {
  it('scrubs first: a bearer token in prose is redacted and the prose kept', () => {
    const text = scrubOrWithhold(BEARER_PROSE, 'deliver');
    expect(text).toBe('use the header Authorization: Bearer «redacted» for the call');
    expect(text).not.toContain('sk-abc123DEF456ghi789JKL012mno345pqr678');
  });

  it('withholds only what STILL looks like a credential after the scrub (a userinfo URL the scrub leaves alone)', () => {
    expect(scrubOrWithhold(USERINFO_URL, 'deliver')).toBeUndefined();
  });

  it('a clean text is itself', () => {
    expect(scrubOrWithhold('the forecast is sunny', 'deliver')).toBe('the forecast is sunny');
  });
});

describe('countsAsAiCall — the one rule for what a send charges', () => {
  it('an ok reply is a call; a failure that reached the brain is a call; CONSENT_REQUIRED (refused before the send) is not', () => {
    expect(countsAsAiCall({ ok: true, text: 'hi' })).toBe(true);
    expect(countsAsAiCall({ ok: false, code: ERROR_CODES.NETWORK_ERROR, message: 'offline', retryable: true })).toBe(true);
    expect(countsAsAiCall({ ok: false, code: ERROR_CODES.CANCELLED, message: 'cancelled', retryable: false })).toBe(true);
    expect(countsAsAiCall({ ok: false, code: ERROR_CODES.CONSENT_REQUIRED, message: 'confirm the endpoint first', retryable: false })).toBe(false);
  });
});
