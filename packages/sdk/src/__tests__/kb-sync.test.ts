// KB ≡ SDK sync (task AC-1): the copy-exactly hook block in the RENDERED knowledge-base
// template must equal embedded/snug-hooks.js after whitespace normalization. Editing
// either side without the other fails here — the sync discipline that keeps every
// generated app's bridge identical to the SDK reference implementation.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getKnowledgeBase } from '@snugprotocol/knowledge';
import { describe, expect, it } from 'vitest';

const TEMPLATE_FILE = 'knowledge-base/app-authoring/20-html-template.md';
const EMBEDDED_PATH = path.resolve(process.cwd(), 'embedded/snug-hooks.js');

/**
 * The hook portion of the rendered template: the `<script type="text/babel">` body of
 * the ```html fence, cut before the section-5 banner (RESPONSE SCHEMA — app-authored,
 * not SDK). Throws loudly on structural drift so the extraction never silently shrinks.
 */
function renderedHookBlock(): string {
  const doc = getKnowledgeBase().find((s) => s.file === TEMPLATE_FILE);
  if (!doc) throw new Error(`${TEMPLATE_FILE} is missing from the rendered KB`);
  const html = /```html\n([\s\S]*?)\n```/.exec(doc.text)?.[1];
  if (html === undefined) throw new Error(`${TEMPLATE_FILE} has no \`\`\`html fenced template block`);
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1];
  if (script === undefined) throw new Error('template has no <script type="text/babel"> block');
  const lines = script.split('\n');
  const bannerIndex = lines.findIndex((line) => line.includes('5. RESPONSE SCHEMA'));
  if (bannerIndex < 1) throw new Error('template script has no section-5 RESPONSE SCHEMA banner');
  return lines.slice(0, bannerIndex - 1).join('\n'); // also drops the ==== line above the banner
}

/** Whitespace normalization: per-line trim (tolerates the template's indentation), blank lines dropped. */
const normalize = (code: string): string =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

describe('KB ≡ SDK sync (20-html-template.md ↔ embedded/snug-hooks.js)', () => {
  it('the rendered KB hook block and embedded/snug-hooks.js are byte-identical after normalization', () => {
    const kb = normalize(renderedHookBlock());
    const embedded = normalize(readFileSync(EMBEDDED_PATH, 'utf8'));
    expect(embedded).toBe(kb);
  });

  it('the embedded file is fully rendered — no un-substituted {{placeholders}} survive', () => {
    const embedded = readFileSync(EMBEDDED_PATH, 'utf8');
    expect(embedded).not.toMatch(/\{\{[A-Za-z0-9_:-]+\}\}/);
    expect(embedded).toContain("'snug:host-ready'"); // frame literals injected from protocol constants
  });

  it('the embedded file covers all four copy-exactly sections and nothing app-authored', () => {
    const embedded = readFileSync(EMBEDDED_PATH, 'utf8');
    for (const name of ['SnugBridge', 'function useSnugApp', 'function usePersistedState', 'function useAppDB']) {
      expect(embedded).toContain(name);
    }
    expect(embedded).not.toContain('RESPONSE_SCHEMA'); // section 5+ stays in the KB only
    expect(embedded).not.toContain('ReactDOM');
  });
});
