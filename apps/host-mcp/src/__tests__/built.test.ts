// The built suites' own gate: a bundle that is missing or stale must be a NAMED FAILURE.
//
// `lifecycle-interop` and `mcp-interop` judge `dist/`. They used to `describe.skip` when the
// bundle was not there — under a comment that said "never a silent skip" — and could not
// tell a bundle built before the last edit from a fresh one, so `pnpm --filter host-mcp
// test` without a build either proved nothing or passed yesterday's bytes. A gate that
// cannot be shown to fail vouches for nothing, so this one is shown failing.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { bundleProblem } from './built.js';

let root: string;
let src: string;
let bundle: string;

/** Write a file and date it `secondsAgo` in the past. */
const dated = (file: string, secondsAgo: number): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, 'x');
  const when = new Date(Date.now() - secondsAgo * 1_000);
  utimesSync(file, when, when);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'snug-built-'));
  src = path.join(root, 'src');
  bundle = path.join(root, 'dist', 'snug-mcp.mjs');
  dated(path.join(src, 'main.ts'), 300);
  dated(path.join(src, 'mcp', 'server.ts'), 200);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('bundleProblem', () => {
  it('a bundle built after every source is fine', () => {
    dated(bundle, 100);
    expect(bundleProblem(bundle, src)).toBeUndefined();
  });

  it('a MISSING bundle cannot run — by name, with the command that builds it', () => {
    const problem = bundleProblem(bundle, src);
    expect(problem).toMatch(/^CANNOT RUN/);
    expect(problem).toMatch(/snug-mcp\.mjs is missing/);
    expect(problem).toContain('pnpm --filter host-mcp build');
  });

  it('a bundle OLDER than a source is stale — and the source is named, however deep it sits', () => {
    dated(bundle, 250); // after main.ts, before mcp/server.ts
    const problem = bundleProblem(bundle, src);
    expect(problem).toMatch(/^CANNOT RUN/);
    expect(problem).toMatch(/STALE/);
    expect(problem).toContain(path.join('mcp', 'server.ts'));
    expect(problem).toContain('pnpm --filter host-mcp build');
  });

  it('a TEST edited after the build is not a reason to rebuild — tests are not in the bundle', () => {
    dated(bundle, 100);
    dated(path.join(src, '__tests__', 'runner.test.ts'), 1);
    expect(bundleProblem(bundle, src)).toBeUndefined();
  });
});
