// AL-05 (TASK-20260806-auth-kb): the auth/connected-API KB teaching.
//   - AC4a: the KB's example directive round-trips the REAL renderDirectiveSchema
//     (M49 — corrupt the example's kind → RED). Same cross-package pattern as the
//     inferrer few-shot contract test.
//   - AC3: the rendered teaching never teaches the LLM-excluded proposal keys, nor
//     the display-only echoes — 7 names checked in JSON-key/backtick context
//     (M51: teach headerTemplate → RED; M56: teach confidence → RED).
//   - AC10b: retrieval delivery — build-time auth queries return the 90-file's
//     emission teaching within searchKnowledge's top-5 (M58: demote the file's
//     auth headings → RED). Headings are retrieval-load-bearing (ADR-0004).
import { describe, expect, it } from 'vitest';
import { AUTH_KINDS, AUTH_WIZARD_DIRECTIVE_KIND, renderDirectiveSchema } from '@snugprotocol/protocol';

import { PROMPT_FILES } from '../generated/content.js';
import { getKnowledgeBase, searchKnowledge } from '../index.js';

const KB_AUTH_FILE = 'knowledge-base/app-authoring/90-auth-and-connected-apis.md';

function authKbText(): string {
  const section = getKnowledgeBase().find((doc) => doc.file === KB_AUTH_FILE);
  expect(section, `${KB_AUTH_FILE} missing from the knowledge base`).toBeDefined();
  return section!.text;
}

/** Every fenced ```json block in the rendered teaching. */
function fencedJsonBlocks(text: string): string[] {
  return [...text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1]!.trim());
}

describe('AC4a — the KB example directive round-trips the real schema (M49)', () => {
  it('contains at least one fenced json example, and EVERY one parses as a valid directive', () => {
    const blocks = fencedJsonBlocks(authKbText());
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    for (const block of blocks) {
      const parsed = renderDirectiveSchema.safeParse(JSON.parse(block));
      expect(parsed.success, `KB example is not a valid directive:\n${block}`).toBe(true);
      expect(parsed.success && parsed.data.kind).toBe(AUTH_WIZARD_DIRECTIVE_KIND);
    }
  });

  it('examples carry ONLY v/kind/proposal — no display-only echoes taught by example', () => {
    for (const block of fencedJsonBlocks(authKbText())) {
      expect(Object.keys(JSON.parse(block) as object).sort()).toEqual(['kind', 'proposal', 'v']);
    }
  });

  it('example kindHint values are real AUTH_KINDS members (open string in the schema — pinned here)', () => {
    for (const block of fencedJsonBlocks(authKbText())) {
      const proposal = (JSON.parse(block) as { proposal: { kindHint?: string } }).proposal;
      if (proposal.kindHint !== undefined) {
        expect(AUTH_KINDS).toContain(proposal.kindHint);
      }
    }
  });

  it('the SOURCE uses the {{authWizardDirectiveKind}} placeholder, never the retyped literal (M50)', () => {
    const raw = PROMPT_FILES['knowledge-base/app-authoring/90-auth-and-connected-apis.md'];
    expect(raw).toBeDefined();
    expect(raw).toMatch(/\{\{authWizardDirectiveKind\}\}/);
    // The rendered output would look identical with a retyped literal — only this
    // source-level check keeps the single-home guarantee (ADR-0004).
    expect(raw).not.toMatch(new RegExp(AUTH_WIZARD_DIRECTIVE_KIND));
  });
});

describe('AC3 — the teaching never names the LLM-excluded keys (M51/M56)', () => {
  // The five llmProposalSchema omissions + the two display-only echoes the host
  // recomputes (B2). Matched as taught keys — backticked or JSON-key context — so
  // ordinary prose stays free.
  const forbidden = [
    'fields',
    'userLayerFields',
    'headerTemplate',
    'registrationConsoleUrl',
    'registrationInstructions',
    'confidence',
    'provenance',
  ] as const;

  for (const key of forbidden) {
    it(`never teaches \`${key}\``, () => {
      const text = authKbText();
      expect(text).not.toMatch(new RegExp(`\`${key}\``));
      expect(text).not.toMatch(new RegExp(`"${key}"\\s*:`));
    });
  }
});

describe('AC10b — retrieval delivery: build-time auth queries reach the emission teaching (M58)', () => {
  // The KB reaches the builder ONLY as top-5 searchKnowledge sections; teaching
  // that cannot win retrieval does not exist. Queries: the app-builder tool
  // prompt's own auth examples + plausible build-time phrasings.
  const queries = [
    'connected api auth',
    'external api credentials',
    'external api',
    'api key',
    'auth',
    'useConnectedFetch',
    // Review C-minor: the tokenizer keeps 'oauth2_*' whole, so a bare 'oauth' query
    // scores ONLY if the prose contains the standalone word — pinned here.
    'oauth',
  ];

  for (const query of queries) {
    it(`"${query}" returns the 90-file's emission teaching in the top 3`, () => {
      // slice() matters: the zero-score fallback returns EVERY document, so an
      // unsliced find() would pass even when retrieval has effectively failed.
      // As authored the emission hit ranks FIRST for every query here; top-3
      // leaves margin for unrelated KB growth while still failing on demotion.
      const hits = searchKnowledge(query).slice(0, 3);
      const emissionHit = hits.find(
        (hit) => hit.file === KB_AUTH_FILE && hit.text.includes(AUTH_WIZARD_DIRECTIVE_KIND),
      );
      expect(
        emissionHit,
        `top-3 for "${query}": ${hits.map((h) => `${h.file}#${h.heading}`).join(' | ')}`,
      ).toBeDefined();
    });
  }
});

describe('AL-05 review C1 — the net-visibility teaching never overclaims the shipped inspector (M60)', () => {
  // The shipped frames timeline renders net frames with NO per-frame method/host/
  // status detail, and the mutating-call confirm supports a session-remember grant.
  // The teaching must claim no more than the host delivers (review finding C1).
  it('does not teach (method, host, status) detail or an always-visible / asks-every-time claim', () => {
    const text = authKbText();
    expect(text).not.toMatch(/method, host, status/);
    expect(text).not.toMatch(/always see|always asked|confirm each time|asked every time/i);
  });
});
