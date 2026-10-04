// The plugin assembly: a missing input must be CANNOT RUN by name, never a smaller plugin;
// the tree carries the process, the launcher, the skill and its provenance.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_NAME,
  buildPlugin,
  checkDirectoryRules,
  checkProvenance,
  commitLabel,
  MAX_FILE_BYTES,
  PAGE_PATH,
  PAGE_PIN_PATH,
  readme,
  README_MIN_WORDS,
  SKILL_DIR,
  wordsOutsideCode,
} from './build-plugin.mjs';
import { BUNDLE_PATH, claudePluginManifest, LAUNCHER_PATH, PLUGIN } from './lib/plugin-manifests.mjs';
import { readZip } from './lib/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    installRoots: write('install-roots.json', JSON.stringify({ binDirs: ['~/.local/bin'], versionedRoots: [{ root: '~/.nvm/versions/node', bin: 'bin' }] })),
    kit: write('snug-host.html', '<!doctype html><title>Snug kit</title>'),
    embed: write('snug-embed.mjs', '// embed'),
    pageBlocks: write('page-blocks.mjs', '// blocks'),
    license: write('LICENSE', 'MIT License'),
  };
  return { dir, out: path.join(dir, 'out'), sources };
};

const build = (out, sources) => buildPlugin(out, sources, { skill: FAKE_SKILL, commit: 'abc123' });

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, as sorted `/`-separated paths from it. */
const filesUnder = (dir, base = dir) =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? filesUnder(path.join(dir, entry.name), base) : [path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/')]))
    .sort();

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
        'snug/scripts/snug',
        `snug/${SKILL_DIR}/SKILL.md`,
        `snug/${SKILL_DIR}/references/10-x.md`,
        `snug/${SKILL_DIR}/assets/snug-host.html`,
        `snug/${SKILL_DIR}/scripts/snug-embed.mjs`,
        `snug/${SKILL_DIR}/scripts/lib/page-blocks.mjs`,
        'snug/README.md',
        'snug/LICENSE',
        'PROVENANCE.json',
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

  it('ships the page ONCE — the skill’s asset is the page the process serves; no second copy under scripts/ (K1)', async () => {
    // The plugin used to carry the kit twice: `skills/snug/assets/snug-host.html` for the
    // artifact route and a separately built `scripts/…-local.html` for the runner — the same
    // size, 2.26 MB each.
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      const pages = walk(out).filter((file) => file.endsWith('.html')).map((file) => path.relative(out, file).split(path.sep).join('/'));
      assert.deepEqual(pages, [`snug/${PAGE_PATH}`]);
      assert.equal(PAGE_PATH, `${SKILL_DIR}/assets/snug-host.html`);
      assert.equal(readFileSync(path.join(out, 'snug', PAGE_PATH), 'utf8'), readFileSync(sources.kit, 'utf8'));
      assert.deepEqual(readdirSync(path.join(out, 'snug/scripts')).sort(), ['snug', 'snug-mcp.mjs']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts the page where the process LOOKS for it: the locator’s first home, resolved from the bundle’s directory', async () => {
    // `apps/host-mcp/src/page.ts` finds the page relative to the bundle. A missing page is
    // served as a placeholder with HTTP 200, so a layout that moved one side and not the
    // other would ship a plugin whose runner opens on "the page is missing" — and every
    // file-reading rule of the gate would pass. This resolves the process's own list
    // inside a built tree. (The launch leg of `check-host-mcp` then proves it over HTTP.)
    const locator = readFileSync(path.join(REPO, 'apps/host-mcp/src/page.ts'), 'utf8');
    const list = /export const PAGE_CANDIDATES = \[([^\]]+)\] as const;/.exec(locator)?.[1];
    assert.ok(list, 'PAGE_CANDIDATES moved or changed its spelling in apps/host-mcp/src/page.ts');
    const candidates = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.equal(candidates.length, 3);
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const bundleDir = path.join(out, 'snug', path.dirname(BUNDLE_PATH));
      const found = candidates.map((candidate) => path.join(bundleDir, candidate)).filter((file) => existsSync(file));
      assert.deepEqual(found, [path.join(out, 'snug', PAGE_PATH)], 'the FIRST candidate — and only it — must be the shipped page');
      assert.equal(path.join(bundleDir, candidates[0]), path.join(out, 'snug', PAGE_PATH));
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
      assert.deepEqual(checkProvenance(out), []);
      const doc = JSON.parse(readFileSync(path.join(out, 'PROVENANCE.json'), 'utf8'));
      assert.equal(doc.commit, 'abc123');
      assert.ok(Object.keys(doc.files).includes('snug/scripts/snug-mcp.mjs'));
      // The root marketplace manifest ships in the verbatim copy, so it is covered too.
      assert.ok(Object.keys(doc.files).includes('.claude-plugin/marketplace.json'));
      assert.ok(!Object.keys(doc.files).includes('PROVENANCE.json'));
      // The mutants: a file edited after the build; a file added; a file removed.
      writeFileSync(path.join(pluginDir, 'README.md'), 'edited');
      assert.ok(checkProvenance(out).some((p) => p.includes('README.md')));
      writeFileSync(path.join(pluginDir, 'extra.txt'), 'x');
      assert.ok(checkProvenance(out).some((p) => p.includes('extra.txt')));
      rmSync(path.join(pluginDir, 'LICENSE'));
      assert.ok(checkProvenance(out).some((p) => p.includes('LICENSE')));
      writeFileSync(path.join(out, 'PROVENANCE.json'), '{not json');
      assert.ok(checkProvenance(out).some((p) => p.includes('not JSON')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the order a provenance lists files in', () => {
  it('is path order, folder by folder — what the directory handed back first is not part of it', async () => {
    // (Characterization, 2026-10-03: the walk under the provenance was reshaped to list
    // folders too, for the directory's rules. Its order was never pinned.)
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const listed = Object.keys(JSON.parse(readFileSync(path.join(out, 'PROVENANCE.json'), 'utf8')).files);
      const bySegments = (a, b) => {
        const [left, right] = [a.split('/'), b.split('/')];
        const at = left.findIndex((segment, index) => segment !== right[index]);
        return left[at] < right[at] ? -1 : 1;
      };
      assert.deepEqual(listed, [...listed].sort(bySegments));
      assert.equal(listed[0], '.claude-plugin/marketplace.json');
      assert.equal(listed.at(-1), ARCHIVE_NAME);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the page is pinned (D8, the build half)', () => {
  // The process serves the page only when it hashes to the `<page>.sha256` beside it
  // (`apps/host-mcp/src/page.ts`); with no pin it serves whatever is there. So the pin is
  // what makes an INSTALLED plugin refuse a partial copy or a stale mix of two versions —
  // and until the build wrote one, every install ran unpinned.

  it('writes the page’s sha256 beside it — over the BYTES, in the spelling the process reads', async () => {
    const { dir, out, sources } = fixtures();
    // Bytes that are not UTF-8: a hash taken over a decoded string would be of other bytes.
    const page = Buffer.concat([Buffer.from('<!doctype html><title>kit</title><p>héllo'), Buffer.from([0xff, 0xfe, 0x00])]);
    writeFileSync(sources.kit, page);
    try {
      assert.deepEqual(await build(out, sources), []);
      assert.equal(PAGE_PIN_PATH, `${PAGE_PATH}.sha256`);
      const pin = readFileSync(path.join(out, 'snug', PAGE_PIN_PATH), 'utf8');
      assert.equal(pin, `${sha256(page)}  snug-host.html\n`);

      // What the locator does with that file: reads `<page>.sha256`, takes the first token,
      // lower-cases it, wants 64 hex digits equal to the hash of the page it read.
      const locator = readFileSync(path.join(REPO, 'apps/host-mcp/src/page.ts'), 'utf8');
      assert.match(locator, /read\(`\$\{file\}\.sha256`\)/, 'the process no longer reads `<page>.sha256` — the pin this build writes would be ignored');
      const token = pin.trim().split(/\s+/)[0].toLowerCase();
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal(token, sha256(readFileSync(path.join(out, 'snug', PAGE_PATH))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SHASUM = '/usr/bin/shasum';
  it('is a line `shasum -c` accepts in the page’s folder — and refuses once the page has changed', { skip: existsSync(SHASUM) ? false : `${SHASUM} is not on this machine` }, async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const folder = path.join(out, 'snug', path.dirname(PAGE_PATH));
      const check = () => spawnSync(SHASUM, ['-a', '256', '-c', path.basename(PAGE_PIN_PATH)], { cwd: folder, encoding: 'utf8' });
      assert.equal(check().status, 0, check().stderr);
      writeFileSync(path.join(out, 'snug', PAGE_PATH), 'a stale mix');
      assert.notEqual(check().status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the provenance accounts for the pin — and its own hash of the page is the one the pin names', async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      assert.deepEqual(checkProvenance(out), []);
      const doc = JSON.parse(readFileSync(path.join(out, 'PROVENANCE.json'), 'utf8'));
      const pinFile = path.join(out, 'snug', PAGE_PIN_PATH);
      assert.equal(doc.files[`snug/${PAGE_PIN_PATH}`], sha256(readFileSync(pinFile)));
      assert.equal(doc.files[`snug/${PAGE_PATH}`], readFileSync(pinFile, 'utf8').split(/\s+/)[0]);
      // The mutants: a pin rewritten after the build (the same-user writer the pin itself
      // cannot stop is at least visible here), and a pin removed.
      writeFileSync(pinFile, `${sha256('another page')}  snug-host.html\n`);
      assert.ok(checkProvenance(out).some((p) => p.includes('snug-host.html.sha256')));
      rmSync(pinFile);
      assert.ok(checkProvenance(out).some((p) => p.includes('snug-host.html.sha256') && p.includes('not in the tree')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the upload archive (D3)', () => {
  // What Claude's "Customize → Plugins → Add → Upload plugin" takes: a zip whose single
  // top-level entry is the plugin folder. The marketplace's own files (its manifest, the
  // provenance) describe a REPO, and are not in it.
  const entriesOf = (out) => readZip(readFileSync(path.join(out, ARCHIVE_NAME)));

  it('writes snug.zip beside the plugin folder: that folder, whole, and nothing else', async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      assert.equal(ARCHIVE_NAME, 'snug.zip');
      const entries = entriesOf(out);
      assert.equal(entries[0].name, 'snug/');
      assert.deepEqual([...new Set(entries.map((entry) => entry.name.split('/')[0]))], ['snug'], 'ONE top-level entry');
      const files = entries.filter((entry) => !entry.name.endsWith('/'));
      assert.deepEqual(
        files.map((entry) => entry.name).sort(),
        filesUnder(path.join(out, 'snug')).map((rel) => `snug/${rel}`),
      );
      for (const entry of files) assert.deepEqual(entry.data, readFileSync(path.join(out, entry.name)), entry.name);
      // By name, too: the two files of the marketplace root, and the archive itself.
      for (const name of entries.map((entry) => entry.name)) assert.doesNotMatch(name, /PROVENANCE|marketplace\.json|\.zip$/);
      // The pin travels with the page it pins.
      assert.ok(files.some((entry) => entry.name === `snug/${PAGE_PIN_PATH}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the launcher runnable (0755) and every other file 0644 — whatever modes the build machine left on its inputs', async () => {
    // A commit carries ONE bit of a mode (runnable or not); the rest is the builder's umask
    // and checkout. Copied through, an input a strict umask left 0600 would be a plugin file
    // another account cannot read, and the same commit would be two different archives.
    const { dir, out, sources } = fixtures();
    chmodSync(sources.license, 0o600);
    chmodSync(sources.embed, 0o664);
    try {
      assert.deepEqual(await build(out, sources), []);
      // The premise: the tree itself took the inputs' modes (so the archive is where they stop).
      assert.equal(statSync(path.join(out, 'snug/LICENSE')).mode & 0o777, 0o600);
      const files = entriesOf(out).filter((entry) => !entry.name.endsWith('/'));
      for (const entry of files) assert.equal(entry.mode, entry.name === `snug/${LAUNCHER_PATH}` ? 0o100755 : 0o100644, `${entry.name} is ${entry.mode.toString(8)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is the same bytes for the same inputs — two builds, two output folders, one archive', async () => {
    const { dir, out, sources } = fixtures();
    const again = path.join(dir, 'out-again');
    try {
      assert.deepEqual(await build(out, sources), []);
      assert.deepEqual(await build(again, sources), []);
      assert.ok(readFileSync(path.join(out, ARCHIVE_NAME)).equals(readFileSync(path.join(again, ARCHIVE_NAME))));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is listed in the provenance by its sha256, like every other file the build writes', async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const doc = JSON.parse(readFileSync(path.join(out, 'PROVENANCE.json'), 'utf8'));
      assert.equal(doc.files[ARCHIVE_NAME], sha256(readFileSync(path.join(out, ARCHIVE_NAME))));
      assert.deepEqual(checkProvenance(out), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const UNZIP = '/usr/bin/unzip';
  it('unzips, with the system’s own unzip, into the tree it was made from — launcher still runnable', { skip: existsSync(UNZIP) ? false : `${UNZIP} is not on this machine` }, async () => {
    const { dir, out, sources } = fixtures();
    const into = path.join(dir, 'unzipped');
    try {
      assert.deepEqual(await build(out, sources), []);
      const archive = path.join(out, ARCHIVE_NAME);
      const tested = spawnSync(UNZIP, ['-t', archive], { encoding: 'utf8' });
      assert.equal(tested.status, 0, `${tested.stdout}\n${tested.stderr}`);
      const unzipped = spawnSync(UNZIP, ['-q', archive, '-d', into], { encoding: 'utf8' });
      assert.equal(unzipped.status, 0, `${unzipped.stdout}\n${unzipped.stderr}`);
      assert.deepEqual(readdirSync(into), ['snug']);
      assert.deepEqual(filesUnder(path.join(into, 'snug')), filesUnder(path.join(out, 'snug')));
      for (const rel of filesUnder(path.join(out, 'snug'))) assert.deepEqual(readFileSync(path.join(into, 'snug', rel)), readFileSync(path.join(out, 'snug', rel)), rel);
      assert.equal(statSync(path.join(into, 'snug', LAUNCHER_PATH)).mode & 0o777, 0o755);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the directory’s install-blocking rules, held by the built tree (D2)', () => {
  // Each of these stops a plugin being installed from the directory (or, for `bin/`, from
  // chat and Cowork at all) — read from the plugin docs on 2026-10-03. A rule is only held
  // if breaking it is seen, so each one is broken here in a tree the builder wrote.

  /** A real build, one mutation of the plugin folder, the rules' verdict. */
  const broken = async (mutate) => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const plugin = path.join(out, 'snug');
      mutate(plugin);
      return checkDirectoryRules(plugin);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const rewrite = (file, change) => writeFileSync(file, JSON.stringify(change(JSON.parse(readFileSync(file, 'utf8')))));
  const manifestOf = (plugin) => path.join(plugin, '.claude-plugin/plugin.json');

  it('a tree the builder wrote keeps every one', async () => {
    assert.deepEqual(await broken(() => {}), []);
  });

  it('the manifest names the plugin for a person: displayName "Snug", from the one constants module', async () => {
    assert.equal(PLUGIN.displayName, 'Snug');
    assert.equal(claudePluginManifest().displayName, 'Snug');
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      const manifest = JSON.parse(readFileSync(manifestOf(path.join(out, 'snug')), 'utf8'));
      for (const field of ['name', 'displayName', 'version', 'description', 'author', 'license']) assert.ok(field in manifest, `plugin.json has no ${field}`);
      assert.equal(manifest.displayName, 'Snug');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const field of ['name', 'displayName', 'version', 'description', 'author', 'license']) {
    it(`catches a manifest with no ${field}`, async () => {
      const problems = await broken((plugin) => rewrite(manifestOf(plugin), ({ [field]: _gone, ...rest }) => rest));
      assert.ok(problems.some((p) => p.includes('plugin.json') && p.includes(field)), JSON.stringify(problems));
    });
  }

  it('catches a manifest field that is there and says nothing', async () => {
    const blank = await broken((plugin) => rewrite(manifestOf(plugin), (manifest) => ({ ...manifest, displayName: '  ' })));
    assert.ok(blank.some((p) => p.includes('plugin.json') && p.includes('displayName')), JSON.stringify(blank));
    const nameless = await broken((plugin) => rewrite(manifestOf(plugin), (manifest) => ({ ...manifest, author: {} })));
    assert.ok(nameless.some((p) => p.includes('plugin.json') && p.includes('author')), JSON.stringify(nameless));
  });

  it('catches a manifest that does not parse, or is not an object — by name, not by a throw', async () => {
    const unparsed = await broken((plugin) => writeFileSync(manifestOf(plugin), '{nope'));
    assert.ok(unparsed.some((p) => p.includes('plugin.json') && /not readable JSON/.test(p)), JSON.stringify(unparsed));
    const nothing = await broken((plugin) => writeFileSync(manifestOf(plugin), 'null'));
    assert.ok(nothing.some((p) => p.includes('plugin.json') && p.includes('displayName')), JSON.stringify(nothing));
  });

  it('counts a README’s words OUTSIDE its fenced code blocks, and not its markup', () => {
    assert.equal(wordsOutsideCode('# Snug\n\nBuild and run **your own** micro apps.\n'), 8);
    assert.equal(wordsOutsideCode('one two\n```\nthree four five\n```\nsix\n~~~sh\nseven\n~~~\n'), 3);
    assert.equal(wordsOutsideCode('- — > * ## ---\n'), 0);
    assert.ok(wordsOutsideCode(readme()) >= README_MIN_WORDS);
  });

  it('catches a README of fewer than forty such words — thirty-nine fails, forty passes, and words in a code block do not count', async () => {
    assert.equal(README_MIN_WORDS, 40);
    const words = (count) => Array.from({ length: count }, (_, index) => `word${index}`).join(' ');
    const fenced = `\n\n\`\`\`\n${words(100)}\n\`\`\`\n`;
    const short = await broken((plugin) => writeFileSync(path.join(plugin, 'README.md'), `# ${words(39)}${fenced}`));
    assert.ok(short.some((p) => p.includes('README.md') && p.includes('39') && p.includes('40')), JSON.stringify(short));
    assert.deepEqual(await broken((plugin) => writeFileSync(path.join(plugin, 'README.md'), `# ${words(40)}${fenced}`)), []);
    const none = await broken((plugin) => rmSync(path.join(plugin, 'README.md')));
    assert.ok(none.some((p) => p.includes('README.md')), JSON.stringify(none));
  });

  it('catches a tree with no license file', async () => {
    const problems = await broken((plugin) => rmSync(path.join(plugin, 'LICENSE')));
    assert.ok(problems.some((p) => /LICENSE/.test(p)), JSON.stringify(problems));
  });

  it('catches a top-level bin/ — and only a top-level one', async () => {
    const top = await broken((plugin) => mkdirSync(path.join(plugin, 'bin')));
    assert.ok(top.some((p) => /bin\//.test(p)), JSON.stringify(top));
    assert.deepEqual(await broken((plugin) => mkdirSync(path.join(plugin, SKILL_DIR, 'scripts', 'bin'))), []);
  });

  for (const [what, make] of [
    ['.DS_Store', (plugin) => writeFileSync(path.join(plugin, '.DS_Store'), '')],
    ['skills/snug/.DS_Store', (plugin) => writeFileSync(path.join(plugin, SKILL_DIR, '.DS_Store'), '')],
    ['__MACOSX', (plugin) => mkdirSync(path.join(plugin, '__MACOSX'))], // an EMPTY folder: no file would give it away
    ['skills/Thumbs.db', (plugin) => writeFileSync(path.join(plugin, 'skills', 'Thumbs.db'), '')],
    ['scripts/desktop.ini', (plugin) => writeFileSync(path.join(plugin, 'scripts', 'desktop.ini'), '')],
  ]) {
    it(`catches ${what}`, async () => {
      const problems = await broken(make);
      assert.ok(problems.some((p) => p.includes(what)), JSON.stringify(problems));
    });
  }

  it('catches a file of 5 MiB — one byte under passes', async () => {
    assert.equal(MAX_FILE_BYTES, 5 * 1024 * 1024);
    const at = await broken((plugin) => writeFileSync(path.join(plugin, 'skills', 'big.bin'), Buffer.alloc(MAX_FILE_BYTES)));
    assert.ok(at.some((p) => p.includes('skills/big.bin') && /5 MiB/.test(p)), JSON.stringify(at));
    assert.deepEqual(await broken((plugin) => writeFileSync(path.join(plugin, 'skills', 'big.bin'), Buffer.alloc(MAX_FILE_BYTES - 1))), []);
  });

  for (const rel of ['.npmrc', 'bunfig.toml', 'uv.toml', 'skills/snug/scripts/.npmrc']) {
    it(`catches package-manager configuration: ${rel}`, async () => {
      const problems = await broken((plugin) => writeFileSync(path.join(plugin, rel), ''));
      assert.ok(problems.some((p) => p.includes(rel) && /package-manager/.test(p)), JSON.stringify(problems));
    });
  }

  describe('.mcp.json declares ONE server: /bin/sh on the launcher under ${CLAUDE_PLUGIN_ROOT}', () => {
    const server = { command: '/bin/sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/snug'] };
    const mcpOf = (plugin) => path.join(plugin, '.mcp.json');
    const caught = (problems) => assert.ok(problems.some((p) => p.includes('.mcp.json')), JSON.stringify(problems));

    it('is what the builder writes', async () => {
      const { dir, out, sources } = fixtures();
      try {
        assert.deepEqual(await build(out, sources), []);
        assert.deepEqual(JSON.parse(readFileSync(mcpOf(path.join(out, 'snug')), 'utf8')), { mcpServers: { snug: server } });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('passes the same server with its keys in another order', async () => {
      assert.deepEqual(await broken((plugin) => writeFileSync(mcpOf(plugin), JSON.stringify({ mcpServers: { snug: { args: server.args, command: server.command } } }))), []);
    });

    for (const [what, config] of [
      ['a file that does not parse', '{nope'],
      ['no server', JSON.stringify({ mcpServers: {} })],
      ['no mcpServers at all', JSON.stringify({})],
      ['a second server', JSON.stringify({ mcpServers: { snug: server, other: server } })],
      ['a bare `node` (a desktop host has no PATH to find it on)', JSON.stringify({ mcpServers: { snug: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/snug-mcp.mjs'] } } })],
      ['a launcher outside the plugin root', JSON.stringify({ mcpServers: { snug: { ...server, args: ['/usr/local/bin/snug'] } } })],
      ['an extra argument', JSON.stringify({ mcpServers: { snug: { ...server, args: [...server.args, '--verbose'] } } })],
      ['an env block', JSON.stringify({ mcpServers: { snug: { ...server, env: { NODE_OPTIONS: '--inspect' } } } })],
    ]) {
      it(`catches ${what}`, async () => caught(await broken((plugin) => writeFileSync(mcpOf(plugin), config))));
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
    // The page is named where it IS — once, under the skill.
    assert.match(text, /`skills\/snug\/assets\/snug-host\.html` — the runner page/);
    // …and the file beside it is explained: a reviewer who meets an unexplained hash asks why.
    assert.match(text, /`skills\/snug\/assets\/snug-host\.html\.sha256` — that page’s sha256/);
    assert.doesNotMatch(text, /scripts\/snug-host/);
    assert.doesNotMatch(text, /curl .*\| *bash/);
  });

  /** The README as sentences: its lines are wrapped, and a claim must not hide across a line break. */
  const said = () => readme().replace(/\s+/g, ' ');

  it('names what ANSWERS the thinks, truthfully: your own Claude Code CLI — or, experimentally, your own Codex CLI, pinned from the brain chip (ADR-0071)', () => {
    const text = said();
    assert.match(text, /your own Claude Code CLI \(or, experimentally, your own Codex CLI — pinned from the brain chip\)/);
    // Under "What it needs", as a prerequisite — not a feature line somewhere below.
    const needs = readme().split('## What it needs')[1].split('## Install')[0];
    assert.match(needs.replace(/\s+/g, ' '), /your own Claude Code CLI \(or, experimentally, your own Codex CLI/);
    // Codex is named ONCE, and never without "experimentally": it is unverified until a
    // logged-in walk is journaled (B6), and `auto` never takes it.
    assert.equal(text.match(/Codex/g).length, 1);
    // The summary no longer says the thinks run on "your own Claude" alone.
    assert.doesNotMatch(text, /think through your own Claude\b/);
    assert.match(text, /think through your own agent/);
    // A brain on a key is not "your own agent" (ADR-0071 §3): the README still asks for none.
    assert.match(text, /No API key/);
    // What the demo brain is, and that the chip says what to do, survive the rewording.
    assert.match(text, /demo brain/);
    assert.match(text, /brain chip says/);
  });

  it('says where PROVENANCE.json IS — beside the plugin folder in the marketplace repository — and that an uploaded archive has none', () => {
    // The line read "`../PROVENANCE.json` (the marketplace root)". For someone who installed
    // with "Upload plugin" there is no `..`: the archive is this folder alone (D3).
    const text = said();
    assert.doesNotMatch(text, /\.\.\/PROVENANCE\.json/);
    assert.match(text, /`PROVENANCE\.json` — not in this folder: it sits beside it in the marketplace repository \(https:\/\/github\.com\/snugprotocol\/snug-skill\)/);
    assert.match(text, /It is not part of an uploaded archive/);
    assert.match(text, /the monorepo commit this tree was built from/);
    // The repository is the manifests' value, not a second typed copy.
    assert.ok(text.includes(`in the marketplace repository (${PLUGIN.repository})`));
  });

  it('…which is true of what the build writes: the provenance is beside the plugin folder, not in it, and not in the archive', async () => {
    const { dir, out, sources } = fixtures();
    try {
      assert.deepEqual(await build(out, sources), []);
      assert.ok(existsSync(path.join(out, 'PROVENANCE.json')));
      assert.ok(!existsSync(path.join(out, 'snug', 'PROVENANCE.json')));
      assert.deepEqual(readZip(readFileSync(path.join(out, ARCHIVE_NAME))).filter((entry) => /PROVENANCE/.test(entry.name)), []);
      // And the README the tree ships is the one tested above.
      assert.equal(readFileSync(path.join(out, 'snug', 'README.md'), 'utf8'), readme());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('the commit a provenance names', () => {
  it('is the bare SHA for a clean tree and SHA-dirty for a tree that differs from it', () => {
    assert.equal(commitLabel('abc', ''), 'abc');
    assert.equal(commitLabel('abc', '\n'), 'abc');
    assert.equal(commitLabel('abc', ' M scripts/x.mjs\n'), 'abc-dirty');
  });
});
