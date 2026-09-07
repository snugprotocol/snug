// The local page's platform (ADR-0068 D-B14, D-B24).

import { describe, expect, it } from 'vitest';

import { composeLocalPlatform } from '../local/compose-local.js';
import type { LocalClient, LocalStatus } from '../local/client.js';

const client = {
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  status: async () => ({ binding: 'local-host', port: 43127, pages: 1 }),
  events: () => () => {},
} as unknown as LocalClient;

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, ...over });

describe('the platform this binding carries', () => {
  it('turns connections ON — the one binding with connected apps', () => {
    // RunView keys its net handler on this, so host-ready.net becomes true structurally.
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.connections).toBe(true);
  });

  it('carries fetchImpl, so the executor reaches the network through the process', () => {
    expect(composeLocalPlatform(client, status()).platform.fetchImpl).toBeTypeOf('function');
  });

  it('leaves platform.oauth UNDEFINED, so the wizard keeps its web popup path', () => {
    // Setting it flips the wizard's one "not a browser" discriminator: the popup-blocker
    // escape is skipped and a handle-less pseudo-popup with no null check is installed, so
    // window.open — already past its user activation — returns null and the flow parks on
    // awaiting_callback forever.
    expect(composeLocalPlatform(client, status()).platform.oauth).toBeUndefined();
  });

  it('carries no LAN seats, so a LAN row gets the executor’s named refusal', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.lanFetch).toBeUndefined();
    expect(platform.lanPair).toBeUndefined();
    expect(platform.capabilities.lanHttpPrivate).toBe(false);
  });

  it('keeps the D15 controls off', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.brainSettings).toBe(false);
    expect(platform.capabilities.account).toBe(false);
  });

  it('keeps the per-app export on while link sharing stays off', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.appExport).toBe(true);
    expect(platform.capabilities.share).toBe(false);
  });
});

describe('when another product holds the file (D-B24)', () => {
  it('REFUSES to open rather than running read-only', () => {
    // Both of the db's save paths swallow a failed write, so a read-only page would take an
    // hour of work and lose it silently on tab close.
    const { refusal } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(refusal).toEqual({ heldBy: 'Snug for Mac' });
  });

  it('carries no userdb backend at all in that state — nothing can write', () => {
    const { platform } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(platform.userdbBackend).toBeUndefined();
    expect(platform.capabilities.connections).toBe(false);
  });
});
