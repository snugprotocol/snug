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

import { act, type ReactElement } from 'react';
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

  // G5-19 (P3-6): RE-PINNED to the orchestrator's copy edit — the label names only the sources a fetch
  // asks (REFRESH_FIRST_MAX_SOURCES = 2, in order) and counts the rest as not asked; was
  // 'fetch new data from 3 apps first'. The title still names every source.
  it('three sources: *fetch new data from Ledger and Pantry first (+1 not asked)*, the names in `title` (G5-19 P3-6)', async () => {
    grant(ledger);
    grant(pantry);
    grant(notes);
    const el = await render();
    const button = toggle(el)!;
    // The two asked are the first two in the fetch's (grant) order — the file's order, not the install
    // order — so the pin names the shape: two of the three by name, then the third as not asked.
    const label = /^fetch new data from (\w+) and (\w+) first \(\+1 not asked\)$/.exec(button.textContent ?? '');
    expect(label, button.textContent ?? '').not.toBeNull();
    const asked = [label![1]!, label![2]!];
    const rest = ['Ledger', 'Pantry', 'Notes'].filter((name) => !asked.includes(name));
    expect(rest).toHaveLength(1);
    expect(button.textContent).toBe(CHAT_FETCH.first([...asked, ...rest]));
    expect(button.getAttribute('title')).toBe(CHAT_FETCH.firstNamed([...asked, ...rest]));
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
  // G5-19 (P3-6): RE-PINNED — three or more name the two asked and count the rest (was '… from 3 apps first').
  it('first(names): names ≤ 2 sources; three or more → the two asked by name, *(+N not asked)* (G5-19 P3-6)', () => {
    expect(CHAT_FETCH.first(['Ledger'])).toContain('Ledger');
    expect(CHAT_FETCH.first(['Ledger'])).toMatch(/new data/);
    const two = CHAT_FETCH.first(['Ledger', 'Pantry']);
    expect(two).toContain('Ledger');
    expect(two).toContain('Pantry');
    expect(CHAT_FETCH.first(['Ledger', 'Pantry', 'Notes'])).toBe('fetch new data from Ledger and Pantry first (+1 not asked)');
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

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-19 (P3-10) and G5-20 (P3-11) on the toggle.
//
// P3-10 the toggle re-reads at the nearest `expiresAt` of the rows it read (one timer, cleared on
//       cleanup): expiry is a clock event that bumps no revision, so a grant that ended while the
//       rail was open left the toggle naming a source the fetch would never ask.
// P3-11 RailChat's press → `onConsumed` → unpress, and its reset on a thread change, RENDERED (they
//       were pinned only structurally). RailChat is EXPORTED from `run/RunView.tsx` for this (this
//       lane's choice — the code lane adds the `export`); loaded through a variable specifier so its
//       absence reds these rows alone.
// =========================================================================================

describe('G5-19 (P3-10) the toggle re-reads when a grant it named expires', () => {
  it('G5-19 an access expiring while the rail is open: the toggle goes at its expiresAt — no revision moved', async () => {
    // It ends 400 ms from now.
    grant(ledger, { duration: { kind: 'until', at: new Date(Date.now() + 400).toISOString() } });
    const el = await render();
    expect(toggle(el), 'named while the access is live').not.toBeNull();
    for (let i = 0; i < 20 && toggle(el) !== null; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });
    }
    expect(toggle(el), 'gone once the access expired').toBeNull();
  });
});

interface RailChatTestProps {
  appId: string;
  threadId: string;
  messages: never[];
  steps: never[];
  activity: string | undefined;
  busy: boolean;
  onSend: (text: string, wireText?: string, options?: { fetchFirst?: boolean; onConsumed?: () => void }) => void;
  onStop: () => void;
}
const RUN_VIEW = '../run/RunView.js';
async function railChat(): Promise<(props: RailChatTestProps) => ReactElement> {
  const mod = (await import(/* @vite-ignore */ RUN_VIEW)) as { RailChat?: (props: RailChatTestProps) => ReactElement };
  if (typeof mod.RailChat !== 'function') throw new Error('run/RunView.tsx does not export RailChat');
  return mod.RailChat;
}

describe('G5-20 (P3-11) RailChat — press, consume, reset (rendered)', () => {
  type SendCall = [string, string | undefined, { fetchFirst?: boolean; onConsumed?: () => void } | undefined];
  let sent: SendCall[];

  async function renderRail(threadId: string): Promise<HTMLDivElement> {
    const RailChat = await railChat();
    if (container === undefined) {
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    }
    await act(async () => {
      root!.render(
        <RailChat appId={budget} threadId={threadId} messages={[]} steps={[]} activity={undefined} busy={false} onSend={(...args) => sent.push(args as SendCall)} onStop={() => undefined} />,
      );
    });
    await settle();
    return container;
  }

  async function typeAndSend(el: HTMLElement, text: string): Promise<void> {
    const box = el.querySelector<HTMLTextAreaElement>('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...el.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'send')!;
    await act(async () => send.click());
  }

  const pressed = (el: HTMLElement): string | null => toggle(el)?.getAttribute('aria-pressed') ?? null;

  beforeEach(() => {
    sent = [];
    grant(ledger);
  });

  it('G5-20 pressed, then a send that is NOT a data turn (onConsumed never called): it stays pressed', async () => {
    const el = await renderRail('t-1');
    await act(async () => toggle(el)!.click());
    expect(pressed(el)).toBe('true');
    await typeAndSend(el, 'make the header blue');
    expect(sent).toHaveLength(1);
    expect(sent[0]![2]?.fetchFirst).toBe(true);
    expect(pressed(el)).toBe('true');
  });

  it('G5-20 pressed, then a data turn consumes it (onConsumed): it unpresses', async () => {
    const el = await renderRail('t-1');
    await act(async () => toggle(el)!.click());
    await typeAndSend(el, 'what did I spend on food?');
    await act(async () => sent[0]![2]!.onConsumed!());
    expect(pressed(el)).toBe('false');
  });

  it('G5-20 an unpressed send carries no fetch option', async () => {
    const el = await renderRail('t-1');
    await typeAndSend(el, 'what did I spend?');
    expect(sent[0]![2]?.fetchFirst).toBeUndefined();
  });

  it('G5-20 a thread change resets it: pressed on t-1, the rail moves to t-2 → unpressed', async () => {
    const el = await renderRail('t-1');
    await act(async () => toggle(el)!.click());
    expect(pressed(el)).toBe('true');
    await renderRail('t-2');
    expect(pressed(el)).toBe('false');
  });
});
