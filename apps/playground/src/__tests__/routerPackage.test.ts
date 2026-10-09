// One router, one major (TASK-20261008-p0-clearance W2). react-router 7 ships the whole
// declarative API from `react-router`; `react-router-dom` 6 carries two advisories with no
// 6.x fix (GHSA-337j, GHSA-wrjc — ADR-0056's acceptance expired 2026-11-30). The host kit and
// the desktop compile THIS package's source through the `@playground` alias, so all three apps
// must resolve the same router: a second copy surfaces only in the kit or the desktop, as
// "useLocation() may be used only in the context of a <Router>". This file lives in the
// playground suite because CI's workspace leg runs it (root `pnpm test` alone is not a merge
// gate).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf8');
const ROUTER_APPS = ['apps/playground', 'apps/host', 'apps/desktop'] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|mts|js|jsx|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

describe('the router package (react-router 7, one copy)', () => {
  it('no source under apps/ or packages/ imports react-router-dom', () => {
    const files = [...sourceFiles(join(REPO, 'apps')), ...sourceFiles(join(REPO, 'packages'))];
    expect(files.length, 'the walk must see the source tree').toBeGreaterThan(500);
    const self = fileURLToPath(import.meta.url);
    const hits = files
      .filter((file) => file !== self)
      .filter((file) => /from\s+['"]react-router-dom['"]|import\(\s*['"]react-router-dom['"]\s*\)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO, file));
    expect(hits).toEqual([]);
  });

  it.each(ROUTER_APPS)('%s declares react-router ^7 and not react-router-dom', (app) => {
    const pkg = JSON.parse(read(app, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(deps['react-router-dom']).toBeUndefined();
    // ^7 exactly: `latest` is 8.x, which needs React 19 — a separate decision.
    expect(deps['react-router']).toMatch(/^\^7\.\d+\.\d+$/);
  });

  it('the three apps declare the SAME react-router range (one copy through the @playground alias)', () => {
    const ranges = ROUTER_APPS.map((app) => (JSON.parse(read(app, 'package.json')) as { dependencies: Record<string, string> }).dependencies['react-router']);
    expect(new Set(ranges).size).toBe(1);
  });

  it('the lockfile resolves no react-router 6, no react-router-dom and no @remix-run/router', () => {
    const lock = read('pnpm-lock.yaml');
    expect(lock).not.toMatch(/react-router-dom/);
    expect(lock).not.toMatch(/@remix-run\/router/);
    expect(lock).not.toMatch(/react-router@6\./);
    expect(lock).toMatch(/react-router@7\./);
  });
});
