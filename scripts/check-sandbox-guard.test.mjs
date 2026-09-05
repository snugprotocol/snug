// WORKSPACE-WIDE SANDBOX GUARD (C2) — TASK-20260820-threat-model-v1, audit finding U1.
//
// `packages/runner/src/__tests__/source-guard.test.ts` already asserts that no shipped
// source carries `allow-same-origin` and that every sandbox attribute is the exact
// literal `allow-scripts`. It is a good guard aimed at the right property — but it roots
// its scan at `packages/runner/src`, so it cannot see `apps/playground`, `apps/desktop`,
// `apps/server`, `packages/sdk`, or anywhere else a NEW iframe is most likely to be added.
//
// That gap matters because of what we say in public. The whitepaper tells implementers
// "the reference implementation asserts the sandbox profile in its test suite: a frame
// carrying `allow-same-origin` fails the build" — a claim about the BUILD, not about one
// package. This test makes the claim true rather than softening the sentence, which is
// the disposition the threat-model task chose for every gap of this shape: fix the code
// so the public claim holds, or state the limit as a residual. Here the fix was cheap.
//
// Dependency-free (node: builtins), matching the other scripts/ checkers. Run via
// `pnpm run check-sandbox-guard`, and in CI beside the threat-model check.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Roots that ship or serve code. `examples/` is app HTML that RUNS INSIDE the sandbox. */
const ROOTS = ['packages', 'apps'];

/**
 * Skipped: build output, deps, and test files. Tests are excluded deliberately and it is
 * worth saying why — a negative test PROVING `allow-same-origin` is refused has to write
 * the string, and a guard that failed on its own counter-evidence would push authors to
 * stop writing that evidence.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '.turbo', '__tests__', 'e2e', 'coverage']);
/**
 * Derived output at an EXACT repo-relative path, never a basename: the host kit's starters
 * package (built from examples/, which the sweep never scanned — it is app HTML that runs
 * INSIDE the sandbox). A basename skip would also hide any future `starters-pkg/` of shipped
 * sources anywhere under the roots.
 */
const SKIP_PATHS = new Set(['apps/host/starters-pkg']);
const SOURCE_RE = /\.(ts|tsx|js|jsx|html)$/;

function shippedSources() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_PATHS.has(relative(REPO, path))) walk(path);
        continue;
      }
      if (name.includes('.test.') || name.includes('.spec.')) continue;
      if (SOURCE_RE.test(name)) out.push({ path: relative(REPO, path), text: readFileSync(path, 'utf8') });
    }
  };
  for (const root of ROOTS) walk(join(REPO, root));
  return out;
}

const sources = shippedSources();

test('the scan reaches every shipped root — a guard that collects nothing proves nothing', () => {
  // Non-vacuity, and specific: the sweep must reach the app directories the package-local
  // guard cannot see, or this file would pass while checking almost nothing.
  assert.ok(sources.length > 100, `only ${sources.length} sources collected`);
  // apps/host/src is the positive control added with the host kit (TASK-20260905-host-kit
  // AC12): the page whose whole job is to embed the sandboxed runner inside foreign hosts.
  for (const dir of ['packages/runner/src', 'apps/playground/src', 'apps/desktop/src', 'apps/host/src']) {
    assert.ok(
      sources.some((s) => s.path.startsWith(dir)),
      `the sweep never reached ${dir}`,
    );
  }
  // The frame component itself must be in scope, or the guard misses its own subject.
  assert.ok(sources.some((s) => s.path.endsWith('SnugAppFrame.tsx')));
});

test("'allow-same-origin' appears in NO shipped source, anywhere in the workspace", () => {
  const offenders = sources.filter((s) => s.text.includes('allow-same-origin')).map((s) => s.path);
  assert.deepEqual(offenders, [], `allow-same-origin found in: ${offenders.join(', ')}`);
});

test('every sandbox attribute in the workspace is the exact literal "allow-scripts"', () => {
  const offenders = [];
  for (const { path, text } of sources) {
    for (const match of text.matchAll(/sandbox\s*=\s*(.{0,24})/g)) {
      const value = match[1];
      // Accept both JSX/HTML double quotes and the single quotes a .html file may use.
      if (!value.startsWith('"allow-scripts"') && !value.startsWith("'allow-scripts'")) {
        offenders.push(`${path}: ${match[0].trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `non-literal or widened sandbox: ${offenders.join(' | ')}`);
});

test('no sandbox value is COMPUTED anywhere in the workspace', () => {
  // The property is that the VALUE is a literal, not that a particular API is banned.
  // `setAttribute('sandbox', 'allow-scripts')` is how the desktop C2 gate builds the
  // probe frames it then attacks — forbidding the call outright would fail the checks
  // that exist to prove this very invariant, so the guard reads the argument instead.
  const offenders = [];
  for (const { path, text } of sources) {
    // JSX: `sandbox={…}` is an expression, and the runner's own guard already bans it.
    if (text.includes('sandbox={')) offenders.push(`${path}: sandbox={…}`);
    for (const match of text.matchAll(/setAttribute\(\s*['"]sandbox['"]\s*,\s*([^)]*)\)/g)) {
      const arg = match[1].trim();
      if (arg !== "'allow-scripts'" && arg !== '"allow-scripts"') {
        offenders.push(`${path}: setAttribute('sandbox', ${arg})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `computed sandbox value: ${offenders.join(' | ')}`);
});
