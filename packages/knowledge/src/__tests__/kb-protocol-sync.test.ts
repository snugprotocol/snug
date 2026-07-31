// KB ≡ protocol wire-shape sync (cheap textual guards until the KB≡SDK sync test lands):
// the copy-exactly bridge code in the RENDERED 20-html-template.md must read db-response
// result fields from the TOP LEVEL of the frame (dbResponseSchema ok:true carries
// rows/columns/value/bytesBase64 top-level, NOT under .data), read hostEvent payloads
// from `.data` ({event, data} per hostEventSchema), and guard sendMessage pre-ready
// (appMessageSchema requires a non-empty instanceId, which only exists after host-ready).
import { describe, expect, it } from 'vitest';

import { getKnowledgeBase } from '../index.js';

const TEMPLATE_FILE = 'knowledge-base/app-authoring/20-html-template.md';

/** The rendered copy-exactly template: the ```html fenced block of 20-html-template.md. */
function renderedBridgeCode(): string {
  const doc = getKnowledgeBase().find((s) => s.file === TEMPLATE_FILE);
  if (!doc) throw new Error(`${TEMPLATE_FILE} is missing from the rendered KB`);
  const match = /```html\n([\s\S]*?)\n```/.exec(doc.text);
  if (!match) throw new Error(`${TEMPLATE_FILE} has no \`\`\`html fenced template block`);
  return match[1] as string;
}

describe('KB template ≡ protocol wire shapes (20-html-template.md, rendered)', () => {
  const code = renderedBridgeCode();

  it('resolves db responses from TOP-LEVEL frame fields (rows/columns/value/bytesBase64)', () => {
    expect(code).toContain('data.rows');
    expect(code).toContain('data.columns');
    expect(code).toContain('data.value');
    expect(code).toContain('data.bytesBase64');
  });

  it('reads the theme-change payload from hostEvent .data ({event, data})', () => {
    expect(code).toContain('data.data && data.data.theme');
  });

  it('never reads the drifted shapes (.payload on hostEvent, .data.* on db responses)', () => {
    expect(code).not.toContain('data.payload');
    expect(code).not.toContain('result.data.value');
    expect(code).not.toContain('rowsAffected');
  });

  it('guards sendMessage against posting before host-ready', () => {
    expect(code).toContain('not connected');
  });
});
