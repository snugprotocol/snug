/**
 * TASK-20260815-inline-cards AC2/AC4/AC5 — the rendered card surfaces.
 *
 * Two components, one rule each:
 *  - the CHOICE card: tapping an option is the ONLY affordance, it fires exactly once,
 *    and a resolved card shows the pick instead of re-offering the decision;
 *  - the PROVIDER CONFIRM card: a chat-origin parked confirm renders here and ONLY here
 *    (the modal returns null for it — one surface per decision), and its facts come
 *    from the executor's own confirm payload.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import { installTestUserDb } from './userdbTestHelper.js';
import type { ChatCardState } from '../agent/cards.js';
import { buildProviderTools, PROVIDER_REQUEST_TOOL_NAME } from '../agent/providerTools.js';
import type { ChatMessage } from '../agent/useBuilderChat.js';
import { NetConfirmDialog } from '../run/NetConfirmDialog.js';
import { netConfirmStore, __resetNetStateForTests } from '../state/net.js';
import { getUserDb } from '../state/userdb.js';
import { ChatLog } from '../views/ChatLog.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const APP = 'app-chat-cards';
const HOST = 'api.cards.example';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(node: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<MemoryRouter>{node}</MemoryRouter>));
}

const cardMessage = (card: ChatCardState): ChatMessage => ({
  id: 7,
  role: 'agent',
  displayText: 'Which one?',
  card,
});

const PENDING: ChatCardState = {
  body: 'Which playlist should the set build from?',
  options: [
    { id: 'top', label: 'Top tracks' },
    { id: 'recent', label: 'Recent finds' },
  ],
  messageRowId: 42,
};

beforeEach(async () => {
  __resetNetStateForTests();
  await installTestUserDb();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  __resetNetStateForTests();
  vi.restoreAllMocks();
});

describe('AC2/AC4 — the inline choice card', () => {
  it('renders options; tapping one fires the handler with (card, messageId, optionId)', () => {
    const picks: Array<[ChatCardState, number, string]> = [];
    render(
      <ChatLog
        messages={[cardMessage(PENDING)]}
        onSelectCardOption={(card, messageId, optionId) => picks.push([card, messageId, optionId])}
      />,
    );
    const buttons = [...container!.querySelectorAll('[data-testid="chat-choice-card"] button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Top tracks', 'Recent finds']);
    act(() => (buttons[0] as HTMLButtonElement).click());
    expect(picks).toEqual([[PENDING, 7, 'top']]);
  });

  it('a RESOLVED card shows the pick and offers no buttons — the decision is single-shot', () => {
    const picks: unknown[] = [];
    render(
      <ChatLog
        messages={[
          cardMessage({ ...PENDING, resolution: { kind: 'selected', optionId: 'top', label: 'Top tracks' } }),
        ]}
        onSelectCardOption={(...args) => picks.push(args)}
      />,
    );
    const card = container!.querySelector('[data-testid="chat-choice-card"]');
    expect(card?.textContent).toContain('you chose: Top tracks');
    expect(card?.querySelectorAll('button')).toHaveLength(0);
    expect(picks).toHaveLength(0);
  });

  it('with no handler the options render disabled, never silently clickable', () => {
    render(<ChatLog messages={[cardMessage(PENDING)]} />);
    const buttons = [...container!.querySelectorAll('[data-testid="chat-choice-card"] button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe('AC5 — the provider write-confirm renders as a chat card, not the modal', () => {
  async function parkChatConfirm(): Promise<{ result: Promise<string>; fetches: string[] }> {
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Cards App', html: '<p>x</p>' });
    db.setSecret(authConnectionCredentialSecretKey(APP, 'c', 'api_key'), 'k-cards');
    db.putDeclaredConnection(
      APP,
      'c',
      {
        slot: 'c',
        kind: 'api_key' as const,
        provider: { name: 'Cards Service' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
        request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
        declaredApiHosts: [HOST],
      },
      'inference',
    );
    db.approveConnection(APP, 'c');
    const fetches: string[] = [];
    const tools = buildProviderTools({
      appId: APP,
      getDb: () => getUserDb(),
      allowWrites: true,
      fetchImpl: async (url) => {
        fetches.push(url);
        return new Response('ok', { status: 200 });
      },
    });
    const tool = tools.find((t) => t.def.name === PROVIDER_REQUEST_TOOL_NAME)!;
    const result = tool.run({ url: `https://${HOST}/v1/change`, method: 'POST', body: '{}' }) as Promise<string>;
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    return { result, fetches };
  }

  it('chat-origin: the ChatLog card renders host+method+URL from the confirm payload; the modal is silent', async () => {
    const { result } = await parkChatConfirm();
    render(
      <>
        <ChatLog messages={[]} />
        <NetConfirmDialog />
      </>,
    );
    const card = container!.querySelector('[data-testid="provider-confirm-card"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('POST');
    expect(card?.textContent).toContain(HOST);
    expect(card?.textContent).toContain(`https://${HOST}/v1/change`);
    // ONE surface per decision: the modal must not double-render a chat-origin confirm.
    expect(container!.textContent).not.toContain('this app wants to make a change');

    const deny = [...card!.querySelectorAll('button')].find((b) => b.textContent === 'deny')!;
    act(() => deny.click());
    await expect(result).resolves.toContain('NET_CONFIRM_DENIED');
  });

  it('approving from the card executes exactly one call', async () => {
    const { result, fetches } = await parkChatConfirm();
    render(<ChatLog messages={[]} />);
    const card = container!.querySelector('[data-testid="provider-confirm-card"]')!;
    const allow = [...card.querySelectorAll('button')].find((b) => b.textContent === 'allow')!;
    act(() => allow.click());
    await expect(result).resolves.toContain('<api_result>');
    expect(fetches).toHaveLength(1);
    expect(netConfirmStore.get()).toBeNull();
  });

  it('an APP-origin confirm keeps the modal and never the chat card', async () => {
    // Reuse the seeded app but drive the confirm through the untagged app-runtime path.
    const db = await getUserDb();
    db.installApp({ appId: APP, displayName: 'Cards App', html: '<p>x</p>' });
    db.setSecret(authConnectionCredentialSecretKey(APP, 'c', 'api_key'), 'k-cards');
    db.putDeclaredConnection(
      APP,
      'c',
      {
        slot: 'c',
        kind: 'api_key' as const,
        provider: { name: 'Cards Service' },
        fields: [{ key: 'api_key', label: 'API key', type: 'secret' as const }],
        request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
        declaredApiHosts: [HOST],
      },
      'inference',
    );
    db.approveConnection(APP, 'c');
    const { createNetHandlerFor, resolveNetConfirm } = await import('../state/net.js');
    const handler = createNetHandlerFor({ fetchImpl: async () => new Response('ok', { status: 200 }) });
    const write = handler.handle(APP, {
      v: 1,
      type: 'snug:net-request',
      requestId: 'r-modal-1',
      instanceId: 'ins-1',
      url: `https://${HOST}/v1/app-write`,
      method: 'POST',
      body: '{}',
    });
    await vi.waitFor(() => expect(netConfirmStore.get()).not.toBeNull());
    render(
      <>
        <ChatLog messages={[]} />
        <NetConfirmDialog />
      </>,
    );
    expect(container!.querySelector('[data-testid="provider-confirm-card"]')).toBeNull();
    expect(container!.textContent).toContain('this app wants to make a change');
    act(() => resolveNetConfirm({ granted: false }));
    await expect(write).resolves.toMatchObject({ ok: false, code: 'NET_CONFIRM_DENIED' });
  });
});
