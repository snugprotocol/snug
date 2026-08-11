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

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { ChatLog } from '../views/ChatLog.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';

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
