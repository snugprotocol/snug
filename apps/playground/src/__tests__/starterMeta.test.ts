// starterMeta.test.ts — TASK-20260820-starter-updates (ADR-0045).
//
// THE SEAM-OFF PROBE (lessons.md 2026-08-08): every other starter-update suite injects
// fixtures, so nothing there proves the PRODUCTION glob resolves — a misspelled
// `import.meta.glob` pattern would keep every fixture-driven test green while shipping
// with no starter versioned at all (the exact shape that once kept 477 tests green over
// an inert feature). This file runs the real wiring: the real glob, the real
// starter.json bytes, joined against the real shelf.

import { describe, expect, it } from 'vitest';

import { listStarterApps, STARTER_PREFIX } from '../starter/starterApps.js';
import { parseStarterMeta, starterMetaFor } from '../starter/starterMeta.js';

describe('bundled starter metadata (real glob, no fixtures)', () => {
  it('every starter on the shelf has parseable release metadata', async () => {
    const starters = listStarterApps();
    expect(starters.length).toBeGreaterThanOrEqual(13);
    for (const starter of starters) {
      const folder = starter.id.slice(STARTER_PREFIX.length);
      const meta = await starterMetaFor(folder);
      expect(meta, `examples/${folder}/starter.json must bundle and parse`).toBeDefined();
      expect(meta!.version).toBeGreaterThanOrEqual(1);
      expect(meta!.changelog[0]?.version).toBe(meta!.version);
    }
  });

  it('an unknown folder reads as unversioned, not as an error', async () => {
    expect(await starterMetaFor('no-such-starter')).toBeUndefined();
  });
});

describe('parseStarterMeta is parse-and-drop', () => {
  it('drops malformed shapes instead of throwing', () => {
    expect(parseStarterMeta('not json')).toBeUndefined();
    expect(parseStarterMeta('{"version":0,"changelog":[]}')).toBeUndefined();
    expect(parseStarterMeta('{"version":2,"changelog":[]}')).toBeUndefined();
    expect(
      parseStarterMeta(JSON.stringify({ version: 2, changelog: [{ version: 2, date: '2026-08-21', sections: [] }] })),
    ).toBeUndefined();
  });

  it('keeps a well-formed meta intact, optional title included', () => {
    const meta = parseStarterMeta(
      JSON.stringify({
        version: 2,
        appHash: 'ignored-at-runtime',
        changelog: [
          { version: 2, date: '2026-08-21', title: 'Faster boot', sections: [{ title: 'Improved', items: ['Boots faster.'] }] },
          { version: 1, date: '2026-08-01', sections: [{ title: "What's new", items: ['Initial release.'] }] },
        ],
      }),
    );
    expect(meta).toMatchObject({ version: 2 });
    expect(meta!.changelog).toHaveLength(2);
    expect(meta!.changelog[0]).toMatchObject({ title: 'Faster boot' });
    expect(meta!.changelog[1]!.title).toBeUndefined();
  });
});
