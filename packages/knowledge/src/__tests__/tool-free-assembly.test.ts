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

const inline = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge: 'inline' });
const unaided = buildHostSystemPrompt({ appBuilder: true, artifacts: false, knowledge: 'none' });
const tooled = buildHostSystemPrompt({ appBuilder: true, artifacts: true });

describe('the five-file core is pinned by name (D2)', () => {
  it('names exactly the five essential files, in KB order, and every one exists in the store', () => {
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
      expect(core[i]).toBe(byFile.get(file)); // the accessor serves the SAME rendering the tool would
    });
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
