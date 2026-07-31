// AC-2: no wire literal is ever retyped in prompt sources — sources carry
// {{placeholders}}; the rendered output carries the injected protocol values.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SNUG_APP_REQUEST_TAG } from '@snugprotocol/protocol';

import { APP_BUILDER_TOOL_NAME } from '../index.js';
import { isVendored, packageRoot, promptFilesOnDisk, renderedStore, walkFiles } from './helpers.js';

describe('placeholder integrity — raw prompt sources', () => {
  it('no raw source retypes the envelope tag or the app-builder tool name', () => {
    const violations: string[] = [];
    for (const file of promptFilesOnDisk()) {
      if (isVendored(file.rel)) continue;
      if (file.content.includes(SNUG_APP_REQUEST_TAG)) {
        violations.push(`${file.rel}: contains the envelope-tag literal — use {{envelopeTag}}`);
      }
      if (file.content.includes(APP_BUILDER_TOOL_NAME)) {
        violations.push(`${file.rel}: contains the tool-name literal — use {{appBuilderToolName}}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('sources actually use the injection placeholders', () => {
    const sources = promptFilesOnDisk()
      .filter((f) => !isVendored(f.rel))
      .map((f) => f.content)
      .join('\n');
    expect(sources).toContain('{{envelopeTag}}');
    expect(sources).toContain('{{appBuilderToolName}}');
  });

  it('no raw source retypes a snug: frame-type literal — use {{frameType:<key>}}', () => {
    const violations: string[] = [];
    for (const file of promptFilesOnDisk()) {
      if (isVendored(file.rel)) continue;
      // Remove reserved-namespace wildcard mentions (e.g. `snug:*`) before scanning.
      const scannable = file.content.replace(/snug:[a-z-]*\*/g, '');
      const matches = scannable.match(/snug:[a-z][a-z-]*[a-z]/g) ?? [];
      for (const m of matches) violations.push(`${file.rel}: literal "${m}"`);
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});

describe('placeholder integrity — rendered output', () => {
  it('rendered store contains the injected envelope tag and tool name', () => {
    const rendered = renderedStore()
      .map((e) => e.text)
      .join('\n');
    expect(rendered).toContain(SNUG_APP_REQUEST_TAG);
    expect(rendered).toContain(APP_BUILDER_TOOL_NAME);
  });

  it('rendered store has no unresolved build-time placeholders for known names', () => {
    // Runtime ({{{...}}} in source) placeholders legitimately survive as {{name}};
    // the build-time names must not (they would mean a render path was skipped).
    const rendered = renderedStore();
    for (const entry of rendered) {
      if (entry.file === 'templates/user-identity.md') continue; // raw by design
      expect(entry.text, entry.file).not.toContain('{{envelopeTag}}');
      expect(entry.text, entry.file).not.toContain('{{appBuilderToolName}}');
      expect(entry.text, entry.file).not.toContain('{{cdnAllowlist}}');
      expect(entry.text, entry.file).not.toContain('{{maxArtifactBytes}}');
      expect(entry.text, entry.file).not.toContain('{{frameType:');
    }
  });
});

describe('placeholder integrity — knowledge src', () => {
  it('only render.ts (and generated/tests) may hold the wire literals in this package', () => {
    const srcDir = path.join(packageRoot, 'src');
    const violations: string[] = [];
    for (const abs of walkFiles(srcDir)) {
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      if (rel === 'render.ts' || rel.startsWith('__tests__/') || rel.startsWith('generated/')) continue;
      const text = readFileSync(abs, 'utf8');
      if (text.includes(SNUG_APP_REQUEST_TAG) || text.includes(APP_BUILDER_TOOL_NAME)) {
        violations.push(rel);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
