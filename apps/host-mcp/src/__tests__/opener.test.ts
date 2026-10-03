// L5 — the browser opener can never crash the runner.
//
// WHAT WAS WRONG. `spawn('open', [url])` with no `error` listener: under a desktop host the
// process has no PATH (measured 2026-09-13), so the bare name is ENOENT — and an `error`
// event nobody listens for is an uncaught exception. `snug_open` would have taken the whole
// runner down, lock held, in exactly the environment walk #2 is about. The opener is now a
// per-platform ABSOLUTE path where one exists, every failure is a rejection the caller
// turns into the printed fallback, and nothing here ever throws asynchronously.

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { openInBrowser, type OpenerChild } from '../opener.js';

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
    expect(spawn).toHaveBeenCalledWith('/usr/bin/open', [URL]);
  });

  it('Linux: xdg-open, found on PATH (distributions do not agree on where it lives)', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const opened = openInBrowser(URL, { platform: 'linux', spawn });
    child.emit('spawn');
    await opened;
    expect(spawn).toHaveBeenCalledWith('xdg-open', [URL]);
  });

  it('passes the address as ONE argv entry — never through a shell', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const hostile = 'http://127.0.0.1:1/#token=a;rm -rf ~';
    const opened = openInBrowser(hostile, { platform: 'darwin', spawn });
    child.emit('exit', 0);
    await opened;
    expect(spawn.mock.calls[0]).toEqual(['/usr/bin/open', [hostile]]);
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
