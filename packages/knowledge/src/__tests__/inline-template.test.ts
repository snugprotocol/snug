// inline-template.test.ts — TASK-20261010-host-broker PR-6 (contract v2 D-PR6-5; AC40e; security S4).
//
// The inline core (a tool-free brain's system prompt) carries KB 20 with sections 6–7 of the hooks
// block CUT: `layers.ts` exports a PURE `inlineTemplate(text)` that replaces EXACTLY the region from
// the `// ====` line above `// 6.` up to (not including) the `// ====` line above the RESPONSE SCHEMA
// banner with ONE short ASCII comment line, and leaves every other byte alone. It THROWS — never
// silently serves a thinner or a wider prompt — when the section-6 banner block is missing, when the
// RESPONSE SCHEMA banner block is missing, when the two are out of order, or when either appears twice.
//
// RED BY DESIGN until `inlineTemplate` is exported. The export is read off the module NAMESPACE, not
// imported by name: this package's `test` script runs `tsc -p tsconfig.test.json` BEFORE vitest, and a
// named import of a missing export would fail the type check and stop EVERY suite in the package
// (lesson 2026-10-11, the transform-time trap). Every row below is red today, each for that reason.
import { describe, expect, it } from 'vitest';

import { getKnowledgeBase } from '../index.js';
import * as layers from '../layers.js';

/** The export under test, or `undefined` while it does not exist. */
const inlineTemplate = (layers as Readonly<Record<string, unknown>>)['inlineTemplate'] as ((text: string) => string) | undefined;

/** Call it, failing the row (not the suite) while it is missing. */
function cut(text: string): string {
  expect(inlineTemplate, 'layers.ts exports inlineTemplate').toBeTypeOf('function');
  return (inlineTemplate as (text: string) => string)(text);
}

/** D-PR6-5: the ONE line that replaces sections 6–7 — verbatim. */
const CUT_LINE =
  '// 6-7. Not in this template (scheduled runs, access between apps): do not call useHostEvents, useSnugSchedule or useSnugAccess.';

const TEMPLATE_FILE = 'knowledge-base/app-authoring/20-html-template.md';
const RULE = '    // ============================================================';

/** A banner block: the rule, the numbered line, the rule. */
const banner = (title: string): string[] => [RULE, `    // ${title}`, RULE];

/** A small KB-20-shaped page whose sections are chosen per row. */
function page(sections: string[][]): string {
  return [
    '# The Mandatory HTML Template',
    '',
    '```html',
    '<script type="text/babel">',
    ...sections.flatMap((section) => [...section, '']),
    '</script>',
    '```',
    '',
    'Prose after the fence.',
  ].join('\n');
}

const FIVE = [...banner('5. useConnectedFetch (copy exactly when the app calls an approved API; omit otherwise)'), '    function useConnectedFetch() { return null; }'];
const SIX = [...banner('6. useHostEvents + useSnugSchedule (copy exactly when the app listens to the host or takes part in schedules; omit otherwise)'), '    function onHostEvent(event, listener) { return () => {}; }'];
const SEVEN = [...banner("7. useSnugAccess (copy exactly, WITH section 6, when the app reads or changes another app's data; omit otherwise)"), '    function useSnugAccess() { return {}; }'];
const SCHEMA = [...banner('8. RESPONSE SCHEMA — describe the JSON the agent must return'), '    const RESPONSE_SCHEMA = {};'];
const APP = [...banner('9. YOUR APP'), '    function App() { return null; }'];

/**
 * The exact-region property: `out` is `served` with lines [start, end) replaced by ONE line whose
 * text (indentation aside) is the cut line — where start is the rule above `// 6.` and end the rule
 * above the RESPONSE SCHEMA banner. Prefix and suffix are compared line for line, byte for byte.
 */
function expectExactlyTheCut(served: string, out: string): void {
  const lines = served.split('\n');
  const six = lines.findIndex((line) => /^\s*\/\/ 6\. /.test(line));
  const schema = lines.findIndex((line) => /^\s*\/\/ \d+\. RESPONSE SCHEMA/.test(line));
  expect(six, 'the fixture has a section-6 banner').toBeGreaterThan(0);
  expect(schema, 'the fixture has a RESPONSE SCHEMA banner after it').toBeGreaterThan(six);
  const start = six - 1;
  const end = schema - 1;
  const outLines = out.split('\n');
  expect(outLines.slice(0, start), 'prefix byte-identical').toEqual(lines.slice(0, start));
  expect(outLines.length, 'the region became ONE line').toBe(start + 1 + (lines.length - end));
  expect(outLines[start]?.trim(), 'that line is the cut line').toBe(CUT_LINE);
  expect(outLines.slice(start + 1), 'suffix byte-identical').toEqual(lines.slice(end));
}

describe('inlineTemplate — the exported, pure cut (D-PR6-5)', () => {
  it('is exported from layers.ts as a function of one string', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect((inlineTemplate as (text: string) => string).length).toBe(1);
  });

  it('replaces EXACTLY one region of a fixture — the rule above `// 6.` through the line before the rule above RESPONSE SCHEMA — with the one cut line', () => {
    const served = page([FIVE, SIX, SEVEN, SCHEMA, APP]);
    const out = cut(served);
    expectExactlyTheCut(served, out);
    // What the region held is gone; what surrounds it stays.
    expect(out).not.toContain('function onHostEvent(');
    expect(out).not.toContain('function useSnugAccess(');
    expect(out).toContain('function useConnectedFetch(');
    expect(out).toContain('// 8. RESPONSE SCHEMA');
    expect(out).toContain('// 9. YOUR APP');
    expect(out).toContain('Prose after the fence.');
  });

  it('on the SERVED KB 20: exactly one region replaced, prefix and suffix byte-identical', () => {
    const served = getKnowledgeBase().find((section) => section.file === TEMPLATE_FILE)!.text;
    expectExactlyTheCut(served, cut(served));
  });

  it('is pure: the same input gives the same output, and the input string is untouched', () => {
    const served = page([FIVE, SIX, SEVEN, SCHEMA, APP]);
    const copy = `${served}`;
    expect(cut(served)).toBe(cut(served));
    expect(served).toBe(copy);
  });

  it('the cut line is one short ASCII line that never names a host — the template’s voice', () => {
    expect(CUT_LINE).toMatch(/^[\x20-\x7e]+$/);
    const out = cut(page([FIVE, SIX, SEVEN, SCHEMA, APP]));
    expect(out.split(CUT_LINE).length - 1).toBe(1);
  });
});

describe('inlineTemplate THROWS rather than serve a wrong prompt (S4)', () => {
  it('throws when the section-6 banner block is missing', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect(() => cut(page([FIVE, SEVEN, SCHEMA, APP]))).toThrow();
  });

  it('throws when `// 6.` carries no `// ====` rule above it — a numbered comment is not a banner block', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    const bare = [`    // ${SIX[1]!.trim().slice(3)}`, '    function onHostEvent() {}'];
    expect(() => cut(page([FIVE, bare, SEVEN, SCHEMA, APP]))).toThrow();
  });

  it('throws when the RESPONSE SCHEMA banner block is missing', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect(() => cut(page([FIVE, SIX, SEVEN, APP]))).toThrow();
  });

  it('throws when the two are out of order (RESPONSE SCHEMA above section 6)', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect(() => cut(page([FIVE, SCHEMA, SIX, SEVEN, APP]))).toThrow();
  });

  it('throws when the section-6 banner appears twice', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect(() => cut(page([FIVE, SIX, SEVEN, SIX, SCHEMA, APP]))).toThrow();
  });

  it('throws when the RESPONSE SCHEMA banner appears twice', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    expect(() => cut(page([FIVE, SIX, SEVEN, SCHEMA, SCHEMA, APP]))).toThrow();
  });

  it('a cut page cannot be cut again — the cut line is not a section-6 banner', () => {
    const once = cut(page([FIVE, SIX, SEVEN, SCHEMA, APP]));
    expect(() => cut(once)).toThrow();
  });

  it('NEGATIVE twin: today’s five-section template (RESPONSE SCHEMA numbered 6) is refused — the cut never guesses a region', () => {
    expect(inlineTemplate).toBeTypeOf('function');
    const fiveSection = page([FIVE, [...banner('6. RESPONSE SCHEMA — describe the JSON the agent must return'), '    const RESPONSE_SCHEMA = {};'], [...banner('7. YOUR APP')]]);
    expect(() => cut(fiveSection)).toThrow();
  });
});
