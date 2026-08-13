// The private-address consent band on the review screen (P0 security-lens
// amendment 15 — lan-apikey-review-copy).
//
// THE THREAT THIS EXISTS FOR IS NOT HUE. A prompt-injected authored `api_key`
// requirement can name a victim address on the user's own network — a router's
// admin endpoint, a NAS, a printer — and ride ADR-0021's http-to-private-literal
// rung with NO pairing gate in the way. Nothing about that row is LAN-CLASS:
// it has no `lanHost` seat, borrows no registry brand, and passes every guard,
// because a private IP literal is a legal `declaredApiHosts` entry and always
// has been. The ONLY barrier is the review screen's host list — which today
// renders `192.168.1.1` in the same neutral voice as `api.github.com`.
//
// So the band keys on the HOST, never on the provider, never on `lanHost`, and
// the non-hue case below is the load-bearing test: a guard scoped to the class
// that produced it would miss every instance of the class that motivated it.
//
// It is a WARNING, not a refusal: refusing a private host outright would break
// self-hosted services, which are a legitimate and growing use. The user is the
// one who knows whether they recognize the address; the screen's job is to make
// sure they are asked the question rather than shown a URL.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

const APP = 'app-lan-consent';

interface Harness {
  db: UserDb;
  wizard: typeof import('../state/connectionWizard.js');
  Sheet: typeof import('../connections/ConnectionWizardSheet.js')['ConnectionWizardSheet'];
}

async function fresh(): Promise<Harness> {
  vi.resetModules();
  const helper = await import('./userdbTestHelper.js');
  const db = await helper.installTestUserDb();
  db.installApp({ appId: APP, displayName: 'Thing', html: '<p>thing</p>' });
  const wizard = await import('../state/connectionWizard.js');
  wizard.__resetConnectionWizardForTests();
  const sheet = await import('../connections/ConnectionWizardSheet.js');
  return { db, wizard, Sheet: sheet.ConnectionWizardSheet };
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

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  for (let i = 0; i < 25; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function testId(id: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

/**
 * A plain authored `api_key` requirement pointing at a host of the caller's
 * choosing. NO registry brand, NO `lanHost` — deliberately the shape a
 * prompt-injected declaration would take.
 */
function authoredRequirement(slot: string, host: string): Record<string, unknown> {
  return {
    slot,
    kind: 'api_key',
    provider: { name: 'My Home Thing' },
    declaredApiHosts: [host],
    fields: [{ key: 'api_key', label: 'API key', type: 'secret', required: true }],
  };
}

async function openReview(harness: Harness, slot: string, host: string): Promise<void> {
  harness.db.putDeclaredConnection(APP, slot, authoredRequirement(slot, host), 'inference');
  harness.wizard.openConnectionWizard({ appId: APP, slot, source: 'settings' });
  await render(<harness.Sheet />);
}

describe('the private-address consent band', () => {
  // Slots are `[a-z0-9][a-z0-9-]{0,39}` — a dotted address cannot be one, so the
  // slot name is a plain index. (The first draft used the address and the SCHEMA
  // refused it; the fixture was the thing that was wrong, not the rule.)
  it.each([
    ['an RFC-1918 /16 address', '192.168.1.1', 'private-a'],
    ['an RFC-1918 /8 address', '10.0.0.5', 'private-b'],
    ['an RFC-1918 /12 address', '172.16.4.9', 'private-c'],
    ['loopback', '127.0.0.1', 'private-d'],
    ['link-local', '169.254.1.1', 'private-e'],
  ])('renders for %s on a NON-hue, non-lanHost requirement', async (_label, host, slot) => {
    const harness = await fresh();
    await openReview(harness, slot, host);

    const band = testId('review-private-host-warning');
    expect(band, `${host} must raise the band`).not.toBeNull();
    expect(band?.textContent ?? '').toMatch(/on your own network/i);
    expect(band?.textContent ?? '').toMatch(/recognize this address/i);
  });

  it('does NOT render for an ordinary public host (the band must stay meaningful)', async () => {
    const harness = await fresh();
    // A host that borrows NO registry brand: `api.github.com` was the first
    // choice and Guard 2b refused the fixture for authoring `fields` under
    // GitHub's name — the guard working exactly as designed (lesson 2026-08-06),
    // and an unrelated host is the fix rather than a weaker guard.
    await openReview(harness, 'public', 'api.some-saas.example');

    expect(testId('review-private-host-warning')).toBeNull();
    // …and the review itself still rendered, so the absence is a real negative
    // rather than a screen that failed to mount.
    expect(testId('review-hosts')).not.toBeNull();
  });

  it('does NOT render for a public host that merely LOOKS private in its name', async () => {
    const harness = await fresh();
    await openReview(harness, 'lookalike', '192-168-1-1.attacker.example');

    expect(testId('review-private-host-warning')).toBeNull();
  });

  it('still warns, never refuses — approval remains available', async () => {
    const harness = await fresh();
    await openReview(harness, 'still-approvable', '10.1.2.3');

    const approve = [...(container?.querySelectorAll('button') ?? [])].find((b) =>
      /approve this connection/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement | undefined;
    expect(approve, 'a warning is not a wall — self-hosted services are legitimate').toBeDefined();
    expect(approve?.disabled).toBe(false);
  });

  it('names the offending host, so the user can check the one that matters', async () => {
    const harness = await fresh();
    await openReview(harness, 'named', '10.1.2.3');

    expect(testId('review-private-host-warning')?.textContent ?? '').toContain('10.1.2.3');
  });
});
