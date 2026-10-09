// L1/L8 — whose pid is that?
//
// WHY THIS FILE EXISTS. The old rule was `/snug-mcp/.test(commandLine)`, fed by a reader the
// shipped build wired to `() => undefined` — so in the release nothing was ever "ours" (the
// attach path was dead, 2026-10-03), and in the tests anything MENTIONING the name was: a
// `tail -f snug-mcp.log`, an editor with the bundle open, a shell sitting in a folder called
// `snug-mcp`. Identity decides whether a live process may be SIGNALLED, so the rule here is
// the narrow one: the Node binary, then the script it was given, and that script's own name
// on a list.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { askToStop, BUNDLE_BASENAMES, isAlive, isSnugCommandLine, readCommandLine, scriptTokenOf } from '../identity.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('the accepted bundle names', () => {
  it('is the release bundle, the test bundle and the name the pending rename gives it (ADR-0069 §3)', () => {
    expect([...BUNDLE_BASENAMES]).toEqual(['snug-mcp.mjs', 'snug-mcp.test.mjs', 'snug-local-host.mjs']);
  });

  it('contains the name the PLUGIN ships the bundle under — read from the manifests module, not restated', () => {
    // One contract, two files: the plugin build decides the shipped file's name
    // (`BUNDLE_PATH`) and this list decides which processes may be taken over. A rename on
    // one side only would make every shipped runner a stranger to the next one.
    const manifests = readFileSync(path.resolve(here, '../../../../scripts/lib/plugin-manifests.mjs'), 'utf8');
    const shipped = /export const BUNDLE_PATH = '([^']+)'/.exec(manifests)?.[1];
    expect(shipped, 'BUNDLE_PATH moved or changed its spelling in plugin-manifests.mjs').toBeDefined();
    expect(BUNDLE_BASENAMES as readonly string[]).toContain(path.posix.basename(shipped!));
  });

  it('contains the names this package builds (both Vite configs)', () => {
    for (const config of ['vite.config.ts', 'vite.test-entry.config.ts']) {
      const built = /entryFileNames: '([^']+)'/.exec(readFileSync(path.resolve(here, '../..', config), 'utf8'))?.[1];
      expect(BUNDLE_BASENAMES as readonly string[]).toContain(built);
    }
  });
});

describe('the script token', () => {
  it('is the token after the Node binary', () => {
    expect(scriptTokenOf('node /x/snug-mcp.mjs')).toBe('/x/snug-mcp.mjs');
    expect(scriptTokenOf('/Users/a/.nvm/versions/node/v24.16.0/bin/node /plugin/scripts/snug-mcp.mjs')).toBe('/plugin/scripts/snug-mcp.mjs');
  });

  it('skips Node’s own flags', () => {
    expect(scriptTokenOf('node --enable-source-maps /x/snug-mcp.mjs open')).toBe('/x/snug-mcp.mjs');
  });

  it('reads an EXACT argv (Linux’s NUL-separated /proc form), spaces and all', () => {
    expect(scriptTokenOf('/usr/bin/node\0/home/a b/plugin/scripts/snug-mcp.mjs\0')).toBe('/home/a b/plugin/scripts/snug-mcp.mjs');
  });

  it('is absent when the binary is not Node — the token after `vim` is a file being edited', () => {
    expect(scriptTokenOf('vim /x/snug-mcp.mjs')).toBeUndefined();
    expect(scriptTokenOf('/usr/bin/tail -f /x/snug-mcp.mjs')).toBeUndefined();
  });

  it('is absent for an empty line', () => {
    expect(scriptTokenOf('')).toBeUndefined();
    expect(scriptTokenOf('node')).toBeUndefined();
  });
});

describe('isSnugCommandLine', () => {
  it.each(BUNDLE_BASENAMES.map((name) => [name]))('accepts node running %s', (name) => {
    expect(isSnugCommandLine(`/opt/homebrew/bin/node /some/where/${name}`)).toBe(true);
  });

  it('accepts a bare relative script — how a developer runs it from dist/', () => {
    expect(isSnugCommandLine('node snug-mcp.mjs')).toBe(true);
  });

  it('refuses an unreadable command line — no evidence is not identity', () => {
    expect(isSnugCommandLine(undefined)).toBe(false);
  });

  it('NEVER matches a substring: a name that merely contains ours is a stranger', () => {
    // Each of these satisfied the old `/snug-mcp/` rule, and take-over signals what it
    // classifies as ours.
    for (const line of [
      'node /x/snug-mcp.mjs.bak',
      'node /x/not-snug-mcp.mjs',
      'node /x/snug-mcp/server.js',
      'node /x/snug-mcp',
      'tail -f /tmp/snug-mcp.log',
      '/bin/zsh -c cd ~/snug-mcp && npm test',
      '/usr/bin/some-unrelated-daemon --serve',
    ]) {
      expect(isSnugCommandLine(line), line).toBe(false);
    }
  });

  it('refuses our bundle’s path as an ARGUMENT to another script', () => {
    // `node analyse.mjs dist/snug-mcp.mjs` is somebody reading the bundle, not running it.
    expect(isSnugCommandLine('node /x/analyse.mjs /x/snug-mcp.mjs')).toBe(false);
  });

  it('refuses another program holding our bundle’s path', () => {
    expect(isSnugCommandLine('vim /x/snug-mcp.mjs')).toBe(false);
    expect(isSnugCommandLine('/usr/bin/less /x/snug-mcp.mjs')).toBe(false);
  });

  it('fails CLOSED on a `ps` line whose spaced script path is NOT A FILE here — it cannot be told from two arguments', () => {
    // RETITLED 2026-10-03 (the assertion is the one it always made). `ps` joins argv with
    // spaces, so `/a b/snug-mcp.mjs` reads as the script `/a` and an argument — unless the
    // file system says otherwise (the next block). Nothing on this machine is at this path,
    // so nothing settles it, and not ours is the safe answer: the caller refuses with a
    // remedy and signals nothing. Linux’s exact argv (above) has no such ambiguity.
    expect(isSnugCommandLine('node /Users/x/Application Support/snug/scripts/snug-mcp.mjs')).toBe(false);
  });
});

// ------------------------------------------------------------------ a path with whitespace
//
// Found by the lifecycle range's verifier (2026-10-03), on the built bundle copied under
// `<tmp>/Application Support/plug/`: macOS's `ps` joins argv with spaces, the rule split on
// them, and so EVERY runner installed under a path with a space was "not a Snug runner" —
// a wedged one of ours was refused as a stranger, with a remedy to delete the lock of a
// process still holding the user file, and `snug stop` could never signal an older build.
// `~/Library/Application Support/…` is where macOS apps keep their data.
//
// What cannot be read from the line can be asked of the file system: the script is the
// first run of tokens, from the one after Node's flags, that names an existing FILE.

describe('a `ps` line whose script path has WHITESPACE is settled by the file system', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'snug-id-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A real file under the temp root, at a path with as many spaces as its segments carry. */
  const file = (...segments: string[]): string => {
    const target = path.join(root, ...segments);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
    return target;
  };

  it('the script is the first absolute run of tokens that is an existing FILE — and its own name decides', () => {
    const script = file('Library', 'Application Support', 'Claude', 'plugins', 'snug', 'scripts', 'snug-mcp.mjs');
    const line = `/Users/a/.nvm/versions/node/v24.16.0/bin/node ${script}`;
    expect(scriptTokenOf(line)).toBe(script);
    expect(isSnugCommandLine(line)).toBe(true);
  });

  it.each(BUNDLE_BASENAMES.map((name) => [name]))('accepts node running %s from a folder with a space in its name', (name) => {
    expect(isSnugCommandLine(`node ${file('Application Support', 'plug', name)}`)).toBe(true);
  });

  it('skips Node’s flags before it, and stops at the script: what follows are the program’s own arguments', () => {
    const script = file('Application Support', 'snug-mcp.mjs');
    expect(scriptTokenOf(`node --enable-source-maps ${script} open --print`)).toBe(script);
    expect(isSnugCommandLine(`node --enable-source-maps ${script} stop --force`)).toBe(true);
  });

  it('keeps the path’s OWN whitespace — two spaces in a folder name are two spaces', () => {
    const script = file('two  spaces', 'and a\ttab', 'snug-mcp.mjs');
    expect(scriptTokenOf(`node ${script}`)).toBe(script);
    expect(isSnugCommandLine(`node ${script}`)).toBe(true);
  });

  it('the SHORTEST run that is a file wins: our bundle as an argument to a script in that folder is still somebody reading it', () => {
    const tool = file('My Tools', 'analyse.mjs');
    const bundle = file('My Tools', 'snug-mcp.mjs');
    expect(scriptTokenOf(`node ${tool} ${bundle}`)).toBe(tool);
    expect(isSnugCommandLine(`node ${tool} ${bundle}`)).toBe(false);
  });

  it('never a substring, here either: a name that merely contains ours is a stranger', () => {
    for (const name of ['snug-mcp.mjs.bak', 'not-snug-mcp.mjs', 'snug-mcp']) {
      expect(isSnugCommandLine(`node ${file('Application Support', name)}`), name).toBe(false);
    }
  });

  it('a DIRECTORY of that name is not a script', () => {
    mkdirSync(path.join(root, 'Application Support', 'snug-mcp.mjs'), { recursive: true });
    expect(isSnugCommandLine(`node ${path.join(root, 'Application Support', 'snug-mcp.mjs')}`)).toBe(false);
  });

  it('fails CLOSED when nothing resolves: a spaced path with no file behind it reads as its first token, as before', () => {
    const gone = path.join(root, 'Application Support', 'removed', 'snug-mcp.mjs');
    expect(scriptTokenOf(`node ${gone}`)).toBe(path.join(root, 'Application'));
    expect(isSnugCommandLine(`node ${gone}`)).toBe(false);
  });

  it('a RELATIVE script is never joined with what follows — it cannot be looked up from here', () => {
    // Its path is relative to the OTHER process's working directory. The token is the script
    // (how a developer runs `node snug-mcp.mjs` from dist/), and the bundle after it an argument.
    const bundle = file('Application Support', 'snug-mcp.mjs');
    expect(scriptTokenOf(`node tool.mjs ${bundle}`)).toBe('tool.mjs');
    expect(isSnugCommandLine(`node tool.mjs ${bundle}`)).toBe(false);
    // Not even ASKED: a relative path would be looked up under THIS process's directory, and
    // a file that happens to be there says nothing about the other process's script.
    const isFile = vi.fn(() => true);
    expect(scriptTokenOf('node my tool.mjs snug-mcp.mjs', isFile)).toBe('my');
    expect(isFile).not.toHaveBeenCalled();
  });

  it('asks about each run in turn, shortest first, and stops at the first that is a file', () => {
    const asked: string[] = [];
    const isFile = (candidate: string): boolean => asked.push(candidate) > 0 && candidate === '/a b/c d/snug-mcp.mjs';
    expect(scriptTokenOf('node /a b/c d/snug-mcp.mjs open --print', isFile)).toBe('/a b/c d/snug-mcp.mjs');
    expect(asked).toEqual(['/a', '/a b/c', '/a b/c d/snug-mcp.mjs']);
  });

  it('another PROGRAM holding that path is still not ours — the binary is checked first', () => {
    const script = file('Application Support', 'snug-mcp.mjs');
    expect(isSnugCommandLine(`vim ${script}`)).toBe(false);
    expect(isSnugCommandLine(`/usr/bin/tail -f ${script}`)).toBe(false);
  });

  it('an EXACT argv (Linux) asks the file system nothing: its script is the argument it was given', () => {
    // Nothing exists at this path. The NUL-separated form needs no help and gets none.
    expect(isSnugCommandLine('/usr/bin/node\0/home/a b/plugin/scripts/snug-mcp.mjs\0open\0')).toBe(true);
    const isFile = vi.fn(() => false);
    expect(scriptTokenOf('/usr/bin/node\0/home/a b/plugin/scripts/snug-mcp.mjs\0open\0', isFile)).toBe('/home/a b/plugin/scripts/snug-mcp.mjs');
    expect(isFile).not.toHaveBeenCalled();
  });
});

describe('readCommandLine', () => {
  it('reads THIS process’s own command line', () => {
    const line = readCommandLine(process.pid);
    expect(line).toBeDefined();
    // Whatever runs the suite, it is a Node process and its line names Node.
    expect(line).toMatch(/node/);
  });

  it('answers undefined for a pid that is not a process', () => {
    // 2^22 is past macOS’s pid ceiling (99998) and Linux’s default (4194304 is the max+1).
    expect(readCommandLine(4_194_305)).toBeUndefined();
  });

  it('answers undefined for a number that is not a pid at all, without running anything', () => {
    expect(readCommandLine(-1)).toBeUndefined();
    expect(readCommandLine(0)).toBeUndefined();
    expect(readCommandLine(1.5)).toBeUndefined();
  });
});

describe('isAlive / askToStop', () => {
  it('this process is alive; a pid past the ceiling is not', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(4_194_305)).toBe(false);
  });

  it('a process we may not signal is still ALIVE — pid 1 belongs to the system', () => {
    // `kill(1, 0)` is EPERM for an ordinary user. Reading that as "dead" would let a lock
    // naming such a pid be taken over without a single question asked.
    expect(isAlive(1)).toBe(true);
  });

  it('asking a pid that is not there to stop is not an error', () => {
    expect(() => askToStop(4_194_305)).not.toThrow();
  });
});
