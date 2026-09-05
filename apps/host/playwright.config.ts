// playwright.config.ts — the host kit's real-browser suite (TASK-20260905-host-kit P9):
// the BUILT page served from a loopback static server (the artifact shape) and opened
// from file:// (the plain-file shape), with every request outside the page's own origin
// aborted except jsDelivr /npm/ (the apps' React) and the starters package, which is
// intercepted and served from the local package build. Run via
// `pnpm --filter host test:e2e` (cwd = apps/host), after `pnpm --filter host build`.
import fs from 'node:fs';

import { defineConfig, devices } from '@playwright/test';

import { KIT_DIST_FILE, KIT_ORIGIN, KIT_PORT, STARTERS_PKG_DIR } from './e2e/helpers';

// A missing build is CANNOT RUN, never a skip (gate-local's precondition says the same).
if (!fs.existsSync(KIT_DIST_FILE)) throw new Error(`${KIT_DIST_FILE} missing — run \`pnpm --filter host build\` first`);
if (!fs.existsSync(`${STARTERS_PKG_DIR}/index.json`)) throw new Error(`${STARTERS_PKG_DIR}/index.json missing — run \`pnpm --filter host build:starters\``);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  use: {
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/static-server.mjs',
    url: `${KIT_ORIGIN}/healthz`,
    env: { SNUG_HOST_E2E_PORT: String(KIT_PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
