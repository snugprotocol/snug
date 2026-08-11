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
    // TASK-20260811 P1 (ADR-0018 D1): the RUNTIME branch — what an installed app's turn
    // gets instead of the builder assembly.
    { appBuilder: false, artifacts: false, appRuntime: true },
  ] as const;

  for (const combo of combos) {
    it(`golden: appBuilder=${combo.appBuilder} artifacts=${combo.artifacts}${
      'appRuntime' in combo ? ' appRuntime=true' : ''
    }`, () => {
      expect(buildHostSystemPrompt(combo)).toMatchSnapshot();
    });
  }

  it('layer count and order follow the gates (10 always; 20 iff artifacts; 30+40 iff appBuilder)', () => {
    for (const combo of combos.filter((c) => !('appRuntime' in c))) {
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

  describe('appRuntime branch (ADR-0018 D1) — what an installed app’s turn actually needs', () => {
    const runtime = buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true });

    it('assembles exactly identity + runtime doctrine + response format', () => {
      const parts = runtime.split(SEPARATOR);
      expect(parts).toHaveLength(3);
      expect(parts[0]).toBe(getSystemLayer('host-identity'));
      expect(parts[1]).toBe(getSystemLayer('app-runtime'));
      expect(parts[2]).toBe(getSystemLayer('app-response-format'));
    });

    it('carries NONE of the authoring instructions a runtime move cannot act on', () => {
      // This is the whole point of the branch: ~3 KB net of builder layers stop riding
      // every app turn. Asserted against the layer CONTENT, not a byte count, so the
      // claim survives edits to those layers.
      expect(runtime).not.toContain(getSystemLayer('app-builder-summary'));
      expect(runtime).not.toContain(getKnowledgeSummary());
      expect(runtime).not.toContain(getSystemLayer('capability-file-creation'));
    });

    it('is materially smaller than the builder assembly it replaces', () => {
      const builder = buildHostSystemPrompt({ appBuilder: true, artifacts: false });
      expect(runtime.length).toBeLessThan(builder.length);
      // MEASURED, not estimated (2026-08-11): 30-app-builder-summary (1439) + the inlined
      // KB summary (864) come out = 2303; the new 45-app-runtime layer (1043) goes back
      // in; 10 and 40 are retained. Net ≈ 1261 bytes (~315 tokens) saved on EVERY app
      // turn, uncached by design (ADR-0012).
      //
      // The plan's "~3 KB net" was optimistic even after fold F-m6 corrected it down from
      // ~4.5 KB — it counted the removals and forgot the new layer is not free. The floor
      // below is deliberately under the measured value so ordinary prompt edits do not
      // fail this test, but far enough above zero that a regression which quietly restores
      // the builder layers is still caught.
      expect(builder.length - runtime.length).toBeGreaterThan(1000);
    });

    it('KEEPS the response-format layer — the app still needs parseable JSON back', () => {
      expect(runtime).toContain(getSystemLayer('app-response-format'));
    });

    it('appRuntime wins over appBuilder if both are somehow set (a turn is one or the other)', () => {
      const both = buildHostSystemPrompt({ appBuilder: true, artifacts: true, appRuntime: true });
      expect(both).toBe(runtime);
    });
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
