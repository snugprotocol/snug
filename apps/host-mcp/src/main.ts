// The process entry (ADR-0068).
//
// Two shapes, one binary. Spawned by a host with no arguments it speaks MCP over stdio;
// run by a person as `snug-mcp open|status` it talks to the primary over the control
// socket and prints the answer to THEIR terminal — which is how the launch URL (fragment
// and all) reaches a user without ever riding an MCP message (D-B8).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMcpServer } from './mcp/server.js';
import { createRunner } from './runner.js';
import { probeControlSocket } from './control-socket.js';
import { watchParent } from './parent-watch.js';
import { detectHolder } from './holder.js';
import type { ToolName } from './tools.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The kit page ships beside the bundle; read lazily so a rebuild needs no restart. */
function readPage(): string {
  // Two homes, in order of how the process is actually run:
  //   1. beside the bundle — how the PLUGIN ships it (build-plugin.mjs puts them together);
  //   2. the sibling app's build output — how a developer runs `dist/snug-mcp.mjs` straight
  //      out of the repo, where nothing has copied the page anywhere.
  // The second path is relative to `apps/host-mcp/dist/`, so it climbs TWO levels, not one.
  // Getting that wrong is silent: the process serves its placeholder and looks like it
  // booted fine, which is exactly how it was found.
  for (const candidate of ['snug-host-local.html', '../../host/dist-local/snug-host-local.html']) {
    try {
      return readFileSync(path.join(here, candidate), 'utf8');
    } catch {
      /* try the next */
    }
  }
  return '<!doctype html><title>Snug</title><p>The Snug runner page is missing from this install.';
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  // macOS only for now, as the desktop is (ADR-0021 D8).
  const child = spawn('open', [url], { stdio: 'ignore', detached: true });
  child.unref();
}

async function runCli(command: string): Promise<number> {
  const home = process.env.SNUG_HOME ?? path.join(process.env.HOME ?? '.', 'Snug');
  const socket = path.join(home, 'host', 'ctl.sock');
  const answer = await probeControlSocket(socket);
  if (answer === undefined) {
    process.stderr.write('Snug is not running. Start it from your agent, then try again.\n');
    return 1;
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(answer)}\n`);
    return 0;
  }
  const { createConnection } = await import('node:net');
  const url = await new Promise<string | undefined>((resolve) => {
    const client = createConnection(socket);
    client.on('error', () => resolve(undefined));
    client.on('connect', () => client.write(`${JSON.stringify({ op: 'open' })}\n`));
    client.on('data', (chunk: Buffer) => {
      try {
        resolve((JSON.parse(chunk.toString('utf8').split('\n')[0]!) as { url?: string }).url);
      } catch {
        resolve(undefined);
      }
      client.destroy();
    });
  });
  if (url === undefined) {
    process.stderr.write('Could not reach the running Snug.\n');
    return 1;
  }
  // The user's own terminal: the one place the launch URL may carry its fragment.
  process.stdout.write(`${url}\n`);
  return 0;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'open' || command === 'status') {
    process.exit(await runCli(command));
  }

  const home = process.env.SNUG_HOME ?? path.join(process.env.HOME ?? '.', 'Snug');
  const runner = createRunner({ home, page: readPage, openBrowser, heldBy: detectHolder });
  await runner.start();

  const server = createMcpServer({
    callTool: (name: ToolName, args) => runner.callTool(name, args),
  });
  server.attach(process.stdin, (line) => process.stdout.write(`${line}\n`));

  const shutdown = (): void => {
    void runner.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  // stdin closing means THIS session is done, not that the runner is: another window may
  // still be attached, so the grace decides (D-B9).
  process.stdin.on('end', () => runner.beginGrace(shutdown));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Every spawn owes a parent watch on a CHANGED ppid (lessons 2026-08-18/19).
  watchParent({ onOrphaned: () => runner.beginGrace(shutdown) });
  process.stdin.resume();
}

void main();
