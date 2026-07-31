// Frame-literal sync: every `snug:` frame literal in the RENDERED KB must be a real
// FRAME_TYPES value (placeholders guarantee this; a drifted retyped literal cannot).
import { describe, expect, it } from 'vitest';
import { FRAME_TYPES } from '@snugprotocol/protocol';

import { getKnowledgeBase } from '../index.js';

const KNOWN_FRAME_TYPES = new Set<string>(Object.values(FRAME_TYPES));

describe('frame-literal sync (rendered KB vs FRAME_TYPES)', () => {
  it('every snug:* frame literal in the rendered KB is a FRAME_TYPES value', () => {
    const violations: string[] = [];
    for (const section of getKnowledgeBase()) {
      // Reserved-namespace wildcard mentions (`snug:*`, `snug:app-*`) are prose, not frames.
      const scannable = section.text.replace(/snug:[a-z-]*\*/g, '');
      const matches = scannable.match(/snug:[a-z][a-z-]*[a-z]/g) ?? [];
      for (const literal of new Set(matches)) {
        if (!KNOWN_FRAME_TYPES.has(literal)) {
          violations.push(`${section.file}: "${literal}" is not a FRAME_TYPES value`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the rendered KB actually teaches the core frames', () => {
    const kbText = getKnowledgeBase()
      .map((s) => s.text)
      .join('\n');
    for (const frame of [
      FRAME_TYPES.announce,
      FRAME_TYPES.hostReady,
      FRAME_TYPES.appMessage,
      FRAME_TYPES.appResponse,
      FRAME_TYPES.dbRequest,
    ]) {
      expect(kbText, `KB must mention ${frame}`).toContain(frame);
    }
  });
});
