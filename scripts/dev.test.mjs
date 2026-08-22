// dev.test.mjs — TASK-20260821-site-playground-polish AC7.
//
// node:test over the dev runner's PURE half (`devPlan`). The impure half (spawn,
// prefixing, teardown) is exercised by running `pnpm dev`; what these tests pin is
// the command construction — the part that silently drifts when package scripts
// change (the server's `dev` runs dist/, so a missing build step yields a stale or
// absent server that LOOKS like the playground's fault).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { devPlan } from './dev.mjs';

test('build step precedes the server start and targets the server package', () => {
  const plan = devPlan({ envLocalExists: false, env: {} });
  assert.equal(plan.build.cmd, 'pnpm');
  assert.deepEqual(plan.build.args, ['--filter', 'server', 'build']);
});

test('server uses dev:local when apps/server/.env.local exists, dev otherwise', () => {
  const withEnv = devPlan({ envLocalExists: true, env: {} });
  const without = devPlan({ envLocalExists: false, env: {} });
  assert.deepEqual(withEnv.server.args, ['--filter', 'server', 'dev:local']);
  assert.deepEqual(without.server.args, ['--filter', 'server', 'dev']);
});

test('playground runs vite dev and both long-lived processes carry labels', () => {
  const plan = devPlan({ envLocalExists: false, env: {} });
  assert.deepEqual(plan.playground.args, ['--filter', 'playground', 'dev']);
  assert.equal(plan.server.label, 'server');
  assert.equal(plan.playground.label, 'playground');
});

test('SNUG_SERVER_PORT rides through to BOTH processes or neither desyncs the pair', () => {
  // vite.config.ts proxies /auth etc. to SNUG_SERVER_PORT ?? 8787 — a value set for
  // one process but not the other recreates the exact /auth/me-unreachable class.
  const plan = devPlan({ envLocalExists: false, env: { SNUG_SERVER_PORT: '9001' } });
  assert.equal(plan.server.env.SNUG_SERVER_PORT, '9001');
  assert.equal(plan.playground.env.SNUG_SERVER_PORT, '9001');
  const unset = devPlan({ envLocalExists: false, env: {} });
  assert.equal('SNUG_SERVER_PORT' in unset.server.env, false);
  assert.equal('SNUG_SERVER_PORT' in unset.playground.env, false);
});

test('a set-but-empty SNUG_SERVER_PORT is dropped, not forwarded', () => {
  // vite.config.ts documents that '' desyncs the pair (Number('') || 8787 vs the
  // server's own default read) — the runner must not launder that state through.
  const plan = devPlan({ envLocalExists: false, env: { SNUG_SERVER_PORT: '' } });
  assert.equal('SNUG_SERVER_PORT' in plan.server.env, false);
  assert.equal('SNUG_SERVER_PORT' in plan.playground.env, false);
});
