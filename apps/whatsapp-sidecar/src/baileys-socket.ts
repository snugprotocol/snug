/**
 * THE REAL `WaSocket` — Baileys behind the seam (ADR-0032 §1).
 *
 * This is the ONLY file in the package that imports the library, which is the entire point of
 * the seam: the router and its refusals are proven against a scripted fake, and an upgrade
 * that reshapes Baileys' payloads is a change to this adapter alone. The 7.x line publishes
 * as release candidates and has reshaped event payloads between them, so that is not a
 * hypothetical.
 *
 * VERIFIED against the published `baileys@7.0.0-rc14` tarball (read, not remembered):
 *   makeWASocket(config) default export · WASocket = ReturnType<typeof makeWASocket>
 *   useMultiFileAuthState(folder) -> { state, saveCreds }
 *   connection.update: { connection?, lastDisconnect?, qr? }
 *   messaging-history.set: { chats, contacts, messages, isLatest?, progress?, syncType? }
 *   messaging-history.status: { syncType, status: 'complete'|'paused', explicit: boolean }
 *   messages.upsert: { messages, type } · sendMessage(jid, content, opts?) -> WAMessage|undefined
 *
 * WHY THE INGEST BUFFER EXISTS. History is PUSHED by WhatsApp in chunks; there is no pullable
 * paged endpoint to put behind a cursor. So this adapter subscribes on link, accumulates
 * thread-scoped messages into its own store, and the router pages over THAT. The honest
 * consequence rides with every page: `explicit: false` means completion was INFERRED from a
 * timeout rather than announced by the server, and an app that renders that as "this is
 * everything" is misdescribing the evidence its whole analysis rests on.
 *
 * THIS PROCESS HOLDS NO MODEL KEY AND MAKES NO MODEL CALL. Analysis, persona work,
 * translation and reply composition all happen in the governed host. A helper that composed
 * its own replies would be a second brain outside every surface the host reviews.
 */

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WASocket as BaileysSocket,
} from 'baileys';
import type { WaChat, WaHistoryState, WaLinkState, WaMessage, WaSocket } from './wa-socket.js';

/** How many messages to retain per thread. Analysis reads recent history, not all of it. */
const MAX_MESSAGES_PER_THREAD = 5_000;

/** Human-like send pacing (ADR-0032 §5): mitigation, never evasion. */
const MIN_SEND_GAP_MS = 1_200;

export interface BaileysSocketDeps {
  /** Folder for `useMultiFileAuthState` — THE store holding session keys, inside the helper. */
  authDir: string;
  /** Injectable for tests; defaults to real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Text of a message, across the shapes Baileys uses for it. */
function textOf(message: { message?: unknown }): string | undefined {
  const content = message.message as
    | {
        conversation?: string;
        extendedTextMessage?: { text?: string };
      }
    | null
    | undefined;
  if (content === null || content === undefined) return undefined;
  if (typeof content.conversation === 'string' && content.conversation.length > 0) {
    return content.conversation;
  }
  const extended = content.extendedTextMessage?.text;
  if (typeof extended === 'string' && extended.length > 0) return extended;
  // Media, reactions, protocol messages and everything else are deliberately NOT mapped:
  // v1 is text-only, and inventing a placeholder would put words in someone's mouth.
  return undefined;
}

/** Who sent it. For a group this is the participant; for a DM, the chat itself. */
function senderOf(message: {
  key?: { remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null };
}): string | undefined {
  const key = message.key;
  if (key === undefined || key === null) return undefined;
  const participant = key.participant;
  if (typeof participant === 'string' && participant.length > 0) return participant;
  const remote = key.remoteJid;
  return typeof remote === 'string' && remote.length > 0 ? remote : undefined;
}

function mentionsOf(message: { message?: unknown }): readonly string[] | undefined {
  const content = message.message as
    | { extendedTextMessage?: { contextInfo?: { mentionedJid?: unknown } } }
    | null
    | undefined;
  const mentioned = content?.extendedTextMessage?.contextInfo?.mentionedJid;
  if (!Array.isArray(mentioned)) return undefined;
  const jids = mentioned.filter((jid): jid is string => typeof jid === 'string');
  return jids.length > 0 ? jids : undefined;
}

/** Map a Baileys message onto the seam's shape, or undefined when it is not a text message. */
export function toWaMessage(raw: {
  key?: { id?: string | null; remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null };
  message?: unknown;
  messageTimestamp?: number | Long | null;
}): { chatJid: string; message: WaMessage } | undefined {
  const id = raw.key?.id;
  const chatJid = raw.key?.remoteJid;
  const text = textOf(raw);
  const from = senderOf(raw);
  if (typeof id !== 'string' || typeof chatJid !== 'string' || text === undefined || from === undefined) {
    return undefined;
  }
  const stamp = raw.messageTimestamp;
  const ts =
    typeof stamp === 'number'
      ? stamp
      : stamp !== null && stamp !== undefined && typeof (stamp as { toNumber?: () => number }).toNumber === 'function'
        ? (stamp as { toNumber: () => number }).toNumber()
        : 0;
  const mentions = mentionsOf(raw);
  return {
    chatJid,
    message: {
      id,
      from,
      text,
      ts,
      ...(raw.key?.fromMe === true ? { fromMe: true } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
    },
  };
}

/** Minimal structural stand-in for protobuf Long, avoiding a dependency on its types. */
interface Long {
  toNumber(): number;
}

export async function createBaileysWaSocket(deps: BaileysSocketDeps): Promise<WaSocket> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const { state, saveCreds } = await useMultiFileAuthState(deps.authDir);

  let link: WaLinkState = 'idle';
  let qr: string | undefined;
  let sock: BaileysSocket | undefined;
  let history: WaHistoryState = { complete: false, explicit: false, progress: 0 };
  let lastSendAt = 0;

  const chats = new Map<string, WaChat>();
  const messages = new Map<string, WaMessage[]>();

  const rememberChat = (jid: string, name?: string): void => {
    const existing = chats.get(jid);
    if (existing !== undefined) {
      if (name !== undefined && name.length > 0 && existing.name === jid) {
        chats.set(jid, { ...existing, name });
      }
      return;
    }
    chats.set(jid, { jid, name: name !== undefined && name.length > 0 ? name : jid, isGroup: jid.endsWith('@g.us') });
  };

  const ingest = (raw: Parameters<typeof toWaMessage>[0]): void => {
    const mapped = toWaMessage(raw);
    if (mapped === undefined) return;
    rememberChat(mapped.chatJid);
    const rows = messages.get(mapped.chatJid) ?? [];
    // De-duplicate on message id: history sync and live upserts overlap, and a duplicated
    // message would double-count its author in every per-person statistic downstream.
    if (rows.some((row) => row.id === mapped.message.id)) return;
    rows.push(mapped.message);
    rows.sort((a, b) => a.ts - b.ts);
    if (rows.length > MAX_MESSAGES_PER_THREAD) rows.splice(0, rows.length - MAX_MESSAGES_PER_THREAD);
    messages.set(mapped.chatJid, rows);
  };

  const connect = (): void => {
    const socket = makeWASocket({ auth: state, printQRInTerminal: false, syncFullHistory: true });
    sock = socket;

    socket.ev.on('creds.update', () => void saveCreds());

    socket.ev.on('connection.update', (update) => {
      if (typeof update.qr === 'string' && update.qr.length > 0) {
        qr = update.qr;
        link = 'waiting';
      }
      if (update.connection === 'open') {
        link = 'linked';
        qr = undefined;
      }
      if (update.connection === 'close') {
        const status = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          // The user unlinked from their phone. That is an instruction, not a fault: do not
          // reconnect, and do not keep claiming to be linked.
          link = 'closed';
          qr = undefined;
          return;
        }
        link = 'closed';
        // Any other close is a transport hiccup; the session keys are still valid.
        setTimeout(() => {
          if (link === 'closed') connect();
        }, 3_000).unref?.();
      }
    });

    socket.ev.on('messaging-history.set', (chunk) => {
      for (const chat of chunk.chats ?? []) {
        if (typeof chat.id === 'string') rememberChat(chat.id, chat.name ?? undefined);
      }
      for (const message of chunk.messages ?? []) ingest(message);
      const progress = chunk.progress;
      history = {
        ...history,
        progress: typeof progress === 'number' ? progress : history.progress,
      };
    });

    socket.ev.on('messaging-history.status', (status) => {
      // `explicit` is the honest bit and the reason this rides all the way to the UI: a
      // completion INFERRED from a timeout is not the same claim as one the server made.
      history = {
        complete: status.status === 'complete',
        explicit: status.explicit === true,
        progress: status.status === 'complete' ? 100 : history.progress,
      };
    });

    socket.ev.on('messages.upsert', (upsert) => {
      for (const message of upsert.messages ?? []) ingest(message);
    });
  };

  return {
    linkState: () => link,
    currentQr: () => (link === 'linked' ? undefined : qr),

    async startLink() {
      // Idempotent while one attempt is in flight — a second call must not open a rival
      // socket racing the first for the same session.
      if (sock !== undefined && (link === 'waiting' || link === 'linked')) return;
      link = 'waiting';
      connect();
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
      if (sock === undefined || link !== 'linked') throw new Error('not linked');
      // Pacing (ADR-0032 §5). Harm reduction against a real ban risk, never evasion — and it
      // is enforced here, at the only place that can actually enforce it.
      const gap = now() - lastSendAt;
      if (gap < MIN_SEND_GAP_MS) await sleep(MIN_SEND_GAP_MS - gap);
      lastSendAt = now();

      const sent = await sock.sendMessage(jid, { text });
      // `sendMessage` returns `WAMessage | undefined`. An undefined return is NOT a
      // successful send, and reporting one would tell the user their message went out when
      // nothing was delivered.
      const id = sent?.key?.id;
      if (typeof id !== 'string' || id.length === 0) throw new Error('the message was not accepted');
      return { id };
    },
  };
}
