#!/usr/bin/env node
// gate-local.mjs — the local merge gate (TASK-20260820-local-ci-gate).
//
// WHAT THIS REPLACES. GitHub Actions is dormant: billing-blocked since
// ~2026-08-18, every run failing in ~2s with zero steps executed, and the owner
// has decided not to restore it before launch. See .github/workflows/ci.yml's
// header for the full reasoning. Worth knowing: CI never actually BLOCKED a
// merge — this repo is private on a free org plan, so branch protection and
// required status checks were never available (the API answers 403). The red X
// was noise with no enforcement behind it.
//
// So this script is now the only thing between a commit and `main`, and
// /close-session merges automatically on its verdict. Two design consequences
// follow, and they are the whole character of this file:
//
//   1. IT MUST NEVER REPORT A FALSE GREEN. A leg that failed, or that was
//      selected but could not run, fails the whole run. There is no
//      "not applicable" success path. (AC4)
//
//   2. IT MUST BE HONEST ABOUT ITS OWN COVERAGE. Legs are user-selectable, so a
//      2-minute default run verifies far less than `--all`. A verdict that said
//      only "PASS" would be the same false confidence in a new costume — so a
//      partial run names what it did NOT verify, and only `--all` may claim
//      equivalence to ci.yml. (AC10)
//
// USAGE
//   node scripts/gate-local.mjs                      # defaults: workspace,smoke (~2 min)
//   node scripts/gate-local.mjs --all                # everything (~15-20 min)
//   node scripts/gate-local.mjs --legs=workspace,e2e
//   node scripts/gate-local.mjs --only=e2e
//   node scripts/gate-local.mjs --list
//
// Legs run SEQUENTIALLY and without fail-fast: the desktop gate drives a real
// WKWebView and Playwright drives real browsers, so running them concurrently
// would have them contend for the cores whose availability their timeouts
// assume. No fail-fast because a solo developer wants every problem in one
// pass, not one problem per 15-minute round trip.
//
// Dependency-free (node: builtins), matching the other scripts/ checkers.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// ---------------------------------------------------------------------------
// The legs
// ---------------------------------------------------------------------------

/**
 * Order matters: cheapest-and-most-likely-to-catch-something first, so a
 * `--all` run that is going to fail tends to fail early even without fail-fast.
 *
 * `defaultOn` mirrors the owner decision (2026-08-20): workspace + smoke are on,
 * everything else is opt-in per run. `smoke` rides with workspace because it is
 * ~10s and closes threat-model R-11's CSP-header gap — there is no ergonomic
 * argument for making it opt-in.
 */
export const LEGS = [
  {
    name: 'workspace',
    description: 'build + all package tests + threat-model + sandbox guard (~2 min)',
    defaultOn: true,
    commands: [
      'pnpm exec turbo run build --force',
      'pnpm exec turbo run test --force',
      'pnpm run check-threat-model',
      'pnpm run check-sandbox-guard',
      // The host kit's structural gate (TASK-20260905-host-kit AC1/AC11/AC12): one
      // self-contained page, reproducible. Needs the kit's dist, which `turbo run build`
      // above produces.
      'pnpm run check-host-kit',
      // The gate's own tests. Deliberately self-referential: this script is now
      // the only merge gate, so "the gate is still wired to ci.yml correctly"
      // (AC3) has to be a property the gate itself checks on every run. Note it
      // does NOT recurse — `turbo run test` above runs turbo's per-package test
      // tasks, not the ROOT `test` script, so this line is the only place these
      // tests execute during a gate run.
      'pnpm run check-gate-local',
    ],
  },
  {
    name: 'smoke',
    description: 'apps/server boot + CSP-header assertion (~10 s, closes threat-model R-11)',
    defaultOn: true,
    commands: ['pnpm --filter server build', 'pnpm --filter server smoke'],
  },
  {
    name: 'e2e',
    description: 'Playwright real-browser suite (~6 min) — EXCEEDS ci.yml, which runs no Playwright',
    defaultOn: false,
    commands: ['pnpm --filter playground test:e2e'],
    // A selected e2e leg on a tree where appIsPresent() is false would silently
    // convert 10 of 15 specs from assertions into skips. That is the exact
    // false-green shape AC4 forbids, so it is a precondition, not a warning.
    precondition: () => {
      const dir = join(REPO, 'apps', 'playground');
      const present =
        existsSync(join(dir, 'index.html')) &&
        existsSync(join(dir, 'src', 'main.tsx')) &&
        (existsSync(join(dir, 'vite.config.ts')) || existsSync(join(dir, 'vite.config.js')));
      return present ? null : 'appIsPresent() is false — 10 of 15 e2e specs would silently skip';
    },
  },
  {
    name: 'rust',
    description: 'cargo test for the Tauri shell (~1 min)',
    defaultOn: false,
    commands: ['cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml'],
    precondition: () =>
      spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0
        ? null
        : 'cargo not found on PATH — the Rust toolchain is required for this leg',
  },
  {
    name: 'desktop',
    description: 'desktop package tests + the in-shell hard gate in a real WKWebView (~5 min)',
    defaultOn: false,
    commands: ['pnpm --filter desktop test', 'pnpm --filter desktop gate'],
    env: { SNUG_GATE_REBUILD_WEB: '1' },
    precondition: () =>
      process.platform === 'darwin'
        ? null
        : `the in-shell gate needs macOS (WKWebView); this host is ${process.platform}`,
  },
  {
    name: 'release',
    description: 'release-inertness proof: gate surface absent from a release binary (~5 min)',
    defaultOn: false,
    commands: ['pnpm --filter desktop gate:release'],
    precondition: () =>
      process.platform === 'darwin' ? null : `release gate needs macOS; this host is ${process.platform}`,
  },
];

export const DEFAULT_LEGS = LEGS.filter((l) => l.defaultOn).map((l) => l.name);

/**
 * ci.yml steps with deliberately NO local counterpart. Each needs a reason, and
 * the test asserts this list stays short — it is the obvious place to silence a
 * real gap, so it argues back.
 *
 *  - `pnpm install --frozen-lockfile[ --filter desktop...]`: CI starts from a
 *    bare runner; a local tree is already installed. Running it here would be a
 *    slow no-op at best and could churn the lockfile at worst.
 *  - `turbo run build --filter=desktop --force`: CI must build the workspace
 *    deps' dist/ before tsc can see @snugprotocol/* on a clean runner. The
 *    `workspace` leg's full `turbo run build --force` already covers it locally,
 *    and is a superset.
 */
export const UNMAPPED_CI_STEPS = [
  /^pnpm install --frozen-lockfile/,
  /^pnpm exec turbo run build --filter=desktop --force$/,
];

// ---------------------------------------------------------------------------
// AC3 — the narrow ci.yml extractor
// ---------------------------------------------------------------------------

/**
 * Pull `jobs.<id>.steps[].run` out of the workflow.
 *
 * PURPOSE-BUILT RATHER THAN A YAML DEPENDENCY, deliberately. The repo has no
 * `yaml` package in its tree, and adding one to read a single file we own and
 * control is more dependency surface than the job needs. The scope is narrow and
 * fixed: two known jobs, `run:` steps only, scalar or block form.
 *
 * The corresponding risk — an extractor that quietly returns nothing would make
 * every AC3 assertion vacuously true — is handled in the test, which asserts
 * minimum step counts rather than trusting a non-empty result.
 *
 * @param {string} yamlText
 * @returns {Record<string, string[]>} job id -> list of run-step commands
 */
export function extractWorkflowRunSteps(yamlText) {
  const lines = yamlText.split('\n');
  const jobs = {};

  let inJobs = false;
  let currentJob = null;
  let pendingBlock = null; // { indent, parts } while consuming a `run: |` block

  const flush = () => {
    if (pendingBlock && currentJob) {
      const text = pendingBlock.parts.join('\n').trim();
      if (text) jobs[currentJob].push(text);
    }
    pendingBlock = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // Comments and blanks never terminate a block scalar in a way we care about,
    // but a blank line inside one is content — keep it only if we are in a block.
    if (!pendingBlock && (line.trim() === '' || line.trim().startsWith('#'))) continue;

    const indent = line.length - line.trimStart().length;

    // Consuming a block scalar: anything indented deeper than the `run:` key.
    if (pendingBlock) {
      if (line.trim() === '' || indent > pendingBlock.indent) {
        pendingBlock.parts.push(line.slice(Math.min(indent, pendingBlock.indent + 2)));
        continue;
      }
      flush();
    }

    if (indent === 0) {
      inJobs = /^jobs:/.test(line);
      currentJob = null;
      continue;
    }
    if (!inJobs) continue;

    // A job id sits at indent 2: `  workspace:`
    const jobMatch = indent === 2 ? line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/) : null;
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs[currentJob] = jobs[currentJob] ?? [];
      continue;
    }
    if (!currentJob) continue;

    const runMatch = line.match(/^\s*-?\s*run:\s*(.*)$/);
    if (runMatch) {
      const value = runMatch[1].trim();
      if (value === '|' || value === '>' || value === '|-' || value === '>-') {
        pendingBlock = { indent, parts: [] };
      } else if (value) {
        jobs[currentJob].push(stripQuotes(value));
      }
    }
  }
  flush();

  return jobs;
}

function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {{ selected: string[] }}
 * @throws on an unknown leg name — a typo must never become a silent no-op that
 *         runs nothing and reports a pass.
 */
export function parseLegSelection(argv) {
  const known = new Set(LEGS.map((l) => l.name));

  if (argv.includes('--all')) return { selected: LEGS.map((l) => l.name) };

  const flag = argv.find((a) => a.startsWith('--legs=') || a.startsWith('--only='));
  if (!flag) return { selected: [...DEFAULT_LEGS] };

  const raw = flag.slice(flag.indexOf('=') + 1);
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (names.length === 0) {
    throw new Error(`empty leg selection in "${flag}" — unknown leg (expected one of: ${[...known].join(', ')})`);
  }
  for (const n of names) {
    if (!known.has(n)) {
      throw new Error(`unknown leg "${n}" — expected one of: ${[...known].join(', ')}`);
    }
  }
  return { selected: names };
}

// ---------------------------------------------------------------------------
// AC4 / AC10 / AC11 — statuses and the verdict
// ---------------------------------------------------------------------------

/**
 * Fold per-leg results into the three-state view. The three states are distinct
 * on purpose (AC11): PASS, FAIL, DESELECTED. Collapsing DESELECTED into either
 * of the others is precisely how a gate starts lying about its coverage.
 *
 * @param {{ selected: string[], results: Record<string, {ok:boolean, unrunnable?:boolean, detail?:string}> }} input
 */
export function legStatuses({ selected, results }) {
  const all = LEGS.map((l) => l.name);
  const passed = [];
  const failed = [];
  const unrunnable = [];

  for (const name of selected) {
    const r = results[name];
    if (r?.ok) passed.push(name);
    else {
      failed.push(name);
      if (r?.unrunnable) unrunnable.push(name);
    }
  }

  const deselected = all.filter((n) => !selected.includes(n));

  return {
    ok: failed.length === 0,
    passed,
    failed,
    unrunnable,
    deselected,
    selected: [...selected],
    isAll: selected.length === all.length,
    details: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v?.detail ?? ''])),
  };
}

/**
 * The one line a human reads. Every word here is load-bearing:
 *
 *  - a failing run must contain no PASS substring at all;
 *  - a partial run says PARTIAL and enumerates what it did not verify;
 *  - only an all-legs run may claim ci.yml equivalence, and even then it
 *    discloses the Windows leg, which has no local counterpart by construction
 *    (ADR-0021 D8: WebView2 is structurally broken and macOS-only ships).
 */
export function renderVerdict(statuses) {
  const total = LEGS.length;
  const ranCount = statuses.selected.length;

  if (!statuses.ok) {
    const parts = [`GATE FAILED — ${statuses.failed.length} of ${ranCount} selected leg(s) failed: ${statuses.failed.join(', ')}.`];
    if (statuses.unrunnable.length > 0) {
      parts.push(
        `Could not run (selected but unrunnable — treated as failure, never a skip): ${statuses.unrunnable.join(', ')}.`,
      );
    }
    if (statuses.deselected.length > 0) {
      parts.push(`DESELECTED (not run, not verified): ${statuses.deselected.join(', ')}.`);
    }
    parts.push('Do NOT merge.');
    return parts.join('\n');
  }

  if (statuses.isAll) {
    return [
      `FULL PASS — ${ranCount}/${total} legs green; equivalent to ci.yml on macOS.`,
      'NOT COVERED: the ci.yml Windows leg has no local counterpart — R-5 regression detection stays unmonitored (ADR-0021 D8, accepted through 1.0).',
    ].join('\n');
  }

  return [
    `PARTIAL PASS — ${ranCount}/${total} legs green (${statuses.passed.join(', ')}).`,
    `NOT VERIFIED: ${statuses.deselected.join(', ')}.`,
    'This run is NOT equivalent to ci.yml. Merging on it accepts the gap above.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function runLeg(leg) {
  const blocked = leg.precondition?.();
  if (blocked) {
    console.log(`\n─── ${leg.name}: CANNOT RUN — ${blocked}`);
    return { ok: false, unrunnable: true, detail: blocked };
  }

  for (const cmd of leg.commands) {
    console.log(`\n─── ${leg.name} $ ${cmd}`);
    const r = spawnSync(cmd, {
      cwd: REPO,
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, ...(leg.env ?? {}) },
    });
    if (r.status !== 0) {
      const detail = `\`${cmd}\` exited ${r.status ?? `signal ${r.signal}`}`;
      console.log(`─── ${leg.name}: FAIL — ${detail}`);
      return { ok: false, detail };
    }
  }
  return { ok: true };
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--list')) {
    for (const l of LEGS) {
      console.log(`${l.defaultOn ? '[x]' : '[ ]'} ${l.name.padEnd(10)} ${l.description}`);
    }
    return 0;
  }

  let selected;
  try {
    ({ selected } = parseLegSelection(argv));
  } catch (err) {
    console.error(`gate:local — ${err.message}`);
    return 2;
  }

  console.log(`gate:local — running ${selected.length}/${LEGS.length} legs: ${selected.join(', ')}`);
  if (selected.length < LEGS.length) {
    console.log(`gate:local — DESELECTED: ${LEGS.map((l) => l.name).filter((n) => !selected.includes(n)).join(', ')}`);
  }

  const results = {};
  for (const name of selected) {
    results[name] = runLeg(LEGS.find((l) => l.name === name));
  }

  const statuses = legStatuses({ selected, results });

  console.log('\n════════════════════════════════════════════');
  for (const leg of LEGS) {
    const state = !statuses.selected.includes(leg.name)
      ? 'DESELECTED'
      : statuses.failed.includes(leg.name)
        ? statuses.unrunnable.includes(leg.name)
          ? 'CANNOT RUN'
          : 'FAIL'
        : 'PASS';
    const detail = statuses.details[leg.name] ? ` — ${statuses.details[leg.name]}` : '';
    console.log(`  ${state.padEnd(11)} ${leg.name}${detail}`);
  }
  console.log('════════════════════════════════════════════');
  console.log(renderVerdict(statuses));

  return statuses.ok ? 0 : 1;
}

// Only run when invoked directly — the test imports this module.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
