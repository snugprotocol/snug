// KB ≡ protocol wire-shape sync (cheap textual guards until the KB≡SDK sync test lands):
// the copy-exactly bridge code in the RENDERED 20-html-template.md must read db-response
// result fields from the TOP LEVEL of the frame (dbResponseSchema ok:true carries
// rows/columns/value/bytesBase64 top-level, NOT under .data), read hostEvent payloads
// from `.data` ({event, data} per hostEventSchema), and guard sendMessage pre-ready
// (appMessageSchema requires a non-empty instanceId, which only exists after host-ready).
//
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-2; security S1): section 1 gains the SOURCE guard
// (a frame from a sibling frame in the same document is ignored) and the access-response arm (settled
// by requestId, deleted first — terminal once), and the host-event arm dispatches `.data` to section
// 6's subscribers AFTER the theme code. The theme pin above stays exactly as it was.
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';
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

  it('PR-6: the bridge listener accepts a frame ONLY from the parent window — the source guard is its first line', () => {
    const guard = `if (event.source !== window.parent || !data || data.v !== ${PROTOCOL_VERSION}) return;`;
    expect(code).toContain(guard);
    // It is the bridge listener's FIRST statement after reading the data: nothing runs before it.
    expect(code).toMatch(new RegExp(`window\\.addEventListener\\('message', \\(event\\) => \\{\\s*const data = event\\.data;\\s*${guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // NEGATIVE: the unguarded line is gone.
    expect(code).not.toMatch(/^\s*if \(!data \|\| data\.v !== \d+\) return;$/m);
  });

  it('PR-6: the access-response arm settles by requestId from the TOP-LEVEL frame — deleted before it is settled, an unknown id ignored', () => {
    const at = code.indexOf(`if (data.type === '${FRAME_TYPES.accessResponse}') {`);
    expect(at, 'the access-response arm').toBeGreaterThan(0);
    const arm = code.slice(at);
    expect(arm).toContain('const settle = SnugBridge.accessPending.get(data.requestId);');
    expect(arm).toMatch(/if \(!settle\) return;/);
    expect(arm.indexOf('SnugBridge.accessPending.delete(data.requestId);')).toBeGreaterThan(0);
    expect(arm.indexOf('SnugBridge.accessPending.delete(data.requestId);')).toBeLessThan(arm.indexOf('settle(data);'));
  });

  it('PR-6: the host-event arm keeps the theme code FIRST and hands section 6’s subscribers the `.data` payload from a copy of the set', () => {
    const theme = code.indexOf('data.data && data.data.theme');
    const dispatch = code.indexOf('const subscribers = SnugBridge.hostEventListeners.get(data.event);');
    expect(dispatch, 'the dispatch to subscribers').toBeGreaterThan(0);
    expect(dispatch, 'after the theme code').toBeGreaterThan(theme);
    expect(code).toContain('if (subscribers) for (const fn of [...subscribers]) fn(data.data);');
  });
});
