// The plugin assembly: a missing input must be CANNOT RUN by name, never a smaller plugin;
// the tree carries the process, the launcher, the skill and its provenance.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { buildPlugin, checkProvenance, readme, SKILL_DIR } from './build-plugin.mjs';

export const FAKE_SKILL = { 'SKILL.md': '---\nname: snug\n---\n# fake', 'references/10-x.md': '# x' };

export const fixtures = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'snugsrc-'));
  mkdirSync(path.join(dir, 'in'), { recursive: true });
  const write = (name, text) => {
    const file = path.join(dir, 'in', name);
    writeFileSync(file, text);
    return file;
  };
  const sources = {
    bundle: write('snug-mcp.mjs', '// bundle'),
    page: write('snug-host-local.html', '<!doctype html><title>Snug</title>'),
    installRoots: write('install-roots.json', JSON.stringify({ binDirs: ['~/.local/bin'], versionedRoots: [{ root: '~/.nvm/versions/node', bin: 'bin' }] })),
    kit: write('snug-host.html', '<!doctype html><title>Snug kit</title>'),
    embed: write('snug-embed.mjs', '// embed'),
    pageBlocks: write('page-blocks.mjs', '// blocks'),
    license: write('LICENSE', 'MIT License'),
  };
  return { dir, out: path.join(dir, 'out'), sources };
};

const build = (out, sources) => buildPlugin(out, sources, { skill: FAKE_SKILL, commit: 'abc123' });

describe('buildPlugin', () => {
  it('writes the whole installable tree', async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      for (const rel of [
        '.claude-plugin/marketplace.json',
        'snug/.claude-plugin/plugin.json',
        'snug/.mcp.json',
        'snug/scripts/snug-mcp.mjs',
        'snug/scripts/snug-host-local.html',
        'snug/scripts/snug',
        `snug/${SKILL_DIR}/SKILL.md`,
        `snug/${SKILL_DIR}/references/10-x.md`,
        `snug/${SKILL_DIR}/assets/snug-host.html`,
        `snug/${SKILL_DIR}/scripts/snug-embed.mjs`,
        `snug/${SKILL_DIR}/scripts/lib/page-blocks.mjs`,
        'snug/README.md',
        'snug/LICENSE',
        'snug/PROVENANCE.json',
      ]) {
        assert.ok(existsSync(path.join(out, rel)), `missing ${rel}`);
      }
      // The launcher is what the manifest runs (AC3): sh, executable, pointing beside itself.
      const launcher = path.join(out, 'snug/scripts/snug');
      assert.ok(statSync(launcher).mode & 0o100, 'the launcher must be executable');
      assert.ok(readFileSync(launcher, 'utf8').startsWith('#!/bin/sh'));
      const mcp = JSON.parse(readFileSync(path.join(out, 'snug/.mcp.json'), 'utf8'));
      assert.deepEqual(mcp.mcpServers.snug, { command: '/bin/sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/snug'] });
      // The skill is the pre-built tree, byte for byte.
      assert.equal(readFileSync(path.join(out, `snug/${SKILL_DIR}/SKILL.md`), 'utf8'), FAKE_SKILL['SKILL.md']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES by name when the bundle has not been built', async () => {
    const { dir, out, sources } = fixtures();
    rmSync(sources.bundle);
    try {
      const problems = await build(out, sources);
      assert.ok(problems.some((p) => p.includes('bundle')), JSON.stringify(problems));
      // and writes nothing: a partial plugin is worse than none
      assert.ok(!existsSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES by name when the artifact kit is missing — the skill would cite an asset it does not have', async () => {
    const { dir, out, sources } = fixtures();
    rmSync(sources.kit);
    try {
      const problems = await build(out, sources);
      assert.ok(problems.some((p) => p.includes('kit')), JSON.stringify(problems));
      assert.ok(!existsSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a provenance the tree verifies against, and catches a changed file', async () => {
    const { dir, out, sources } = fixtures();
    try {
      await build(out, sources);
      const pluginDir = path.join(out, 'snug');
      assert.deepEqual(checkProvenance(pluginDir), []);
      const doc = JSON.parse(readFileSync(path.join(pluginDir, 'PROVENANCE.json'), 'utf8'));
      assert.equal(doc.commit, 'abc123');
      assert.ok(Object.keys(doc.files).includes('scripts/snug-mcp.mjs'));
      assert.ok(!Object.keys(doc.files).includes('PROVENANCE.json'));
      // The mutants: a file edited after the build; a file added; a file removed.
      writeFileSync(path.join(pluginDir, 'README.md'), 'edited');
      assert.ok(checkProvenance(pluginDir).some((p) => p.includes('README.md')));
      writeFileSync(path.join(pluginDir, 'extra.txt'), 'x');
      assert.ok(checkProvenance(pluginDir).some((p) => p.includes('extra.txt')));
      rmSync(path.join(pluginDir, 'LICENSE'));
      assert.ok(checkProvenance(pluginDir).some((p) => p.includes('LICENSE')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the README a marketplace reviewer reads', () => {
  it('names the two prerequisites and the install, and ships no hooks', () => {
    const text = readme();
    assert.match(text, /Node\.js 20/);
    assert.match(text, /Claude Code/);
    assert.match(text, /\/login/);
    assert.match(text, /claude plugin install snug@snug-skill/);
    assert.match(text, /no hooks/);
    assert.match(text, /PROVENANCE\.json/);
    assert.doesNotMatch(text, /curl .*\| *bash/);
  });
});

describe('the tree carries no path from the machine that built it', () => {
  it('writes no .codex-plugin interim and no absolute path anywhere (the distribution repo is a verbatim copy)', async () => {
    const { dir, out, sources } = fixtures();
    try {
      await buildPlugin(out, sources, { skill: FAKE_SKILL, commit: 'abc123' });
      assert.ok(!existsSync(path.join(out, 'snug/.codex-plugin')));
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const file of walk(path.join(out, 'snug'))) {
        if (/\.(html|mjs)$/.test(file) && !file.endsWith('scripts/snug')) continue; // the built inputs are fixtures here
        assert.ok(!readFileSync(file, 'utf8').includes(out), `${path.relative(out, file)} names the build machine's path`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names a skill that cannot ship as a problem, never as a stack', async () => {
    const { dir, out, sources } = fixtures();
    try {
      const problems = await buildPlugin(out, sources, { skill: undefined, commit: 'abc123', ...{ } });
      // With no pre-built skill the real sources render; this fixture cannot reach the knowledge dist
      // in every environment, so the only claim is the SHAPE: a string list, never a throw.
      assert.ok(Array.isArray(problems));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
