// Is that pid one of ours? (L1/L8)
//
// A pid recorded in the lock can outlive the runner it named: pids recycle, and a recycled
// one is a live STRANGER. Take-over signals what it replaces, so "a number alone is never
// enough" (the desktop reaper's rule, lessons 2026-08-18/19) — the command line must name
// the thing we would have started.
//
// WHAT WAS WRONG, both halves found 2026-10-03. The rule was a substring (`/snug-mcp/`),
// which is satisfied by `tail -f snug-mcp.log`, an editor holding the bundle, a shell in a
// folder of that name. And the reader behind it was wired to `() => undefined` in the
// shipped build, so in practice NOTHING was ours and every second window was refused.
//
// THE RULE NOW: the program is Node, and the script it was given — the argv token after the
// binary — is a file whose own name is on the list below. A list, because the bundle is
// about to be renamed (ADR-0069 §3) and a runner started before an update must still be
// recognised by the one started after it.
//
// WHERE THE LINE CANNOT SAY which token that is — macOS's `ps` joins argv with spaces, and
// `~/Library/Application Support/…` is where that system keeps app data — the FILE SYSTEM
// is asked (`scriptTokenOf`). Where that settles nothing either, the answer is "not ours".
//
// This is read in ONE situation only: a live pid that does not answer its control socket.
// A runner that answers is identified by the token hash it answers with, which no stranger
// can produce — so attaching never depends on reading a process table.

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

/**
 * The file names a Snug host process is started from: the release bundle, the test bundle,
 * and the name the pending rename gives the release bundle. Pinned by test against the
 * plugin's `BUNDLE_PATH` and both Vite configs.
 */
export const BUNDLE_BASENAMES = ['snug-mcp.mjs', 'snug-mcp.test.mjs', 'snug-local-host.mjs'] as const;

/** The launcher execs `node`, the tests spawn `process.execPath`: the binary's own name is `node`. */
const NODE_BINARY = 'node';

const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

/** Whether a path names an existing regular file. What cannot be looked at is not one. */
const isExistingFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The script a Node command line runs, or `undefined` when the program is not Node.
 *
 * Two spellings arrive here. Linux's `/proc/<pid>/cmdline` is the EXACT argv, NUL-separated:
 * the script is the first argument that is not one of Node's flags, spaces and all.
 *
 * `ps` joins argv with spaces, so a script path containing one cannot be told from two
 * arguments BY THE LINE. It used to be split on whitespace and left at that — "such a path
 * simply reads as some other script" — which made every runner installed under a folder
 * with a space in its name a stranger: wedged, it was refused with a remedy to delete the
 * lock of a process still holding the user file, and `snug stop` could never signal an
 * older build there (found 2026-10-03 on the built bundle under `…/Application Support/`).
 * So the file system settles it: from the first token after Node's flags, the script is the
 * SHORTEST run of tokens that names an existing file. Shortest, because `node tool.mjs
 * bundle.mjs` is somebody reading the bundle — a script that exists is the script, whatever
 * follows it.
 *
 * When that settles nothing the first token is the script, as it always was: a RELATIVE
 * script (relative to the other process's working directory, which is not ours to guess), a
 * file that has since been removed, a Node binary whose OWN path has a space. Such a line
 * reads as some other script, and that is the safe direction: not ours means a refusal
 * with a remedy, never a signal.
 *
 * `isFile` is injected only so a test can see WHEN the file system is asked.
 */
export function scriptTokenOf(commandLine: string, isFile: (file: string) => boolean = isExistingFile): string | undefined {
  if (commandLine.includes('\0')) {
    const [binary, ...rest] = commandLine.split('\0').filter((token) => token !== '');
    if (binary === undefined || basename(binary) !== NODE_BINARY) return undefined;
    // Node's own flags come before the script; the first token that is not one IS the script.
    return rest.find((token) => !token.startsWith('-'));
  }

  // Each token WITH its place in the line: a candidate is cut from the line itself, so the
  // whitespace inside a path is the path's own and not whatever a join would put back.
  const words = Array.from(commandLine.matchAll(/\S+/g), (match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  const [binary, ...rest] = words;
  if (binary === undefined || basename(binary.text) !== NODE_BINARY) return undefined;
  const first = rest.findIndex((word) => !word.text.startsWith('-'));
  const script = rest[first];
  if (script === undefined) return undefined;
  if (script.text.startsWith('/')) {
    for (const last of rest.slice(first)) {
      const candidate = commandLine.slice(script.start, last.end);
      if (isFile(candidate)) return candidate;
    }
  }
  return script.text;
}

/** Whether a command line is a Snug host process — by its script's own name, never a substring. */
export function isSnugCommandLine(commandLine: string | undefined): boolean {
  if (commandLine === undefined) return false;
  const script = scriptTokenOf(commandLine);
  return script !== undefined && (BUNDLE_BASENAMES as readonly string[]).includes(basename(script));
}

/**
 * A process's command line, or `undefined` when it cannot be read (no such pid, no `ps`).
 * Unreadable is NOT ours — the caller refuses rather than guessing.
 */
export function readCommandLine(pid: number): string | undefined {
  // The pid comes out of a file another process wrote; it reaches an argv only as a number.
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      return raw === '' ? undefined : raw;
    }
    // By ABSOLUTE path (holder.ts is the precedent): a host-spawned process has no PATH to
    // find `ps` on. `-ww` lifts the column limit — a truncated line would cut the script off.
    const line = execFileSync('/bin/ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return line === '' ? undefined : line;
  } catch {
    return undefined;
  }
}

/** Whether the pid exists. EPERM is ALIVE: a process we may not signal is still a process. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Ask a process to shut down (SIGTERM). Only ever called for a pid whose command line was
 * just read and is ours. A failure is not reported: the caller's next step is to WAIT for
 * the pid to go, and that wait is what decides.
 */
export function askToStop(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* gone already, or not ours to signal */
  }
}
