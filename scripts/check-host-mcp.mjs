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
//      says NOT VERIFIED by name rather than passing in silence;
//   5. a tree that does not START (D1). The four rules above read files; none of them ran
//      one, and that is how a plugin whose second window could never attach to its own
//      runner was "marketplace-ready" (found 2026-10-03). The launch legs start the launcher
//      the tree ships, speak to it as a host does, start a second one beside it — and ask
//      the first for `/`, which must be the page the tree ships (K1: the plugin carries the
//      page ONCE, as the skill's asset, and the process finds it relative to its bundle; a
//      page it cannot find is served as a placeholder with HTTP 200);
//   6. a tree whose page is not PINNED (D8): no sha256 beside the page, one that names
//      another page — or a pin the process does not honour, which only starting a copy of
//      the tree with one byte of its page changed can show;
//   7. a tree the plugin directory would refuse to install (D2 — `checkDirectoryRules`);
//   8. an upload archive, `snug.zip`, that is not the plugin folder — whole, byte for byte,
//      launcher still runnable, and nothing else (D3).
//
// And one thing it PRINTS and does not refuse: the release bundle's size against the
// directory's 256 KiB reviewer-hold line, so growth is seen in review.
//
// The tree is BUILT here, on every run, from the built inputs (`turbo build` first): nothing
// generated is committed, so the gate is what proves the sources still assemble.
//
// Dependency-free node builtins, like every other gate under `scripts/`.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARCHIVE_NAME,
  archiveEntries,
  buildPlugin,
  checkDirectoryRules,
  checkProvenance,
  PAGE_PATH,
  PAGE_PIN_PATH,
  PLUGIN_OUT_DIR,
  SKILL_DIR,
  SOURCES,
} from './build-plugin.mjs';
import { BUNDLE_PATH, claudeMcpConfig, claudePluginManifest, LAUNCHER_PATH, marketplaceManifest, PLUGIN, SH } from './lib/plugin-manifests.mjs';
import { buildSkillTree, INSTRUCTIONS_SOURCE } from './lib/skill-build.mjs';
import { readZip } from './lib/zip.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// One path per artifact: the bundle is the builder's input, the instructions the skill's source.
export const BUNDLE_FILE = SOURCES.bundle;
export const INSTRUCTIONS_FILE = INSTRUCTIONS_SOURCE;
export const PLUGIN_DIR = PLUGIN_OUT_DIR;

/**
 * What must never appear in a RELEASE bundle: the PREFIX every test hook's env name shares
 * (K5). The test build reads those variables and injects a resolver, a holder, a brain, a
 * port list; the release build passes none of them, and this is what proves it rather than
 * a comment claiming it.
 *
 * A prefix, not a list. The list named three hooks while the test entry had grown five —
 * a list is only as current as the last person to remember it. A test pins that every name
 * the test entry declares carries this prefix.
 */
export const FORBIDDEN_PREFIX_IN_RELEASE = 'SNUG_MCP_TEST_';

/** Every env var the process may read. Anything else is a hook or a surprise. */
export const ALLOWED_ENV_READS = ['HOME', 'PATH', 'SHELL', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM', 'SNUG_HOME', 'NODE_EXTRA_CA_CERTS'];

/**
 * How many times the release bundle may read the WHOLE environment object rather than a
 * named variable (D-B34): once.
 *
 * The name sweep below can only see `process.env.X`. A reader that hands the entire object
 * to a function that decides — which variable names a home, which variables an agent's
 * child may inherit — is invisible to it, and that is the shape every reader of consequence
 * has. So the whole-object reads are counted, and the count is pinned.
 *
 * WHERE THE ONE READ LIVES: the brain registry (`apps/host-mcp/src/brains/registry.ts`). It
 * takes the environment once and hands it to every driver, each of which builds its child's
 * environment from it by ALLOWLIST (ADR-0071 §3); whatever else needs the environment is
 * handed that same object or reads a variable by name. Before the registry there were three
 * — `resolveHome`, `createClaudeBrain`, `probeBrain` — each taking the parent environment
 * for itself, and this gate caught the third the day it was written.
 *
 * WHY A SECOND IS A FINDING, not a number to raise: with one reader there is one place to
 * review for "can the parent's environment reach a child?" (C1 — no API-key variable may).
 * A second read means some module reached past the registry for the environment on its own
 * — a driver spawning with what it found, a home resolved from an object nobody passed. The
 * remedy is to hand that module the registry's object, never to edit this constant.
 */
export const ALLOWED_WHOLE_ENV_READS = 1;

/**
 * The plugin directory's reviewer-hold line for a plugin's server bundle (the task's reading
 * of the plugin docs, 2026-10-03): past it a submission waits for a person. It is not an
 * install-blocking rule, so the gate PRINTS where the bundle stands and never fails on it —
 * growth is then a number in a review instead of a surprise at submission. (The bundle was
 * already over when this was written: 286,953 bytes.)
 */
export const REVIEWER_HOLD_BYTES = 256 * 1024;

export function bundleSizeLine(bytes) {
  const count = (n) => n.toLocaleString('en-US');
  const where = bytes > REVIEWER_HOLD_BYTES ? `${count(bytes - REVIEWER_HOLD_BYTES)} OVER` : `${count(REVIEWER_HOLD_BYTES - bytes)} under`;
  return (
    `the release bundle is ${count(bytes)} bytes — ${where} ` +
    `the plugin directory’s 256 KiB reviewer-hold line (${count(REVIEWER_HOLD_BYTES)})`
  );
}

/** The Agent Skills reference validator the gate runs, pinned (supply chain at gate time). */
export const SKILLS_REF_VERSION = '0.1.1';

export function checkBundle(source) {
  const problems = [];
  // The raw bytes, not `process.env.X` accesses: the test entry reads its hooks through
  // constants, so in a bundle the name may exist only as a string.
  const hooks = new Set(source.match(new RegExp(`${FORBIDDEN_PREFIX_IN_RELEASE}\\w*`, 'g')) ?? []);
  for (const name of hooks) problems.push(`the release bundle names ${name} — a test hook must not ship`);
  // Every `process.env.X` / `process.env['X']` the bundle actually reads.
  const read = new Set();
  for (const match of source.matchAll(/process\.env(?:\.([A-Za-z_$][\w$]*)|\[["']([A-Za-z_$][\w$]*)["']\])/g)) {
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
      `the bundle reads the whole environment ${whole} times, but ONE read is declared — the brain registry’s ` +
        '(apps/host-mcp/src/brains/registry.ts). Hand the new reader the registry’s environment, or read a variable by name',
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
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      problems.push(`${rel} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
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
  // The runner page is the skill's asset — the ONE copy (ADR-0072 §1). A page beside the
  // bundle is the second copy the plugin used to ship: the process would not read it.
  if (!existsSync(path.join(pluginDir, PAGE_PATH))) problems.push(`the plugin tree is missing the runner page (${PAGE_PATH})`);
  const besideBundle = path.join(pluginDir, path.dirname(BUNDLE_PATH));
  if (existsSync(besideBundle)) {
    for (const name of readdirSync(besideBundle).filter((entry) => entry.endsWith('.html'))) {
      problems.push(`the plugin tree carries a second copy of the page (${path.dirname(BUNDLE_PATH)}/${name}) — it ships once, as ${PAGE_PATH}`);
    }
  }

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

  // D8: the pin beside the page names THIS page. The provenance cannot stand in for this —
  // it hashes whatever the build wrote, so a build that wrote no pin, or pinned another
  // file, describes its own tree perfectly. Read as the process reads it: the first token.
  const pageFile = path.join(pluginDir, PAGE_PATH);
  const pinFile = path.join(pluginDir, PAGE_PIN_PATH);
  if (!existsSync(pinFile)) {
    problems.push(`the plugin tree is missing the page’s pin (${PAGE_PIN_PATH}) — without it an installed plugin serves whatever page it finds`);
  } else if (existsSync(pageFile)) {
    const pinned = readFileSync(pinFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    if (pinned !== createHash('sha256').update(readFileSync(pageFile)).digest('hex')) {
      problems.push(`the pin (${PAGE_PIN_PATH}) does not name the sha256 of the page beside it — the process would refuse to lead (page-damaged)`);
    }
  }

  // What a reviewer reads, what the plugin must not ship, and what the directory will not
  // install (D2 — a missing README or LICENSE is one of its rules).
  const readmeFile = path.join(pluginDir, 'README.md');
  if (existsSync(readmeFile)) {
    const text = readFileSync(readmeFile, 'utf8');
    if (!/Node\.js 20/.test(text) || !/Claude Code/.test(text)) problems.push('README.md does not name both prerequisites (Node.js 20, Claude Code)');
  }
  if (existsSync(path.join(pluginDir, 'hooks'))) problems.push('the plugin ships a hooks/ directory — it must ship no hooks (ADR-0069)');
  if (manifest !== undefined && 'hooks' in manifest) problems.push('plugin.json declares hooks — it must ship no hooks (ADR-0069)');
  // (Both walk the plugin folder: with no folder, everything above has already said so.)
  if (existsSync(pluginDir)) problems.push(...checkDirectoryRules(pluginDir), ...checkArchive(dir));

  if (existsSync(dir)) problems.push(...checkProvenance(dir));
  return problems;
}

/**
 * The upload archive against the tree it was made from (D3): read back (which verifies
 * every entry's CRC), it must hold the plugin folder as its ONE top-level entry and, under
 * it, exactly the tree's files — the same bytes, the same runnable bit. The provenance
 * vouches for the archive's own hash; only this says what is IN it.
 *
 * @param {string} dir the marketplace dir (the archive is `<dir>/snug.zip`, the plugin `<dir>/snug`)
 */
export function checkArchive(dir) {
  const file = path.join(dir, ARCHIVE_NAME);
  if (!existsSync(file)) return [`the upload archive ${ARCHIVE_NAME} is missing`];
  let entries;
  try {
    entries = readZip(readFileSync(file));
  } catch (error) {
    return [`${ARCHIVE_NAME} does not read back: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems = [];
  const top = [...new Set(entries.map((entry) => entry.name.split('/')[0]))];
  if (top.length !== 1 || top[0] !== PLUGIN.name) {
    problems.push(`${ARCHIVE_NAME} must hold ONE top-level entry, ${PLUGIN.name}/ — what "Upload plugin" takes — and it holds: ${top.join(', ') || 'nothing'}`);
  }
  const archived = new Map(entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => [entry.name, entry]));
  for (const expected of archiveEntries(path.join(dir, PLUGIN.name))) {
    const entry = archived.get(expected.name);
    if (entry === undefined) {
      problems.push(`${ARCHIVE_NAME} is missing ${expected.name}`);
      continue;
    }
    archived.delete(expected.name);
    const mode = entry.mode & 0o777;
    if (!entry.data.equals(expected.data)) problems.push(`${ARCHIVE_NAME}: ${expected.name} is not the tree’s file, byte for byte`);
    else if (mode !== expected.mode) problems.push(`${ARCHIVE_NAME}: ${expected.name} has mode ${mode.toString(8)} where the tree’s file is ${expected.mode.toString(8)}`);
  }
  for (const name of archived.keys()) problems.push(`${ARCHIVE_NAME} carries ${name}, which is not in the tree`);
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
      // A validator that cannot START vouches for nothing either way (measured 2026-10-04: an
      // interrupted install left a non-executable `claude` stub on PATH, read as a refusal
      // with no words). Only a validator that RAN and said no is a refusal.
      if (error?.code === 'EACCES' || error?.code === 'ENOEXEC') {
        return { name, status: 'not verified', detail: `${command} is on this machine but cannot run (${error.code}) — repair or reinstall it` };
      }
      const detail = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}`.trim();
      return { name, status: 'failed', detail };
    }
  };
  return [
    run('claude plugin validate --strict (marketplace)', 'claude', ['plugin', 'validate', '--strict', dir]),
    run('claude plugin validate --strict (plugin)', 'claude', ['plugin', 'validate', '--strict', path.join(dir, PLUGIN.name)]),
    // Pinned: the gate must not execute whatever PyPI serves today.
    run('agentskills validate (skill)', 'uvx', ['--from', `skills-ref==${SKILLS_REF_VERSION}`, 'agentskills', 'validate', path.join(dir, PLUGIN.name, SKILL_DIR)]),
  ];
}

// ------------------------------------------------------------------- the launch legs (D1)

/**
 * THE ISOLATION CONTRACT. The environment a leg's process gets — these three variables and
 * nothing else (the `env -i` of the contract: `spawn` with an explicit `env` inherits none
 * of ours). The release bundle is the ONE build allowed to resolve the user's real
 * `~/Snug`, so a gate that started it with the developer's environment would be one unset
 * variable away from a second writer on the owner's file (lessons 2026-09-07/08). With this
 * environment there is no real home for it to find.
 */
export function isolationEnv(tmp) {
  return { HOME: tmp, SNUG_HOME: path.join(tmp, 'Snug'), PATH: path.dirname(process.execPath) };
}

/**
 * Start the launcher as a host does (`/bin/sh <launcher>`, cwd `/`) and speak JSON-RPC lines
 * to it. Exported for the desktop-host walk (`walk-desktop-host.mjs`), which starts the same
 * launcher the same way under an environment of its own: one client, so the walk and the
 * gate cannot come to speak to the process differently.
 */
export function startLauncher(launcher, env, requestTimeoutMs) {
  const child = spawn(SH, [launcher], { cwd: '/', env, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let out = '';
  let err = '';
  let exited = false;
  child.on('exit', () => (exited = true));
  // A launcher that cannot even be spawned, or a pipe to one that has gone: the request
  // that follows times out and names what it saw, so neither may throw here.
  child.on('error', (error) => (err += String(error)));
  child.stdin.on('error', () => {});
  child.stderr.on('data', (chunk) => (err += chunk.toString('utf8')));
  child.stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
    for (let newline = out.indexOf('\n'); newline !== -1; newline = out.indexOf('\n')) {
      const line = out.slice(0, newline);
      out = out.slice(newline + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });

  let nextId = 1;
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`${method} was not answered within ${requestTimeoutMs} ms${err.trim() === '' ? '' : ` (stderr: ${err.trim().slice(0, 300)})`}`));
      }, requestTimeoutMs);
      waiting.set(id, (message) => {
        clearTimeout(timer);
        if (message.error !== undefined) reject(new Error(`${method} answered an error: ${message.error.message}`));
        else resolve(message.result);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  return {
    child,
    request,
    initialize: () => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check-host-mcp', version: '0' } }),
    status: async () => JSON.parse((await request('tools/call', { name: 'snug_status', arguments: {} })).content[0].text),
    /** End the session as a host does, ask it to go, and after the bound make it go. Only ever this leg's own child. */
    reap: (reapMs) =>
      new Promise((resolve) => {
        if (exited || child.pid === undefined) return resolve();
        const kill = setTimeout(() => child.kill('SIGKILL'), reapMs);
        child.once('exit', () => {
          clearTimeout(kill);
          resolve();
        });
        child.stdin.end();
        child.kill('SIGTERM');
      }),
  };
}

const under = (file, dir) => typeof file === 'string' && file.startsWith(`${dir}${path.sep}`);

/** Is this status from the process the leg started, on the home the leg gave it? */
const ownedBy = (status, session, tmp) => under(status.home, tmp) && under(status.file, tmp) && status.pid === session.child.pid;

/** What a started process serves at `/`, against the page the tree ships. Empty when they are the same bytes. */
async function servedPageProblems(port, pageFile, timeoutMs) {
  const shipped = readFileSync(pageFile, 'utf8');
  let served;
  try {
    // The open document: no bearer, and so no page contact — nothing here starts a brain probe.
    served = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })).text();
  } catch (error) {
    return [`positive leg: the process does not serve the page the tree ships — nothing answered at http://127.0.0.1:${port}/ (${error instanceof Error ? error.message : String(error)})`];
  }
  if (served === shipped) return [];
  return [
    `positive leg: the process does not serve the page the tree ships (${path.basename(pageFile)}, ${shipped.length} chars) — it answered ${served.length} chars: ` +
      `${JSON.stringify(served.slice(0, 120))}. The process finds the page relative to its bundle (apps/host-mcp/src/page.ts).`,
  ];
}

/**
 * Start what the tree ships, twice over (D1). No leg spawns a CLI: the brain probe is lazy
 * and nothing here ever makes the page contact that would start it.
 *
 *   positive  the isolation environment → `initialize`, `tools/list`, `snug_status`; then a
 *             SECOND process against the same home, which must attach to the first.
 *   negative  neither HOME nor SNUG_HOME → `initialize` STILL succeeds, and `snug_status`
 *             is the `home-unresolved` refusal.
 *
 * @param {string} launcher the POSIX launcher inside the built tree (`<tree>/snug/scripts/snug`)
 * @param {{ requestTimeoutMs?: number, reapMs?: number, page?: string }} [options] the bounds
 *   (tests shorten them), and the page file the tree ships — when given, the positive leg
 *   requires the started process to serve exactly those bytes at `/`
 * @returns {Promise<string[]>} the problems; empty when both legs passed
 */
export async function runLaunchLegs(launcher, options = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const reapMs = options.reapMs ?? 8_000;
  const problems = [];
  const started = [];
  const start = (env) => {
    const session = startLauncher(launcher, env, requestTimeoutMs);
    started.push(session);
    return session;
  };

  const tmp = mkdtempSync(path.join(tmpdir(), 'snug-gate-'));
  try {
    const env = isolationEnv(tmp);
    const first = start(env);
    await first.initialize();
    const { tools } = await first.request('tools/list');
    if (!tools.some((tool) => tool.name === 'snug_status')) problems.push('positive leg: tools/list does not carry snug_status');
    const status = await first.status();

    // THE FIRST ASSERTION, before anything in the answer is believed or a second process is
    // started: this is the process the leg spawned, on the home the leg gave it. Anything
    // else means the leg is talking to — or about to share a lock with — a Snug it does
    // not own, and it stops here.
    if (!ownedBy(status, first, tmp)) {
      problems.push(
        `positive leg: ISOLATION — the status names home ${JSON.stringify(status.home)}, file ${JSON.stringify(status.file)} and pid ${JSON.stringify(status.pid)}, ` +
          `but this leg started pid ${first.child.pid} under ${tmp}. The leg was aborted before starting a second process.`,
      );
    } else {
      if (status.running !== true) problems.push(`positive leg: the first process is not running: ${JSON.stringify(status.refusal ?? status)}`);
      else if (options.page !== undefined) problems.push(...(await servedPageProblems(status.port, options.page, requestTimeoutMs)));
      const second = start(env);
      await second.initialize();
      const joined = await second.status();
      if (joined.attached !== true || joined.pid !== first.child.pid) {
        problems.push(`positive leg: the second process did not attach to the first (pid ${first.child.pid}): ${JSON.stringify(joined.refusal ?? joined)}`);
      }
    }
  } catch (error) {
    problems.push(`positive leg: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Newest first: the attached session leaves, then the primary it was holding open.
    for (const session of started.splice(0).reverse()) await session.reap(reapMs);
    rmSync(tmp, { recursive: true, force: true });
  }

  try {
    // No home of any kind — and no way to invent one: the working directory is `/`.
    const bare = start({ PATH: path.dirname(process.execPath) });
    await bare.initialize();
    const status = await bare.status();
    if (status.running !== false || status.refusal?.code !== 'home-unresolved') {
      problems.push(`negative leg: with neither HOME nor SNUG_HOME the status must be the home-unresolved refusal, but it was ${JSON.stringify(status.refusal?.code ?? status)}`);
    }
  } catch (error) {
    problems.push(`negative leg: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const session of started.splice(0)) await session.reap(reapMs);
  }
  return problems;
}

/**
 * The pin, proven on the tree (D8). The build writes the page's sha256 beside it and the
 * process serves only bytes that match — two halves in two packages, and every hash in the
 * tree stays correct if they stop meeting. So this starts what the tree ships, twice:
 *
 *   damaged    a COPY of the plugin folder with ONE byte of its page changed, under the
 *              isolation environment → `initialize` succeeds and `snug_status` is the
 *              `page-damaged` refusal. (No pin, or a process that does not read it, and the
 *              copy LEADS — on a page that is not the one it was built with.)
 *   untouched  the tree itself, on the same home, while the damaged process is still
 *              running → it leads. A pin of the wrong page passes the first half all by
 *              itself; and a damaged install must hold nothing a healthy one needs.
 *
 * The tree it is given is never written to. No leg spawns a CLI, and both processes are
 * reaped in the `finally`.
 *
 * @param {string} pluginDir the built plugin folder (`<tree>/snug`)
 * @param {{ requestTimeoutMs?: number, reapMs?: number }} [options] the bounds (tests shorten them)
 * @returns {Promise<string[]>} the problems; empty when both halves held
 */
export async function runDamagedPageLeg(pluginDir, options = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  const reapMs = options.reapMs ?? 8_000;
  const problems = [];
  const started = [];
  const start = (launcher, env) => {
    const session = startLauncher(launcher, env, requestTimeoutMs);
    started.push(session);
    return session;
  };

  const tmp = mkdtempSync(path.join(tmpdir(), 'snug-gate-'));
  try {
    const copy = path.join(tmp, 'install', PLUGIN.name);
    cpSync(pluginDir, copy, { recursive: true });
    const page = path.join(copy, PAGE_PATH);
    const bytes = readFileSync(page);
    bytes[bytes.length >> 1] ^= 1;
    writeFileSync(page, bytes);

    const env = isolationEnv(tmp);
    const damaged = start(path.join(copy, LAUNCHER_PATH), env);
    await damaged.initialize();
    const refused = await damaged.status();
    if (refused.running !== false || refused.refusal?.code !== 'page-damaged') {
      // It stops here: a copy that LED holds this home's lock, and a second process would
      // only attach to it.
      problems.push(
        `damaged-page leg: a copy of the tree with one byte of its page changed must refuse to lead (page-damaged), but its status was ` +
          `${JSON.stringify(refused)} — is ${PAGE_PIN_PATH} in the tree, and does the process read it (apps/host-mcp/src/page.ts)?`,
      );
    } else {
      const untouched = start(path.join(pluginDir, LAUNCHER_PATH), env);
      await untouched.initialize();
      const status = await untouched.status();
      if (status.running !== true) {
        problems.push(`damaged-page leg: the untouched tree must still lead, beside the damaged copy — but its status was ${JSON.stringify(status.refusal ?? status)}`);
      } else if (!ownedBy(status, untouched, tmp)) {
        problems.push(
          `damaged-page leg: ISOLATION — the untouched tree's status names home ${JSON.stringify(status.home)}, file ${JSON.stringify(status.file)} and pid ${JSON.stringify(status.pid)}, ` +
            `but this leg started pid ${untouched.child.pid} under ${tmp}: it is not leading on the leg's own home.`,
        );
      }
    }
  } catch (error) {
    problems.push(`damaged-page leg: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const session of started.splice(0).reverse()) await session.reap(reapMs);
    rmSync(tmp, { recursive: true, force: true });
  }
  return problems;
}

/** The legs the gate starts a tree with — named, so a test can pin that the defaults ARE these. */
export const GATE_LEGS = Object.freeze({ launch: runLaunchLegs, damagedPage: runDamagedPageLeg });

/**
 * The gate, whole: sweep the bundle, build the tree, check it, START it, ask the validators.
 *
 * It is a function with its collaborators as parameters because of what the R2 verifier
 * found (2026-10-03): with all of this inline in `main()`, deleting the call to the launch
 * legs — or to the damaged-page leg — left every suite green. Each leg had its own tests;
 * nothing tested that the gate runs them. The tests drive this over a real build of fixture
 * inputs, with legs that record their calls and once with the real ones.
 *
 * @param {object} [options] every default is the real gate's; a test passes its own
 * @param {string} [options.bundleFile] the release bundle: swept, then shipped in the tree
 * @param {string} [options.pluginDir] the marketplace dir the tree is built into, checked in and started from
 * @param {{ launch: typeof runLaunchLegs, damagedPage: typeof runDamagedPageLeg }} [options.legs]
 * @param {typeof runValidators} [options.validators]
 * @param {typeof SOURCES} [options.sources] the builder's other inputs (tests)
 * @param {Record<string, string>} [options.skill] a pre-rendered skill tree (tests)
 * @returns {Promise<{ lines: string[], problems: string[] }>} what to print, and what
 *   failed — the gate passed when `problems` is empty
 */
export async function runGate(options = {}) {
  const bundleFile = options.bundleFile ?? BUNDLE_FILE;
  const pluginDir = options.pluginDir ?? PLUGIN_DIR;
  const legs = options.legs ?? GATE_LEGS;
  const validators = options.validators ?? runValidators;
  const tree = options.skill !== undefined ? { skill: options.skill } : {};

  if (!existsSync(bundleFile)) {
    return { lines: [], problems: [`CANNOT RUN — ${path.relative(REPO, bundleFile)} is missing (pnpm --filter host-mcp build)`] };
  }
  const source = readFileSync(bundleFile, 'utf8');
  const bundleBytes = Buffer.byteLength(source);
  // Printed whatever the verdict, and never part of it.
  const lines = [`SIZE — ${bundleSizeLine(bundleBytes)}`];
  const problems = [...checkBundle(source), ...checkInstructions(source, readFileSync(INSTRUCTIONS_FILE, 'utf8'))];

  // The tree is built HERE, every run: a missing input is CANNOT RUN by name — after the
  // bundle's own problems, found above, so they are not lost with it.
  const unbuilt = await buildPlugin(pluginDir, { ...(options.sources ?? SOURCES), bundle: bundleFile }, tree);
  if (unbuilt.length > 0) return { lines, problems: [...problems, ...unbuilt.map((problem) => `CANNOT RUN — ${problem}`)] };

  problems.push(...(await checkPluginTree(pluginDir, tree)));
  // Only a tree that is what it says it is gets STARTED.
  if (problems.length === 0) {
    const plugin = path.join(pluginDir, PLUGIN.name);
    problems.push(...(await legs.launch(path.join(plugin, LAUNCHER_PATH), { page: path.join(plugin, PAGE_PATH) })));
    problems.push(...(await legs.damagedPage(plugin)));
  }

  const verdicts = validators(pluginDir);
  for (const v of verdicts) {
    if (v.status === 'failed') problems.push(`${v.name} refused the tree:\n${v.detail}`);
  }
  if (problems.length > 0) return { lines, problems };

  lines.push(
    `ok (${bundleBytes} bytes; plugin tree built and checked — page pinned, directory rules kept, ${ARCHIVE_NAME} is the tree; ` +
      `launched — the shipped page served, a second process attached, no home refused by name, a damaged page refused beside a tree that still led; ` +
      `validators: ${verdicts.map((v) => `${v.name} ${v.status}`).join(', ')})`,
  );
  for (const v of verdicts.filter((verdict) => verdict.status === 'not verified')) lines.push(`NOT VERIFIED — ${v.name}: ${v.detail}`);
  return { lines, problems };
}

async function main() {
  const { lines, problems } = await runGate();
  for (const line of lines) console.log(`check-host-mcp: ${line}`);
  for (const problem of problems) console.error(`check-host-mcp: ${problem}`);
  if (problems.length > 0) process.exit(1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
