// The human CLI (ADR-0068; L4, L5): `snug status | open [--print] | stop [--force]`.
//
// One binary, two shapes. Started by a host with no verb it speaks MCP over stdio; run by a
// PERSON with a verb it talks to the running primary over the control socket and prints the
// answer to THEIR terminal. Everything it does goes through `controlCall`, and everything
// it trusts is an answer that carries the positive ack of the op it asked.
//
// THE BEARER (L5). The launch address with its token leaves the runner by exactly one op,
// `launch-url`, and this file is its only caller. It asks only when stdout is a terminal:
// an agent that runs `snug open --print` through a shell tool has a PIPE for stdout, and a
// pipe is a transcript. Not asking is stronger than not printing — the token never enters
// this process at all. (Before this range the socket's `open` answered the tokened address
// to whoever asked, and the CLI printed it wherever stdout pointed.)
//
// `stop` IS THE REMEDY the refusal table names, so it has to work against what is really
// running — including a build from before `stop` existed. That one is signalled, and only
// when BOTH hold: the socket answers with the hash the lock records, and the lock's pid has
// our command line. The pid is taken from the lock, never from the socket's answer.

import path from 'node:path';

import { acked, type ControlAnswer, type ControlCallRequest } from './control-socket.js';
import { isSnugCommandLine } from './identity.js';
import { controlSocketPath, type LockRecord } from './lock.js';
import { refusalFor, refusalSentence } from './refusals.js';

export const CLI_VERBS = ['status', 'open', 'stop'] as const;
type Verb = (typeof CLI_VERBS)[number];

/** The flags each verb takes. Anything else is a usage error — `stop --froce` must stop nothing. */
const FLAGS: Record<Verb, readonly string[]> = { status: [], open: ['--print'], stop: ['--force'] };

/** An unknown verb or flag: usage on stderr, and this exit code. */
export const CLI_USAGE_EXIT = 2;

/** How long `stop` waits for the runner to go: past the runner's own hard exit deadline. */
const STOP_WAIT_MS = 8_000;
const STOP_POLL_MS = 100;

export interface CliDeps {
  /** The Snug home. Throws when it cannot be resolved. */
  home(): string;
  call(socket: string, request: ControlCallRequest, options?: { timeoutMs?: number }): Promise<ControlAnswer | undefined>;
  readLock(dir: string): LockRecord | undefined;
  isAlive(pid: number): boolean;
  commandLineOf(pid: number): string | undefined;
  /** SIGTERM. */
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  out(line: string): void;
  err(line: string): void;
  /** Whether stdout is a terminal: the launch address is printed to nothing else (L5). */
  isTTY: boolean;
  /** How this CLI is run on this install — the launcher's real path — for every line that says what to type. */
  command: string;
}

/**
 * The verb a command line names, or `undefined` for the agent's stdio mode. The FIRST
 * argument that is not a flag — so a typo is a verb and reaches the usage line, instead of
 * silently starting a runner nobody is talking to.
 */
export function positionalVerb(args: readonly string[]): string | undefined {
  return args.find((arg) => !arg.startsWith('-'));
}

function usage(command: string): string {
  return [
    `Usage: ${command} <verb>`,
    '  status         what is running: version, build, pid, home, sessions, pages, brains',
    '  open           open Snug in your browser',
    '  open --print   print the launch address instead (in a terminal only)',
    '  stop           stop the running Snug (refuses while a page is open)',
    '  stop --force   stop it even with pages open',
    'With no verb this program is started by your agent and speaks to it over stdio.',
  ].join('\n');
}

export async function runCli(args: readonly string[], deps: CliDeps): Promise<number> {
  const verb = positionalVerb(args);
  const flags = args.filter((arg) => arg !== verb);
  if (verb === undefined || !(CLI_VERBS as readonly string[]).includes(verb) || flags.some((flag) => !FLAGS[verb as Verb].includes(flag))) {
    deps.err(usage(deps.command));
    return CLI_USAGE_EXIT;
  }

  let hostDir: string;
  try {
    hostDir = path.join(deps.home(), 'host');
  } catch {
    deps.err(refusalSentence(refusalFor('home-unresolved', { cli: deps.command })));
    return 1;
  }
  const socket = controlSocketPath(hostDir);
  const ask = (request: ControlCallRequest, timeoutMs?: number): Promise<ControlAnswer | undefined> =>
    deps.call(socket, request, timeoutMs !== undefined ? { timeoutMs } : {});
  const notRunning = 'Snug is not running. Start it from your agent, then try again.';
  /** An older build names itself by what it lacks: a `hello` with no ack and no `build` (L3). */
  const olderBuild = (hello: ControlAnswer): boolean => !acked(hello, 'hello') || typeof hello.build !== 'string';
  const olderSentence = (): string => {
    const pid = deps.readLock(hostDir)?.pid;
    return refusalSentence(refusalFor('older-build', { cli: deps.command, ...(pid !== undefined ? { pid } : {}) }));
  };
  const gone = async (pid: number): Promise<boolean> => {
    for (let waited = 0; deps.isAlive(pid); waited += STOP_POLL_MS) {
      if (waited >= STOP_WAIT_MS) return false;
      await deps.sleep(STOP_POLL_MS);
    }
    return true;
  };

  switch (verb as Verb) {
    case 'status': {
      const answer = await ask({ op: 'status' });
      if (answer === undefined) {
        deps.err(notRunning);
        return 1;
      }
      if (!acked(answer, 'status')) {
        // What an older build can honestly be said to have told us: that it is there.
        deps.out(JSON.stringify({ running: true, older: true, pid: deps.readLock(hostDir)?.pid, port: typeof answer.port === 'number' ? answer.port : undefined }));
        deps.err(olderSentence());
        return 0;
      }
      const { ok: _ok, op: _op, ...status } = answer;
      deps.out(JSON.stringify(status));
      return 0;
    }

    case 'open': {
      const hello = await ask({ op: 'hello' });
      if (hello === undefined) {
        deps.err(notRunning);
        return 1;
      }
      if (olderBuild(hello) || typeof hello.port !== 'number') {
        // NOT asked to `open`: an older build answers that op with the tokened address.
        deps.err(olderSentence());
        return 1;
      }
      const address = `http://127.0.0.1:${hello.port}/`;
      const print = flags.includes('--print');
      if (!print) {
        // The opener has its own bound in the runner; this one sits just past it.
        if (acked(await ask({ op: 'open' }, 10_000), 'open')) {
          deps.out(`Snug is open at ${address}`);
          return 0;
        }
        deps.err('The runner could not open a browser from here.');
      }
      if (!deps.isTTY) {
        deps.out(address);
        deps.err(`The full launch address is only printed in a terminal — run this in your own terminal: ${deps.command} open --print`);
        // `--print` did what a pipe allows; a plain `open` that opened nothing did not.
        return print ? 0 : 1;
      }
      // The user's own terminal: the one place the launch address may carry its fragment.
      const launch = await ask({ op: 'launch-url' });
      if (!acked(launch, 'launch-url') || typeof launch.url !== 'string') {
        deps.err('Could not reach the running Snug.');
        return 1;
      }
      deps.out(launch.url);
      return 0;
    }

    case 'stop': {
      const hello = await ask({ op: 'hello' });
      const lock = deps.readLock(hostDir);
      if (hello === undefined) {
        if (lock !== undefined && deps.isAlive(lock.pid)) {
          deps.err(`Snug’s lock names pid ${lock.pid}, which is running but not answering its control socket. Quit the agent session that started it; nothing was signalled.`);
          return 1;
        }
        deps.out('Snug is not running.');
        return 0;
      }

      if (olderBuild(hello)) {
        // It does not know `stop` — it would answer with its hello. A signal is the only
        // way, and a signal needs BOTH proofs: this socket is the lock's, and the lock's
        // pid is ours. The pid comes from the lock, never from what the socket said.
        const confirmed = lock !== undefined && hello.tokenHash === lock.tokenHash && isSnugCommandLine(deps.commandLineOf(lock.pid));
        if (!confirmed) {
          deps.err('An older Snug runner is running, but its identity could not be confirmed, so nothing was signalled. Quit the agent session that started it.');
          return 1;
        }
        deps.kill(lock.pid);
        if (!(await gone(lock.pid))) {
          deps.err(`The older Snug (pid ${lock.pid}) was signalled but has not exited.`);
          return 1;
        }
        deps.out(`Stopped an older Snug (pid ${lock.pid}) with a signal — that build does not know “stop”.`);
        return 0;
      }

      const answer = await ask({ op: 'stop', force: flags.includes('--force') }, 5_000);
      if (acked(answer, 'stop')) {
        const pid = typeof answer.pid === 'number' ? answer.pid : lock?.pid;
        if (pid !== undefined && !(await gone(pid))) {
          deps.err(`Snug (pid ${pid}) acknowledged the stop but has not exited.`);
          return 1;
        }
        deps.out(`Stopped Snug${pid !== undefined ? ` (pid ${pid})` : ''} over its control socket.`);
        return 0;
      }
      if (answer?.error === 'pages-open') {
        const pages = typeof answer.pages === 'number' ? answer.pages : 1;
        deps.err(
          `${pages} Snug page${pages === 1 ? ' is' : 's are'} open — stopping now could lose work they have not saved yet. Close ${pages === 1 ? 'it' : 'them'}, or run: ${deps.command} stop --force`,
        );
        return 1;
      }
      deps.err('The running Snug did not acknowledge the stop.');
      return 1;
    }
  }
}
