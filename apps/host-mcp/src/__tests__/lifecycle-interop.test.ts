// The runner's lifecycle, proven on the BUILT bundles (L1, L2, L4, L5, L7, D8).
//
// WHY BUILT, AND WHY REAL PROCESSES. "Two windows, one Snug" passed every unit test for a
// month while being dead in the shipped build: the tests injected the one dependency the
// release wired to `() => undefined` (found 2026-10-03, with the owner's own second window
// failing as "Connection closed"). So the claims here are made the only way that would have
// caught it — two real processes started from `dist/`, speaking the protocol a host speaks,
// with nothing injected.
//
// The release bundle is used wherever the claim is about what ships. The TEST bundle is used
// for exactly three things the release cannot do in a suite, each by a hook that exists only
// in that build: a grace short enough to wait for, a port list that can really fail, and
// the launch token (its ready line) for the legs that need a page. Both bundles are the same
// `startProcess` (K5).
//
// SAFETY. Every process gets the three-variable isolation environment (`built.ts`); nothing
// here can reach the real `~/Snug` or meet a runner the developer has open. `snug_open` is
// never called against the RELEASE bundle — that build opens a real browser.

import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { bundleProblem, exitsWithin, isolation, reapAll, RELEASE_BUNDLE, runVerb, scratch, startScript, startSession, TEST_BUNDLE, type Isolation, type Session } from './built.js';
import { readCommandLine, scriptTokenOf } from '../identity.js';
import { REFUSAL_CODES } from '../refusals.js';

/**
 * A missing or stale build is CANNOT RUN — a FAILING test, by name (`built.ts`). The cases
 * below are skipped only so that failure is one line, not sixty about old bytes.
 */
const cannotRun = [RELEASE_BUNDLE, TEST_BUNDLE].map((bundle) => bundleProblem(bundle)).find((problem) => problem !== undefined);
it('the bundles under test are built, and built from the sources on disk', () => {
  if (cannotRun !== undefined) throw new Error(cannotRun);
});
const describeBuilt = describe.skipIf(cannotRun !== undefined);

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await reapAll();
});

const SLOW = 40_000;
const hostDir = (iso: Isolation): string => path.join(iso.home, 'host');
const lockFile = (iso: Isolation): string => path.join(hostDir(iso), 'lock.json');
const socketFile = (iso: Isolation): string => path.join(hostDir(iso), 'ctl.sock');

/** The test build: same process, plus the hooks only it reads. */
const testEnv = (iso: Isolation, extra: Record<string, string> = {}): Record<string, string> => ({ ...iso.env, SNUG_MCP_TEST_ENTRY: '1', ...extra });

const begin = async (bundle: string, env: Record<string, string>, options: { cwd?: string } = {}): Promise<Session> => {
  const session = startSession(bundle, env, options);
  await session.initialize();
  return session;
};

const until = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

/** A real bundle: the schema is strict, so a hand-waved fixture proves nothing. */
const bundle = {
  format: 'snug-app-bundle/1',
  lineage: '0123abcd-4567-89ab-cdef-0123456789ab',
  sharedAt: '2026-09-07T00:00:00.000Z',
  app: { displayName: 'Chess', usesDb: false },
  html: '<!doctype html><title>a</title>',
  connections: [],
};

/** A listener on the home's control socket that answers every line with `answer(line)`. */
const fakeSocket = async (iso: Isolation, answer: (request: { op?: string }) => unknown): Promise<void> => {
  mkdirSync(hostDir(iso), { recursive: true });
  const peers = new Set<Socket>();
  const server: NetServer = createNetServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('data', (chunk: Buffer) => {
      const said = answer(JSON.parse(chunk.toString('utf8')) as { op?: string });
      if (said !== undefined) peer.write(`${JSON.stringify(said)}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketFile(iso), resolve));
  closers.push(() => {
    for (const peer of peers) peer.destroy();
    return new Promise((resolve) => server.close(resolve));
  });
};
const writeLock = (iso: Isolation, record: { pid: number; tokenHash: string; port?: number }): void => {
  mkdirSync(hostDir(iso), { recursive: true });
  writeFileSync(lockFile(iso), JSON.stringify({ port: 43999, startedAt: 1, socket: socketFile(iso), ...record }));
};
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A port nothing listens on: bound once, then given back. */
const silentPort = async (): Promise<number> => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
};

describeBuilt('L1 — a second process ATTACHES (the release bundle, twice, nothing injected)', () => {
  it(
    'the first leads, the second joins it, and both report the SAME runner',
    async () => {
      const iso = isolation();
      const first = await begin(RELEASE_BUNDLE, iso.env);
      const mine = await first.status();
      // The isolation contract, asserted before anything else is believed.
      expect(mine.home).toBe(iso.home);
      expect(String(mine.file).startsWith(iso.tmp)).toBe(true);
      expect(mine).toMatchObject({ running: true, pid: first.pid, clients: 0, pages: 0, binding: 'local-host', platform: process.platform });

      const second = await begin(RELEASE_BUNDLE, iso.env);
      const theirs = await second.status();
      // THE claim: before this range the second process died ahead of the handshake.
      expect(theirs).toMatchObject({ running: true, attached: true, pid: first.pid, port: mine.port, home: iso.home, clients: 1 });
      expect(second.pid).not.toBe(first.pid);
      expect(await first.status()).toMatchObject({ clients: 1 });
    },
    SLOW,
  );

  it(
    'two processes started AT THE SAME INSTANT are one Snug: one leads, the other waits for its socket and joins',
    async () => {
      // The simultaneous-spawn race, both halves: `O_EXCL` picks one winner, and the loser —
      // arriving between the winner's lock and its socket — waits instead of judging a
      // silence that means nothing yet. Three rounds, because it is a race.
      for (let round = 0; round < 3; round += 1) {
        const iso = isolation();
        const pair = [startSession(RELEASE_BUNDLE, iso.env), startSession(RELEASE_BUNDLE, iso.env)] as const;
        await Promise.all(pair.map((session) => session.initialize()));
        const [a, b] = await Promise.all(pair.map((session) => session.status()));
        expect([a!.running, b!.running], `round ${round}: ${JSON.stringify([a!.refusal, b!.refusal])}`).toEqual([true, true]);
        // The same runner, seen from both sides — and exactly one of them is attached to it.
        expect(a!.pid).toBe(b!.pid);
        expect([pair[0].pid, pair[1].pid]).toContain(a!.pid);
        expect([a!.attached, b!.attached].filter((attached) => attached === true)).toHaveLength(1);
        await reapAll();
      }
    },
    SLOW,
  );

  it(
    'the attached session serves the tools through the primary (L3) — and lists all four',
    async () => {
      const iso = isolation();
      const first = await begin(RELEASE_BUNDLE, iso.env);
      await first.status();
      const second = await begin(RELEASE_BUNDLE, iso.env);
      const { tools } = (await second.request('tools/list')) as { tools: Array<{ name: string }> };
      expect(tools.map((tool) => tool.name).sort()).toEqual(['snug_hand_in', 'snug_list_apps', 'snug_open', 'snug_status']);

      // Each answer is word for word the primary's own. (`snug_open` is not called on this
      // build: it opens a real browser. It is driven on the test build below.)
      for (const [name, args] of [
        ['snug_hand_in', { bundle }],
        ['snug_hand_in', { bundle: { format: 'nope' } }],
        ['snug_list_apps', {}],
      ] as const) {
        expect(await second.tool(name, args), name).toEqual(await first.tool(name, args));
      }
      expect((await second.tool('snug_hand_in', { bundle })).text).toMatch(/no Snug page is open — call snug_open first/);
    },
    SLOW,
  );

  it(
    'reports the build it is running: the sha256 prefix of the bundle file itself',
    async () => {
      const iso = isolation();
      const session = await begin(RELEASE_BUNDLE, iso.env);
      const status = await session.status();
      expect(status.build).toBe(createHash('sha256').update(readFileSync(RELEASE_BUNDLE)).digest('hex').slice(0, 7));
      expect(status.version).toBe((JSON.parse(readFileSync(path.resolve(RELEASE_BUNDLE, '../../package.json'), 'utf8')) as { version: string }).version);
    },
    SLOW,
  );

  it(
    '…the build that is RUNNING: a bundle replaced on disk after the process started does not change what it reports',
    async () => {
      // The owner's own dev flow: the plugin build rewrites the bundle in place while a runner
      // started from it is alive. `build` used to be hashed on the FIRST ASK, from whatever
      // was on disk by then — so the stale runner reported the new build's id, which is the
      // one question `build` exists to answer (which bytes are running?). Measured on this
      // bundle: started from 1a17789, one line appended before the first status, reported 03a71d6.
      const iso = isolation();
      const file = path.join(scratch(), 'snug-mcp.mjs');
      cpSync(RELEASE_BUNDLE, file);
      const idOf = (): string => createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 7);
      const loaded = idOf();

      // It has answered the handshake — it is running — and nobody has asked for its build yet.
      const session = await begin(file, iso.env);
      appendFileSync(file, '\n');
      // The canary can see: the file on disk is now a different build.
      expect(idOf()).not.toBe(loaded);

      expect((await session.status()).build).toBe(loaded);
      // …and it is what `snug status` prints for it — even run from the file as it is NOW:
      // the verb reports the runner's build, which the runner settled when it started.
      const { stdout } = await runVerb(file, ['status'], iso.env);
      expect(JSON.parse(stdout)).toMatchObject({ pid: session.pid, build: loaded });
    },
    SLOW,
  );

  it(
    'the release build writes NOTHING to stderr on a clean start — a ready line would put the bearer in a host’s log',
    async () => {
      const iso = isolation();
      const session = await begin(RELEASE_BUNDLE, iso.env);
      await session.status();
      expect(session.stderr()).toBe('');
    },
    SLOW,
  );
});

describeBuilt('L1/L8 — what a crash leaves behind is taken over ONCE, by the release bundle, with nothing injected', () => {
  it(
    'a WEDGED runner of ours — alive, lock held, socket gone — is recognised from the process table, asked to stop, waited for and replaced',
    async () => {
      // THE defect this range opened with, pinned where it lived. Every unit test injects the
      // command-line reader; the shipped build had it wired to `() => undefined`. With the
      // reader unwired this runner is a "stranger" for ever: the take-over never happens and
      // the refusal tells the user to delete the lock of a process still holding their file.
      const iso = isolation();
      const port = await silentPort();
      mkdirSync(hostDir(iso), { recursive: true });
      // Started from a file with the BUNDLE'S OWN NAME — that name is the identity `ps` reads.
      const file = path.join(scratch(), 'snug-mcp.mjs');
      writeFileSync(
        file,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(lockFile(iso))}, JSON.stringify({ port: ${port}, pid: process.pid, tokenHash: 'wedged', startedAt: 1, socket: ${JSON.stringify(socketFile(iso))} }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
process.stdout.write('up\\n');
`,
      );
      const wedged = startScript(file, iso.env);
      const wedgedExit = new Promise<number | null>((resolve) => wedged.once('exit', (code) => resolve(code)));
      await new Promise<void>((resolve) => wedged.stdout!.once('data', () => resolve()));

      const began = Date.now();
      const session = await begin(RELEASE_BUNDLE, iso.env);
      const status = await session.status();
      expect(status.refusal).toBeUndefined();
      expect(status).toMatchObject({ running: true, pid: session.pid });
      // Three probes over five seconds came first (L8): it was not signalled on one silence.
      expect(Date.now() - began).toBeGreaterThanOrEqual(5_000);
      // Asked to stop — its own handler exits 0 — and gone before the lock changed hands.
      expect(await wedgedExit).toBe(0);
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: session.pid });
    },
    SLOW,
  );

  it(
    'the same wedged runner installed under a path with a SPACE (…/Application Support/…) is recognised too — never "a stranger", with its lock to delete',
    async () => {
      // macOS's `ps` joins argv with spaces, and the identity rule split on them: under the
      // folder macOS keeps app data in, a runner of ours was refused as `lock-held-by-stranger`
      // — "…is not a Snug runner", delete the lock — while it still held the user file
      // (reproduced by the verifier on this bundle, 2026-10-03). Linux reads an exact argv.
      const iso = isolation();
      const port = await silentPort();
      mkdirSync(hostDir(iso), { recursive: true });
      const file = path.join(scratch(), 'Application Support', 'plug', 'snug-mcp.mjs');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(lockFile(iso))}, JSON.stringify({ port: ${port}, pid: process.pid, tokenHash: 'wedged', startedAt: 1, socket: ${JSON.stringify(socketFile(iso))} }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
process.stdout.write('up\\n');
`,
      );
      const wedged = startScript(file, iso.env);
      const wedgedExit = new Promise<number | null>((resolve) => wedged.once('exit', (code) => resolve(code)));
      await new Promise<void>((resolve) => wedged.stdout!.once('data', () => resolve()));
      // The line the release build will read is the one with the space in it.
      expect(readCommandLine(wedged.pid!)).toContain('Application Support/plug/snug-mcp.mjs');

      const session = await begin(RELEASE_BUNDLE, iso.env);
      const status = await session.status();
      expect(status.refusal).toBeUndefined();
      expect(status).toMatchObject({ running: true, pid: session.pid });
      expect(await wedgedExit).toBe(0);
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: session.pid });
    },
    SLOW,
  );

  it(
    'a STALE lock and THREE processes started at once: one leads, two attach — on the first answer, every round',
    async () => {
      // Measured before the fix, on this bundle: 77 rounds in 80 the loser's first answer was
      // a refusal naming the DEAD pid, and 3 in 80 the split was permanent — a primary with
      // no lock.json, and every later process refused `socket-in-use` on every retry.
      for (let round = 0; round < 20; round += 1) {
        const iso = isolation();
        // What a crash leaves, made the way a crash makes it: a real primary, SIGKILLed.
        const crashed = await begin(RELEASE_BUNDLE, iso.env);
        expect((await crashed.status()).running).toBe(true);
        crashed.child.kill('SIGKILL');
        await crashed.exited;
        expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: crashed.pid });

        const trio = [startSession(RELEASE_BUNDLE, iso.env), startSession(RELEASE_BUNDLE, iso.env), startSession(RELEASE_BUNDLE, iso.env)];
        await Promise.all(trio.map((session) => session.initialize()));
        const answers = await Promise.all(trio.map((session) => session.status()));
        const told = `round ${round}: ${JSON.stringify(answers.map((answer) => answer.refusal ?? { pid: answer.pid, attached: answer.attached }))}`;
        expect(answers.map((answer) => answer.running), told).toEqual([true, true, true]);
        // ONE runner, and it is one of the three.
        const leader = answers[0]!.pid;
        expect(answers.map((answer) => answer.pid), told).toEqual([leader, leader, leader]);
        expect(trio.map((session) => session.pid), told).toContain(leader);
        expect(answers.filter((answer) => answer.attached === true), told).toHaveLength(2);
        // …which the lock names, so the NEXT window attaches too.
        expect(JSON.parse(readFileSync(lockFile(iso), 'utf8')), told).toMatchObject({ pid: leader });
        expect(await trio.find((session) => session.pid === leader)!.status(), told).toMatchObject({ clients: 2 });
        await reapAll();
      }
    },
    120_000,
  );
});

describeBuilt('the SOCKET is the last word — a runner whose lock went missing is still ONE Snug', () => {
  it(
    'the next process wins the empty lock, meets the live socket, gives the lock back and JOINS — and the lock names the runner again',
    async () => {
      // The permanent state the stale-lock race used to leave (3 rounds in 80): a healthy
      // primary and no lock.json. Every later process was refused `socket-in-use`, on every
      // retry, until somebody stopped the healthy runner.
      const iso = isolation();
      const first = await begin(RELEASE_BUNDLE, iso.env);
      const mine = await first.status();
      rmSync(lockFile(iso));

      const second = await begin(RELEASE_BUNDLE, iso.env);
      expect(await second.status()).toMatchObject({ running: true, attached: true, pid: first.pid, port: mine.port });
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: first.pid, port: mine.port });
      // With the lock back, a third window attaches the ordinary way.
      const third = await begin(RELEASE_BUNDLE, iso.env);
      expect(await third.status()).toMatchObject({ running: true, attached: true, pid: first.pid });
      expect(await first.status()).toMatchObject({ clients: 2 });
    },
    SLOW,
  );
});

describeBuilt('a refusal never names a process that is GONE — a dead record beside a healthy runner is healed, not reported', () => {
  it(
    'the lock names a DEAD pid while the runner lives: the next process replaces the record, leaves the socket alone and JOINS',
    async () => {
      // How it comes about: the runner's lock goes missing (deleting it is the stranger row's
      // own remedy), a newcomer wins the empty lock, and dies before it gives it back. Every
      // process after that was refused "Another Snug runner (pid <dead>) holds this home" —
      // first answer and every retry — until somebody stopped the HEALTHY runner (reproduced
      // by the verifier on this bundle, 2026-10-03).
      const iso = isolation();
      const first = await begin(RELEASE_BUNDLE, iso.env);
      const mine = await first.status();
      // A process that has come and gone: a real pid, and a dead one.
      const nothing = path.join(scratch(), 'gone.mjs');
      writeFileSync(nothing, '');
      const gone = startScript(nothing, iso.env);
      await new Promise((resolve) => gone.once('exit', resolve));
      expect(pidAlive(gone.pid!)).toBe(false);
      writeLock(iso, { pid: gone.pid!, tokenHash: 'left-by-a-newcomer-that-died' });

      const second = await begin(RELEASE_BUNDLE, iso.env);
      const theirs = await second.status();
      expect(theirs.refusal, JSON.stringify(theirs.refusal)).toBeUndefined();
      expect(theirs).toMatchObject({ running: true, attached: true, pid: first.pid, port: mine.port });
      // The healthy runner was never disturbed, and the lock is its own again.
      expect(await first.status()).toMatchObject({ running: true, pid: first.pid, clients: 1 });
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: first.pid, port: mine.port });
      // So a third window attaches the ordinary way.
      const third = await begin(RELEASE_BUNDLE, iso.env);
      expect(await third.status()).toMatchObject({ running: true, attached: true, pid: first.pid });
    },
    SLOW,
  );
});

describeBuilt('L2 — no failure precedes the handshake: every row of the refusal table, through a built bundle', () => {
  /** What every refused runner must still do, and how it must say why. */
  const expectRefused = async (session: Session, code: (typeof REFUSAL_CODES)[number]): Promise<{ message: string; remedy: string }> => {
    // It was initialized by `begin` — the handshake came first. The tool surface is intact:
    const { tools } = (await session.request('tools/list')) as { tools: unknown[] };
    expect(tools).toHaveLength(4);
    const status = (await session.status()) as { running: boolean; refusal: { code: string; message: string; remedy: string } };
    expect(status.running).toBe(false);
    expect(status.refusal.code).toBe(code);
    expect(status.refusal.message.length).toBeGreaterThan(10);
    expect(status.refusal.remedy.length).toBeGreaterThan(10);
    // Every other tool: the same sentence, as an error.
    const other = await session.tool('snug_list_apps');
    expect(other.isError).toBe(true);
    expect(other.text).toBe(`${status.refusal.message} ${status.refusal.remedy}`);
    // …and the host's log has it too (its own pipe, so it is waited for, not assumed).
    expect(await session.stderrLine(/Snug: [^\n]+\n/)).toContain(status.refusal.message);
    expect(session.hasExited()).toBe(false);
    return status.refusal;
  };

  const proven = new Set<string>();
  const row = (code: (typeof REFUSAL_CODES)[number], name: string, body: () => Promise<void>): void => {
    proven.add(code);
    it(`${code}: ${name}`, body, SLOW);
  };

  row('home-unresolved', 'neither HOME nor SNUG_HOME', async () => {
    const session = await begin(RELEASE_BUNDLE, { PATH: path.dirname(process.execPath) }, { cwd: '/' });
    const refusal = await expectRefused(session, 'home-unresolved');
    expect(`${refusal.message} ${refusal.remedy}`).toMatch(/SNUG_HOME/);
  });

  row('home-unwritable', 'a home that cannot be created — and it CLEARS without restarting the agent', async () => {
    const iso = isolation();
    const blocker = path.join(iso.tmp, 'blocker');
    writeFileSync(blocker, 'a file where the home’s parent should be');
    const session = await begin(RELEASE_BUNDLE, { ...iso.env, SNUG_HOME: path.join(blocker, 'Snug') });
    await expectRefused(session, 'home-unwritable');

    // The user fixes the cause. The SAME process, asked again, is now the runner.
    rmSync(blocker);
    await until(async () => (await session.status()).running === true, 'the degraded runner to promote itself');
    expect(await session.status()).toMatchObject({ running: true, pid: session.pid, home: path.join(blocker, 'Snug') });
  });

  row('lock-held-by-stranger', 'a live pid that is not a Snug runner is refused, and never signalled', async () => {
    const iso = isolation();
    // This test process: alive, silent on the socket, and its command line is not ours.
    writeLock(iso, { pid: process.pid, tokenHash: 'a-stale-record' });
    const session = await begin(RELEASE_BUNDLE, iso.env);
    const refusal = await expectRefused(session, 'lock-held-by-stranger');
    expect(refusal.message).toContain(`pid ${process.pid}`);
    expect(refusal.message).toContain(lockFile(iso));
    // Still here (a signal would have ended the suite), and its record untouched.
    expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: process.pid, tokenHash: 'a-stale-record' });

    // The remedy the sentence gives, performed — and it works.
    rmSync(lockFile(iso));
    await until(async () => (await session.status()).running === true, 'the runner to lead once the stale lock is gone');
  });

  row('lock-contended', 'the socket answers as another lock generation', async () => {
    const iso = isolation();
    await fakeSocket(iso, () => ({ ok: true, op: 'hello', tokenHash: 'what-the-socket-says', port: 43999, build: 'abc1234' }));
    writeLock(iso, { pid: process.pid, tokenHash: 'what-the-lock-says' });
    const session = await begin(RELEASE_BUNDLE, iso.env);
    const refusal = await expectRefused(session, 'lock-contended');
    expect(refusal.remedy).toMatch(/ stop /);
  });

  row('older-build', 'a primary from before this range is named, with its pid — never joined as if it had answered', async () => {
    const iso = isolation();
    // What the previous build's socket says to EVERY line, `attach` and `call` included.
    await fakeSocket(iso, () => ({ tokenHash: 'old', port: 43999, running: true, clients: 0 }));
    writeLock(iso, { pid: process.pid, tokenHash: 'old' });
    const session = await begin(RELEASE_BUNDLE, iso.env);
    const refusal = await expectRefused(session, 'older-build');
    expect(refusal.message).toContain(`pid ${process.pid}`);
    const handIn = await session.tool('snug_hand_in', { bundle });
    expect(handIn.isError).toBe(true);
    expect(handIn.text).not.toMatch(/handed/);
  });

  row('socket-path-too-long', 'a home whose socket path would be truncated', async () => {
    const iso = isolation();
    const session = await begin(RELEASE_BUNDLE, { ...iso.env, SNUG_HOME: path.join(iso.tmp, 'x'.repeat(110)) });
    const refusal = await expectRefused(session, 'socket-path-too-long');
    expect(refusal.remedy).toMatch(/SNUG_HOME/);
  });

  row('socket-in-use', 'something live on the control socket, with no lock — it is not unlinked', async () => {
    const iso = isolation();
    await fakeSocket(iso, () => undefined); // accepts, and says nothing
    const session = await begin(RELEASE_BUNDLE, iso.env);
    await expectRefused(session, 'socket-in-use');
    expect(existsSync(socketFile(iso))).toBe(true);
    // Nothing of the refused runner's is left to block the next attempt.
    expect(existsSync(lockFile(iso))).toBe(false);
  });

  row('listen-failed', 'every port refused (the test build: its port list can really fail)', async () => {
    const iso = isolation();
    const taken = createHttpServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => taken.close(resolve)));
    const { port } = taken.address() as { port: number };

    const session = await begin(TEST_BUNDLE, testEnv(iso, { SNUG_MCP_TEST_PORTS: String(port) }));
    const refusal = await expectRefused(session, 'listen-failed');
    expect(refusal.message).toContain('EADDRINUSE');
    expect(existsSync(lockFile(iso))).toBe(false);
  });

  row('page-damaged', 'a page that does not match its pin: refused, and the damaged bytes are never served', async () => {
    const iso = isolation();
    const install = scratch();
    cpSync(RELEASE_BUNDLE, path.join(install, 'snug-mcp.mjs'));
    writeFileSync(path.join(install, 'snug-host.html'), '<!doctype html><title>a stale mix</title>');
    writeFileSync(path.join(install, 'snug-host.html.sha256'), `${createHash('sha256').update('the page the plugin was built with').digest('hex')}\n`);
    const session = await begin(path.join(install, 'snug-mcp.mjs'), iso.env);
    const refusal = await expectRefused(session, 'page-damaged');
    expect(refusal.remedy).toMatch(/reinstall the Snug plugin/i);
    // It never led: nothing is locked and there is no data plane, so the bytes that failed
    // the pin have nothing to be served by. (That it binds nothing at all: D8, below.)
    expect(existsSync(lockFile(iso))).toBe(false);
  });

  it('every row of the table has a case above', () => {
    expect([...proven].sort()).toEqual([...REFUSAL_CODES].sort());
  });
});

describeBuilt('D8 — the served page is the pinned page', () => {
  it(
    'a page whose bytes match the sha256 beside it is served, byte for byte',
    async () => {
      const iso = isolation();
      const install = scratch();
      const page = '<!doctype html><meta charset="utf-8"><title>kit</title><p>héllo';
      cpSync(RELEASE_BUNDLE, path.join(install, 'snug-mcp.mjs'));
      writeFileSync(path.join(install, 'snug-host.html'), page);
      writeFileSync(path.join(install, 'snug-host.html.sha256'), createHash('sha256').update(Buffer.from(page, 'utf8')).digest('hex'));
      const session = await begin(path.join(install, 'snug-mcp.mjs'), iso.env);
      const status = await session.status();
      expect(status.running).toBe(true);
      const response = await fetch(`http://127.0.0.1:${String(status.port)}/`);
      expect(await response.text()).toBe(page);
    },
    SLOW,
  );

  it(
    'a DAMAGED install binds NOTHING: no listener at the runner’s address, no lock, no socket — and a healthy install beside it gets that address',
    async () => {
      // MIGRATED 2026-10-03 (the orchestrator's decision, replacing "a damaged install still
      // says so to a browser"). The damaged process used to serve a fixed sentence from a bare
      // listener on the FIRST port. That port is the fixed one a user has registered as their
      // OAuth redirect — so a healthy install started beside it was pushed onto an ephemeral
      // port and lost its OAuth rows for as long as the damaged session lived. A damaged
      // install's whole channel is now the handshake and the refusal its tools answer with.
      //
      // The test build, for its port list only: the release's fixed port belongs to whatever
      // Snug the developer has open. Both entries are the same `startProcess`.
      const iso = isolation();
      const install = scratch();
      const port = await silentPort();
      const env = testEnv(iso, { SNUG_MCP_TEST_PORTS: `${port},0` });
      cpSync(TEST_BUNDLE, path.join(install, 'snug-mcp.test.mjs'));
      writeFileSync(path.join(install, 'snug-host.html'), '<!doctype html><title>a stale mix</title>');
      writeFileSync(path.join(install, 'snug-host.html.sha256'), `${createHash('sha256').update('the page the plugin was built with').digest('hex')}\n`);
      const damaged = await begin(path.join(install, 'snug-mcp.test.mjs'), env);
      // Its start has SETTLED (the test build says so on stderr): whatever it was going to
      // bind, it has bound.
      expect(JSON.parse(await damaged.stderrLine(/\{"ready":false[^\n]*\}/))).toMatchObject({ refusal: { code: 'page-damaged' } });
      expect(await damaged.status()).toMatchObject({ running: false, refusal: { code: 'page-damaged' } });

      // Nothing answers where a runner would: not a sentence, and not the bytes that failed.
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      expect(existsSync(lockFile(iso))).toBe(false);
      expect(existsSync(socketFile(iso))).toBe(false);

      // A healthy install — same home, same ports — started while the damaged process lives:
      // it leads, and at the FIRST port, as if that process were not there.
      const healthy = await begin(TEST_BUNDLE, env);
      expect(await healthy.status()).toMatchObject({ running: true, pid: healthy.pid, port });
      // …and the damaged one is still there, still saying why.
      expect(damaged.hasExited()).toBe(false);
      expect(await damaged.status()).toMatchObject({ running: false, refusal: { code: 'page-damaged' } });
    },
    SLOW,
  );

  it(
    'the page is read ONCE: a file changed after boot is not what is served',
    async () => {
      const iso = isolation();
      const install = scratch();
      cpSync(RELEASE_BUNDLE, path.join(install, 'snug-mcp.mjs'));
      writeFileSync(path.join(install, 'snug-host.html'), 'the page at boot');
      const session = await begin(path.join(install, 'snug-mcp.mjs'), iso.env);
      const status = await session.status();
      writeFileSync(path.join(install, 'snug-host.html'), 'swapped underneath a running process');
      expect(await (await fetch(`http://127.0.0.1:${String(status.port)}/`)).text()).toBe('the page at boot');
    },
    SLOW,
  );
});

describeBuilt('L7 — presence and succession (the test build: a grace short enough to wait for)', () => {
  const GRACE_MS = 400;
  const graced = (iso: Isolation): Record<string, string> => testEnv(iso, { SNUG_MCP_TEST_GRACE_MS: String(GRACE_MS) });

  it(
    'the primary’s stdin closes while an attached process lives → STILL SERVING; the attached one closes → the primary exits and the lock is released',
    async () => {
      const iso = isolation();
      const first = await begin(TEST_BUNDLE, graced(iso));
      const { port } = (await first.status()) as { port: number };
      const second = await begin(TEST_BUNDLE, graced(iso));
      expect(await second.status()).toMatchObject({ attached: true, pid: first.pid });

      // The first window closes. Its runner is the second window's runner too.
      first.endInput();
      expect(await exitsWithin(first, GRACE_MS * 4), 'the primary left while a session was attached').toBe(false);
      expect(await second.status()).toMatchObject({ running: true, attached: true, pid: first.pid, port });
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);

      // The second window closes: nobody is left, and the grace runs out.
      second.endInput();
      expect(await second.exited).toBe(0);
      expect(await exitsWithin(first, GRACE_MS + 6_000), 'the primary never left').toBe(true);
      expect(await first.exited).toBe(0);
      expect(existsSync(lockFile(iso)), 'the lock was not released').toBe(false);
      expect(existsSync(socketFile(iso)), 'the socket was left behind').toBe(false);
    },
    SLOW,
  );

  it(
    'a primary with NO attached session exits after the grace when its stdin closes',
    async () => {
      const iso = isolation();
      const only = await begin(TEST_BUNDLE, graced(iso));
      await only.status();
      only.endInput();
      expect(await only.exited).toBe(0);
      expect(existsSync(lockFile(iso))).toBe(false);
    },
    SLOW,
  );

  it(
    'the primary is SIGKILLed → the attached session’s next snug_status reports it running as the primary',
    async () => {
      const iso = isolation();
      const first = await begin(TEST_BUNDLE, graced(iso));
      await first.status();
      const second = await begin(TEST_BUNDLE, graced(iso));
      expect(await second.status()).toMatchObject({ attached: true, pid: first.pid });

      // No shutdown, no release: the lock and the socket are left exactly as a crash leaves them.
      first.child.kill('SIGKILL');
      await first.exited;
      expect(existsSync(lockFile(iso))).toBe(true);

      const status = await second.status();
      expect(status).toMatchObject({ running: true, pid: second.pid, pages: 0, clients: 0 });
      expect(status.attached).toBeUndefined();
      // A new runner is a new bearer: the agent is told to open the page again.
      expect(String(status.note)).toMatch(/snug_open/);
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid: second.pid });
      expect((await fetch(`http://127.0.0.1:${String(status.port)}/`)).status).toBe(200);

      // And it works as one: `snug_open` (a no-op opener in this build) clears the note.
      expect((await second.tool('snug_open')).text).toBe(`Snug is open at http://127.0.0.1:${String(status.port)}/`);
      expect((await second.status()).note).toBeUndefined();
    },
    SLOW,
  );

  it(
    'the primary is SIGKILLed with TWO attached sessions asking at once → one takes its place and the other attaches to THAT one',
    async () => {
      // Succession is a take-over of a dead record by two newcomers at the same instant.
      // Before it was one step, the slower one was answered `lock-contended` with the dead
      // primary's pid — every time (60 rounds in 60).
      for (let round = 0; round < 5; round += 1) {
        const iso = isolation();
        const first = await begin(TEST_BUNDLE, graced(iso));
        await first.status();
        const second = await begin(TEST_BUNDLE, graced(iso));
        const third = await begin(TEST_BUNDLE, graced(iso));
        for (const session of [second, third]) expect(await session.status()).toMatchObject({ attached: true, pid: first.pid });
        expect(await first.status()).toMatchObject({ clients: 2 });

        first.child.kill('SIGKILL');
        await first.exited;
        const answers = await Promise.all([second.status(), third.status()]);
        const told = `round ${round}: ${JSON.stringify(answers.map((answer) => answer.refusal ?? { pid: answer.pid, attached: answer.attached }))}`;
        expect(answers.map((answer) => answer.running), told).toEqual([true, true]);
        expect(answers[0]!.pid, told).toBe(answers[1]!.pid);
        expect([second.pid, third.pid], told).toContain(answers[0]!.pid);
        expect(answers.filter((answer) => answer.attached === true), told).toHaveLength(1);
        // Both are told the page must be opened again: it rides the new primary's status.
        for (const answer of answers) expect(String(answer.note), told).toMatch(/snug_open/);
        await reapAll();
      }
    },
    SLOW,
  );

  it(
    'an attached session’s snug_open is performed by the PRIMARY, and its answer carries no token (L3, L5)',
    async () => {
      const iso = isolation();
      const first = startSession(TEST_BUNDLE, graced(iso));
      await first.initialize();
      const ready = JSON.parse(await first.stderrLine(/\{"ready":true[^\n]*\}/)) as { url: string; port: number };
      const token = new URL(ready.url).hash.replace('#token=', '');
      expect(token).toMatch(/^[0-9a-f]{64}$/);

      const second = await begin(TEST_BUNDLE, graced(iso));
      const opened = await second.tool('snug_open');
      expect(opened).toEqual({ text: `Snug is open at http://127.0.0.1:${ready.port}/`, isError: false });
      // The attached process never learned the bearer, so it cannot have printed it.
      expect(JSON.parse(await second.stderrLine(/\{"ready":true[^\n]*\}/))).toMatchObject({ role: 'attached', url: `http://127.0.0.1:${ready.port}/` });
      expect(second.stderr()).not.toContain(token);
    },
    SLOW,
  );
});

describeBuilt('K5 — the ONE composition is what both bundles run: the parent watch, the failed write, the home', () => {
  const GRACE_MS = 400;
  const graced = (iso: Isolation): Record<string, string> => testEnv(iso, { SNUG_MCP_TEST_GRACE_MS: String(GRACE_MS) });

  it(
    'a runner whose PARENT goes away while its stdin stays open leaves after the grace and gives the lock back — the changed-ppid watch (L7)',
    async () => {
      // A host that crashes does not close the pipe politely. Here the runner's stdin is a
      // pipe THIS TEST holds open, handed down through a stand-in parent — so when that
      // parent is killed no `end` ever arrives, and only the watch can tell the runner its
      // own session is gone.
      const iso = isolation();
      const parent = path.join(scratch(), 'parent.mjs');
      writeFileSync(
        parent,
        `import { spawn } from 'node:child_process';
// stdin: this process's fd 3 (held open by the test). stderr: inherited, for the ready line.
const child = spawn(process.execPath, [process.argv[2]], { stdio: [3, 'ignore', 'inherit'] });
process.stdout.write(String(child.pid) + '\\n');
setInterval(() => {}, 1_000);
`,
      );
      const host = startScript(parent, graced(iso), { args: [TEST_BUNDLE], stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
      const held = host.stdio[3] as Socket;
      held.on('error', () => {});
      closers.push(() => held.destroy());
      let out = '';
      let err = '';
      host.stdout!.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
      host.stderr!.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
      await until(() => out.includes('\n') && err.includes('"ready":true'), `the runner to lead (stderr: ${err.slice(0, 200)})`);
      const pid = Number(out.trim());
      // The runner is this test's own grandchild; if it outlives the test it is reaped by its
      // pid — and only while that pid is still running THIS bundle.
      closers.push(() => {
        if (scriptTokenOf(readCommandLine(pid) ?? '') === TEST_BUNDLE) process.kill(pid, 'SIGKILL');
      });
      expect(JSON.parse(readFileSync(lockFile(iso), 'utf8'))).toMatchObject({ pid });

      host.kill('SIGKILL');
      await new Promise((resolve) => host.once('exit', resolve));
      expect(held.destroyed, 'the runner’s stdin was closed with its parent — this would prove nothing').toBe(false);
      expect(pidAlive(pid)).toBe(true);

      // The watch looks every two seconds; then the grace; then a clean stop.
      await until(() => !pidAlive(pid), 'the orphaned runner to leave', 12_000);
      expect(existsSync(lockFile(iso)), 'the lock was not released').toBe(false);
      expect(existsSync(socketFile(iso)), 'the socket was left behind').toBe(false);
    },
    SLOW,
  );

  it(
    'a host that went away WITHOUT closing the pipe: the failed write ends the session and the runner leaves cleanly — exit 0, lock released',
    async () => {
      const iso = isolation();
      const session = await begin(TEST_BUNDLE, graced(iso));
      expect((await session.status()).running).toBe(true);
      // The host's reading end goes. Its writing end — the runner's stdin — stays open, so
      // no `end` will ever say the session is over: the next answer is a write to nobody.
      session.child.stdout!.destroy();
      session.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9_999, method: 'tools/call', params: { name: 'snug_status', arguments: {} } })}\n`);
      expect(await exitsWithin(session, 10_000), 'the runner never left').toBe(true);
      // An unhandled `error` on stdout is an uncaught exception: exit 1, the lock still held.
      expect(await session.exited).toBe(0);
      expect(existsSync(lockFile(iso)), 'the lock was not released').toBe(false);
      expect(session.stderr()).not.toMatch(/EPIPE/);
    },
    SLOW,
  );

  it(
    'the TEST build never gets a real home: HOME set, SNUG_HOME not → home-unresolved, and nothing is created there (D-B34)',
    async () => {
      // The one difference between the two entries that must never be lost: the release may
      // resolve `$HOME/Snug`, the test build may not — it is the binary the browser suite
      // spawns, and a suite once wrote over the owner's user file. (HOME here is a temp dir.)
      const iso = isolation();
      const env = { HOME: iso.tmp, PATH: iso.env.PATH! };
      const session = await begin(TEST_BUNDLE, { ...env, SNUG_MCP_TEST_ENTRY: '1' }, { cwd: '/' });
      expect(await session.status()).toMatchObject({ running: false, refusal: { code: 'home-unresolved' } });
      expect(existsSync(path.join(iso.tmp, 'Snug'))).toBe(false);

      // The RELEASE build, given exactly that environment, does resolve it.
      const release = await begin(RELEASE_BUNDLE, env, { cwd: '/' });
      expect(await release.status()).toMatchObject({ running: true, pid: release.pid, home: path.join(iso.tmp, 'Snug') });
    },
    SLOW,
  );
});

describeBuilt('L4/L5 — the human CLI, run as a person runs it', () => {
  /** A primary whose launch token the test knows (the test build's ready line). */
  const primaryWithToken = async (iso: Isolation): Promise<{ session: Session; token: string; port: number }> => {
    const session = startSession(TEST_BUNDLE, testEnv(iso));
    await session.initialize();
    const ready = JSON.parse(await session.stderrLine(/\{"ready":true[^\n]*\}/)) as { url: string; port: number };
    return { session, token: new URL(ready.url).hash.replace('#token=', ''), port: ready.port };
  };

  it(
    '`status` prints which runner this is: version, build, pid, platform, home, clients, pages',
    async () => {
      const iso = isolation();
      const session = await begin(RELEASE_BUNDLE, iso.env);
      const mine = await session.status();
      const { code, stdout } = await runVerb(RELEASE_BUNDLE, ['status'], iso.env);
      expect(code).toBe(0);
      const printed = JSON.parse(stdout) as Record<string, unknown>;
      expect(printed).toMatchObject({ running: true, version: mine.version, build: mine.build, pid: session.pid, platform: process.platform, home: iso.home, clients: 0, pages: 0 });
      // A status poll is not a session: asking did not change the answer.
      expect(await session.status()).toMatchObject({ clients: 0 });
    },
    SLOW,
  );

  it(
    '`status` with nothing running says so, exits 1, and starts nothing',
    async () => {
      const iso = isolation();
      const { code, stdout, stderr } = await runVerb(RELEASE_BUNDLE, ['status'], iso.env);
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/not running/i);
      expect(existsSync(lockFile(iso))).toBe(false);
    },
    SLOW,
  );

  it(
    'an unknown verb prints usage, exits 2, and does NOT become a runner',
    async () => {
      const iso = isolation();
      const { code, stdout, stderr } = await runVerb(RELEASE_BUNDLE, ['stauts'], iso.env);
      expect(code).toBe(2);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/usage/i);
      // The old entry treated anything it did not recognise as "no verb" and started serving.
      expect(existsSync(hostDir(iso))).toBe(false);
    },
    SLOW,
  );

  it(
    '`open --print` into a pipe prints the address WITHOUT the token — the canary, on real stdout',
    async () => {
      const iso = isolation();
      const { token, port } = await primaryWithToken(iso);
      for (const args of [['open', '--print'], ['open'], ['status']]) {
        const { code, stdout, stderr } = await runVerb(RELEASE_BUNDLE, args, iso.env);
        expect(code, args.join(' ')).toBe(0);
        expect(stdout + stderr, args.join(' ')).not.toContain(token);
        expect(stdout + stderr, args.join(' ')).not.toMatch(/#token=/);
      }
      const printed = await runVerb(RELEASE_BUNDLE, ['open', '--print'], iso.env);
      expect(printed.stdout).toBe(`http://127.0.0.1:${port}/\n`);
      expect(printed.stderr).toMatch(/run this in your own terminal/i);
    },
    SLOW,
  );

  it(
    '`stop` stops the runner over its socket: it exits 0, the lock is released, and the CLI says which way',
    async () => {
      const iso = isolation();
      const session = await begin(RELEASE_BUNDLE, iso.env);
      await session.status();
      const { code, stdout } = await runVerb(RELEASE_BUNDLE, ['stop'], iso.env);
      expect(code).toBe(0);
      expect(stdout).toMatch(new RegExp(`Stopped Snug \\(pid ${session.pid}\\) over its control socket`));
      expect(await session.exited).toBe(0);
      expect(existsSync(lockFile(iso))).toBe(false);
      expect(existsSync(socketFile(iso))).toBe(false);
    },
    SLOW,
  );

  it(
    '`stop` REFUSES while a page is open; `stop --force` stops, and the page is told',
    async () => {
      const iso = isolation();
      const { session, token, port } = await primaryWithToken(iso);
      const events = await fetch(`http://127.0.0.1:${port}/events`, { headers: { authorization: `Bearer ${token}` } });
      const reader = events.body!.getReader();
      closers.push(() => reader.cancel().catch(() => {}));
      await until(async () => (await session.status()).pages === 1, 'the page to be counted');

      const refused = await runVerb(RELEASE_BUNDLE, ['stop'], iso.env);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/1 Snug page is open/);
      expect(refused.stderr).toMatch(/stop --force/);
      expect(await session.status()).toMatchObject({ running: true, pages: 1 });

      const forced = await runVerb(RELEASE_BUNDLE, ['stop', '--force'], iso.env);
      expect(forced.code).toBe(0);
      expect(await session.exited).toBe(0);
      expect(existsSync(lockFile(iso))).toBe(false);
      // The page heard it (K7 renders it; this is the process's half).
      let seen = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += new TextDecoder().decode(chunk.value);
      }
      expect(seen).toContain('event: shutdown');
    },
    SLOW,
  );

  describe('against an OLDER build, which answers every op with its hello', () => {
    /** A process that behaves as the previous build's socket did, started from a file of the given name. */
    const olderRunner = async (iso: Isolation, fileName: string): Promise<{ pid: number; exited: Promise<unknown> }> => {
      const dir = scratch();
      const file = path.join(dir, fileName);
      mkdirSync(hostDir(iso), { recursive: true });
      writeFileSync(
        file,
        `import { createServer } from 'node:net';
import { rmSync, writeFileSync } from 'node:fs';
const [socket, lock] = [${JSON.stringify(socketFile(iso))}, ${JSON.stringify(lockFile(iso))}];
const hello = { tokenHash: 'old', port: 43999, running: true, clients: 0 };
const server = createServer((peer) => { peer.on('error', () => {}); peer.on('data', () => peer.write(JSON.stringify(hello) + '\\n')); });
server.listen(socket, () => {
  writeFileSync(lock, JSON.stringify({ port: 43999, pid: process.pid, tokenHash: 'old', startedAt: 1, socket }));
  process.stdout.write('up\\n');
});
process.on('SIGTERM', () => { rmSync(lock, { force: true }); rmSync(socket, { force: true }); process.exit(0); });
`,
      );
      const child = startScript(file, iso.env);
      await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
      return { pid: child.pid!, exited: new Promise((resolve) => child.once('exit', resolve)) };
    };

    it(
      'falls back to a SIGNAL — the socket’s hash matches the lock and the command line is ours — and says so',
      async () => {
        const iso = isolation();
        const old = await olderRunner(iso, 'snug-mcp.mjs');
        const { code, stdout } = await runVerb(RELEASE_BUNDLE, ['stop'], iso.env);
        expect(code).toBe(0);
        expect(stdout).toMatch(new RegExp(`Stopped an older Snug \\(pid ${old.pid}\\) with a signal`));
        await old.exited;
        expect(existsSync(lockFile(iso))).toBe(false);
      },
      SLOW,
    );

    it(
      'does NOT signal a process whose command line is not ours, whatever the lock and the socket say',
      async () => {
        const iso = isolation();
        // The same behaviour, started from a file that is not a Snug bundle's name.
        const impostor = await olderRunner(iso, 'looks-like-snug-mcp.mjs');
        const { code, stderr } = await runVerb(RELEASE_BUNDLE, ['stop'], iso.env);
        expect(code).toBe(1);
        expect(stderr).toMatch(/could not be confirmed/);
        // Still running: it was never signalled.
        expect(existsSync(lockFile(iso))).toBe(true);
        expect(() => process.kill(impostor.pid, 0)).not.toThrow();
      },
      SLOW,
    );

    it(
      'a NEWER session cannot work through it either: `status` and `open` name it, and print no address',
      async () => {
        const iso = isolation();
        const old = await olderRunner(iso, 'snug-mcp.mjs');
        const status = await runVerb(RELEASE_BUNDLE, ['status'], iso.env);
        expect(JSON.parse(status.stdout)).toMatchObject({ running: true, older: true, pid: old.pid });
        const open = await runVerb(RELEASE_BUNDLE, ['open'], iso.env);
        expect(open.code).toBe(1);
        expect(open.stderr).toMatch(new RegExp(`older Snug runner \\(pid ${old.pid}\\)`));
        expect(open.stdout).toBe('');
      },
      SLOW,
    );
  });
});
