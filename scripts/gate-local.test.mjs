// gate-local.test.mjs — the tests that make `pnpm run gate:local` trustworthy
// (TASK-20260820-local-ci-gate, AC3/AC4/AC10/AC11).
//
// WHY THIS FILE CARRIES MORE WEIGHT THAN A USUAL TEST. GitHub Actions is dormant
// (see .github/workflows/ci.yml's header) and this repo never had branch
// protection — private on a free org plan, so required status checks were never
// available. `gate:local` is therefore the ONLY thing standing between a commit
// and `main`, and `/close-session` merges automatically on its verdict. A gate
// that reports a false green is not a degraded gate; it is an active hazard,
// because it manufactures confidence at exactly the moment nothing else looks.
//
// So the properties under test here are not "does it run the commands" — they are:
//   AC3   every CI step has a local counterpart (no silent drift from the workflow)
//   AC4   nothing that failed or could not run is ever reported as a pass
//   AC10  a partial run states what it did NOT verify
//   AC11  DESELECTED is a distinct third state, never conflated with PASS
//
// Dependency-free (node: builtins), matching scripts/check-threat-model.test.mjs
// and scripts/check-sandbox-guard.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  LEGS,
  DEFAULT_LEGS,
  extractWorkflowRunSteps,
  parseLegSelection,
  renderVerdict,
  legStatuses,
  UNMAPPED_CI_STEPS,
} from './gate-local.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github', 'workflows', 'ci.yml');

// ---------------------------------------------------------------------------
// AC3 — the local gate is a proven SUPERSET of ci.yml
// ---------------------------------------------------------------------------

test('AC3: the narrow extractor reads run-steps out of ci.yml', () => {
  const steps = extractWorkflowRunSteps(readFileSync(WORKFLOW, 'utf8'));

  // The extractor is purpose-built rather than a YAML dependency: it only needs
  // `jobs.<id>.steps[].run`, and the workflow is a file we own. Adding a parser
  // dependency to read one known file is more surface than the job requires.
  assert.ok(steps.workspace, 'workspace job must be found');
  assert.ok(steps['desktop-shell'], 'desktop-shell job must be found');

  // Guard the extractor against silently returning nothing — the failure mode
  // that would make every other assertion in this file vacuously true.
  assert.ok(steps.workspace.length >= 4, `expected >=4 run-steps in workspace, got ${steps.workspace.length}`);
  assert.ok(
    steps['desktop-shell'].length >= 4,
    `expected >=4 run-steps in desktop-shell, got ${steps['desktop-shell'].length}`,
  );

  // A step is a command string, not an object/undefined.
  for (const [job, list] of Object.entries(steps)) {
    for (const s of list) {
      assert.equal(typeof s, 'string', `${job} step must be a string`);
      assert.ok(s.trim().length > 0, `${job} step must be non-empty`);
    }
  }
});

test('AC3: every ci.yml run-step maps to a local leg (extras allowed, gaps are not)', () => {
  const steps = extractWorkflowRunSteps(readFileSync(WORKFLOW, 'utf8'));
  const ciSteps = [...steps.workspace, ...steps['desktop-shell']];

  // Every command any local leg runs, flattened.
  const localCommands = LEGS.flatMap((l) => l.commands);

  const unmapped = [];
  for (const step of ciSteps) {
    if (UNMAPPED_CI_STEPS.some((re) => re.test(step))) continue; // documented, reasoned exemptions
    const covered = localCommands.some((cmd) => commandsMatch(cmd, step));
    if (!covered) unmapped.push(step);
  }

  assert.deepEqual(
    unmapped,
    [],
    `ci.yml steps with no local counterpart (the stale-twin failure this test exists to catch):\n  ${unmapped.join('\n  ')}`,
  );
});

test('AC3: the exemption list is justified, not a dumping ground', () => {
  // Every exemption must be a Windows-only or environment-setup step. If someone
  // silences a REAL gap by adding a regex here, this is the test that argues back.
  assert.ok(UNMAPPED_CI_STEPS.length <= 4, 'exemptions should stay few; each needs a written reason');
  for (const re of UNMAPPED_CI_STEPS) {
    assert.ok(re instanceof RegExp, 'exemptions are regexes');
  }
});

/**
 * CI steps and local commands are the same work spelled for different runners
 * (`pnpm exec turbo` vs `pnpm run`, etc). Match on the operative core.
 *
 * TOKEN-SET EQUALITY, NOT SUBSTRING. A substring rule was tried first and a
 * mutation test killed it: replacing the local `pnpm --filter desktop gate:release`
 * with `pnpm --filter desktop nonexistent` still "matched" CI's real step,
 * because the CI step contained the local one's prefix. That is precisely the
 * drift AC3 exists to catch, so the looser rule made this whole test decorative.
 *
 * Comparing the full normalized token SET means dropping or renaming the
 * operative verb (`gate:release` -> `nonexistent`) breaks the match, while
 * tolerating the runner-spelling differences that are genuinely equivalent.
 */
function commandsMatch(localCmd, ciStep) {
  const tokens = (s) =>
    new Set(
      s
        .replace(/\s+/g, ' ')
        .replace(/^pnpm exec /, 'pnpm ')
        .replace(/^pnpm run /, 'pnpm ')
        .trim()
        .split(' ')
        .filter(Boolean),
    );
  const a = tokens(localCmd);
  const b = tokens(ciStep);
  if (a.size !== b.size) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// AC4 / AC11 — fail loud; DESELECTED is its own state
// ---------------------------------------------------------------------------

test('AC4: a failing leg fails the whole run and is named', () => {
  const statuses = legStatuses({
    selected: ['workspace', 'smoke'],
    results: { workspace: { ok: true }, smoke: { ok: false, detail: 'exit 1' } },
  });

  assert.equal(statuses.ok, false, 'one failing leg must fail the run');
  assert.deepEqual(statuses.failed, ['smoke']);
  assert.ok(renderVerdict(statuses).includes('smoke'), 'the verdict must name the failing leg');
});

test('AC4: a SELECTED leg that could not run is a FAILURE, not a silent pass', () => {
  // The concrete hazards: the Rust toolchain absent, or appIsPresent() false —
  // which silently converts 10 of 15 e2e specs from assertions into skips.
  const statuses = legStatuses({
    selected: ['rust', 'e2e'],
    results: {
      rust: { ok: false, unrunnable: true, detail: 'cargo not found' },
      e2e: { ok: false, unrunnable: true, detail: 'appIsPresent() false' },
    },
  });

  assert.equal(statuses.ok, false, 'an unrunnable selected leg must fail');
  assert.deepEqual(statuses.failed.sort(), ['e2e', 'rust']);
  const verdict = renderVerdict(statuses);
  assert.ok(/could not run|unrunnable/i.test(verdict), 'the verdict must distinguish "could not run" from a plain fail');
});

test('AC11: a DESELECTED leg is neither passed nor failed', () => {
  const statuses = legStatuses({
    selected: ['workspace'],
    results: { workspace: { ok: true } },
  });

  assert.equal(statuses.ok, true);
  assert.deepEqual(statuses.passed, ['workspace']);
  assert.deepEqual(statuses.failed, []);
  // Everything not selected is DESELECTED — and must be enumerated, not dropped.
  assert.deepEqual(
    statuses.deselected.sort(),
    LEGS.map((l) => l.name).filter((n) => n !== 'workspace').sort(),
  );
});

// ---------------------------------------------------------------------------
// AC10 — the verdict never overclaims
// ---------------------------------------------------------------------------

test('AC10: a partial run says PARTIAL and names what it did NOT verify', () => {
  const statuses = legStatuses({
    selected: ['workspace', 'smoke'],
    results: { workspace: { ok: true }, smoke: { ok: true } },
  });
  const verdict = renderVerdict(statuses);

  assert.match(verdict, /PARTIAL PASS/, 'a partial run may not print an unqualified PASS');
  assert.match(verdict, /NOT VERIFIED/, 'a partial run must name the gap');
  for (const missing of ['e2e', 'rust', 'desktop', 'release']) {
    assert.ok(verdict.includes(missing), `the verdict must list the unverified leg "${missing}"`);
  }
  // Careful: the partial verdict legitimately contains the string "NOT equivalent
  // to ci.yml" — a DENIAL of equivalence. Assert against an affirmative claim
  // only, or this test rejects the very honesty it exists to enforce.
  assert.doesNotMatch(
    verdict,
    /(?<!NOT )equivalent to ci\.yml/i,
    'only --all may CLAIM CI equivalence (a "NOT equivalent" disclaimer is required, not forbidden)',
  );
  assert.match(verdict, /NOT equivalent to ci\.yml/i, 'a partial run must explicitly deny CI equivalence');
});

test('AC10: only an all-legs run may claim ci.yml equivalence', () => {
  const results = Object.fromEntries(LEGS.map((l) => [l.name, { ok: true }]));
  const statuses = legStatuses({ selected: LEGS.map((l) => l.name), results });
  const verdict = renderVerdict(statuses);

  assert.match(verdict, /FULL PASS/);
  assert.match(verdict, /equivalent to ci\.yml/i);
  // Honesty about the one leg that has NO local counterpart, by construction.
  assert.match(verdict, /Windows/i, 'a full pass must still disclose the missing Windows leg');
  assert.doesNotMatch(verdict, /NOT VERIFIED/);
});

test('AC10: a failing run never prints PASS in any form', () => {
  const statuses = legStatuses({
    selected: ['workspace'],
    results: { workspace: { ok: false, detail: 'boom' } },
  });
  const verdict = renderVerdict(statuses);
  assert.match(verdict, /FAIL/);
  assert.doesNotMatch(verdict, /\bPASS\b/, 'no PASS substring may appear in a failing verdict');
});

// ---------------------------------------------------------------------------
// Selection parsing — a typo must never become a silent no-op
// ---------------------------------------------------------------------------

test('selection: defaults are workspace + smoke', () => {
  assert.deepEqual(parseLegSelection([]).selected, DEFAULT_LEGS);
  assert.deepEqual(DEFAULT_LEGS, ['workspace', 'smoke']);
});

test('selection: --all selects every leg', () => {
  assert.deepEqual(parseLegSelection(['--all']).selected, LEGS.map((l) => l.name));
});

test('selection: --legs and --only are explicit', () => {
  assert.deepEqual(parseLegSelection(['--legs=workspace,e2e']).selected, ['workspace', 'e2e']);
  assert.deepEqual(parseLegSelection(['--only=e2e']).selected, ['e2e']);
});

test('selection: an unknown leg name is an ERROR, never a silent no-op', () => {
  // `--legs=e2ee` must not report a pass having run nothing at all.
  assert.throws(() => parseLegSelection(['--legs=e2ee']), /unknown leg/i);
  assert.throws(() => parseLegSelection(['--only=nope']), /unknown leg/i);
  assert.throws(() => parseLegSelection(['--legs=']), /unknown leg|empty/i);
});

test('every declared leg has commands and a description', () => {
  for (const leg of LEGS) {
    assert.ok(leg.name, 'leg needs a name');
    assert.ok(Array.isArray(leg.commands) && leg.commands.length > 0, `${leg.name} needs commands`);
    assert.ok(leg.description, `${leg.name} needs a description (it is shown in the close-session prompt)`);
  }
});
