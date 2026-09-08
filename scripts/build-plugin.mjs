#!/usr/bin/env node
// Assemble the installable plugin tree (ADR-0068 §8).
//
// Output: `dist/plugin/` — a marketplace of one plus the plugin itself, which is what
// `claude plugin marketplace add` takes. Every manifest field comes from
// `lib/plugin-manifests.mjs`; nothing here hand-writes one.
//
// This does NOT publish anything. Pushing the tree to the distribution repo, cutting a
// release and registering an npm scope are owner acts (PROCESS.md).

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, codexMcpConfig, codexPluginManifest, marketplaceManifest, PLUGIN } from './lib/plugin-manifests.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_OUT_DIR = path.join(REPO, 'dist', 'plugin');

const SOURCES = {
  bundle: path.join(REPO, 'apps/host-mcp/dist/snug-mcp.mjs'),
  page: path.join(REPO, 'apps/host/dist-local/snug-host-local.html'),
};

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** @returns {string[]} problems — empty when the tree was written. */
export function buildPlugin(outDir = PLUGIN_OUT_DIR, sources = SOURCES) {
  const problems = [];
  for (const [name, file] of Object.entries(sources)) {
    // A missing input is CANNOT RUN by name, never a silently smaller plugin.
    if (!existsSync(file)) problems.push(`missing ${name}: ${path.relative(REPO, file)} — build it first`);
  }
  if (problems.length > 0) return problems;

  const pluginDir = path.join(outDir, PLUGIN.name);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(pluginDir, 'scripts'), { recursive: true });
  mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
  mkdirSync(path.join(outDir, '.claude-plugin'), { recursive: true });

  cpSync(sources.bundle, path.join(pluginDir, BUNDLE_PATH));
  // The page ships BESIDE the bundle: the process reads it relative to its own location,
  // so the pair moves together or not at all.
  cpSync(sources.page, path.join(pluginDir, 'scripts', 'snug-host-local.html'));

  writeFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), json(claudePluginManifest()));
  writeFileSync(path.join(pluginDir, '.mcp.json'), json(claudeMcpConfig()));
  writeFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), json(codexPluginManifest()));
  writeFileSync(
    path.join(pluginDir, '.codex-plugin', '.mcp.json'),
    json(codexMcpConfig({ absolutePath: path.join(pluginDir, BUNDLE_PATH) })),
  );
  writeFileSync(path.join(outDir, '.claude-plugin', 'marketplace.json'), json(marketplaceManifest()));
  writeFileSync(
    path.join(pluginDir, 'README.md'),
    [
      '# Snug',
      '',
      PLUGIN.description,
      '',
      'Install this directory as a local marketplace:',
      '',
      '```',
      `claude plugin marketplace add ${path.relative(process.cwd(), outDir) || '.'}`,
      'claude plugin install snug@snug-local',
      '```',
      '',
      'Then start a new session and ask your agent to open Snug.',
      '',
      '> Rebuilding does NOT update an installed plugin: the install is a copy under a',
      '> version directory, and neither `install` nor `update` refreshes it. Uninstall,',
      '> rebuild, install again.',
      '',
    ].join('\n'),
  );
  return [];
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = buildPlugin();
  if (problems.length > 0) {
    for (const problem of problems) console.error(`build-plugin: ${problem}`);
    process.exit(1);
  }
  console.log(`build-plugin: ok (${path.relative(REPO, PLUGIN_OUT_DIR)})`);
}
