// AC1/AC7/AC8 — the composition root, on real listeners and a real socket.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildId, VERSION } from '../build.js';
import { CONTROL_OPS, controlCall } from '../control-socket.js';
import { controlSocketPath, readLock } from '../lock.js';
import { refusalFor, refusalSentence } from '../refusals.js';
import { createRefusedRunner, createRunner, type Runner } from '../runner.js';

let home: string;
const started: Runner[] = [];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'snugrun-'));
});
afterEach(async () => {
  for (const runner of started.splice(0)) await runner.stop();
  rmSync(home, { recursive: true, force: true });
});

const make = (over: Partial<Parameters<typeof createRunner>[0]> = {}): Runner => {
  const runner = createRunner({
    home,
    page: () => '<!doctype html><title>kit</title>',
    openBrowser: async () => {},
    // Port 0: the fixed 43127 belongs to a developer's own running Snug, and a test that
    // fights it for the port is a test that fails for the wrong reason.
    lockDeps: { commandLineOf: () => 'node /x/snug-mcp.mjs' },
    ...over,
  });
  started.push(runner);
  return runner;
};

/** A REAL bundle: the schema is strict, so a hand-waved fixture proves nothing. */
const bundle = (displayName = 'Chess', connections: unknown[] = []) => ({
  format: 'snug-app-bundle/1',
  lineage: '0123abcd-4567-89ab-cdef-0123456789ab',
  sharedAt: '2026-09-07T00:00:00.000Z',
  app: { displayName, usesDb: false },
  html: '<!doctype html><title>a</title>',
  connections,
});

describe('the real-home guard (D-B34)', () => {
  it('refuses to construct without a home, rather than defaulting to the live ~/Snug', () => {
    // A runner built by a forgetful caller used to lock, serve and WRITE the owner's real
    // user file. Omission is now a refusal — the only failure mode a data-loss defect may
    // have is one that happens before anything is opened.
    expect(() => createRunner({ page: () => 'kit' } as Parameters<typeof createRunner>[0])).toThrow(/home/i);
  });
});

describe('starting', () => {
  it('becomes the primary and serves the page', async () => {
    const runner = make();
    const { role, port } = await runner.start();
    expect(role).toBe('primary');
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toContain('kit');
  });

  it('puts the token in the launch URL’s FRAGMENT, never its query', async () => {
    const runner = make();
    await runner.start();
    const url = new URL(runner.launchUrl());
    expect(url.hash).toMatch(/token=/);
    expect(url.search).toBe('');
  });
});

describe('the brain readiness probe (D-B35)', () => {
  it('the FIRST authenticated request starts the probe, and that very /status carries its answer — not the first think', async () => {
    // RETITLED 2026-10-03 (the assertions are the ones it always made). It used to say
    // "probes at boot", and the probe no longer does: it is lazy (B1), so a session that only
    // speaks over stdio never spawns the user's CLI. What this proves is the half that
    // mattered to the owner's walk — a logged-out CLI used to surface as a bare 502 the
    // first time an app thought. The page's first request is this `/status`; it starts the
    // probe and waits a moment for it, so a verdict that needs no spawn is named before the
    // user asks for anything. (That nothing probes at start: "the brain probe is lazy", below.)
    const runner = make({ brainState: async () => ({ state: 'logged-out' as const, detail: 'run `claude` and `/login`' }) });
    const { port } = await runner.start();
    const status = (await (await fetch(`http://127.0.0.1:${port}/status`, {
      headers: { authorization: `Bearer ${new URL(runner.launchUrl()).hash.replace('#token=', '')}` },
    })).json()) as { brain?: { state: string } };
    expect(status.brain?.state).toBe('logged-out');
  });

  it('a brain probe that throws does not stop the runner from starting', async () => {
    // The kit must open even when the brain cannot be reached: an app that only stores
    // data still works, and a page that refuses to boot teaches the user nothing.
    const runner = make({ brainState: async () => { throw new Error('probe blew up'); } });
    await expect(runner.start()).resolves.toMatchObject({ role: 'primary' });
  });
});

describe('two sessions, one Snug (D-B9)', () => {
  it('the second attaches to the first rather than spawning a rival', async () => {
    const first = make();
    const a = await first.start();
    const second = make();
    const b = await second.start();
    expect(b.role).toBe('attached');
    expect(b.port).toBe(a.port);
  });

  it('the attached session’s snug_status reports the SAME runner', async () => {
    const first = make();
    const a = await first.start();
    const second = make();
    await second.start();
    const status = JSON.parse((await second.callTool('snug_status', {})).content[0]!.text) as { port: number; attached: boolean };
    expect(status.attached).toBe(true);
    expect(status.port).toBe(a.port);
  });
});

describe('tools', () => {
  it('snug_status names the binding, the port and the file', async () => {
    const runner = make();
    await runner.start();
    const status = JSON.parse((await runner.callTool('snug_status', {})).content[0]!.text) as Record<string, unknown>;
    expect(status).toMatchObject({ running: true, binding: 'local-host' });
    expect(String(status.file)).toMatch(/user\.snug$/);
  });

  it('snug_status never carries the bearer', async () => {
    const runner = make();
    await runner.start();
    const token = new URL(runner.launchUrl()).hash.replace('#token=', '');
    const result = await runner.callTool('snug_status', {});
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('snug_open opens the browser with the FRAGMENT and returns an address without it', async () => {
    const opened: string[] = [];
    const runner = make({ openBrowser: async (url) => void opened.push(url) });
    await runner.start();
    const result = await runner.callTool('snug_open', {});
    expect(opened[0]).toMatch(/#token=/);
    // The token must not ride an MCP message: the tool result is one.
    expect(JSON.stringify(result)).not.toMatch(/#token=/);
  });

  it('snug_open names the CLI fallback when no browser can be opened', async () => {
    const runner = make({ openBrowser: async () => { throw new Error('sandboxed'); } });
    await runner.start();
    const result = await runner.callTool('snug_open', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/scripts\/snug open/);
  });

  it('snug_hand_in refuses a bundle asking for a connection, and says who grants one', async () => {
    // Binding B is the one binding WITH connections — and they are still the user's to
    // grant in the wizard, never something a bundle can bring.
    const runner = make();
    await runner.start();
    // A REAL connection requirement — validated against the protocol's own schema, so the
    // refusal under test is D4's and not a shape error standing in for it.
    const connection = {
      slot: 'bank',
      kind: 'api_key',
      provider: { name: 'SimpleFIN', docsUrl: 'https://beta-bridge.simplefin.org' },
      declaredApiHosts: ['beta-bridge.simplefin.org'],
      fields: [{ key: 'token', label: 'Token', type: 'secret' }],
    };
    const result = await runner.callTool('snug_hand_in', { bundle: bundle('Ledger', [connection]) });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/wizard/);
  });

  it('snug_hand_in refuses a malformed bundle by name', async () => {
    const runner = make();
    await runner.start();
    const result = await runner.callTool('snug_hand_in', { bundle: { format: 'nope' } });
    expect(result.isError).toBe(true);
  });

  it('snug_hand_in says so when no page is open rather than dropping the app', async () => {
    const runner = make();
    await runner.start();
    const result = await runner.callTool('snug_hand_in', { bundle: bundle() });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/snug_open/);
  });
});

describe('the exit grace', () => {
  it('does NOT exit while another session is attached', async () => {
    // MIGRATED (L7 — the migration the plan names). "Attached" used to mean a probe that
    // came and went: nothing was held, so nothing was really counted. A session now HOLDS
    // one control connection for as long as it lives, and that connection is its presence.
    const first = make({ graceMs: 20 });
    await first.start();
    const second = make();
    await second.start(); // holds ONE persistent control connection
    const onExit = vi.fn();
    first.beginGrace(onExit);
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).not.toHaveBeenCalled();
    // …and its leaving is what lets the first one go: the decision is re-made on every change.
    await second.stop();
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 2_000 });
  });

  it('exits once nobody is attached', async () => {
    const runner = make({ graceMs: 20 });
    await runner.start();
    const onExit = vi.fn();
    runner.beginGrace(onExit);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled(), { timeout: 2_000 });
  });
});

describe('the runner reaps the brain’s children (ADR-0069 §5)', () => {
  it('stop() calls the brain’s stop() — reverting the wire would leave pre-warmed children behind', async () => {
    const stop = vi.fn();
    const runner = make({ brain: { stream: async () => {}, stop } });
    await runner.start();
    await runner.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

// =====================================================================================
// The lifecycle range (TASK-20261003): L2 handshake-first, L3 attached sessions, L4 stop,
// L5 the bearer's one way out, L7 presence and succession.
// =====================================================================================

const statusOf = async (runner: Runner): Promise<Record<string, unknown>> => JSON.parse((await runner.callTool('snug_status', {})).content[0]!.text) as Record<string, unknown>;
const tokenOf = (runner: Runner): string => new URL(runner.launchUrl()).hash.replace('#token=', '');
const hostDir = (): string => path.join(home, 'host');
const socketOf = (): string => controlSocketPath(hostDir());

/** A page: one `/events` subscriber on the primary, as the open kit holds. */
const openPage = async (runner: Runner, port: number): Promise<{ read(until: string): Promise<string>; close(): Promise<void> }> => {
  const response = await fetch(`http://127.0.0.1:${port}/events`, { headers: { authorization: `Bearer ${tokenOf(runner)}` } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  return {
    async read(until) {
      while (!text.includes(until)) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    },
    close: () => reader.cancel(),
  };
};

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** What a build from BEFORE this range answers to every line: its hello, no ack. */
const oldPrimary = async (tokenHash = 'an-old-hash'): Promise<void> => {
  mkdirSync(hostDir(), { recursive: true });
  const server: NetServer = createNetServer((peer) => {
    peer.on('error', () => {});
    peer.on('data', () => peer.write(`${JSON.stringify({ tokenHash, port: 43999, running: true, clients: 0 })}\n`));
  });
  await new Promise<void>((resolve) => server.listen(socketOf(), resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 43999, pid: process.pid, tokenHash, startedAt: 1, socket: socketOf() }));
};

describe('no start failure is thrown (L2: handshake first)', () => {
  it('a home it cannot create is a refusal, not an exception', async () => {
    // A FILE where the home should be: mkdir fails whoever runs this (root included).
    writeFileSync(path.join(home, 'blocker'), 'x');
    const runner = make({ home: path.join(home, 'blocker', 'Snug') });
    const started = await runner.start();
    expect(started.role).toBe('degraded');
    expect(started.refusal).toMatchObject({ code: 'home-unwritable' });
    expect(started.refusal!.message).toContain(path.join(home, 'blocker', 'Snug'));
  });

  it('snug_status returns the refusal as its ANSWER — code, message, remedy — not as an error', async () => {
    writeFileSync(path.join(home, 'blocker'), 'x');
    const runner = make({ home: path.join(home, 'blocker', 'Snug') });
    await runner.start();
    const result = await runner.callTool('snug_status', {});
    expect(result.isError).toBeUndefined();
    const status = JSON.parse(result.content[0]!.text) as { running: boolean; refusal: { code: string; message: string; remedy: string } };
    expect(status.running).toBe(false);
    expect(status.refusal.code).toBe('home-unwritable');
    expect(status.refusal.message.length).toBeGreaterThan(10);
    expect(status.refusal.remedy.length).toBeGreaterThan(10);
    // What a person pastes when they report it.
    expect(status).toMatchObject({ version: VERSION, build: buildId(), pid: process.pid, platform: process.platform });
  });

  it.each([['snug_open'], ['snug_hand_in'], ['snug_list_apps']] as const)('%s returns the same sentence, as an error', async (tool) => {
    writeFileSync(path.join(home, 'blocker'), 'x');
    const runner = make({ home: path.join(home, 'blocker', 'Snug') });
    const started = await runner.start();
    const result = await runner.callTool(tool, { bundle: bundle() });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(refusalSentence(started.refusal!));
  });

  it('a tool call made BEFORE start() has settled waits for it, rather than answering from a half-built runner', async () => {
    const runner = make();
    const starting = runner.start();
    const status = await statusOf(runner);
    expect(status.running).toBe(true);
    await starting;
  });

  it('re-runs the start on the next tool call, and PROMOTES itself once the cause is gone', async () => {
    writeFileSync(path.join(home, 'blocker'), 'x');
    const runner = make({ home: path.join(home, 'blocker', 'Snug'), retryFloorMs: 0 });
    expect((await runner.start()).role).toBe('degraded');
    // The user fixes it; nobody restarts the agent.
    rmSync(path.join(home, 'blocker'));
    const status = await statusOf(runner);
    expect(status).toMatchObject({ running: true, binding: 'local-host' });
    expect(status.refusal).toBeUndefined();
    const response = await fetch(`http://127.0.0.1:${String(status.port)}/`);
    expect(await response.text()).toContain('kit');
  });

  it('is rate-bounded: a burst of tool calls is ONE re-run, not one each', async () => {
    mkdirSync(hostDir(), { recursive: true });
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 1, pid: process.pid, tokenHash: 'x', startedAt: 1, socket: socketOf() }));
    const commandLineOf = vi.fn(() => '/usr/sbin/cupsd -l');
    const runner = make({ retryFloorMs: 60_000, lockDeps: { commandLineOf, isAlive: () => true } });
    await runner.start();
    expect(commandLineOf).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i += 1) await runner.callTool('snug_status', {});
    expect(commandLineOf).toHaveBeenCalledTimes(1);
  });

  it('…and with the floor passed, each call does ask again', async () => {
    mkdirSync(hostDir(), { recursive: true });
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 1, pid: process.pid, tokenHash: 'x', startedAt: 1, socket: socketOf() }));
    const commandLineOf = vi.fn(() => '/usr/sbin/cupsd -l');
    const runner = make({ retryFloorMs: 0, lockDeps: { commandLineOf, isAlive: () => true } });
    await runner.start();
    await runner.callTool('snug_status', {});
    await runner.callTool('snug_open', {});
    expect(commandLineOf).toHaveBeenCalledTimes(3);
  });
});

describe('each way a start can fail has its row (L2)', () => {
  it('lock-held-by-stranger: names the pid, signals nothing, and clears when the lock does', async () => {
    mkdirSync(hostDir(), { recursive: true });
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 1, pid: 4_000_001, tokenHash: 'x', startedAt: 1, socket: socketOf() }));
    const kill = vi.fn();
    const runner = make({ retryFloorMs: 0, lockDeps: { isAlive: () => true, commandLineOf: () => '/usr/sbin/cupsd -l', kill } });
    const started = await runner.start();
    expect(started.refusal).toMatchObject({ code: 'lock-held-by-stranger' });
    expect(started.refusal!.message).toContain('pid 4000001');
    expect(kill).not.toHaveBeenCalled();
    // The remedy the sentence gives, performed:
    rmSync(path.join(hostDir(), 'lock.json'));
    expect(await statusOf(runner)).toMatchObject({ running: true });
  });

  it('lock-contended: a socket answering as another lock generation is not joined', async () => {
    await oldPrimary('the-socket-says-this');
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 43999, pid: process.pid, tokenHash: 'the-lock-says-that', startedAt: 1, socket: socketOf() }));
    const started = await make().start();
    expect(started.refusal).toMatchObject({ code: 'lock-contended' });
    expect(started.refusal!.remedy).toMatch(/snug stop/);
  });

  it('older-build: a primary that cannot ack `attach` is NEVER reported as attached (L3)', async () => {
    // It answers the hello — so the lock says "healthy primary, attach" — and then answers
    // `attach`, `call` and everything else with that same hello. Reading that as success is
    // the false success the ack exists to prevent.
    await oldPrimary();
    const runner = make();
    const started = await runner.start();
    expect(started.role).toBe('degraded');
    expect(started.refusal).toMatchObject({ code: 'older-build' });
    expect(started.refusal!.message).toContain(`pid ${process.pid}`);
    const status = await statusOf(runner);
    expect(status).toMatchObject({ running: false, refusal: { code: 'older-build' } });
    const handIn = await runner.callTool('snug_hand_in', { bundle: bundle() });
    expect(handIn.isError).toBe(true);
    expect(handIn.content[0]!.text).toMatch(/older Snug runner/);
  });

  it('socket-path-too-long: decided before anything is locked or bound', async () => {
    const long = path.join(home, 'x'.repeat(120));
    const runner = make({ home: long });
    const started = await runner.start();
    expect(started.refusal).toMatchObject({ code: 'socket-path-too-long' });
    expect(readLock(path.join(long, 'host'))).toBeUndefined();
  });

  it('socket-in-use: a LIVE listener on the socket path is never unlinked, and the lock is given back', async () => {
    mkdirSync(hostDir(), { recursive: true });
    // FIXTURE ONLY (2026-10-03, assertions untouched): the squatter now DISCARDS what it is
    // sent. The runner asks a live socket who it is before refusing (it may be a runner whose
    // lock went missing), and a peer that never reads keeps that unread line — and with it
    // the connection, and this fixture's own `close()` — for ever.
    const squatter: NetServer = createNetServer((peer) => peer.on('error', () => {}).resume());
    await new Promise<void>((resolve) => squatter.listen(socketOf(), resolve));
    closers.push(() => new Promise((resolve) => squatter.close(resolve)));

    const started = await make().start();
    expect(started.refusal).toMatchObject({ code: 'socket-in-use' });
    // Still theirs:
    expect(existsSync(socketOf())).toBe(true);
    // …and nothing of ours left behind to block the next attempt.
    expect(readLock(hostDir())).toBeUndefined();
  });

  it('a DEAD socket file under a lock we hold is replaced — that is litter, not a listener', async () => {
    mkdirSync(hostDir(), { recursive: true });
    writeFileSync(socketOf(), 'left behind');
    const started = await make().start();
    expect(started.role).toBe('primary');
    expect(await controlCall(socketOf(), { op: 'hello' })).toMatchObject({ ok: true, op: 'hello' });
  });

  it('listen-failed: every port refused → the refusal, with the lock given back', async () => {
    const taken: HttpServer = createHttpServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => taken.close(resolve)));
    const { port } = taken.address() as { port: number };

    const started = await make({ ports: [port] }).start();
    expect(started.refusal).toMatchObject({ code: 'listen-failed' });
    expect(started.refusal!.message).toContain('EADDRINUSE');
    expect(readLock(hostDir())).toBeUndefined();
    expect(existsSync(socketOf())).toBe(false);
  });

  it('a busy first port falls back to the next — the fixed port belongs to whoever got there first', async () => {
    const taken: HttpServer = createHttpServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => taken.close(resolve)));
    const { port: busy } = taken.address() as { port: number };

    const started = await make({ ports: [busy, 0] }).start();
    expect(started.role).toBe('primary');
    expect(started.port).not.toBe(busy);
    // The lock records where it REALLY listens (take-over asks that port, L8).
    expect(readLock(hostDir())).toMatchObject({ port: started.port });
  });

  it('a refused runner (home-unresolved, page-damaged) answers the same way and never retries', async () => {
    const refusal = refusalFor('page-damaged', { cli: 'sh /plugin/scripts/snug' });
    const runner = createRefusedRunner(refusal);
    expect(await runner.start()).toMatchObject({ role: 'degraded', refusal });
    expect(await statusOf(runner)).toMatchObject({ running: false, refusal, version: VERSION, pid: process.pid });
    const open = await runner.callTool('snug_open', {});
    expect(open.isError).toBe(true);
    expect(open.content[0]!.text).toBe(refusalSentence(refusal));
    const onExit = vi.fn();
    runner.beginGrace(onExit);
    expect(onExit).toHaveBeenCalledTimes(1);
    await runner.stop();
  });
});

describe('a start that fails leaves NOTHING behind (L2)', () => {
  it('a throw AFTER the lock was taken gives the lock, the listener and the socket back — and the retry leads', async () => {
    // Found by the range's verifier: the catch-all degraded the runner and released nothing.
    // It then held its OWN lock, and its retry judged that record like anybody else's —
    // alive, silent, command line ours — whose last step is a SIGTERM. To itself.
    const ports = [0];
    let thrown = false;
    Object.defineProperty(ports, Symbol.iterator, {
      value(this: number[]) {
        // Read once the lock is held and nothing is bound yet: the first start dies there.
        if (!thrown) {
          thrown = true;
          throw new Error('the disk went away');
        }
        return Array.prototype[Symbol.iterator].call(this);
      },
    });
    const kill = vi.fn();
    const runner = make({ ports, retryFloorMs: 0, lockDeps: { commandLineOf: () => 'node /x/snug-mcp.mjs', kill, sleep: async () => {} } });
    const started = await runner.start();
    expect(started.refusal).toMatchObject({ code: 'home-unwritable' });
    expect(started.refusal!.message).toContain('the disk went away');
    expect(readLock(hostDir()), 'the failed start kept its lock').toBeUndefined();
    expect(existsSync(socketOf())).toBe(false);

    expect(await statusOf(runner)).toMatchObject({ running: true, pid: process.pid });
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('the SOCKET is the last word on who the runner is', () => {
  const hashOf = (runner: Runner): string => createHash('sha256').update(tokenOf(runner)).digest('hex');

  it('a primary whose lock went MISSING is joined through its socket — and its lock names it again', async () => {
    // The state the verifier's stress left behind 3 rounds in 80: a healthy primary, no
    // lock.json. Every later process then WON the lock (nothing to contend with), hit the
    // live socket, and was refused `socket-in-use` — on every retry, until somebody stopped
    // the healthy runner. Whoever answers on the canonical socket IS the runner.
    const first = make();
    const a = await first.start();
    rmSync(path.join(hostDir(), 'lock.json'));

    const second = make();
    const b = await second.start();
    expect(b).toMatchObject({ role: 'attached', port: a.port });
    expect(await statusOf(second)).toMatchObject({ running: true, attached: true, port: a.port });
    expect(await statusOf(first)).toMatchObject({ clients: 1 });
    // …and the lock is the PRIMARY'S again, so the next window attaches the ordinary way.
    expect(readLock(hostDir())).toMatchObject({ pid: process.pid, port: a.port, tokenHash: hashOf(first) });
    const third = make();
    expect(await third.start()).toMatchObject({ role: 'attached', port: a.port });
  });

  it('a lock naming a DEAD process beside a healthy runner is healed the same way — the newcomer joins, never "pid <dead> holds this home"', async () => {
    // The runner's lock went missing, a newcomer won the empty lock and died holding it.
    // `acquire` used to answer every later process `lock-contended` with the dead pid's
    // number, on every retry. Now it replaces the record WITHOUT unlinking the socket, and
    // from there this is the case above: win the lock, meet the live socket, give it back, join.
    const first = make();
    const a = await first.start();
    const DEAD = 4_000_001;
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 43999, pid: DEAD, tokenHash: 'left-by-a-newcomer-that-died', startedAt: 1, socket: socketOf() }));

    const second = make({ retryFloorMs: 60_000, lockDeps: { isAlive: (pid) => pid !== DEAD } });
    const b = await second.start();
    expect(b.refusal).toBeUndefined();
    expect(b).toMatchObject({ role: 'attached', port: a.port });
    expect(await statusOf(second)).toMatchObject({ running: true, attached: true, port: a.port });
    // The healthy runner's socket was never unlinked: it still answers, and counts the session.
    expect(await statusOf(first)).toMatchObject({ running: true, clients: 1 });
    expect(readLock(hostDir())).toMatchObject({ pid: process.pid, port: a.port, tokenHash: hashOf(first) });
  });

  it('a lock that goes missing DURING the start is put back the moment the socket is bound', async () => {
    const ports = [0];
    Object.defineProperty(ports, Symbol.iterator, {
      value(this: number[]) {
        // Read with the lock held and nothing bound yet: this is where it is taken away.
        rmSync(path.join(hostDir(), 'lock.json'));
        return Array.prototype[Symbol.iterator].call(this);
      },
    });
    const runner = make({ ports });
    const { role, port } = await runner.start();
    expect(role).toBe('primary');
    expect(readLock(hostDir())).toMatchObject({ pid: process.pid, port, tokenHash: hashOf(runner) });
  });

  it('…but only a CURRENT runner: a socket that answers nothing, or an older build’s hello, is still socket-in-use', async () => {
    mkdirSync(hostDir(), { recursive: true });
    const older: NetServer = createNetServer((peer) => {
      peer.on('error', () => {});
      peer.on('data', () => peer.write(`${JSON.stringify({ tokenHash: 'old', port: 43999, running: true, clients: 0 })}\n`));
    });
    await new Promise<void>((resolve) => older.listen(socketOf(), resolve));
    closers.push(() => new Promise((resolve) => older.close(resolve)));

    const started = await make().start();
    expect(started.refusal).toMatchObject({ code: 'socket-in-use' });
    expect(readLock(hostDir())).toBeUndefined();
  });
});

describe('the release wiring of the identity reader (L1, L8)', () => {
  it('a WEDGED runner of ours is recognised by the real reader, signalled, waited for and replaced — nothing injected but the clock', async () => {
    // The defect this range opened with: every test injected `commandLineOf`, and the shipped
    // build wired it to `() => undefined`. So this one injects nothing that decides anything:
    // the command line is read from the process table, the pid is really signalled, and its
    // exit is really waited for. Only the five seconds are shortened.
    const silent = createHttpServer();
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as { port: number };
    await new Promise((resolve) => silent.close(resolve));

    mkdirSync(hostDir(), { recursive: true });
    // Started from a file with the BUNDLE'S OWN NAME: that name, read back by `ps`, is the identity.
    const script = path.join(home, 'snug-mcp.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(hostDir(), 'lock.json'))}, JSON.stringify({ port: ${port}, pid: process.pid, tokenHash: 'wedged', startedAt: 1, socket: ${JSON.stringify(socketOf())} }));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1_000);
process.stdout.write('up\\n');
`,
    );
    const wedged = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: path.dirname(process.execPath) } });
    const exited = new Promise<number | null>((resolve) => wedged.once('exit', (code) => resolve(code)));
    closers.push(() => {
      if (wedged.exitCode === null && wedged.signalCode === null) wedged.kill('SIGKILL');
    });
    await new Promise<void>((resolve) => wedged.stdout.once('data', () => resolve()));

    const runner = createRunner({ home, page: () => 'kit', ports: [0], lockDeps: { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms / 20)) } });
    started.push(runner);
    const led = await runner.start();
    expect(led.refusal).toBeUndefined();
    expect(led.role).toBe('primary');
    // Asked to stop (its own handler exits 0) — not killed, and not left running.
    expect(await exited).toBe(0);
    expect(readLock(hostDir())).toMatchObject({ pid: process.pid });
  });
});

describe('a refused runner binds NOTHING (D8 — decided 2026-10-03)', () => {
  // MIGRATED from "a refused runner with something to SAY to a browser". A damaged install
  // used to serve one fixed document from a bare listener on the first port — holding no
  // lock. A healthy install started beside it then found that port taken, fell back to an
  // ephemeral one and lost its OAuth rows (the redirect URI is registered against the fixed
  // port). The decision: a refused runner's whole channel is its tools' answers.
  const freePort = async (): Promise<number> => {
    const probe = createHttpServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));
    return port;
  };
  const refusal = refusalFor('page-damaged', { cli: 'sh /plugin/scripts/snug' });

  it('opens no listener — even handed the document and the port it used to serve', async () => {
    const port = await freePort();
    // @ts-expect-error — the second argument was the notice; a refused runner takes none now.
    const runner = createRefusedRunner(refusal, { html: '<!doctype html><p>This install is damaged', port });
    started.push(runner);
    expect(await runner.start()).toEqual({ role: 'degraded', port: 0, url: '', refusal });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    // The tools are the channel, and they say exactly what they said.
    expect(await statusOf(runner)).toMatchObject({ running: false, refusal });
    // Nothing under the home either: no lock, no socket, not even the directory.
    expect(existsSync(hostDir())).toBe(false);
    // The port is free for whoever comes next — a healthy install leads AT it.
    const healthy = make({ ports: [port, 0] });
    expect(await healthy.start()).toMatchObject({ role: 'primary', port });
  });
});

describe('snug_status says which runner this is (L4)', () => {
  it('reports version, build, pid, platform, home, clients and pages', async () => {
    const runner = make();
    const { port } = await runner.start();
    expect(await statusOf(runner)).toMatchObject({
      running: true,
      version: VERSION,
      build: buildId(),
      pid: process.pid,
      platform: process.platform,
      home,
      file: path.join(home, 'user.snug'),
      port,
      clients: 0,
      pages: 0,
    });
  });

  it('`clients` counts attached SESSIONS, `pages` counts open pages', async () => {
    const first = make();
    const { port } = await first.start();
    const second = make();
    await second.start();
    const page = await openPage(first, port);
    closers.push(() => page.close());
    await vi.waitFor(async () => expect(await statusOf(first)).toMatchObject({ clients: 1, pages: 1 }));
    // A status poll over the socket is not a session:
    for (let i = 0; i < 3; i += 1) await controlCall(socketOf(), { op: 'status' });
    expect(await statusOf(first)).toMatchObject({ clients: 1 });
  });
});

describe('an attached session serves all four tools, through the PRIMARY (L3)', () => {
  const pair = async (overFirst: Parameters<typeof make>[0] = {}, overSecond: Parameters<typeof make>[0] = {}) => {
    const first = make(overFirst);
    const a = await first.start();
    const second = make(overSecond);
    const b = await second.start();
    expect(b.role).toBe('attached');
    return { first, second, port: a.port };
  };

  it('snug_status is the primary’s own, marked as seen from an attached session', async () => {
    const { first, second } = await pair();
    const mine = await statusOf(first);
    const theirs = await statusOf(second);
    expect(theirs).toMatchObject({ ...mine, attached: true });
    expect(mine.attached).toBeUndefined();
  });

  it('snug_hand_in reaches the open page — the path that did not exist before', async () => {
    const { first, second, port } = await pair();
    const page = await openPage(first, port);
    closers.push(() => page.close());
    await vi.waitFor(async () => expect(await statusOf(first)).toMatchObject({ pages: 1 }));

    const result = await second.callTool('snug_hand_in', { bundle: bundle('Chess') });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe('handed "Chess" to the open runner');
    const seen = await page.read('hand-in');
    expect(seen).toContain('"displayName":"Chess"');
  });

  it('answers exactly what the primary answers — attached and primary cannot drift', async () => {
    const { first, second } = await pair();
    for (const [tool, args] of [
      ['snug_hand_in', { bundle: bundle() }], // no page open
      ['snug_hand_in', { bundle: { format: 'nope' } }],
      ['snug_hand_in', {}],
      ['snug_list_apps', {}],
    ] as const) {
      expect(await second.callTool(tool, args), `${tool} ${JSON.stringify(args)}`).toEqual(await first.callTool(tool, args));
    }
  });

  it('a bundle asking for a connection is refused IN THE PRIMARY, whatever the session did (C5)', async () => {
    // Driven over the raw socket: no attached-side code runs, so a refusal here can only be
    // the primary's own re-validation.
    const { first } = await pair();
    void first;
    const connection = {
      slot: 'bank',
      kind: 'api_key',
      provider: { name: 'SimpleFIN', docsUrl: 'https://beta-bridge.simplefin.org' },
      declaredApiHosts: ['beta-bridge.simplefin.org'],
      fields: [{ key: 'token', label: 'Token', type: 'secret' }],
    };
    const answer = await controlCall(socketOf(), { op: 'call', name: 'snug_hand_in', args: { bundle: bundle('Ledger', [connection]) } });
    expect(answer).toMatchObject({ ok: true, op: 'call', result: { isError: true } });
    expect(JSON.stringify(answer)).toMatch(/wizard/);
    const malformed = await controlCall(socketOf(), { op: 'call', name: 'snug_hand_in', args: { bundle: { format: 'nope' } } });
    expect(malformed).toMatchObject({ ok: true, op: 'call', result: { isError: true } });
  });

  it('`call` runs only the four tools — the allowlist holds on the socket too', async () => {
    const { first } = await pair();
    void first;
    for (const name of ['snug_fetch', 'constructor', '__proto__', '', 7, undefined]) {
      expect(await controlCall(socketOf(), { op: 'call', name, args: {} }), String(name)).toEqual({ ok: false, op: 'call', error: 'unknown tool' });
    }
    // Arguments that are not an object never reach a tool.
    expect(await controlCall(socketOf(), { op: 'call', name: 'snug_status', args: 'x' })).toEqual({ ok: false, op: 'call', error: 'arguments must be an object' });
  });

  /** A primary that knows `hello` and `attach`, and answers every other op with `other`. */
  const primaryAnswering = async (other: (hello: Record<string, unknown>, op: string) => unknown): Promise<void> => {
    mkdirSync(hostDir(), { recursive: true });
    const hello = { tokenHash: 'half-new', port: 43999, build: 'abc1234' };
    const peers = new Set<import('node:net').Socket>();
    const server: NetServer = createNetServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('data', (chunk: Buffer) => {
        const { op } = JSON.parse(chunk.toString('utf8')) as { op: string };
        peer.write(`${JSON.stringify(op === 'hello' || op === 'attach' ? { ok: true, op, ...hello } : other(hello, op))}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketOf(), resolve));
    closers.push(() => {
      // The session under test HOLDS a connection; a server waits for those before it closes.
      for (const peer of peers) peer.destroy();
      return new Promise((resolve) => server.close(resolve));
    });
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 43999, pid: process.pid, tokenHash: 'half-new', startedAt: 1, socket: socketOf() }));
  };

  it('an answer that is not the ack of `call` is NEVER read as success (L3)', async () => {
    // `call` answered the way an older build answers everything: a success-shaped hello —
    // here even carrying something shaped like a tool result, the most convincing non-answer
    // there is. Without the ack NAMING `call` the session must say so, not hand the agent
    // "delivered".
    await primaryAnswering((hello) => ({ ...hello, running: true, clients: 1, result: { content: [{ type: 'text', text: 'delivered' }] } }));
    const runner = make();
    expect((await runner.start()).role).toBe('attached');
    for (const tool of ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps'] as const) {
      const result = await runner.callTool(tool, { bundle: bundle() });
      expect(result.isError, tool).toBe(true);
      expect(result.content[0]!.text, tool).toMatch(/older Snug runner/);
    }
  });

  it('an ack that carries no tool result is an error too — the peer is another process, so its answer is parsed', async () => {
    await primaryAnswering((_hello, op) => ({ ok: true, op, result: 'not a tool result' }));
    const runner = make();
    expect((await runner.start()).role).toBe('attached');
    const result = await runner.callTool('snug_list_apps', {});
    expect(result).toMatchObject({ isError: true, content: [{ type: 'text' }] });
  });

  it('a refusal that is NOT an older build is said as what it is — the socket’s own error, never "an older Snug runner"', async () => {
    // The socket cuts an over-long line off with `{ error: 'line too long' }` and no `op`.
    // Every un-acked answer used to be reported as "an older Snug runner is already
    // running", whose remedy is to restart a session that has nothing wrong with it.
    await primaryAnswering(() => ({ error: 'line too long' }));
    const runner = make();
    expect((await runner.start()).role).toBe('attached');
    const result = await runner.callTool('snug_hand_in', { bundle: bundle() });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).not.toMatch(/older Snug runner/);
    expect(result.content[0]!.text).toMatch(/too large/);
  });

  it('a primary that is SLOW is not a primary that is gone: the call is not sent a second time', async () => {
    // A hand-in forwarded twice is an app installed twice. Nothing coming back within the
    // bound used to be read as "the primary went away": the session dropped its presence,
    // re-ran the start, attached again — and sent the same call again.
    mkdirSync(hostDir(), { recursive: true });
    const hello = { tokenHash: 'slow', port: 43999, build: 'abc1234' };
    const calls: string[] = [];
    const peers = new Set<Socket>();
    const server: NetServer = createNetServer((peer) => {
      peers.add(peer);
      peer.on('error', () => {});
      peer.on('data', (chunk: Buffer) => {
        const request = JSON.parse(chunk.toString('utf8')) as { op: string; name?: string };
        if (request.op === 'hello' || request.op === 'attach') peer.write(`${JSON.stringify({ ok: true, op: request.op, ...hello })}\n`);
        else calls.push(String(request.name)); // …and no answer at all
      });
    });
    await new Promise<void>((resolve) => server.listen(socketOf(), resolve));
    closers.push(() => {
      for (const peer of peers) peer.destroy();
      return new Promise((resolve) => server.close(resolve));
    });
    writeFileSync(path.join(hostDir(), 'lock.json'), JSON.stringify({ port: 43999, pid: process.pid, tokenHash: 'slow', startedAt: 1, socket: socketOf() }));

    const runner = make({ callTimeoutMs: 150 });
    expect((await runner.start()).role).toBe('attached');
    const result = await runner.callTool('snug_hand_in', { bundle: bundle() });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/did not answer in time/);
    expect(calls).toEqual(['snug_hand_in']);
    // Still attached to that same primary: its record was not taken, its session not dropped.
    expect(readLock(hostDir())).toMatchObject({ tokenHash: 'slow' });
    expect((await runner.start()).role).toBe('attached');
  });

  it('snug_open makes the PRIMARY open the browser — it holds the bearer, the session never does', async () => {
    const openedByFirst: string[] = [];
    const openedBySecond: string[] = [];
    const { second, port } = await pair({ openBrowser: async (url) => void openedByFirst.push(url) }, { openBrowser: async (url) => void openedBySecond.push(url) });
    const result = await second.callTool('snug_open', {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe(`Snug is open at http://127.0.0.1:${port}/`);
    expect(openedByFirst).toHaveLength(1);
    expect(openedByFirst[0]).toMatch(/#token=/);
    expect(openedBySecond).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/token/);
  });
});

describe('the bearer has one way out besides the page (L5)', () => {
  it('`open` answers the PORT and nothing else; `launch-url` is the one op that answers the address', async () => {
    const opened: string[] = [];
    const runner = make({ openBrowser: async (url) => void opened.push(url) });
    const { port } = await runner.start();
    expect(await controlCall(socketOf(), { op: 'open' })).toEqual({ ok: true, op: 'open', port });
    expect(opened).toEqual([runner.launchUrl()]);
    expect(await controlCall(socketOf(), { op: 'launch-url' })).toEqual({ ok: true, op: 'launch-url', url: runner.launchUrl() });
  });

  it('THE CANARY: the token appears in no answer of any other op — error answers included', async () => {
    let failOpen = false;
    const runner = make({
      openBrowser: async () => {
        if (failOpen) throw new Error('no window server');
      },
      onStopRequested: () => {},
    });
    const { port } = await runner.start();
    const token = tokenOf(runner);
    // The canary must be able to see: the one permitted answer DOES carry it.
    expect(JSON.stringify(await controlCall(socketOf(), { op: 'launch-url' }))).toContain(token);

    const page = await openPage(runner, port);
    closers.push(() => page.close());
    await vi.waitFor(async () => expect(await statusOf(runner)).toMatchObject({ pages: 1 }));

    const answers: unknown[] = [];
    const ask = async (request: Parameters<typeof controlCall>[1]): Promise<void> => void answers.push(await controlCall(socketOf(), request));
    for (const op of CONTROL_OPS) {
      if (op === 'launch-url') continue;
      if (op === 'call') {
        for (const name of ['snug_status', 'snug_open', 'snug_hand_in', 'snug_list_apps', 'snug_fetch']) {
          await ask({ op, name, args: {} });
          await ask({ op, name, args: { bundle: bundle() } });
          await ask({ op, name, args: 'not an object' });
        }
        continue;
      }
      await ask({ op }); // `stop` is REFUSED here: a page is open and nobody said force
    }
    failOpen = true;
    await ask({ op: 'open' });
    await ask({ op: 'call', name: 'snug_open', args: {} });
    await ask({ op: 'goodbye' });
    await ask({ op: 'launch-url-please' });

    expect(answers.length).toBeGreaterThan(20);
    for (const answer of answers) {
      expect(answer, 'every op must answer').toBeDefined();
      expect(JSON.stringify(answer)).not.toContain(token);
      expect(JSON.stringify(answer)).not.toMatch(/#token=/);
    }
    // The refused stop is among them, and the runner is still up.
    expect(answers).toContainEqual({ ok: false, op: 'stop', error: 'pages-open', pages: 1 });
    expect(await statusOf(runner)).toMatchObject({ running: true });
  });

  it('`open` whose browser cannot be opened is an error answer carrying the port — never the address', async () => {
    const runner = make({
      openBrowser: async () => {
        throw new Error('no window server');
      },
    });
    const { port } = await runner.start();
    expect(await controlCall(socketOf(), { op: 'open' })).toEqual({ ok: false, op: 'open', error: 'could not open a browser', port });
  });

  it('snug_open’s fallback names the launcher’s REAL path, and the command that prints the address', async () => {
    const runner = make({
      cli: 'sh "/Users/a b/plugins/snug/scripts/snug"',
      openBrowser: async () => {
        throw new Error('sandboxed');
      },
    });
    await runner.start();
    const result = await runner.callTool('snug_open', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('sh "/Users/a b/plugins/snug/scripts/snug" open --print');
    expect(result.content[0]!.text).not.toContain(tokenOf(runner));
  });
});

describe('presence and succession (L7)', () => {
  it('a TRANSIENT op neither holds the runner nor cancels its grace', async () => {
    const runner = make({ graceMs: 150 });
    await runner.start();
    const onExit = vi.fn();
    const began = Date.now();
    runner.beginGrace(onExit);
    // A status poll every 20 ms, across the whole grace and beyond it.
    const polling = setInterval(() => void controlCall(socketOf(), { op: 'status' }), 20);
    closers.push(() => clearInterval(polling));
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    clearInterval(polling);
    // Counting connections would have reset the grace on every poll and never fired.
    expect(Date.now() - began).toBeLessThan(1_500);
  });

  it('a transient connection OPEN at the moment the session ends does not hold the runner either', async () => {
    // The poll above connects and hangs up; this one connects and STAYS, having said
    // nothing. It is still not a session: only `attach` is.
    const runner = make({ graceMs: 60 });
    await runner.start();
    const { createConnection } = await import('node:net');
    const idle = createConnection(socketOf());
    await new Promise((resolve) => idle.on('connect', resolve));
    closers.push(() => idle.destroy());
    const onExit = vi.fn();
    runner.beginGrace(onExit);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: 2_000 });
  });

  // THE MARGINS (widened 2026-10-03; the claims are unchanged). These two used a 500 ms and a
  // 150 ms grace: the attach had to land inside it, and the look had about 120 ms between
  // the old schedule and the new one. This file runs beside `lifecycle-interop`, which
  // starts dozens of Node processes — under that load a real attach can take longer than
  // that, and the tests would fail for a reason that is not a defect. The grace is now
  // seconds, and every wait is in proportion to it.
  const GRACE_MS = 2_000;

  it(
    'each lonely stretch gets its WHOLE grace: one that was interrupted does not resume where it left off',
    async () => {
      const first = make({ graceMs: GRACE_MS });
      await first.start();
      const onExit = vi.fn();
      const began = Date.now();
      first.beginGrace(onExit); // the grace is armed for began + GRACE
      const second = make();
      await second.start(); // …and cancelled
      await new Promise((r) => setTimeout(r, GRACE_MS / 2));
      await second.stop(); // alone again at about began + GRACE/2: a WHOLE grace ends at began + 1.5 × GRACE
      // A timer that was merely left running would fire at began + GRACE. Looked at a quarter
      // of a grace after that, and a quarter before the new one can end.
      await new Promise((r) => setTimeout(r, GRACE_MS * 1.25 - (Date.now() - began)));
      expect(onExit, 'the interrupted grace fired on its old schedule').not.toHaveBeenCalled();
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1), { timeout: GRACE_MS * 3, interval: 50 });
      // …and it WAS a whole one, counted from when the runner was alone again.
      expect(Date.now() - began).toBeGreaterThanOrEqual(GRACE_MS * 1.5 - 50);
    },
    GRACE_MS * 6,
  );

  it(
    'a session that attaches DURING the grace cancels it',
    async () => {
      const first = make({ graceMs: GRACE_MS });
      await first.start();
      const onExit = vi.fn();
      first.beginGrace(onExit);
      const second = make();
      expect((await second.start()).role).toBe('attached');
      // Past the whole grace, with room: a grace that was not cancelled has fired by now.
      await new Promise((r) => setTimeout(r, GRACE_MS * 1.5));
      expect(onExit).not.toHaveBeenCalled();
    },
    GRACE_MS * 6,
  );

  it('does not exit while its OWN session lives, however many others come and go', async () => {
    const first = make({ graceMs: 20 });
    await first.start();
    const second = make();
    await second.start();
    await second.stop();
    await new Promise((r) => setTimeout(r, 150));
    // No beginGrace was ever called: the first session's own window is still open.
    expect(await statusOf(first)).toMatchObject({ running: true, clients: 0 });
  });

  it('an attached session whose own window closes leaves at once — it holds nothing to wait for', async () => {
    const first = make();
    await first.start();
    const second = make();
    await second.start();
    const onExit = vi.fn();
    second.beginGrace(onExit);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
  });

  it('an attached session whose primary is GONE promotes itself on its next tool call, and says to open again', async () => {
    const first = make();
    const a = await first.start();
    const second = make();
    await second.start();
    const oldToken = tokenOf(first);

    await first.stop(); // the primary's window closed and its runner went with it

    const status = await statusOf(second);
    expect(status).toMatchObject({ running: true, pid: process.pid, pages: 0 });
    expect(status.attached).toBeUndefined();
    // A new runner is a new bearer: the old page cannot talk to it.
    expect(String(status.note)).toMatch(/snug_open/);
    expect(tokenOf(second)).not.toBe(oldToken);
    expect(readLock(hostDir())).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${String(status.port)}/`);
    expect(await response.text()).toContain('kit');
    void a;
  });

  it('the note goes once the page has been opened again', async () => {
    const first = make();
    await first.start();
    const second = make();
    await second.start();
    await first.stop();
    expect(String((await statusOf(second)).note)).toMatch(/snug_open/);
    await second.callTool('snug_open', {});
    expect((await statusOf(second)).note).toBeUndefined();
  });

  it('a primary that was never anything else carries no such note', async () => {
    const runner = make();
    await runner.start();
    expect((await statusOf(runner)).note).toBeUndefined();
  });

  it('a call that finds the primary gone MID-CALL is answered by the promoted runner, not by an error', async () => {
    const first = make();
    await first.start();
    const second = make();
    await second.start();
    await first.stop();
    // No status first: this very call is the one that discovers the loss.
    const result = await second.callTool('snug_hand_in', { bundle: bundle() });
    expect(result.content[0]!.text).toMatch(/no Snug page is open — call snug_open first/);
  });
});

describe('stop (L4)', () => {
  it('refuses while a page is open — the page may hold work the runner has not been given yet', async () => {
    const onStopRequested = vi.fn();
    const runner = make({ onStopRequested });
    const { port } = await runner.start();
    const page = await openPage(runner, port);
    closers.push(() => page.close());
    await vi.waitFor(async () => expect(await statusOf(runner)).toMatchObject({ pages: 1 }));

    expect(await controlCall(socketOf(), { op: 'stop' })).toEqual({ ok: false, op: 'stop', error: 'pages-open', pages: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(onStopRequested).not.toHaveBeenCalled();
  });

  it('--force stops anyway, and only a literal `true` is force', async () => {
    const onStopRequested = vi.fn();
    const runner = make({ onStopRequested });
    const { port } = await runner.start();
    const page = await openPage(runner, port);
    closers.push(() => page.close());
    await vi.waitFor(async () => expect(await statusOf(runner)).toMatchObject({ pages: 1 }));

    for (const force of ['true', 1, 'yes', {}]) {
      expect(await controlCall(socketOf(), { op: 'stop', force })).toMatchObject({ ok: false, error: 'pages-open' });
    }
    expect(await controlCall(socketOf(), { op: 'stop', force: true })).toEqual({ ok: true, op: 'stop', pid: process.pid });
    await vi.waitFor(() => expect(onStopRequested).toHaveBeenCalledTimes(1));
  });

  it('with no page open it stops, acking FIRST', async () => {
    const onStopRequested = vi.fn();
    const runner = make({ onStopRequested });
    await runner.start();
    expect(await controlCall(socketOf(), { op: 'stop' })).toEqual({ ok: true, op: 'stop', pid: process.pid });
    await vi.waitFor(() => expect(onStopRequested).toHaveBeenCalledTimes(1));
  });

  it('with nobody overriding it, `stop` over the socket stops THIS runner — and the caller still reads its ack', async () => {
    // Stopping closes the very socket the answer travels on. Ten rounds, because the
    // failure this guards against is an ordering one.
    for (let round = 0; round < 10; round += 1) {
      const runner = createRunner({ home, page: () => 'kit', openBrowser: async () => {} });
      await runner.start();
      expect(await controlCall(socketOf(), { op: 'stop' }), `round ${round}`).toEqual({ ok: true, op: 'stop', pid: process.pid });
      await vi.waitFor(() => expect(readLock(hostDir())).toBeUndefined());
      await runner.stop();
    }
  });

  it('stop() tells the page, gives the lock back and leaves no socket behind', async () => {
    const runner = make();
    const { port } = await runner.start();
    const page = await openPage(runner, port);
    expect(readLock(hostDir())).toBeDefined();
    await runner.stop();
    expect(await page.read('shutdown')).toContain('event: shutdown');
    expect(readLock(hostDir())).toBeUndefined();
    expect(existsSync(socketOf())).toBe(false);
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('a write in flight when stop begins LANDS before the lock is given back', async () => {
    // The order is the point: a successor that took the lock while this write was still
    // running would be a second writer on the same user file.
    const { request } = await import('node:http');
    const runner = make();
    const { port } = await runner.start();
    const put = request({
      host: '127.0.0.1',
      port,
      path: '/userdb/user.snug',
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenOf(runner)}`, 'content-length': 10 },
    });
    const answered = new Promise<number>((resolve, reject) => {
      put.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      put.on('error', reject);
    });
    put.write('01234'); // half a body: the write is in flight and cannot finish yet
    await new Promise((r) => setTimeout(r, 100));

    let stoppedYet = false;
    const stopping = runner.stop().then(() => void (stoppedYet = true));
    await new Promise((r) => setTimeout(r, 200));
    expect(stoppedYet, 'stop returned with a write still in flight').toBe(false);
    expect(readLock(hostDir()), 'the lock was given back before the write landed').toBeDefined();

    put.end('56789');
    expect(await answered).toBe(204);
    await stopping;
    expect(readLock(hostDir())).toBeUndefined();
    expect(readFileSync(path.join(home, 'user.snug'), 'utf8')).toBe('0123456789');
  });

  it('stop() is safe to call twice, and on a runner that never started', async () => {
    const runner = make();
    await runner.start();
    await runner.stop();
    await expect(runner.stop()).resolves.toBeUndefined();
    await expect(make().stop()).resolves.toBeUndefined();
  });
});

describe('the brain probe is lazy (B1)', () => {
  it('does NOT run at start — a session that only speaks over stdio spawns no CLI', async () => {
    const probe = vi.fn(async () => ({ state: 'ready' }));
    const runner = make({ brainState: probe });
    const { port } = await runner.start();
    await runner.callTool('snug_status', {});
    await fetch(`http://127.0.0.1:${port}/`); // the open document is not a page contact
    await fetch(`http://127.0.0.1:${port}/status`); // a 401 is not one either
    await new Promise((r) => setTimeout(r, 50));
    expect(probe).not.toHaveBeenCalled();
  });

  it('runs ONCE, at the first authenticated request, in the brain’s own neutral directory', async () => {
    const probe = vi.fn(async (_context: { cwd: string }) => ({ state: 'ready' }));
    const runner = make({ brainState: probe });
    const { port } = await runner.start();
    const authed = { headers: { authorization: `Bearer ${tokenOf(runner)}` } };
    await fetch(`http://127.0.0.1:${port}/status`, authed);
    await fetch(`http://127.0.0.1:${port}/status`, authed);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toEqual({ cwd: path.join(home, 'host', 'brain') });
  });

  it('a SLOW probe does not hold the page’s first read — the state arrives by event instead', async () => {
    let finish: (value: { state: string }) => void = () => {};
    const runner = make({ brainState: () => new Promise<{ state: string }>((resolve) => (finish = resolve)) });
    const { port } = await runner.start();
    const authed = { headers: { authorization: `Bearer ${tokenOf(runner)}` } };
    const began = Date.now();
    const first = (await (await fetch(`http://127.0.0.1:${port}/status`, authed)).json()) as { brain?: unknown };
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(first.brain).toBeUndefined();

    const page = await openPage(runner, port);
    closers.push(() => page.close());
    finish({ state: 'logged-out' });
    expect(await page.read('logged-out')).toContain('event: status');
  });

  it('with no probe given there is NO probe — the default never reaches for the real CLI', async () => {
    const runner = make();
    const { port } = await runner.start();
    const body = (await (await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: `Bearer ${tokenOf(runner)}` } })).json()) as { brain?: unknown };
    expect(body.brain).toBeUndefined();
  });
});
