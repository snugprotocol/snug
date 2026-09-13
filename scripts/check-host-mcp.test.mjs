// Tests for the local-host-process gate.
//
// Every rule gets a MUTANT: a gate that cannot be shown to fail is a gate vouching for
// nothing. `node --test`, named `*.test.mjs` to match the other root scripts (the
// `*.node-test.mjs` convention exists for packages where vitest would also collect them;
// scripts/ is vitest-run).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildPlugin } from './build-plugin.mjs';
import { FAKE_SKILL, fixtures } from './build-plugin.test.mjs';
import { ALLOWED_ENV_READS, ALLOWED_WHOLE_ENV_READS, checkBundle, checkInstructions, checkPluginTree, FORBIDDEN_IN_RELEASE, runValidators } from './check-host-mcp.mjs';

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

  it('catches a lowercase or mixed-case name — the sweep is not uppercase-only', () => {
    assert.ok(checkBundle(`${CLEAN} process.env.snugDebug;`).some((p) => p.includes('snugDebug')));
  });

  it('catches the bracket spelling too', () => {
    const problems = checkBundle(`${CLEAN} process.env['SOME_DEBUG_FLAG'];`);
    assert.ok(problems.some((p) => p.includes('SOME_DEBUG_FLAG')));
  });

  it('admits every declared read', () => {
    const reads = ALLOWED_ENV_READS.map((name) => `process.env.${name}`).join(';');
    assert.deepEqual(checkBundle(`${CLEAN} ${reads}`), []);
  });

  it('catches an env read the name-sweep cannot see — a bare `process.env` handed to a function', () => {
    // THE GAP THIS CLOSES. The real bundle contains no `process.env.X` literal at all: both
    // release readers pass the WHOLE env object into a function (`resolveHome`,
    // `childEnvFor`). So the name sweep was passing vacuously, and a new reader spelled the
    // same way would have shipped unexamined. Whole-object reads must be counted and capped.
    const reads = Array.from({ length: ALLOWED_WHOLE_ENV_READS + 1 }, () => '{...process.env}').join(';');
    const problems = checkBundle(`${CLEAN} ${reads};`);
    assert.ok(
      problems.some((p) => /whole environment|process\.env/i.test(p)),
      `expected an unreviewed whole-env read to be caught, got ${JSON.stringify(problems)}`,
    );
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
  /** A real build over fake inputs, then a mutation — the gate must see it. */
  const built = async () => {
    const { dir, out, sources } = fixtures();
    assert.deepEqual(await buildPlugin(out, sources, { skill: FAKE_SKILL, commit: 'abc123' }), []);
    return { dir, out };
  };
  const check = (out) => checkPluginTree(out, { skill: FAKE_SKILL });

  it('passes a tree the builder wrote', async () => {
    const { dir, out } = await built();
    try {
      assert.deepEqual(await check(out), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a hand-edited manifest', async () => {
    // The mutant: the "one contract, two artifacts" defect this module exists to prevent.
    const { dir, out } = await built();
    const file = path.join(out, 'snug/.claude-plugin/plugin.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), version: '9.9.9' }));
    try {
      assert.ok((await check(out)).some((p) => p.includes('plugin.json') && p.includes('plugin-manifests')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a server command pointed somewhere else', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/.mcp.json'), JSON.stringify({ mcpServers: { snug: { command: 'node', args: ['/tmp/whatever.mjs'] } } }));
    try {
      assert.ok((await check(out)).some((p) => p.includes('.mcp.json')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a missing launcher — the manifest runs it, so a tree without it starts nothing (AC3)', async () => {
    const { dir, out } = await built();
    rmSync(path.join(out, 'snug/scripts/snug'));
    try {
      assert.ok((await check(out)).some((p) => p.includes('launcher')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a missing runner page', async () => {
    const { dir, out } = await built();
    rmSync(path.join(out, 'snug/scripts/snug-host-local.html'));
    try {
      assert.ok((await check(out)).some((p) => p.includes('runner page')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a SKILL.md edited in the tree rather than in its source (AC1)', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/skills/snug/SKILL.md'), '---\nname: snug\n---\n# edited by hand');
    try {
      assert.ok((await check(out)).some((p) => p.includes('SKILL.md') && p.includes('fresh render')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a plugin that grew a hooks/ directory (ADR-0069: no hooks)', async () => {
    const { dir, out } = await built();
    mkdirSync(path.join(out, 'snug/hooks'), { recursive: true });
    writeFileSync(path.join(out, 'snug/hooks/hooks.json'), '{}');
    try {
      assert.ok((await check(out)).some((p) => p.includes('hooks')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a manifest that is not JSON, by name', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/.mcp.json'), '{nope');
    try {
      assert.ok((await check(out)).some((p) => p.includes('.mcp.json') && p.includes('not JSON')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a file changed after the provenance was written', async () => {
    const { dir, out } = await built();
    writeFileSync(path.join(out, 'snug/scripts/snug-mcp.mjs'), '// replaced');
    try {
      assert.ok((await check(out)).some((p) => p.includes('PROVENANCE') && p.includes('snug-mcp.mjs')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the external validators', () => {
  it('reports an absent validator as NOT VERIFIED, never as a pass', () => {
    const exec = () => {
      const error = new Error('spawn claude ENOENT');
      error.code = 'ENOENT';
      throw error;
    };
    const results = runValidators('/nowhere', exec);
    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.status === 'not verified'));
  });

  it('reports a refusal as failed, with the validator’s own words', () => {
    const exec = () => {
      const error = new Error('exit 1');
      error.status = 1;
      error.stdout = '';
      error.stderr = 'x Validation failed: description too long';
      throw error;
    };
    const results = runValidators('/nowhere', exec);
    assert.ok(results.every((r) => r.status === 'failed' && r.detail.includes('description too long')));
  });

  it('reports a pass as ok', () => {
    const results = runValidators('/nowhere', () => '✔ Validation passed\n');
    assert.ok(results.every((r) => r.status === 'ok'));
  });
});
