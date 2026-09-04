#!/usr/bin/env node
// deploy-relay.mjs — TASK-20260904-app-sharing (ADR-0064): the share relay's deploy,
// run BY THE OWNER from the repo root, in ADR-0054's discipline:
//
//   node scripts/deploy-relay.mjs init        # print the one-time setup (bucket, domain, lifecycle, rate limit)
//   node scripts/deploy-relay.mjs             # pre-flight, test, PRINT the wrangler argv, STOP
//   node scripts/deploy-relay.mjs --deploy    # …and deploy (the explicit ask)
//
// Steps, each refusal loud and naming its fix:
//   1. resolve CLOUDFLARE_ACCOUNT_ID (process env, else root .env) and check the
//      wrangler session is logged in to THAT account (wrangler ≥ 4);
//   2. git pre-flight: clean tree on main == origin/main — the relay is production only
//      (there is no preview relay; a second bucket would be a second surface);
//   3. the relay's own test suite must pass (node:test, in-memory store);
//   4. the config must still be the blind shape: no logging enabled, one R2 binding,
//      the custom domain, no KV/D1/analytics bindings — the falsifiability claim of
//      ADR-0064 §5 is "read the Worker and its config", so the deploy refuses to ship
//      a config that grew a second surface;
//   5. PRINT the exact wrangler argv and STOP — unless --deploy. Every deploy is
//      journaled with UTC time and the verification performed (PROCESS.md release rules).
//
// Reuses deploy-web.mjs's pure helpers (account id, git pre-flight, quoting) so the two
// deploy paths cannot drift on what "clean on main" means.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitPreflight, resolveAccountId, shellQuote } from './deploy-web.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELAY_DIR = 'apps/share-relay';
export const RELAY_CONFIG = `${RELAY_DIR}/wrangler.jsonc`;
export const WORKER_NAME = 'snug-share-relay';
export const BUCKET_NAME = 'snug-share-bundles';
export const RELAY_HOST = 'share.snugprotocol.org';

export class UsageError extends Error {}
class Refusal extends Error {}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const init = args.includes('init');
  const deploy = args.includes('--deploy');
  const devIndex = args.indexOf('--dev-origin');
  let devOrigin;
  if (devIndex !== -1) {
    devOrigin = args[devIndex + 1];
    if (devOrigin === undefined || devOrigin.startsWith('--')) {
      throw new UsageError('--dev-origin needs a value, e.g. --dev-origin http://localhost:5173');
    }
  }
  const consumed = new Set(['init', '--deploy', '--dev-origin', devOrigin]);
  const unknown = args.filter((a) => !consumed.has(a));
  if (unknown.length) throw new UsageError(`unknown argument(s): ${unknown.join(' ')}`);
  return { init, deploy, ...(devOrigin !== undefined ? { devOrigin } : {}) };
}

export function initCommands() {
  return [
    `# 0. FIRST: the relay's code must be on main — this script refuses anything but a clean tree on main == origin/main.`,
    `#    Merge the PR, then: git switch main && git pull`,
    `# 1. the bucket (once): pnpm exec wrangler r2 bucket create ${BUCKET_NAME}`,
    `# 2. the lifecycle janitor (once): pnpm exec wrangler r2 bucket lifecycle add ${BUCKET_NAME} expire-shares --expire-days 31`,
    `#    (verify: pnpm exec wrangler r2 bucket lifecycle list ${BUCKET_NAME} — expiry is ALSO enforced at read time by the Worker, so the rule only reclaims storage)`,
    `# 3. the custom domain: the Worker config declares ${RELAY_HOST}; the first deploy binds it (the zone must be on this account)`,
    `# 4. the rate limit (once, dashboard ONLY — Security → WAF → Rate limiting rules): POST to /v1/bundles, 20 per minute per IP, block 10 minutes`,
    `# 5. dry run: node scripts/deploy-relay.mjs   (pre-flight + relay tests + prints the wrangler argv, then stops)`,
    `# 6. deploy: node scripts/deploy-relay.mjs --deploy`,
  ];
}

// Strip line comments and block comments (wrangler.jsonc) — enough for our own file, not a general parser.
export function parseJsonc(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  return JSON.parse(stripped);
}

/** The blind shape ADR-0064 promises — refused if the config grew a second surface. */
export function configPreflight(config) {
  const problems = [];
  if (config.name !== WORKER_NAME) problems.push(`name must be ${WORKER_NAME}`);
  if (config.main !== 'worker.mjs') problems.push('main must be worker.mjs');
  if (config.workers_dev !== false) problems.push('workers_dev must be false (the *.workers.dev name is a second host)');
  if (config.observability?.enabled !== false) problems.push('observability.enabled must be false (no request logging)');
  const buckets = config.r2_buckets ?? [];
  if (buckets.length !== 1 || buckets[0]?.binding !== 'BUNDLES' || buckets[0]?.bucket_name !== BUCKET_NAME) {
    problems.push(`exactly one R2 binding BUNDLES → ${BUCKET_NAME}`);
  }
  for (const key of ['kv_namespaces', 'd1_databases', 'analytics_engine_datasets', 'durable_objects', 'queues', 'services', 'logpush']) {
    if (config[key] !== undefined) problems.push(`${key} must be absent — the relay has one store and no telemetry`);
  }
  const routes = config.routes ?? [];
  if (routes.length !== 1 || routes[0]?.pattern !== RELAY_HOST || routes[0]?.custom_domain !== true) {
    problems.push(`exactly one route: the custom domain ${RELAY_HOST}`);
  }
  if (problems.length) throw new Refusal(`REFUSED: ${RELAY_CONFIG} is not the blind shape ADR-0064 promises:\n  - ${problems.join('\n  - ')}`);
}

/**
 * `DEPLOY_SHA` is a Worker var the handler never reads or serves — it exists so
 * `wrangler deployments list` names the commit.
 *
 * `--dev-origin <origin>` ADDS one browser origin to the CORS allowlist for this deploy
 * only, on top of the config's production list. It exists so a developer can exercise the
 * copy-link path against a local playground (`http://localhost:5173`), which the shipped
 * allowlist rightly refuses. Three properties keep it from becoming a hole: it is
 * ADDITIVE (never replaces the pinned origins), it is refused unless the origin is
 * loopback, and it is **not sticky** — the next ordinary deploy drops it, because the
 * committed `wrangler.jsonc` is the only durable statement of who may write. A relay
 * carrying a dev origin should never be the one serving real users for long.
 */
export function wranglerCommand({ sha, devOrigin, configOrigins }) {
  const argv = ['pnpm', 'exec', 'wrangler', 'deploy', '--config', RELAY_CONFIG, '--var', `DEPLOY_SHA:${sha}`];
  if (devOrigin !== undefined) {
    argv.push('--var', `ALLOWED_ORIGINS:${[...configOrigins, devOrigin].join(',')}`);
  }
  return argv;
}

/** Loopback only — a dev override must never admit a public origin. */
export function assertLoopbackOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Refusal(`REFUSED: --dev-origin ${origin} is not a URL (want e.g. http://localhost:5173).`);
  }
  if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    throw new Refusal(
      `REFUSED: --dev-origin ${origin} is not loopback. This flag exists for local development only; ` +
        'a public origin belongs in apps/share-relay/wrangler.jsonc, reviewed.',
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Refusal(`REFUSED: --dev-origin ${origin} must be a bare origin (scheme://host:port).`);
  }
  return `${url.protocol}//${url.host}`;
}

export const realIo = {
  env: process.env,
  log: (s) => console.log(s),
  error: (s) => console.error(s),
  readDotEnvFile: () => (existsSync(path.join(ROOT, '.env')) ? readFileSync(path.join(ROOT, '.env'), 'utf8') : null),
  readConfig: () => readFileSync(path.join(ROOT, RELAY_CONFIG), 'utf8'),
  exec: (file, args, opts = {}) => {
    const r = spawnSync(file, args, { cwd: ROOT, encoding: 'utf8', ...opts });
    if (r.error) throw r.error;
    return { status: r.status ?? 1, stdout: r.stdout ?? '' };
  },
};

export function main(argv, io = realIo) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    io.error(String(err.message));
    io.error('usage: node scripts/deploy-relay.mjs [init] [--deploy]');
    return 2;
  }
  if (parsed.init) {
    for (const line of initCommands()) io.log(line);
    return 0;
  }
  try {
    const accountId = resolveAccountId(io.env, io.readDotEnvFile());
    const version = io.exec('pnpm', ['exec', 'wrangler', '--version']);
    const major = Number(/(?:^|\s)(\d+)\.\d+\.\d+/.exec(version.stdout)?.[1]);
    if (!Number.isFinite(major) || major < 4) throw new Refusal('REFUSED: wrangler 4+ is required (pnpm install).');
    const whoami = io.exec('pnpm', ['exec', 'wrangler', 'whoami']);
    if (!whoami.stdout.includes(accountId)) {
      throw new Refusal(`REFUSED: wrangler is not logged in to account ${accountId} (\`wrangler whoami\`).`);
    }
    const branch = io.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const porcelain = io.exec('git', ['status', '--porcelain']).stdout;
    const head = io.exec('git', ['rev-parse', 'HEAD']).stdout.trim();
    io.exec('git', ['fetch', 'origin', 'main', '--quiet']);
    const originMain = io.exec('git', ['rev-parse', 'origin/main']).stdout.trim();
    gitPreflight({ branch, porcelain, head, originMain, preview: false });
    configPreflight(parseJsonc(io.readConfig()));
    const tests = io.exec('pnpm', ['--filter', 'share-relay', 'test']);
    if (tests.status !== 0) throw new Refusal('REFUSED: the relay test suite is red.');
    const config = parseJsonc(io.readConfig());
    const devOrigin = parsed.devOrigin === undefined ? undefined : assertLoopbackOrigin(parsed.devOrigin);
    if (devOrigin !== undefined) {
      io.log(`⚠ --dev-origin ${devOrigin} — this deploy ALSO accepts writes from that loopback origin.`);
      io.log('  It is additive and NOT sticky: the next ordinary deploy restores the config-only allowlist.');
    }
    const argvOut = wranglerCommand({
      sha: head.slice(0, 12),
      ...(devOrigin !== undefined ? { devOrigin, configOrigins: String(config.vars?.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean) } : {}),
    });
    io.log(`relay ${WORKER_NAME} → ${RELAY_HOST} (account ${accountId}, main @ ${head.slice(0, 12)})`);
    io.log(shellQuote(argvOut));
    if (!parsed.deploy) {
      io.log('printed, not run — re-run with --deploy on an explicit owner ask (ADR-0054 §16 / ADR-0064 §4).');
      return 0;
    }
    const result = io.exec(argvOut[0], argvOut.slice(1), { stdio: 'inherit' });
    if (result.status !== 0) throw new Refusal(`REFUSED: wrangler deploy exited ${result.status}.`);
    io.log(`deployed ${new Date().toISOString()} — journal it: what, when UTC, verification (curl -sI https://${RELAY_HOST}/ → 404; POST/GET round trip from the playground).`);
    return 0;
  } catch (err) {
    io.error(String(err.message));
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
