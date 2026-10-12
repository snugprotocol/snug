// railChatFetch.test.tsx — TASK-20261010-host-broker PR-5 (AC39b; contract v2 D-PR5-20; D10, F9).
// RED-FIRST: `run/ChatFetchToggle.tsx` does not exist yet, nor `CHAT_FETCH` in `access/copy.ts`.
//
// THE CHAT'S *fetch new data first*. A `<button aria-pressed>` in RailChat's composer row, before
// *send*: `ChatFetchToggle` (exported; props `{appId, pressed, onPress}` plus `disabled` — v2.1
// question T-D Q11), with its own data hook, re-read on the access revision AND on brain changes. It
// shows ONLY when the chat door is open for the app (`appMayUseAccess` ∧ `chatDoorOpen(chatBrainRoute
// (db, app))` — a keyed BYOK or a local brain; never webllm, demo, subscription or host) and ≥ 1
// live grant OWNED by the chat caller carries `refresh`. Its label `CHAT_FETCH.first(names)` names ≤ 2
// sources, else *fetch new data from 3 apps first* with the names in `title`. Disabled while busy.
// (Its reset on a thread or app change is RailChat's state — pinned only structurally here; the
// send option it feeds is pinned in useBuilderChatLanes.test.tsx.)
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { accessGrantSchema, type AccessGrant } from '@snugprotocol/protocol';

import { CHAT_FETCH } from '../access/copy.js';
import { __setAccessDepsForTests, resetAccessSession, revokeAccess } from '../access/grants.js';
import { ChatFetchToggle } from '../run/ChatFetchToggle.js';
import { modeStore, providerStore } from '../state/mode.js';
import { webgpuStore, webllmFlagStore } from '../state/webllm.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let db: UserDb;
let budget: string;
let ledger: string;
let pantry: string;
let notes: string;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

function grant(sourceAppId: string, over: Record<string, unknown> = {}): AccessGrant {
  const at = new Date().toISOString();
  const { refresh = true, ...rest } = over as { refresh?: boolean } & Record<string, unknown>;
  const row = accessGrantSchema.parse({
    id: crypto.randomUUID(),
    readerAppId: budget,
    sourceAppId,
    scope: { tables: [{ name: 'transactions', columns: ['id', 'amount'] }] },
    access: 'read',
    purpose: 'to show spending',
    duration: { kind: 'always' },
    unattended: false,
    status: 'active',
    provenance: 'app',
    readerVersion: 1,
    grantedAt: at,
    updatedAt: at,
    reads: 0,
    timeouts: 0,
    ...(refresh ? { refresh: true } : {}),
    ...rest,
  });
  db.putAccessGrant(row);
  return row;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

async function render(props: { pressed?: boolean; onPress?: () => void; disabled?: boolean; appId?: string } = {}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const extra = (props.disabled !== undefined ? { disabled: props.disabled } : {}) as Record<string, unknown>;
  await act(async () => {
    root!.render(<ChatFetchToggle appId={props.appId ?? budget} pressed={props.pressed ?? false} onPress={props.onPress ?? (() => undefined)} {...extra} />);
  });
  await settle();
  return container;
}

const toggle = (el: HTMLElement): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>('button[aria-pressed]');

beforeEach(async () => {
  modeStore.set('local');
  providerStore.set('mock');
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  db = await installTestUserDb();
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db), now: () => Date.now() });
  budget = db.installApp({ displayName: 'Budget', html: '<html>budget</html>', usesDb: true }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<html>ledger</html>' }).appId;
  pantry = db.installApp({ displayName: 'Pantry', html: '<html>pantry</html>' }).appId;
  notes = db.installApp({ displayName: 'Notes', html: '<html>notes</html>' }).appId;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  container?.remove();
  container = undefined;
  modeStore.set('byok');
  providerStore.set('mock');
  webllmFlagStore.set(false);
  webgpuStore.set('unknown');
  resetAccessSession();
  __setAccessDepsForTests();
});

describe('D-PR5-20 the toggle — shown, its state, its act', () => {
  it('a local brain and one owned live grant with `refresh` → ONE aria-pressed button naming the source; pressed=false reads "false"', async () => {
    grant(ledger);
    const el = await render();
    const button = toggle(el);
    expect(button).not.toBeNull();
    expect(button!.getAttribute('aria-pressed')).toBe('false');
    expect(button!.textContent).toBe(CHAT_FETCH.first(['Ledger']));
    expect(button!.textContent).toContain('Ledger');
    expect(el.querySelectorAll('button')).toHaveLength(1);
  });

  it('pressed=true reads aria-pressed "true"; a click calls onPress once', async () => {
    grant(ledger);
    const onPress = vi.fn();
    const el = await render({ pressed: true, onPress });
    expect(toggle(el)!.getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      toggle(el)!.click();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('two sources are both named', async () => {
    grant(ledger);
    grant(pantry);
    const el = await render();
    const text = toggle(el)!.textContent ?? '';
    expect(text).toContain('Ledger');
    expect(text).toContain('Pantry');
  });

  it('three sources: *fetch new data from 3 apps first*, the names in `title`', async () => {
    grant(ledger);
    grant(pantry);
    grant(notes);
    const el = await render();
    const button = toggle(el)!;
    expect(button.textContent).toBe('fetch new data from 3 apps first');
    for (const name of ['Ledger', 'Pantry', 'Notes']) expect(button.getAttribute('title')).toContain(name);
  });

  it('two grants on one source name it once', async () => {
    grant(ledger);
    grant(ledger, { scope: { tables: [{ name: 'accounts', columns: ['id'] }] } });
    const el = await render();
    expect(toggle(el)!.textContent).toBe(CHAT_FETCH.first(['Ledger']));
  });

  it('disabled while busy', async () => {
    grant(ledger);
    const el = await render({ disabled: true });
    expect(toggle(el)!.disabled).toBe(true);
  });
});

describe('D-PR5-20 NEGATIVE — hidden unless the door is open AND a grant lets the chat ask for new data', () => {
  it('no grant at all → nothing', async () => {
    const el = await render();
    expect(el.innerHTML).toBe('');
  });

  it('a grant WITHOUT `refresh` → nothing', async () => {
    grant(ledger, { refresh: false });
    const el = await render();
    expect(toggle(el)).toBeNull();
  });

  it('a stopped grant → nothing', async () => {
    grant(ledger, { status: 'revoked', revokedAt: new Date().toISOString() });
    const el = await render();
    expect(toggle(el)).toBeNull();
  });

  it('another reader’s grant → nothing for this app', async () => {
    grant(ledger, { readerAppId: notes });
    const el = await render();
    expect(toggle(el)).toBeNull();
  });

  for (const [label, arrange] of [
    ['the demo brain (BYOK with no key)', () => modeStore.set('byok')],
    ['the subscription brain', () => modeStore.set('subscription')],
    [
      'the in-browser (webllm) brain',
      () => {
        webllmFlagStore.set(true);
        webgpuStore.set('yes');
      },
    ],
  ] as const) {
    it(`${label} → nothing (the data lane does not run there)`, async () => {
      grant(ledger);
      arrange();
      const el = await render();
      expect(toggle(el)).toBeNull();
    });
  }
});

describe('D-PR5-20 its data hook re-reads on the access revision and on brain changes', () => {
  it('the grant stopped while shown → the toggle goes', async () => {
    const g = grant(ledger);
    const el = await render();
    expect(toggle(el)).not.toBeNull();
    await act(async () => {
      await revokeAccess(g.id);
    });
    await settle();
    expect(toggle(el)).toBeNull();
  });

  it('the brain changes to one with a data lane → the toggle appears', async () => {
    grant(ledger);
    modeStore.set('subscription');
    const el = await render();
    expect(toggle(el)).toBeNull();
    await act(async () => {
      modeStore.set('local');
    });
    await settle();
    expect(toggle(el)).not.toBeNull();
  });
});

describe('D-PR5-20 the words — `access/copy.ts` CHAT_FETCH (straight apostrophes; *new data*, never *look up*)', () => {
  it('first(names): names ≤ 2 sources; three or more → *fetch new data from 3 apps first*', () => {
    expect(CHAT_FETCH.first(['Ledger'])).toContain('Ledger');
    expect(CHAT_FETCH.first(['Ledger'])).toMatch(/new data/);
    const two = CHAT_FETCH.first(['Ledger', 'Pantry']);
    expect(two).toContain('Ledger');
    expect(two).toContain('Pantry');
    expect(CHAT_FETCH.first(['Ledger', 'Pantry', 'Notes'])).toBe('fetch new data from 3 apps first');
    for (const words of [CHAT_FETCH.first(['Ledger']), two]) {
      expect(words).not.toMatch(/look(ed|ing)?[\s-]?up/i);
      expect(words).not.toContain('’');
    }
  });
});

describe('D-PR5-20 the mount — RailChat’s composer row, before *send* (structural)', () => {
  it('RunView imports ChatFetchToggle and renders it inside RailChat before the send act', () => {
    const source = readFileSync(path.resolve(__dirname, '../run/RunView.tsx'), 'utf8');
    expect(source).toMatch(/import\s*\{[^}]*\bChatFetchToggle\b[^}]*\}\s*from\s*'\.\/ChatFetchToggle\.js'/);
    const rail = source.slice(source.indexOf('function RailChat('));
    expect(rail.indexOf('<ChatFetchToggle'), 'mounted in RailChat').toBeGreaterThan(0);
    expect(rail.indexOf('<ChatFetchToggle')).toBeLessThan(rail.indexOf('onClick={submit}'));
  });
});
