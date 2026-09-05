// yourFileChip.test.tsx — TASK-20260905-binding-a-artifacts AC7/AC12: the "your file" chip
// renders only where the platform carries a custody seat (the host kit), says where the
// file lives from the ONE derivation, shows the state line, and offers exactly the acts the
// seat carries — the save act disappears on read-only, the divergence acts appear with a
// divergence, and web (the positive twin) renders nothing.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBackend } from '@snugprotocol/db';

import type { CustodySeat, CustodyState, SnugPlatform } from '../platform/platform.js';
import { createStore } from '../state/store.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.resetModules();
});

function seatWith(state: CustodyState, acts: Partial<CustodySeat> = {}): { seat: CustodySeat; store: ReturnType<typeof createStore<CustodyState>> } {
  const store = createStore<CustodyState>(state);
  return { seat: { state: store, ...acts }, store };
}

function hostPlatform(seat: CustodySeat | undefined, binding: SnugPlatform['binding'] = 'artifact', kind: 'opfs' | 'memory' = 'opfs'): SnugPlatform {
  const backend = kind === 'memory' ? createMemoryBackend() : { ...createMemoryBackend(), kind: 'artifact-html' as const };
  return {
    kind: 'host',
    binding,
    brain: { kind: 'demo' },
    userdbBackend: backend,
    ...(seat !== undefined ? { custody: seat } : {}),
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: false, hubAuth: false, brainSettings: false, account: false, sync: false, connections: false, share: false },
  };
}

async function mountChip(platform?: SnugPlatform): Promise<void> {
  vi.resetModules();
  const mod = await import('../platform/platform.js');
  if (platform !== undefined) mod.setPlatform(platform);
  const { YourFileChip } = await import('../views/YourFileChip.js');
  render(<YourFileChip />);
}

const chip = (): HTMLElement | null => document.querySelector('[data-testid="your-file-chip"]');
const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const click = (el: HTMLElement | null): void => {
  if (el === null) throw new Error('nothing to click');
  act(() => {
    el.click();
  });
};

describe('YourFileChip', () => {
  it('web (positive twin): renders nothing at all', async () => {
    await mountChip();
    expect(chip()).toBeNull();
  });

  it('host without a custody seat: renders nothing (the seat is the switch, never the platform kind)', async () => {
    await mountChip(hostPlatform(undefined));
    expect(chip()).toBeNull();
  });

  it('a hosted artifact, clean: the label, the body, no status line, the save act', async () => {
    const save = vi.fn(async () => ({ ok: true, message: 'saved' }));
    const { seat } = seatWith({ dirty: false, readOnly: false }, { save, canSave: () => true });
    await mountChip(hostPlatform(seat));
    expect(chip()?.textContent).toContain('your file: in this artifact');
    expect(chip()?.getAttribute('aria-label')).toBe('your file: in this artifact');
    click(chip());
    expect(q('your-file-menu')?.textContent).toContain('Anthropic-hosted');
    expect(q('your-file-status')).toBeNull();
    click(q('your-file-save'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('dirty: the dot and the aria-label say unsaved; the status line names the act', async () => {
    const { seat } = seatWith({ dirty: true, readOnly: false }, { save: async () => ({ ok: true, message: '' }) });
    await mountChip(hostPlatform(seat));
    expect(chip()?.className).toContain('your-file-chip-dirty');
    expect(chip()?.getAttribute('aria-label')).toContain('unsaved');
    click(chip());
    expect(q('your-file-status')?.textContent).toBe('unsaved changes — save to this artifact to keep them.');
  });

  it('read-only: no save act even though the seat has one; the status says export', async () => {
    const { seat } = seatWith({ dirty: true, readOnly: true }, { save: async () => ({ ok: true, message: '' }), canSave: () => false });
    await mountChip(hostPlatform(seat));
    click(chip());
    expect(q('your-file-save')).toBeNull();
    expect(q('your-file-status')?.textContent).toContain('read-only');
  });

  it('a divergence: the direction on the status line and the two acts; each act closes the menu', async () => {
    const loadPageCopy = vi.fn(async () => undefined);
    const keepBrowserCopy = vi.fn();
    const { seat, store } = seatWith({ dirty: false, readOnly: false, divergence: 'older' }, { loadPageCopy, keepBrowserCopy });
    await mountChip(hostPlatform(seat));
    click(chip());
    expect(q('your-file-status')?.textContent).toContain('page’s saved copy is newer');
    click(q('your-file-keep-browser'));
    expect(keepBrowserCopy).toHaveBeenCalledTimes(1);
    expect(q('your-file-menu')).toBeNull();
    // The chip follows the store without a reload.
    act(() => store.set({ dirty: true, readOnly: false }));
    click(chip());
    expect(q('your-file-load-page')).toBeNull();
    expect(q('your-file-status')?.textContent).toContain('unsaved');
  });

  it('a note renders with its dismiss when the seat can dismiss it', async () => {
    const dismissNote = vi.fn();
    const { seat } = seatWith({ dirty: false, readOnly: false, note: 'someone published this artifact first — your copy is safe in this browser; save again' }, { dismissNote });
    await mountChip(hostPlatform(seat));
    click(chip());
    expect(q('your-file-note')?.textContent).toContain('published this artifact first');
    click(q('your-file-dismiss'));
    expect(dismissNote).toHaveBeenCalledTimes(1);
  });

  it('the chat view and the static page carry their own labels', async () => {
    const { seat } = seatWith({ dirty: false, readOnly: false });
    await mountChip(hostPlatform(seat, 'artifact-chat'));
    expect(chip()?.textContent).toContain('your file: in this chat');
    act(() => root?.unmount());
    container?.remove();
    const { seat: seat2 } = seatWith({ dirty: false, readOnly: true });
    await mountChip(hostPlatform(seat2, 'artifact-static'));
    expect(chip()?.textContent).toContain('your file: not saved here');
  });
});
