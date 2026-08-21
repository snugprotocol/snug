// Unit tests for the threat-model conformance checker (node:test — dependency-free,
// runs as part of `pnpm run check-threat-model` so it cannot rot unexercised).
//
// The checker's own value depends on it failing for the RIGHT reasons, so these tests
// drive the pure parsers directly rather than the filesystem: a ledger that agrees, one
// that has drifted, one missing a delta entirely, and one pinning a file that is gone.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  backtickedPaths,
  checkDeltaLedger,
  checkProseDeltaCount,
  checkResidualIdsUnique,
  hashPrefix,
  LEDGER_BEGIN,
  LEDGER_END,
  parseInvariantRows,
  parseLedger,
  sectionOf,
} from './check-threat-model.mjs';

const ledgerDoc = (rows) =>
  [
    '## The deltas this consolidates',
    '',
    LEDGER_BEGIN,
    '',
    '| Delta | Pinned hash | Consolidated into |',
    '|---|---|---|',
    ...rows,
    '',
    LEDGER_END,
  ].join('\n');

test('hashPrefix is a stable 12-hex prefix', () => {
  const a = hashPrefix('hello');
  assert.match(a, /^[0-9a-f]{12}$/);
  assert.equal(a, hashPrefix('hello'));
  assert.notEqual(a, hashPrefix('hello '));
});

test('parseLedger reads path → hash rows between the markers', () => {
  const md = ledgerDoc(['| `docs/security/threat-model-delta-x.md` | `abc123def456` | §4 |']);
  const ledger = parseLedger(md);
  assert.equal(ledger.get('docs/security/threat-model-delta-x.md'), 'abc123def456');
  assert.equal(ledger.size, 1);
});

test('parseLedger returns null when the markers are absent', () => {
  assert.equal(parseLedger('# a document with no ledger at all'), null);
});

test('checkDeltaLedger: an agreeing ledger yields no failures', () => {
  const ledger = new Map([['docs/security/a.md', 'aaaaaaaaaaaa']]);
  const actual = new Map([['docs/security/a.md', 'aaaaaaaaaaaa']]);
  assert.deepEqual(checkDeltaLedger(ledger, actual), []);
});

test('checkDeltaLedger: an EDITED delta fails — the model must be re-read against it', () => {
  const ledger = new Map([['docs/security/a.md', 'aaaaaaaaaaaa']]);
  const actual = new Map([['docs/security/a.md', 'bbbbbbbbbbbb']]);
  const failures = checkDeltaLedger(ledger, actual);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /changed since consolidation/);
});

test('checkDeltaLedger: a NEW delta fails — adding one beside the model is not consolidating it', () => {
  const ledger = new Map();
  const actual = new Map([['docs/security/new.md', 'cccccccccccc']]);
  const failures = checkDeltaLedger(ledger, actual);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /not consolidated/);
});

test('checkDeltaLedger: a STALE row fails — a pin whose file is gone', () => {
  const ledger = new Map([['docs/security/deleted.md', 'dddddddddddd']]);
  const failures = checkDeltaLedger(ledger, new Map());
  assert.equal(failures.length, 1);
  assert.match(failures[0], /stale ledger row/);
});

test('checkDeltaLedger: a missing ledger is itself the failure, not a crash', () => {
  const failures = checkDeltaLedger(null, new Map([['docs/security/a.md', 'aaaaaaaaaaaa']]));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no delta ledger/);
});

test('backtickedPaths keeps repo paths and drops prose, stripping :line suffixes', () => {
  assert.deepEqual(
    backtickedPaths('| `packages/auth/src/scrub.ts:12` — exact substring, `never` a regex |'),
    ['packages/auth/src/scrub.ts'],
  );
  // Prose in backticks is not a path and must not be demanded to exist.
  assert.deepEqual(backtickedPaths('| `connect-src \'none\'` |'), []);
});

test('sectionOf extracts one ## section and stops at the next', () => {
  const md = ['## Enforced invariants', 'row text', '', '## Residuals', 'other text'].join('\n');
  assert.match(sectionOf(md, /enforced invariants/i), /row text/);
  assert.doesNotMatch(sectionOf(md, /enforced invariants/i), /other text/);
  assert.equal(sectionOf(md, /nothing like this/i), null);
});

test('parseInvariantRows finds enforcement and test columns by HEADER, not position', () => {
  const md = [
    '## Enforced invariants',
    '',
    '| Invariant | Enforcement | Test |',
    '|---|---|---|',
    '| a promise | `packages/auth/src/scrub.ts` | `packages/auth/src/__tests__/scrub.test.ts` |',
  ].join('\n');
  const rows = parseInvariantRows(md);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].enforcement, ['packages/auth/src/scrub.ts']);
  assert.deepEqual(rows[0].test, ['packages/auth/src/__tests__/scrub.test.ts']);
});

test('parseInvariantRows: a REORDERED table still resolves the right columns', () => {
  const md = [
    '## Enforced invariants',
    '',
    '| Invariant | Test | Enforcement |',
    '|---|---|---|',
    '| a promise | `packages/auth/src/__tests__/scrub.test.ts` | `packages/auth/src/scrub.ts` |',
  ].join('\n');
  const rows = parseInvariantRows(md);
  assert.deepEqual(rows[0].enforcement, ['packages/auth/src/scrub.ts']);
  assert.deepEqual(rows[0].test, ['packages/auth/src/__tests__/scrub.test.ts']);
});

test('parseInvariantRows surfaces a row with NO enforcement path — the AC3 case', () => {
  // A promise with no named enforcement belongs in residuals; the checker must be able
  // to see the difference rather than accepting confident prose.
  const md = [
    '## Enforced invariants',
    '',
    '| Invariant | Enforcement | Test |',
    '|---|---|---|',
    '| we are careful about this | it is handled throughout | `packages/auth/src/__tests__/scrub.test.ts` |',
  ].join('\n');
  const rows = parseInvariantRows(md);
  assert.deepEqual(rows[0].enforcement, []);
});

// ── TM7: residual ids are unique (TASK-20260821, plan-review finding 17) ──
// v1 shipped two R-14s and downstream citations then disagreed about which was meant.
// The hash-pin mechanism is structurally blind to this: a delta can be perfectly
// unmoved while the document numbers two residuals the same.

test('checkResidualIdsUnique: distinct ids yield no failures', () => {
  const md = ['**R-1 — first.**', 'prose', '- **R-2 — second.**', '**R-30 — third.**'].join('\n');
  assert.deepEqual(checkResidualIdsUnique(md), []);
});

test('checkResidualIdsUnique: a DUPLICATE definition fails and names the id', () => {
  const md = ['**R-14 — the ceiling scope.**', 'prose', '- **R-14 — a protected file.**'].join('\n');
  const failures = checkResidualIdsUnique(md);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /R-14 is DEFINED 2 times/);
});

test('checkResidualIdsUnique: a REFERENCE is not a definition', () => {
  // The distinguishing property: without it, every cross-reference ("see R-8", the
  // ledger's own "R-3, R-9" column) would read as a redefinition and the check would
  // fail on a correct document — a false positive that gets the check deleted.
  const md = [
    '**R-8 — untrusted text.**',
    'The precondition R-8 depends on, see R-8 above.',
    '| `docs/security/delta-x.md` | `abc123def456` | §5 ceiling · R-8, R-9 |',
  ].join('\n');
  assert.deepEqual(checkResidualIdsUnique(md), []);
});

test('checkResidualIdsUnique: the REAL threat model has unique ids', () => {
  // Against the shipped document, not a fixture — the fixture proves the mechanism,
  // this proves the artifact.
  const md = readFileSync(new URL('../docs/threat-model.md', import.meta.url), 'utf8');
  assert.deepEqual(checkResidualIdsUnique(md), []);
});

// --- TM8: the §1 prose delta count must agree with the ledger --------------
//
// WHY THIS EXISTS (TASK-20260821-launch-security-review). The shipped v2 document said
// "This document consolidates eight per-change threat-model deltas" while its ledger
// carried twelve rows and docs/security/ held twelve files — and the checker was fully
// green throughout, because its only count assertion was `actual.size >= 8`: a FLOOR that
// passes at twelve and never reads the prose at all. A mechanical check earns exactly the
// claim its mechanism supports, and this one was being credited with a claim it could not
// make. These tests pin the check that would have caught it.

test('checkProseDeltaCount: prose agreeing with the ledger yields no failures', () => {
  const md = [
    'This document consolidates twelve per-change threat-model deltas (§8).',
    LEDGER_BEGIN,
    '| Delta | Pinned hash | Consolidated into |',
    '|---|---|---|',
    ...Array.from({ length: 12 }, (_, i) => `| \`docs/security/threat-model-delta-${i}.md\` | \`0123456789ab\` | §5 |`),
    LEDGER_END,
  ].join('\n');
  assert.deepEqual(checkProseDeltaCount(md), []);
});

test('checkProseDeltaCount: the EXACT v2 defect fails and names both numbers', () => {
  const md = [
    'This document consolidates eight per-change threat-model deltas (§8).',
    LEDGER_BEGIN,
    '| Delta | Pinned hash | Consolidated into |',
    '|---|---|---|',
    ...Array.from({ length: 12 }, (_, i) => `| \`docs/security/threat-model-delta-${i}.md\` | \`0123456789ab\` | §5 |`),
    LEDGER_END,
  ].join('\n');
  const failures = checkProseDeltaCount(md);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /eight/i);
  assert.match(failures[0], /12/);
});

test('checkProseDeltaCount: a missing prose sentence is a failure, never a silent pass', () => {
  // The failure mode a "find the number and compare it" check invites: no number found,
  // nothing compared, green. An absent claim must fail loudly.
  const md = [LEDGER_BEGIN, '| Delta |', LEDGER_END].join('\n');
  const failures = checkProseDeltaCount(md);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no delta-count sentence/i);
});

test('checkProseDeltaCount: the REAL threat model agrees with its own ledger', () => {
  const md = readFileSync(new URL('../docs/threat-model.md', import.meta.url), 'utf8');
  assert.deepEqual(checkProseDeltaCount(md), []);
});
