// AC3 — the launcher starts the process with no user PATH (ADR-0069 §6).
//
// The script is sh, so the tests spawn a real `sh` with a controlled HOME and PATH and a
// FAKE node (a sh script that answers the version probe and records the argv it was exec'd
// with). Every rule has a case that would fail without it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { launcherScript, NODE_MIN_MAJOR, readInstallRoots } from './plugin-launcher.mjs';

const roots = readInstallRoots();

/**
 * The real list with its ABSOLUTE directories moved under the temp dir. The first run of
 * this file found the owner's own /opt/homebrew/bin/node through the real list and ran the
 * stand-in bundle with it — every "no node anywhere" case exited 0. A behavioural test must
 * not be able to reach the machine it runs on.
 */
function isolatedRoots(base) {
  const move = (dir) => (dir.startsWith('~/') ? dir : path.join(base, 'root', dir));
  return {
    binDirs: roots.binDirs.map(move),
    versionedRoots: roots.versionedRoots.map(({ root, bin }) => ({ root: move(root), bin })),
  };
}

/** A plugin dir (optionally with a space in its name) holding the launcher and a stand-in bundle. */
function plugin(name = 'plugin') {
  const base = mkdtempSync(path.join(tmpdir(), 'snug-launcher-'));
  const dir = path.join(base, name, 'scripts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'snug-mcp.mjs'), '// stand-in bundle');
  const launcher = path.join(dir, 'snug');
  writeFileSync(launcher, launcherScript({ bundleBasename: 'snug-mcp.mjs', roots: isolatedRoots(base) }));
  return { base, launcher, bundle: path.join(dir, 'snug-mcp.mjs') };
}

/** A fake `node` at `dir/node` reporting `version`, recording its argv to `record` when run. */
function fakeNode(dir, version, record) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'node');
  writeFileSync(
    file,
    `#!/bin/sh\ncase "\${1:-}" in -p) echo "${version}"; exit 0 ;; esac\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${record}"\nexit 0\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

function run(launcher, env, extraArgs = []) {
  return spawnSync('/bin/sh', [launcher, ...extraArgs], { env, encoding: 'utf8' });
}

describe('the generated launcher', () => {
  it('parses as POSIX sh', () => {
    const { launcher, base } = plugin();
    try {
      const result = spawnSync('/bin/sh', ['-n', launcher], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('is templated from the one install-roots list, not a second copy', () => {
    const text = launcherScript({ bundleBasename: 'x.mjs', roots });
    for (const dir of roots.binDirs) assert.ok(text.includes(dir.replace('~/', '$HOME/')), `missing ${dir}`);
    for (const { root, bin } of roots.versionedRoots) assert.ok(text.includes(`${root.replace('~/', '$HOME/')}"/*/${bin}`), `missing ${root}`);
    assert.ok(text.includes(`-ge ${NODE_MIN_MAJOR}`));
  });

  it('execs a node from PATH with the bundle beside itself, passing extra arguments through', () => {
    const { base, launcher, bundle } = plugin();
    const record = path.join(base, 'argv');
    const home = path.join(base, 'home');
    const bin = path.join(base, 'onpath');
    fakeNode(bin, '22.13.1', record);
    try {
      const result = run(launcher, { HOME: home, PATH: `/nonexistent:${bin}` }, ['open']);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n'), [bundle, 'open']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('finds a node under nvm with NO PATH at all — the GUI-spawned case', () => {
    const { base, launcher } = plugin();
    const record = path.join(base, 'argv');
    const home = path.join(base, 'home');
    fakeNode(path.join(home, '.nvm/versions/node/v22.0.0/bin'), '22.0.0', record);
    try {
      const result = run(launcher, { HOME: home, PATH: '' });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(record, 'utf8').includes('snug-mcp.mjs'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('skips a node that is too old on PATH in favour of a new enough one under a root', () => {
    const { base, launcher } = plugin();
    const home = path.join(base, 'home');
    const oldRecord = path.join(base, 'old');
    const newRecord = path.join(base, 'new');
    const onPath = path.join(base, 'onpath');
    fakeNode(onPath, '18.20.0', oldRecord);
    fakeNode(path.join(home, '.local/bin'), '22.1.0', newRecord);
    try {
      const result = run(launcher, { HOME: home, PATH: onPath });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(readFileSync(newRecord, 'utf8').includes('snug-mcp.mjs'), 'the 22 must have been exec’d');
      assert.throws(() => readFileSync(oldRecord), 'the 18 must not have been exec’d');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('with no node anywhere, prints ONE line naming the install and exits 1', () => {
    const { base, launcher } = plugin();
    try {
      const result = run(launcher, { HOME: path.join(base, 'home'), PATH: '/nonexistent' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /nodejs\.org/);
      assert.equal(result.stderr.trim().split('\n').length, 1);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('survives a HOME and a plugin root with spaces in them', () => {
    const { base, launcher, bundle } = plugin('My Plugins');
    const record = path.join(base, 'argv');
    const home = path.join(base, 'John Smith');
    fakeNode(path.join(home, '.volta/bin'), '22.0.0', record);
    try {
      const result = run(launcher, { HOME: home, PATH: '' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(record, 'utf8').trim(), bundle);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('never treats an empty PATH entry as the working directory', () => {
    // `PATH=":/x"` — a shell would run ./node; the launcher must not.
    const { base, launcher } = plugin();
    const cwd = path.join(base, 'cwd');
    fakeNode(cwd, '22.0.0', path.join(base, 'argv'));
    try {
      const result = spawnSync('/bin/sh', [launcher], { env: { HOME: path.join(base, 'home'), PATH: ':/nonexistent:' }, cwd, encoding: 'utf8' });
      assert.equal(result.status, 1, 'a node in the cwd must not be found through an empty PATH entry');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does not run a node that exists but is not executable', () => {
    const { base, launcher } = plugin();
    const home = path.join(base, 'home');
    const dir = path.join(home, '.local/bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'node'), '#!/bin/sh\necho 22.0.0\n');
    chmodSync(path.join(dir, 'node'), 0o644);
    try {
      const result = run(launcher, { HOME: home, PATH: '' });
      assert.equal(result.status, 1);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
