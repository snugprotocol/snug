// AC4 — the brain finds its own binary (ADR-0069 §6).
//
// WHY. A process a desktop host spawns gets no user PATH — measured 2026-09-13:
// `launchctl getenv PATH` is EMPTY on the owner's Mac, and both `node` and `claude` live
// under nvm. `spawn('claude')` from such a process is ENOENT, which the probe would report
// as "absent" to a user who has the CLI installed and logged in. So the binary is looked
// for on PATH first and then in the places the installers actually put it, from ONE list.

import { describe, expect, it } from 'vitest';

import { candidateDirs, defaultResolveDeps, INSTALL_ROOTS, resolveBinary, type ResolveDeps } from '../brain-resolve.js';

/** A fake filesystem: the set of files that exist, and the directory listings. */
function fakeFs(files: string[], dirs: Record<string, string[]> = {}): Pick<ResolveDeps, 'exists' | 'readdir'> {
  const set = new Set(files);
  return {
    exists: (file) => set.has(file),
    readdir: (dir) => dirs[dir] ?? [],
  };
}

const HOME = '/Users/x';

describe('resolveBinary', () => {
  it('takes PATH first, in PATH order', () => {
    const deps = { env: { HOME, PATH: '/usr/bin:/opt/tools/bin' }, ...fakeFs(['/opt/tools/bin/claude', '/Users/x/.local/bin/claude']) };
    expect(resolveBinary('claude', deps)).toBe('/opt/tools/bin/claude');
  });

  it('finds the native installer’s ~/.local/bin/claude with NO PATH at all — the GUI-spawned case', () => {
    const deps = { env: { HOME }, ...fakeFs(['/Users/x/.local/bin/claude']) };
    expect(resolveBinary('claude', deps)).toBe('/Users/x/.local/bin/claude');
  });

  it('walks a versioned root (nvm) and picks the HIGHEST version, not the first listed', () => {
    const nvm = '/Users/x/.nvm/versions/node';
    const deps = {
      env: { HOME, PATH: '' },
      ...fakeFs([`${nvm}/v18.20.0/bin/claude`, `${nvm}/v22.13.1/bin/claude`, `${nvm}/v9.0.0/bin/claude`], { [nvm]: ['v18.20.0', 'v9.0.0', 'v22.13.1'] }),
    };
    expect(resolveBinary('claude', deps)).toBe(`${nvm}/v22.13.1/bin/claude`);
  });

  it('reads fnm’s layout (installation/bin under each version)', () => {
    const fnm = '/Users/x/.local/share/fnm/node-versions';
    const deps = { env: { HOME }, ...fakeFs([`${fnm}/v22.0.0/installation/bin/node`], { [fnm]: ['v22.0.0'] }) };
    expect(resolveBinary('node', deps)).toBe(`${fnm}/v22.0.0/installation/bin/node`);
  });

  it('answers undefined when the binary is nowhere — the caller names that state', () => {
    expect(resolveBinary('claude', { env: { HOME, PATH: '/usr/bin' }, ...fakeFs([]) })).toBeUndefined();
  });

  it('expands ~ against HOME, spaces and all', () => {
    const home = '/Users/John Smith';
    const deps = { env: { HOME: home }, ...fakeFs([`${home}/.local/bin/claude`]) };
    expect(resolveBinary('claude', deps)).toBe(`${home}/.local/bin/claude`);
  });

  it('skips the home-relative roots when there is no HOME, rather than resolving them against nothing', () => {
    const dirs = candidateDirs({ env: { PATH: '/usr/bin' }, ...fakeFs([]) });
    expect(dirs).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin']);
  });

  it('never resolves an empty PATH entry to the working directory', () => {
    // `PATH=":/usr/bin"` has an empty first entry, which the shell reads as ".": a binary
    // resolver must not — a `claude` in the cwd is not the user's CLI.
    const dirs = candidateDirs({ env: { HOME, PATH: ':/usr/bin:' }, ...fakeFs([]) });
    expect(dirs[0]).toBe('/usr/bin');
    expect(dirs).not.toContain('');
    expect(dirs).not.toContain('.');
  });
});

describe('the one install-roots list', () => {
  it('has both shapes populated and every entry absolute or home-relative', () => {
    expect(INSTALL_ROOTS.binDirs.length).toBeGreaterThan(0);
    expect(INSTALL_ROOTS.versionedRoots.length).toBeGreaterThan(0);
    for (const dir of [...INSTALL_ROOTS.binDirs, ...INSTALL_ROOTS.versionedRoots.map((r) => r.root)]) {
      expect(dir, `${dir} must be absolute or ~/`).toMatch(/^(~\/|\/)/);
    }
  });

  it('names the native installer’s directory, the one a non-developer ends up with', () => {
    expect(INSTALL_ROOTS.binDirs).toContain('~/.local/bin');
  });
});

describe('defaultResolveDeps reads the environment by NAME', () => {
  it('takes HOME and PATH and nothing else — the release gate counts whole-env reads', () => {
    const deps = defaultResolveDeps({ HOME: '/h', PATH: '/p', CLAUDE_CODE_MESSAGING_TOKEN: 'leak', ANTHROPIC_API_KEY: 'leak' });
    expect(deps.env).toEqual({ HOME: '/h', PATH: '/p' });
    expect(JSON.stringify(deps.env)).not.toContain('leak');
  });

  it('leaves an unset variable absent rather than the string "undefined"', () => {
    expect(defaultResolveDeps({}).env).toEqual({});
  });
});

describe('relative PATH entries (review, 2026-09-13)', () => {
  it('never resolves `bin`, `./bin` or `../x` against the working directory', () => {
    const dirs = candidateDirs({ env: { HOME, PATH: 'bin:./bin:../x:/usr/bin' }, ...fakeFs([]) });
    expect(dirs[0]).toBe('/usr/bin');
    expect(dirs.some((d) => !d.startsWith('/'))).toBe(false);
  });
});
