// TASK-20261023-siwc-chatgpt-plan L0 (AC8, plan D6): `isModelId` moves to the browser-safe
// adapters package so the playground can validate a model id at the settings boundary (C5)
// without importing the Node-only host runner. The runner keeps its own copy for now
// (migration queued); this parity test reads that copy's SOURCE so the two cannot drift
// unnoticed — and needs no dependency edge between the two packages to do it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MODEL_ID_PATTERN, isModelId } from '../index.js';

describe('L0 — isModelId (AC8): leading alnum, no whitespace or control characters, bounded', () => {
  it('accepts the ids the plan route and the other brains actually use', () => {
    for (const id of ['gpt-6.1-sol', 'gpt-5.1-codex', 'claude-sonnet-4-5', 'llama3.2', 'o3', 'qwen2.5:7b', 'm[1]']) {
      expect(isModelId(id), id).toBe(true);
    }
  });

  it('refuses non-strings, empties, a leading symbol, whitespace, control characters and slashes', () => {
    for (const bad of [undefined, null, 42, '', '-gpt', ' gpt', 'gpt 4', 'gpt\n4', 'gpt\u00004', 'a/b', '../x', 'gpt;drop']) {
      expect(isModelId(bad), String(bad)).toBe(false);
    }
  });

  it('is bounded at 200 characters', () => {
    expect(isModelId(`a${'b'.repeat(199)}`)).toBe(true);
    expect(isModelId(`a${'b'.repeat(200)}`)).toBe(false);
  });

  it('narrows the type (a type guard, not a boolean)', () => {
    const value: unknown = 'gpt-6.1-sol';
    if (isModelId(value)) {
      const upper: string = value.toUpperCase();
      expect(upper).toBe('GPT-6.1-SOL');
    } else {
      throw new Error('unreachable');
    }
  });

  it('PARITY — the host runner’s `MODEL_ID` regex source is byte-identical to this one (migration queued)', () => {
    const brainSource = readFileSync(join(__dirname, '../../../../apps/host-mcp/src/brains/brain.ts'), 'utf8');
    const match = /^const MODEL_ID = \/(.+)\/;$/m.exec(brainSource);
    expect(match?.[1], 'the runner still declares `const MODEL_ID = /…/;` on one line').toBeDefined();
    expect(MODEL_ID_PATTERN.source).toBe(match?.[1]);
  });
});
