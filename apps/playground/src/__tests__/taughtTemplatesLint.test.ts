// TASK-20260810-p2-pipeline FOLD — the taught form and the ENFORCED form may not drift.
//
// THE DEFECT THIS PINS. The KB and the inferrer prompt taught header templates written
// with the renderer's triple-brace runtime escape (`{{{request.timestamp}}}`). That escape
// only survives for simple identifiers: `render.ts`'s PLACEHOLDER charset is
// [A-Za-z0-9_:-], so `{{{api_key}}}` correctly renders to `{{api_key}}` but
// `{{{request.timestamp}}}` and `{{{hmac_sha256_b64(a, b)}}}` — which contain '.', '(',
// ',' and spaces — do NOT match and pass through as LITERAL triple braces. A model copying
// the Coinbase exemplar therefore emits a template the host's own `lintAuthHeaderTemplate`
// REFUSES, for the exact provider the phase exists to support.
//
// Nothing connected the two before: every AC test hand-typed the correct bare-brace form
// rather than sourcing it from the prompt or KB, which is why the drift passed Gate 4.
// This test sources the templates from the RENDERED artifacts the model actually sees and
// runs them through the REAL lint, so the two can never separate again.

// It lives in the playground rather than in packages/knowledge because the assertion
// spans two packages that deliberately do NOT depend on each other — `knowledge` is the
// leaf prompt store (protocol only) and `auth` owns the lint. The playground is the first
// place both are in scope, and it is where the taught form is actually consumed.

import { describe, expect, it } from 'vitest';
import { lintAuthHeaderTemplate } from '@snugprotocol/auth';
import { getKnowledgeBase, getToolPrompt } from '@snugprotocol/knowledge';

/**
 * Every `"headerTemplate": { ... }` object literal in a rendered text, brace-matched so a
 * nested object cannot truncate the capture.
 */
function extractHeaderTemplates(text: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  const opener = /"headerTemplate"\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) {
          found.push(JSON.parse(text.slice(start, i + 1)) as Record<string, string>);
          break;
        }
      }
    }
  }
  return found;
}

/** Field keys declared beside a template in the same fenced example. */
const TAUGHT_FIELD_KEYS = ['api_key', 'api_secret', 'passphrase', 'token'];

function renderedKnowledgeBase(): string {
  const sections = getKnowledgeBase();
  return sections.map((section) => `${section.heading}\n${section.text}`).join('\n\n');
}

describe('P2 FOLD — every taught headerTemplate passes the real lint', () => {
  it('the rendered inferrer prompt teaches only templates the host accepts', () => {
    const templates = extractHeaderTemplates(getToolPrompt('connection-requirement-inferrer'));
    // Guard the extractor itself: a silently-empty match set would make this vacuous.
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) {
      const lint = lintAuthHeaderTemplate(template, { fieldKeys: TAUGHT_FIELD_KEYS });
      expect(lint.issues, `taught template refused by the host lint: ${JSON.stringify(template)}`).toEqual([]);
      expect(lint.ok).toBe(true);
    }
  });

  it('the rendered app-authoring KB teaches only templates the host accepts', () => {
    const templates = extractHeaderTemplates(renderedKnowledgeBase());
    expect(templates.length).toBeGreaterThanOrEqual(1);
    for (const template of templates) {
      const lint = lintAuthHeaderTemplate(template, { fieldKeys: TAUGHT_FIELD_KEYS });
      expect(lint.issues, `taught template refused by the host lint: ${JSON.stringify(template)}`).toEqual([]);
      expect(lint.ok).toBe(true);
    }
  });

  // NEGATIVE: the triple brace is what breaks these, and it breaks them ONLY because the
  // inner expression leaves the placeholder charset. Pin both halves of that fact so a
  // future author cannot "helpfully" re-add the escape.
  it('the triple-brace escape is what fails — and it is unnecessary for these expressions', () => {
    const escaped = { 'CB-ACCESS-TIMESTAMP': '{{{request.timestamp}}}' };
    expect(lintAuthHeaderTemplate(escaped, { fieldKeys: TAUGHT_FIELD_KEYS }).ok).toBe(false);

    const bare = { 'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}' };
    expect(lintAuthHeaderTemplate(bare, { fieldKeys: TAUGHT_FIELD_KEYS }).ok).toBe(true);
  });
});
