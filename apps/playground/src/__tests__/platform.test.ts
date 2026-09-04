// Platform seam (TASK-20260812 P1 glue): the ONE desktop-vs-web switch. The web
// default IS today's behavior (AC10's no-regression hinges on every consumer
// treating the absent seams as "do what you did before"), and the set-once /
// set-before-first-read rule forbids mid-session platform swaps — a platform that
// changed under a live wizard would split one flow across two transports.

import { describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

/** Module-level state under test — each case gets a fresh module registry. */
async function freshModule(): Promise<typeof import('../platform/platform.js')> {
  vi.resetModules();
  return import('../platform/platform.js');
}

function desktopPlatform(): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}

describe('getPlatform default', () => {
  it('is the web platform with today\'s capabilities and no optional seams', async () => {
    const { getPlatform } = await freshModule();
    const p = getPlatform();
    expect(p.kind).toBe('web');
    // hubAuth is false unless the build sets VITE_SNUG_HUB_AUTH=1 (ADR-0052 §5) —
    // vitest sets no such env, so the default is the launch posture.
    expect(p.capabilities).toEqual({ subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, hubAuth: false });
    // Absent seams are the web signal: consumers fall back to page fetch /
    // detectPersistenceBackend / popup+BroadcastChannel / downloadBlob / no probe.
    expect(p.fetchImpl).toBeUndefined();
    expect(p.userdbBackend).toBeUndefined();
    expect(p.oauth).toBeUndefined();
    expect(p.saveFile).toBeUndefined();
    expect(p.probeOllama).toBeUndefined();
    expect(p.onOpenSnugFile).toBeUndefined();
  });
});

describe('setPlatform', () => {
  it('before the first read makes getPlatform return exactly the set platform', async () => {
    const { getPlatform, setPlatform } = await freshModule();
    const desktop = desktopPlatform();
    setPlatform(desktop);
    expect(getPlatform()).toBe(desktop);
    expect(getPlatform().capabilities.lanHttpPrivate).toBe(true);
  });

  it('throws after getPlatform was read in web-default mode (no mid-session swap)', async () => {
    const { getPlatform, setPlatform } = await freshModule();
    expect(getPlatform().kind).toBe('web');
    expect(() => setPlatform(desktopPlatform())).toThrow(/getPlatform/);
    // The failed set must not have taken effect.
    expect(getPlatform().kind).toBe('web');
  });

  it('throws when called twice — the platform is set once before boot', async () => {
    const { getPlatform, setPlatform } = await freshModule();
    const first = desktopPlatform();
    setPlatform(first);
    expect(() => setPlatform(desktopPlatform())).toThrow(/twice|already/);
    expect(getPlatform()).toBe(first);
  });
});
