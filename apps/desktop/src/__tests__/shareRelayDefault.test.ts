// @vitest-environment node
// (Vite's resolveConfig runs esbuild, which refuses jsdom's TextEncoder.)
// shareRelayDefault.test.ts — TASK-20260905-desktop-share-relay-default AC1.
//
// The shell is Snug's own binary, so it knows the ONE hosted relay (ADR-0064) by
// default: `tauri dev` and `tauri build` both bake `VITE_SNUG_SHARE_RELAY` in without
// an env file (deploy-web's posture rule — no app-level .env — holds for the desktop
// too, and release-desktop.mjs refuses one). An explicit value in the environment still
// wins, for a developer pointing at a dev relay. The test resolves the REAL Vite config
// and reads what Vite would expose as `import.meta.env`, so the mechanism — not a
// constant — is what is pinned; and the value must equal the release script's, so the
// web deploy, the desktop release and desktop dev cannot name two relays.

import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import { SHARE_RELAY_ORIGIN } from '../../../../scripts/release-desktop.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

async function resolvedEnv(): Promise<Record<string, unknown>> {
  const config = await resolveConfig({ root, configFile, logLevel: 'silent' }, 'build');
  return config.env;
}

const saved = process.env.VITE_SNUG_SHARE_RELAY;

afterEach(() => {
  if (saved === undefined) delete process.env.VITE_SNUG_SHARE_RELAY;
  else process.env.VITE_SNUG_SHARE_RELAY = saved;
});

describe('the desktop build knows the share relay', () => {
  it('defaults VITE_SNUG_SHARE_RELAY to the one hosted relay when the environment has none', async () => {
    delete process.env.VITE_SNUG_SHARE_RELAY;
    const env = await resolvedEnv();
    expect(env.VITE_SNUG_SHARE_RELAY).toBe('https://share.snugprotocol.org');
    expect(env.VITE_SNUG_SHARE_RELAY).toBe(SHARE_RELAY_ORIGIN);
  });

  it('an explicit environment value still wins (a developer pointing at a dev relay)', async () => {
    process.env.VITE_SNUG_SHARE_RELAY = 'http://localhost:8787';
    const env = await resolvedEnv();
    expect(env.VITE_SNUG_SHARE_RELAY).toBe('http://localhost:8787');
  });
});
