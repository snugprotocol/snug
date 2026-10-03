// hostPassport.test.tsx — TASK-20261003 R3 S5 (ADR-0072 §4): the host passport. One chip on
// the header's chip row, HOST platforms only, that says in words what this host can and
// cannot do — thinks, keeps your file, live connections, a provider sign-in, your home
// network, the phone helper — from the SAME table the shelf and the run route obey
// (`offersOf`), so "why is that tile disabled?" has one answer and one place to read it.
// Web and desktop render nothing new: their story is Settings' and the brain chip's.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentAdapter } from '@snugprotocol/adapters';
import { createMemoryBackend } from '@snugprotocol/db';

import type { CustodyState, PlatformBrain, SnugPlatform } from '../platform/platform.js';
import { createStore } from '../state/store.js';
import { HOST_OFF_CAPABILITIES, hostPlatform as hostFixture } from './fixtures/hostPlatform.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const seat = (async () => new Response('')) as never;
const idleAdapter: AgentAdapter = { complete: async () => ({ ok: true, text: '{}', toolCalls: [], stopReason: 'end' }) };
const hostBrain = (label: string): PlatformBrain => ({ kind: 'host', label, adapter: idleAdapter, streaming: true, tools: false });
const custody = (state: CustodyState = { dirty: false, readOnly: false }) => ({ state: createStore<CustodyState>(state) });

/** The kit inside a Claude artifact: nothing but a sandbox, a file in the page, and (here) no brain. */
const artifact = (state?: CustodyState): SnugPlatform =>
  hostFixture({ userdbBackend: { ...createMemoryBackend(), kind: 'artifact-html' as const }, custody: custody(state) });

/** The local runner: the user's own agent thinks, the process carries connections, the file is on disk. */
const runner = (over: Partial<SnugPlatform['capabilities']> = {}, state?: CustodyState): SnugPlatform =>
  hostFixture({
    binding: 'local-host',
    brain: hostBrain('Claude · your CLI'),
    fetchImpl: seat,
    userdbBackend: { ...createMemoryBackend(), kind: 'file' as const },
    custody: custody(state),
    capabilities: { ...HOST_OFF_CAPABILITIES, connections: true, appExport: true, ...over },
  });

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  vi.resetModules();
});

interface Mounted {
  availability: typeof import('../platform/availability.js');
  platform: typeof import('../platform/platform.js');
  signals: typeof import('../platform/signals.js');
}

async function mount(platform?: SnugPlatform): Promise<Mounted> {
  vi.resetModules();
  const platformModule = await import('../platform/platform.js');
  if (platform !== undefined) platformModule.setPlatform(platform);
  const { HostPassport } = await import('../views/HostPassport.js');
  const node: ReactElement = <HostPassport />;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
  return {
    availability: await import('../platform/availability.js'),
    platform: platformModule,
    signals: await import('../platform/signals.js'),
  };
}

const chip = (): HTMLButtonElement | null => container?.querySelector<HTMLButtonElement>('[data-testid="host-passport"]') ?? null;
const menu = (): HTMLElement | null => container?.querySelector<HTMLElement>('[data-testid="host-passport-menu"]') ?? null;
const row = (key: string): HTMLElement => {
  const found = container?.querySelector<HTMLElement>(`[data-testid="host-passport-row-${key}"]`) ?? null;
  if (found === null) throw new Error(`no passport row "${key}"`);
  return found;
};
const click = (el: HTMLElement | null): void => {
  if (el === null) throw new Error('nothing to click');
  act(() => {
    el.click();
  });
};
/** key → can, in the order the popover lists them. */
const verdicts = (): Record<string, boolean> =>
  Object.fromEntries(
    [...(menu()?.querySelectorAll<HTMLElement>('[data-testid^="host-passport-row-"]') ?? [])].map((el) => [
      el.getAttribute('data-testid')!.replace('host-passport-row-', ''),
      el.getAttribute('data-can') === 'true',
    ]),
  );

describe('where it renders', () => {
  it('web (positive twin): nothing', async () => {
    await mount();
    expect(chip()).toBeNull();
  });

  it('desktop: nothing', async () => {
    await mount({ kind: 'desktop', capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true }, fetchImpl: seat });
    expect(chip()).toBeNull();
  });

  it('a host platform: the chip, closed, announcing that it opens something', async () => {
    await mount(artifact());
    expect(chip()).not.toBeNull();
    expect(chip()!.getAttribute('aria-haspopup')).toBe('true');
    expect(chip()!.getAttribute('aria-expanded')).toBe('false');
    expect(menu()).toBeNull();
  });

  it('is mounted on the header chip row, beside the brain and your-file chips', () => {
    const app = readFileSync(path.resolve(process.cwd(), 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/<BrainChip \/>[\s\S]*<YourFileChip \/>[\s\S]*<HostPassport \/>[\s\S]*<FeedbackMenu \/>/);
  });
});

describe('what it says — six rows, each a yes or a no with one plain sentence', () => {
  it('an artifact with no brain: it keeps your file, and that is all', async () => {
    await mount(artifact());
    click(chip());
    expect(chip()!.getAttribute('aria-expanded')).toBe('true');
    expect(verdicts()).toEqual({
      thinks: false,
      file: true,
      connections: false,
      'sign-in': false,
      'home-network': false,
      'phone-helper': false,
    });
    expect(menu()!.textContent).toContain('a Claude artifact');
    expect(row('thinks').textContent).toContain('the demo brain answers');
    expect(row('file').textContent).toContain('kept in this artifact');
    expect(row('connections').textContent).toContain('connections aren’t available in this host');
    expect(row('home-network').textContent).toContain('Snug for Mac');
    expect(row('phone-helper').textContent).toContain('Snug for Mac');
    // The chip's own name carries the count, so the compact (glyph-only) chip still says something.
    expect(chip()!.getAttribute('aria-label')).toBe('what this host can do: 1 of 6');
  });

  it('the local runner: your agent thinks, the file is on this Mac, connections and sign-in work; no home network, no helper', async () => {
    await mount(runner());
    click(chip());
    expect(verdicts()).toEqual({
      thinks: true,
      file: true,
      connections: true,
      'sign-in': true,
      'home-network': false,
      'phone-helper': false,
    });
    expect(menu()!.textContent).toContain('your agent, on this computer');
    expect(row('thinks').textContent).toContain('Claude · your CLI');
    expect(row('file').textContent).toContain('kept on this Mac');
    // The request leaves from the process — which is why Trade Copilot is enabled on this shelf.
    expect(row('connections').textContent).toContain('sent from this computer');
    expect(chip()!.getAttribute('aria-label')).toBe('what this host can do: 4 of 6');
  });

  it('the runner whose sign-in port was taken: connections yes, sign-in no — and it says why', async () => {
    await mount(runner({ oauthRedirect: false }));
    click(chip());
    expect(verdicts()['connections']).toBe(true);
    expect(verdicts()['sign-in']).toBe(false);
    expect(row('sign-in').textContent).toContain('already in use when Snug started');
  });

  it('a file that only lives in memory is a NO, with what to do about it', async () => {
    await mount(hostFixture({ binding: 'file', userdbBackend: createMemoryBackend(), custody: custody() }));
    click(chip());
    expect(verdicts()['file']).toBe(false);
    expect(row('file').textContent).toContain('in memory only');
    expect(row('file').textContent).toContain('export');
  });

  // "keeps your file" is a yes only when a durable copy exists AND this view may write it.
  // Each host below HAS a durable backend, so the backend alone would earn the tick and
  // "kept in this artifact" / "kept on this Mac"; one condition each takes it away. (The
  // round-2 verifier removed all three conditions and nothing went red, 2026-10-03.)
  it('a copy of the artifact page, served outside the viewer, is a NO — nothing saves there, whatever the bucket is', async () => {
    // The real composition also starts this binding read-only (apps/host compose.test.ts).
    // The fixture leaves custody clean so the BINDING is what is under test.
    await mount(hostFixture({ binding: 'artifact-static', userdbBackend: { ...createMemoryBackend(), kind: 'artifact-html' as const }, custody: custody() }));
    click(chip());
    expect(verdicts()['file']).toBe(false);
    expect(menu()!.textContent).toContain('a copy of an artifact page');
    expect(row('file').textContent).toContain('a copy of the artifact page — export to keep what you do');
    expect(row('file').textContent).not.toContain('kept');
    expect(chip()!.getAttribute('aria-label')).toBe('what this host can do: 0 of 6');
  });

  it('a read-only view is a NO — the durable copy exists, and this view may not write it', async () => {
    await mount(artifact({ dirty: false, readOnly: true }));
    click(chip());
    expect(verdicts()['file']).toBe(false);
    expect(row('file').textContent).toContain('read-only view — export to keep a copy');
    expect(row('file').textContent).not.toContain('kept');
  });

  it('a runner whose file another product holds is a NO, and it names who has it', async () => {
    await mount(runner({}, { dirty: false, readOnly: false, heldBy: 'Snug for Mac' }));
    click(chip());
    expect(verdicts()['file']).toBe(false);
    expect(row('file').textContent).toContain('Snug for Mac has your file open');
    expect(row('file').textContent).not.toContain('kept on this Mac');
    // Everything else the runner offers is unchanged: only the file row moved.
    expect(chip()!.getAttribute('aria-label')).toBe('what this host can do: 3 of 6');
  });

  it('every capability row IS the offer — the same table the shelf obeys', async () => {
    for (const platform of [artifact(), runner(), runner({ oauthRedirect: false })]) {
      const mounted = await mount(platform);
      click(chip());
      const offers = mounted.availability.offersOf(mounted.platform.getPlatform());
      expect(verdicts()).toMatchObject({
        connections: offers.network,
        'sign-in': offers.oauth,
        'home-network': offers.lan,
        'phone-helper': offers.helper,
      });
      act(() => root?.unmount());
      container?.remove();
    }
  });

  it('each row reads as a sentence to a screen reader: the mark is spoken as "yes" or "no"', async () => {
    await mount(artifact());
    click(chip());
    expect(row('file').querySelector('.visually-hidden')?.textContent).toBe('yes: ');
    expect(row('connections').querySelector('.visually-hidden')?.textContent).toBe('no: ');
    expect(row('connections').querySelector('[aria-hidden="true"]')?.textContent).toBe('✗');
    expect(row('file').querySelector('[aria-hidden="true"]')?.textContent).toBe('✓');
  });
});

describe('how it behaves', () => {
  it('the popover is a labelled GROUP — a label on a role-less element is never announced', async () => {
    // The chip says `aria-haspopup`, so a screen reader user opens it expecting to be told
    // what opened. `aria-label` on a plain <div> is dropped by assistive technology; the
    // role is what makes "what this host can do" the popover's spoken name.
    await mount(artifact());
    click(chip());
    expect(menu()!.getAttribute('role')).toBe('group');
    expect(menu()!.getAttribute('aria-label')).toBe('what this host can do');
  });

  it('Escape closes it and returns focus to the chip', async () => {
    await mount(artifact());
    click(chip());
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('follows the brain: a probe that answers after boot flips "thinks" without a reload', async () => {
    // The runner's brain is a live getter (the platform is set once and cannot be swapped),
    // and `brainRevision` is the signal that it would now answer differently.
    let brain: PlatformBrain = { kind: 'demo' };
    const platform = runner();
    Object.defineProperty(platform, 'brain', { get: () => brain });
    const mounted = await mount(platform);
    click(chip());
    expect(verdicts()['thinks']).toBe(false);
    brain = hostBrain('Claude · your CLI');
    act(() => mounted.signals.bumpBrainRevision());
    expect(verdicts()['thinks']).toBe(true);
  });
});
