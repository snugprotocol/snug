// deploy-web.test.mjs — TASK-20260823-web-deploy (ADR-0054).
//
// node:test over the deploy script's PURE parts plus its composition root through an
// injected io seam, wired into root `pnpm test` via `check-deploy-web` (a node:test file
// nothing runs is dead coverage — the release-desktop precedent). Every refusal has a
// passing twin (lessons 2026-08-20: a stub that always says yes vouches for nothing).
//
// The impure half — real wrangler, real turbo, real git — is exercised at the deploy
// ask itself (PROCESS.md release rules) and journaled there.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DIST_DIRS,
  MAX_FILES,
  MAX_FILE_BYTES,
  PINNED_BUILD_ENV,
  PROJECTS,
  UsageError,
  buildArgv,
  cloudflarePreflight,
  gitPreflight,
  hostedPostureCheck,
  htmlTripwire,
  initCommands,
  isAppEnvFile,
  main,
  parseArgs,
  readDotEnv,
  resolveAccountId,
  shellQuote,
  verifyDist,
  wranglerCommand,
} from './deploy-web.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '0123456789abcdef0123456789abcdef';

// ---------------------------------------------------------------------------
// AC1 — targets & usage
// ---------------------------------------------------------------------------

test('AC1: parseArgs accepts website | playground | all | init and the two flags', () => {
  assert.deepEqual(parseArgs(['website']), { command: 'deploy', targets: ['website'], deploy: false, preview: false });
  assert.deepEqual(parseArgs(['playground', '--deploy']), { command: 'deploy', targets: ['playground'], deploy: true, preview: false });
  assert.deepEqual(parseArgs(['all', '--preview']), { command: 'deploy', targets: ['website', 'playground'], deploy: false, preview: true });
  assert.deepEqual(parseArgs(['init']), { command: 'init', targets: [], deploy: false, preview: false });
});

test('AC1: parseArgs refuses unknown targets, unknown flags, no target, and --allow-dirty (dropped on review)', () => {
  for (const argv of [[], ['server'], ['website', '--yolo'], ['website', '--allow-dirty'], ['website', 'playground']]) {
    assert.throws(() => parseArgs(argv), UsageError, `should refuse ${JSON.stringify(argv)}`);
  }
});

test('AC1: init prints the one-time project-creation commands and never a deploy', () => {
  const out = initCommands().join('\n');
  assert.match(out, /wrangler pages project create snug-website --production-branch main/);
  assert.match(out, /wrangler pages project create snug-playground --production-branch main/);
  assert.doesNotMatch(out, /pages deploy/);
});

// ---------------------------------------------------------------------------
// AC2 — account resolution
// ---------------------------------------------------------------------------

test('AC2: readDotEnv handles KEY=value, quotes, comments, blanks, and CRLF', () => {
  const text = `# deploy tooling\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\r\nQUOTED="a b"\nSINGLE='c'\n\nEXPORTED=1 # trailing\n`;
  assert.deepEqual(readDotEnv(text), {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    QUOTED: 'a b',
    SINGLE: 'c',
    EXPORTED: '1',
  });
});

test('AC2: process env wins over .env; absent everywhere refuses naming .env.example; never hardcoded', () => {
  assert.equal(resolveAccountId({ CLOUDFLARE_ACCOUNT_ID: 'fromenv' }, `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`), 'fromenv');
  assert.equal(resolveAccountId({}, `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`), ACCOUNT);
  assert.throws(() => resolveAccountId({}, null), /\.env\.example/);
  assert.throws(() => resolveAccountId({ CLOUDFLARE_ACCOUNT_ID: '' }, ''), /\.env\.example/);
  // The script must not carry an account id of its own.
  const src = readFileSync(path.join(ROOT, 'scripts', 'deploy-web.mjs'), 'utf8');
  assert.doesNotMatch(src, /[0-9a-f]{32}/, 'a 32-hex literal in the script would be a hardcoded account id');
});

// ---------------------------------------------------------------------------
// AC3 — Cloudflare pre-flight
// ---------------------------------------------------------------------------

const cfOk = {
  versionOutput: ' ⛅️ wrangler 4.110.0 (update available 4.125.0)\n',
  whoamiOutput: `👋 You are logged in with an OAuth Token.\n│ Owner's Account │ ${ACCOUNT} │\n`,
  projectListOutput: '│ snug-website │ snug-website.pages.dev │\n│ snug-playground │ snug-playground.pages.dev │\n',
  accountId: ACCOUNT,
  apps: ['website', 'playground'],
};

test('AC3: cloudflarePreflight passes on wrangler ≥4 (banner OR bare-semver output), matching account, both projects present', () => {
  assert.doesNotThrow(() => cloudflarePreflight(cfOk));
  // The real `pnpm exec wrangler --version` shape (caught on the first smoke run):
  assert.doesNotThrow(() => cloudflarePreflight({ ...cfOk, versionOutput: '4.125.0\n' }));
});

test('AC3: cloudflarePreflight refuses wrangler <4, a different account, and a missing project (naming init)', () => {
  assert.throws(() => cloudflarePreflight({ ...cfOk, versionOutput: 'wrangler 3.99.0' }), /wrangler 4/);
  assert.throws(() => cloudflarePreflight({ ...cfOk, versionOutput: 'not a version' }), /wrangler/);
  assert.throws(
    () => cloudflarePreflight({ ...cfOk, whoamiOutput: '│ Other Account │ ffffffffffffffffffffffffffffffff │' }),
    /not logged in to account/,
  );
  assert.throws(
    () => cloudflarePreflight({ ...cfOk, projectListOutput: '│ snug-website │ snug-website.pages.dev │' }),
    /snug-playground.*init/s,
  );
});

// ---------------------------------------------------------------------------
// AC4 — git pre-flight
// ---------------------------------------------------------------------------

const gitClean = { branch: 'main', porcelain: '', head: 'abc123', originMain: 'abc123', preview: false };

test('AC4: production passes only on a clean main equal to origin/main', () => {
  assert.deepEqual(gitPreflight(gitClean), { mode: 'production', branch: 'main', dirty: false });
  assert.throws(() => gitPreflight({ ...gitClean, branch: 'feat/x' }), /main/);
  assert.throws(() => gitPreflight({ ...gitClean, porcelain: ' M scripts/x.mjs\n' }), /clean/);
  assert.throws(() => gitPreflight({ ...gitClean, originMain: 'def456' }), /origin\/main/);
});

test('AC4: preview deploys any OTHER branch (dirty allowed) and refuses main / detached HEAD', () => {
  assert.deepEqual(gitPreflight({ ...gitClean, branch: 'feat/x', porcelain: ' M a\n', preview: true }), {
    mode: 'preview',
    branch: 'feat/x',
    dirty: true,
  });
  assert.throws(() => gitPreflight({ ...gitClean, preview: true }), /preview.*main/s);
  assert.throws(() => gitPreflight({ ...gitClean, branch: 'HEAD', preview: true }), /detached/);
});

// ---------------------------------------------------------------------------
// AC5 — hosted-posture refusals (ADR-0013)
// ---------------------------------------------------------------------------

test('AC5a: the pinned build env disables hub auth, forces production site mode, and names the share relay', () => {
  assert.equal(PINNED_BUILD_ENV.VITE_SNUG_HUB_AUTH, '');
  assert.equal(PINNED_BUILD_ENV.PUBLIC_SITE_MODE, 'production');
  // TASK-20260904-share-link-ux AC8: the hosted playground's link transport is a build
  // invariant, pinned here rather than read from any env file (ADR-0064).
  assert.equal(PINNED_BUILD_ENV.VITE_SNUG_SHARE_RELAY, 'https://share.snugprotocol.org');
  assert.equal(Object.isFrozen(PINNED_BUILD_ENV), true);
});

test('AC5b/c: hostedPostureCheck refuses app-level .env* files and a staged local-artifacts dir; passes when clean', () => {
  // realIo.listEnvFiles ignores .env.example (Vite/Astro never read it) — pinned by the filter's exported twin.
  assert.deepEqual(isAppEnvFile('.env.example'), false);
  assert.deepEqual(['.env', '.env.local', '.env.production', 'x.env', 'README.md'].map(isAppEnvFile), [true, true, true, false, false]);
  assert.doesNotThrow(() => hostedPostureCheck({ app: 'playground', envFiles: [], localArtifactsExists: false }));
  assert.throws(
    () => hostedPostureCheck({ app: 'playground', envFiles: ['apps/playground/.env.local'], localArtifactsExists: false }),
    /apps\/playground\/\.env\.local/,
  );
  assert.throws(
    () => hostedPostureCheck({ app: 'website', envFiles: [], localArtifactsExists: true }),
    /local-artifacts/,
  );
});

test('AC5d: htmlTripwire refuses the local-mode fingerprints in website HTML and passes production HTML', () => {
  assert.doesNotThrow(() => htmlTripwire([{ path: 'index.html', text: '<a href="https://playground.snugprotocol.org">' }]));
  assert.throws(() => htmlTripwire([{ path: 'index.html', text: '<a href="http://localhost:5173">' }]), /index\.html.*localhost:5173/s);
  assert.throws(() => htmlTripwire([{ path: 'download/index.html', text: '<a href="/local-artifacts/Snug.dmg">' }]), /local-artifacts/);
});

// ---------------------------------------------------------------------------
// AC6 — build from a clean dist with the cache bypassed
// ---------------------------------------------------------------------------

test('AC6: buildArgv names the dependency closure via turbo and bypasses the cache', () => {
  assert.deepEqual(buildArgv('website'), ['pnpm', 'exec', 'turbo', 'run', 'build', '--filter=website', '--force']);
  assert.deepEqual(buildArgv('playground'), ['pnpm', 'exec', 'turbo', 'run', 'build', '--filter=playground', '--force']);
});

// ---------------------------------------------------------------------------
// AC7 — dist verification
// ---------------------------------------------------------------------------

const websiteDist = [
  { path: 'index.html', size: 10 },
  { path: '404.html', size: 10 },
  { path: 'download/index.html', size: 10 },
  { path: 'videos/teaser-landscape.mp4', size: 8 * 1024 * 1024 },
];
const playgroundDist = [
  { path: 'index.html', size: 10 },
  { path: 'assets/index-abc.js', size: 6 * 1024 * 1024 },
  { path: 'assets/sql-wasm-UFUCzYNW.wasm', size: 1024 },
];

test('AC7: verifyDist passes both well-formed manifests', () => {
  assert.doesNotThrow(() => verifyDist('website', websiteDist));
  assert.doesNotThrow(() => verifyDist('playground', playgroundDist));
});

test('AC7: verifyDist refuses missing index, >25 MiB files, >20k files', () => {
  assert.throws(() => verifyDist('website', websiteDist.filter((f) => f.path !== 'index.html')), /index\.html/);
  assert.throws(() => verifyDist('website', [...websiteDist, { path: 'big.bin', size: MAX_FILE_BYTES + 1 }]), /big\.bin.*25 MiB/s);
  const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.txt`, size: 1 }));
  assert.throws(() => verifyDist('playground', [...playgroundDist, ...many]), /20,?000/);
});

test('AC7: website requires 404.html and refuses local-artifacts/; playground requires NO 404.html and a sql.js wasm', () => {
  assert.throws(() => verifyDist('website', websiteDist.filter((f) => f.path !== '404.html')), /404\.html/);
  assert.throws(() => verifyDist('website', [...websiteDist, { path: 'local-artifacts/Snug.dmg', size: 1 }]), /local-artifacts/);
  assert.throws(() => verifyDist('playground', [...playgroundDist, { path: '404.html', size: 1 }]), /404\.html.*SPA/s);
  assert.throws(() => verifyDist('playground', playgroundDist.filter((f) => !f.path.endsWith('.wasm'))), /wasm/);
});

function walk(dir, prefix = '') {
  // Local recursive manifest — kept independent of the script's own walker on purpose.
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

test('AC7: the REAL dists pass the structural rules (named failure when a dist is absent — never a skip)', () => {
  for (const app of ['website', 'playground']) {
    const dist = path.join(ROOT, DIST_DIRS[app]);
    assert.ok(
      existsSync(path.join(dist, 'index.html')),
      `${DIST_DIRS[app]} is absent — run \`pnpm exec turbo run build --filter=${app}\` first (root \`pnpm test\` does this for you)`,
    );
    // The local-artifacts rule is pinned synthetically above: an owner tree that just ran
    // local E2E legitimately carries one, and the deploy script's refusal is the guard.
    const manifest = walk(dist).filter((f) => !f.path.startsWith('local-artifacts/'));
    assert.doesNotThrow(() => verifyDist(app, manifest), `${app} dist failed verifyDist`);
  }
});

// ---------------------------------------------------------------------------
// AC8 — command assembly as argv + dry default
// ---------------------------------------------------------------------------

test('AC8: wranglerCommand is an argv array carrying project, branch, sha and subject verbatim', () => {
  const argv = wranglerCommand({ app: 'website', mode: 'production', branch: 'main', sha: 'abc123', subject: "don't $(rm) it", dirty: false });
  assert.deepEqual(argv, [
    'wrangler', 'pages', 'deploy', DIST_DIRS.website,
    '--project-name', PROJECTS.website,
    '--branch', 'main',
    '--commit-hash', 'abc123',
    '--commit-message', "don't $(rm) it",
  ]);
  // Printing quotes; execution never goes through a shell.
  const printed = shellQuote(argv);
  assert.match(printed, /'don'\\''t \$\(rm\) it'/);
});

test('AC8: preview mode never emits --branch main and marks a dirty tree', () => {
  const argv = wranglerCommand({ app: 'playground', mode: 'preview', branch: 'feat/x', sha: 'abc', subject: 's', dirty: true });
  assert.equal(argv[argv.indexOf('--branch') + 1], 'feat/x');
  assert.ok(argv.includes('--commit-dirty=true'));
  assert.throws(() => wranglerCommand({ app: 'playground', mode: 'preview', branch: 'main', sha: 'abc', subject: 's', dirty: false }), /preview.*main/s);
  const prod = wranglerCommand({ app: 'playground', mode: 'production', branch: 'main', sha: 'abc', subject: 's', dirty: false });
  assert.ok(!prod.includes('--commit-dirty=true'));
});

// ---- main() through the io seam ------------------------------------------------

function fakeIo(overrides = {}) {
  const calls = [];
  const errors = [];
  const state = {
    branch: 'feat/x',
    porcelain: '',
    head: 'abc123',
    originMain: 'abc123',
    subject: 'TASK: ship',
    dotEnv: `CLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`,
    envFiles: { website: [], playground: [] },
    localArtifacts: false,
    manifests: { website: websiteDist, playground: playgroundDist },
    html: { website: [{ path: 'index.html', text: 'ok' }], playground: [] },
    wranglerProjects: cfOk.projectListOutput,
    ...overrides,
  };
  const io = {
    env: {},
    log: () => {},
    error: (msg) => errors.push(String(msg)),
    readDotEnvFile: () => state.dotEnv,
    listEnvFiles: (app) => state.envFiles[app],
    localArtifactsExists: () => state.localArtifacts,
    rmDist: (app) => calls.push(['rm', app]),
    manifest: (app) => state.manifests[app],
    htmlFiles: (app) => state.html[app],
    exec: (file, args, opts) => {
      calls.push([file, ...args]);
      const joined = [file, ...args].join(' ');
      if (joined.includes('wrangler --version')) return { status: 0, stdout: cfOk.versionOutput };
      if (joined.includes('wrangler whoami')) return { status: 0, stdout: cfOk.whoamiOutput };
      if (joined.includes('pages project list')) return { status: 0, stdout: state.wranglerProjects };
      if (joined.includes('rev-parse --abbrev-ref HEAD')) return { status: 0, stdout: `${state.branch}\n` };
      if (joined.includes('status --porcelain')) return { status: 0, stdout: state.porcelain };
      if (joined.includes('rev-parse origin/main')) return { status: 0, stdout: `${state.originMain}\n` };
      if (joined.includes('rev-parse HEAD')) return { status: 0, stdout: `${state.head}\n` };
      if (joined.includes('log -1')) return { status: 0, stdout: `${state.subject}\n` };
      if (joined.includes('fetch origin main')) return { status: 0, stdout: '' };
      if (joined.includes('turbo run build')) {
        calls.push(['build-env', opts?.env?.VITE_SNUG_HUB_AUTH, opts?.env?.PUBLIC_SITE_MODE, opts?.env?.CLOUDFLARE_ACCOUNT_ID]);
        return { status: 0, stdout: '' };
      }
      if (joined.includes('pages deploy')) {
        calls.push(['deploy-env', opts?.env?.CLOUDFLARE_ACCOUNT_ID, opts?.stdio]);
        return { status: 0, stdout: '' };
      }
      throw new Error(`unexpected exec: ${joined}`);
    },
  };
  return { io, calls, errors, state };
}
const isDeploy = (c) => c.includes('pages') && c.includes('deploy');

test('AC8: dry default — git fetch + turbo build run, wrangler deploy is NEVER called', async () => {
  const { io, calls } = fakeIo({ branch: 'main' });
  const code = await main(['website'], io);
  assert.equal(code, 0);
  assert.ok(calls.some((c) => c.join(' ').includes('fetch origin main')), 'git fetch must run in production mode');
  assert.ok(calls.some((c) => c.join(' ').includes('turbo run build --filter=website --force')), 'build must run');
  assert.ok(calls.some((c) => c[0] === 'rm' && c[1] === 'website'), 'dist must be removed before the build');
  assert.equal(calls.filter(isDeploy).length, 0);
});

test('AC8: --deploy performs exactly one wrangler deploy per app, and `all` verifies both before uploading either', async () => {
  const { io, calls } = fakeIo({ branch: 'main' });
  assert.equal(await main(['all', '--deploy'], io), 0);
  const deploys = calls.filter(isDeploy);
  assert.equal(deploys.length, 2);
  const firstDeploy = calls.findIndex(isDeploy);
  const lastBuild = calls.map((c) => c.join(' ')).reduce((acc, s, i) => (s.includes('turbo run build') ? i : acc), -1);
  assert.ok(lastBuild < firstDeploy, 'both builds must precede the first upload');
});

test('AC8: main passes the pinned build env and the account id into the build and wrangler', async () => {
  const { io, calls } = fakeIo({ branch: 'main' });
  await main(['playground', '--deploy'], io);
  const envCall = calls.find((c) => c[0] === 'build-env');
  assert.deepEqual(envCall, ['build-env', '', 'production', ACCOUNT]);
  // The upload runs with the SAME resolved account id (checked == deploying) and inherits stdio.
  const deployEnv = calls.find((c) => c[0] === 'deploy-env');
  assert.deepEqual(deployEnv, ['deploy-env', ACCOUNT, 'inherit']);
});

test('AC8: main refuses (exit 1, named reason, no deploy) on each pre-flight failure', async () => {
  const cases = [
    ['wrong branch', { branch: 'feat/x' }, ['website', '--deploy'], /only from main/],
    ['dirty tree', { branch: 'main', porcelain: ' M x\n' }, ['website', '--deploy'], /not clean/],
    ['behind origin', { branch: 'main', originMain: 'zzz' }, ['website', '--deploy'], /origin\/main/],
    ['preview on main', { branch: 'main' }, ['website', '--preview', '--deploy'], /would deploy to PRODUCTION/],
    ['app .env file', { branch: 'main', envFiles: { website: [], playground: ['apps/playground/.env'] } }, ['playground', '--deploy'], /apps\/playground\/\.env/],
    ['staged DMG', { branch: 'main', localArtifacts: true }, ['website', '--deploy'], /local-artifacts/],
    ['local html', { branch: 'main', html: { website: [{ path: 'index.html', text: 'localhost:5173' }], playground: [] } }, ['website', '--deploy'], /localhost:5173/],
    ['missing project', { branch: 'main', wranglerProjects: '│ snug-website │' }, ['playground', '--deploy'], /snug-playground.*init/s],
    ['no account', { branch: 'main', dotEnv: null }, ['website', '--deploy'], /\.env\.example/],
  ];
  for (const [name, overrides, argv, reason] of cases) {
    const { io, calls, errors } = fakeIo(overrides);
    const code = await main(argv, io);
    assert.equal(code, 1, `${name}: must refuse with exit 1 (got ${code}; stderr: ${errors.join(' | ')})`);
    assert.match(errors.join('\n'), reason, `${name}: must refuse for the RIGHT reason`);
    assert.equal(calls.filter(isDeploy).length, 0, `${name}: must not deploy`);
  }
});

test('AC8: preview from a feature branch deploys with that branch and --commit-dirty when dirty', async () => {
  const { io, calls } = fakeIo({ branch: 'feat/x', porcelain: ' M x\n' });
  assert.equal(await main(['website', '--preview', '--deploy'], io), 0);
  const deploy = calls.find(isDeploy);
  assert.equal(deploy[deploy.indexOf('--branch') + 1], 'feat/x');
  assert.ok(deploy.includes('--commit-dirty=true'));
  assert.ok(!calls.some((c) => c.join(' ').includes('fetch origin main')), 'preview does not need the network');
});

// ---------------------------------------------------------------------------
// AC9 — wired, not dead coverage
// ---------------------------------------------------------------------------

test('AC9: root package.json runs this file via check-deploy-web inside `test`, and wrangler is a devDependency', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['check-deploy-web'], 'node --test scripts/deploy-web.test.mjs');
  assert.match(pkg.scripts.test, /pnpm run check-deploy-web/);
  assert.match(pkg.devDependencies.wrangler ?? '', /^\^4/);
});

// ---------------------------------------------------------------------------
// AC10 — runbook, example env, hygiene
// ---------------------------------------------------------------------------

test('AC10: .env.example carries the key, .gitignore ignores .wrangler/, and the runbook names every out-of-git fact', () => {
  assert.match(readFileSync(path.join(ROOT, '.env.example'), 'utf8'), /^CLOUDFLARE_ACCOUNT_ID=/m);
  assert.match(readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.wrangler\/$/m);
  const runbook = readFileSync(path.join(ROOT, 'docs', 'runbooks', 'deploy-web.md'), 'utf8');
  for (const needle of [
    'scripts/deploy-web.mjs',
    'snug-website',
    'snug-playground',
    'snugprotocol.org',
    'www.snugprotocol.org',
    'playground.snugprotocol.org',
    'Redirect Rule',
    'Email Address Obfuscation',
    'Rocket Loader',
    'Auto Minify',
    'Web Analytics',
    'Access policy',
    'Bulk Redirect',
    'cdn-cgi',
    'schema version',
    'Rollback',
  ]) {
    assert.ok(runbook.includes(needle), `runbook must mention: ${needle}`);
  }
  // No account email or id in the public tree (the project's own domain is the only one allowed).
  assert.doesNotMatch(runbook, /[\w.+-]+@(?!snugprotocol\.org)[\w-]+\.[a-z]{2,}|[0-9a-f]{32}/i);
});
