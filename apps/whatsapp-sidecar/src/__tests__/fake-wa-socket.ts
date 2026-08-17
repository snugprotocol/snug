/**
 * A SCRIPTED WhatsApp socket — the seam's test double.
 *
 * It implements `WaSocket` and nothing else, so the router's refusals are proven without a
 * network, a phone, or a real account. Deliberately a hand-written fake rather than a mock
 * of the library: the point of the seam is that the router never sees library shapes, and a
 * fake that reproduced them would quietly undo that.
 */

import type { WaChat, WaHistoryState, WaLinkState, WaMessage, WaSocket } from '../wa-socket.js';

export interface FakeWaSocket extends WaSocket {
  emitQr(payload: string): void;
  emitLinked(): void;
  seedChat(jid: string, messages: WaMessage[], chat?: Partial<WaChat>): void;
  setHistoryState(state: WaHistoryState): void;
  sent(): ReadonlyArray<{ jid: string; text: string }>;
}

export function createFakeWaSocket(): FakeWaSocket {
  let state: WaLinkState = 'idle';
  let qr: string | undefined;
  let history: WaHistoryState = { complete: false, explicit: false, progress: 0 };
  const chats = new Map<string, WaChat>();
  const messages = new Map<string, WaMessage[]>();
  const outbox: Array<{ jid: string; text: string }> = [];
  let sendSeq = 0;

  return {
    linkState: () => state,
    currentQr: () => qr,
    async startLink() {
      if (state === 'idle' || state === 'closed') state = 'waiting';
    },
    listChats: () => [...chats.values()],
    history(jid) {
      const rows = messages.get(jid);
      if (rows === undefined) return undefined;
      return { messages: [...rows] };
    },
    messagesSince(jid, since) {
      const rows = messages.get(jid);
      if (rows === undefined) return undefined;
      return since === undefined ? [...rows] : rows.filter((row) => row.ts > since);
    },
    historyState: () => history,
    async sendText(jid, text) {
      outbox.push({ jid, text });
      sendSeq += 1;
      return { id: `sent-${sendSeq}` };
    },

    // ---- scripting handles ----
    emitQr(payload) {
      state = 'waiting';
      qr = payload;
    },
    emitLinked() {
      state = 'linked';
      qr = undefined;
    },
    seedChat(jid, rows, chat) {
      chats.set(jid, {
        jid,
        name: chat?.name ?? jid,
        isGroup: chat?.isGroup ?? jid.endsWith('@g.us'),
        ...(chat?.participants !== undefined ? { participants: chat.participants } : {}),
      });
      messages.set(jid, rows);
    },
    setHistoryState(next) {
      history = next;
    },
    sent: () => outbox,
  };
}
