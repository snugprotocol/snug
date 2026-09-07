// The process entry (ADR-0068). Spawned by the host over stdio; also runnable by a person
// as `node snug-mcp.mjs status|open` against a primary that is already running.
//
// Steps 2+ of the task wire the loopback listener, the control socket and the lock into
// this file. Today it serves the MCP surface with tools that report honestly that the
// runner is not up yet, so `initialize` → `tools/list` → `snug_status` is exercisable end
// to end against the real bundle (the interop test does exactly that).

import { createMcpServer } from './mcp/server.js';
import type { ToolName } from './tools.js';

const NOT_YET = 'the local runner is not wired up in this build yet';

async function callTool(name: ToolName): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  if (name === 'snug_status') {
    return { content: [{ type: 'text', text: JSON.stringify({ running: false, detail: NOT_YET }) }] };
  }
  return { content: [{ type: 'text', text: NOT_YET }], isError: true };
}

function main(): void {
  const server = createMcpServer({ callTool });
  server.attach(process.stdin, (line) => process.stdout.write(`${line}\n`));
  // The host closes stdin to say "we are done"; with nothing else holding the loop open
  // the process exits on its own. Steps 2+ add the attached-session count that decides
  // whether this is really the end (D-B9).
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

main();
