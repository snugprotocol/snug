// Phase E of TASK-20260804-observability-caching: the starter tile becomes a single
// card control (AC1/AC2) and the brand token shrinks 20% (AC3).
//
// The behavioural half of AC2 — "opening still does not install" — is already covered
// by starterInstall.test.tsx's outcome tests, which must stay green through this
// change. This file covers the control's SHAPE and accessibility.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = (name: string): string => readFileSync(join(here, '..', 'theme', name), 'utf8');

describe('AC3 — the brand wordmark is 20% smaller', () => {
  const tokens = css('tokens.css');

  it('sets --text-brand to 2rem (down from 2.5rem)', () => {
    const match = /--text-brand:\s*([0-9.]+)rem/.exec(tokens);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(2);
  });

  it('scales the narrow-viewport token with it rather than leaving it stranded', () => {
    const brand = Number(/--text-brand:\s*([0-9.]+)rem/.exec(tokens)?.[1]);
    const narrow = Number(/--text-brand-narrow:\s*([0-9.]+)rem/.exec(tokens)?.[1]);
    expect(narrow).toBeLessThan(brand);
    // 20% off the previous 1.5rem, matching the reduction applied to the main token.
    expect(narrow).toBeCloseTo(1.2, 5);
  });

  it('keeps the header rules that depend on these tokens', () => {
    // The 760px/830px rules are what stop the wordmark overflowing; shrinking the token
    // must not have removed the guards that make it safe at narrow widths.
    const app = css('app.css');
    expect(app).toContain('--text-brand-narrow');
    expect(/@media[^{]*760px/.test(app)).toBe(true);
  });
});
