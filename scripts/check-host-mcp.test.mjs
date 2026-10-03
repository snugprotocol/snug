// Tests for the local-host-process gate.
//
// Every rule gets a MUTANT: a gate that cannot be shown to fail is a gate vouching for
// nothing. `node --test`, named `*.test.mjs` to match the other root scripts (the
// `*.node-test.mjs` convention exists for packages where vitest would also collect them;
// scripts/ is vitest-run).

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildPlugin } from './build-plugin.mjs';
import { FAKE_SKILL, fixtures } from './build-plugin.test.mjs';
import {
  ALLOWED_ENV_READS,
  ALLOWED_WHOLE_ENV_READS,
  checkBundle,
  checkInstructions,
  checkPluginTree,
  FORBIDDEN_PREFIX_IN_RELEASE,
  isolationEnv,
  runLaunchLegs,
  runValidators,
} from './check-host-mcp.mjs';

const CLEAN = `const home = process.env.HOME; const t = process.env.TMPDIR; export const tools = ['snug_status'];`;

describe('the release-inertness sweep', () => {
  it('passes a bundle with no hook', () => {
    assert.deepEqual(checkBundle(CLEAN), []);
  });

  it('sweeps for the test hooks’ PREFIX, not a list of their names (K5)', () => {
    // A list is only ever as current as the last person to remember it: the test entry had
    // five hooks and the list named three. Every hook the test entry reads starts with this.
    assert.equal(FORBIDDEN_PREFIX_IN_RELEASE, 'SNUG_MCP_TEST_');
    const entry = readFileSync(new URL('../apps/host-mcp/src/main.test-hooks.ts', import.meta.url), 'utf8');
    const hooks = [...entry.matchAll(/'(SNUG_[A-Z0-9_]+)'/g)].map((match) => match[1]);
    assert.ok(hooks.length >= 5, `expected the test entry to name its hooks, found ${JSON.stringify(hooks)}`);
    for (const name of hooks) assert.ok(name.startsWith(FORBIDDEN_PREFIX_IN_RELEASE), `${name} is a test hook the prefix sweep would miss`);
  });

  for (const name of ['SNUG_MCP_TEST_RESOLVE', 'SNUG_MCP_TEST_HOLDER', 'SNUG_MCP_TEST_BRAIN', 'SNUG_MCP_TEST_BRAIN_MODEL', 'SNUG_MCP_TEST_MODELS', 'SNUG_MCP_TEST_ENTRY', 'SNUG_MCP_TEST_A_HOOK_NOBODY_HAS_WRITTEN_YET']) {
    it(`catches ${name} in the shipped bytes`, () => {
      // The mutant: the test build's env name reaching the release artifact.
      const problems = checkBundle(`${CLEAN} process.env.${name};`);
      assert.ok(problems.some((p) => p.includes(name)), `expected ${name} to be caught, got ${JSON.stringify(problems)}`);
    });
  }

  it('catches a hook that is only a STRING in the bundle — the test entry reads its names through constants', () => {
    const problems = checkBundle(`${CLEAN} const HOOK = "SNUG_MCP_TEST_GRACE_MS"; process.env[HOOK];`);
    assert.ok(problems.some((p) => p.includes('SNUG_MCP_TEST_GRACE_MS')), JSON.stringify(problems));
  });

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

describe('the launch legs — the gate STARTS what it ships (D1)', () => {
  // The plugin gate used to check the tree's FILES and never run them, which is how a
  // plugin that could not attach to its own runner shipped as "marketplace-ready". The legs
  // start the launcher the tree ships and speak to it as a host does. These tests drive the
  // legs with launchers that MISBEHAVE, because a leg that cannot be shown to fail vouches
  // for nothing — and because the first thing a leg must prove is that it is not talking
  // to the developer's real Snug.

  /**
   * NO LEG LEAVES A PROCESS BEHIND, however it ended — passed, aborted, or caught a launcher
   * misbehaving. Two tests below make that their subject; this makes it true of all of them:
   * every fake launcher reports the processes still alive when it is removed, and a test
   * that left one fails here, by pid.
   */
  const outlived = [];
  afterEach(() => {
    assert.deepEqual(outlived.splice(0), [], 'a launch leg left a process running');
  });

  /** A launcher whose process answers as `mode` says. Every start is logged, with its pid. */
  const fake = (mode) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'snug-leg-'));
    const starts = path.join(dir, 'starts.log');
    const script = path.join(dir, 'fake-runner.mjs');
    writeFileSync(
      script,
      `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const mode = ${JSON.stringify(mode)};
appendFileSync(${JSON.stringify(starts)}, process.pid + '\\n');
const home = process.env.SNUG_HOME;
const status = () => {
  if (home === undefined) {
    if (mode === 'resolves-a-home-anyway') return { running: true, pid: process.pid, home: '/Users/someone/Snug', file: '/Users/someone/Snug/user.snug' };
    return { running: false, refusal: { code: mode === 'wrong-refusal' ? 'listen-failed' : 'home-unresolved', message: 'no home', remedy: 'set one' } };
  }
  mkdirSync(home, { recursive: true });
  const record = path.join(home, 'primary.pid');
  const base = {
    running: true,
    home: mode === 'leaks-home' ? '/Users/someone/Snug' : home,
    file: mode === 'leaks-file' ? '/Users/someone/Snug/user.snug' : path.join(home, 'user.snug'),
  };
  if (existsSync(record) && mode !== 'never-attaches') return { ...base, attached: true, pid: Number(readFileSync(record, 'utf8')) };
  writeFileSync(record, String(process.pid));
  return { ...base, pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid };
};
// A process that ignores both ways of being asked: something must keep it alive once its
// input has ended, or it would simply fall off the end of its event loop.
if (mode === 'lingers') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000); }
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || mode === 'silent') return;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'snug', version: '0' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps'].map((name) => ({ name })) });
  else reply(message.id, { content: [{ type: 'text', text: JSON.stringify(status()) }] });
});
process.stdin.on('end', () => { if (mode !== 'lingers') process.exit(0); });
`,
    );
    const launcher = path.join(dir, 'snug');
    // What the real launcher ends with: `exec` — so the launcher's pid IS the process's pid.
    writeFileSync(launcher, `#!/bin/sh\nexec node ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });
    const pids = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n').map(Number) : []);
    return {
      launcher,
      pids,
      remove: () => {
        // Looked at BEFORE the log goes: these are the processes this launcher started.
        outlived.push(...pids().filter(alive));
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const quick = { requestTimeoutMs: 1_500, reapMs: 1_000 };

  it('the isolation environment is exactly three variables — never the developer’s own', () => {
    const env = isolationEnv('/tmp/x');
    assert.deepEqual(env, { HOME: '/tmp/x', SNUG_HOME: '/tmp/x/Snug', PATH: path.dirname(process.execPath) });
  });

  it('passes a launcher whose process leads, is joined by a second, and refuses with no home', async () => {
    const f = fake('honest');
    try {
      assert.deepEqual(await runLaunchLegs(f.launcher, quick), []);
      // Two for the positive leg, one for the negative — and every one of them reaped.
      assert.equal(f.pids().length, 3);
      for (const pid of f.pids()) assert.equal(alive(pid), false, `pid ${pid} was left running`);
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status names a home outside its temp directory — before a second process exists', async () => {
    // The mutant that matters most: a build that ignores SNUG_HOME. The leg would otherwise
    // go on to start a second process against whatever home that was.
    const f = fake('leaks-home');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && p.includes('/Users/someone/Snug')), JSON.stringify(problems));
      assert.equal(f.pids().length, 2, 'the positive leg must stop at ONE process (the negative leg starts the other)');
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status names a FILE outside its temp directory — a home in the right place is not enough', async () => {
    // The file is what gets written. A build that reports the home it was given and keeps
    // the user file somewhere else is the 2026-09-07 data loss with a reassuring status.
    const f = fake('leaks-file');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && p.includes('/Users/someone/Snug/user.snug')), JSON.stringify(problems));
      assert.equal(f.pids().length, 2, 'the positive leg must stop at ONE process (the negative leg starts the other)');
    } finally {
      f.remove();
    }
  });

  it('ABORTS the positive leg when the status’s pid is not the process the leg started', async () => {
    // A status from some OTHER runner means the leg attached to something it did not spawn.
    const f = fake('wrong-pid');
    try {
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /isolation/i.test(p) && /pid/.test(p)), JSON.stringify(problems));
      assert.equal(f.pids().length, 2);
    } finally {
      f.remove();
    }
  });

  it('catches a second process that does not attach — the defect this range exists for', async () => {
    const f = fake('never-attaches');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /did not attach/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches a process that RESOLVES a home when none was given', async () => {
    const f = fake('resolves-a-home-anyway');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /negative leg/.test(p) && /home-unresolved/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches the wrong refusal', async () => {
    const f = fake('wrong-refusal');
    try {
      assert.ok((await runLaunchLegs(f.launcher, quick)).some((p) => /negative leg/.test(p) && /listen-failed/.test(p)));
    } finally {
      f.remove();
    }
  });

  it('catches a launcher that never completes the handshake, by name — and does not hang', async () => {
    const f = fake('silent');
    try {
      const began = Date.now();
      const problems = await runLaunchLegs(f.launcher, quick);
      assert.ok(problems.some((p) => /positive leg/.test(p) && /initialize/.test(p)), JSON.stringify(problems));
      assert.ok(problems.some((p) => /negative leg/.test(p) && /initialize/.test(p)), JSON.stringify(problems));
      assert.ok(Date.now() - began < 15_000);
    } finally {
      f.remove();
    }
  });

  it('catches a launcher that is not there', async () => {
    const problems = await runLaunchLegs('/nowhere/scripts/snug', quick);
    assert.ok(problems.length >= 2);
  });

  it('REAPS a process that will not go: closing its input and a SIGTERM are followed, after the bound, by a SIGKILL', async () => {
    const f = fake('lingers');
    try {
      await runLaunchLegs(f.launcher, quick);
      assert.equal(f.pids().length, 3);
      for (const pid of f.pids()) assert.equal(alive(pid), false, `pid ${pid} outlived the leg`);
    } finally {
      f.remove();
    }
  });
});
