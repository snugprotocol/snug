/**
 * THE THREAD STORE (ADR-0034, TASK-20260817-telepath) — the adapter's memory of chats and
 * messages, extracted pure so its rules are provable without Baileys, a network or a phone.
 *
 * IT OWNS THE UNREAD COUNTER (review F4). Baileys reports unread only as a snapshot field
 * on synced conversations — nothing in the library maintains a live count — so this store
 * seeds from the snapshot (`seedChatMeta`) and increments itself on live incoming rows.
 * Every rule here fails silently when wrong, which is why they live behind their own suite:
 * counting the user's own sends nags them about themselves; counting history replay invents
 * a thousand unread on first sync; counting a deduplicated row inflates forever.
 */

import type { WaChat, WaMessage } from './wa-socket.js';

/** How many messages to retain per thread. Analysis reads recent history, not all of it. */
export const MAX_MESSAGES_PER_THREAD = 5_000;

export interface ThreadStore {
  /** Learn a chat exists. A name upgrades a jid-placeholder; it never overwrites a real one. */
  rememberChat(jid: string, name?: string): void;
  /** Apply snapshot metadata (sync/`chats.update`): the PHONE's read state wins. */
  seedChatMeta(jid: string, meta: { name?: string; unreadCount?: number; isGroup?: boolean }): void;
  /**
   * Add one mapped row. `live` marks a `messages.upsert` arrival as opposed to history
   * replay — only live incoming rows move the unread counter. Returns whether the row was
   * NEW; a deduplicated row moves nothing.
   */
  ingest(chatJid: string, message: WaMessage, opts: { live: boolean }): { added: boolean };
  listChats(): WaChat[];
  history(jid: string): { messages: readonly WaMessage[] } | undefined;
  messagesSince(jid: string, since?: number): readonly WaMessage[] | undefined;
}

export function createThreadStore(maxPerThread: number = MAX_MESSAGES_PER_THREAD): ThreadStore {
  const chats = new Map<string, WaChat>();
  const messages = new Map<string, WaMessage[]>();

  const rememberChat = (jid: string, name?: string): void => {
    const existing = chats.get(jid);
    if (existing !== undefined) {
      // Upgrade a placeholder only: a chat named by its jid takes the first real name it
      // is offered, and a real name is never re-guessed afterwards.
      if (name !== undefined && name.length > 0 && existing.name === jid) {
        chats.set(jid, { ...existing, name });
      }
      return;
    }
    chats.set(jid, {
      jid,
      name: name !== undefined && name.length > 0 ? name : jid,
      isGroup: jid.endsWith('@g.us'),
    });
  };

  return {
    rememberChat,

    seedChatMeta(jid, meta) {
      rememberChat(jid, meta.name);
      const existing = chats.get(jid)!;
      chats.set(jid, {
        ...existing,
        ...(meta.isGroup !== undefined ? { isGroup: meta.isGroup } : {}),
        // The snapshot OVERWRITES the running count — "I read it on my phone" must clear
        // the badge here, or it never clears anywhere.
        ...(meta.unreadCount !== undefined ? { unreadCount: meta.unreadCount } : {}),
      });
    },

    ingest(chatJid, message, opts) {
      rememberChat(chatJid);
      const rows = messages.get(chatJid) ?? [];
      // De-duplicate on message id: history sync and live upserts overlap, and a duplicated
      // message would double-count its author in every per-person statistic downstream —
      // and double-move the unread counter here.
      if (rows.some((row) => row.id === message.id)) return { added: false };
      rows.push(message);
      rows.sort((a, b) => a.ts - b.ts);
      if (rows.length > maxPerThread) rows.splice(0, rows.length - maxPerThread);
      messages.set(chatJid, rows);

      const chat = chats.get(chatJid)!;
      const newestKnown = chat.lastActivityTs ?? -Infinity;
      chats.set(chatJid, {
        ...chat,
        ...(message.ts >= newestKnown
          ? {
              lastActivityTs: message.ts,
              lastMessage: {
                text: message.text,
                ts: message.ts,
                ...(message.fromMe === true ? { fromMe: true } : {}),
                ...(message.kind !== undefined ? { kind: message.kind } : {}),
              },
            }
          : {}),
        ...(opts.live && message.fromMe !== true ? { unreadCount: (chat.unreadCount ?? 0) + 1 } : {}),
      });
      return { added: true };
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
  };
}
