// The interop test — and the justification for D-B2′.
//
// The framing in `mcp/jsonrpc.ts` is hand-rolled, so it must be proven against the
// REFERENCE implementation rather than against our own reading of the spec. That is what
// the `@modelcontextprotocol/sdk` devDependency buys: this file drives the SHIPPED bundle
// with the official client over a real spawned process, so a divergence in framing,
// initialize handshake or tool schema shows up here rather than in a user's session.
//
// It runs against `dist/snug-mcp.mjs` — the release artifact, not the source — because the
// build is part of what is being tested (a bundling change that broke the entry would pass
// a source-level test).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(here, '../../dist/snug-mcp.mjs');

/** A missing build is CANNOT RUN by name, never a silent skip (the kit's own discipline). */
const built = existsSync(BUNDLE);
const describeBuilt = built ? describe : describe.skip;
if (!built) {
  // eslint-disable-next-line no-console
  console.warn(`[mcp-interop] ${BUNDLE} is missing — run \`pnpm --filter host-mcp build\` first`);
}

async function connected(): Promise<Client> {
  const client = new Client({ name: 'interop-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BUNDLE] }));
  return client;
}

describeBuilt('the official MCP client against the shipped bundle', () => {
  it('completes the initialize handshake and reads our instructions', async () => {
    const client = await connected();
    try {
      expect(client.getServerVersion()).toMatchObject({ name: 'snug' });
      // The launch protocol reaches a real client — the D-B12 text, through the build.
      expect(client.getInstructions()).toMatch(/snug_status/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('lists exactly the four control-plane tools, with usable schemas', async () => {
    const client = await connected();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(['snug_hand_in', 'snug_list_apps', 'snug_open', 'snug_status']);
      // The SDK validates schemas on the way through; a malformed one fails here.
      for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.close();
    }
  }, 30_000);

  it('calls a tool and reads its result', async () => {
    const client = await connected();
    try {
      const result = await client.callTool({ name: 'snug_status', arguments: {} });
      expect(JSON.stringify(result.content)).toMatch(/running/);
    } finally {
      await client.close();
    }
  }, 30_000);

  it('rejects a tool outside the allowlist', async () => {
    const client = await connected();
    try {
      // The allowlist holds against the real client, not only against our own dispatcher.
      await expect(client.callTool({ name: 'snug_fetch', arguments: { url: 'https://example.com' } })).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 30_000);
});

describeBuilt('lifecycle', () => {
  it('exits when its stdin closes — the host closing the pipe is how a session ends', async () => {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 10_000))]);
    expect(code).not.toBe('timeout');
    expect(code).toBe(0);
  }, 20_000);

  it('writes nothing to stdout before it is spoken to — stdout is the transport', async () => {
    // A banner or a log line on stdout corrupts the JSON-RPC stream; diagnostics belong on
    // stderr. This is the cheapest test that catches a stray console.log in the entry.
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    await new Promise((r) => setTimeout(r, 700));
    child.stdin.end();
    expect(out).toBe('');
  }, 20_000);
});
