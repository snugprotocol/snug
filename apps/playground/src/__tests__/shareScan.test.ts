// shareScan.test.ts — TASK-20260904-app-sharing AC5: the share gate finds credential
// shapes in html and docs as NAMED WARNINGS with a line number, never rewrites, and —
// the finding-3 half — does NOT flag the shipped starters or their docs, because a scan
// that reds on every real app is a scan that gets ignored.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { findCredentialShapes } from '../security/credentialShapes.js';

const examples = join(__dirname, '..', '..', '..', '..', 'examples');

describe('findCredentialShapes — the share scan', () => {
  it('flags a planted key in html AND in a doc, with the line it sits on (positive twins, lesson 2026-08-13)', () => {
    const html = '<html>\n<script>\nconst KEY = "sk-ant-api03-abcdefghijklmnop1234";\n</script>\n</html>';
    const hits = findCredentialShapes(html);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 3, family: 'an API key (sk-…)' });
    expect(hits[0]?.preview.length).toBeLessThanOrEqual(13);
    const doc = '# Lessons\n\nWe used AKIAIOSFODNN7EXAMPLE for the bucket.\n';
    expect(findCredentialShapes(doc)).toEqual([expect.objectContaining({ line: 3, family: 'an AWS access key' })]);
  });

  it('flags a hardcoded credential in a URL and a key/value pair — when the value carries a digit', () => {
    expect(findCredentialShapes("fetch('https://api.example/x?appid=9f8e7d6c5b4a3210')")).toEqual([
      expect.objectContaining({ family: 'a credential in a URL' }),
    ]);
    expect(findCredentialShapes('const apiKey = "Zx9Qw8Er7Ty6Ui5O";')).toEqual([
      expect.objectContaining({ family: 'a key/value credential pair' }),
    ]);
  });

  it('does not flag prose and code that merely TALK about credentials (digit guard on the overlapping alphabets)', () => {
    for (const text of [
      'Basic credentials are entered in the wizard.',
      'the token endpoint returns a bearer token',
      'const apiKey = readFromHost(); // never hardcode it',
      'Authorization: Bearer placeholder',
      'a very long unbroken run without digits: ' + 'abcdefghij'.repeat(8),
      'data:image/png;base64,' + 'A1B2'.repeat(40), // the long-run shape is OFF in share mode
    ]) {
      expect(findCredentialShapes(text), text).toEqual([]);
    }
  });

  it('passes every shipped starter html and every shipped authoring doc clean (finding 3)', () => {
    if (!existsSync(examples)) return;
    const offenders: string[] = [];
    for (const folder of readdirSync(examples, { withFileTypes: true })) {
      if (!folder.isDirectory()) continue;
      const html = join(examples, folder.name, 'app.html');
      if (existsSync(html) && findCredentialShapes(readFileSync(html, 'utf8')).length > 0) offenders.push(`${folder.name}/app.html`);
      const docs = join(examples, folder.name, 'authoring', 'docs');
      if (existsSync(docs)) {
        for (const file of readdirSync(docs)) {
          const hits = findCredentialShapes(readFileSync(join(docs, file), 'utf8'));
          if (hits.length > 0) offenders.push(`${folder.name}/authoring/docs/${file}: ${hits.map((h) => `${h.family}@${h.line}`).join(',')}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
