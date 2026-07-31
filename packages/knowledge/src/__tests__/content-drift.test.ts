// AC-9 support: the committed generated module must equal a fresh regeneration —
// editing prompts/ without running `pnpm gen:content` (or build) fails here.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Scripts are plain .mjs (no d.ts); vitest executes them fine.
// eslint-disable-next-line import/no-relative-packages
// @ts-ignore — untyped codegen module (test layer only)
import { buildChecksumManifestSource, buildContentModuleSource } from '../../scripts/gen-content.mjs';

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
