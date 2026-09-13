#!/usr/bin/env node
// The gate for the local host process (ADR-0068).
//
// Three things it refuses, each a defect that would otherwise ship quietly:
//   1. a release bundle carrying a TEST HOOK (the desktop's `gate:release` transposed);
//   2. an `instructions` string that has drifted from its one source (D-B12);
//   3. a plugin tree whose manifests were not written from the constants module.
//
// Dependency-free node builtins, like every other gate under `scripts/`.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, marketplaceManifest } from './lib/plugin-manifests.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_FILE = path.join(REPO, 'apps/host-mcp/dist/snug-mcp.mjs');
export const INSTRUCTIONS_FILE = path.join(REPO, 'apps/host-mcp/src/instructions.md');
export const PLUGIN_DIR = path.join(REPO, 'dist/plugin');

/**
 * Names that must never appear in a RELEASE bundle. The test-hook build reads the env var
 * and injects a resolver; the release build passes neither, and this is what proves it
 * rather than a comment claiming it.
 */
export const FORBIDDEN_IN_RELEASE = ['SNUG_MCP_TEST_RESOLVE', 'SNUG_MCP_TEST_HOLDER', 'SNUG_MCP_TEST_BRAIN'];

/** Every env var the process may read. Anything else is a hook or a surprise. */
export const ALLOWED_ENV_READS = ['HOME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SNUG_HOME', 'NODE_EXTRA_CA_CERTS'];

/**
 * How many times the release bundle may read the WHOLE environment object rather than a
 * named variable (D-B34).
 *
 * The name sweep below can only see `process.env.X`, and the release bundle contains no such
 * literal: both readers hand the entire object to a function that decides — `resolveHome`
 * (which env names a home) and `childEnvFor` (which builds the child's env by ALLOWLIST).
 * That is the right design in both cases, and it is exactly why the name sweep alone proved
 * nothing. Counting the whole-object reads and pinning the count is what keeps a further one
 * from arriving unreviewed: adding a reader is fine, but it must be a deliberate edit here
 * with a reason, not a silent pass.
 *
 * The declared three (raise this ONLY with a reason, and only after checking the new reader
 * cannot leak the parent's environment to a child):
 *   1. `resolveHome`            — reads which env names a home (D-B34).
 *   2. `createClaudeBrain`      — `childEnvFor(process.env)`, the child env by ALLOWLIST.
 *   3. `probeBrain`             — the same allowlist, for the boot readiness probe (D-B35).
 * This gate caught #3 the moment it was written, which is the review working.
 */
export const ALLOWED_WHOLE_ENV_READS = 3;

export function checkBundle(source) {
  const problems = [];
  for (const name of FORBIDDEN_IN_RELEASE) {
    if (source.includes(name)) problems.push(`the release bundle names ${name} — a test hook must not ship`);
  }
  // Every `process.env.X` / `process.env['X']` the bundle actually reads.
  const read = new Set();
  for (const match of source.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[["']([A-Z_][A-Z0-9_]*)["']\])/g)) {
    read.add(match[1] ?? match[2]);
  }
  for (const name of read) {
    if (!ALLOWED_ENV_READS.includes(name)) problems.push(`the bundle reads an unexpected environment variable: ${name}`);
  }
  // Whole-object reads: `process.env` NOT followed by a `.NAME` or `['NAME']` access. These
  // are invisible to the sweep above, so they are counted rather than named.
  const whole = source.match(/process\.env(?!\s*(?:\.[A-Za-z_$]|\[["'`]))/g)?.length ?? 0;
  if (whole > ALLOWED_WHOLE_ENV_READS) {
    problems.push(
      `the bundle reads the whole environment ${whole} times, but only ${ALLOWED_WHOLE_ENV_READS} are declared ` +
        '(resolveHome, childEnvFor, probeBrain) — a new whole-env reader must be reviewed and the count raised deliberately',
    );
  }
  if (!source.includes('snug_status')) problems.push('the bundle does not carry the tool surface — did the entry change?');
  return problems;
}

/** D-B12: the shipped instructions are byte-identical to their one source. */
export function checkInstructions(source, instructions) {
  // The bundle inlines the file, so its exact bytes must be findable in the output.
  return source.includes(JSON.stringify(instructions).slice(1, -1)) ? [] : ['the bundled instructions text differs from apps/host-mcp/src/instructions.md'];
}

/** The manifests are what the constants module says, not what someone typed. */
export function checkPluginTree(dir) {
  const problems = [];
  const read = (rel) => {
    const file = path.join(dir, rel);
    if (!existsSync(file)) {
      problems.push(`the plugin tree is missing ${rel}`);
      return undefined;
    }
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  const same = (rel, actual, expected) => {
    if (actual !== undefined && JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${rel} was not written from scripts/lib/plugin-manifests.mjs`);
    }
  };
  same('snug/.claude-plugin/plugin.json', read('snug/.claude-plugin/plugin.json'), claudePluginManifest());
  same('snug/.mcp.json', read('snug/.mcp.json'), claudeMcpConfig());
  same('.claude-plugin/marketplace.json', read('.claude-plugin/marketplace.json'), marketplaceManifest());
  if (!existsSync(path.join(dir, 'snug', BUNDLE_PATH))) problems.push(`the plugin tree is missing ${BUNDLE_PATH}`);
  if (!existsSync(path.join(dir, 'snug/scripts/snug-host-local.html'))) problems.push('the plugin tree is missing the runner page');
  return problems;
}

function main() {
  const problems = [];
  if (!existsSync(BUNDLE_FILE)) {
    console.error('check-host-mcp: CANNOT RUN — apps/host-mcp/dist/snug-mcp.mjs is missing (pnpm --filter host-mcp build)');
    process.exit(1);
  }
  const source = readFileSync(BUNDLE_FILE, 'utf8');
  problems.push(...checkBundle(source));
  problems.push(...checkInstructions(source, readFileSync(INSTRUCTIONS_FILE, 'utf8')));
  // The plugin tree is optional: it is assembled on demand, and its absence is not a defect.
  if (existsSync(PLUGIN_DIR)) problems.push(...checkPluginTree(PLUGIN_DIR));

  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-host-mcp: ${problem}`);
    process.exit(1);
  }
  console.log(`check-host-mcp: ok (${source.length} bytes, ${existsSync(PLUGIN_DIR) ? 'plugin tree checked' : 'no plugin tree'})`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
