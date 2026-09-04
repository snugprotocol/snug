// deploy-relay.test.mjs — the pure parts of deploy-relay.mjs (root `check-deploy-relay`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RELAY_CONFIG, assertLoopbackOrigin, configPreflight, initCommands, main, parseArgs, parseJsonc, wranglerCommand } from './deploy-relay.mjs';

const shipped = () => parseJsonc(readFileSync(new URL(`../${RELAY_CONFIG}`, import.meta.url), 'utf8'));

test('parseArgs: init / --deploy / unknown', () => {
  assert.deepEqual(parseArgs(['node', 'x']), { init: false, deploy: false });
  assert.deepEqual(parseArgs(['node', 'x', '--deploy']), { init: false, deploy: true });
  assert.deepEqual(parseArgs(['node', 'x', 'init']), { init: true, deploy: false });
  assert.throws(() => parseArgs(['node', 'x', '--preview']), /unknown argument/);
});

test('the shipped wrangler.jsonc IS the blind shape (and the preflight refuses each widening)', () => {
  const config = shipped();
  assert.doesNotThrow(() => configPreflight(config));
  assert.throws(() => configPreflight({ ...config, observability: { enabled: true } }), /no request logging/);
  assert.throws(() => configPreflight({ ...config, kv_namespaces: [] }), /kv_namespaces must be absent/);
  assert.throws(() => configPreflight({ ...config, workers_dev: true }), /workers_dev/);
  assert.throws(() => configPreflight({ ...config, r2_buckets: [] }), /exactly one R2 binding/);
  assert.throws(() => configPreflight({ ...config, routes: [] }), /exactly one route/);
  assert.throws(() => configPreflight({ ...config, analytics_engine_datasets: [] }), /no telemetry/);
});

test('the wrangler argv names the config and carries the sha; init prints the one-time setup', () => {
  const argv = wranglerCommand({ sha: 'abc123' });
  assert.deepEqual(argv.slice(0, 6), ['pnpm', 'exec', 'wrangler', 'deploy', '--config', RELAY_CONFIG]);
  assert.ok(argv.includes('DEPLOY_SHA:abc123'));
  const init = initCommands();
  assert.ok(init.some((l) => /r2 bucket create/.test(l)));
  assert.ok(init.some((l) => /Rate limiting/.test(l)));
  // The two facts the owner's first real run needed (2026-09-04): the deploy refuses off
  // main, so MERGE comes before every other step; and the lifecycle rule is a wrangler
  // command, not a dashboard-only act (verified against `wrangler r2 bucket lifecycle
  // add --help`). Both are printed, so a reader of `init` cannot walk into the refusal
  // or into the dashboard for something the CLI does.
  assert.ok(init.some((l) => /git switch main/.test(l)), 'init must say merge-then-main first');
  assert.ok(init.some((l) => /r2 bucket lifecycle add .* --expire-days 31/.test(l)), 'the lifecycle rule is a CLI command');
  assert.ok(init.some((l) => /dashboard ONLY/.test(l)), 'the WAF rule is the one dashboard step, and says so');
});

test('--dev-origin is ADDITIVE, loopback-only, and never sticky', async () => {
  const { assertLoopbackOrigin } = await import('./deploy-relay.mjs');
  // Additive: the config's pinned origins survive and the dev origin is appended.
  const argv = wranglerCommand({ sha: 'abc', devOrigin: 'http://localhost:5173', configOrigins: ['https://playground.snugprotocol.org', 'tauri://localhost'] });
  const varArg = argv[argv.indexOf('--var', argv.indexOf('--var') + 1) + 1];
  assert.equal(varArg, 'ALLOWED_ORIGINS:https://playground.snugprotocol.org,tauri://localhost,http://localhost:5173');
  // Absent by default — an ordinary deploy carries no origin override at all, which is
  // what makes the flag non-sticky (the next deploy restores the config-only list).
  assert.ok(!wranglerCommand({ sha: 'abc' }).some((a) => String(a).startsWith('ALLOWED_ORIGINS:')));
  // Loopback only: a public origin belongs in the reviewed config, not in a flag.
  assert.equal(assertLoopbackOrigin('http://localhost:5173'), 'http://localhost:5173');
  assert.equal(assertLoopbackOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  assert.throws(() => assertLoopbackOrigin('https://evil.example'), /not loopback/);
  assert.throws(() => assertLoopbackOrigin('https://playground.snugprotocol.org'), /not loopback/);
  assert.throws(() => assertLoopbackOrigin('not-a-url'), /not a URL/);
  assert.throws(() => assertLoopbackOrigin('http://localhost:5173/path'), /bare origin/);
  // The flag needs a value.
  assert.throws(() => parseArgs(['n', 'x', '--dev-origin']), /needs a value/);
  assert.throws(() => parseArgs(['n', 'x', '--dev-origin', '--deploy']), /needs a value/);
});

test('main prints and STOPS without --deploy; deploys only with it (the exec seam is observed)', () => {
  const calls = [];
  const logs = [];
  const io = {
    env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
    log: (s) => logs.push(s),
    error: (s) => logs.push(`ERR ${s}`),
    readDotEnvFile: () => null,
    readConfig: () => readFileSync(new URL(`../${RELAY_CONFIG}`, import.meta.url), 'utf8'),
    exec: (file, args) => {
      calls.push([file, ...args].join(' '));
      const joined = args.join(' ');
      if (joined === 'exec wrangler --version') return { status: 0, stdout: '4.30.0\n' };
      if (joined === 'exec wrangler whoami') return { status: 0, stdout: 'Account ID acct-1\n' };
      if (joined === 'rev-parse --abbrev-ref HEAD') return { status: 0, stdout: 'main\n' };
      if (joined === 'status --porcelain') return { status: 0, stdout: '' };
      if (joined === 'rev-parse HEAD') return { status: 0, stdout: 'deadbeefdeadbeef\n' };
      if (joined === 'rev-parse origin/main') return { status: 0, stdout: 'deadbeefdeadbeef\n' };
      if (joined === 'log -1 --pretty=%s') return { status: 0, stdout: 'subject\n' };
      if (joined === '--filter share-relay test') return { status: 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
  };
  assert.equal(main(['node', 'x'], io), 0);
  assert.ok(!calls.some((c) => /wrangler deploy/.test(c)), 'no deploy without --deploy');
  assert.ok(logs.some((l) => /printed, not run/.test(l)));
  calls.length = 0;
  assert.equal(main(['node', 'x', '--deploy'], io), 0);
  assert.ok(calls.some((c) => /wrangler deploy --config apps\/share-relay\/wrangler.jsonc/.test(c)));
});

test('main refuses a dirty tree, a non-main branch, and a red relay suite', () => {
  const base = (over) => ({
    env: { CLOUDFLARE_ACCOUNT_ID: 'acct-1' },
    log: () => undefined,
    error: () => undefined,
    readDotEnvFile: () => null,
    readConfig: () => readFileSync(new URL(`../${RELAY_CONFIG}`, import.meta.url), 'utf8'),
    exec: (file, args) => {
      const joined = args.join(' ');
      if (joined === 'exec wrangler --version') return { status: 0, stdout: '4.30.0\n' };
      if (joined === 'exec wrangler whoami') return { status: 0, stdout: 'acct-1\n' };
      if (joined === 'rev-parse --abbrev-ref HEAD') return { status: 0, stdout: `${over.branch ?? 'main'}\n` };
      if (joined === 'status --porcelain') return { status: 0, stdout: over.dirty ? ' M x\n' : '' };
      if (joined === 'rev-parse HEAD' || joined === 'rev-parse origin/main') return { status: 0, stdout: 'aaaa\n' };
      if (joined === '--filter share-relay test') return { status: over.red ? 1 : 0, stdout: '' };
      return { status: 0, stdout: '' };
    },
  });
  assert.equal(main(['node', 'x'], base({ dirty: true })), 1);
  assert.equal(main(['node', 'x'], base({ branch: 'feat/x' })), 1);
  assert.equal(main(['node', 'x'], base({ red: true })), 1);
});
