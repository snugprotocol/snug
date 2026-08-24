// consentBands.test.tsx — TASK-20260823-legal-terms-privacy-eula AC6 / AC7 / AC8
// (ADR-0055 §3): the contextual-consent bands in Settings.
//
// THE DOCTRINE, from lanConsentCopy.test.tsx: a band is a WARNING, not a refusal. It
// names the specific thing (the provider, the host, the origin) so the user can judge,
// it keys on state the code can actually know, and it never disables the control or
// adds a confirm. Each band therefore gets the same four assertions: absent in the null
// state, present in the live state, names the thing, leaves the control enabled.
//
//   AC6  BYOK: while a provider's key is SAVED, say what that provider receives (prompts,
//        app data, connected-service results), under whose terms, on whose bill.
//   AC7  local model: when the "local" URL's host is not on this machine, say so and NAME
//        it — the private-address doctrine applied to the field where the misunderstanding
//        costs most ("local means local" is load-bearing for the honesty posture). Keys on
//        the HOST: the default localhost stays quiet, a lookalike name raises.
//   AC8  sync origin: dropbox → the whole file, every saved key and token, re-copied for
//        as long as it stays selected. Hub (flag-on builds only) → a WARNING about app
//        data reaching the hub operator, keys stripped — and on the launch build the band
//        is absent WITH the option, so the guard proves the wiring, not merely an absence.
//
// Platform is set-once, so each case takes a fresh module registry
// (desktopSettingsView.test.tsx's harness).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnugPlatform } from '../platform/platform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  mode: typeof import('../state/mode.js');
  sync: typeof import('../state/sync.js');
  webllm: typeof import('../state/webllm.js');
  SettingsView: (typeof import('../views/SettingsView.js'))['SettingsView'];
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.restoreAllMocks();
});

async function fresh(platform?: SnugPlatform): Promise<Harness> {
  vi.resetModules();
  localStorage.clear();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const helper = await import('./userdbTestHelper.js');
  await helper.installTestUserDb();
  const mode = await import('../state/mode.js');
  const sync = await import('../state/sync.js');
  const webllm = await import('../state/webllm.js');
  const view = await import('../views/SettingsView.js');
  return { mode, sync, webllm, SettingsView: view.SettingsView };
}

async function render(View: Harness['SettingsView']): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter>
        <View />
      </MemoryRouter>,
    );
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function q<T extends HTMLElement = HTMLElement>(sel: string): T | null {
  return container?.querySelector<T>(sel) ?? null;
}

const webFlagOn: SnugPlatform = {
  kind: 'web',
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false, hubAuth: true },
};

describe('AC6 — the BYOK saved-key band', () => {
  it('is absent while no key is saved, present while one is — naming the provider, the terms, the bill', async () => {
    const h = await fresh();
    h.mode.modeStore.set('byok');
    h.mode.byokKeyPresenceStore.set({ anthropic: false, openai: false });
    await render(h.SettingsView);
    expect(q('[data-testid="byok-consent-band"]')).toBeNull();

    await act(async () => {
      h.mode.byokKeyPresenceStore.set({ anthropic: true, openai: false });
    });
    await settle();
    const band = q('[data-testid="provider-row-anthropic"] [data-testid="byok-consent-band"]');
    expect(band, 'the band renders inside the keyed provider\'s row').not.toBeNull();
    expect(band?.getAttribute('role')).toBe('note');
    const text = band?.textContent ?? '';
    expect(text).toContain('Anthropic');
    expect(text).toMatch(/prompts/i);
    expect(text).toMatch(/app data/i);
    expect(text).toMatch(/connected/i);
    expect(text).toMatch(/their (own )?terms/i);
    expect(text).toMatch(/your (own )?bill/i);
    // The OTHER provider's row stays quiet — the band keys on THAT key, not on any key.
    expect(q('[data-testid="provider-row-openai"] [data-testid="byok-consent-band"]')).toBeNull();
  });

  it('warns, never refuses: the key input stays enabled and no confirm appears', async () => {
    const h = await fresh();
    h.mode.modeStore.set('byok');
    h.mode.byokKeyPresenceStore.set({ anthropic: true, openai: true });
    await render(h.SettingsView);
    expect(q<HTMLInputElement>('#byok-key-anthropic')?.disabled).toBe(false);
    expect(q<HTMLInputElement>('#byok-key-openai')?.disabled).toBe(false);
    expect(container?.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
  });
});

describe('AC7 — the local-model remote-endpoint band', () => {
  async function withLocalUrl(url: string): Promise<Harness> {
    const h = await fresh();
    h.mode.modeStore.set('local');
    h.mode.localUrlStore.set(url);
    await render(h.SettingsView);
    return h;
  }

  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1', 'http://192.168.1.20:11434/v1'])(
    'stays quiet for a genuinely local endpoint: %s',
    async (url) => {
      await withLocalUrl(url);
      expect(q('[data-testid="local-endpoint-remote-band"]')).toBeNull();
      // …and the endpoint field really rendered, so the absence is a real negative.
      expect(q('#local-url')).not.toBeNull();
    },
  );

  it.each([
    ['a remote server', 'https://my-ollama.example.com/v1', 'my-ollama.example.com'],
    ['a name that merely LOOKS local', 'http://127-0-0-1.example/v1', '127-0-0-1.example'],
    ['a localhost-prefixed public name', 'http://localhost.attacker.example/v1', 'localhost.attacker.example'],
    ['an mDNS name on the LAN — it leaves this machine', 'http://mymac.local:11434/v1', 'mymac.local'],
  ])('raises for %s and NAMES the host', async (_label, url, host) => {
    await withLocalUrl(url);
    const band = q('[data-testid="local-endpoint-remote-band"]');
    expect(band).not.toBeNull();
    expect(band?.getAttribute('role')).toBe('note');
    expect(band?.textContent).toContain(host);
    expect(band?.textContent).toMatch(/leave(s)? this (machine|computer)/i);
    expect(band?.textContent).toMatch(/prompts/i);
  });

  it('warns, never refuses — the URL input stays enabled', async () => {
    await withLocalUrl('https://my-ollama.example.com/v1');
    expect(q<HTMLInputElement>('#local-url')?.disabled).toBe(false);
  });

  it('renders nothing (and does not throw) for an unparsable URL', async () => {
    await withLocalUrl('not a url at all');
    expect(q('#local-url')).not.toBeNull();
    expect(q('[data-testid="local-endpoint-remote-band"]')).toBeNull();
  });

  it('does not render in byok mode even if a remote local URL is stored', async () => {
    const h = await fresh();
    h.mode.modeStore.set('byok');
    h.mode.localUrlStore.set('https://my-ollama.example.com/v1');
    await render(h.SettingsView);
    expect(q('[data-testid="local-endpoint-remote-band"]')).toBeNull();
  });
});

describe('AC8 — the sync-origin bands', () => {
  it('dropbox: the whole file, every saved key and token, for as long as it stays selected', async () => {
    const h = await fresh();
    h.sync.syncStatusStore.set({ origin: 'dropbox', state: 'idle' });
    await render(h.SettingsView);
    const band = q('[data-testid="sync-origin-secrets-band"]');
    expect(band).not.toBeNull();
    expect(band?.getAttribute('role')).toBe('note');
    const text = band?.textContent ?? '';
    expect(text).toMatch(/whole file/i);
    expect(text).toMatch(/every saved key and token/i);
    expect(text).toMatch(/for as long as/i);
    expect(text).toMatch(/dropbox/i);
    // Selection is still a single click: every origin button stays enabled.
    for (const b of container?.querySelectorAll<HTMLButtonElement>('[aria-labelledby="origin-label"] button') ?? []) expect(b.disabled).toBe(false);
  });

  it('this device only: no band at all', async () => {
    const h = await fresh();
    h.sync.syncStatusStore.set({ origin: 'none', state: 'off' });
    await render(h.SettingsView);
    expect(q('[data-testid="sync-origin-secrets-band"]')).toBeNull();
    expect(q('[data-testid="sync-origin-hub-band"]')).toBeNull();
  });

  it('hub, flag-ON build: a WARNING that app data reaches the hub operator, keys stripped (the Q3 guard)', async () => {
    const h = await fresh(webFlagOn);
    h.sync.syncStatusStore.set({ origin: 'hub', state: 'idle' });
    await render(h.SettingsView);
    const band = q('[data-testid="sync-origin-hub-band"]');
    expect(band, 'the day the flag flips, the disclosure ships with it').not.toBeNull();
    expect(band?.getAttribute('role')).toBe('note');
    const text = band?.textContent ?? '';
    expect(text).toMatch(/operator/i);
    expect(text).toMatch(/records|chats|messages/i);
    expect(text).toMatch(/stripped/i);
    expect(q('[data-testid="sync-origin-secrets-band"]')).toBeNull();
  });

  it('hub, launch build (flag off): neither the option nor the band exists', async () => {
    const h = await fresh(); // web, hubAuth absent — ADR-0052 §5
    h.sync.syncStatusStore.set({ origin: 'hub', state: 'idle' });
    await render(h.SettingsView);
    expect([...(container?.querySelectorAll('.seg button') ?? [])].find((b) => /this hub/.test(b.textContent ?? ''))).toBeUndefined();
    expect(q('[data-testid="sync-origin-hub-band"]')).toBeNull();
  });

  it('the include-secrets export hint says the exported file then carries every saved key and token (review F12)', async () => {
    const h = await fresh();
    await render(h.SettingsView);
    expect(container?.textContent ?? '').toMatch(/exported file then carries every saved key and token/i);
  });
});

describe('the experimental in-browser model names where its weights come from (review F12)', () => {
  it('flag on: the card names huggingface.co', async () => {
    const h = await fresh();
    h.webllm.webllmFlagStore.set(true);
    await render(h.SettingsView);
    expect(q('[data-testid="webllm-experimental-card"]')?.textContent).toContain('huggingface.co');
  });
});
