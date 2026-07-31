// AC-1: every prompt file (except vendored skill-creator/**) carries the mandatory
// 4-field header, and its `layer:` value agrees with the directory it lives in.
import { describe, expect, it } from 'vitest';

import { isVendored, promptFilesOnDisk } from './helpers.js';

const LAYER_VALUES = ['system', 'knowledge-base', 'tool', 'skill', 'template', 'ui'] as const;

/** Top-level prompts/ directory → required `layer:` header value. */
const DIR_TO_LAYER: Record<string, (typeof LAYER_VALUES)[number]> = {
  system: 'system',
  'knowledge-base': 'knowledge-base',
  tools: 'tool',
  skills: 'skill',
  templates: 'template',
  ui: 'ui',
};

// prompts/README.md is the store map for humans/agents, not LLM-bound prompt content.
const EXEMPT = new Set(['README.md']);

function checkedFiles() {
  return promptFilesOnDisk().filter((f) => !isVendored(f.rel) && !EXEMPT.has(f.rel));
}

describe('prompt-store headers', () => {
  it('every non-vendored prompt file starts with the 4-field header comment', () => {
    const violations: string[] = [];
    for (const file of checkedFiles()) {
      if (!file.content.startsWith('<!--')) {
        violations.push(`${file.rel}: does not start with the <!-- header comment`);
        continue;
      }
      const end = file.content.indexOf('-->');
      if (end === -1) {
        violations.push(`${file.rel}: header comment never closes`);
        continue;
      }
      const header = file.content.slice(0, end);
      for (const field of ['layer:', 'destination:', 'blast-radius:', 'source:']) {
        if (!new RegExp(`^${field}`, 'm').test(header)) {
          violations.push(`${file.rel}: header missing "${field}" field`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every header declares a valid layer that matches its directory', () => {
    const violations: string[] = [];
    for (const file of checkedFiles()) {
      const match = /^layer:\s*(\S+)/m.exec(file.content.slice(0, file.content.indexOf('-->')));
      if (!match) continue; // reported by the previous test
      const layer = match[1] as string;
      if (!(LAYER_VALUES as readonly string[]).includes(layer)) {
        violations.push(`${file.rel}: unknown layer "${layer}"`);
        continue;
      }
      const topDir = file.rel.split('/')[0] as string;
      const expected = DIR_TO_LAYER[topDir];
      if (expected !== undefined && layer !== expected) {
        violations.push(`${file.rel}: layer "${layer}" but directory requires "${expected}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
