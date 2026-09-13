// Where the user's own CLI is (ADR-0069 §6).
//
// A process a desktop host spawns gets no user PATH. Measured 2026-09-13 on the owner's Mac:
// `launchctl getenv PATH` is empty, and both `node` and `claude` are nvm installs — so a
// bare `spawn('claude')` from under Claude Desktop is ENOENT, and the probe would tell a
// user who HAS the CLI that it is absent. The binary is therefore looked for on PATH first
// and then in the directories the installers actually use, from ONE list
// (`install-roots.json`) that the plugin's sh launcher is templated from as well.
//
// The trust boundary is the user's own home: executing the first `claude` found under it
// is the same trust as the user's shell (threat-model residual 1 — any same-user process).

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import roots from './install-roots.json';

export interface InstallRoots {
  /** Directories holding binaries directly; `~/` means HOME. */
  binDirs: readonly string[];
  /** Directories holding one sub-directory per installed version, binaries under `bin`. */
  versionedRoots: readonly { root: string; bin: string }[];
}

export const INSTALL_ROOTS: InstallRoots = roots;

export interface ResolveDeps {
  /** HOME and PATH, read BY NAME by the caller — never the whole environment. */
  env: { HOME?: string; PATH?: string };
  /** Is this file present and executable? */
  exists(file: string): boolean;
  /** The entries of a directory; `[]` when it does not exist. */
  readdir(dir: string): string[];
}

/**
 * The production deps. Takes the environment as a parameter so the ONLY reads are the two
 * named variables — `scripts/check-host-mcp.mjs` sweeps the release bundle for every env
 * read and caps whole-object reads, and this module must add none.
 */
export function defaultResolveDeps(env: Record<string, string | undefined>): ResolveDeps {
  const named: { HOME?: string; PATH?: string } = {};
  if (typeof env.HOME === 'string') named.HOME = env.HOME;
  if (typeof env.PATH === 'string') named.PATH = env.PATH;
  return {
    env: named,
    exists: (file) => {
      // A FILE that is executable — a directory named `claude` is executable too, and is
      // not a binary.
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
    readdir: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
  };
}

function expandHome(dir: string, home: string | undefined): string | undefined {
  if (!dir.startsWith('~/')) return dir;
  if (home === undefined || home === '') return undefined;
  return path.join(home, dir.slice(2));
}

/** `v22.13.1` → [22, 13, 1]; anything unparsable sorts last. */
function versionKey(name: string): number[] {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(name);
  if (match === null) return [-1];
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function byVersionDesc(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (kb[i] ?? 0) - (ka[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Every directory to look in, in order: PATH (empty entries dropped — a shell reads them as
 * the working directory, and a binary resolver must not), then the fixed bin dirs, then
 * each versioned root's versions from highest to lowest.
 */
export function candidateDirs(deps: ResolveDeps, installRoots: InstallRoots = INSTALL_ROOTS): string[] {
  const dirs: string[] = [];
  for (const entry of (deps.env.PATH ?? '').split(path.delimiter)) {
    if (entry !== '' && entry !== '.') dirs.push(entry);
  }
  for (const dir of installRoots.binDirs) {
    const expanded = expandHome(dir, deps.env.HOME);
    if (expanded !== undefined) dirs.push(expanded);
  }
  for (const { root, bin } of installRoots.versionedRoots) {
    const expanded = expandHome(root, deps.env.HOME);
    if (expanded === undefined) continue;
    for (const version of [...deps.readdir(expanded)].sort(byVersionDesc)) {
      dirs.push(path.join(expanded, version, bin));
    }
  }
  return dirs;
}

/** The first executable `<dir>/<name>` in candidate order, or undefined when there is none. */
export function resolveBinary(name: string, deps: ResolveDeps, installRoots: InstallRoots = INSTALL_ROOTS): string | undefined {
  for (const dir of candidateDirs(deps, installRoots)) {
    const file = path.join(dir, name);
    if (deps.exists(file)) return file;
  }
  return undefined;
}
