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

/** One row of WhatsApp's address book, reduced to the seats a name can come from. */
export interface WaContact {
  id: string;
  /** The LID form of this identity, when WhatsApp supplies it on the row itself. */
  lid?: string | undefined;
  /** The phone-number form, when WhatsApp supplies it on the row itself. */
  phoneNumber?: string | undefined;
  /** The name the USER saved in their own address book. */
  name?: string | undefined;
  /** The name the contact set for themselves. */
  notify?: string | undefined;
  /** A business's verified name. */
  verifiedName?: string | undefined;
}

/** WhatsApp's LID ↔ phone-number pairing. `lid` is an internal id, NOT a phone number. */
export interface WaLidMapping {
  lid: string;
  pn: string;
}

/** Group metadata, reduced to what a chat list and a thread header need. */
export interface WaGroupMetadata {
  subject?: string | undefined;
  participants?: ReadonlyArray<{ id: string }> | undefined;
}

export interface ThreadStore {
  /** Learn a chat exists. A name upgrades a jid-placeholder; it never overwrites a real one. */
  rememberChat(jid: string, name?: string): void;
  /**
   * Absorb address-book rows (`messaging-history.set`'s `contacts`, plus the
   * `contacts.upsert`/`contacts.update` events). Name preference is
   * saved-name → their own notify name → verifiedName; a row carrying NO name never
   * erases a name already known, because `contacts.update` legitimately sends partials.
   */
  rememberContacts(contacts: readonly WaContact[]): void;
  /** Absorb LID↔phone pairings so both spellings of one person resolve together. */
  rememberLidMappings(mappings: readonly WaLidMapping[]): void;
  /** The display name for an identity in EITHER spelling, or undefined if truly unknown. */
  contactName(identity: string): string | undefined;
  /** The canonical (phone-number) form of an identity when one is known. */
  resolveIdentity(identity: string): string;
  /** Record a group's subject and roster; participants gain names from the directory. */
  setGroupMetadata(jid: string, metadata: WaGroupMetadata): void;
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
  /** identity (either spelling) → display name. */
  const names = new Map<string, string>();
  /** lid → phone-number jid. The canonical direction: a LID is never a phone number. */
  const lidToPn = new Map<string, string>();
  /** Group rosters, kept raw so a later contact sync can re-name their participants. */
  const groupRosters = new Map<string, readonly string[]>();

  const nameFromContact = (contact: WaContact): string | undefined => {
    for (const candidate of [contact.name, contact.notify, contact.verifiedName]) {
      if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    }
    return undefined;
  };

  const resolveIdentity = (identity: string): string => lidToPn.get(identity) ?? identity;

  const contactName = (identity: string): string | undefined =>
    names.get(identity) ?? names.get(resolveIdentity(identity));

  /**
   * Re-derive a group's participant list from its raw roster plus whatever the directory
   * now knows. Called on every roster change AND every contact sync, because the two
   * arrive in either order — a roster that landed before the address book would otherwise
   * keep its members nameless forever.
   */
  const refreshParticipants = (jid: string): void => {
    const roster = groupRosters.get(jid);
    const chat = chats.get(jid);
    if (roster === undefined || chat === undefined) return;
    chats.set(jid, {
      ...chat,
      participants: roster.map((id) => {
        const name = contactName(id);
        // No name seat at all when unknown — never a fabricated one. The app renders what
        // it can and stays honest about the rest.
        return name !== undefined ? { jid: id, name } : { jid: id };
      }),
    });
  };

  /** A DM's chat name follows its contact; a group's follows its subject. */
  const refreshChatName = (jid: string): void => {
    const chat = chats.get(jid);
    if (chat === undefined || chat.isGroup) return;
    const name = contactName(jid);
    if (name !== undefined && name !== chat.name) chats.set(jid, { ...chat, name });
  };

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
    // A new chat takes the offered name, else whatever the address book already knows
    // about this identity, else its jid as an honest placeholder.
    const known = name !== undefined && name.length > 0 ? name : contactName(jid);
    chats.set(jid, {
      jid,
      name: known !== undefined && known.length > 0 ? known : jid,
      isGroup: jid.endsWith('@g.us'),
    });
  };

  return {
    rememberChat,

    rememberContacts(contacts) {
      let learned = false;
      for (const contact of contacts) {
        if (typeof contact?.id !== 'string' || contact.id.length === 0) continue;
        // Pair the row's own spellings before naming, so either reaches the same person.
        if (typeof contact.lid === 'string' && typeof contact.phoneNumber === 'string') {
          lidToPn.set(contact.lid, contact.phoneNumber);
        }
        const name = nameFromContact(contact);
        // A partial update (no name seat) must not erase what we already know: Baileys
        // sends `contacts.update` with only the changed fields.
        if (name === undefined) continue;
        learned = true;
        for (const spelling of [contact.id, contact.lid, contact.phoneNumber]) {
          if (typeof spelling === 'string' && spelling.length > 0) names.set(spelling, name);
        }
        const pn = lidToPn.get(contact.id);
        if (pn !== undefined) names.set(pn, name);
      }
      if (!learned) return;
      // Names can arrive after the chats and rosters they belong to.
      for (const jid of chats.keys()) refreshChatName(jid);
      for (const jid of groupRosters.keys()) refreshParticipants(jid);
    },

    rememberLidMappings(mappings) {
      for (const mapping of mappings) {
        if (typeof mapping?.lid !== 'string' || typeof mapping?.pn !== 'string') continue;
        lidToPn.set(mapping.lid, mapping.pn);
        // A name known under either spelling now covers both.
        const known = names.get(mapping.pn) ?? names.get(mapping.lid);
        if (known !== undefined) {
          names.set(mapping.pn, known);
          names.set(mapping.lid, known);
        }
      }
      for (const jid of chats.keys()) refreshChatName(jid);
      for (const jid of groupRosters.keys()) refreshParticipants(jid);
    },

    contactName,
    resolveIdentity,

    setGroupMetadata(jid, metadata) {
      rememberChat(jid, metadata.subject);
      const existing = chats.get(jid)!;
      // A group's subject is authoritative — unlike a DM name, WhatsApp owns it — so it
      // overwrites the jid placeholder AND any earlier subject.
      if (typeof metadata.subject === 'string' && metadata.subject.trim().length > 0) {
        chats.set(jid, { ...existing, name: metadata.subject.trim(), isGroup: true });
      }
      const roster = (metadata.participants ?? [])
        .map((participant) => participant?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      groupRosters.set(jid, roster);
      refreshParticipants(jid);
    },

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
