// Driving the BUILT bundles as real processes — shared by `mcp-interop.test.ts` and
// `lifecycle-interop.test.ts`.
//
// THE ISOLATION CONTRACT (D1), written once so no suite restates a weaker one. Every
// process these tests start gets an environment made of exactly three variables:
//
//   HOME       a fresh directory under the OS temp dir
//   SNUG_HOME  <that directory>/Snug
//   PATH       the directory of the Node running the suite
//
// — never `...process.env`. The release bundle is the one build allowed to resolve the
// user's REAL `~/Snug` (D-B34), and a test that hands it the developer's environment is one
// `SNUG_HOME` typo away from a second writer on the owner's file (lessons 2026-09-07/08).
// With this env there is no real home for it to find. It also means nothing here can meet
// a runner the developer already has open: a different home is a different lock.
//
// Every child is one THIS file spawned, and `reapAll()` kills only those — then FAILS, by
// name, if the suite has left a process or a temp directory behind anyway.

import { execFileSync, spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_BUNDLE = path.resolve(here, '../../dist/snug-mcp.mjs');
export const TEST_BUNDLE = path.resolve(here, '../../dist/snug-mcp.test.mjs');

const SOURCE_DIR = path.resolve(here, '..');
const PACKAGE_DIR = path.resolve(here, '../..');

/** The most recently changed file a bundle is built from: everything under `src/` but the tests. */
function newestSource(dir: string): { file: string; mtimeMs: number } {
  let newest = { file: dir, mtimeMs: 0 };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const file = path.join(dir, entry.name);
    const found = entry.isDirectory() ? newestSource(file) : { file, mtimeMs: statSync(file).mtimeMs };
    if (found.mtimeMs > newest.mtimeMs) newest = found;
  }
  return newest;
}

/**
 * Why a bundle cannot be judged — or `undefined` when it can.
 *
 * These suites exist because the BUILT bundle once differed from everything the unit tests
 * saw. So a bundle that is not there, or was built before the sources changed, is not a
 * reason to skip: skipped proves nothing and reads as a pass, and a stale bundle is worse —
 * it is yesterday's code being given today's verdict. Both are a FAILING test that says what
 * to run. (A source touched without being changed also reads as stale: the safe direction,
 * and one build clears it.)
 */
export function bundleProblem(bundle: string, sourceDir: string = SOURCE_DIR): string | undefined {
  const name = path.relative(PACKAGE_DIR, bundle);
  const built = statSync(bundle, { throwIfNoEntry: false });
  if (built === undefined) return `CANNOT RUN — ${name} is missing. Build first: pnpm --filter host-mcp build`;
  const newest = newestSource(sourceDir);
  if (newest.mtimeMs > built.mtimeMs) {
    return `CANNOT RUN — ${name} is STALE: ${path.relative(PACKAGE_DIR, newest.file)} changed after it was built. Rebuild: pnpm --filter host-mcp build`;
  }
  return undefined;
}

export interface Isolation {
  /** The temp directory everything lives under. */
  tmp: string;
  /** `<tmp>/Snug` — what `SNUG_HOME` is set to. */
  home: string;
  env: Record<string, string>;
}

const temps: string[] = [];
const children: ChildProcess[] = [];

/** A fresh home and the three-variable environment that points at it. */
export function isolation(): Isolation {
  // Short on purpose: `sun_path` is ~104 bytes and the control socket lives under this.
  const tmp = mkdtempSync(path.join(tmpdir(), 'snug-i-'));
  temps.push(tmp);
  const home = path.join(tmp, 'Snug');
  return { tmp, home, env: { HOME: tmp, SNUG_HOME: home, PATH: path.dirname(process.execPath) } };
}

/** A scratch directory that is removed with the rest (for a copied bundle, a fake runner). */
export function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-s-'));
  temps.push(dir);
  return dir;
}

export interface ToolAnswer {
  text: string;
  isError: boolean;
}

export interface Session {
  child: ChildProcess;
  pid: number;
  /** One JSON-RPC request; rejects on an error answer or when nothing answers in time. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** The MCP handshake a host performs. Resolves with the server's own answer. */
  initialize(): Promise<{ serverInfo: { name: string; version: string }; instructions: string }>;
  tool(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  /** `snug_status`, parsed. */
  status(): Promise<Record<string, unknown>>;
  /** Close the pipe — how a host ends a session. */
  endInput(): void;
  /** The exit code, once it has exited. */
  exited: Promise<number | null>;
  hasExited(): boolean;
  stderr(): string;
  /** Wait for a line on stderr (the test build's ready line). */
  stderrLine(match: RegExp, timeoutMs?: number): Promise<string>;
}

/** Start a bundle in MCP mode and speak newline-delimited JSON-RPC to it. */
export function startSession(bundle: string, env: Record<string, string>, options: { cwd?: string } = {}): Session {
  const child = spawn(process.execPath, [bundle], { stdio: ['pipe', 'pipe', 'pipe'], env, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) });
  children.push(child);
  let exitedYet = false;
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code) => {
      exitedYet = true;
      resolve(code);
    }),
  );
  // A write to a child that has gone is that child's story, told by `exited`.
  child.stdin!.on('error', () => {});

  let errText = '';
  const errWaiters: Array<() => void> = [];
  child.stderr!.on('data', (chunk: Buffer) => {
    errText += chunk.toString('utf8');
    for (const wake of errWaiters.splice(0)) wake();
  });

  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let outText = '';
  child.stdout!.on('data', (chunk: Buffer) => {
    outText += chunk.toString('utf8');
    for (;;) {
      const newline = outText.indexOf('\n');
      if (newline === -1) break;
      const line = outText.slice(0, newline);
      outText = outText.slice(newline + 1);
      if (line.trim() === '') continue;
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : waiting.get(message.id);
      if (waiter === undefined) continue;
      waiting.delete(message.id!);
      if (message.error !== undefined) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    }
  });

  let nextId = 1;
  const request = (method: string, params: unknown = {}): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`no answer to ${method} within 20s (exited: ${exitedYet}); stderr: ${errText.slice(0, 400)}`));
      }, 20_000);
      waiting.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> => {
    const result = (await request('tools/call', { name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]?.text ?? '', isError: result.isError === true };
  };

  return {
    child,
    pid: child.pid ?? -1,
    request,
    async initialize() {
      const answer = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lifecycle-test', version: '0.0.0' } });
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return answer as { serverInfo: { name: string; version: string }; instructions: string };
    },
    tool,
    status: async () => JSON.parse((await tool('snug_status')).text) as Record<string, unknown>,
    endInput: () => child.stdin!.end(),
    exited,
    hasExited: () => exitedYet,
    stderr: () => errText,
    stderrLine: (match, timeoutMs = 20_000) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no stderr line matching ${String(match)}; saw: ${errText.slice(0, 400)}`)), timeoutMs);
        const look = (): void => {
          const found = match.exec(errText);
          if (found === null) {
            errWaiters.push(look);
            return;
          }
          clearTimeout(timer);
          resolve(found[0]);
        };
        look();
      }),
  };
}

/** Run a bundle with a verb, as a person would, and collect what it printed. stdout is a PIPE here — never a terminal. */
export function runVerb(bundle: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bundle, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Start any Node script as a child this file owns (a fake runner, a stand-in parent). */
export function startScript(file: string, env: Record<string, string>, options: { args?: string[]; stdio?: StdioOptions } = {}): ChildProcess {
  const child = spawn(process.execPath, [file, ...(options.args ?? [])], { stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], env });
  children.push(child);
  return child;
}

/** Whether a process exits within `ms`. */
export const exitsWithin = (session: Pick<Session, 'exited'>, ms: number): Promise<boolean> =>
  Promise.race([session.exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

/**
 * The processes whose PARENT is this one, as `pid command` — read from the process table, so
 * it sees a child whoever spawned it (the SDK's transport, a bare `spawn` in a test).
 * `undefined` where that cannot be read reliably: no `ps`, or a pool whose workers share
 * one process id with the files running beside this one.
 */
export function liveChildren(): string[] | undefined {
  if (!isMainThread) return undefined;
  let table: string;
  try {
    // `-A`: every process, in the one spelling macOS and Linux agree on.
    table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
  return table
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((row): row is RegExpExecArray => row !== null && Number(row[2]) === process.pid)
    // Not the `ps` that is answering (itself a child of this process), and not a child that
    // has EXITED and is only waiting to be collected — `(node)` on macOS, `<defunct>` on Linux.
    .filter((row) => !/^(\S*\/)?ps\b/.test(row[3]!) && !/^\(.*\)$|<defunct>$/.test(row[3]!.trim()))
    .map((row) => `${row[1]} ${row[3]}`);
}

/**
 * Kill every child THIS file spawned that is still alive, then remove every temp directory —
 * and FAIL if anything is left: a registered child that did not go, a directory that is
 * still there, or ANY other live child of this process. That last one is the class of
 * defect this guards (found 2026-10-03): two children started with a bare `spawn`, outside
 * this registry, which no reaper owned. A suite that starts real processes owes the machine
 * none of them afterwards (lessons 2026-08-18/19).
 */
export async function reapAll(): Promise<void> {
  const spawned = children.splice(0);
  await Promise.all(
    spawned
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map(
        (child) =>
          new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            child.kill('SIGKILL');
          }),
      ),
  );
  const dirs = temps.splice(0);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });

  const left = [
    ...spawned.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => `process ${String(child.pid)} (registered, still alive)`),
    ...(liveChildren() ?? []).map((child) => `process ${child} (a child nobody reaped)`),
    ...dirs.filter((dir) => existsSync(dir)).map((dir) => `directory ${dir}`),
  ];
  if (left.length > 0) throw new Error(`the suite left something behind:\n  ${left.join('\n  ')}`);
}
