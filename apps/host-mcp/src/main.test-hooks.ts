// The TEST entry (D-B11) — never shipped.
//
// The e2e drives the real process against a self-signed stub on 127.0.0.1 answering for
// `stub.snug.test`. Two things make that possible, and both are hooks that must not exist
// in the release bundle: a DNS resolver, and a holder override so the read-only path can be
// exercised without running Snug Desktop.
//
// A resolved-address check in the proxy would refuse this stub outright — which is one
// reason (besides its being a new policy the desktop lacks) the proxy has none. The release
// bundle is swept for both names below by `check-host-mcp`.

import type { LookupFn } from './node-transport.js';

/** `host=ip,host=ip` — the browser's `--host-resolver-rules`, for the process side. */
export function resolverFromEnv(spec: string | undefined): LookupFn | undefined {
  if (spec === undefined || spec.trim() === '') return undefined;
  const table = new Map<string, string>();
  for (const entry of spec.split(',')) {
    const [host, ip] = entry.split('=');
    if (host !== undefined && ip !== undefined) table.set(host.trim(), ip.trim());
  }
  return ((hostname: string, _options: unknown, callback: (err: Error | null, address: string, family: number) => void) => {
    const mapped = table.get(hostname);
    if (mapped !== undefined) {
      callback(null, mapped, 4);
      return;
    }
    callback(new Error(`no test mapping for ${hostname}`), '', 4);
  }) as unknown as LookupFn;
}

export const TEST_RESOLVE_ENV = 'SNUG_MCP_TEST_RESOLVE';
export const TEST_HOLDER_ENV = 'SNUG_MCP_TEST_HOLDER';

/* c8 ignore start — the entry half, exercised by the e2e rather than by unit tests */
if (process.env.SNUG_MCP_TEST_ENTRY === '1') {
  const { createRunner } = await import('./runner.js');
  const { createMcpServer } = await import('./mcp/server.js');
  const { readFileSync } = await import('node:fs');
  const nodePath = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { createFetchProxy } = await import('./fetch-proxy.js');
  const { createNodeHttpsSend } = await import('./node-transport.js');

  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const page = (): string => readFileSync(nodePath.join(here, 'snug-host-local.html'), 'utf8');
  const holder = process.env[TEST_HOLDER_ENV];
  const runner = createRunner({
    home: process.env.SNUG_HOME ?? nodePath.join(process.env.HOME ?? '.', 'Snug'),
    page,
    openBrowser: async () => {},
    ...(holder !== undefined && holder !== '' ? { heldBy: () => holder } : {}),
    proxy: createFetchProxy({ send: createNodeHttpsSend(resolverFromEnv(process.env[TEST_RESOLVE_ENV])) }),
  });
  const started = await runner.start();
  process.stderr.write(`${JSON.stringify({ ready: true, port: started.port, url: runner.launchUrl() })}\n`);
  const server = createMcpServer({ callTool: (name, args) => runner.callTool(name, args) });
  server.attach(process.stdin, (line) => process.stdout.write(`${line}\n`));
  process.stdin.resume();
}
/* c8 ignore stop */
