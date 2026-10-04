#!/usr/bin/env node
// Assemble the installable plugin tree (ADR-0068 §8, ADR-0069 §7).
//
// Output: `dist/plugin/` — a marketplace of one plus the plugin itself under `snug/`, which
// is what `claude plugin marketplace add` takes and what the distribution repo
// (`snugprotocol/snug-skill`) is a verbatim copy of. Every manifest field comes from
// `lib/plugin-manifests.mjs`; the launcher from `lib/plugin-launcher.mjs`; the skill from
// `lib/skill-build.mjs`. Nothing here hand-writes a field, and nothing here is committed.
//
// PROVENANCE. The tree is generated, so a reviewer of the distribution repo reads generated
// files by design; `PROVENANCE.json` ties them to the monorepo commit that built them and
// carries the sha256 of every shipped file, which the gate re-checks.
//
// Two more things are written from the finished plugin folder: the page's PIN (its sha256
// beside it — what makes an installed plugin serve the page it was built with, or none) and
// `snug.zip`, the same folder as the archive Claude's "Upload plugin" takes.
//
// This does NOT publish anything. Pushing the tree to the distribution repo, cutting a
// release and registering an npm scope are owner acts (PROCESS.md).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { INSTALL_ROOTS_FILE, launcherScript, readInstallRoots } from './lib/plugin-launcher.mjs';
import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, LAUNCHER_PATH, MARKETPLACE, marketplaceManifest, PLUGIN } from './lib/plugin-manifests.mjs';
import { buildSkillTree, SKILL_NAME } from './lib/skill-build.mjs';
import { createZip, isOsJunk } from './lib/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_OUT_DIR = path.join(REPO, 'dist', 'plugin');

/** Where the skill lives inside the plugin; `assets/` and `scripts/` under it are the skill's own. */
export const SKILL_DIR = `skills/${SKILL_NAME}`;

/**
 * The kit page's path inside the plugin, from its root — the ONE copy (ADR-0072 §1). It is
 * the skill's asset (the artifact route hands apps in to it) and it is the page the local
 * host process serves: `apps/host-mcp/src/page.ts` finds it relative to the bundle, and
 * `build-plugin.test.mjs` resolves that locator's first home against this path.
 */
export const PAGE_PATH = `${SKILL_DIR}/assets/snug-host.html`;

/**
 * The page's pin (D8): its sha256, in the file the process looks for beside the page
 * (`<page>.sha256` — `apps/host-mcp/src/page.ts`). With a pin there the process serves
 * only bytes that hash to it, and refuses to lead (`page-damaged`) otherwise: an installed
 * plugin serves the page it was built with or none. Without one — a developer's checkout —
 * the page is served as it is, which is why the build, not the process, must write it.
 */
export const PAGE_PIN_PATH = `${PAGE_PATH}.sha256`;

/**
 * The upload archive (D3), written beside the plugin folder it holds: what Claude's
 * "Customize → Plugins → Add → Upload plugin" takes. The marketplace root's own files
 * describe a repo and are not in it.
 */
export const ARCHIVE_NAME = `${PLUGIN.name}.zip`;

export const SOURCES = {
  bundle: path.join(REPO, 'apps/host-mcp/dist/snug-mcp.mjs'),
  installRoots: INSTALL_ROOTS_FILE,
  // The kit and its hand-in script: the skill folder carries the artifact route on its own,
  // so the folder alone uploads to claude.ai and still works — and the same page is what the
  // process serves (there is one page; the plugin used to ship a second build of it).
  kit: path.join(REPO, 'apps/host/dist/snug-host.html'),
  embed: path.join(REPO, 'scripts/snug-embed.mjs'),
  pageBlocks: path.join(REPO, 'scripts/lib/page-blocks.mjs'),
  license: path.join(REPO, 'LICENSE'),
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** What a marketplace reviewer and a first-time user read. Pinned by the gate's content bar. */
export function readme() {
  return [
    '# Snug',
    '',
    PLUGIN.description,
    '',
    'Snug apps are single-file micro apps your agent builds for you. Each one lives in your own',
    'Snug file on this machine, runs in a sandboxed runner, and can think through your own agent',
    'at runtime. You keep the app and everything it accumulates; nothing is uploaded.',
    '',
    '## What it needs',
    '',
    '- **Node.js 20 or newer** on this machine. The plugin starts a small local process (it serves',
    '  the runner page on `127.0.0.1` and nothing else). If no Node is found, the process says so',
    '  in one line and where to get it: https://nodejs.org',
    // What ANSWERS the thinks, as it is (ADR-0071): Claude by default; Codex only by the
    // user's own pin, and labelled experimental until a logged-in walk is journaled.
    '- **An agent CLI of your own, logged in**, to answer your apps’ thinks on your own',
    '  subscription: your own Claude Code CLI (or, experimentally, your own Codex CLI — pinned',
    '  from the brain chip). For Claude Code that is `claude`, then `/login`. Until one is ready',
    '  the runner opens with its demo brain and the brain chip says what to do. Claude Code:',
    '  https://code.claude.com/docs/en/quickstart',
    '',
    'No API key, no account, no configuration. The plugin ships no hooks and no data-plane tools:',
    'the agent can open the runner and hand apps in; it can never fetch with your credentials or',
    'read your file.',
    '',
    '## Install',
    '',
    '```',
    `claude plugin marketplace add snugprotocol/${MARKETPLACE.name}`,
    `claude plugin install ${PLUGIN.name}@${MARKETPLACE.name}`,
    '```',
    '',
    'Then start a new session and ask your agent to build something. From a local checkout of',
    'this tree the same two commands take a directory instead of `snugprotocol/…`.',
    '',
    '> After a plugin update, restart your agent so the running process is the new one: an',
    '> installed plugin is a copy under a version directory, and the process keeps the code it',
    '> loaded at spawn.',
    '',
    '## Where things are',
    '',
    '- `scripts/snug` — the launcher the plugin runs; finds Node where installers put it.',
    `- \`${BUNDLE_PATH}\` — the local host process.`,
    `- \`${SKILL_DIR}/\` — the skill: what a Snug app is, how to launch the runner, the authoring references.`,
    `- \`${PAGE_PATH}\` — the runner page: the process serves it, and the skill hands apps in to it.`,
    `- \`${PAGE_PIN_PATH}\` — that page’s sha256. The process serves the page only while it matches, so a`,
    '  partial or mixed-up install says so instead of running a page it was not built with.',
    // Said as where it IS. The line used to point at `../PROVENANCE.json`, which exists for a
    // marketplace clone and for nobody who installed with "Upload plugin" (D3: the archive
    // is this folder alone).
    '- `PROVENANCE.json` — not in this folder: it sits beside it in the marketplace repository',
    `  (${PLUGIN.repository}) and names the monorepo commit this tree was built from and every`,
    '  file’s sha256. It is not part of an uploaded archive.',
    '',
    `Source: ${PLUGIN.repository} · ${PLUGIN.homepage} · ${PLUGIN.license}`,
    '',
  ].join('\n');
}

/** Everything under `dir` — files AND folders, as `/`-separated paths from it, a folder ahead of what it holds. */
function tree(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    out.push({ rel: path.relative(base, full).split(path.sep).join('/'), folder: entry.isDirectory() });
    if (entry.isDirectory()) out.push(...tree(full, base));
  }
  return out;
}

/** The files under `dir`. */
const walk = (dir) => tree(dir).filter((entry) => !entry.folder).map((entry) => entry.rel);

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * The provenance document for a finished MARKETPLACE tree (the distribution repo's root):
 * every shipped file's sha256 — the plugin's, the root marketplace manifest's AND the
 * upload archive's — the commit, the time.
 *
 * (The archive's hash is of its container: the same tree deflated by another Node's zlib is
 * the same entries and may be other bytes. What is IN it is the gate's `checkArchive`.)
 */
export function provenance(treeDir, commit) {
  const files = {};
  for (const rel of walk(treeDir)) {
    if (rel === 'PROVENANCE.json') continue;
    files[rel] = sha256(path.join(treeDir, rel));
  }
  return { format: 'snug-plugin-provenance/1', commit, builtAt: new Date().toISOString(), files };
}

/** Which files a provenance document no longer describes (or describes wrongly). */
export function checkProvenance(treeDir) {
  const file = path.join(treeDir, 'PROVENANCE.json');
  if (!existsSync(file)) return ['PROVENANCE.json is missing'];
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return [`PROVENANCE.json is not JSON: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems = [];
  if (typeof doc.commit !== 'string' || doc.commit === '') problems.push('PROVENANCE.json names no commit');
  const listed = new Set(Object.keys(doc.files ?? {}));
  for (const rel of walk(treeDir)) {
    if (rel === 'PROVENANCE.json') continue;
    if (!listed.has(rel)) problems.push(`PROVENANCE.json does not list ${rel}`);
    else if (doc.files[rel] !== sha256(path.join(treeDir, rel))) problems.push(`PROVENANCE.json's hash for ${rel} does not match the file`);
    listed.delete(rel);
  }
  for (const rel of listed) problems.push(`PROVENANCE.json lists ${rel}, which is not in the tree`);
  return problems;
}

/**
 * The plugin folder as the archive's entries (D3): every file, named from the folder's own
 * name down — so `snug/` is the archive's ONE top-level entry — with the one bit of its
 * mode a commit carries: runnable, or not. The rest of a mode is the build machine's umask
 * and checkout; copied through, a strict umask would ship files another account cannot
 * read, and one commit would be two different archives. The gate reads the written archive
 * back against exactly this.
 */
export function archiveEntries(pluginDir) {
  return walk(pluginDir).map((rel) => {
    const file = path.join(pluginDir, rel);
    return { name: `${PLUGIN.name}/${rel}`, data: readFileSync(file), mode: statSync(file).mode & 0o111 ? 0o755 : 0o644 };
  });
}

// ------------------------------------------------------------- the directory's rules (D2)

/** The directory will not install a plugin carrying a file this large. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** …or one whose README says less than this, outside its code blocks. */
export const README_MIN_WORDS = 40;

const PACKAGE_MANAGER_CONFIG = ['.npmrc', 'bunfig.toml', 'uv.toml'];

/**
 * The one server the plugin may declare. Spelled out here, NOT read from
 * `plugin-manifests.mjs`: the rule is the directory's, so a change to the constants has to
 * meet it rather than redefine it.
 */
const INSTALLABLE_SERVER = { command: '/bin/sh', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/snug'] };

/** A README's words outside its fenced code blocks. A token with no letter or digit (`#`, `-`, `—`) is markup, not a word. */
export function wordsOutsideCode(markdown) {
  let fenced = false;
  let words = 0;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) words += line.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  }
  return words;
}

/**
 * The plugin directory's install-BLOCKING rules, against a built plugin folder (D2; the
 * task's reading of claude.com/docs/plugins — /build and /pre-submission-checklist — on
 * 2026-10-03).
 * Breaking any one stops the plugin being installed from the directory, and a top-level
 * `bin/` stops chat and Cowork installing it from anywhere. `claude plugin validate --strict`
 * holds none of them — measured 2026-10-03 on CLI 2.1.288, it passed a tree with no
 * displayName, no LICENSE, a one-word README, a `bin/`, a `.DS_Store`, a `__MACOSX/` and an
 * `.npmrc` — which is why they are held here.
 *
 * @param {string} pluginDir the plugin folder (`<tree>/snug`)
 * @returns {string[]} the rules the folder breaks; empty when it keeps them all
 */
export function checkDirectoryRules(pluginDir) {
  const problems = [];
  const parse = (rel) => {
    try {
      return JSON.parse(readFileSync(path.join(pluginDir, rel), 'utf8'));
    } catch (error) {
      problems.push(`${rel} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };
  const said = (value) => typeof value === 'string' && value.trim() !== '';

  const manifest = parse('.claude-plugin/plugin.json');
  if (manifest !== undefined) {
    const fields = manifest !== null && typeof manifest === 'object' ? manifest : {};
    for (const field of ['name', 'displayName', 'version', 'description', 'license']) {
      if (!said(fields[field])) problems.push(`.claude-plugin/plugin.json has no ${field}`);
    }
    if (!said(fields.author?.name)) problems.push('.claude-plugin/plugin.json has no author (an object with a name)');
  }

  const mcp = parse('.mcp.json');
  if (mcp !== undefined) {
    const servers = Object.values(mcp?.mcpServers ?? {});
    if (servers.length !== 1 || !isDeepStrictEqual(servers[0], INSTALLABLE_SERVER)) {
      problems.push(`.mcp.json must declare exactly one server, ${JSON.stringify(INSTALLABLE_SERVER)} — it declares ${JSON.stringify(mcp?.mcpServers ?? null)}`);
    }
  }

  const readmeFile = path.join(pluginDir, 'README.md');
  if (!existsSync(readmeFile)) problems.push('README.md is missing');
  else {
    const words = wordsOutsideCode(readFileSync(readmeFile, 'utf8'));
    if (words < README_MIN_WORDS) problems.push(`README.md has ${words} words outside its code blocks; at least ${README_MIN_WORDS} are needed`);
  }
  if (!existsSync(path.join(pluginDir, 'LICENSE'))) problems.push('there is no LICENSE file');

  // Folders too, not only files: an empty `__MACOSX/` or `bin/` has no file to give it away.
  for (const { rel, folder } of tree(pluginDir)) {
    const name = path.posix.basename(rel);
    const { size } = statSync(path.join(pluginDir, rel));
    if (rel === 'bin' && folder) problems.push('a top-level bin/ directory — chat and Cowork do not install a plugin that has one');
    if (isOsJunk(name)) problems.push(`${rel} — what a desktop leaves in a folder must not ship`);
    if (PACKAGE_MANAGER_CONFIG.includes(name)) problems.push(`${rel} — package-manager configuration must not ship`);
    if (size >= MAX_FILE_BYTES) problems.push(`${rel} is ${size} bytes; every file must be under 5 MiB`);
  }
  return problems.map((problem) => `the plugin directory would refuse this tree: ${problem}`);
}

/**
 * The commit a provenance names: HEAD, suffixed `-dirty` when the working tree differs
 * from it — a clean SHA must reproduce the hashes, and a dirty one cannot. The owner's
 * push step refuses a `-dirty` provenance (next-steps); the gate accepts it, because a
 * developer's tree is dirty by definition.
 */
export function commitLabel(sha, porcelain) {
  return porcelain.trim() === '' ? sha : `${sha}-dirty`;
}

function currentCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    const porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' });
    return commitLabel(sha, porcelain);
  } catch {
    return 'unknown';
  }
}

/**
 * Write the tree. Returns the problems — empty when it was written; a missing input is
 * CANNOT RUN by name, never a silently smaller plugin.
 *
 * @param {string} [outDir]
 * @param {typeof SOURCES} [sources]
 * @param {{ skill?: Record<string, string>, commit?: string }} [options] a pre-built skill tree
 *   (tests) and the commit to record; both default to the real thing
 */
export async function buildPlugin(outDir = PLUGIN_OUT_DIR, sources = SOURCES, options = {}) {
  const problems = [];
  for (const [name, file] of Object.entries(sources)) {
    if (!existsSync(file)) problems.push(`missing ${name}: ${path.relative(REPO, file)} — build it first`);
  }
  if (problems.length > 0) return problems;
  // The skill renders BEFORE anything is written, so a skill that cannot ship leaves no tree —
  // and its refusal is a named problem, not a stack.
  let skill;
  try {
    skill = options.skill ?? (await buildSkillTree());
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const pluginDir = path.join(outDir, PLUGIN.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(outDir, '.claude-plugin'), { recursive: true });

  // The process: bundle and launcher, side by side — the launcher execs the bundle beside
  // itself, and the process finds the page (the skill's asset, below) relative to the bundle.
  cpSync(sources.bundle, path.join(pluginDir, BUNDLE_PATH));
  writeFileSync(
    path.join(pluginDir, LAUNCHER_PATH),
    launcherScript({ bundleBasename: path.basename(BUNDLE_PATH), roots: readInstallRoots(sources.installRoots) }),
    { mode: 0o755 },
  );

  // The skill, self-contained: SKILL.md + references, the kit page as an asset, the hand-in
  // script (and the one module it imports) as its scripts.
  const skillDir = path.join(pluginDir, SKILL_DIR);
  for (const [rel, text] of Object.entries(skill)) {
    mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true });
    writeFileSync(path.join(skillDir, rel), text);
  }
  mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
  mkdirSync(path.join(skillDir, 'scripts', 'lib'), { recursive: true });
  const pageFile = path.join(pluginDir, PAGE_PATH);
  cpSync(sources.kit, pageFile);
  // The pin (D8), hashed from the COPY — the bytes this tree ships — and in `shasum`'s own
  // spelling, so `shasum -a 256 -c` run in that folder checks it by hand.
  writeFileSync(path.join(pluginDir, PAGE_PIN_PATH), `${sha256(pageFile)}  ${path.basename(PAGE_PATH)}\n`);
  cpSync(sources.embed, path.join(skillDir, 'scripts', 'snug-embed.mjs'));
  cpSync(sources.pageBlocks, path.join(skillDir, 'scripts', 'lib', 'page-blocks.mjs'));

  writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), json(claudePluginManifest()));
  writeFileSync(path.join(pluginDir, '.mcp.json'), json(claudeMcpConfig()));
  // No `.codex-plugin/` here: its interim form carried an ABSOLUTE path to this machine's
  // launcher, and this tree is copied verbatim into the distribution repo. T9 adds the
  // published-package form (`codexMcpConfig()` in the manifests module) when it exists.
  writeFileSync(path.join(outDir, '.claude-plugin', 'marketplace.json'), json(marketplaceManifest()));
  cpSync(sources.license, path.join(pluginDir, 'LICENSE'));
  writeFileSync(path.join(pluginDir, 'README.md'), readme());
  // The upload archive (D3): the plugin folder as it now stands, and only it.
  writeFileSync(path.join(outDir, ARCHIVE_NAME), createZip(archiveEntries(pluginDir)));
  // Last, over everything above — at the MARKETPLACE root, so the root manifest is covered too.
  writeFileSync(path.join(outDir, 'PROVENANCE.json'), json(provenance(outDir, options.commit ?? currentCommit())));
  return [];
}

/** The size of the tree, for the log line. */
function treeBytes(dir) {
  return walk(dir).reduce((sum, rel) => sum + statSync(path.join(dir, rel)).size, 0);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await buildPlugin();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`build-plugin: ${problem}`);
    process.exit(1);
  }
  const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  console.log(
    `build-plugin: ok (${path.relative(REPO, PLUGIN_OUT_DIR)}: the plugin ${mib(treeBytes(path.join(PLUGIN_OUT_DIR, PLUGIN.name)))}, ` +
      `${ARCHIVE_NAME} ${mib(statSync(path.join(PLUGIN_OUT_DIR, ARCHIVE_NAME)).size)})`,
  );
}
