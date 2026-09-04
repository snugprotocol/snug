// deploy-relay.test.mjs — the pure parts of deploy-relay.mjs (root `check-deploy-relay`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { RELAY_CONFIG, configPreflight, initCommands, main, parseArgs, parseJsonc, wranglerCommand } from './deploy-relay.mjs';

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
  assert.ok(initCommands().some((l) => /r2 bucket create/.test(l)));
  assert.ok(initCommands().some((l) => /Rate limiting/.test(l)));
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
