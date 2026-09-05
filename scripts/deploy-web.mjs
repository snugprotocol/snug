#!/usr/bin/env node
// deploy-web.mjs — TASK-20260823-web-deploy (ADR-0054).
//
// The website + playground deploy pipeline (Cloudflare Pages, direct upload), run BY
// THE OWNER from the repo root:
//
//   node scripts/deploy-web.mjs init                       # print the one-time setup
//   node scripts/deploy-web.mjs <website|playground|all>   # pre-flight, build, verify, PRINT
//   node scripts/deploy-web.mjs <target> --deploy          # …and upload (explicit ask)
//   node scripts/deploy-web.mjs <target> --preview [--deploy]   # *.pages.dev preview
//
// Steps, in order — each refusal is loud and names its fix:
//   1. resolve CLOUDFLARE_ACCOUNT_ID (process env, else root .env; see .env.example) —
//      never hardcoded, and the wrangler session must be logged in to THAT account;
//   2. Cloudflare pre-flight: wrangler ≥ 4, `whoami` shows the account, `pages project
//      list` already contains the project (the deploy path never creates one — the
//      one-time creation is `init`'s output, run by a human);
//   3. git pre-flight: production = clean tree on main == origin/main; preview = any
//      OTHER branch (Pages decides "production" purely by branch name equalling the
//      project's production branch, so a preview from main would BE production);
//   4. hosted-posture checks (ADR-0013 — the hosted hub ships no sign-in, no backend):
//      the build env PINS VITE_SNUG_HUB_AUTH='' and PUBLIC_SITE_MODE='production';
//      any apps/<app>/.env* file refuses (gitignored, unhashed by turbo, invisible to a
//      clean-tree check); a staged apps/website/public/local-artifacts/ refuses;
//   5. build from a DELETED dist/ with `turbo … --force` (turbo restores cached dist/**
//      over stale files and never hashes gitignored inputs — lessons 2026-08-10);
//   6. verify the dist manifest against Pages' limits (20,000 files, 25 MiB per file)
//      and the per-app invariants: website needs 404.html and no local-artifacts/;
//      playground needs NO 404.html (Pages' SPA fallback keys on its absence) and the
//      sql.js wasm; website HTML must not carry the local-mode fingerprints;
//   7. PRINT the exact wrangler argv per app and STOP — unless --deploy, in which case
//      `all` uploads only after BOTH apps verified. Every deploy is journaled with UTC
//      time and verification performed (PROCESS.md release rules).
//
// Subprocesses run through ONE injected exec seam (spawnSync with an argv array, never
// a shell string — commit subjects carry apostrophes). The pure parts are exported for
// scripts/deploy-web.test.mjs, which root `pnpm test` runs via `check-deploy-web`.
// Node builtins only, matching the other scripts/ checkers.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROJECTS = Object.freeze({ website: 'snug-website', playground: 'snug-playground' });
export const DIST_DIRS = Object.freeze({ website: 'apps/website/dist', playground: 'apps/playground/dist' });
const APP_DIRS = Object.freeze({ website: 'apps/website', playground: 'apps/playground' });
/** The one hosted endpoint (ADR-0064) — the playground's link transport is a BUILD invariant. */
export const SHARE_RELAY_ORIGIN = 'https://share.snugprotocol.org';
/**
 * ADR-0013: the hosted playground ships no sign-in; the hosted website is never local-mode.
 * ADR-0064 (TASK-20260904-share-link-ux): the hosted playground knows the relay, so the
 * link actions render — pinned here, never read from an env file.
 */
export const PINNED_BUILD_ENV = Object.freeze({ VITE_SNUG_HUB_AUTH: '', PUBLIC_SITE_MODE: 'production', VITE_SNUG_SHARE_RELAY: SHARE_RELAY_ORIGIN });
/** Cloudflare Pages direct-upload limits. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;
const PRODUCTION_BRANCH = 'main';
const APPS = ['website', 'playground'];

export class UsageError extends Error {}
class Refusal extends Error {}

const USAGE =
  'usage: node scripts/deploy-web.mjs <website|playground|all|init> [--deploy] [--preview]\n' +
  '  (no --allow-dirty: a hotfix is commit → gate:local → merge → deploy; ADR-0054 §3)';

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const [target, ...flags] = argv;
  const out = { command: 'deploy', targets: [], deploy: false, preview: false };
  if (target === 'init') {
    if (flags.length) throw new UsageError(USAGE);
    return { ...out, command: 'init' };
  }
  if (target === 'all') out.targets = [...APPS];
  else if (APPS.includes(target)) out.targets = [target];
  else throw new UsageError(USAGE);
  for (const flag of flags) {
    if (flag === '--deploy') out.deploy = true;
    else if (flag === '--preview') out.preview = true;
    else throw new UsageError(USAGE);
  }
  return out;
}

/** The one-time setup a human runs (see docs/runbooks/deploy-web.md). Never a deploy. */
export function initCommands() {
  return [
    '# One-time setup (each line is an explicit act — journal it). Requires `wrangler login`',
    '# on the Cloudflare account that holds the snugprotocol.org zone, and CLOUDFLARE_ACCOUNT_ID in .env.',
    ...APPS.map((app) => `pnpm exec wrangler pages project create ${PROJECTS[app]} --production-branch ${PRODUCTION_BRANCH}`),
    '# Then, in the dashboard (docs/runbooks/deploy-web.md, "One-time setup"): custom domains,',
    '# the www Redirect Rule, zone features OFF, the preview Access policy, the pages.dev Bulk Redirect.',
  ];
}

/** Minimal KEY=value parser: quotes, `#` comments, blank lines, CRLF. No dependency. */
export function readDotEnv(text) {
  const out = {};
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    out[key] = value;
  }
  return out;
}

export function resolveAccountId(env, dotEnvText) {
  const fromEnv = env?.CLOUDFLARE_ACCOUNT_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const fromFile = readDotEnv(dotEnvText).CLOUDFLARE_ACCOUNT_ID;
  if (typeof fromFile === 'string' && fromFile.trim() !== '') return fromFile.trim();
  throw new Refusal(
    'REFUSED: CLOUDFLARE_ACCOUNT_ID is not set. Put it in the (gitignored) root .env — ' +
      'see .env.example — or export it. It is the id of the account that holds the snugprotocol.org zone.',
  );
}

export function cloudflarePreflight({ versionOutput, whoamiOutput, projectListOutput, accountId, apps }) {
  // `pnpm exec wrangler --version` prints a bare `4.125.0`; the banner form is ` ⛅️ wrangler 4.110.0 …`.
  const major = Number(/(?:^|\s)(\d+)\.\d+\.\d+/.exec(String(versionOutput ?? ''))?.[1]);
  if (!Number.isFinite(major)) throw new Refusal(`REFUSED: could not read the wrangler version from: ${String(versionOutput).trim()}`);
  if (major < 4) throw new Refusal(`REFUSED: wrangler ${major}.x found; wrangler 4+ is required (pnpm install).`);
  if (!String(whoamiOutput).includes(accountId)) {
    throw new Refusal(
      `REFUSED: wrangler is not logged in to account ${accountId} (\`wrangler whoami\`). ` +
        'Run `pnpm exec wrangler logout && pnpm exec wrangler login` on the zone-holding account.',
    );
  }
  for (const app of apps) {
    const project = PROJECTS[app];
    if (!new RegExp(`(^|[^\\w-])${project}([^\\w-]|$)`, 'm').test(String(projectListOutput))) {
      throw new Refusal(
        `REFUSED: Pages project ${project} does not exist on this account. ` +
          'Create it first — `node scripts/deploy-web.mjs init` prints the command (its own explicit ask).',
      );
    }
  }
}

export function gitPreflight({ branch, porcelain, head, originMain, preview }) {
  const dirty = String(porcelain).trim() !== '';
  if (preview) {
    if (branch === 'HEAD') throw new Refusal('REFUSED: detached HEAD — a preview needs a branch name (git switch <branch>).');
    if (branch === PRODUCTION_BRANCH) {
      throw new Refusal(
        `REFUSED: --preview on ${PRODUCTION_BRANCH} would deploy to PRODUCTION — Pages decides production ` +
          'purely by branch name. Preview from a feature branch, or deploy production without --preview.',
      );
    }
    return { mode: 'preview', branch, dirty };
  }
  if (branch !== PRODUCTION_BRANCH) {
    throw new Refusal(`REFUSED: production deploys only from ${PRODUCTION_BRANCH} (on ${branch}). Merge first, or use --preview.`);
  }
  if (dirty) throw new Refusal('REFUSED: the working tree is not clean. Commit → gate:local → merge, then deploy from main.');
  if (head !== originMain) {
    throw new Refusal(`REFUSED: HEAD (${head}) != origin/main (${originMain}). Pull or push so main is what is merged.`);
  }
  return { mode: 'production', branch, dirty: false };
}

export function hostedPostureCheck({ app, envFiles, localArtifactsExists }) {
  if (envFiles.length) {
    throw new Refusal(
      `REFUSED: ${envFiles.join(', ')} exists — an app-level .env file can put VITE_*/PUBLIC_* values into a ` +
        'hosted build that no clean-tree check sees (ADR-0013). Move it aside for the deploy.',
    );
  }
  if (app === 'website' && localArtifactsExists) {
    throw new Refusal(
      'REFUSED: apps/website/public/local-artifacts/ exists (the DMG staged for local E2E) and would be ' +
        'published. Delete the directory (it is gitignored; `stage-local-desktop` recreates it) and rerun.',
    );
  }
}

/** Website HTML carrying a local-mode URL (site.ts LOCAL_LINKS) must never ship. */
export function htmlTripwire(htmlFiles) {
  for (const { path: file, text } of htmlFiles) {
    for (const needle of ['localhost:5173', '/local-artifacts/']) {
      if (text.includes(needle)) {
        throw new Refusal(`REFUSED: ${file} contains "${needle}" — the build ran in local site mode (PUBLIC_SITE_MODE=local).`);
      }
    }
  }
}

/** turbo names the dependency closure (^build); --force bypasses the cache (lessons 2026-08-10/23). */
export function buildArgv(app) {
  return ['pnpm', 'exec', 'turbo', 'run', 'build', `--filter=${app}`, '--force'];
}

export function verifyDist(app, manifest) {
  const paths = new Set(manifest.map((f) => f.path));
  if (!paths.has('index.html')) throw new Refusal(`REFUSED: ${DIST_DIRS[app]} has no index.html — the build did not produce a site.`);
  if (manifest.length > MAX_FILES) {
    throw new Refusal(`REFUSED: ${manifest.length} files exceeds Cloudflare Pages' 20,000-file limit.`);
  }
  for (const f of manifest) {
    if (f.size > MAX_FILE_BYTES) {
      throw new Refusal(`REFUSED: ${f.path} is ${(f.size / 1024 / 1024).toFixed(1)} MiB; Pages refuses files over 25 MiB.`);
    }
  }
  if (app === 'website') {
    if (!paths.has('404.html')) throw new Refusal('REFUSED: website dist has no 404.html — Astro should emit one; the build is not a static site.');
    const staged = manifest.find((f) => f.path.startsWith('local-artifacts/'));
    if (staged) throw new Refusal(`REFUSED: ${staged.path} is in the website dist — a locally staged desktop bundle must never publish.`);
  }
  if (app === 'playground') {
    if (paths.has('404.html')) {
      throw new Refusal(
        'REFUSED: playground dist contains 404.html — Cloudflare Pages enables the SPA fallback ONLY when it is ' +
          'absent, and react-router deep links depend on that fallback. Remove it (or decide the routing story in an ADR).',
      );
    }
    if (![...paths].some((p) => p.startsWith('assets/') && p.endsWith('.wasm'))) {
      throw new Refusal('REFUSED: playground dist has no assets/*.wasm — the sql.js runtime asset is missing from the build.');
    }
  }
}

export function wranglerCommand({ app, mode, branch, sha, subject, dirty }) {
  if (mode === 'preview' && branch === PRODUCTION_BRANCH) {
    throw new Refusal(`REFUSED: a preview can never target --branch ${PRODUCTION_BRANCH} (that is production).`);
  }
  const argv = [
    'wrangler', 'pages', 'deploy', DIST_DIRS[app],
    '--project-name', PROJECTS[app],
    '--branch', mode === 'production' ? PRODUCTION_BRANCH : branch,
    '--commit-hash', sha,
    '--commit-message', subject,
  ];
  if (mode === 'preview' && dirty) argv.push('--commit-dirty=true');
  return argv;
}

/** For PRINTING only — execution never goes through a shell. */
export function shellQuote(argv) {
  return argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`)).join(' ');
}

// ---------------------------------------------------------------------------
// The io seam (real implementations; the test injects fakes)
// ---------------------------------------------------------------------------

/** Files Vite/Astro actually read: `.env`, `.env.<mode>`, `.env.local`… — never `.env.example`. */
export function isAppEnvFile(name) {
  return name !== '.env.example' && (name === '.env' || name.startsWith('.env.'));
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: rel, size: st.size });
  }
  return out;
}

export const realIo = {
  env: process.env,
  log: (s) => console.log(s),
  error: (s) => console.error(s),
  readDotEnvFile: () => (existsSync(path.join(ROOT, '.env')) ? readFileSync(path.join(ROOT, '.env'), 'utf8') : null),
  listEnvFiles: (app) =>
    readdirSync(path.join(ROOT, APP_DIRS[app]))
      .filter(isAppEnvFile)
      .map((n) => `${APP_DIRS[app]}/${n}`),
  localArtifactsExists: () => existsSync(path.join(ROOT, 'apps', 'website', 'public', 'local-artifacts')),
  rmDist: (app) => rmSync(path.join(ROOT, DIST_DIRS[app]), { recursive: true, force: true }),
  manifest: (app) => walk(path.join(ROOT, DIST_DIRS[app])),
  htmlFiles: (app) =>
    walk(path.join(ROOT, DIST_DIRS[app]))
      .filter((f) => f.path.endsWith('.html'))
      .map((f) => ({ path: f.path, text: readFileSync(path.join(ROOT, DIST_DIRS[app], f.path), 'utf8') })),
  exec: (file, args, opts = {}) => {
    const r = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', ...opts });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  },
};

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

export function main(argv, io = realIo) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.error(err.message);
    return 2;
  }
  if (args.command === 'init') {
    for (const line of initCommands()) io.log(line);
    return 0;
  }
  try {
    const accountId = resolveAccountId(io.env, io.readDotEnvFile());
    const cfEnv = { ...io.env, CLOUDFLARE_ACCOUNT_ID: accountId };
    const capture = (file, a) => {
      const r = io.exec(file, a, { env: cfEnv, stdio: ['ignore', 'pipe', 'inherit'] });
      if (r.status !== 0) throw new Refusal(`REFUSED: \`${shellQuote([file, ...a])}\` exited ${r.status}.`);
      return r.stdout;
    };
    const wrangler = (...a) => capture('pnpm', ['exec', 'wrangler', ...a]);
    const git = (...a) => capture('git', a).trim();

    cloudflarePreflight({
      versionOutput: wrangler('--version'),
      whoamiOutput: wrangler('whoami'),
      projectListOutput: wrangler('pages', 'project', 'list'),
      accountId,
      apps: args.targets,
    });
    io.log(`✔ wrangler session on account ${accountId}; project(s) ${args.targets.map((a) => PROJECTS[a]).join(', ')} exist`);

    const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
    if (!args.preview) git('fetch', 'origin', PRODUCTION_BRANCH, '--quiet');
    const state = gitPreflight({
      branch,
      porcelain: git('status', '--porcelain'),
      head: git('rev-parse', 'HEAD'),
      originMain: args.preview ? '' : git('rev-parse', `origin/${PRODUCTION_BRANCH}`),
      preview: args.preview,
    });
    const sha = git('rev-parse', 'HEAD');
    const subject = git('log', '-1', '--format=%s');
    io.log(`✔ git: ${state.mode} from ${state.branch}@${sha.slice(0, 7)}${state.dirty ? ' (dirty — preview only)' : ''}`);

    const commands = [];
    for (const app of args.targets) {
      hostedPostureCheck({ app, envFiles: io.listEnvFiles(app), localArtifactsExists: io.localArtifactsExists() });
      io.rmDist(app);
      const [file, ...a] = buildArgv(app);
      const r = io.exec(file, a, { env: { ...cfEnv, ...PINNED_BUILD_ENV }, stdio: 'inherit' });
      if (r.status !== 0) throw new Refusal(`REFUSED: build failed for ${app} (exit ${r.status}).`);
      verifyDist(app, io.manifest(app));
      if (app === 'website') htmlTripwire(io.htmlFiles(app));
      io.log(`✔ ${app}: built fresh (turbo --force) and verified against Pages limits + hosted-posture invariants`);
      commands.push([app, wranglerCommand({ app, mode: state.mode, branch: state.branch, sha, subject, dirty: state.dirty })]);
    }

    io.log('');
    for (const [app, cmd] of commands) io.log(`${app}: pnpm exec ${shellQuote(cmd)}`);
    if (!args.deploy) {
      io.log('\nNot deployed (no --deploy). Deploying needs an explicit ask in this session — then rerun with --deploy');
      io.log('and record what/when(UTC)/verification in the task journal (PROCESS.md release rules).');
      return 0;
    }
    for (const [app, cmd] of commands) {
      io.log(`\n▶ deploying ${app} (${state.mode})…`);
      const r = io.exec('pnpm', ['exec', ...cmd], { env: cfEnv, stdio: 'inherit' });
      if (r.status !== 0) throw new Refusal(`REFUSED: wrangler deploy failed for ${app} (exit ${r.status}).`);
      io.log(`✔ ${app} deployed (${state.mode}). Now walk docs/runbooks/deploy-web.md "Verify", then journal it.`);
    }
    return 0;
  } catch (err) {
    io.error(err instanceof Refusal ? err.message : String(err?.stack ?? err));
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
