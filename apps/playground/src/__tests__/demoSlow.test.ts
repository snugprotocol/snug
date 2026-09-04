// demoSlow.test.ts — the `?demoslow=<ms>` e2e pacing seam (TASK-20260903 AC10).
//
// The seam exists so a real browser can watch a demo build IN FLIGHT; it must be
// absent by default, bounded, and pass the request through untouched when it fires.

import { describe, expect, it } from 'vitest';

import type { AgentAdapter } from '@snugprotocol/adapters';

import { DEMO_SLOW_MAX_MS, demoSlowMs, paced } from '../agent/adapter.js';

describe('demoSlowMs', () => {
  it('is 0 without the flag, on junk, and on non-positive values', () => {
    expect(demoSlowMs('')).toBe(0);
    expect(demoSlowMs('?demoreq=starter-x')).toBe(0);
    expect(demoSlowMs('?demoslow=')).toBe(0);
    expect(demoSlowMs('?demoslow=abc')).toBe(0);
    expect(demoSlowMs('?demoslow=0')).toBe(0);
    expect(demoSlowMs('?demoslow=-5')).toBe(0);
  });

  it('reads the flag and caps it', () => {
    expect(demoSlowMs('?demoslow=1500')).toBe(1500);
    expect(demoSlowMs('?a=1&demoslow=250.7')).toBe(251);
    expect(demoSlowMs(`?demoslow=${DEMO_SLOW_MAX_MS * 10}`)).toBe(DEMO_SLOW_MAX_MS);
  });
});

describe('paced', () => {
  const inner: AgentAdapter = {
    complete: async (request) => ({ ok: true, text: `saw ${request.messages.length}`, toolCalls: [], stopReason: 'end' }),
  };

  it('returns the very same adapter when there is nothing to pace', () => {
    expect(paced(inner, 0)).toBe(inner);
  });

  it('waits, then passes the request through untouched', async () => {
    const started = performance.now();
    const result = await paced(inner, 30).complete({ system: '', messages: [{ role: 'user', content: 'hi' }] });
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    expect(result).toMatchObject({ ok: true, text: 'saw 1' });
  });
});
