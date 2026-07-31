// AC-5: section search over the rendered KB — keyword scoring, heading weighting,
// full-document fallback, and a stability lock on the retrieval-load-bearing headings.
import { describe, expect, it } from 'vitest';

import { getKnowledgeBase, getKnowledgeSummary, searchKnowledge } from '../index.js';

/** A real ##/### heading from the KB with enough distinctive tokens to query for. */
function pickQueryableHeading(): { file: string; heading: string } {
  for (const section of getKnowledgeBase()) {
    for (const headingLine of section.headingTree) {
      const match = /^(##|###)\s+(.*)$/.exec(headingLine);
      if (!match) continue;
      const title = (match[2] as string).trim();
      const tokens = title.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
      if (tokens.filter((t) => t.length >= 4).length >= 2) {
        return { file: section.file, heading: title };
      }
    }
  }
  throw new Error('KB has no ##/### heading with >=2 distinctive tokens — retrieval structure is broken');
}

describe('searchKnowledge', () => {
  it('returns the matching section when queried with a real heading', () => {
    const { file, heading } = pickQueryableHeading();
    const results = searchKnowledge(heading);
    expect(results.length).toBeGreaterThan(0);
    expect((results[0] as { score: number }).score).toBeGreaterThan(0);
    expect(
      results.some((r) => r.file === file && r.heading === heading),
      `expected a result for "${heading}" from ${file}; got: ${results
        .map((r) => `${r.file}#${r.heading}`)
        .join(' | ')}`,
    ).toBe(true);
  });

  it('results are sorted by descending score', () => {
    const { heading } = pickQueryableHeading();
    const results = searchKnowledge(heading);
    for (let i = 1; i < results.length; i += 1) {
      expect((results[i - 1] as { score: number }).score).toBeGreaterThanOrEqual(
        (results[i] as { score: number }).score,
      );
    }
  });

  it('respects the limit option', () => {
    const { heading } = pickQueryableHeading();
    expect(searchKnowledge(heading, { limit: 1 }).length).toBe(1);
  });

  it('falls back to full documents (score 0) when nothing matches', () => {
    const kb = getKnowledgeBase();
    const results = searchKnowledge('zzqxv wqvvk xyzzyplugh');
    expect(results.length).toBe(kb.length);
    for (const [i, result] of results.entries()) {
      expect(result.score).toBe(0);
      expect(result.file).toBe((kb[i] as { file: string }).file);
      expect(result.text).toBe((kb[i] as { text: string }).text);
    }
  });
});

describe('KB retrieval structure stability', () => {
  it('heading tree per file is locked (edits show up as snapshot diffs)', () => {
    const skeleton = getKnowledgeBase().map(({ file, headingTree }) => ({ file, headingTree }));
    expect(skeleton.length).toBeGreaterThan(0);
    expect(skeleton).toMatchSnapshot();
  });

  it('knowledge summary is locked', () => {
    expect(getKnowledgeSummary()).toMatchSnapshot();
  });
});
