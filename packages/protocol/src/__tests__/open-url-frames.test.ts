// TASK-20260818-ledger-starter Phase C (ADR-0038 D5): the `open-url` frames.
//
// THE CAPABILITY IN ONE SENTENCE: an app may REQUEST that the host open an https URL
// in the user's real browser; the host shows the full URL in a confirm dialog and only
// a user gesture opens anything. The frames are PUBLISHED since spec v0.3 (owner ask
// 2026-08-20, TASK-20260820-spec-v03-whitepaper — in the json-schemas SOURCES alongside
// the net pair); the `openUrl` capability flag on host-ready was published earlier and is
// tested in frames.test.ts's neighbourhood. Regenerate via gen:schemas.
//
// C2 IS UNTOUCHED and these tests pin the frame-level half of why: the request carries
// a URL and nothing else — no target window, no features string, no navigation
// primitive. Refusals here are the schema's; the runner adds the capability gate and
// the playground adds the human.

import { describe, expect, it } from 'vitest';

import { FRAME_TYPES } from '../constants.js';
import { openUrlRequestSchema, openUrlResultSchema } from '../frames.js';

const base = {
  v: 1,
  type: FRAME_TYPES.openUrlRequest,
  requestId: 'r1',
  instanceId: 'i1',
} as const;

describe('snug:open-url-request', () => {
  it('accepts a plain https URL', () => {
    const parsed = openUrlRequestSchema.safeParse({ ...base, url: 'https://example.com/account/cancel' });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it('REFUSES a non-https URL — every scheme, not just http', () => {
    for (const url of [
      'http://example.com/cancel',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'snug-connection://simplefin/accounts',
    ]) {
      const parsed = openUrlRequestSchema.safeParse({ ...base, url });
      expect(parsed.success, `${url} must refuse`).toBe(false);
    }
  });

  it('REFUSES a URL carrying userinfo — a credential-shaped opener is phishing bait', () => {
    const parsed = openUrlRequestSchema.safeParse({ ...base, url: 'https://user:pass@example.com/' });
    expect(parsed.success).toBe(false);
  });

  it('REFUSES an unparseable URL and an oversized one', () => {
    expect(openUrlRequestSchema.safeParse({ ...base, url: 'not a url' }).success).toBe(false);
    expect(openUrlRequestSchema.safeParse({ ...base, url: 'https://e.com/' + 'a'.repeat(3000) }).success).toBe(false);
  });

  it('is STRICT — no extra seats can ride the frame (no window features, no target)', () => {
    const parsed = openUrlRequestSchema.safeParse({
      ...base,
      url: 'https://example.com/',
      target: '_top',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('snug:open-url-result', () => {
  it('accepts each of the three outcomes', () => {
    for (const status of ['opened', 'declined', 'refused'] as const) {
      const parsed = openUrlResultSchema.safeParse({
        v: 1,
        type: FRAME_TYPES.openUrlResult,
        requestId: 'r1',
        status,
      });
      expect(parsed.success, status).toBe(true);
    }
  });

  it('refused may carry a reason; opened/declined stay bare (nothing to explain)', () => {
    const refused = openUrlResultSchema.safeParse({
      v: 1,
      type: FRAME_TYPES.openUrlResult,
      requestId: 'r1',
      status: 'refused',
      reason: 'this app does not have the open-url capability',
    });
    expect(refused.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const parsed = openUrlResultSchema.safeParse({
      v: 1,
      type: FRAME_TYPES.openUrlResult,
      requestId: 'r1',
      status: 'navigated',
    });
    expect(parsed.success).toBe(false);
  });
});
