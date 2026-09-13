// The plugin assembly: a missing input must be CANNOT RUN by name, never a smaller plugin.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildPlugin } from './build-plugin.mjs';

const fixtures = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'snugsrc-'));
  mkdirSync(path.join(dir, 'in'), { recursive: true });
  const bundle = path.join(dir, 'in/snug-mcp.mjs');
  const page = path.join(dir, 'in/snug-host-local.html');
  writeFileSync(bundle, '// bundle');
  writeFileSync(page, '<!doctype html><title>Snug</title>');
  return { dir, out: path.join(dir, 'out'), sources: { bundle, page } };
};

describe('buildPlugin', () => {
  it('writes the whole installable tree', () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(buildPlugin(out, sources), []);
      for (const rel of [
        '.claude-plugin/marketplace.json',
        'snug/.claude-plugin/plugin.json',
        'snug/.mcp.json',
        'snug/.codex-plugin/plugin.json',
        'snug/scripts/snug-mcp.mjs',
        'snug/scripts/snug-host-local.html',
      ]) {
        assert.ok(existsSync(path.join(out, rel)), `missing ${rel}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES by name when the bundle has not been built', () => {
    const { dir, out, sources } = fixtures();
    rmSync(sources.bundle);
    try {
      const problems = buildPlugin(out, sources);
      assert.ok(problems.some((p) => p.includes('bundle')), JSON.stringify(problems));
      // and writes nothing: a partial plugin is worse than none
      assert.ok(!existsSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES by name when the runner page has not been built', () => {
    const { dir, out, sources } = fixtures();
    rmSync(sources.page);
    try {
      assert.ok(buildPlugin(out, sources).some((p) => p.includes('page')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tells the reader that a rebuild does not reach an installed plugin', () => {
    // Measured: the install is a version-keyed copy, and neither `install` nor `update`
    // refreshes it — so the README must say so or the next walk tests a stale bundle.
    const { dir, out, sources } = fixtures();
    try {
      buildPlugin(out, sources);
      const readme = readFileSync(path.join(out, 'snug/README.md'), 'utf8');
      assert.match(readme, /Uninstall/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
