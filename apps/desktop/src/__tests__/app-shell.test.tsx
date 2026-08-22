// Desktop shell smoke (TASK-20260812 P3 item 6): the window is titled "Snug", and the
// first-run welcome renders through the SAME composition main.tsx uses — the playground
// App under a HashRouter with a desktop platform installed first. The platform here is
// a fake (no Tauri in vitest); the point is that the aliased playground source plus the
// desktop entry's wiring produce the grandma-facing first screen.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '@playground/platform/platform';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

describe('window title', () => {
  it('the Tauri window and the html document are both titled "Snug"', () => {
    const conf = JSON.parse(readFileSync(here('../../src-tauri/tauri.conf.json'), 'utf8')) as {
      app?: { windows?: Array<{ title?: string }> };
    };
    const windows = conf.app?.windows ?? [];
    expect(windows.length).toBeGreaterThan(0);
    for (const win of windows) expect(win.title).toBe('Snug');
    expect(readFileSync(here('../../index.html'), 'utf8')).toContain('<title>Snug</title>');
  });
});

describe('first-run through the desktop entry composition', () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = undefined;
    root = undefined;
    vi.restoreAllMocks();
  });

  // 20s, not vitest's default 5s. This one test resets the module graph, dynamic-imports the
  // WHOLE playground App, boots a sql.js-backed user DB and renders React through it —
  // ~1.1s alone, ~3.5s under partial load, and OVER 5s when `turbo run test` runs every
  // package's suite at once, which is exactly how the merge gate runs it. That made the
  // gate red on `main` for a test that had never regressed (reproduced on 2449990,
  // TASK-20260822-wa-authstate-corruption). A budget must be set by what the work costs at
  // its slowest, not by what it costs on an idle machine; the default was never chosen for
  // this test, it was merely inherited.
  it('renders the welcome (platform first, HashRouter, playground App) on a fresh user file', async () => {
    vi.resetModules();
    const platform: SnugPlatform = {
      kind: 'desktop',
      probeOllama: () => Promise.resolve({ running: true, models: ['llama3.2'] }),
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    };
    // Exactly main.tsx's order: install the platform BEFORE any playground module reads it.
    const platformModule = await import('@playground/platform/platform');
    platformModule.setPlatform(platform);
    // Memory-backed user DB (vitest has no OPFS/Tauri fs) via the playground helper.
    const helper = await import('@playground/__tests__/userdbTestHelper');
    await helper.installTestUserDb();
    const { App } = await import('@playground/App');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <HashRouter>
          <App />
        </HashRouter>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).toContain(
      'Snug runs on your computer. Your data stays in one file that belongs to you.',
    );
    // BYOK/local only: the desktop shell never shows a subscription surface.
    expect(container.textContent).not.toMatch(/subscription/i);
  }, 20_000);
});
