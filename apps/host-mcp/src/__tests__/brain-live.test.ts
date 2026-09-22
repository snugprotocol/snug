// OPT-IN, against the REAL CLI: `SNUG_LIVE_BRAIN=1 vitest run src/__tests__/brain-live.test.ts`.
//
// Two tiny prompts on the developer's own subscription. What it proves that no fake can:
// the stream-json wire on the installed CLI, and that the second think on the same system
// prompt — served by the pre-warmed child (ADR-0069 §5) — is faster than the first.
// Skipped by default; the gate never runs it.

import { describe, expect, it } from 'vitest';

import { createClaudeBrain, probeBrain } from '../brain-claude.js';

const live = process.env.SNUG_LIVE_BRAIN === '1';

describe.skipIf(!live)('the real CLI (SNUG_LIVE_BRAIN=1)', () => {
  it('answers on the streaming wire, and the pre-warmed second think is faster than the cold first', async () => {
    const probe = await probeBrain();
    expect(probe, 'the live test needs a ready CLI').toMatchObject({ state: 'ready' });

    const brain = createClaudeBrain();
    const system = 'Answer in one word.';
    try {
      const t1 = Date.now();
      const first = await brain.complete({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'Say ok.' }] });
      const firstMs = Date.now() - t1;
      expect(first).toContain('"finish_reason":"stop"');
      expect(first.trimEnd().endsWith('data: [DONE]')).toBe(true);

      // Let the pre-warmed replacement finish its start-up (measured ~2.8 s).
      await new Promise((resolve) => setTimeout(resolve, 3_500));

      const t2 = Date.now();
      const second = await brain.complete({ messages: [{ role: 'system', content: system }, { role: 'user', content: 'Say ok again.' }] });
      const secondMs = Date.now() - t2;
      expect(second).toContain('"finish_reason":"stop"');

      // eslint-disable-next-line no-console
      console.log(`live: first think ${firstMs} ms (cold spawn), second ${secondMs} ms (pre-warmed)`);
      expect(secondMs).toBeLessThan(firstMs);
    } finally {
      brain.stop();
    }
  }, 120_000);
});
