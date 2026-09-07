// Global setup for the Binding-B suite: a stub provider, then the REAL local host process
// serving the REAL built page (ADR-0068 step 6).
//
// Nothing here is faked at the seam under test. The browser talks to the process, the
// process talks to the stub, and the only accommodations are the two a self-signed
// certificate forces: `--ignore-certificate-errors` for the browser, and
// `NODE_EXTRA_CA_CERTS` for the process — the latter needing the stub to export its CA,
// which is why `SNUG_E2E_CERT_OUT` exists.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../../..');

export const STUB_PORT = 43520;
export const STUB_HOST = 'stub.snug.test';
export const PROCESS_BUNDLE = path.join(REPO, 'apps/host-mcp/dist/snug-mcp.test.mjs');
export const LOCAL_PAGE = path.join(REPO, 'apps/host/dist-local/snug-host-local.html');

export interface LocalHarness {
  url: string;
  port: number;
  home: string;
  stop(): Promise<void>;
}

const waitForLine = (child: ChildProcess, match: RegExp, timeoutMs = 20_000): Promise<string> =>
  new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${match}; saw: ${buffer.slice(0, 500)}`)), timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const found = match.exec(buffer);
      if (found !== null) {
        clearTimeout(timer);
        resolve(found[0]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the process exited (${code}) before it was ready: ${buffer.slice(0, 500)}`));
    });
  });

/**
 * Start the real process against an isolated home, with the page copied where it expects
 * it. A missing build is CANNOT RUN by name — never a skip that reads as a pass.
 */
export async function startLocalHost(options: { certPath?: string; holder?: string } = {}): Promise<LocalHarness> {
  if (!existsSync(PROCESS_BUNDLE)) throw new Error(`${PROCESS_BUNDLE} missing — run \`pnpm --filter host-mcp build\``);
  if (!existsSync(LOCAL_PAGE)) throw new Error(`${LOCAL_PAGE} missing — run \`pnpm --filter host build\``);

  const home = mkdtempSync(path.join(tmpdir(), 'snug-e2e-'));
  const { cpSync } = await import('node:fs');
  // The process reads the page from beside its own bundle; the plugin ships them together.
  cpSync(LOCAL_PAGE, path.join(path.dirname(PROCESS_BUNDLE), 'snug-host-local.html'));

  const child = spawn(process.execPath, [PROCESS_BUNDLE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SNUG_MCP_TEST_ENTRY: '1',
      SNUG_HOME: home,
      SNUG_MCP_TEST_RESOLVE: `${STUB_HOST}=127.0.0.1`,
      ...(options.holder !== undefined ? { SNUG_MCP_TEST_HOLDER: options.holder } : {}),
      ...(options.certPath !== undefined ? { NODE_EXTRA_CA_CERTS: options.certPath } : {}),
    },
  });

  const line = await waitForLine(child, /\{"ready":true[^\n]*\}/);
  const ready = JSON.parse(line) as { port: number; url: string };

  return {
    url: ready.url,
    port: ready.port,
    home,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
      rmSync(home, { recursive: true, force: true });
    },
  };
}
