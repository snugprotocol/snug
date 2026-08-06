// Unit tests for the code-map count regenerator (node:test — dependency-free, runs as
// part of `pnpm run update-code-map` so it cannot rot unexercised).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { locationPackage, parseTestLog, rewriteCodeMap } from './update-code-map-counts.mjs';

// Fixture invariant (enforced by the anti-spoof cross-check): each vitest package's
// summary total equals the sum of its per-file counts, exactly as in a real run.
const LOG = [
  '@snugprotocol/db:test:  ✓ src/userdb/__tests__/materializer.test.ts (17 tests) 834ms',
  '@snugprotocol/db:test:  ✓ src/sync/__tests__/loop.test.ts (30 tests) 12ms',
  '@snugprotocol/db:test:  ✓ src/sync/__tests__/providers.test.ts (14 tests) 9ms',
  '@snugprotocol/db:test:       Tests  61 passed (61)',
  'playground:test:  ✓ src/run/__tests__/railTabs.test.tsx (9 tests) 40ms',
  'playground:test:  ✓ src/views/__tests__/hub.test.tsx (239 tests | 2 skipped) 90ms',
  'playground:test:       Tests  246 passed | 2 skipped (248)',
  'examples:test: # Subtest: chess: single-file HTML',
  'examples:test: # tests 18',
  'examples:test: # pass 18',
  'unrelated line without a turbo prefix',
].join('\n');

const DIR_TO_NAME = new Map([
  ['packages/db', '@snugprotocol/db'],
  ['apps/playground', 'playground'],
  ['examples', 'examples'],
]);

test('parseTestLog: per-package totals, per-file counts, TAP totals', () => {
  const parsed = parseTestLog(LOG);
  assert.equal(parsed.get('@snugprotocol/db').total, 61);
  assert.equal(parsed.get('@snugprotocol/db').files.get('src/userdb/__tests__/materializer.test.ts'), 17);
  assert.equal(parsed.get('playground').total, 248);
  assert.equal(parsed.get('examples').total, 18);
  assert.equal(parsed.size, 3);
});

test('locationPackage: dir + sub-tree extraction', () => {
  assert.deepEqual(locationPackage('`packages/db/src/sync` ✅'), { dir: 'packages/db', sub: 'src/sync' });
  assert.deepEqual(locationPackage('`apps/playground/src` ✅'), { dir: 'apps/playground', sub: 'src' });
  assert.deepEqual(locationPackage('`examples/{chess,flying-pig}`'), { dir: 'examples', sub: '' });
  assert.equal(locationPackage('nothing to see'), undefined);
});

test('rewriteCodeMap: total-marker, sub-tree, per-file, and suite counts are refreshed', () => {
  const table = [
    '| Area | Location | Tests |',
    '|---|---|---|',
    '| User DB | `packages/db/src/userdb` ✅ | `packages/db` vitest (163 total) |',
    '| Sync | `packages/db/src/sync` ✅ | `packages/db` vitest (99) |',
    '| Materializer | `packages/db/src/userdb/userdb.ts` ✅ | `packages/db` `materializer.test.ts` (3) |',
    '| Examples | `examples/{chess}` ✅ | `examples` validate suite (12) |',
  ].join('\n');
  const { content, changes } = rewriteCodeMap(table, parseTestLog(LOG), DIR_TO_NAME);
  assert.ok(content.includes('vitest (61 total)'), 'package total from the summary line');
  assert.ok(content.includes('vitest (44)'), 'sub-tree sum 30+14 for src/sync');
  assert.ok(content.includes('`materializer.test.ts` (17)'), 'per-file count by basename');
  assert.ok(content.includes('validate suite (18)'), 'TAP total for node:test packages');
  assert.equal(changes.length, 4);
});

test('rewriteCodeMap: Playwright numbers and prose rows are left byte-identical', () => {
  const table = [
    '| Area | Location | Tests |',
    '|---|---|---|',
    '| Playground | `apps/playground/src` ✅ | vitest (200) + Playwright (30, incl. the C2 gate) |',
    '| No numbers | `packages/db/src/userdb` ✅ | `packages/db` vitest |',
    '| Wildcards | `apps/playground/src` ✅ | playground `llmInspector*.test.*` (incl. live) |',
  ].join('\n');
  const { content } = rewriteCodeMap(table, parseTestLog(LOG), DIR_TO_NAME);
  assert.ok(content.includes('vitest (248) + Playwright (30, incl. the C2 gate)'), 'vitest updated, Playwright untouched');
  assert.ok(content.includes('| `packages/db` vitest |'), 'count-less cell untouched');
  assert.ok(content.includes('`llmInspector*.test.*` (incl. live)'), 'wildcard prose untouched');
});

test('rewriteCodeMap: unresolvable counts are never guessed to zero', () => {
  const table = [
    '| Area | Location | Tests |',
    '|---|---|---|',
    '| Unknown pkg | `packages/ghost/src` ✅ | vitest (7) |',
    '| Empty subtree | `packages/db/src/nowhere` ✅ | vitest (7) |',
  ].join('\n');
  const { content, changes } = rewriteCodeMap(table, parseTestLog(LOG), DIR_TO_NAME);
  assert.equal(changes.length, 0);
  assert.equal((content.match(/vitest \(7\)/g) ?? []).length, 2);
});

test('rewriteCodeMap: idempotent — a second pass changes nothing', () => {
  const table = [
    '| Area | Location | Tests |',
    '|---|---|---|',
    '| Sync | `packages/db/src/sync` ✅ | `packages/db` vitest (99) |',
  ].join('\n');
  const parsed = parseTestLog(LOG);
  const once = rewriteCodeMap(table, parsed, DIR_TO_NAME);
  const twice = rewriteCodeMap(once.content, parsed, DIR_TO_NAME);
  assert.equal(twice.content, once.content);
  assert.equal(twice.changes.length, 0);
});

// --- anti-spoofing regressions (adversarial-review fix #1) --------------------------
// Test code can print arbitrary lines that land under the package's turbo prefix; a
// loose "anything ending in (N)" summary match was forgeable, last-match-wins.

const TOTAL_ROW = [
  '| Area | Location | Tests |',
  '|---|---|---|',
  '| User DB | `packages/db/src/userdb` ✅ | `packages/db` vitest (163 total) |',
].join('\n');

test('spoof: a printed line merely ending in (N) is not a summary and cannot win', () => {
  const spoofed = `${LOG}\n@snugprotocol/db:test:       Tests like these are great (999)`;
  const refusals = [];
  const parsed = parseTestLog(spoofed, (pkg, detail) => refusals.push([pkg, detail]));
  assert.equal(parsed.get('@snugprotocol/db').total, 61, 'the real summary still wins');
  assert.equal(refusals.length, 0);

  const { content } = rewriteCodeMap(TOTAL_ROW, parsed, DIR_TO_NAME);
  assert.ok(content.includes('vitest (61 total)'));
  assert.ok(!content.includes('999'), 'the spoofed number must never reach the code map');
});

test('spoof: a shape-valid forged summary that disagrees with the per-file sum refuses the package', () => {
  // Forged line is LAST (the last-match-wins probe) and matches the real vitest shape.
  const spoofed = `${LOG}\n@snugprotocol/db:test:       Tests  1 passed (999)`;
  const refusals = [];
  const parsed = parseTestLog(spoofed, (pkg, detail) => refusals.push([pkg, detail]));
  assert.equal(parsed.has('@snugprotocol/db'), false, 'inconsistent package dropped wholesale');
  assert.deepEqual(refusals, [['@snugprotocol/db', { total: 999, fileSum: 61 }]]);

  const { content, changes } = rewriteCodeMap(TOTAL_ROW, parsed, DIR_TO_NAME);
  assert.equal(changes.length, 0, 'refused package rewrites nothing');
  assert.ok(content.includes('vitest (163 total)'), 'row left byte-identical');
});
