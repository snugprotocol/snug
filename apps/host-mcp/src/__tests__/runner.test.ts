// AC1/AC7/AC8 — the composition root, on real listeners and a real socket.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRunner, type Runner } from '../runner.js';

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
    expect(result.content[0]!.text).toMatch(/snug-mcp\.mjs open/);
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
    const first = make({ graceMs: 20 });
    await first.start();
    const second = make();
    await second.start(); // holds a control-socket client
    const onExit = vi.fn();
    first.beginGrace(onExit);
    await new Promise((r) => setTimeout(r, 120));
    expect(onExit).not.toHaveBeenCalled();
  });

  it('exits once nobody is attached', async () => {
    const runner = make({ graceMs: 20 });
    await runner.start();
    const onExit = vi.fn();
    runner.beginGrace(onExit);
    await vi.waitFor(() => expect(onExit).toHaveBeenCalled(), { timeout: 2_000 });
  });
});
