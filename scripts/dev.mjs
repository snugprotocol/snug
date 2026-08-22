// dev.mjs — TASK-20260821-site-playground-polish AC7: one command for the local dev pair.
//
// `pnpm dev` = build the server (its `dev` script runs dist/, so the build is not
// optional), then run server + playground vite together with prefixed output and
// one Ctrl-C tearing both down. Exists because the two-process dance kept producing
// half-killed vite servers whose interrupted dep re-optimization leaves
// node_modules/.vite in a state where every app 504s ("Outdated Optimize Dep");
// recovery for that state: delete apps/playground/node_modules/.vite and rerun.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Pure command plan — tested by dev.test.mjs. */
export function devPlan({ envLocalExists, env }) {
  const port = env.SNUG_SERVER_PORT;
  const portEnv = port ? { SNUG_SERVER_PORT: port } : {};
  return {
    build: { cmd: 'pnpm', args: ['--filter', 'server', 'build'] },
    server: {
      cmd: 'pnpm',
      args: ['--filter', 'server', envLocalExists ? 'dev:local' : 'dev'],
      label: 'server',
      env: { ...portEnv },
    },
    playground: {
      cmd: 'pnpm',
      args: ['--filter', 'playground', 'dev'],
      label: 'playground',
      env: { ...portEnv },
    },
  };
}

function prefixPipe(stream, label, out) {
  let carry = '';
  stream.on('data', (chunk) => {
    const lines = (carry + chunk.toString()).split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) out.write(`[${label}] ${line}\n`);
  });
  stream.on('end', () => {
    if (carry) out.write(`[${label}] ${carry}\n`);
  });
}

function run(step) {
  return spawn(step.cmd, step.args, {
    cwd: ROOT,
    env: { ...process.env, ...(step.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main() {
  const plan = devPlan({
    envLocalExists: existsSync(path.join(ROOT, 'apps/server/.env.local')),
    env: process.env,
  });

  process.stdout.write('[dev] building server…\n');
  const build = run(plan.build);
  prefixPipe(build.stdout, 'build', process.stdout);
  prefixPipe(build.stderr, 'build', process.stderr);
  const buildCode = await new Promise((resolve) => build.on('exit', resolve));
  if (buildCode !== 0) {
    process.stderr.write(`[dev] server build failed (exit ${buildCode})\n`);
    process.exit(buildCode ?? 1);
  }

  const children = [plan.server, plan.playground].map((step) => {
    const child = run(step);
    prefixPipe(child.stdout, step.label, process.stdout);
    prefixPipe(child.stderr, step.label, process.stderr);
    return { child, label: step.label };
  });

  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    // Give vite/node a moment to flush; SIGKILL backstop so Ctrl-C never hangs.
    setTimeout(() => {
      for (const { child } of children) {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      process.exit(code);
    }, 2000).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  for (const { child, label } of children) {
    child.on('exit', (code) => {
      if (!shuttingDown) {
        process.stderr.write(`[dev] ${label} exited (${code}) — stopping the pair\n`);
        shutdown(code ?? 1);
      }
    });
  }
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) await main();
