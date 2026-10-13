// AC-2: no wire literal is ever retyped in prompt sources — sources carry
// {{placeholders}}; the rendered output carries the injected protocol values.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
  SNUG_APP_REQUEST_TAG,
} from '@snugprotocol/protocol';

import { APP_BUILDER_TOOL_NAME, renderPrompt } from '../index.js';
import { isVendored, packageRoot, promptFilesOnDisk, renderedStore, walkFiles, withoutNonFrameSnugMentions } from './helpers.js';

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
      // Wildcard mentions (`snug:*`) are prose; the scheduled-run kv KEY is not a frame (helpers.ts).
      const scannable = withoutNonFrameSnugMentions(file.content);
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

// TASK-20261010-host-broker PR-6 (contract v2 "render.ts"; AC40d): section 6 of the hooks block bounds
// a scheduled result with the protocol's three schedule bounds, so the renderer learns exactly THREE
// new static placeholders — and nothing else new. Pinned through the package's own exported render
// path (`renderPrompt`, re-exported by index.ts), never by reading render.ts's source.
describe('placeholder integrity — PR-6: the three schedule bounds (AC40d)', () => {
  /** The static placeholder names the renderer knows, read off its own refusal of an unknown one. */
  const knownStaticNames = (): string[] => {
    let message = '';
    try {
      renderPrompt('{{pr6NoSuchPlaceholder}}');
    } catch (err) {
      message = (err as Error).message;
    }
    const list = /known placeholders: ([^(]*?) \(use/.exec(message)?.[1];
    expect(list, 'the renderer names its known placeholders when it refuses one').toBeDefined();
    return (list as string).split(', ').filter((name) => !name.startsWith('frameType:'));
  };

  /** The static names render.ts knew BEFORE PR-6 (main @ d0b5066). */
  const BEFORE_PR6 = [
    'envelopeTag',
    'appBuilderToolName',
    'runtimeContractWriteToolName',
    'schemaApplyToolName',
    'appDocWriteToolName',
    'appObjectNameRule',
    'standardDocSlugs',
    'cdnAllowlist',
    'protocolVersion',
    'maxArtifactBytes',
    'maxFrameKiB',
    'maxParseFailures',
    'rawExcerptChars',
    'authKinds',
    'authEvidenceMaxItems',
    'authEvidenceMaxChars',
    'authWizardDirectiveKind',
    'connectionRequirementDirectiveKind',
    'connectionKinds',
    'appAgentMaxToolCalls',
    'appAgentMaxRoundTrips',
  ];
  const PR6_NAMES = ['scheduleSummaryMaxChars', 'scheduleTitleMaxChars', 'scheduleNotifyBodyMaxChars'];

  it('the renderer knows the three schedule-bound placeholders, each the protocol constant as plain digits', () => {
    expect(renderPrompt('{{scheduleSummaryMaxChars}}')).toBe(String(SCHEDULE_STEP_SUMMARY_MAX_CHARS));
    expect(renderPrompt('{{scheduleTitleMaxChars}}')).toBe(String(SCHEDULE_TITLE_MAX_CHARS));
    expect(renderPrompt('{{scheduleNotifyBodyMaxChars}}')).toBe(String(SCHEDULE_NOTIFY_BODY_MAX_CHARS));
  });

  it('…and NOTHING else new: the known static names are exactly the pre-PR-6 set plus those three', () => {
    expect(knownStaticNames().sort()).toEqual([...BEFORE_PR6, ...PR6_NAMES].sort());
  });

  it('NEGATIVE: the renderer still refuses an unknown placeholder (the strictness the three ride on)', () => {
    expect(() => renderPrompt('{{scheduleSummaryMaxBytes}}')).toThrow(/Unknown placeholder/);
  });

  it('KB 20’s SOURCE carries the three placeholders (section 6 never retypes a bound); the rendered page carries the values', () => {
    const template = promptFilesOnDisk().find((f) => f.rel === 'knowledge-base/app-authoring/20-html-template.md');
    expect(template, '20-html-template.md is on disk').toBeDefined();
    for (const name of PR6_NAMES) expect(template!.content, name).toContain(`{{${name}}}`);
    const rendered = renderedStore().find((entry) => entry.file === 'knowledge-base/app-authoring/20-html-template.md')?.text ?? '';
    for (const name of PR6_NAMES) expect(rendered, name).not.toContain(`{{${name}}}`);
    expect(rendered).toContain(`.slice(0, ${SCHEDULE_STEP_SUMMARY_MAX_CHARS})`);
    expect(rendered).toContain(`.slice(0, ${SCHEDULE_TITLE_MAX_CHARS})`);
    expect(rendered).toContain(`.slice(0, ${SCHEDULE_NOTIFY_BODY_MAX_CHARS})`);
  });
});
