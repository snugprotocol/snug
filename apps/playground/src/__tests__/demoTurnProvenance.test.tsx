// demoTurnProvenance — TASK-20260826-demo-brain-clarity AC5 (ADR-0059 rule 3).
//
// Scripted output carries its provenance ON THE ROW, not in the session that
// rendered it (lessons 2026-08-19: a phase starts fresh on every launch, a row does
// not). Three altitudes:
//
//   1. THE STAMP — `createDirectBuilder.send` reports the resolved brain kind via
//      `handlers.onBrain`, computed from the SAME config the adapter is constructed
//      from, and BEFORE the provider is called — a failed real-provider turn still
//      reports the real provider, and the keyless fall-through reports 'demo'.
//   2. THE ROW — a demo-brain build through useBuilderChat persists
//      `brainKind: 'demo'` in the assistant message meta, and a FRESH hook over the
//      same thread rehydrates it.
//   3. THE SURFACE — ChatLog tags exactly the agent messages whose row says demo;
//      real-provider and untagged rows render no tag.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterKind } from '../agent/adapter.js';
import { createAppTargetSink } from '../agent/artifactSink.js';
import { createDirectBuilder } from '../agent/builder.js';
import { useBuilderChat, type BuilderChat, type ChatMessage } from '../agent/useBuilderChat.js';
import { byokKeyPresenceStore, endpointsNeedConfirmStore, modeStore, providerStore } from '../state/mode.js';
import { ChatLog, DEMO_TURN_TAG } from '../views/ChatLog.js';
import { installTestUserDb } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function renderNode(node: ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<MemoryRouter>{node}</MemoryRouter>);
  });
}

function unmount(): void {
  if (root !== undefined) act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
}

beforeEach(() => {
  modeStore.set('byok');
  providerStore.set('mock');
  byokKeyPresenceStore.set({ anthropic: false, openai: false });
  endpointsNeedConfirmStore.set(false);
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('the stamp: createDirectBuilder reports the resolved brain (AC5)', () => {
  it('a demo-brain turn reports demo', async () => {
    const db = await installTestUserDb();
    const brains: AdapterKind[] = [];
    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'mock',
      sink: createAppTargetSink({ getDb: () => Promise.resolve(db) }),
      getKey: () => Promise.resolve(undefined),
    });
    const result = await builder.send(
      'build me tic-tac-toe',
      { onBrain: (kind) => brains.push(kind) },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(brains).toEqual(['demo']);
  });

  it('a keyed-provider turn reports the provider even when the wire fails', async () => {
    const db = await installTestUserDb();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    const brains: AdapterKind[] = [];
    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: createAppTargetSink({ getDb: () => Promise.resolve(db) }),
      getKey: () => Promise.resolve('sk-ant-test'),
    });
    const result = await builder.send(
      'build me anything',
      { onBrain: (kind) => brains.push(kind) },
      new AbortController().signal,
    );
    // The stamp precedes the provider call: provenance is a property of the ROUTE,
    // not of a successful response.
    expect(result.ok).toBe(false);
    expect(brains).toEqual(['anthropic']);
  });

  it('the keyless fall-through reports demo — the trap the chip and tag exist for', async () => {
    const db = await installTestUserDb();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    const brains: AdapterKind[] = [];
    const builder = createDirectBuilder({
      mode: 'byok',
      provider: 'anthropic',
      sink: createAppTargetSink({ getDb: () => Promise.resolve(db) }),
      getKey: () => Promise.resolve(undefined),
    });
    const result = await builder.send(
      'build me anything',
      { onBrain: (kind) => brains.push(kind) },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(brains).toEqual(['demo']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the row: brainKind persists and rehydrates (AC5)', () => {
  function renderChat(threadId: string): { chat: () => BuilderChat } {
    const holder: { current: BuilderChat | null } = { current: null };
    function Harness(): ReactElement {
      holder.current = useBuilderChat(threadId);
      return <span />;
    }
    renderNode(<Harness />);
    return {
      chat: () => {
        if (holder.current === null) throw new Error('hook not rendered');
        return holder.current;
      },
    };
  }

  async function settleUntil(condition: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 400 && !condition(); i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
    if (!condition()) throw new Error(`did not settle: ${label}`);
  }

  it('a demo build writes brainKind onto the assistant row; a fresh hook reads it back', async () => {
    const db = await installTestUserDb();
    const first = renderChat('thr-provenance');
    act(() => first.chat().send('build me tic-tac-toe'));
    await settleUntil(() => !first.chat().busy, 'turn finished');
    await settleUntil(
      () => db.listChatMessages('thr-provenance').some((m) => m.role === 'assistant'),
      'assistant row persisted',
    );
    const assistant = db.listChatMessages('thr-provenance').find((m) => m.role === 'assistant');
    expect(assistant?.meta).toMatchObject({ brainKind: 'demo' });
    // The live message carries it too — the tag must not wait for a reload.
    expect(first.chat().messages.at(-1)?.brainKind).toBe('demo');
    unmount();

    const second = renderChat('thr-provenance');
    await settleUntil(() => second.chat().messages.length > 0, 'thread rehydrated');
    expect(second.chat().messages.at(-1)?.brainKind).toBe('demo');
  });
});

describe('the surface: ChatLog tags exactly the demo rows (AC5)', () => {
  const msg = (overrides: Partial<ChatMessage> & { id: number }): ChatMessage => ({
    role: 'agent',
    displayText: 'here is your app',
    ...overrides,
  });

  it('renders the pinned tag on a demo agent message', () => {
    renderNode(<ChatLog messages={[msg({ id: 1, brainKind: 'demo' })]} />);
    const tag = document.querySelector('[data-testid="demo-turn-tag"]');
    expect(tag).not.toBeNull();
    expect(tag!.textContent).toContain(DEMO_TURN_TAG);
    expect(DEMO_TURN_TAG).toBe('scripted demo — not an AI response');
  });

  it('renders no tag on real-provider, untagged, or user messages', () => {
    renderNode(
      <ChatLog
        messages={[
          msg({ id: 1, brainKind: 'anthropic' }),
          msg({ id: 2 }),
          msg({ id: 3, role: 'user', brainKind: 'demo' }),
        ]}
      />,
    );
    expect(document.querySelector('[data-testid="demo-turn-tag"]')).toBeNull();
  });
});
