#!/usr/bin/env node
// The gate for the local host process and the plugin it ships in (ADR-0068, ADR-0069 §7).
//
// What it refuses, each a defect that would otherwise ship quietly:
//   1. a release bundle carrying a TEST HOOK (the desktop's `gate:release` transposed);
//   2. an `instructions` string that has drifted from its one source (D-B12);
//   3. a plugin tree whose manifests were not written from the constants module, whose
//      launcher is missing, whose SKILL.md is not the fresh render of its sources, whose
//      provenance does not describe its files, or which ships a hook;
//   4. a tree the two external validators refuse — `claude plugin validate --strict` and
//      `agentskills validate` — when they are on this machine; when they are not, the gate
//      says NOT VERIFIED by name rather than passing in silence.
//
// The tree is BUILT here, on every run, from the built inputs (`turbo build` first): nothing
// generated is committed, so the gate is what proves the sources still assemble.
//
// Dependency-free node builtins, like every other gate under `scripts/`.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlugin, checkProvenance, PLUGIN_OUT_DIR, SKILL_DIR } from './build-plugin.mjs';
import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, LAUNCHER_PATH, marketplaceManifest, PLUGIN } from './lib/plugin-manifests.mjs';
import { buildSkillTree } from './lib/skill-build.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUNDLE_FILE = path.join(REPO, 'apps/host-mcp/dist/snug-mcp.mjs');
export const INSTRUCTIONS_FILE = path.join(REPO, 'apps/host-mcp/src/instructions.md');
export const PLUGIN_DIR = PLUGIN_OUT_DIR;

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
 * This gate caught #3 the moment it was written, which is the review working. The binary
 * resolver (ADR-0069 §6) reads HOME and PATH by NAME and adds none.
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

/**
 * The tree is what the constants module, the launcher generator, the skill build and the
 * provenance say it is — not what someone typed.
 *
 * @param {string} dir the marketplace dir (the plugin is at `<dir>/snug`)
 * @param {{ skill?: Record<string, string> }} [options] a pre-rendered skill tree (tests);
 *   by default the skill is re-rendered from its sources and compared byte for byte
 */
export async function checkPluginTree(dir, options = {}) {
  const problems = [];
  const pluginDir = path.join(dir, PLUGIN.name);
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
  const manifest = read('snug/.claude-plugin/plugin.json');
  same('snug/.claude-plugin/plugin.json', manifest, claudePluginManifest());
  same('snug/.mcp.json', read('snug/.mcp.json'), claudeMcpConfig());
  same('.claude-plugin/marketplace.json', read('.claude-plugin/marketplace.json'), marketplaceManifest());
  if (!existsSync(path.join(pluginDir, BUNDLE_PATH))) problems.push(`the plugin tree is missing ${BUNDLE_PATH}`);
  if (!existsSync(path.join(pluginDir, LAUNCHER_PATH))) problems.push(`the plugin tree is missing the launcher ${LAUNCHER_PATH} (AC3)`);
  if (!existsSync(path.join(pluginDir, 'scripts/snug-host-local.html'))) problems.push('the plugin tree is missing the runner page');

  // The skill: byte-identical to a fresh render of its sources (AC1), self-contained (assets +
  // scripts), every reference present.
  const skill = options.skill ?? (await buildSkillTree());
  const skillDir = path.join(pluginDir, SKILL_DIR);
  for (const [rel, expected] of Object.entries(skill)) {
    const file = path.join(skillDir, rel);
    if (!existsSync(file)) problems.push(`the skill is missing ${rel}`);
    else if (readFileSync(file, 'utf8') !== expected) problems.push(`${SKILL_DIR}/${rel} differs from a fresh render of its sources — rebuild the plugin, never edit the tree`);
  }
  for (const rel of ['assets/snug-host.html', 'scripts/snug-embed.mjs', 'scripts/lib/page-blocks.mjs']) {
    if (!existsSync(path.join(skillDir, rel))) problems.push(`the skill is missing ${rel} — the artifact route needs it`);
  }

  // What a reviewer reads, and what the plugin must not ship.
  if (!existsSync(path.join(pluginDir, 'LICENSE'))) problems.push('the plugin tree is missing LICENSE');
  const readmeFile = path.join(pluginDir, 'README.md');
  if (!existsSync(readmeFile)) problems.push('the plugin tree is missing README.md');
  else {
    const text = readFileSync(readmeFile, 'utf8');
    if (!/Node\.js 20/.test(text) || !/Claude Code/.test(text)) problems.push('README.md does not name both prerequisites (Node.js 20, Claude Code)');
  }
  if (existsSync(path.join(pluginDir, 'hooks'))) problems.push('the plugin ships a hooks/ directory — it must ship no hooks (ADR-0069)');
  if (manifest !== undefined && 'hooks' in manifest) problems.push('plugin.json declares hooks — it must ship no hooks (ADR-0069)');

  if (existsSync(pluginDir)) problems.push(...checkProvenance(pluginDir));
  return problems;
}

/**
 * The two external validators, when the machine has them. Absent is NOT VERIFIED, by name:
 * CI's runner has neither, and a gate that passed there in silence would vouch for nothing.
 *
 * @returns {{ name: string, status: 'ok' | 'failed' | 'not verified', detail: string }[]}
 */
export function runValidators(dir, exec = execFileSync) {
  const run = (name, command, args) => {
    try {
      const out = exec(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
      return { name, status: 'ok', detail: String(out).trim().split('\n').pop() ?? '' };
    } catch (error) {
      if (error?.code === 'ENOENT') return { name, status: 'not verified', detail: `${command} is not on this machine` };
      const detail = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim();
      return { name, status: 'failed', detail };
    }
  };
  return [
    run('claude plugin validate --strict (marketplace)', 'claude', ['plugin', 'validate', '--strict', dir]),
    run('claude plugin validate --strict (plugin)', 'claude', ['plugin', 'validate', '--strict', path.join(dir, PLUGIN.name)]),
    run('agentskills validate (skill)', 'uvx', ['--from', 'skills-ref', 'agentskills', 'validate', path.join(dir, PLUGIN.name, SKILL_DIR)]),
  ];
}

async function main() {
  const problems = [];
  if (!existsSync(BUNDLE_FILE)) {
    console.error('check-host-mcp: CANNOT RUN — apps/host-mcp/dist/snug-mcp.mjs is missing (pnpm --filter host-mcp build)');
    process.exit(1);
  }
  const source = readFileSync(BUNDLE_FILE, 'utf8');
  problems.push(...checkBundle(source));
  problems.push(...checkInstructions(source, readFileSync(INSTRUCTIONS_FILE, 'utf8')));

  // The tree is built HERE, every run: a missing input is CANNOT RUN by name.
  const buildProblems = await buildPlugin();
  if (buildProblems.length > 0) {
    for (const problem of buildProblems) console.error(`check-host-mcp: CANNOT RUN — ${problem}`);
    process.exit(1);
  }
  problems.push(...(await checkPluginTree(PLUGIN_DIR)));

  const validators = runValidators(PLUGIN_DIR);
  for (const v of validators) {
    if (v.status === 'failed') problems.push(`${v.name} refused the tree:\n${v.detail}`);
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`check-host-mcp: ${problem}`);
    process.exit(1);
  }
  const notVerified = validators.filter((v) => v.status === 'not verified');
  console.log(`check-host-mcp: ok (${source.length} bytes; plugin tree built and checked; validators: ${validators.map((v) => `${v.name} ${v.status}`).join(', ')})`);
  for (const v of notVerified) console.log(`check-host-mcp: NOT VERIFIED — ${v.name}: ${v.detail}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
