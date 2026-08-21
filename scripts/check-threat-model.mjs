#!/usr/bin/env node
// check-threat-model.mjs — conformance checks for docs/threat-model.md
// (TASK-20260820-threat-model-v1, acceptance criteria AC1–AC4/AC6).
//
// The threat model is a CONSOLIDATION: eight per-change deltas under docs/security/
// were merged into one document a stranger can audit. A consolidation rots in two
// directions — a new delta lands and the model never hears of it, or an enforcement
// path it cites is refactored away. This checker fails on both, treating the delta
// files and the working tree as FIXTURES the document must agree with.
//
// Dependency-free on purpose (node: builtins), matching scripts/check-whitepaper.mjs.
// Run via `pnpm run check-threat-model`, or directly:
//   node scripts/check-threat-model.mjs
//
// What each check enforces:
//   TM1  docs/threat-model.md exists and is non-trivial
//   TM2  SECURITY.md's forward reference is a live link; the "landing at" copy is gone
//   TM3  every docs/security/threat-model-delta-*.md is pinned in the delta ledger
//        with a matching content hash — a new OR edited delta fails until the model
//        re-consolidates it (stale ledger rows fail too)
//   TM4  every invariant row names an enforcement point AND a test as repo paths that
//        exist — a promise with no named enforcement may not sit in the invariants table
//   TM5  the residuals section exists and carries the named accepted residuals
//   TM6  the macOS-only shipped surface is stated
//
// Exit code 0 = all green; 1 = at least one failure (details on stderr).

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TM = join(REPO, 'docs', 'threat-model.md');
const SECURITY = join(REPO, 'SECURITY.md');
const DELTA_DIR = join(REPO, 'docs', 'security');

export const LEDGER_BEGIN = '<!-- DELTA-LEDGER:BEGIN -->';
export const LEDGER_END = '<!-- DELTA-LEDGER:END -->';

/** First 12 hex chars of SHA-256 — short enough to read in a table, long enough to pin. */
export function hashPrefix(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

/**
 * Parse the delta ledger table between the markers into Map<repo-relative path, hash>.
 * Rows look like: | `docs/security/threat-model-delta-x.md` | `abc123def456` | §4, §7 |
 * Returns null when the markers are absent (reported as its own failure, not a throw).
 */
export function parseLedger(md) {
  const begin = md.indexOf(LEDGER_BEGIN);
  const end = md.indexOf(LEDGER_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  const block = md.slice(begin + LEDGER_BEGIN.length, end);
  const rows = new Map();
  for (const m of block.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{12})`\s*\|/gm)) {
    rows.set(m[1], m[2]);
  }
  return rows;
}

/**
 * Every residual id (R-n) must be defined exactly ONCE (TASK-20260821, plan-review
 * finding 17). v1 shipped two R-14s — the encryption residual and the ceiling-scope one
 * — and downstream citations then disagreed about which was meant, silently, because
 * nothing checked. The hash-pin mechanism cannot see this class: a delta can be
 * perfectly unmoved while the document it feeds numbers two residuals the same.
 *
 * A DEFINITION is a bolded or list-item heading (`**R-n —` / `- **R-n —`); a mention in
 * prose or in the ledger's "consolidated into" column is a REFERENCE and must not count,
 * or every cross-reference would read as a redefinition.
 *
 * Pure: takes the markdown, returns failure strings.
 */
export function checkResidualIdsUnique(md) {
  const seen = new Map();
  for (const m of md.matchAll(/^(?:- )?\*\*(R-\d+)\s*—/gm)) {
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  const failures = [];
  for (const [id, count] of seen) {
    if (count > 1) {
      failures.push(`residual id ${id} is DEFINED ${count} times — ids must be unique; renumber the newer one`);
    }
  }
  return failures;
}

/** Number words the §1 prose may spell the delta count with, plus their values. */
const NUMBER_WORDS = new Map([
  ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9],
  ['ten', 10], ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14],
  ['fifteen', 15], ['sixteen', 16], ['seventeen', 17], ['eighteen', 18],
  ['nineteen', 19], ['twenty', 20],
]);

/**
 * The §1 prose states how many deltas this document consolidates. That sentence is a
 * CLAIM about the ledger below it, and it can drift — v2 shipped "eight" against a
 * twelve-row ledger, green the whole time, because the only count assertion here was a
 * `>= 8` floor that never read the prose. Compare the two directly.
 *
 * A MISSING sentence is a failure rather than a skip: a check that quietly passes when it
 * finds nothing to check is the shape this whole file exists to avoid.
 */
export function checkProseDeltaCount(md) {
  const m = md.match(/consolidates\s+([a-z]+|\d+)\s+per-change threat-model deltas/i);
  if (m === null) {
    return ['no delta-count sentence found in the prose — §1 must state how many deltas this document consolidates'];
  }
  const raw = m[1].toLowerCase();
  const stated = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS.get(raw);
  if (stated === undefined) return [`the delta-count sentence says "${m[1]}", which is not a number this check understands`];
  const ledger = parseLedger(md);
  const actual = ledger === null ? 0 : ledger.size;
  if (stated !== actual) {
    return [`§1 prose says the document consolidates "${m[1]}" deltas, but the ledger carries ${actual} rows — the prose is a claim about the table below it`];
  }
  return [];
}

/**
 * Compare the ledger against the actual delta files. Pure: takes Map<path, hash> for
 * both sides so the tests need no filesystem. Returns a list of failure strings.
 */
export function checkDeltaLedger(ledger, actual) {
  const failures = [];
  if (ledger === null) {
    return [`no delta ledger found — the model must carry a table between ${LEDGER_BEGIN} and ${LEDGER_END}`];
  }
  for (const [path, hash] of actual) {
    const pinned = ledger.get(path);
    if (pinned === undefined) {
      failures.push(`delta not consolidated: ${path} exists but has no ledger row — a new delta must be folded into the model, not just added beside it`);
    } else if (pinned !== hash) {
      failures.push(`delta changed since consolidation: ${path} hashes to ${hash} but the ledger pins ${pinned} — re-read the delta, update the model, then the ledger`);
    }
  }
  for (const path of ledger.keys()) {
    if (!actual.has(path)) failures.push(`stale ledger row: ${path} is pinned but no such file exists`);
  }
  return failures;
}

/**
 * Extract the invariant rows from the section whose heading matches
 * /enforced invariants/i, up to the next '## ' heading. Each data row must carry at
 * least one backticked repo path in BOTH the enforcement and the test column.
 *
 * The section holds SEVERAL tables (one per constraint family), so this walks them all
 * and re-reads the column positions at each header rather than assuming one table with
 * one ordering — a reordered or newly-inserted table still resolves correctly, and the
 * header/separator rows of every table are skipped instead of being graded as invariants
 * that name no enforcement.
 */
export function parseInvariantRows(md) {
  const section = sectionOf(md, /enforced invariants/i);
  if (section === null) return null;
  const lines = section.split('\n').filter((l) => /^\s*\|/.test(l));
  const rows = [];
  let enfCol = -1;
  let testCol = -1;
  for (const line of lines) {
    const cells = line.split('|');
    const lower = cells.map((c) => c.trim().toLowerCase());
    // A header row re-arms the column map for the table that follows it.
    if (lower.some((c) => /enforce/.test(c)) && lower.some((c) => /^test$/.test(c))) {
      enfCol = lower.findIndex((c) => /enforce/.test(c));
      testCol = lower.findIndex((c) => /^test$/.test(c));
      continue;
    }
    if (cells.every((c) => c.trim() === '' || /^:?-{3,}:?$/.test(c.trim()))) continue; // separator
    if (enfCol === -1 || testCol === -1) continue; // prose table before any recognised header
    if (cells.length <= Math.max(enfCol, testCol)) continue;
    rows.push({
      label: (cells[1] ?? '').trim(),
      enforcement: backtickedPaths(cells[enfCol]),
      test: backtickedPaths(cells[testCol]),
    });
  }
  return rows;
}

/** The text of the first section whose '## ' heading matches `re`, or null. */
export function sectionOf(md, re) {
  const m = md.match(new RegExp(`^##\\s+.*(?:${re.source}).*$`, `im${re.flags.replace(/[gimy]/g, (f) => (f === 'i' ? '' : f))}`));
  if (!m) return null;
  const start = md.indexOf(m[0]) + m[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Backticked tokens that look like repo paths (a slash under a known top-level dir). */
export function backtickedPaths(cell) {
  return [...(cell ?? '').matchAll(/`([^`]+)`/g)]
    .map((m) => m[1].split(':')[0]) // allow `path/to/file.ts:123`
    .filter((p) => /^(packages|apps|scripts|examples|docs|\.github)\//.test(p));
}

/** Residual markers AC4 names explicitly — the model must state each as accepted. */
export const REQUIRED_RESIDUAL_MARKERS = [
  { label: 'Windows/WebView2 subframe IPC injection (R-5)', re: /WebView2/ },
  { label: 'BYOK browser-CORS advisory', re: /CORS/ },
  { label: 'installed-starter staleness', re: /staleness/i },
];

// ---------------------------------------------------------------- tiny check harness

const failures = [];
const passes = [];

function check(id, name, ok, detail = '') {
  if (ok) passes.push(`${id} ${name}`);
  else failures.push(`${id} ${name}${detail ? `\n      ${detail}` : ''}`);
  return ok;
}

// ---------------------------------------------------------------- run

function main() {
  // TM1 — the document exists and is a document, not a stub.
  if (!check('TM1', 'docs/threat-model.md exists', existsSync(TM), `expected ${TM}`)) {
    console.error('\n✗ threat-model checks failed: the document does not exist yet.\n');
    process.exit(1);
  }
  const tm = readFileSync(TM, 'utf8');
  check('TM1', 'document is non-trivial', statSync(TM).size > 4000, `${statSync(TM).size} bytes (expect >4000)`);

  // TM2 — SECURITY.md's promise resolves.
  const sec = readFileSync(SECURITY, 'utf8');
  check('TM2', 'SECURITY.md links to the threat model', /\]\((?:\.\/)?docs\/threat-model\.md\)/.test(sec),
    'expected a live markdown link to docs/threat-model.md');
  check('TM2', 'the "landing at" forward-reference copy is gone', !/landing at/i.test(sec),
    'SECURITY.md still promises a future document');

  // TM3 — every delta is pinned with a matching hash.
  const actual = new Map();
  for (const f of readdirSync(DELTA_DIR).filter((f) => /^threat-model-delta-.*\.md$/.test(f))) {
    const rel = `docs/security/${f}`;
    actual.set(rel, hashPrefix(readFileSync(join(DELTA_DIR, f))));
  }
  // EXACT, not a floor. `>= 8` passed at twelve and would pass at fifty — it could never
  // notice a delta going missing above the floor, and it was the assertion mistakenly
  // credited with catching the prose/ledger drift below.
  check('TM3', 'the ledger row count equals the delta files on disk', actual.size === (parseLedger(tm)?.size ?? -1),
    `docs/security/ holds ${actual.size}, the ledger carries ${parseLedger(tm)?.size ?? 'no'} rows`);
  for (const f of checkDeltaLedger(parseLedger(tm), actual)) check('TM3', 'delta ledger agrees with docs/security/', false, f);
  if (parseLedger(tm) !== null && checkDeltaLedger(parseLedger(tm), actual).length === 0) {
    check('TM3', 'delta ledger agrees with docs/security/', true);
  }

  // TM8 — the §1 prose count is a claim about the ledger; hold it to that.
  const proseFailures = checkProseDeltaCount(tm);
  for (const f of proseFailures) check('TM8', 'the §1 delta count agrees with the ledger', false, f);
  if (proseFailures.length === 0) check('TM8', 'the §1 delta count agrees with the ledger', true);

  // TM4 — invariant rows name enforcement + test paths that exist.
  const rows = parseInvariantRows(tm);
  if (check('TM4', 'enforced-invariants table present and parseable', rows !== null && rows.length > 0,
    'expected a "## Enforced invariants" section with an enforcement column and a test column')) {
    for (const row of rows) {
      check('TM4', `invariant "${row.label}" names an enforcement path`, row.enforcement.length > 0,
        'a promise with no named enforcement belongs in residuals, not here');
      check('TM4', `invariant "${row.label}" names a test path`, row.test.length > 0,
        'an invariant no test would catch regressing belongs in residuals, not here');
      for (const p of [...row.enforcement, ...row.test]) {
        check('TM4', `path exists: ${p}`, existsSync(join(REPO, p)), `cited by invariant "${row.label}" but absent from the tree`);
      }
    }
  }

  // TM5 — residuals stated, with the AC4-named ones present.
  const residuals = sectionOf(tm, /residual/i);
  if (check('TM5', 'residuals section present', residuals !== null)) {
    for (const r of REQUIRED_RESIDUAL_MARKERS) {
      check('TM5', `residual stated: ${r.label}`, r.re.test(residuals), `expected ${r.re} in the residuals section`);
    }
  }

  // TM6 — the shipped surface is honest about platform.
  check('TM6', 'macOS-only shipped surface stated', /macOS[- ]only/.test(tm),
    'ADR-0021 D8: the desktop shell ships macOS-only and the model must say so');

  // TM7 — residual ids are unique (v1 shipped two R-14s; see the function's header).
  const idFailures = checkResidualIdsUnique(tm);
  check('TM7', 'every residual id is defined exactly once', idFailures.length === 0, idFailures.join('; '));

  const total = passes.length + failures.length;
  if (failures.length) {
    console.error(`\n✗ threat-model checks: ${failures.length}/${total} FAILED\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✓ threat-model checks: ${total}/${total} passed`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
