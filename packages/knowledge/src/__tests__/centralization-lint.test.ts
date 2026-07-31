// AC-3: centralization lint — no LLM-bound prompt text outside the store.
// Heuristic (per ADR-0004): template literals > 400 chars carrying prompt markers in
// packages/*/src and apps/*/src, excluding the knowledge package and test files.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { repoRoot, walkFiles } from './helpers.js';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PROMPT_MARKER = /You are|MUST respond|CRITICAL|system prompt/i;
const MAX_LITERAL_CHARS = 400;
// Handles escaped backticks; nested ${`...`} interpolation is beyond the heuristic.
const TEMPLATE_LITERAL = /`(?:[^`\\]|\\[\s\S])*`/g;

function srcDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (group === 'packages' && entry.name === 'knowledge') continue; // the store itself
      const src = path.join(groupDir, entry.name, 'src');
      if (existsSync(src)) dirs.push(src);
    }
  }
  return dirs;
}

describe('centralization lint (ADR-0004)', () => {
  it('no long prompt-marker template literal lives outside packages/knowledge', () => {
    const violations: string[] = [];
    for (const dir of srcDirs()) {
      for (const abs of walkFiles(dir)) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        if (!CODE_EXTENSIONS.has(path.extname(abs))) continue;
        if (rel.includes('__tests__') || /\.test\./.test(path.basename(abs))) continue;
        const text = readFileSync(abs, 'utf8');
        for (const literal of text.match(TEMPLATE_LITERAL) ?? []) {
          if (literal.length > MAX_LITERAL_CHARS && PROMPT_MARKER.test(literal)) {
            violations.push(
              `${rel}: ${literal.length}-char template literal with prompt markers — move it into packages/knowledge/prompts/`,
            );
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
