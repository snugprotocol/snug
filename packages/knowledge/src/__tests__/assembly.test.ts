// AC-4 / AC-7: golden assembly snapshots — the gating matrix for the host system
// prompt and the skill-builder pipeline per mode. Any prompt edit shows its blast
// radius as a snapshot diff.
import { describe, expect, it } from 'vitest';

import {
  buildHostSystemPrompt,
  buildSkillBuilderPrompt,
  getKnowledgeSummary,
  getSkillBuilderPreamble,
  getSkillCreatorFile,
  getSkillMode,
  getSystemLayer,
  listSkillModes,
} from '../index.js';

const SEPARATOR = '\n\n---\n\n';

describe('buildHostSystemPrompt gating matrix', () => {
  const combos = [
    { appBuilder: false, artifacts: false },
    { appBuilder: false, artifacts: true },
    { appBuilder: true, artifacts: false },
    { appBuilder: true, artifacts: true },
  ] as const;

  for (const combo of combos) {
    it(`golden: appBuilder=${combo.appBuilder} artifacts=${combo.artifacts}`, () => {
      expect(buildHostSystemPrompt(combo)).toMatchSnapshot();
    });
  }

  it('layer count and order follow the gates (10 always; 20 iff artifacts; 30+40 iff appBuilder)', () => {
    for (const combo of combos) {
      const prompt = buildHostSystemPrompt(combo);
      const parts = prompt.split(SEPARATOR);
      const expected = 1 + (combo.artifacts ? 1 : 0) + (combo.appBuilder ? 2 : 0);
      expect(parts.length, JSON.stringify(combo)).toBe(expected);
      expect(parts[0]).toBe(getSystemLayer('host-identity'));
      expect(prompt.includes(getSystemLayer('capability-file-creation'))).toBe(combo.artifacts);
      expect(prompt.includes(getSystemLayer('app-builder-summary'))).toBe(combo.appBuilder);
      expect(prompt.includes(getSystemLayer('app-response-format'))).toBe(combo.appBuilder);
    }
  });

  it('appends the KB summary directly beneath the 30-app-builder-summary layer', () => {
    const summary = getKnowledgeSummary();
    const prompt = buildHostSystemPrompt({ appBuilder: true, artifacts: false });
    const summaryLayerAt = prompt.indexOf(getSystemLayer('app-builder-summary').trimEnd());
    const kbSummaryAt = prompt.indexOf(summary);
    const responseFormatAt = prompt.indexOf(getSystemLayer('app-response-format'));
    expect(summaryLayerAt).toBeGreaterThanOrEqual(0);
    expect(kbSummaryAt).toBeGreaterThan(summaryLayerAt); // "summary below" is literally true
    expect(responseFormatAt).toBeGreaterThan(kbSummaryAt); // before 40-response-format
    // Gated with the app-builder layers: absent when appBuilder is off.
    expect(buildHostSystemPrompt({ appBuilder: false, artifacts: true })).not.toContain(summary);
  });
});

describe('buildSkillBuilderPrompt', () => {
  it('the store ships at least one skill mode', () => {
    expect(listSkillModes().length).toBeGreaterThan(0);
  });

  it('golden per mode (data-driven over prompts/skills/modes/)', () => {
    for (const mode of listSkillModes()) {
      expect(buildSkillBuilderPrompt(mode)).toMatchSnapshot(`mode=${mode}`);
    }
  });

  it('appends the current-skill context block when ctx is provided', () => {
    const mode = listSkillModes()[0] as string;
    const existingSkillMd = '# Demo skill\n\nBody of the existing skill.';
    const prompt = buildSkillBuilderPrompt(mode, { slug: 'demo-skill', existingSkillMd });
    expect(prompt).toContain('## Current skill');
    expect(prompt).toContain('Slug: `demo-skill`');
    expect(prompt).toContain('<existing-skill-md>');
    expect(prompt).toContain(existingSkillMd);
    expect(prompt).toContain('</existing-skill-md>');
    // Without ctx there is no context block.
    expect(buildSkillBuilderPrompt(mode)).not.toContain('## Current skill');
  });

  it('orders preamble before vendored SKILL.md before mode tail', () => {
    const mode = listSkillModes()[0] as string;
    const prompt = buildSkillBuilderPrompt(mode);
    const preambleAt = prompt.indexOf(getSkillBuilderPreamble());
    const skillMdAt = prompt.indexOf(getSkillCreatorFile('SKILL.md'));
    const modeAt = prompt.indexOf(getSkillMode(mode));
    expect(preambleAt).toBe(0);
    expect(skillMdAt).toBeGreaterThan(preambleAt);
    expect(modeAt).toBeGreaterThan(skillMdAt);
  });

  it('throws on an unknown mode', () => {
    expect(() => buildSkillBuilderPrompt('no-such-mode')).toThrowError(/Unknown skill mode/);
  });
});
