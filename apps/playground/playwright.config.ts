// playwright.config.ts — the umbrella's real-browser gate (AC-7 flow, BROWSER_CSP_CHECKS,
// StrictMode F-4, mobile smoke). Run via `pnpm --filter playground test:e2e` (the suite
// assumes cwd = apps/playground; see e2e/helpers.ts).
//
// webServer array:
//   1. fixture server (always)     — self-contained harness pages for csp/strictmode/
//                                    bridge round-trip; production runner dist under test.
//   2. reference server (always)   — apps/server with SNUG_ADAPTER=mock on a fixed port,
//                                    fresh SNUG_DATA_DIR under the OS tmpdir per run (the
//                                    mock script is stateful — never reuse a server).
//   3. vite app (once it exists)   — workstream A's SPA; gated so the runnable-now specs
//                                    stay green before integration.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { APP_PORT, APP_URL, FIXTURE_PORT, FIXTURE_URL, NET_STUB_PORT, NET_STUB_URL, SERVER_PORT, SERVER_URL, appIsPresent } from './e2e/helpers';

const hasApp = appIsPresent();
// Propagated to workers so specs can skip (not fail) before workstream A lands.
process.env.SNUG_E2E_HAS_APP = hasApp ? '1' : '';

// Fresh data dir per run: the mock adapter's scripted turns and the artifact store are
// stateful, and AC-7 asserts on exactly the demo script's output.
const dataDir = path.join(os.tmpdir(), 'snug-playground-e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });

const webServer = [
  {
    command: 'node e2e/fixtures/server.mjs',
    url: `${FIXTURE_URL}/healthz`,
    env: { SNUG_E2E_FIXTURE_PORT: String(FIXTURE_PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
  {
    // AL-03 net e2e: a self-signed HTTPS provider stub (net.spec scopes ignoreHTTPSErrors
    // to its own context). Requires the auth+db dist the fixture import map serves.
    command: 'pnpm --filter @snugprotocol/auth build && pnpm --filter @snugprotocol/db build && node e2e/fixtures/net-stub.mjs',
    url: `${NET_STUB_URL}/healthz`,
    env: { SNUG_E2E_NET_STUB_PORT: String(NET_STUB_PORT) },
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  {
    command: 'pnpm --filter server build && node ../server/dist/server.js',
    url: `${SERVER_URL}/artifacts`,
    env: {
      SNUG_ADAPTER: 'mock',
      PORT: String(SERVER_PORT),
      HOST: '127.0.0.1',
      SNUG_DATA_DIR: dataDir,
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
  ...(hasApp
    ? [
        {
          // vite.config.ts proxies /invoke + /artifacts to 127.0.0.1:8787 — the
          // reference-server entry above binds that exact port (SERVER_PORT).
          command: `npx vite --port ${APP_PORT} --strictPort --host 127.0.0.1`,
          url: APP_URL,
          reuseExistingServer: false,
          timeout: 120_000,
        },
      ]
    : []),
];

export default defineConfig({
  testDir: './e2e',
  // The reference server's mock script is consumed in order — keep the run serial.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: APP_URL,
    trace: 'retain-on-failure',
  },
  webServer,
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/mobile\.spec\.ts/, /no-server\.spec\.ts/, /net\.spec\.ts/],
    },
    {
      // AL-03 net e2e: its OWN project so the self-signed-cert allowance and the
      // stub.snug.test → 127.0.0.1 host-resolver rule stay SCOPED to this spec (A1) and
      // never touch the app-serving contexts.
      name: 'net',
      testMatch: /net\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        ignoreHTTPSErrors: true,
        launchOptions: {
          args: [
            `--host-resolver-rules=MAP stub.snug.test 127.0.0.1`,
            // The document-level fetch to the self-signed stub needs the cert error
            // ignored at the browser level too — scoped to THIS project's browser.
            '--ignore-certificate-errors',
          ],
        },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      // AC2's OPFS-persistence gate gets its OWN browser process: Chromium shares
      // ephemeral-context OPFS profile-wide, and the ASYNC storage cleanup from other
      // tests' closing contexts (csp.spec's 15 rapid contexts) lands mid-test and
      // wipes the origin's OPFS. A separate project = separate worker = fresh profile.
      name: 'no-server',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /no-server\.spec\.ts/,
    },
  ],
});
