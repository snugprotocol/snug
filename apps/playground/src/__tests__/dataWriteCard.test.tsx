/**
 * TASK-20260811-lean-runtime-data-chat, P3 — the data-write approval card
 * (ADR-0019 D8, AC-F2-4).
 *
 * THE CARD IS THE GATE. Everything the user is agreeing to must be ON it: the verbatim
 * SQL, the plain-language summary, and the row counts. A card that says "apply changes?"
 * without showing what changes is consent theater — the doctrine is the LLM proposes and
 * the HUMAN approves, which only means something if the human can see what they approve.
 *
 * Follows the connection-card precedent in ChatLog: rendered from a message field that
 * exists only because the host STAGED a real proposal, so the card can never advertise a
 * change that was never previewed.
 */

import { readFileSync as readSource } from 'node:fs';
import nodePath from 'node:path';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';

import { ChatLog } from '../views/ChatLog.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';
import { literalsIn } from './literalsIn.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

const PROPOSAL = {
  appId: 'app-1',
  statements: ["UPDATE expenses SET cents = 999 WHERE label = 'coffee'"],
  params: [[]],
  summary: 'Set both coffees to £9.99',
  previewed: [2],
};

function render(messages: ChatMessage[], handlers: Parameters<typeof ChatLog>[0] extends never ? never : Record<string, unknown> = {}): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter>
        <ChatLog messages={messages} {...handlers} />
      </MemoryRouter>,
    );
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

const withProposal = (): ChatMessage[] => [
  { id: 1, role: 'user', displayText: 'set the coffees to 9.99' },
  { id: 2, role: 'agent', displayText: 'Here is what I would change.', dataWrite: PROPOSAL },
];

describe('the approval card shows everything the user is approving', () => {
  it('renders the summary, the verbatim SQL and the row count', () => {
    const el = render(withProposal());
    const card = el.querySelector('[data-testid="data-write-card"]');
    expect(card).not.toBeNull();
    const text = card?.textContent ?? '';
    expect(text).toContain('Set both coffees to £9.99');
    expect(text).toContain("UPDATE expenses SET cents = 999 WHERE label = 'coffee'");
    expect(text).toContain('2');
  });

  it('offers approve and decline', () => {
    const el = render(withProposal(), { onApproveDataWrite: vi.fn(), onDeclineDataWrite: vi.fn() });
    const labels = [...el.querySelectorAll('button')].map((button) => button.textContent?.toLowerCase() ?? '');
    expect(labels.some((label) => label.includes('apply'))).toBe(true);
    expect(labels.some((label) => label.includes('cancel') || label.includes('decline'))).toBe(true);
  });

  it('approve calls back with the proposal, decline does not', () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    const el = render(withProposal(), { onApproveDataWrite: onApprove, onDeclineDataWrite: onDecline });

    const approve = [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').toLowerCase().includes('apply'));
    act(() => approve?.click());

    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0]?.[0]).toMatchObject({ summary: PROPOSAL.summary });
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('decline calls back and never approves', () => {
    const onApprove = vi.fn();
    const onDecline = vi.fn();
    const el = render(withProposal(), { onApproveDataWrite: onApprove, onDeclineDataWrite: onDecline });

    const decline = [...el.querySelectorAll('button')].find((b) => {
      const label = (b.textContent ?? '').toLowerCase();
      return label.includes('cancel') || label.includes('decline');
    });
    act(() => decline?.click());

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('renders every statement of a multi-statement proposal', () => {
    const el = render([
      {
        id: 1,
        role: 'agent',
        displayText: '',
        dataWrite: {
          ...PROPOSAL,
          statements: ['INSERT INTO expenses (id, cents) VALUES (9, 1200)', 'UPDATE expenses SET cents = 1300 WHERE id = 9'],
          params: [[], []],
          previewed: [1, 1],
        },
      },
    ]);
    const text = el.querySelector('[data-testid="data-write-card"]')?.textContent ?? '';
    expect(text).toContain('INSERT INTO expenses');
    expect(text).toContain('UPDATE expenses SET cents = 1300');
  });

  it('shows a settled OUTCOME instead of buttons once resolved', () => {
    // After approve/decline the card must stop offering an action — an approved change
    // that still shows "apply" invites a second, unreviewed execution.
    const el = render([
      { id: 1, role: 'agent', displayText: '', dataWrite: { ...PROPOSAL, outcome: 'applied' as const } },
    ]);
    const card = el.querySelector('[data-testid="data-write-card"]');
    expect(card?.textContent ?? '').toMatch(/applied/i);
    expect(card?.querySelectorAll('button')).toHaveLength(0);
  });

  it('states the DRIFT halt in the user’s terms rather than silently re-rendering', () => {
    const el = render([
      { id: 1, role: 'agent', displayText: '', dataWrite: { ...PROPOSAL, outcome: 'drifted' as const } },
    ]);
    const text = el.querySelector('[data-testid="data-write-card"]')?.textContent ?? '';
    expect(text).toMatch(/chang|differ|again/i);
  });

  it('no card renders when the message carries no proposal', () => {
    const el = render([{ id: 1, role: 'agent', displayText: 'just a reply' }]);
    expect(el.querySelector('[data-testid="data-write-card"]')).toBeNull();
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 — the chat card's own-app undo and its words (D-PR4-19, D-PR4-12;
// D16, D19, D20; AC32b). An applied own-app card offers *undo* ONLY while its `undoId` is live in the
// approval bucket (checked on render, like the ⋈ sheet's `undoable` set) → the host's undo
// (`undoOwnWrite(…, { via: 'user' })`) → `outcome: 'undone'`; otherwise its line ends *· can no longer
// be undone*; an `undoable: false` apply reads *applied — 2 rows changed · this one can’t be undone*;
// counts use `rowsWord`, never *row(s)*. The armed confirm is the result page's: role="group" named
// by its question (`OWN_UNDO.arm`), focus to *keep* when it arms and to the outcome line when
// answered. The card's words have ONE home, `agent/copy.dataWrite.ts` (`DATA_WRITE_CARD`).
//
// Assumed (lane T-C questions): ChatLog takes the live set as `dataWriteUndoable` and the act as
// `onUndoDataWrite(card, messageId) → Promise<UndoOutcome>`; the card carries `undoId` and
// `undoable: false` from the outcome; the card shows the answer line itself (the ⋈ sheet's pattern).
// The new module is reached through a NON-literal dynamic import inside the tests that need it, so
// this file's existing tests never fail at import while it is absent.
// =============================================================================================

const UNDO_ID = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const COPY_MODULE = ['..', 'agent', 'copy.dataWrite.js'].join('/');

const applied = (over: Record<string, unknown> = {}): ChatMessage[] => [
  { id: 2, role: 'agent', displayText: '', dataWrite: { ...PROPOSAL, outcome: 'applied' as const, executed: [2], undoId: UNDO_ID, ...over } as never },
];

const cardText = (el: HTMLElement): string => el.querySelector('[data-testid="data-write-card"]')?.textContent ?? '';
const undoButton = (el: HTMLElement): HTMLButtonElement | undefined => [...el.querySelectorAll<HTMLButtonElement>('[data-testid="data-write-card"] button')].find((b) => b.textContent === 'undo');

describe('PR-4 — the card’s own-app undo (D-PR4-19)', () => {
  it('offered while the undoId is live: the applied line in rowsWord’s words, and *undo*', () => {
    const el = render(applied(), { dataWriteUndoable: new Set([UNDO_ID]), onUndoDataWrite: vi.fn(async () => ({ ok: true })) });
    expect(cardText(el)).toContain('applied — 2 rows changed');
    expect(undoButton(el)).toBeDefined();
  });

  it('NEGATIVE: no longer live (undone elsewhere, aged out) — the line ends *· can no longer be undone* and offers nothing', () => {
    const el = render(applied(), { dataWriteUndoable: new Set<string>(), onUndoDataWrite: vi.fn(async () => ({ ok: true })) });
    expect(cardText(el)).toContain('applied — 2 rows changed · can no longer be undone');
    expect(undoButton(el)).toBeUndefined();
  });

  it('an apply that could not be captured says so: *applied — 2 rows changed · this one can’t be undone*', () => {
    const el = render(applied({ undoId: undefined, undoable: false }), { dataWriteUndoable: new Set([UNDO_ID]), onUndoDataWrite: vi.fn(async () => ({ ok: true })) });
    expect(cardText(el)).toContain('applied — 2 rows changed · this one can’t be undone');
    expect(undoButton(el)).toBeUndefined();
  });

  it('counts use rowsWord — one row is *1 row*, and *row(s)* is never printed (the preview line included)', () => {
    const el = render(
      [{ id: 2, role: 'agent', displayText: '', dataWrite: { ...PROPOSAL, previewed: [1], outcome: 'applied' as const, executed: [1], undoId: UNDO_ID } as never }],
      { dataWriteUndoable: new Set([UNDO_ID]), onUndoDataWrite: vi.fn(async () => ({ ok: true })) },
    );
    expect(cardText(el)).toContain('applied — 1 row changed');
    expect(cardText(el)).not.toContain('row(s)');
    const staged = render(withProposal());
    expect(cardText(staged)).not.toContain('row(s)');
    expect(cardText(staged)).toContain('2 rows');
  });

  it('the armed confirm: role="group" named by its question, focus on *keep*; *yes, undo* calls the host once and the answer line takes the focus', async () => {
    const onUndo = vi.fn(async () => ({ ok: true as const }));
    const el = render(applied(), { dataWriteUndoable: new Set([UNDO_ID]), onUndoDataWrite: onUndo });
    await act(async () => {
      undoButton(el)?.click();
    });
    const confirm = el.querySelector<HTMLElement>('[data-testid="data-write-card"] [role="group"]');
    expect(confirm).not.toBeNull();
    const question = confirm?.getAttribute('aria-label') ?? '';
    expect(question).toMatch(/^put 2 rows in .+ back as they were before this change\? \(if they changed since, nothing happens\)$/);
    expect(confirm?.textContent).toContain(question);
    expect(document.activeElement?.textContent).toBe('keep');
    await act(async () => {
      [...(confirm?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'yes, undo')?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect((onUndo.mock.calls[0] as unknown[])[0]).toMatchObject({ undoId: UNDO_ID });
    expect((onUndo.mock.calls[0] as unknown[])[1]).toBe(2);
    expect(document.activeElement?.textContent ?? '').toContain('undone');
  });

  it('*keep* backs out without calling the host', async () => {
    const onUndo = vi.fn(async () => ({ ok: true as const }));
    const el = render(applied(), { dataWriteUndoable: new Set([UNDO_ID]), onUndoDataWrite: onUndo });
    await act(async () => {
      undoButton(el)?.click();
    });
    await act(async () => {
      [...el.querySelectorAll<HTMLButtonElement>('[role="group"] button')].find((b) => b.textContent === 'keep')?.click();
    });
    expect(onUndo).not.toHaveBeenCalled();
    expect(el.querySelector('[data-testid="data-write-card"] [role="group"]')).toBeNull();
    expect(undoButton(el)).toBeDefined();
  });

  it('an undone card reads *undone* and offers nothing more', () => {
    const el = render(applied({ outcome: 'undone' }), { dataWriteUndoable: new Set<string>(), onUndoDataWrite: vi.fn(async () => ({ ok: true })) });
    expect(cardText(el)).toContain('undone');
    expect(el.querySelectorAll('[data-testid="data-write-card"] button')).toHaveLength(0);
  });

  it('NEGATIVE: without the host’s undo act the card is read-only — no undo, whatever the live set says', () => {
    const el = render(applied(), { dataWriteUndoable: new Set([UNDO_ID]) });
    expect(undoButton(el)).toBeUndefined();
  });
});

describe('PR-4 — the card’s words have ONE home, agent/copy.dataWrite.ts (D-PR4-19; D16)', () => {
  it('DATA_WRITE_CARD holds the card’s sentences — the old JSX literals moved there', async () => {
    const mod = (await import(/* @vite-ignore */ COPY_MODULE)) as { DATA_WRITE_CARD?: Record<string, unknown> };
    expect(mod.DATA_WRITE_CARD).toBeDefined();
    const strings = Object.values(mod.DATA_WRITE_CARD ?? {}).filter((value): value is string => typeof value === 'string');
    expect(strings).toContain('apply to my data');
    expect(strings).toContain('cancelled — nothing was changed');
  });

  it('views/ChatLog.tsx no longer spells the card’s words — no "apply to my data", no "row(s)", no "nothing was changed"', () => {
    const source = readSource(nodePath.resolve(__dirname, '..', 'views', 'ChatLog.tsx'), 'utf8');
    const words = literalsIn(source).map((literal) => literal.words);
    expect(words.filter((text) => /apply to my data|row\(s\)|nothing was changed|could not be applied/.test(text))).toEqual([]);
  });
});
