// tool-free-assembly.test.ts — TASK-20260906-tool-free-kb-inlining AC1/AC2/AC6.
//
// The defect this pins: a brain that cannot call tools was told, in the system prompt, to
// call `snug_app_builder` before writing any app and never to write one from memory — so
// it built a self-contained `localStorage` app with no bridge hooks, which rendered as a
// white page (T4's hosted walk, 2026-09-06). "Which adapter" and "what did the prompt
// actually say" are different questions; these tests read the assembly AS THE MODEL WOULD.
//
// Every assertion is anchored on the package's own exports (tool-name constants, the
// accessor's rendered texts, protocol frame literals) — never on a retyped sentence — so a
// rename or a KB edit cannot rot the test into passing for the wrong reason.
//
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-5; AC40e): the inline core carries KB 20's hooks
// block CUT after section 5 — sections 6 (useHostEvents + useSnugSchedule) and 7 (useSnugAccess) are
// replaced, in the template's voice, by ONE comment line (the measured ledger: 10,799 B whole would
// cross HOST_BUILDER_SYSTEM_MAX_BYTES). The row that pinned "the accessor serves the SAME rendering
// the tool would" is INVERTED for the KB 20 entry ONLY — the other four stay byte-identical. These
// rows compare TEXT and need no new export; the pure `inlineTemplate` itself is pinned in
// inline-template.test.ts (red as a whole until the export lands).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { FRAME_TYPES } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import {
  APP_BUILDER_TOOL_NAME,
  APP_DOC_WRITE_TOOL_NAME,
  ARTIFACT_EDIT_TOOL_NAME,
  buildHostSystemPrompt,
  getInlineKnowledgeCore,
  getKnowledgeBase,
  getKnowledgeSummary,
  getSystemLayer,
  INLINE_KNOWLEDGE_CORE_FILES,
  RUNTIME_CONTRACT_WRITE_TOOL_NAME,
  SCHEMA_APPLY_TOOL_NAME,
  SYSTEM_BLOCK_SEPARATOR,
} from '../index.js';
import { repoRoot } from './helpers.js';

/**
 * Every way a tool-free brain could be told to call a tool: the wire names (the package's
 * own constants) AND the prose forms the KB uses — the Gate-5 review found "the host's
 * schema-apply tool" riding the inline core past a constants-only check.
 */
const TOOL_CITATIONS = [
  APP_BUILDER_TOOL_NAME,
  SCHEMA_APPLY_TOOL_NAME,
  APP_DOC_WRITE_TOOL_NAME,
  ARTIFACT_EDIT_TOOL_NAME,
  RUNTIME_CONTRACT_WRITE_TOOL_NAME,
  'artifact_write',
  'artifact write tool',
  'schema-apply tool',
  'schema tool',
  'app-builder tool',
];

/** PR-6 (D-PR6-5): the ONE line that replaces sections 6–7 in the inline core — verbatim. */
const CUT_LINE =
  '// 6-7. Not in this template (scheduled runs, access between apps): do not call useHostEvents, useSnugSchedule or useSnugAccess.';
/**
 * PR-6 (D-PR6-5): the 35-layer's sibling sentence — verbatim. R-docs-4 (Gate 5, folded): its tail
 * says what THIS APP will not do — never that the host lacks schedules or access (the artifact host
 * schedules and offers access; the old tail followed a list of what "this host does not carry").
 */
const SIBLING_SENTENCE =
  'Sections 6–7 are not in this template: never call `useSnugSchedule` or `useSnugAccess`, nor hand-roll their listeners — say in one line that this app will not take part in schedules or read other apps, and offer it without them.';
const TEMPLATE_FILE = 'knowledge-base/app-authoring/20-html-template.md';
const EMBEDDED_HOOKS = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'embedded', 'snug-hooks.js'), 'utf8');

/** Whitespace normalization (kb-sync's): per-line trim, blank lines dropped. */
const normalize = (code: string): string =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

/** The text as sentences: the files are hard-wrapped, and a claim must not hide across a line break. */
const prose = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * The region the cut replaces, as LINE indices of `text`: from the `// ====` line above `// 6.` up to
 * (not including) the `// ====` line above the RESPONSE SCHEMA banner. `undefined` when either banner
 * block is absent — a red row, never a thrown suite.
 */
function cutRegion(text: string): { start: number; end: number } | undefined {
  const lines = text.split('\n');
  const six = lines.findIndex((line) => /^\s*\/\/ 6\. /.test(line));
  const schema = lines.findIndex((line) => /^\s*\/\/ \d+\. RESPONSE SCHEMA/.test(line));
  if (six < 1 || schema < 1 || schema <= six) return undefined;
  return { start: six - 1, end: schema - 1 };
}

/** The `<script type="text/babel">` hook block of a KB 20 rendering, cut before the RESPONSE SCHEMA banner block (kb-sync's extraction). */
function hookBlock(text: string): string | undefined {
  const html = /```html\n([\s\S]*?)\n```/.exec(text)?.[1];
  const script = html === undefined ? undefined : /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1];
  if (script === undefined) return undefined;
  const lines = script.split('\n');
  const banner = lines.findIndex((line) => /\d+\. RESPONSE SCHEMA/.test(line));
  return banner < 1 ? undefined : lines.slice(0, banner - 1).join('\n');
}

/** The embedded hooks block up to (not including) the `// ====` line above `// 6.` — sections 1–5. */
function embeddedSectionsOneToFive(): string | undefined {
  const lines = EMBEDDED_HOOKS.split('\n');
  const six = lines.findIndex((line) => /^\s*\/\/ 6\. /.test(line));
  return six < 1 ? undefined : lines.slice(0, six - 1).join('\n');
}

const inline = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge: 'inline' });
const unaided = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge: 'none' });
const tooled = buildHostSystemPrompt({ appBuilder: true, artifacts: true });

describe('the five-file core is pinned by name (D2)', () => {
  it('names exactly the five essential files, in KB order, and every one exists in the store — PR-6: the four non-template entries are the SAME rendering the tool would serve', () => {
    expect(INLINE_KNOWLEDGE_CORE_FILES).toEqual([
      'knowledge-base/app-authoring/10-overview-and-contract.md',
      'knowledge-base/app-authoring/20-html-template.md',
      'knowledge-base/app-authoring/30-bridge-protocol.md',
      'knowledge-base/app-authoring/40-persistence-and-db.md',
      'knowledge-base/app-authoring/80-cdn-compatibility.md',
    ]);
    const byFile = new Map(getKnowledgeBase().map((section) => [section.file, section.text]));
    const core = getInlineKnowledgeCore();
    expect(core).toHaveLength(INLINE_KNOWLEDGE_CORE_FILES.length);
    INLINE_KNOWLEDGE_CORE_FILES.forEach((file, i) => {
      expect(byFile.get(file), file).toBeDefined();
      // PR-6 (D-PR6-5; AC40e) INVERTS this for KB 20 ONLY — pinned in the next row. The other four
      // are still the SAME rendering the tool would serve, byte for byte.
      if (file === TEMPLATE_FILE) return;
      expect(core[i]).toBe(byFile.get(file));
    });
  });

  it('PR-6 (AC40e): the KB 20 entry differs from the served page by EXACTLY the cut — one region of lines replaced by the one cut line; prefix and suffix byte-identical', () => {
    const served = getKnowledgeBase().find((section) => section.file === TEMPLATE_FILE)!.text;
    const inlined = getInlineKnowledgeCore()[INLINE_KNOWLEDGE_CORE_FILES.indexOf(TEMPLATE_FILE)]!;
    const region = cutRegion(served);
    expect(region, 'the served template carries a section-6 banner block above the RESPONSE SCHEMA banner block').toBeDefined();
    const { start, end } = region!;
    const servedLines = served.split('\n');
    const inlineLines = inlined.split('\n');
    expect(inlineLines.slice(0, start), 'prefix byte-identical').toEqual(servedLines.slice(0, start));
    expect(inlineLines.length, 'the region is ONE line in the inline core').toBe(start + 1 + (servedLines.length - end));
    expect(inlineLines[start]?.trim(), 'the region is the cut line').toBe(CUT_LINE);
    expect(inlineLines.slice(start + 1), 'suffix byte-identical').toEqual(servedLines.slice(end));
  });

  it('PR-6 (AC40e): the cut line rides ONCE in the inline core and NEVER on the served page or the tooled assembly; it is one short ASCII line in the template’s voice', () => {
    expect(CUT_LINE).toMatch(/^[\x20-\x7e]+$/);
    expect(getInlineKnowledgeCore().join('\n').split(CUT_LINE).length - 1).toBe(1);
    expect(inline.split(CUT_LINE).length - 1).toBe(1);
    for (const section of getKnowledgeBase()) expect(section.text, section.file).not.toContain(CUT_LINE);
    expect(tooled).not.toContain(CUT_LINE);
    // The template's voice, never the host's: nothing says THIS HOST lacks them (the artifact host schedules and offers access).
    expect(CUT_LINE).not.toMatch(/\bhosts?\b/i) // the word, not the hook's name (useHostEvents) — Gate-4 sanctioned fix;
  });

  it('PR-6 (AC40e): the inline KB 20 hooks block normalises to the embedded file’s sections 1–5, then the cut line; the served page’s to the WHOLE file', () => {
    const served = getKnowledgeBase().find((section) => section.file === TEMPLATE_FILE)!.text;
    const inlined = getInlineKnowledgeCore()[INLINE_KNOWLEDGE_CORE_FILES.indexOf(TEMPLATE_FILE)]!;
    const oneToFive = embeddedSectionsOneToFive();
    expect(oneToFive, 'the embedded hooks block has a section-6 banner block').toBeDefined();
    expect(normalize(hookBlock(inlined) ?? '')).toBe(`${normalize(oneToFive!)}\n${CUT_LINE}`);
    expect(normalize(hookBlock(served) ?? '')).toBe(normalize(EMBEDDED_HOOKS));
    // NEGATIVE: none of sections 6–7's code rides inline.
    for (const name of ['function onHostEvent(', 'function useHostEvents(', 'function useSnugSchedule(', 'function proposeSchedule(', 'function useSnugAccess(', 'function snugAccessCall(']) {
      expect(inlined, name).not.toContain(name);
      expect(served, name).toContain(name);
    }
  });

  it('leaves the connected-API layer out — connected apps do not exist under Binding A (D4)', () => {
    expect(INLINE_KNOWLEDGE_CORE_FILES.some((f) => f.includes('90-auth-and-connected-apis'))).toBe(false);
    const ninety = getKnowledgeBase().find((s) => s.file.endsWith('90-auth-and-connected-apis.md'))!.text;
    expect(inline).not.toContain(ninety);
  });
});

describe("AC1 — knowledge: 'inline' is SELF-SUFFICIENT", () => {
  it('carries every core file verbatim, each as its own system block, directly after the inline builder layer', () => {
    const blocks = inline.split(SYSTEM_BLOCK_SEPARATOR);
    const core = getInlineKnowledgeCore();
    const at = blocks.indexOf(getSystemLayer('app-builder-inline'));
    expect(at).toBeGreaterThan(0);
    expect(blocks.slice(at + 1, at + 1 + core.length)).toEqual(core);
    expect(blocks[at + 1 + core.length]).toBe(getSystemLayer('app-response-format'));
  });

  it('contains the mandatory template with the copy-exactly bridge hooks (the literal frame types)', () => {
    expect(inline).toContain('## Full Template');
    expect(inline).toContain(FRAME_TYPES.announce);
    expect(inline).toContain(FRAME_TYPES.appMessage);
    expect(inline).toContain('function useSnugApp(');
    expect(inline).toContain('function usePersistedState(');
  });

  it('contains the reply contract and the pinned CDN table', () => {
    expect(inline).toContain('## JSON-Only Reply Rule');
    expect(inline).toContain('## DATA: Pinned Known-Good CDN Builds');
    expect(inline).toContain('## Never Think on a Timer');
  });

  it('names what is ABSENT: the overview still points at sections the core does not carry, and the frame says so', () => {
    // 10-overview rides byte-identical to the tool rendering, Section Map included; the
    // inline frame must own the gap rather than let "everything is here" contradict it.
    const frame = getSystemLayer('app-builder-inline');
    for (const absent of ['App Catalog', 'Design Quality', 'Defensive Coding', 'Connected APIs']) {
      expect(frame, absent).toContain(absent);
      expect(inline, absent).not.toContain(`## ${absent}`);
    }
    expect(frame).toMatch(/never include the template's `useConnectedFetch` section/);
  });

  // PR-6 (D-PR6-5): the NOT-here list gains the two pages the Section Map names and the core does not
  // carry. Their pages open with an H1 (`# Scheduled Runs`, `# Access Between Apps`), so the `## <name>`
  // probe above would pass vacuously for them: the honest probe is no heading line of ANY level naming
  // them, and none of either page's own headings, in the inline assembly.
  it('PR-6: the "What is NOT here" paragraph names "Scheduled Runs" and "Access Between Apps" — and neither page rides inline', () => {
    const frame = getSystemLayer('app-builder-inline');
    const notHere = prose(/\*\*What is NOT here\.\*\*[\s\S]*?(?=\n\n)/.exec(frame)?.[0] ?? '');
    expect(notHere, 'the What is NOT here paragraph').not.toBe('');
    for (const absent of ['Scheduled Runs', 'Access Between Apps']) {
      expect(notHere, absent).toContain(absent);
      expect(inline, absent).not.toMatch(new RegExp(`^#{1,6} ${absent}$`, 'm'));
    }
    for (const file of ['knowledge-base/app-authoring/85-scheduled-runs.md', 'knowledge-base/app-authoring/87-cross-app-access.md']) {
      const page = getKnowledgeBase().find((section) => section.file === file)!;
      for (const heading of page.headingTree) expect(inline.split('\n'), `${file}: ${heading}`).not.toContain(heading);
    }
  });

  it('PR-6: the 35 layer carries the sibling sentence — sections 6–7 are not in this template — verbatim, once', () => {
    const frame = prose(getSystemLayer('app-builder-inline'));
    expect(frame.split(SIBLING_SENTENCE).length - 1).toBe(1);
  });

  it('never tells the model to fetch the rules — the inline layer says they FOLLOW', () => {
    // The 30-layer's "call the tool… never write an app from memory" bind is the bug; its
    // tool-free sibling must not carry that sentence in any form.
    expect(inline).not.toContain(getSystemLayer('app-builder-summary'));
    expect(inline).not.toContain(getKnowledgeSummary());
    expect(inline).not.toMatch(/Never write an app from memory/);
  });
});

describe('AC2 — a tool-free assembly never cites a tool it cannot call', () => {
  for (const [label, prompt] of [
    ['inline', inline],
    ['none', unaided],
  ] as const) {
    it(`'${label}' contains no tool name (${TOOL_CITATIONS.length} names checked from the package's own constants)`, () => {
      for (const name of TOOL_CITATIONS) expect(prompt, name).not.toContain(name);
    });
  }

  it("negative twin: the TOOLED assembly still cites the tools, and `knowledge: 'tool'` is byte-identical to omitting the seat", () => {
    expect(tooled).toContain(APP_BUILDER_TOOL_NAME);
    expect(tooled).toContain(SCHEMA_APPLY_TOOL_NAME);
    expect(tooled).toContain(APP_DOC_WRITE_TOOL_NAME);
    expect(buildHostSystemPrompt({ appBuilder: true, artifacts: true, knowledge: 'tool' })).toBe(tooled);
    expect(buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge: 'tool' })).toBe(
      buildHostSystemPrompt({ appBuilder: true, artifacts: false }),
    );
  });

  it('a tool-free delivery under the file-creation layer is REFUSED — the 20 layer cites the artifact write tool', () => {
    for (const knowledge of ['inline', 'none'] as const) {
      expect(() => buildHostSystemPrompt({ appBuilder: true, artifacts: true, knowledge })).toThrow(/tool-free delivery/);
    }
  });

  it('the seat is a builder-branch seat: the runtime branch and the no-builder branch ignore it', () => {
    for (const knowledge of ['inline', 'none'] as const) {
      expect(buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true, knowledge })).toBe(
        buildHostSystemPrompt({ appBuilder: false, artifacts: false, appRuntime: true }),
      );
      expect(buildHostSystemPrompt({ appBuilder: false, artifacts: false, knowledge })).toBe(
        buildHostSystemPrompt({ appBuilder: false, artifacts: false }),
      );
    }
  });
});

describe("knowledge: 'none' — the honest unaided layer (webllm)", () => {
  it('replaces the 30-slot with the unaided layer and carries NO knowledge base at all', () => {
    const blocks = unaided.split(SYSTEM_BLOCK_SEPARATOR);
    expect(blocks).toEqual([
      getSystemLayer('host-identity'),
      getSystemLayer('app-builder-unaided'),
      getSystemLayer('app-response-format'),
    ]);
    for (const text of getInlineKnowledgeCore()) expect(unaided).not.toContain(text);
  });

  it('says plainly that no knowledge base is available here, and that browser storage is not either', () => {
    expect(unaided).toMatch(/knowledge base/i);
    expect(unaided).toMatch(/not available|unavailable/i);
    expect(unaided).toContain('localStorage');
  });
});

describe('AC6 — localStorage is refused by name', () => {
  it("the persistence layer's host-brokered rule rides in 'inline' (the sentence whose absence produced the observed app)", () => {
    const persistence = getKnowledgeBase().find((s) => s.file.endsWith('40-persistence-and-db.md'))!.text;
    expect(inline).toContain(persistence);
    expect(persistence).toContain('## Storage Is Host-Brokered');
    expect(persistence).toContain('localStorage');
  });

  it('the inline builder layer restates it at the top — the model reads it before the 37 KB that follows', () => {
    expect(getSystemLayer('app-builder-inline')).toContain('localStorage');
  });
});

describe('platform suffix still rides LAST on the new deliveries (TASK-20260812 P2 invariant)', () => {
  for (const knowledge of ['inline', 'none'] as const) {
    it(`'${knowledge}': the web assembly is a strict prefix of its desktop sibling`, () => {
      const web = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge });
      const desktop = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge, platform: 'desktop' });
      expect(desktop.startsWith(web)).toBe(true);
      expect(desktop.endsWith(getSystemLayer('platform-desktop'))).toBe(true);
    });
  }
});

// =========================================================================================
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-6; AC40f): the two INLINE pages that describe the
// hooks read true against seven sections — KB 20's intro on both pages (it sits above the cut), and
// KB 10's "## The SDK Hooks", which names the seven WITHOUT growing (10 rides inline, byte-neutral).
// =========================================================================================
describe('PR-6 — the inline pages read true against seven sections (D-PR6-6)', () => {
  /** KB 20's two-zone intro as words: emphasis markers dropped, whitespace folded. */
  const words = (text: string): string => prose(text.replace(/\*\*/g, ''));
  const INTRO_COPY =
    "Copy exactly — sections 1–7: 1–3 always; 4 and up only when the app needs them (SQL; an approved API; host events or a schedule; another app's data — 7 needs 6).";

  it('KB 20’s intro says "Copy exactly — sections 1–7 … Yours — sections 8–9." on the served page AND in the inline core', () => {
    const served = getKnowledgeBase().find((section) => section.file === TEMPLATE_FILE)!.text;
    const inlined = getInlineKnowledgeCore()[INLINE_KNOWLEDGE_CORE_FILES.indexOf(TEMPLATE_FILE)]!;
    for (const [label, text] of [['served', served], ['inline', inlined]] as const) {
      const intro = words(text.slice(0, text.indexOf('## Full Template')));
      expect(intro, label).toContain(INTRO_COPY);
      expect(intro, label).toContain('Yours — sections 8–9.');
      // NEGATIVE: the stale AL-03 numbering is gone.
      expect(intro, label).not.toContain('(sections 1–4)');
      expect(intro, label).not.toContain('(sections 5–6)');
    }
  });

  /** "## The SDK Hooks" of rendered KB 10, heading through the line before the next `##`. */
  const sdkHooksSection = (): string => {
    const text = getInlineKnowledgeCore()[INLINE_KNOWLEDGE_CORE_FILES.indexOf('knowledge-base/app-authoring/10-overview-and-contract.md')]!;
    const start = text.indexOf('\n## The SDK Hooks') + 1;
    expect(start, 'KB 10 has "## The SDK Hooks"').toBeGreaterThan(0);
    const next = text.indexOf('\n## ', start);
    return text.slice(start, next === -1 ? undefined : next + 1);
  };

  it('KB 10’s "## The SDK Hooks" names the seven hooks', () => {
    const hooks = sdkHooksSection();
    for (const hook of ['useSnugApp', 'usePersistedState', 'useAppDB', 'useConnectedFetch', 'useHostEvents', 'useSnugSchedule', 'useSnugAccess']) {
      expect(hooks, hook).toContain(hook);
    }
  });

  // R-docs-3 (Gate 5): the list opens useSnugApp, usePersistedState, useAppDB — so "the first three"
  // took useAppDB in, against KB 20's "1–3 always; 4 and up only when needed" (3 is usePersistedState's
  // section, 4 useAppDB's). The two always present are the first two the list names.
  it('says "The first two are always present" — useSnugApp and usePersistedState — never "the first three"', () => {
    const hooks = prose(sdkHooksSection());
    expect(hooks).toContain('The first two are always present');
    expect(hooks).not.toContain('The first three are always present');
    const listed = [...hooks.matchAll(/- `(use\w+)\(/g)].map((m) => m[1]);
    expect(listed.slice(0, 2)).toEqual(['useSnugApp', 'usePersistedState']);
  });

  it('…and the section did NOT grow — at most the 1,017 UTF-8 bytes it measured before PR-6 (2026-10-12, Node 22)', () => {
    expect(new TextEncoder().encode(sdkHooksSection()).length).toBeLessThanOrEqual(1017);
  });
});
