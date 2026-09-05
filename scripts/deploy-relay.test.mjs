// deploy-relay.test.mjs — the pure parts of deploy-relay.mjs (root `check-deploy-relay`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  RATE_LIMIT_TARGET,
  RELAY_CONFIG,
  assertLoopbackOrigin,
  configPreflight,
  initCommands,
  main,
  mergeRateLimitRules,
  parseArgs,
  parseJsonc,
  rateLimitRuleFor,
  ratelimitMain,
  resolveWafToken,
  wranglerCommand,
} from './deploy-relay.mjs';

const shipped = () => parseJsonc(readFileSync(new URL(`../${RELAY_CONFIG}`, import.meta.url), 'utf8'));

test('parseArgs: init / --deploy / unknown', () => {
  assert.deepEqual(parseArgs(['node', 'x']), { init: false, deploy: false });
  assert.deepEqual(parseArgs(['node', 'x', '--deploy']), { init: false, deploy: true });
  assert.deepEqual(parseArgs(['node', 'x', 'init']), { init: true, deploy: false });
  assert.deepEqual(parseArgs(['node', 'x', 'ratelimit']), { init: false, deploy: false, ratelimit: true, apply: false });
  assert.deepEqual(parseArgs(['node', 'x', 'ratelimit', '--apply']), { init: false, deploy: false, ratelimit: true, apply: true });
  assert.throws(() => parseArgs(['node', 'x', '--apply']), /--apply belongs to ratelimit/);
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
  assert.ok(init.some((l) => /deploy-relay.mjs ratelimit/.test(l)), 'the WAF rule is a scripted act (TASK-20260904-share-link-ux AC9)');
  assert.ok(!init.some((l) => /dashboard ONLY/.test(l)));
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

// ---------------------------------------------------------------------------
// TASK-20260904-share-link-ux AC9 — the rate-limit rule as a print-and-stop act
// ---------------------------------------------------------------------------

test('rateLimitRuleFor: the runbook numbers on a plan that allows them; clamped WITH the clamp named on a plan that does not', () => {
  assert.deepEqual(RATE_LIMIT_TARGET, { requests: 20, period: 60, timeout: 600 });
  const business = rateLimitRuleFor('business');
  assert.deepEqual(business.clamped, []);
  assert.equal(business.rule.action, 'block');
  assert.equal(business.rule.enabled, true);
  assert.deepEqual(business.rule.ratelimit, { characteristics: ['ip.src', 'cf.colo.id'], period: 60, requests_per_period: 20, mitigation_timeout: 600 });
  assert.match(business.rule.expression, /http\.host eq "share\.snugprotocol\.org"/);
  assert.match(business.rule.expression, /http\.request\.method eq "POST"/);
  assert.match(business.rule.expression, /http\.request\.uri\.path eq "\/v1\/bundles"/);
  assert.equal(business.rule.description, 'snug-share-relay: uploads per IP (deploy-relay.mjs ratelimit)');
  // Pro: a 60 s period is allowed, a 600 s timeout is not → the largest allowed timeout, named.
  const pro = rateLimitRuleFor('pro');
  assert.equal(pro.rule.ratelimit.period, 60);
  assert.equal(pro.rule.ratelimit.requests_per_period, 20);
  assert.equal(pro.rule.ratelimit.mitigation_timeout, 600);
  assert.deepEqual(pro.clamped, []);
  // Free: only a 10 s period and a 10 s timeout exist → the SAME rate over 10 s (20/60 s = 4/10 s, rounded up), named twice.
  const free = rateLimitRuleFor('free');
  assert.deepEqual(free.rule.ratelimit, { characteristics: ['ip.src', 'cf.colo.id'], period: 10, requests_per_period: 4, mitigation_timeout: 10 });
  assert.equal(free.clamped.length, 2);
  assert.match(free.clamped[0], /period 60 s → 10 s/);
  assert.match(free.clamped[1], /timeout 600 s → 10 s/);
  assert.equal(rateLimitRuleFor('enterprise').clamped.length, 0);
  assert.throws(() => rateLimitRuleFor('mystery'), /unknown plan/);
});

test('mergeRateLimitRules: replaces the relay rule by description, keeps every other rule, appends when absent', () => {
  const ours = rateLimitRuleFor('business').rule;
  const other = { description: 'someone else', expression: 'true', action: 'block', ratelimit: { characteristics: ['ip.src'], period: 10, requests_per_period: 1, mitigation_timeout: 10 } };
  assert.deepEqual(mergeRateLimitRules([], ours), [ours]);
  assert.deepEqual(mergeRateLimitRules([other], ours), [other, ours]);
  const stale = { ...ours, id: 'rule-1', ratelimit: { ...ours.ratelimit, requests_per_period: 999 } };
  const merged = mergeRateLimitRules([other, stale], ours);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, 'rule-1', 'the existing rule id is kept so the PUT updates rather than recreates');
  assert.equal(merged[1].ratelimit.requests_per_period, 20);
});

test('resolveWafToken: env, then root .env, else a refusal naming the scopes — and NEVER CLOUDFLARE_API_TOKEN (wrangler would adopt it)', () => {
  assert.equal(resolveWafToken({ CLOUDFLARE_WAF_TOKEN: ' t1 ' }, null), 't1');
  assert.equal(resolveWafToken({}, 'CLOUDFLARE_ACCOUNT_ID=a\nCLOUDFLARE_WAF_TOKEN=t2\n'), 't2');
  assert.throws(() => resolveWafToken({ CLOUDFLARE_API_TOKEN: 'nope' }, null), /CLOUDFLARE_WAF_TOKEN.*Zone WAF/s);
});

function wafIo({ plan = 'business', existing = null, calls, logs, env = { CLOUDFLARE_WAF_TOKEN: 'tok' } } = {}) {
  return {
    env,
    log: (s) => logs.push(s),
    error: (s) => logs.push(`ERR ${s}`),
    readDotEnvFile: () => null,
    http: async (method, url, body) => {
      calls.push({ method, url, body });
      if (method === 'GET' && /\/zones\?name=snugprotocol\.org$/.test(url)) {
        return { status: 200, json: { success: true, result: [{ id: 'zone-1', name: 'snugprotocol.org', plan: { legacy_id: plan } }] } };
      }
      if (method === 'GET' && /\/zones\/zone-1\/rulesets\/phases\/http_ratelimit\/entrypoint$/.test(url)) {
        return existing === null ? { status: 404, json: { success: false, errors: [{ code: 10000 }] } } : { status: 200, json: { success: true, result: existing } };
      }
      if (method === 'PUT' && /\/zones\/zone-1\/rulesets\/phases\/http_ratelimit\/entrypoint$/.test(url)) {
        return { status: 200, json: { success: true, result: { id: 'rs-1', rules: body.rules.map((r, i) => ({ ...r, id: r.id ?? `new-${i}` })) } } };
      }
      return { status: 404, json: { success: false } };
    },
  };
}

test('ratelimit prints the rule and STOPS without --apply; writes the merged entrypoint with it; refuses without a token', async () => {
  const calls = [];
  const logs = [];
  assert.equal(await ratelimitMain({ apply: false }, wafIo({ calls, logs })), 0);
  assert.ok(!calls.some((c) => c.method === 'PUT'), 'no write without --apply');
  assert.ok(logs.some((l) => /zone-1/.test(l) && /business/.test(l)));
  assert.ok(logs.some((l) => /20 requests per 60 s per IP, block 600 s/.test(l)));
  assert.ok(logs.some((l) => /printed, not applied/.test(l)));

  calls.length = 0;
  const other = { id: 'r-other', description: 'someone else', expression: 'true', action: 'block', ratelimit: { characteristics: ['ip.src'], period: 10, requests_per_period: 1, mitigation_timeout: 10 } };
  assert.equal(await ratelimitMain({ apply: true }, wafIo({ calls, logs, existing: { id: 'rs-1', rules: [other] } })), 0);
  const put = calls.find((c) => c.method === 'PUT');
  assert.ok(put, 'the PUT happened');
  assert.equal(put.body.rules.length, 2);
  assert.equal(put.body.rules[0].id, 'r-other', 'a stranger rule survives');
  assert.equal(put.body.rules[1].ratelimit.requests_per_period, 20);
  assert.ok(logs.some((l) => /applied .*journal/.test(l)));

  // Free plan: the clamp is printed, not hidden.
  logs.length = 0;
  assert.equal(await ratelimitMain({ apply: false }, wafIo({ calls, logs, plan: 'free' })), 0);
  assert.ok(logs.some((l) => /clamped/.test(l) && /period 60 s → 10 s/.test(l)));

  logs.length = 0;
  assert.equal(await ratelimitMain({ apply: false }, wafIo({ calls, logs, env: {} })), 1);
  assert.ok(logs.some((l) => /CLOUDFLARE_WAF_TOKEN/.test(l)));
});
