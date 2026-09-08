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
  return ((hostname: string, options: { all?: boolean } | undefined, callback: (err: Error | null, address: unknown, family?: number) => void) => {
    const mapped = table.get(hostname);
    if (mapped === undefined) {
      callback(new Error(`no test mapping for ${hostname}`), '', 4);
      return;
    }
    // NODE'S ACTUAL CONTRACT. `node:https` calls a custom lookup with `{ all: true }` and
    // expects an ARRAY of `{address, family}`. Answering with a bare string made every
    // request through the test build fail as `Invalid IP address: undefined` — which is
    // why the AC3/AC4 legs could not reach the stub. Both forms are answered because the
    // single-address form is still the documented one when `all` is not set.
    if (options?.all === true) {
      callback(null, [{ address: mapped, family: 4 }]);
      return;
    }
    callback(null, mapped, 4);
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
  const { resolveHome } = await import('./home.js');

  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const page = (): string => readFileSync(nodePath.join(here, 'snug-host-local.html'), 'utf8');
  const holder = process.env[TEST_HOLDER_ENV];
  const runner = createRunner({
    // The TEST build never gets the real home, not even on an opt-in (D-B34): this is the
    // binary the e2e spawns, and it is the one that once wrote over the owner's user file.
    home: resolveHome(),
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
