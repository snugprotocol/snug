// AC-9 support: the committed generated module must equal a fresh regeneration —
// editing prompts/ without running `pnpm gen:content` (or build) fails here.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Scripts are plain .mjs (no d.ts); vitest executes them fine.
// eslint-disable-next-line import/no-relative-packages
// @ts-ignore — untyped codegen module (test layer only)
import { buildChecksumManifestSource, buildContentModuleSource, collectPromptFiles, EXCLUDED_FROM_CONTENT } from '../../scripts/gen-content.mjs';

import { generatedDir } from './helpers.js';

describe('generated content drift', () => {
  it('src/generated/content.ts equals a fresh regeneration from prompts/', () => {
    const committedPath = path.join(generatedDir, 'content.ts');
    expect(existsSync(committedPath), 'src/generated/content.ts missing — run `pnpm gen:content`').toBe(true);
    const committed = readFileSync(committedPath, 'utf8');
    expect(committed).toBe(buildContentModuleSource());
  });

  it('src/generated/skill-creator.sha256.json equals a fresh regeneration', () => {
    const committedPath = path.join(generatedDir, 'skill-creator.sha256.json');
    expect(
      existsSync(committedPath),
      'src/generated/skill-creator.sha256.json missing — run `pnpm gen:content`',
    ).toBe(true);
    const committed = readFileSync(committedPath, 'utf8');
    expect(committed).toBe(buildChecksumManifestSource());
  });
});

describe('the Snug skill source stays OUT of content.ts (ADR-0069 §7)', () => {
  it('names the exclusion, and the exclusion is the skill', () => {
    expect(EXCLUDED_FROM_CONTENT).toContain('skills/snug/');
  });

  it('the skill SOURCE exists on disk — the exclusion must hide a real file, not vouch for nothing', () => {
    expect(existsSync(path.join(generatedDir, '..', '..', 'prompts', 'skills', 'snug', 'SKILL.md'))).toBe(true);
  });

  it('a fresh regeneration carries no skills/snug/ key, so no runtime bundle can import it', () => {
    expect(collectPromptFiles().some((f: { rel: string }) => f.rel.startsWith('skills/snug/'))).toBe(false);
    expect(buildContentModuleSource()).not.toContain('skills/snug/');
  });
});
