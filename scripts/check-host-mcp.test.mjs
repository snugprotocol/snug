// Tests for the local-host-process gate.
//
// Every rule gets a MUTANT: a gate that cannot be shown to fail is a gate vouching for
// nothing. `node --test`, named `*.test.mjs` to match the other root scripts (the
// `*.node-test.mjs` convention exists for packages where vitest would also collect them;
// scripts/ is vitest-run).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ALLOWED_ENV_READS, checkBundle, checkInstructions, checkPluginTree, FORBIDDEN_IN_RELEASE } from './check-host-mcp.mjs';
import { claudeMcpConfig, claudePluginManifest, marketplaceManifest } from './lib/plugin-manifests.mjs';

const CLEAN = `const home = process.env.HOME; const t = process.env.TMPDIR; export const tools = ['snug_status'];`;

describe('the release-inertness sweep', () => {
  it('passes a bundle with no hook', () => {
    assert.deepEqual(checkBundle(CLEAN), []);
  });

  for (const name of FORBIDDEN_IN_RELEASE) {
    it(`catches ${name} in the shipped bytes`, () => {
      // The mutant: the test build's env name reaching the release artifact.
      const problems = checkBundle(`${CLEAN} process.env.${name};`);
      assert.ok(problems.some((p) => p.includes(name)), `expected ${name} to be caught, got ${JSON.stringify(problems)}`);
    });
  }

  it('catches an environment variable nobody declared', () => {
    const problems = checkBundle(`${CLEAN} process.env.ANTHROPIC_API_KEY;`);
    assert.ok(problems.some((p) => p.includes('ANTHROPIC_API_KEY')));
  });

  it('catches the bracket spelling too', () => {
    const problems = checkBundle(`${CLEAN} process.env['SOME_DEBUG_FLAG'];`);
    assert.ok(problems.some((p) => p.includes('SOME_DEBUG_FLAG')));
  });

  it('admits every declared read', () => {
    const reads = ALLOWED_ENV_READS.map((name) => `process.env.${name}`).join(';');
    assert.deepEqual(checkBundle(`${CLEAN} ${reads}`), []);
  });

  it('catches a bundle that lost its tool surface', () => {
    const problems = checkBundle('const home = process.env.HOME;');
    assert.ok(problems.some((p) => p.includes('tool surface')));
  });

  it('never admits a credential-shaped name into the allowlist itself', () => {
    for (const name of ALLOWED_ENV_READS) {
      assert.ok(!/KEY|TOKEN|SECRET|ANTHROPIC|CLAUDE/i.test(name), `${name} does not belong in the env allowlist`);
    }
  });
});

describe('the instructions byte-compare (D-B12)', () => {
  const instructions = 'Call snug_status first.\nThen snug_open.\n';

  it('passes when the bundle carries the source text', () => {
    const bundled = `var i = ${JSON.stringify(instructions)};`;
    assert.deepEqual(checkInstructions(bundled, instructions), []);
  });

  it('catches a bundle built from a STALE copy', () => {
    // The mutant: someone edits instructions.md and ships yesterday's bundle.
    const bundled = `var i = ${JSON.stringify('Call snug_status first.\n')};`;
    assert.equal(checkInstructions(bundled, instructions).length, 1);
  });
});

describe('the plugin tree', () => {
  const tree = (mutate = (files) => files) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snugplug-'));
    const files = {
      'snug/.claude-plugin/plugin.json': claudePluginManifest(),
      'snug/.mcp.json': claudeMcpConfig(),
      '.claude-plugin/marketplace.json': marketplaceManifest(),
    };
    const mutated = mutate(files);
    for (const [rel, value] of Object.entries(mutated)) {
      mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), JSON.stringify(value, null, 2));
    }
    mkdirSync(path.join(dir, 'snug/scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'snug/scripts/snug-mcp.mjs'), '// bundle');
    writeFileSync(path.join(dir, 'snug/scripts/snug-host-local.html'), '<!doctype html>');
    return dir;
  };

  it('passes a tree written from the constants module', () => {
    const dir = tree();
    try {
      assert.deepEqual(checkPluginTree(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a hand-edited manifest', () => {
    // The mutant: the "one contract, two artifacts" defect this module exists to prevent.
    const dir = tree((files) => ({ ...files, 'snug/.claude-plugin/plugin.json': { ...files['snug/.claude-plugin/plugin.json'], version: '9.9.9' } }));
    try {
      assert.equal(checkPluginTree(dir).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a server command pointed somewhere else', () => {
    const dir = tree((files) => ({ ...files, 'snug/.mcp.json': { mcpServers: { snug: { command: 'node', args: ['/tmp/whatever.mjs'] } } } }));
    try {
      assert.ok(checkPluginTree(dir).some((p) => p.includes('.mcp.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a missing runner page', () => {
    const dir = tree();
    rmSync(path.join(dir, 'snug/scripts/snug-host-local.html'));
    try {
      assert.ok(checkPluginTree(dir).some((p) => p.includes('runner page')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
