// The local page's platform (ADR-0068 D-B14, D-B24).

import { afterEach, describe, expect, it } from 'vitest';

import { brainState, composeLocalPlatform } from '../local/compose-local.js';
import type { LocalClient, LocalStatus } from '../local/client.js';

const client = {
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  status: async () => ({ binding: 'local-host', port: 43127, pages: 1 }),
  events: () => () => {},
} as unknown as LocalClient;

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, ...over });

/** `PlatformBrain` is a union and only its `host` arm carries a label — narrow, don't cast. */
const labelOf = (brain: { kind: string } | undefined): string | undefined =>
  brain !== undefined && brain.kind === 'host' ? (brain as unknown as { label: string }).label : undefined;

describe('the brain chip names what the CLI can actually do (D-B35)', () => {
  // The holder is module state; a leak between cases would make these prove each other.
  afterEach(() => {
    brainState.current = undefined;
  });

  it('says "Claude · your CLI" when the CLI is ready', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'ready' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
  });

  it('NAMES a logged-out CLI on the chip, with the remedy', () => {
    // The owner's walk: a logged-out CLI surfaced as a bare HTTP 502 at the first think,
    // with no remedy and no sign the brain was the problem. The chip must say so before
    // the user asks an app to think.
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'logged-out', detail: 'run `claude` and `/login`' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toMatch(/log/i);
    expect(labelOf(platform.brain)).not.toBe('Claude · your CLI');
  });

  it('falls back to the demo brain’s wording when no CLI is installed', () => {
    // A machine with no `claude` gets a different sentence: telling that user to /login
    // sends them to a CLI they do not have.
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'absent' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain) ?? 'demo brain — no host brain found').toMatch(/demo|no .*brain|not found/i);
  });

  it('the label is a LIVE getter, so a probe answering after boot corrects the chip in place', () => {
    // The probe runs in the background — the kit must open even if the CLI is wedged — so
    // the chip's first value is the boot one and the `status` event carries the verdict.
    // It CANNOT arrive by recomposing: the platform is set once and `setPlatform` throws on
    // a second call (see localBrainEvent.test.ts), so the seat reads a holder at render.
    const { platform } = composeLocalPlatform(client, status(), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    brainState.current = { state: 'logged-out', detail: 'run `claude` and `/login`' };
    expect(labelOf(platform.brain), 'the SAME platform object must now read the new label').toMatch(/log/i);
    brainState.current = undefined;
  });

  it('does not claim the CLI is ready before the probe has answered', () => {
    // `/status` omits `brain` until the probe returns. Reporting "ready" during that
    // window would be a guess that is wrong exactly when it matters.
    const { platform } = composeLocalPlatform(client, status(), undefined, undefined, 't');
    expect(labelOf(platform.brain)).not.toMatch(/logged out/i);
  });
});

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
