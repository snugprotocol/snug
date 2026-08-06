#!/usr/bin/env node
// update-code-map-counts.mjs — regenerate the test-count numbers in docs/code-map.md's
// Tests column from a real `pnpm test` run (TASK-20260805-doctrines-devex, roadmap A15).
//
// The counts drift every task and were re-baselined by hand. This script rewrites ONLY
// the numbers it can resolve from a measured run and leaves everything else
// byte-identical — in particular Playwright counts (a different runner this script does
// not invoke) and prose rows without numbers.
//
// Dependency-free on purpose: node:child_process + node:fs + regexes. Run via
// `pnpm run update-code-map` (which also runs this script's own node:test suite first).
//
// What it rewrites inside a Tests cell, using the row's Location column to resolve the
// package (and the sub-tree within it):
//   `<file>.test.<ext>` (N)   → that file's measured count (basename lookup)
//   vitest (N total)          → the package's measured total (keeps the word "total")
//   vitest (N)                → the measured sum for the Location's sub-tree
//   suite (N)                 → the package's measured total (node:test TAP packages)
// A number that cannot be resolved (unknown package, empty sub-tree, ambiguous file
// basename) is left untouched — the script never writes a guessed or zero count.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------ parse the run log

/**
 * Parse combined turbo output (`pnpm test` at root) into per-package measurements.
 * Turbo prefixes every line with `<packageName>:test: `. Recognized inside a package's
 * stream: vitest per-file lines (`✓ path (N tests…)`), the vitest summary
 * (`Tests … (N)`), and node:test TAP totals (`# tests N`).
 *
 * @returns Map<packageName, { total: number|undefined, files: Map<relPath, count> }>
 */
export function parseTestLog(log) {
  const packages = new Map();
  const entry = (name) => {
    if (!packages.has(name)) packages.set(name, { total: undefined, files: new Map() });
    return packages.get(name);
  };
  for (const rawLine of log.split('\n')) {
    const line = rawLine.replace(/\[[0-9;]*m/g, ''); // strip ANSI, defensively
    const prefixed = /^([^\s:]+):test:\s?(.*)$/.exec(line);
    if (prefixed === null) continue;
    const [, pkg, rest] = prefixed;
    const fileLine = /^\s*[✓×❯]\s+(\S+\.test\.\S+)\s+\((\d+) tests?/.exec(rest);
    if (fileLine !== null) {
      entry(pkg).files.set(fileLine[1], Number(fileLine[2]));
      continue;
    }
    const vitestTotal = /^\s*Tests\s+.*\((\d+)\)\s*$/.exec(rest);
    if (vitestTotal !== null) {
      entry(pkg).total = Number(vitestTotal[1]);
      continue;
    }
    const tapTotal = /^\s*# tests (\d+)\s*$/.exec(rest);
    if (tapTotal !== null) {
      entry(pkg).total = Number(tapTotal[1]);
    }
  }
  return packages;
}

// ------------------------------------------------------------------ rewrite the table

/** Location cell → { dir: 'packages/db', sub: 'src/sync' } | undefined. */
export function locationPackage(cell) {
  const m = /(packages|apps)\/([A-Za-z0-9._-]+)((?:\/[A-Za-z0-9._-]+)*)/.exec(cell);
  if (m !== null) {
    return { dir: `${m[1]}/${m[2]}`, sub: m[3].replace(/^\//, '') };
  }
  const ex = /\bexamples\b/.exec(cell);
  if (ex !== null) return { dir: 'examples', sub: '' };
  return undefined;
}

const sumSubtree = (measured, sub) => {
  let sum = 0;
  let any = false;
  for (const [path, count] of measured.files) {
    if (sub === '' || path === sub || path.startsWith(`${sub}/`)) {
      sum += count;
      any = true;
    }
  }
  return any ? sum : undefined;
};

const fileCount = (measured, basename) => {
  const matches = [...measured.files.entries()].filter(([path]) => path.split('/').at(-1) === basename);
  return matches.length === 1 ? matches[0][1] : undefined; // ambiguous or absent → unresolved
};

/**
 * Rewrite the Tests column of the code-map markdown table.
 *
 * @param markdown  docs/code-map.md content
 * @param measurements  Map from parseTestLog
 * @param dirToName  Map<'packages/db', '@snugprotocol/db'> (workspace dir → package name)
 * @returns { content, changes: [{row, from, to}] }
 */
export function rewriteCodeMap(markdown, measurements, dirToName) {
  const changes = [];
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    const cells = line.split('|');
    if (cells.length < 4) continue; // need Area | Location | Tests
    const location = cells[2];
    const testsCell = cells[3];
    const where = locationPackage(location);
    if (where === undefined) continue;
    const pkgName = dirToName.get(where.dir);
    const measured = pkgName === undefined ? undefined : measurements.get(pkgName);
    if (measured === undefined) continue;

    const replaceNumber = (cell, regex, resolve) =>
      cell.replace(regex, (whole, num) => {
        const next = resolve();
        if (next === undefined || next === 0) return whole; // unresolved: never guess, never zero
        return whole.replace(`(${num}`, `(${next}`);
      });

    let next = testsCell;
    // 1. Per-file counts: `materializer.test.ts` (17)
    next = next.replace(/`([A-Za-z0-9._-]+\.test\.[a-z]+)` \((\d+)\)/g, (whole, base, num) => {
      const count = fileCount(measured, base);
      if (count === undefined) return whole;
      return whole.replace(`(${num})`, `(${count})`);
    });
    // 2. Package totals with the explicit marker: vitest (163 total)
    next = replaceNumber(next, /vitest \((\d+) total\)/, () => measured.total);
    // 3. Sub-tree counts: vitest (44) with Location packages/db/src/sync
    next = replaceNumber(next, /vitest \((\d+)\)/, () =>
      where.sub === '' || where.sub === 'src' ? measured.total : sumSubtree(measured, where.sub),
    );
    // 4. node:test packages: validate suite (18)
    next = replaceNumber(next, /suite \((\d+)\)/, () => measured.total);

    if (next !== testsCell) {
      cells[3] = next;
      lines[i] = cells.join('|');
      changes.push({ row: cells[1].trim().slice(0, 60), from: testsCell.trim(), to: next.trim() });
    }
  }
  return { content: lines.join('\n'), changes };
}

// ------------------------------------------------------------------------------ main

const repoRoot = () => join(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace dir → package name, read from the checked-in package.json files. */
export function workspaceDirToName(root) {
  const map = new Map();
  for (const parent of ['packages', 'apps']) {
    const parentDir = join(root, parent);
    if (!existsSync(parentDir)) continue;
    for (const dir of readdirSync(parentDir)) {
      const manifest = join(parentDir, dir, 'package.json');
      if (!existsSync(manifest)) continue;
      map.set(`${parent}/${dir}`, JSON.parse(readFileSync(manifest, 'utf8')).name);
    }
  }
  const examplesManifest = join(root, 'examples', 'package.json');
  if (existsSync(examplesManifest)) {
    map.set('examples', JSON.parse(readFileSync(examplesManifest, 'utf8')).name);
  }
  return map;
}

function main() {
  const root = repoRoot();
  const fromFlag = process.argv.indexOf('--from');
  let log;
  if (fromFlag !== -1 && process.argv[fromFlag + 1] !== undefined) {
    log = readFileSync(process.argv[fromFlag + 1], 'utf8');
  } else {
    console.log('Running `pnpm test` at the repo root (turbo may replay cached logs)…');
    const run = spawnSync('pnpm', ['test'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) {
      console.error(run.stdout ?? '');
      console.error(run.stderr ?? '');
      console.error('\nTest run FAILED — refusing to update counts from a red run.');
      process.exit(1);
    }
    log = `${run.stdout}\n${run.stderr}`;
  }

  const measurements = parseTestLog(log);
  if (measurements.size === 0) {
    console.error('No per-package test output recognized in the run log — nothing rewritten.');
    process.exit(1);
  }
  const mapPath = join(root, 'docs', 'code-map.md');
  const before = readFileSync(mapPath, 'utf8');
  const { content, changes } = rewriteCodeMap(before, measurements, workspaceDirToName(root));
  if (changes.length === 0) {
    console.log('docs/code-map.md test counts already match the measured run — no changes.');
    return;
  }
  writeFileSync(mapPath, content);
  console.log(`Updated ${changes.length} row(s) in docs/code-map.md:`);
  for (const change of changes) {
    console.log(`  - ${change.row}\n      ${change.from}\n    → ${change.to}`);
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
