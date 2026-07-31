// AC-6: the vendored Anthropic skill-creator is verbatim, commit-pinned, and
// checksum-locked by the committed manifest; attribution files ride along.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { getSkillCreatorFile, listSkillCreatorFiles } from '../index.js';
import { generatedDir, promptsDir, walkFiles } from './helpers.js';

const vendoredDir = path.join(promptsDir, 'skills', 'skill-creator');
const manifestPath = path.join(generatedDir, 'skill-creator.sha256.json');

function diskManifest(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const abs of walkFiles(vendoredDir)) {
    const rel = path.relative(vendoredDir, abs).split(path.sep).join('/');
    out[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
  }
  return out;
}

describe('vendored skill-creator', () => {
  it('exists with SKILL.md, LICENSE.txt, and NOTICE.md carrying a pinned upstream commit', () => {
    expect(existsSync(vendoredDir), 'prompts/skills/skill-creator/ missing').toBe(true);
    expect(existsSync(path.join(vendoredDir, 'SKILL.md')), 'SKILL.md missing').toBe(true);
    expect(existsSync(path.join(vendoredDir, 'LICENSE.txt')), 'LICENSE.txt missing').toBe(true);
    const noticePath = path.join(vendoredDir, 'NOTICE.md');
    expect(existsSync(noticePath), 'NOTICE.md missing').toBe(true);
    const notice = readFileSync(noticePath, 'utf8');
    expect(notice, 'NOTICE.md must pin the upstream commit (40-hex sha)').toMatch(/\b[0-9a-f]{40}\b/);
  });

  it('committed sha256 manifest matches the vendored tree exactly (set + values)', () => {
    expect(existsSync(manifestPath), 'manifest missing — run `pnpm gen:content`').toBe(true);
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>;
    const actual = diskManifest();
    expect(Object.keys(actual).length).toBeGreaterThan(0);
    expect(committed).toEqual(actual);
  });

  it('loader exposes every vendored file VERBATIM (byte-identical to disk)', () => {
    // The content module carries the prompt extensions; the manifest hashes everything.
    const STORE_EXTENSIONS = new Set(['.md', '.txt', '.py', '.html', '.json']);
    const relPaths = walkFiles(vendoredDir)
      .filter((abs) => STORE_EXTENSIONS.has(path.extname(abs).toLowerCase()))
      .map((abs) => path.relative(vendoredDir, abs).split(path.sep).join('/'));
    expect(relPaths.length).toBeGreaterThan(0);
    for (const rel of relPaths) {
      const onDisk = readFileSync(path.join(vendoredDir, rel), 'utf8');
      expect(getSkillCreatorFile(rel), `${rel} must round-trip verbatim`).toBe(onDisk);
    }
    // And the listing agrees with the disk tree (for extensions the store carries).
    const listed = new Set(listSkillCreatorFiles());
    for (const rel of relPaths) {
      expect(listed.has(rel), `${rel} missing from listSkillCreatorFiles()`).toBe(true);
    }
  });

  it('getSkillCreatorFile throws on unknown paths', () => {
    expect(() => getSkillCreatorFile('nope/missing.md')).toThrowError(/Unknown vendored/);
  });
});
