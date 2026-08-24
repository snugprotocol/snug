// audit-deps.mjs — the dependency-advisory gate (ADR-0056).
//
// Runs `pnpm audit --json` over the workspace and reds on any advisory at or above the
// gate threshold (high/critical) that is not recorded in scripts/audit-allowlist.json.
//
// What a green DOES prove: every high/critical advisory pnpm can see is either fixed or
// carries a written, time-boxed acceptance naming its task.
// What it does NOT prove: that the accepted ones are harmless — the allowlist entries
// carry the evidence, and their `reviewBy` dates force a re-read. It also does not see
// Cargo advisories (the Rust side has its own dismissals recorded in the allowlist for
// documentation only, with a `tool: "cargo"` marker so this gate ignores them).
//
// Why this is NOT part of root `pnpm test`: the root gate must stay offline-runnable
// (owner call, ADR-0056 §4). This is a pre-flip runbook check and a local command.
//
// Usage:
//   pnpm run audit:deps              # audit the workspace, gate on high+
//   node scripts/audit-deps.mjs --report <file.json>   # classify a saved report
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';

/** Severities that fail the gate. Moderate and low are reported, never gating. */
export const GATE_SEVERITIES = new Set(['high', 'critical']);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse the allowlist document. Throws rather than defaulting to empty: a malformed
 * allowlist that silently read as "nothing accepted" would red the gate confusingly,
 * and one that silently read as "everything accepted" would be worse.
 */
export function parseAllowlist(raw) {
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.entries)) {
    throw new Error('audit-allowlist.json: `entries` must be an array');
  }
  return doc.entries;
}

/** Validate one acceptance. Returns a list of reasons it is malformed (empty = fine). */
function allowlistEntryProblems(entry) {
  const problems = [];
  const id = entry.ghsa ?? '(no ghsa)';
  if (typeof entry.ghsa !== 'string' || !entry.ghsa.startsWith('GHSA-')) {
    problems.push(`allowlist entry ${id}: \`ghsa\` must be a GHSA- identifier`);
  }
  if (typeof entry.package !== 'string' || entry.package === '') {
    problems.push(`allowlist entry ${id}: \`package\` is required`);
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
    problems.push(`allowlist entry ${id}: \`reason\` is required — an acceptance states its evidence`);
  }
  if (typeof entry.task !== 'string' || entry.task.trim() === '') {
    problems.push(`allowlist entry ${id}: \`task\` is required — every acceptance names the task that decided it`);
  }
  if (typeof entry.reviewBy !== 'string' || !ISO_DATE.test(entry.reviewBy)) {
    problems.push(`allowlist entry ${id}: \`reviewBy\` must be a YYYY-MM-DD date`);
  }
  return problems;
}

/**
 * Classify a `pnpm audit --json` report against the allowlist.
 *
 * @param report parsed pnpm audit JSON ({ advisories: {id: advisory}, metadata })
 * @param allowlistEntries entries from parseAllowlist
 * @param today ISO YYYY-MM-DD — injected so the expiry rule is testable
 * @returns {{failures: string[], accepted: object[], stale: object[], belowThreshold: object[]}}
 */
export function classifyReport(report, allowlistEntries, today) {
  const failures = [];
  const accepted = [];
  const belowThreshold = [];

  // Cargo-side acceptances are documentation only — this gate audits the npm tree.
  const npmEntries = allowlistEntries.filter((e) => e.tool !== 'cargo');
  const byGhsa = new Map();
  for (const entry of npmEntries) {
    const problems = allowlistEntryProblems(entry);
    if (problems.length > 0) {
      failures.push(...problems);
      continue;
    }
    byGhsa.set(entry.ghsa, entry);
  }

  const advisories = Object.values(report.advisories ?? {});
  const seenGhsa = new Set();

  for (const adv of advisories) {
    const ghsa = adv.github_advisory_id;
    seenGhsa.add(ghsa);
    const severity = adv.severity;
    if (!GATE_SEVERITIES.has(severity)) {
      belowThreshold.push({ ghsa, severity, package: adv.module_name, title: adv.title });
      continue;
    }
    const entry = byGhsa.get(ghsa);
    if (!entry) {
      failures.push(
        `${severity.toUpperCase()} ${ghsa} in ${adv.module_name} (${adv.vulnerable_versions}) — ${adv.title}`,
      );
      continue;
    }
    if (entry.reviewBy < today) {
      failures.push(
        `${ghsa} in ${adv.module_name}: acceptance lapsed — reviewBy ${entry.reviewBy} has passed (${entry.task})`,
      );
      continue;
    }
    accepted.push({ ...entry, severity, title: adv.title });
  }

  // An acceptance whose advisory no longer appears is good news, not a failure — but
  // it is reported so the allowlist can be pruned (ADR-0027: distill, don't accumulate).
  const stale = npmEntries.filter(
    (e) => typeof e.ghsa === 'string' && !seenGhsa.has(e.ghsa),
  );

  return { failures, accepted, stale, belowThreshold };
}

/** Render the human-facing report. Named failures + the remedy, one per line. */
export function summarize({ failures, accepted, stale, belowThreshold }) {
  const lines = [];
  if (failures.length > 0) {
    lines.push(`audit-deps: ${failures.length} blocking advisory finding(s):`, '');
    for (const f of failures) lines.push(`  ✗ ${f}`);
    lines.push(
      '',
      'Remedy: upgrade the dependency, or record a time-boxed acceptance in',
      '  scripts/audit-allowlist.json  (ghsa, package, class, reason, task, reviewBy)',
      'per ADR-0056 — an acceptance must state its evidence and name its task.',
    );
  } else {
    lines.push('audit-deps: no un-accepted high/critical advisories.');
  }
  if (accepted.length > 0) {
    lines.push('', `Accepted (time-boxed, ${accepted.length}):`);
    for (const a of accepted) lines.push(`  • ${a.ghsa} ${a.package} — ${a.class}, review by ${a.reviewBy} (${a.task})`);
  }
  if (stale.length > 0) {
    lines.push('', `Prunable allowlist entries (advisory no longer reported, ${stale.length}):`);
    for (const s of stale) lines.push(`  • ${s.ghsa} ${s.package} — remove it`);
  }
  if (belowThreshold.length > 0) {
    lines.push('', `Below threshold (not gating, ${belowThreshold.length}): ` +
      belowThreshold.map((b) => `${b.package} ${b.severity}`).join(', '));
  }
  return lines.join('\n');
}

function readReport(argv) {
  const flagIndex = argv.indexOf('--report');
  if (flagIndex !== -1) {
    return JSON.parse(readFileSync(argv[flagIndex + 1], 'utf8'));
  }
  // `pnpm audit` exits non-zero when it finds anything — that is data, not an error.
  let stdout;
  try {
    stdout = execFileSync('pnpm', ['audit', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (typeof err.stdout !== 'string' || err.stdout.trim() === '') {
      throw new Error(`pnpm audit produced no report: ${err.message}`);
    }
    stdout = err.stdout;
  }
  return JSON.parse(stdout);
}

function main() {
  const argv = process.argv.slice(2);
  const allowlistUrl = new URL('./audit-allowlist.json', import.meta.url);
  const entries = parseAllowlist(readFileSync(allowlistUrl, 'utf8'));
  const report = readReport(argv);
  const today = new Date().toISOString().slice(0, 10);
  const result = classifyReport(report, entries, today);
  process.stdout.write(`${summarize(result)}\n`);
  if (result.failures.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
