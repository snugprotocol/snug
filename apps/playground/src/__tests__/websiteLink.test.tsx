// TASK-20260821-site-playground-polish AC2 — the shell nav links back to the website.
//
// One link serves BOTH surfaces (the desktop shell compiles this same App), so the
// desktop half must route through the platform's system-browser opener — a plain
// href would navigate the Tauri webview away from the app (the DesktopWelcome
// pattern). The URL is playground-OWNED: the dependency direction is
// website → playground, never the reverse (ADR-0048), so this is a new constant,
// not an import from apps/website.
//
// Platform is set-once/locks-on-first-read → fresh module registry per case
// (the platform.test.ts pattern), consumers imported dynamically.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.resetModules();
});

async function renderLink(openExternal?: (url: string) => Promise<void>): Promise<HTMLAnchorElement> {
  vi.resetModules();
  if (openExternal !== undefined) {
    const { setPlatform } = await import('../platform/platform.js');
    setPlatform({
      kind: 'desktop',
      capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
      oauth: {
        redirectUriFor: () => Promise.reject(new Error('unused')),
        openExternal,
        channelFor: () => {
          throw new Error('unused');
        },
        cancel: () => Promise.resolve(),
      },
    });
  }
  // openExternal undefined → no setPlatform: getPlatform falls back to the web default.
  const { WebsiteLink } = await import('../ui/WebsiteLink.js');
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<WebsiteLink />));
  const link = container.querySelector('a');
  if (link === null) throw new Error('WebsiteLink rendered no anchor');
  return link;
}

/** Dispatch a real cancelable click; returns the event for defaultPrevented checks. */
function click(link: HTMLAnchorElement): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  // jsdom would "navigate" on an un-prevented anchor click; stub that final hop only.
  link.addEventListener('click', (e) => e.defaultPrevented || e.preventDefault(), {
    capture: false,
  });
  act(() => {
    link.dispatchEvent(event);
  });
  return event;
}

describe('WebsiteLink', () => {
  it('renders the website URL as a new-tab link labelled by the domain', async () => {
    const link = await renderLink();
    expect(link.textContent).toBe('snugprotocol.org');
    expect(link.getAttribute('href')).toBe('https://snugprotocol.org');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.className).toContain('nav-link');
  });

  it('web: the click stays a plain anchor navigation (component calls no preventDefault)', async () => {
    const link = await renderLink();
    const handler = vi.fn();
    // Observe defaultPrevented AS SEEN AFTER React's own handler ran, before our stub.
    link.addEventListener('click', (e) => handler(e.defaultPrevented));
    click(link);
    expect(handler).toHaveBeenCalledWith(false);
  });

  it('desktop: the click prefers the system-browser opener and suppresses the href', async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    const link = await renderLink(openExternal);
    const event = click(link);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://snugprotocol.org');
  });

  it('the shell nav actually mounts it (wiring, not just the component)', () => {
    // vitest runs with cwd = apps/playground; import.meta.url is not file-scheme here.
    const appSource = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(appSource).toContain('<WebsiteLink />');
  });
});
