// Global setup for the Binding-B suite: a stub provider, then the REAL local host process
// serving the REAL built page (ADR-0068 step 6).
//
// Nothing here is faked at the seam under test. The browser talks to the process, the
// process talks to the stub, and the only accommodations are the two a self-signed
// certificate forces: `--ignore-certificate-errors` for the browser, and
// `NODE_EXTRA_CA_CERTS` for the process — the latter needing the stub to export its CA,
// which is why `SNUG_E2E_CERT_OUT` exists.

import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(here, '../../..');

export const STUB_PORT = 43520;
export const STUB_HOST = 'stub.snug.test';
export const PROCESS_BUNDLE = path.join(REPO, 'apps/host-mcp/dist/snug-mcp.test.mjs');
/** The ONE kit page (K1): the artifact suite opens it from a static server; here the real process serves it. */
export const KIT_PAGE = path.join(REPO, 'apps/host/dist/snug-host.html');

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
  /** Call one of the process's tools as its agent does — a JSON-RPC line over its stdio. */
  tool(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** Kill the process outright (SIGKILL): it goes without a `shutdown` event, as a crash does. Only ever this harness's own child. */
  kill(): Promise<void>;
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

/** A loopback port nothing holds right now — for a spec that needs the runner on ITS fixed port. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/**
 * One fake brain driver of the TEST build (`SNUG_MCP_TEST_BRAINS`, read by
 * `apps/host-mcp/src/main.test-hooks.ts`). The test build has ONLY the brains a spec names:
 * it has no path to the developer's real CLIs, so a suite can spend nobody's subscription.
 */
export interface FakeBrain {
  id: string;
  name: string;
  /** Whose it is, in words (`your Codex CLI`). */
  via: string;
  /** What its probe answers. Any string: an unknown one is how a spec shows the page one. */
  state: string;
  /** The remedy sentence for a state that is not `ready`. */
  detail?: string;
  /** false = experimental: never taken by `auto`, answers only when pinned (ADR-0071 §2). */
  verified: boolean;
  streaming?: boolean;
  efforts?: readonly string[];
  models?: readonly { id: string; name: string; efforts: readonly string[] }[];
  /** What it answers every think with. Absent → it refuses by name (the 502 a brain that cannot answer gives). */
  reply?: string;
  /** The model it reports as having run. Default `<id>-fake`. */
  resolvedModel?: string;
  /**
   * What its probe answers from the SECOND round on — a brain the user fixed while the
   * page was open (`/login` in a terminal). Absent → every round answers `state`.
   */
  afterRecheck?: { state: string; detail?: string };
}

export interface LocalHostOptions {
  certPath?: string;
  certPaths?: string[];
  holder?: string;
  /**
   * The runner's brains, in the runner's order (its default brain, `claude`, first). Wins
   * over the three single-brain options below.
   */
  brains?: readonly FakeBrain[];
  /**
   * THE SINGLE-BRAIN OPTIONS, from before the brain registry (TASK-20260922): the state of
   * the one CLI, the model it reports having run, its model list. Kept so the specs written
   * against them stay byte-identical — they are translated into ONE fake `claude` brain.
   */
  brain?: string;
  brainModel?: string;
  models?: readonly { id: string; name: string; effort: boolean }[];
  /**
   * The page to serve INSTEAD of the built one — a spec that needs a page carrying embedded
   * blocks (K6) hands in its bytes. Default: `apps/host/dist/snug-host.html`, unchanged.
   */
  page?: string;
  /**
   * The ports to try, in order. The first is the runner's FIXED port — the one an OAuth
   * redirect is registered against — so a spec that needs the sign-in offer passes a free
   * one. Default: the release's own list (43127, then any), where 43127 is usually taken by
   * a developer's own running Snug.
   */
  ports?: readonly number[];
}

/** The levels `claude --effort` documents (measured, 2.1.278) — what the real driver reports for a model that thinks. */
export const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The real `claude` driver's remedy per state — held equal to its source by localSetup.test.ts — so a spec reads the sentence a user does. */
export const CLAUDE_REMEDY: Readonly<Record<string, string>> = {
  'logged-out': 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.',
  outdated: 'Your Claude CLI is out of date — run `claude update`, then check again.',
  absent: 'No `claude` CLI found on this machine — Snug is using its demo brain. Install Claude Code (https://code.claude.com/docs/en/quickstart), then run `claude` and `/login`, and check again.',
};

/**
 * The single-brain options as the ONE brain they always described. `undefined` when a spec
 * gave none of them: that runner has no brain at all.
 *
 *  - `brain`      → the state its probe answers (default `ready`: a spec that pinned only a
 *                   model was describing a CLI that answers);
 *  - `brainModel` → it ANSWERS (a JSON object, as a real model answers an app that declares
 *                   a response schema — it carries no app-specific field, so an app treats it
 *                   as off-script), and reports that id as the model that ran. Without it the
 *                   brain refuses by name, as the old test build's did;
 *  - `models`     → its catalogue; `effort: true` was "this model has the thinking axis",
 *                   which is Claude's five levels now that levels are listed per model.
 */
export function legacyClaude(options: Pick<LocalHostOptions, 'brain' | 'brainModel' | 'models'>): FakeBrain | undefined {
  if (options.brain === undefined && options.brainModel === undefined && options.models === undefined) return undefined;
  const state = options.brain ?? 'ready';
  const detail = CLAUDE_REMEDY[state];
  return {
    id: 'claude',
    name: 'Claude',
    via: 'your Claude Code CLI',
    state,
    ...(detail !== undefined ? { detail } : {}),
    verified: true,
    streaming: true,
    efforts: CLAUDE_LEVELS,
    models: (options.models ?? []).map(({ id, name, effort }) => ({ id, name, efforts: effort ? CLAUDE_LEVELS : [] })),
    ...(options.brainModel !== undefined ? { reply: JSON.stringify({ message: 'pinned reply' }), resolvedModel: options.brainModel } : {}),
  };
}

/** What `SNUG_MCP_TEST_BRAINS` carries for these options; `undefined` = the variable is not set. */
export function brainsEnv(options: LocalHostOptions): string | undefined {
  const legacy = legacyClaude(options);
  const brains = options.brains ?? (legacy !== undefined ? [legacy] : undefined);
  return brains === undefined ? undefined : JSON.stringify(brains);
}

/**
 * Start the real process against an isolated home, from a SCRATCH INSTALL: the test bundle
 * and the page copied side by side into a temp directory, which is the layout the process's
 * page locator finds last (`apps/host-mcp/src/page.ts`). Nothing is written into the repo's
 * `dist/`, and a spec can serve a page of its own. A missing build is CANNOT RUN by name —
 * never a skip that reads as a pass.
 */
export async function startLocalHost(options: LocalHostOptions = {}): Promise<LocalHarness> {
  if (!existsSync(PROCESS_BUNDLE)) throw new Error(`${PROCESS_BUNDLE} missing — run \`pnpm --filter host-mcp build\``);
  if (!existsSync(KIT_PAGE)) throw new Error(`${KIT_PAGE} missing — run \`pnpm --filter host build\``);

  const home = mkdtempSync(path.join(tmpdir(), 'snug-e2e-'));
  const install = mkdtempSync(path.join(tmpdir(), 'snug-e2e-install-'));
  const bundle = path.join(install, path.basename(PROCESS_BUNDLE));
  cpSync(PROCESS_BUNDLE, bundle);
  if (options.page !== undefined) writeFileSync(path.join(install, 'snug-host.html'), options.page);
  else cpSync(KIT_PAGE, path.join(install, 'snug-host.html'));

  // NODE_EXTRA_CA_CERTS takes ONE file, and AC5 needs the process to trust two stubs (the
  // provider and the IdP). PEM is concatenative, so the CAs are joined into one bundle
  // rather than the suite having to pick which fixture the process may reach.
  const cas = [...(options.certPath !== undefined ? [options.certPath] : []), ...(options.certPaths ?? [])];
  let caBundle: string | undefined;
  if (cas.length > 0) {
    caBundle = path.join(home, 'e2e-ca-bundle.pem');
    writeFileSync(caBundle, cas.map((file) => readFileSync(file, 'utf8')).join('\n'));
  }

  const brains = brainsEnv(options);
  const child = spawn(process.execPath, [bundle], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SNUG_MCP_TEST_ENTRY: '1',
      SNUG_HOME: home,
      // Both fixture hosts: AC3/AC4 reach the provider stub, AC5's token and refresh
      // POSTs reach the IdP — and both are made by the PROCESS, not the browser.
      SNUG_MCP_TEST_RESOLVE: `${STUB_HOST}=127.0.0.1,${IDP_HOST}=127.0.0.1`,
      ...(options.holder !== undefined ? { SNUG_MCP_TEST_HOLDER: options.holder } : {}),
      ...(brains !== undefined ? { SNUG_MCP_TEST_BRAINS: brains } : {}),
      ...(options.ports !== undefined ? { SNUG_MCP_TEST_PORTS: options.ports.join(',') } : {}),
      ...(caBundle !== undefined ? { NODE_EXTRA_CA_CERTS: caBundle } : {}),
    },
  });

  // The agent's side of the process: one JSON-RPC line out, the answer with the same id back.
  const answers = new Map<number, (result: { content?: { text?: string }[]; isError?: boolean }) => void>();
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
    for (let newline = stdout.indexOf('\n'); newline !== -1; newline = stdout.indexOf('\n')) {
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      try {
        const message = JSON.parse(line) as { id?: number; result?: { content?: { text?: string }[]; isError?: boolean } };
        if (typeof message.id === 'number' && message.result !== undefined) answers.get(message.id)?.(message.result);
      } catch {
        /* not a JSON-RPC line */
      }
    }
  });
  let nextId = 1;

  const line = await waitForLine(child, /\{"ready":true[^\n]*\}/);
  const ready = JSON.parse(line) as { port: number; url: string };

  let exited = false;
  child.on('exit', () => (exited = true));

  return {
    url: ready.url,
    port: ready.port,
    home,
    tool(name, args = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`${name} was not answered in 20 s`)), 20_000);
        answers.set(id, (result) => {
          clearTimeout(timer);
          answers.delete(id);
          resolve({ text: result.content?.[0]?.text ?? '', isError: result.isError === true });
        });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
      });
    },
    async kill() {
      if (exited) return;
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    },
    async stop() {
      // Idempotent: a spec that stops the runner itself (K7) is followed by the fixture's stop.
      if (!exited) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(install, { recursive: true, force: true });
    },
  };
}
