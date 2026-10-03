// The process, composed ONCE (K5).
//
// There used to be two composition roots: `main.ts` for the release and a hand-written copy
// inside `main.test-hooks.ts` for the browser suite. The copy had no grace, no parent watch
// and no signal handling — so the e2e was never running the lifecycle the product ships, and
// a change to one root was invisible to the other. Both entries now call `startProcess` and
// differ only in the HOOKS they hand it.
//
// THE DEFAULTS ARE INERT, deliberately (D-B34's rule, generalised): with no hooks this
// reaches no real home, opens no browser and probes no CLI. Each of those is something the
// release entry says out loud, so the test entry cannot acquire one by forgetting to
// override it.
//
// HANDSHAKE FIRST (L2). In MCP mode the stdio server is attached before anything that can
// fail is attempted, and nothing in here throws: a home that cannot be resolved and a
// damaged install are refusals the tools answer with, like every other row of the table.
// (No Node at all is the launcher's sentence — it cannot be this process's.)

import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VERSION } from './build.js';
import { positionalVerb, runCli } from './cli.js';
import { controlCall } from './control-socket.js';
import { resolveHome } from './home.js';
import { askToStop, isAlive, readCommandLine } from './identity.js';
import { readLock } from './lock.js';
import { createMcpServer } from './mcp/server.js';
import { locatePage } from './page.js';
import { watchParent } from './parent-watch.js';
import { refusalFor, refusalSentence } from './refusals.js';
import { createRefusedRunner, createRunner, type Runner, type RunnerOptions, type RunnerStart } from './runner.js';

/**
 * How long a shutdown may take before the process exits anyway (L4). A stop that waits on a
 * wedged listener or a child that will not die would otherwise leave a runner that has
 * released its lock and still holds a port.
 */
export const EXIT_DEADLINE_MS = 5_000;

export interface ProcessHooks extends Pick<RunnerOptions, 'openBrowser' | 'heldBy' | 'brainState' | 'brain' | 'models' | 'proxy' | 'graceMs' | 'ports'> {
  /**
   * Opt in to the user's real `~/Snug`. The release entry passes this; nothing else may
   * (D-B34 — a test once destroyed the owner's user file by reaching it by default).
   */
  allowRealHome?: boolean;
  /** Told once the first start has settled. The test entry prints its ready line from here. */
  onStarted?(started: RunnerStart): void;
}

/** A path as one shell word, for a line a person will paste. */
const shellWord = (value: string): string => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);

/**
 * How the human CLI is run on THIS install (L5). The plugin ships the launcher beside the
 * bundle (`scripts/snug`), and the launcher is what finds Node under a desktop host — so
 * that is the line to give a person. Straight out of the repo there is no launcher, and the
 * honest line is this Node running this file.
 */
export function cliCommand(bundleFile: string): string {
  const launcher = path.join(path.dirname(bundleFile), 'snug');
  try {
    if (statSync(launcher).isFile()) return `sh ${shellWord(launcher)}`;
  } catch {
    /* no launcher beside the bundle */
  }
  return `${shellWord(process.execPath)} ${shellWord(bundleFile)}`;
}

/**
 * Stop, then exit — and exit anyway at the deadline. `exit` is injected so this can be
 * shown to fire; the process passes `process.exit`.
 */
export function shutdownWithin(stop: () => Promise<void>, exit: (code: number) => void, deadlineMs: number = EXIT_DEADLINE_MS): void {
  // Unref'd, so a clean stop is not held open by its own backstop.
  setTimeout(() => exit(1), deadlineMs).unref();
  void stop().then(
    () => exit(0),
    () => exit(1),
  );
}

export async function startProcess({ hooks }: { hooks: ProcessHooks }): Promise<void> {
  const { allowRealHome, onStarted, ...runnerHooks } = hooks;
  const bundleFile = fileURLToPath(import.meta.url);
  const cli = cliCommand(bundleFile);
  const home = (): string => resolveHome({ allowRealHome: allowRealHome === true });

  // A PERSON ran it with a verb: talk to the primary over the control socket and print the
  // answer to their terminal. MCP mode is only ever the absence of a verb.
  const args = process.argv.slice(2);
  if (positionalVerb(args) !== undefined) {
    // `exitCode`, not `exit()`: what the verb printed must drain to a pipe before the process goes.
    process.exitCode = await runCli(args, {
      home,
      call: controlCall,
      readLock,
      isAlive,
      commandLineOf: readCommandLine,
      kill: askToStop,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      out: (line) => void process.stdout.write(`${line}\n`),
      err: (line) => void process.stderr.write(`${line}\n`),
      isTTY: process.stdout.isTTY === true,
      command: cli,
    });
    return;
  }

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    shutdownWithin(() => runner.stop(), (code) => process.exit(code));
  };

  // The two refusals that are decided before a runner can exist. Neither can change inside
  // a running process, so neither is retried.
  const runner: Runner = ((): Runner => {
    let resolved: string;
    try {
      resolved = home();
    } catch {
      return createRefusedRunner(refusalFor('home-unresolved', { cli }));
    }
    // The page is read ONCE, here: bytes that were checked are the bytes that are served.
    const page = locatePage(path.dirname(bundleFile));
    // D8: a damaged install binds NOTHING — no lock, no socket, no listener (decided
    // 2026-10-03). It answers the handshake and this refusal, and that is its whole channel:
    // a healthy install started beside it leads at the fixed port as if it were not there.
    if (page.damaged) return createRefusedRunner(refusalFor('page-damaged', { cli, home: resolved }));
    const { html } = page;
    return createRunner({ ...runnerHooks, home: resolved, page: () => html, cli, onStopRequested: shutdown });
  })();

  const server = createMcpServer({ callTool: (name, toolArgs) => runner.callTool(name, toolArgs), serverVersion: VERSION });
  server.attach(process.stdin, (line) => process.stdout.write(`${line}\n`));

  // stdin closing means THIS session is done, not that the runner is: another window may
  // still be attached, so the grace decides (D-B9).
  process.stdin.on('end', () => runner.beginGrace(shutdown));
  // A host that went away without closing the pipe shows up as a failed write instead; an
  // unhandled `error` here would be an uncaught exception with the lock still held.
  process.stdout.on('error', () => runner.beginGrace(shutdown));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Every spawn owes a parent watch on a CHANGED ppid (lessons 2026-08-18/19).
  watchParent({ onOrphaned: () => runner.beginGrace(shutdown) });
  process.stdin.resume();

  const started = await runner.start();
  // stderr is the host's log, never the transport: the one line that says why, with no
  // address and no token in it.
  if (started.refusal !== undefined) process.stderr.write(`Snug: ${refusalSentence(started.refusal)}\n`);
  onStarted?.(started);
}
