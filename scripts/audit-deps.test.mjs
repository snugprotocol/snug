// Unit tests for the dependency-advisory gate (node:test — dependency-free, runs as
// part of `pnpm run audit:deps` so it cannot rot unexercised).
//
// ADR-0056: the gate reds on any un-allowlisted advisory at or above the threshold
// severity, and ALSO reds when an allowlisted acceptance has passed its reviewBy date —
// an accepted risk must never silently become permanent.
//
// These tests drive the pure classifier over fixture reports rather than the network,
// because the gate's value depends on it failing for the RIGHT reasons: a fresh high
// must red, an accepted one must not, an expired acceptance must red, a malformed
// allowlist entry must red rather than silently excusing an advisory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  GATE_SEVERITIES,
  classifyReport,
  parseAllowlist,
  summarize,
} from './audit-deps.mjs';

const TODAY = '2026-08-24';

const advisory = (over) => ({
  github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
  severity: 'high',
  module_name: 'left-pad',
  vulnerable_versions: '<1.0.0',
  patched_versions: '>=1.0.0',
  title: 'left-pad pads left too enthusiastically',
  url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
  findings: [{ version: '0.9.0', paths: ['. > left-pad@0.9.0'] }],
  ...over,
});

const report = (...advisories) => ({
  advisories: Object.fromEntries(advisories.map((a, i) => [String(i + 1), a])),
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
});

const allow = (over) => ({
  ghsa: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  class: 'runtime-unreachable',
  reason: 'the padding API is never called from a shipped surface',
  task: 'TASK-20260824-dependabot-triage',
  reviewBy: '2026-11-30',
  ...over,
});

test('GATE_SEVERITIES gates high and critical only — moderate/low never gate', () => {
  assert.deepEqual([...GATE_SEVERITIES].sort(), ['critical', 'high']);
});

test('an un-allowlisted HIGH advisory fails, naming the GHSA id and the package', () => {
  const { failures } = classifyReport(report(advisory()), [], TODAY);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /GHSA-aaaa-bbbb-cccc/);
  assert.match(failures[0], /left-pad/);
});

test('an un-allowlisted CRITICAL advisory fails', () => {
  const { failures } = classifyReport(
    report(advisory({ severity: 'critical' })),
    [],
    TODAY,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /critical/i);
});

test('an allowlisted advisory passes and is reported as accepted', () => {
  const { failures, accepted } = classifyReport(report(advisory()), [allow()], TODAY);
  assert.deepEqual(failures, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].ghsa, 'GHSA-aaaa-bbbb-cccc');
});

test('an allowlisted advisory whose reviewBy has PASSED fails — acceptance is time-boxed', () => {
  const { failures } = classifyReport(
    report(advisory()),
    [allow({ reviewBy: '2026-08-23' })],
    TODAY,
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0], /review/i);
  assert.match(failures[0], /2026-08-23/);
});

test('reviewBy exactly TODAY is still accepted — the gate reds the day AFTER', () => {
  const { failures } = classifyReport(report(advisory()), [allow({ reviewBy: TODAY })], TODAY);
  assert.deepEqual(failures, []);
});

test('MODERATE and LOW advisories never gate, allowlisted or not', () => {
  const { failures, belowThreshold } = classifyReport(
    report(
      advisory({ severity: 'moderate', github_advisory_id: 'GHSA-mmmm-mmmm-mmmm' }),
      advisory({ severity: 'low', github_advisory_id: 'GHSA-llll-llll-llll' }),
    ),
    [],
    TODAY,
  );
  assert.deepEqual(failures, []);
  assert.equal(belowThreshold.length, 2);
});

test('a malformed allowlist entry (no reason) fails rather than silently excusing', () => {
  const { failures } = classifyReport(
    report(advisory()),
    [allow({ reason: '' })],
    TODAY,
  );
  // Two failures, and both matter: the malformed entry is named, AND the advisory it
  // failed to excuse is still reported — a broken acceptance must not shadow the risk.
  assert.equal(failures.length, 2);
  assert.ok(failures.some((f) => /reason/.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /GHSA-aaaa-bbbb-cccc/.test(f)), failures.join('\n'));
});

test('a malformed allowlist entry (no task) fails — every acceptance names its task', () => {
  const { failures } = classifyReport(report(advisory()), [allow({ task: undefined })], TODAY);
  assert.equal(failures.length, 2);
  assert.ok(failures.some((f) => /task/.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /GHSA-aaaa-bbbb-cccc/.test(f)), failures.join('\n'));
});

test('a malformed allowlist entry (bad reviewBy) fails', () => {
  const { failures } = classifyReport(
    report(advisory()),
    [allow({ reviewBy: 'someday' })],
    TODAY,
  );
  assert.equal(failures.length, 2);
  assert.ok(failures.some((f) => /reviewBy/.test(f)), failures.join('\n'));
  assert.ok(failures.some((f) => /GHSA-aaaa-bbbb-cccc/.test(f)), failures.join('\n'));
});

test('an allowlist entry matches on GHSA id, not on package name alone', () => {
  const { failures } = classifyReport(
    report(advisory()),
    [allow({ ghsa: 'GHSA-zzzz-zzzz-zzzz' })],
    TODAY,
  );
  assert.equal(failures.length, 1, 'a different GHSA must not excuse this advisory');
});

test('an allowlist entry whose GHSA is not in the report is reported as stale', () => {
  const { stale } = classifyReport(
    report(),
    [allow({ ghsa: 'GHSA-gone-gone-gone' })],
    TODAY,
  );
  assert.equal(stale.length, 1);
  assert.equal(stale[0].ghsa, 'GHSA-gone-gone-gone');
});

test('a stale allowlist entry does NOT fail the gate — a fixed advisory is good news', () => {
  const { failures } = classifyReport(report(), [allow()], TODAY);
  assert.deepEqual(failures, []);
});

test('parseAllowlist reads the entries array and tolerates comment keys', () => {
  const entries = parseAllowlist(
    JSON.stringify({ $comment: 'why this file exists', entries: [allow()] }),
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].package, 'left-pad');
});

test('parseAllowlist throws on a non-array entries field rather than defaulting to empty', () => {
  assert.throws(() => parseAllowlist(JSON.stringify({ entries: {} })), /entries/);
});

test('summarize names each failure on its own line and states the remedy', () => {
  const { failures } = classifyReport(report(advisory()), [], TODAY);
  const text = summarize({ failures, accepted: [], stale: [], belowThreshold: [] });
  assert.match(text, /GHSA-aaaa-bbbb-cccc/);
  assert.match(text, /audit-allowlist\.json/);
});

test('the checked-in allowlist itself is well-formed and every entry is unexpired', () => {
  // Cargo entries are documentation only (the npm gate filters them), but they must
  // still satisfy the same shape rules — checked separately below.
  const raw = readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8');
  const entries = parseAllowlist(raw);
  const npmEntries = entries.filter((e) => e.tool !== 'cargo');
  const today = new Date().toISOString().slice(0, 10);
  // Reuse the real classifier: build a report that contains every allowlisted GHSA at
  // gating severity, so a malformed or expired entry surfaces here at author time and
  // not only on the next `pnpm audit:deps`.
  const synthetic = report(
    ...npmEntries.map((e) =>
      advisory({ github_advisory_id: e.ghsa, module_name: e.package, severity: 'high' }),
    ),
  );
  const { failures } = classifyReport(synthetic, npmEntries, today);
  assert.deepEqual(failures, [], failures.join('\n'));

  // Cargo-tool entries: same required fields, same expiry rule.
  for (const entry of entries.filter((e) => e.tool === 'cargo')) {
    for (const field of ['ghsa', 'package', 'class', 'reason', 'task', 'reviewBy']) {
      assert.ok(
        typeof entry[field] === 'string' && entry[field].trim() !== '',
        `cargo allowlist entry ${entry.ghsa}: \`${field}\` is required`,
      );
    }
    assert.match(entry.reviewBy, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.reviewBy >= today, `cargo acceptance ${entry.ghsa} lapsed ${entry.reviewBy}`);
  }
});
