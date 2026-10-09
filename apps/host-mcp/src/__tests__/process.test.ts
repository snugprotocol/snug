// K5/L4/L5 — the two pieces of the one composition that can be judged without a process:
// how a shutdown is bounded, and what the human CLI is called on this install. Everything
// else `startProcess` does is proven on the built bundles (`lifecycle-interop.test.ts`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliCommand, EXIT_DEADLINE_MS, shutdownWithin } from '../process.js';

describe('a shutdown has a HARD deadline (L4)', () => {
  it('exits 0 once the stop has finished', async () => {
    const exit = vi.fn();
    shutdownWithin(async () => {}, exit, 1_000);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 1 when the stop fails — a runner that could not shut down cleanly must still go', async () => {
    const exit = vi.fn();
    shutdownWithin(async () => {
      throw new Error('the listener would not close');
    }, exit, 1_000);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it('exits 1 AT THE DEADLINE when the stop never settles', async () => {
    // The mutant: no deadline. A stop waiting on a wedged listener would leave a process
    // that has given its lock away and still holds its port — for ever.
    const exit = vi.fn();
    const began = Date.now();
    shutdownWithin(() => new Promise<void>(() => {}), exit, 80);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1), { timeout: 2_000 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(70);
  });

  it('the shipped deadline is seconds, not minutes', () => {
    expect(EXIT_DEADLINE_MS).toBeGreaterThanOrEqual(3_000);
    expect(EXIT_DEADLINE_MS).toBeLessThanOrEqual(10_000);
  });
});

describe('how the human CLI is run on this install (L5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'snug-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is the LAUNCHER beside the bundle, by its real path — what the plugin ships, and what finds Node under a desktop host', () => {
    writeFileSync(path.join(dir, 'snug'), '#!/bin/sh\n');
    expect(cliCommand(path.join(dir, 'snug-mcp.mjs'))).toBe(`sh ${path.join(dir, 'snug')}`);
  });

  it('is one shell word even when the install path has a space or a quote in it', () => {
    const spaced = path.join(dir, "Application Support", "it's here");
    mkdirSync(spaced, { recursive: true });
    writeFileSync(path.join(spaced, 'snug'), '#!/bin/sh\n');
    expect(cliCommand(path.join(spaced, 'snug-mcp.mjs'))).toBe(`sh '${path.join(dir, 'Application Support')}/it'\\''s here/snug'`);
  });

  it('with no launcher (straight out of the repo) is this Node running this file', () => {
    expect(cliCommand(path.join(dir, 'snug-mcp.mjs'))).toBe(`${process.execPath} ${path.join(dir, 'snug-mcp.mjs')}`);
  });

  it('a DIRECTORY called snug is not a launcher', () => {
    mkdirSync(path.join(dir, 'snug'));
    expect(cliCommand(path.join(dir, 'snug-mcp.mjs'))).toBe(`${process.execPath} ${path.join(dir, 'snug-mcp.mjs')}`);
  });
});
