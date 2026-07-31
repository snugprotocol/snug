// AC-8: the store teaches ONLY the Snug v0.1 protocol — no ancestor hook names,
// codenames, sandbox escapes, or localStorage-as-storage (storage is host-brokered).
import { describe, expect, it } from 'vitest';

import { renderedStore } from './helpers.js';

// Substring, case-insensitive. 'cheo'/'indra' also catch cheo-app, indra-app,
// useCheoAppBridge, useIndraAppBridge; kept explicit anyway for clear failure output.
const FORBIDDEN_TOKENS = [
  'cheo',
  'guardian',
  'indra',
  'cheo-app',
  'indra-app',
  'usecheoappbridge',
  'useindraappbridge',
  'allow-same-origin',
];

describe('no ancestor tokens in the rendered store', () => {
  it('rendered store contains no ancestor codenames, dead hooks, or sandbox escapes', () => {
    const violations: string[] = [];
    for (const entry of renderedStore()) {
      const lower = entry.text.toLowerCase();
      for (const token of FORBIDDEN_TOKENS) {
        if (lower.includes(token)) violations.push(`${entry.file}: contains "${token}"`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('every localStorage/sessionStorage mention is a do-not-use warning, never a teaching', () => {
    // The null-origin sandbox has no browser storage (one ancestor KB taught localStorage
    // via a sandbox escape the spec forbids). A mention is only legal inside an explicit
    // negation: a negating word within the surrounding 3 lines.
    const NEGATION = /\b(not|never|no|don't|do not|cannot|dead end|forbidden|blocked)\b/i;
    const violations: string[] = [];
    for (const entry of renderedStore()) {
      const lines = entry.text.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!/localstorage|sessionstorage/i.test(line)) continue;
        const context = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (!NEGATION.test(context)) {
          violations.push(`${entry.file}:${i + 1}: browser-storage mention without a nearby negation: "${line.trim()}"`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
