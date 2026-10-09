// L5 — the browser opener can never crash the runner.
//
// WHAT WAS WRONG. `spawn('open', [url])` with no `error` listener: under a desktop host the
// process has no PATH (measured 2026-09-13), so the bare name is ENOENT — and an `error`
// event nobody listens for is an uncaught exception. `snug_open` would have taken the whole
// runner down, lock held, in exactly the environment walk #2 is about. The opener is now a
// per-platform ABSOLUTE path where one exists, every failure is a rejection the caller
// turns into the printed fallback, and nothing here ever throws asynchronously.
//
// Gate 5 (security/F2) added two more: the Linux opener is an ABSOLUTE path too — a bare
// `xdg-open` walks PATH, and an empty PATH entry is the working directory, which for a plugin
// process is the agent's current project — and the opener child gets an ALLOWLISTED
// environment, never the parent's: on Linux the opener may BECOME the browser, and every
// process that browser starts would otherwise carry the session's messaging token and any
// API key the agent was started with.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { OPENER_ENV_ALLOWLIST, OPENER_ENV_PREFIXES, openerEnvFor, openInBrowser, spawnOpener, type OpenerChild } from '../opener.js';
import { BENIGN_PARENT, HOSTILE_ONLY, HOSTILE_PARENT } from './fixtures/hostile-env.js';

const URL = 'http://127.0.0.1:43127/#token=abc';

function fakeChild(): OpenerChild & EventEmitter {
  return Object.assign(new EventEmitter(), { unref: vi.fn() });
}

describe('which program opens the browser', () => {
  it('macOS: /usr/bin/open by ABSOLUTE path — a host-spawned process has no PATH to find it on', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const opened = openInBrowser(URL, { platform: 'darwin', spawn });
    child.emit('exit', 0);
    await opened;
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', [URL], expect.any(Object));
  });

  it('Linux: /usr/bin/xdg-open by ABSOLUTE path — a bare name walks PATH, and an empty entry is the agent’s project folder', async () => {
    // MIGRATED (Gate 5, security/F2). This pinned the bare `xdg-open`, "found on PATH". The
    // review proved what that finds: with PATH ending in `:` and an executable `xdg-open` in
    // the working directory, the bearer URL ran THAT. Where `/usr/bin/xdg-open` is absent the
    // spawn fails ENOENT, and the caller prints the fallback instead (`snug open --print`).
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const opened = openInBrowser(URL, { platform: 'linux', spawn });
    child.emit('spawn');
    await opened;
    expect(spawn).toHaveBeenCalledWith('/usr/bin/xdg-open', [URL], expect.any(Object));
  });

  it('every platform’s opener is an absolute path — no platform looks its opener up', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const child = fakeChild();
      const spawn = vi.fn(() => child);
      const opened = openInBrowser(URL, { platform, spawn, settleMs: 1 });
      child.emit('spawn');
      child.emit('exit', 0);
      await opened;
      const [command] = spawn.mock.calls[0] as unknown as [string];
      expect(path.isAbsolute(command), `${platform}: ${command}`).toBe(true);
    }
  });

  it('passes the address as ONE argv entry — never through a shell', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const hostile = 'http://127.0.0.1:1/#token=a;rm -rf ~';
    const opened = openInBrowser(hostile, { platform: 'darwin', spawn });
    child.emit('exit', 0);
    await opened;
    expect((spawn.mock.calls[0] as unknown[]).slice(0, 2)).toEqual(['/usr/bin/open', [hostile]]);
  });

  it('any other platform is a rejection, not a guess', async () => {
    const spawn = vi.fn(() => fakeChild());
    await expect(openInBrowser(URL, { platform: 'win32', spawn })).rejects.toThrow(/no browser opener/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('failure is a rejection, never a crash', () => {
  it('a missing program (the `error` event) rejects', async () => {
    const child = fakeChild();
    const opened = openInBrowser(URL, { platform: 'linux', spawn: () => child });
    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }));
    await expect(opened).rejects.toThrow(/ENOENT/);
  });

  it('a spawn that THROWS rejects', async () => {
    await expect(
      openInBrowser(URL, {
        platform: 'darwin',
        spawn: () => {
          throw new Error('EAGAIN');
        },
      }),
    ).rejects.toThrow(/EAGAIN/);
  });

  it('macOS: a non-zero exit rejects — `open` says so when there is no window server to open into', async () => {
    const child = fakeChild();
    const opened = openInBrowser(URL, { platform: 'darwin', spawn: () => child });
    child.emit('exit', 1);
    await expect(opened).rejects.toThrow(/exit/i);
  });

  it('an `error` AFTER it settled is swallowed — a late event must not become an uncaught exception', async () => {
    const child = fakeChild();
    const opened = openInBrowser(URL, { platform: 'linux', spawn: () => child });
    child.emit('spawn');
    await opened;
    // An EventEmitter with no `error` listener throws on emit: this line is the test.
    expect(() => child.emit('error', new Error('late'))).not.toThrow();
  });

  it('macOS: an opener that neither exits nor fails is taken as started after the bound, not awaited for ever', async () => {
    const child = fakeChild();
    await expect(openInBrowser(URL, { platform: 'darwin', spawn: () => child, settleMs: 10 })).resolves.toBeUndefined();
  });
});

describe('the child is let go', () => {
  it('is unref’d so a browser left open never holds the runner’s exit', async () => {
    const child = fakeChild();
    const opened = openInBrowser(URL, { platform: 'linux', spawn: () => child });
    child.emit('spawn');
    await opened;
    expect(child.unref).toHaveBeenCalled();
  });
});

describe('the opener child’s environment is an ALLOWLIST, never the parent’s (Gate 5, security/F2)', () => {
  /** What a Linux desktop session hands its processes, and the opener needs to reach the display and the session bus. */
  const DESKTOP: Record<string, string> = {
    DISPLAY: ':0',
    WAYLAND_DISPLAY: 'wayland-0',
    XAUTHORITY: '/run/user/1000/gdm/Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: '/run/user/1000',
    XDG_CURRENT_DESKTOP: 'GNOME',
    XDG_DATA_DIRS: '/usr/share',
    DESKTOP_SESSION: 'ubuntu',
    BROWSER: 'firefox',
    LC_CTYPE: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
  };

  /** The env the opener handed its child, for one platform and one parent. */
  const envSpawnedWith = async (platform: 'darwin' | 'linux', parentEnv?: Record<string, string | undefined>): Promise<Record<string, string>> => {
    const child = fakeChild();
    const spawn = vi.fn((_command: string, _args: string[], _env: Record<string, string>) => child);
    const opened = openInBrowser(URL, { platform, spawn, settleMs: 1, ...(parentEnv !== undefined ? { parentEnv } : {}) });
    child.emit('spawn');
    child.emit('exit', 0);
    await opened;
    return spawn.mock.calls[0]![2];
  };

  it.each(['linux', 'darwin'] as const)('%s: the hostile parent’s secrets reach the opener NOT AT ALL — the desktop’s own variables do', async (platform) => {
    const env = await envSpawnedWith(platform, { ...HOSTILE_PARENT, ...DESKTOP });
    for (const name of Object.keys(HOSTILE_ONLY)) expect(env, `${name} must not reach the opener`).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toMatch(/canary/);
    // …and what an opener needs to find the user's display, session bus and browser is kept.
    expect(env).toEqual({ ...BENIGN_PARENT, ...DESKTOP });
  });

  it('given NO parent environment it passes an empty one — never falls back to this process’s own', async () => {
    const before = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'canary-from-process-env';
    try {
      expect(await envSpawnedWith('linux')).toEqual({});
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      else process.env.CLAUDE_CODE_MESSAGING_TOKEN = before;
    }
  });

  it('PATH keeps only ABSOLUTE entries — `xdg-open` is a shell script, and its own lookups must not reach the working directory either', () => {
    expect(openerEnvFor({ PATH: '/usr/local/bin::.:bin:/usr/bin:' }).PATH).toBe('/usr/local/bin:/usr/bin');
    expect(openerEnvFor({ PATH: ':.:' })).not.toHaveProperty('PATH');
  });

  it('the allowlist itself can never admit a credential-shaped name', () => {
    // The guard on the guard. XAUTHORITY is a PATH to the X cookie file — the display a
    // browser must open on — not a credential in a variable; it is the one AUTH-shaped name.
    for (const name of OPENER_ENV_ALLOWLIST) expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CLAUDE|ANTHROPIC|OPENAI|CODEX|SNUG|NODE/i);
    for (const name of Object.keys(HOSTILE_ONLY)) {
      expect(OPENER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)), `${name} must match no kept prefix`).toBe(false);
    }
  });

  it('the REAL spawn hands the child exactly that environment — not Node’s default, which is the whole parent', async () => {
    // A fake spawn cannot see this line of the opener: `spawn(cmd, args, options)` with no
    // `env` inherits `process.env` whole. So a real child reports what it was given.
    const home = mkdtempSync(path.join(tmpdir(), 'snug-opener-'));
    const out = path.join(home, 'env.json');
    const before = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'canary-from-process-env';
    try {
      const env = openerEnvFor({ HOME: home, PATH: path.dirname(process.execPath), ...HOSTILE_ONLY });
      const child = spawnOpener(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`], env);
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', () => resolve());
      });
      const seen = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
      expect(seen.HOME).toBe(home);
      expect(seen).not.toHaveProperty('CLAUDE_CODE_MESSAGING_TOKEN');
      for (const name of Object.keys(HOSTILE_ONLY)) expect(seen, name).not.toHaveProperty(name);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      else process.env.CLAUDE_CODE_MESSAGING_TOKEN = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
