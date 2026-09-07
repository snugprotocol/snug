// binding-a-rules.test.ts — TASK-20260905-binding-a-artifacts AC11: the two rules an app
// bound for a Claude artifact must carry in the knowledge base (the skill's `references/`):
// the artifact viewer's NARROWER CDN allowlist (a loading rule, never a safety claim), and
// "never think on a timer" (every agent call is a user act; a host may bill the viewer).
// Asserted on the prompt sources; content-drift.test.ts keeps the generated module honest.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { promptsDir } from './helpers.js';

const read = (...parts: string[]): string => readFileSync(path.join(promptsDir, ...parts), 'utf8');
const cdn = (): string => read('knowledge-base', 'app-authoring', '80-cdn-compatibility.md');
const overview = (): string => read('knowledge-base', 'app-authoring', '10-overview-and-contract.md');

describe('the artifact allowlist rule (AC11)', () => {
  it('names the two hosts that load inside an artifact and the ones that do not, and inline CSS/fonts', () => {
    const text = cdn();
    expect(text).toMatch(/## Inside a Claude Artifact/);
    expect(text).toContain('https://cdn.jsdelivr.net/npm/');
    expect(text).toContain('https://cdnjs.cloudflare.com/');
    expect(text).toMatch(/never unpkg, never `\/gh\/`/);
    expect(text).toMatch(/no CDN stylesheet\s+or font/i);
    expect(text).toMatch(/snug-embed --strict/);
  });
  it('says outright that the rule is about loading, not safety (R-21)', () => {
    expect(cdn()).toMatch(/whether the app LOADS, not whether it is safe/);
  });
});

describe('never think on a timer (AC11)', () => {
  it('the CDN page carries the rule with its reason, and the overview points at it beside the request loop', () => {
    const text = cdn();
    expect(text).toMatch(/## Never Think on a Timer/);
    expect(text).toMatch(/setInterval/);
    expect(text).toMatch(/on load/);
    expect(text).toMatch(/bill/);
    expect(overview()).toMatch(/never send one from a timer, an interval, or on load/);
  });
});
