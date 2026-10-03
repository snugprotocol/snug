// L4/L5 — the human CLI: `status`, `open [--print]`, `stop [--force]`.
//
// It is the same binary as the agent's process (one bundle, started by the plugin's
// launcher), run BY A PERSON in their own terminal. Two rules shape it:
//
//  * THE BEARER'S ONE WAY OUT (L5). The launch address with its token is printed only when
//    stdout is a terminal. An agent that runs this through a shell tool gets a pipe — and a
//    pipe is a transcript. There the CLI does not even ASK the runner for the address.
//  * `stop` IS THE REMEDY the refusal table names, so it has to work against whatever is
//    actually running — including a build from before `stop` existed, which it may signal
//    only when BOTH the socket's hash matches the lock and the command line is ours.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CLI_USAGE_EXIT, positionalVerb, runCli, type CliDeps } from '../cli.js';
import type { ControlAnswer, ControlCallRequest } from '../control-socket.js';

const TOKEN_URL = 'http://127.0.0.1:43127/#token=' + 'c'.repeat(64);
const HELLO = { ok: true, op: 'hello', tokenHash: 'h', port: 43127, build: 'abc1234', version: '0.1.0', pid: 777 };
const OLD_HELLO = { tokenHash: 'h', port: 43127, running: true, clients: 1 };

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  asked: ControlCallRequest[];
  kill: ReturnType<typeof vi.fn>;
}

/** A CLI with everything injected: `answers` maps an op to what the runner says to it. */
function harness(answers: Record<string, ControlAnswer | undefined | ((request: ControlCallRequest) => ControlAnswer | undefined)>, over: Partial<CliDeps> = {}): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const asked: ControlCallRequest[] = [];
  const kill = vi.fn();
  const deps: CliDeps = {
    home: () => '/home/x/Snug',
    call: async (_socket, request) => {
      asked.push(request);
      const answer = answers[request.op];
      return typeof answer === 'function' ? answer(request) : answer;
    },
    readLock: () => undefined,
    isAlive: () => false,
    commandLineOf: () => undefined,
    kill,
    sleep: async () => {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isTTY: false,
    command: 'sh /plugin/scripts/snug',
    ...over,
  };
  return { deps, out, err, asked, kill };
}

const everything = (h: Harness): string => [...h.out, ...h.err].join('\n');

describe('which mode the binary is in', () => {
  it('is the agent’s stdio mode ONLY when there is no positional verb', () => {
    expect(positionalVerb([])).toBeUndefined();
    expect(positionalVerb(['--some-flag'])).toBeUndefined();
    expect(positionalVerb(['status'])).toBe('status');
    expect(positionalVerb(['--force', 'stop'])).toBe('stop');
    // A typo is a VERB — it must reach the usage line, not silently start a runner.
    expect(positionalVerb(['stauts'])).toBe('stauts');
  });
});

describe('an unknown verb', () => {
  it('prints usage and exits 2 — without touching the runner', async () => {
    const h = harness({ hello: HELLO });
    expect(await runCli(['stauts'], h.deps)).toBe(2);
    expect(CLI_USAGE_EXIT).toBe(2);
    expect(h.err.join('\n')).toMatch(/usage/i);
    for (const verb of ['status', 'open', 'open --print', 'stop', 'stop --force']) expect(h.err.join('\n')).toContain(verb);
    expect(h.out).toEqual([]);
    expect(h.asked).toEqual([]);
  });

  it('an unknown FLAG on a known verb is usage too — `stop --froce` must not stop anything', async () => {
    const h = harness({ hello: HELLO, stop: { ok: true, op: 'stop', pid: 777 } });
    expect(await runCli(['stop', '--froce'], h.deps)).toBe(2);
    expect(await runCli(['status', '--print'], h.deps)).toBe(2);
    expect(await runCli(['open', 'extra'], h.deps)).toBe(2);
    expect(h.asked).toEqual([]);
  });
});

describe('with no home', () => {
  it('says why and exits 1 — the same sentence the agent would get', async () => {
    const h = harness(
      {},
      {
        home: () => {
          throw new Error('refusing to guess a home directory');
        },
      },
    );
    expect(await runCli(['status'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/HOME/);
    expect(h.err.join('\n')).toMatch(/SNUG_HOME/);
  });
});

describe('status', () => {
  it('prints what the runner reports: version, build, pid, platform, home, clients, pages', async () => {
    const doc = { running: true, version: '0.1.0', build: 'abc1234', pid: 777, platform: 'darwin', home: '/home/x/Snug', clients: 2, pages: 1, port: 43127 };
    const h = harness({ status: { ok: true, op: 'status', ...doc } });
    expect(await runCli(['status'], h.deps)).toBe(0);
    expect(JSON.parse(h.out.join('\n'))).toEqual(doc);
    // It asked the socket under THIS home.
    expect(h.asked).toEqual([{ op: 'status' }]);
  });

  it('says so, and exits 1, when nothing is running', async () => {
    const h = harness({});
    expect(await runCli(['status'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/not running/i);
    expect(h.out).toEqual([]);
  });

  it('an OLDER build’s answer is reported as exactly that — never dressed up as a current status', async () => {
    const h = harness({ status: OLD_HELLO }, { readLock: () => ({ port: 43127, pid: 4242, tokenHash: 'h', startedAt: 1, socket: '/home/x/Snug/host/ctl.sock' }) });
    expect(await runCli(['status'], h.deps)).toBe(0);
    const printed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(printed).toMatchObject({ running: true, older: true, pid: 4242, port: 43127 });
    expect(printed.version).toBeUndefined();
    expect(h.err.join('\n')).toMatch(/older Snug runner/);
  });
});

describe('open (L5)', () => {
  it('asks the RUNNER to open the browser, and prints the address without its token', async () => {
    const h = harness({ hello: HELLO, open: { ok: true, op: 'open', port: 43127 } }, { isTTY: true });
    expect(await runCli(['open'], h.deps)).toBe(0);
    expect(h.out).toEqual(['Snug is open at http://127.0.0.1:43127/']);
    expect(h.asked.map((request) => request.op)).toEqual(['hello', 'open']);
  });

  it('--print in a TERMINAL prints the launch address — the one place it may appear', async () => {
    const h = harness({ hello: HELLO, 'launch-url': { ok: true, op: 'launch-url', url: TOKEN_URL } }, { isTTY: true });
    expect(await runCli(['open', '--print'], h.deps)).toBe(0);
    expect(h.out).toEqual([TOKEN_URL]);
    // It printed; it did not also open a browser.
    expect(h.asked.map((request) => request.op)).toEqual(['hello', 'launch-url']);
  });

  it('--print into a PIPE prints the address without the token, says where to run it — and never asks for the token', async () => {
    // An agent running this through a shell tool is the case: its stdout is a transcript.
    // Not asking is stronger than not printing — the bearer never enters this process.
    const h = harness({ hello: HELLO, 'launch-url': { ok: true, op: 'launch-url', url: TOKEN_URL } }, { isTTY: false });
    expect(await runCli(['open', '--print'], h.deps)).toBe(0);
    expect(h.out).toEqual(['http://127.0.0.1:43127/']);
    expect(h.err.join('\n')).toMatch(/run this in your own terminal/i);
    expect(h.err.join('\n')).toContain('sh /plugin/scripts/snug open --print');
    expect(h.asked.map((request) => request.op)).toEqual(['hello']);
    expect(everything(h)).not.toMatch(/token/);
  });

  it('when the runner cannot open a browser, a terminal gets the launch address instead', async () => {
    const h = harness(
      { hello: HELLO, open: { ok: false, op: 'open', error: 'could not open a browser', port: 43127 }, 'launch-url': { ok: true, op: 'launch-url', url: TOKEN_URL } },
      { isTTY: true },
    );
    expect(await runCli(['open'], h.deps)).toBe(0);
    expect(h.out).toEqual([TOKEN_URL]);
  });

  it('…and a pipe gets the tokenless address and the sentence, exit 1 — nothing was opened', async () => {
    const h = harness(
      { hello: HELLO, open: { ok: false, op: 'open', error: 'could not open a browser', port: 43127 }, 'launch-url': { ok: true, op: 'launch-url', url: TOKEN_URL } },
      { isTTY: false },
    );
    expect(await runCli(['open'], h.deps)).toBe(1);
    expect(everything(h)).not.toMatch(/token/);
    expect(h.asked.map((request) => request.op)).not.toContain('launch-url');
  });

  it('an OLDER build is refused by name — its `open` answers the address to anyone who asks', async () => {
    // The old socket's `open` returned the tokened URL on a pipe. Not asking it is the fix
    // on this side; the remedy sentence names the pid to restart.
    const h = harness(
      { hello: OLD_HELLO, open: { ...OLD_HELLO, url: TOKEN_URL } },
      { isTTY: true, readLock: () => ({ port: 43127, pid: 4242, tokenHash: 'h', startedAt: 1, socket: '/s' }) },
    );
    expect(await runCli(['open'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/older Snug runner \(pid 4242\)/);
    expect(h.asked.map((request) => request.op)).toEqual(['hello']);
    expect(everything(h)).not.toMatch(/token/);
  });

  it('says so when nothing is running', async () => {
    const h = harness({});
    expect(await runCli(['open'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/not running/i);
  });

  it('a runner that answers `launch-url` with anything but its ack prints nothing', async () => {
    const h = harness({ hello: HELLO, 'launch-url': { ...OLD_HELLO, url: TOKEN_URL } }, { isTTY: true });
    expect(await runCli(['open', '--print'], h.deps)).toBe(1);
    expect(h.out).toEqual([]);
  });
});

describe('stop (L4)', () => {
  const lock = { port: 43127, pid: 777, tokenHash: 'h', startedAt: 1, socket: '/home/x/Snug/host/ctl.sock' };

  it('stops the runner over its socket, waits for it to go, and says which way it went', async () => {
    let polls = 0;
    const h = harness({ hello: HELLO, stop: { ok: true, op: 'stop', pid: 777 } }, { readLock: () => lock, isAlive: () => ++polls < 4 });
    expect(await runCli(['stop'], h.deps)).toBe(0);
    expect(h.asked).toEqual([{ op: 'hello' }, { op: 'stop', force: false }]);
    expect(h.out.join('\n')).toMatch(/Stopped Snug \(pid 777\) over its control socket/);
    expect(polls).toBeGreaterThanOrEqual(4);
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('REFUSES while a page is open, and names the way past', async () => {
    const h = harness({ hello: HELLO, stop: { ok: false, op: 'stop', error: 'pages-open', pages: 2 } }, { readLock: () => lock });
    expect(await runCli(['stop'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/2 Snug pages are open/);
    expect(h.err.join('\n')).toContain('sh /plugin/scripts/snug stop --force');
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('--force sends force, and only then', async () => {
    const h = harness({ hello: HELLO, stop: (request) => (request.force === true ? { ok: true, op: 'stop', pid: 777 } : { ok: false, op: 'stop', error: 'pages-open', pages: 1 }) }, { readLock: () => lock });
    expect(await runCli(['stop', '--force'], h.deps)).toBe(0);
    expect(h.asked[1]).toEqual({ op: 'stop', force: true });
  });

  it('exits 1 when it acknowledged and then did not go', async () => {
    const sleep = vi.fn(async () => {});
    const h = harness({ hello: HELLO, stop: { ok: true, op: 'stop', pid: 777 } }, { readLock: () => lock, isAlive: () => true, sleep });
    expect(await runCli(['stop'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/has not exited/);
    // The wait is bounded.
    expect(sleep.mock.calls.length).toBeLessThan(500);
  });

  it('with nothing running, says so and exits 0 — there is nothing to stop', async () => {
    const h = harness({});
    expect(await runCli(['stop'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/not running/i);
  });

  it('a lock naming a LIVE pid that does not answer is not "not running": it says what it found, exit 1, no signal', async () => {
    const h = harness({}, { readLock: () => lock, isAlive: () => true, commandLineOf: () => 'node /plugin/scripts/snug-mcp.mjs' });
    expect(await runCli(['stop'], h.deps)).toBe(1);
    expect(h.err.join('\n')).toMatch(/pid 777/);
    expect(h.err.join('\n')).toMatch(/not answering/);
    expect(h.kill).not.toHaveBeenCalled();
  });

  describe('against an OLDER build, which does not know `stop`', () => {
    const ours = (): string => 'node /plugin/scripts/snug-mcp.mjs';

    it('falls back to SIGTERM of the lock’s pid — when the socket’s hash matches the lock AND the command line is ours', async () => {
      let alive = true;
      const h = harness({ hello: OLD_HELLO, stop: OLD_HELLO }, { readLock: () => lock, commandLineOf: ours, isAlive: () => alive });
      h.kill.mockImplementation(() => {
        alive = false;
      });
      expect(await runCli(['stop'], h.deps)).toBe(0);
      expect(h.kill).toHaveBeenCalledTimes(1);
      expect(h.kill).toHaveBeenCalledWith(777);
      // It says which path it took.
      expect(h.out.join('\n')).toMatch(/Stopped an older Snug \(pid 777\) with a signal/);
      // It never asked an old build to `stop`: its answer would have been a hello, read as nothing.
      expect(h.asked.map((request) => request.op)).toEqual(['hello']);
    });

    it('…also when the older runner was installed under a path with a SPACE — `ps` cannot split it, the file system can', async () => {
      // `~/Library/Application Support/…`: the fallback could never fire there, and `stop` is
      // the remedy three rows of the refusal table name.
      const root = mkdtempSync(path.join(tmpdir(), 'snug-cli-'));
      try {
        const script = path.join(root, 'Application Support', 'plug', 'snug-mcp.mjs');
        mkdirSync(path.dirname(script), { recursive: true });
        writeFileSync(script, '');
        let alive = true;
        const h = harness({ hello: OLD_HELLO }, { readLock: () => lock, commandLineOf: () => `/opt/homebrew/bin/node ${script}`, isAlive: () => alive });
        h.kill.mockImplementation(() => {
          alive = false;
        });
        expect(await runCli(['stop'], h.deps)).toBe(0);
        expect(h.kill).toHaveBeenCalledWith(777);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it('does NOT signal when the socket’s hash is not the lock’s', async () => {
      const h = harness({ hello: { ...OLD_HELLO, tokenHash: 'someone-else' } }, { readLock: () => lock, commandLineOf: ours, isAlive: () => true });
      expect(await runCli(['stop'], h.deps)).toBe(1);
      expect(h.kill).not.toHaveBeenCalled();
      expect(h.err.join('\n')).toMatch(/could not be confirmed/);
    });

    it('does NOT signal when the command line is not ours — the pid may have been recycled', async () => {
      const h = harness({ hello: OLD_HELLO }, { readLock: () => lock, commandLineOf: () => '/usr/sbin/cupsd -l', isAlive: () => true });
      expect(await runCli(['stop'], h.deps)).toBe(1);
      expect(h.kill).not.toHaveBeenCalled();
    });

    it('does NOT signal when there is no lock to name a pid', async () => {
      const h = harness({ hello: OLD_HELLO }, { readLock: () => undefined, commandLineOf: ours, isAlive: () => true });
      expect(await runCli(['stop'], h.deps)).toBe(1);
      expect(h.kill).not.toHaveBeenCalled();
    });

    it('never takes the pid from the SOCKET’s answer — only the lock names who may be signalled', async () => {
      const h = harness({ hello: { ...OLD_HELLO, pid: 1 } }, { readLock: () => lock, commandLineOf: ours, isAlive: () => false });
      await runCli(['stop'], h.deps);
      expect(h.kill).toHaveBeenCalledWith(777);
    });
  });
});
