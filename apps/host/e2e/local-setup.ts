// Global setup for the Binding-B suite: a stub provider, then the REAL local host process
// serving the REAL built page (ADR-0068 step 6).
//
// Nothing here is faked at the seam under test. The browser talks to the process, the
// process talks to the stub, and the only accommodations are the two a self-signed
// certificate forces: `--ignore-certificate-errors` for the browser, and
// `NODE_EXTRA_CA_CERTS` for the process — the latter needing the stub to export its CA,
// which is why `SNUG_E2E_CERT_OUT` exists.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../../..');

export const STUB_PORT = 43520;
export const STUB_HOST = 'stub.snug.test';
export const PROCESS_BUNDLE = path.join(REPO, 'apps/host-mcp/dist/snug-mcp.test.mjs');
export const LOCAL_PAGE = path.join(REPO, 'apps/host/dist-local/snug-host-local.html');

/** The API key the stub demands — its own constant, mirrored here for the assertions. */
export const STUB_API_KEY = 'e2e-secret-key-9999';
export const NET_STUB = path.join(REPO, 'apps/playground/e2e/fixtures/net-stub.mjs');

export interface StubHarness {
  /** The CA file the PROCESS must trust to reach this stub (D-B29). */
  certPath: string;
  stop(): Promise<void>;
}

/**
 * The HTTPS provider stub, plus the CA export the process needs.
 *
 * The browser reaches a self-signed stub because Playwright is launched with
 * `--ignore-certificate-errors`. The PROCESS cannot be: `node:https` has no such flag and
 * fails `DEPTH_ZERO_SELF_SIGNED_CERT`. So the stub exports its CA (`SNUG_E2E_CERT_OUT`,
 * D-B29) and the process is pointed at it with `NODE_EXTRA_CA_CERTS` — the one
 * accommodation a self-signed certificate forces, and nothing else about the path is faked.
 */
export async function startNetStub(): Promise<StubHarness> {
  if (!existsSync(NET_STUB)) throw new Error(`${NET_STUB} missing — the fixture moved?`);
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-e2e-ca-'));
  const certPath = path.join(dir, 'stub-ca.pem');

  const child = spawn(process.execPath, [NET_STUB], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SNUG_E2E_NET_STUB_PORT: String(STUB_PORT), SNUG_E2E_CERT_OUT: certPath },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the net stub did not start in time')), 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('net stub')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the net stub exited (${code}) before it was ready`));
    });
  });
  if (!existsSync(certPath)) throw new Error('the stub did not export its CA — SNUG_E2E_CERT_OUT (D-B29) is not wired');

  return {
    certPath,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const IDP_HOST = 'idp.snug.test';
export const IDP_TLS_PORT = 43122;
export const FAKE_IDP = path.join(REPO, 'apps/playground/e2e/fixtures/fake-idp.mjs');

/**
 * The fake identity provider, with its CA exported for the PROCESS (D-B29).
 *
 * AC5's OAuth journey takes the WEB popup path (D-B14): the page's own origin serves
 * `/oauth/callback` and the delivery rides `BroadcastChannel`. The token and refresh POSTs
 * are made by the EXECUTOR through `/fetch`, so it is the process — not the browser — that
 * must trust this certificate.
 */
export async function startFakeIdp(): Promise<StubHarness> {
  if (!existsSync(FAKE_IDP)) throw new Error(`${FAKE_IDP} missing — the fixture moved?`);
  const dir = mkdtempSync(path.join(tmpdir(), 'snug-e2e-idp-'));
  const certPath = path.join(dir, 'idp-ca.pem');

  const child = spawn(process.execPath, [FAKE_IDP], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SNUG_E2E_CERT_OUT_IDP: certPath },
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the fake IdP did not start in time')), 20_000);
    let seen = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      seen += chunk.toString();
      // Wait for the HTTPS listener specifically — the http one comes up first.
      if (seen.includes('https://')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`the fake IdP exited (${code}) before it was ready`));
    });
  });
  if (!existsSync(certPath)) throw new Error('the IdP did not export its CA — SNUG_E2E_CERT_OUT_IDP (D-B29) is not wired');

  return {
    certPath,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.on('exit', resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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
export async function startLocalHost(options: { certPath?: string; certPaths?: string[]; holder?: string; brain?: string } = {}): Promise<LocalHarness> {
  if (!existsSync(PROCESS_BUNDLE)) throw new Error(`${PROCESS_BUNDLE} missing — run \`pnpm --filter host-mcp build\``);
  if (!existsSync(LOCAL_PAGE)) throw new Error(`${LOCAL_PAGE} missing — run \`pnpm --filter host build\``);

  const home = mkdtempSync(path.join(tmpdir(), 'snug-e2e-'));
  const { cpSync } = await import('node:fs');

  // NODE_EXTRA_CA_CERTS takes ONE file, and AC5 needs the process to trust two stubs (the
  // provider and the IdP). PEM is concatenative, so the CAs are joined into one bundle
  // rather than the suite having to pick which fixture the process may reach.
  const cas = [...(options.certPath !== undefined ? [options.certPath] : []), ...(options.certPaths ?? [])];
  let caBundle: string | undefined;
  if (cas.length > 0) {
    caBundle = path.join(home, 'e2e-ca-bundle.pem');
    writeFileSync(caBundle, cas.map((file) => readFileSync(file, 'utf8')).join('\n'));
  }
  // The process reads the page from beside its own bundle; the plugin ships them together.
  cpSync(LOCAL_PAGE, path.join(path.dirname(PROCESS_BUNDLE), 'snug-host-local.html'));

  const child = spawn(process.execPath, [PROCESS_BUNDLE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SNUG_MCP_TEST_ENTRY: '1',
      SNUG_HOME: home,
      // Both fixture hosts: AC3/AC4 reach the provider stub, AC5's token and refresh
      // POSTs reach the IdP — and both are made by the PROCESS, not the browser.
      SNUG_MCP_TEST_RESOLVE: `${STUB_HOST}=127.0.0.1,${IDP_HOST}=127.0.0.1`,
      ...(options.holder !== undefined ? { SNUG_MCP_TEST_HOLDER: options.holder } : {}),
      ...(options.brain !== undefined ? { SNUG_MCP_TEST_BRAIN: options.brain } : {}),
      ...(caBundle !== undefined ? { NODE_EXTRA_CA_CERTS: caBundle } : {}),
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
