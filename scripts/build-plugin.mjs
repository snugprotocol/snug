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
// This does NOT publish anything. Pushing the tree to the distribution repo, cutting a
// release and registering an npm scope are owner acts (PROCESS.md).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { INSTALL_ROOTS_FILE, launcherScript, readInstallRoots } from './lib/plugin-launcher.mjs';
import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, LAUNCHER_PATH, MARKETPLACE, marketplaceManifest, PLUGIN } from './lib/plugin-manifests.mjs';
import { buildSkillTree, SKILL_NAME } from './lib/skill-build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_OUT_DIR = path.join(REPO, 'dist', 'plugin');

/** Where the skill lives inside the plugin; `assets/` and `scripts/` under it are the skill's own. */
export const SKILL_DIR = `skills/${SKILL_NAME}`;

export const SOURCES = {
  bundle: path.join(REPO, 'apps/host-mcp/dist/snug-mcp.mjs'),
  page: path.join(REPO, 'apps/host/dist-local/snug-host-local.html'),
  installRoots: INSTALL_ROOTS_FILE,
  // The artifact runner's kit and its hand-in script: the skill folder carries the artifact
  // route on its own, so the folder alone uploads to claude.ai and still works.
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
    'Snug file on this machine, runs in a sandboxed runner, and can think through your own Claude',
    'at runtime. You keep the app and everything it accumulates; nothing is uploaded.',
    '',
    '## What it needs',
    '',
    '- **Node.js 20 or newer** on this machine. The plugin starts a small local process (it serves',
    '  the runner page on `127.0.0.1` and nothing else). If no Node is found, the process says so',
    '  in one line and where to get it: https://nodejs.org',
    '- **Claude Code, logged in** (`claude` then `/login`), for your apps to think on your own',
    '  subscription. Without it the runner opens with its demo brain and the brain chip says how to',
    '  install Claude Code: https://code.claude.com/docs/en/quickstart',
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
    '- `scripts/snug-host-local.html` — the runner page it serves.',
    `- \`${SKILL_DIR}/\` — the skill: what a Snug app is, how to launch the runner, the authoring references.`,
    '- `PROVENANCE.json` — the monorepo commit this tree was built from, and every file’s sha256.',
    '',
    `Source: ${PLUGIN.repository} · ${PLUGIN.homepage} · ${PLUGIN.license}`,
    '',
  ].join('\n');
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The provenance document for a finished plugin dir: every file's sha256, the commit, the time. */
export function provenance(pluginDir, commit) {
  const files = {};
  for (const rel of walk(pluginDir)) {
    if (rel === 'PROVENANCE.json') continue;
    files[rel] = sha256(path.join(pluginDir, rel));
  }
  return { format: 'snug-plugin-provenance/1', commit, builtAt: new Date().toISOString(), files };
}

/** Which files a provenance document no longer describes (or describes wrongly). */
export function checkProvenance(pluginDir) {
  const file = path.join(pluginDir, 'PROVENANCE.json');
  if (!existsSync(file)) return ['PROVENANCE.json is missing'];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const problems = [];
  if (typeof doc.commit !== 'string' || doc.commit === '') problems.push('PROVENANCE.json names no commit');
  const listed = new Set(Object.keys(doc.files ?? {}));
  for (const rel of walk(pluginDir)) {
    if (rel === 'PROVENANCE.json') continue;
    if (!listed.has(rel)) problems.push(`PROVENANCE.json does not list ${rel}`);
    else if (doc.files[rel] !== sha256(path.join(pluginDir, rel))) problems.push(`PROVENANCE.json's hash for ${rel} does not match the file`);
    listed.delete(rel);
  }
  for (const rel of listed) problems.push(`PROVENANCE.json lists ${rel}, which is not in the tree`);
  return problems;
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
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

  // The process: bundle, page and launcher, side by side — the process reads the page
  // relative to its own location, and the launcher execs the bundle beside itself.
  cpSync(sources.bundle, path.join(pluginDir, BUNDLE_PATH));
  cpSync(sources.page, path.join(pluginDir, 'scripts', 'snug-host-local.html'));
  writeFileSync(
    path.join(pluginDir, LAUNCHER_PATH),
    launcherScript({ bundleBasename: path.basename(BUNDLE_PATH), roots: readInstallRoots(sources.installRoots) }),
    { mode: 0o755 },
  );

  // The skill, self-contained: SKILL.md + references, the artifact kit as an asset, the
  // hand-in script (and the one module it imports) as its scripts.
  const skillDir = path.join(pluginDir, SKILL_DIR);
  for (const [rel, text] of Object.entries(skill)) {
    mkdirSync(path.dirname(path.join(skillDir, rel)), { recursive: true });
    writeFileSync(path.join(skillDir, rel), text);
  }
  mkdirSync(path.join(skillDir, 'assets'), { recursive: true });
  mkdirSync(path.join(skillDir, 'scripts', 'lib'), { recursive: true });
  cpSync(sources.kit, path.join(skillDir, 'assets', 'snug-host.html'));
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
  // Last, over everything above.
  writeFileSync(path.join(pluginDir, 'PROVENANCE.json'), json(provenance(pluginDir, options.commit ?? currentCommit())));
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
  console.log(`build-plugin: ok (${path.relative(REPO, PLUGIN_OUT_DIR)}, ${(treeBytes(PLUGIN_OUT_DIR) / 1024 / 1024).toFixed(1)} MiB)`);
}
