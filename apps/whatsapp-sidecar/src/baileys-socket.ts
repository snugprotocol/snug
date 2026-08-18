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

import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  useMultiFileAuthState,
  type WASocket as BaileysSocket,
} from 'baileys';
import { createEventBuffer } from './event-buffer.js';
import { createThreadStore } from './thread-store.js';
import type { WaHistoryState, WaLinkState, WaMediaResult, WaMessage, WaSocket } from './wa-socket.js';

/** Human-like send pacing (ADR-0032 §5): mitigation, never evasion. */
const MIN_SEND_GAP_MS = 1_200;

/**
 * Raw image bytes above this are REFUSED with `{tooLarge: true}` (ADR-0034 §1): the Rust
 * transport caps a response at 1 MiB while reading, and base64 + JSON framing costs ~37%,
 * so 700 000 raw bytes is the honest ceiling under it. Refuse, never truncate — a truncated
 * image is a corrupt file wearing a 200.
 */
export const MAX_MEDIA_BYTES = 700_000;

/** How many raw image messages to retain for `mediaOf` downloads. Bounded like everything. */
const MAX_RAW_IMAGES = 1_000;

/** Hint ring size behind `GET /events`. A consumer that falls further behind gets resync. */
const EVENT_BUFFER_SIZE = 512;

/**
 * May `startLink` clear the credential store first?
 *
 * Only when we are NOT linked. `POST /pair/start` means "I want to link a device", and if
 * there is no live session then whatever sits on disk is not a working one — it is at best a
 * dead session and at worst the half-linked wedge described in `session-reset.test.ts`, where
 * `me` is present (the scan happened) and `registered` is false (it never finished). Baileys
 * loads that, tries to RESUME rather than pair, and WhatsApp answers "Connection Failure" —
 * no QR and no session, permanently, because nothing ever cleared the directory.
 *
 * While LINKED this must stay false: reopening the wizard on a working connection would
 * otherwise unlink the user's phone.
 */
export function shouldResetAuthStore(link: WaLinkState): boolean {
  return link !== 'linked';
}

/**
 * Delete every credential file, keeping the directory.
 *
 * NEVER THROWS: failing to clean up must not be worse than not trying — an exception here
 * would take down `startLink` and leave the user in exactly the wedge this clears.
 */
export function resetAuthStore(authDir: string): void {
  try {
    for (const entry of readdirSync(authDir)) {
      rmSync(join(authDir, entry), { recursive: true, force: true });
    }
  } catch {
    // Missing directory (first run) or an unreadable one. Both are survivable: a fresh
    // `useMultiFileAuthState` will create what it needs.
  }
}

export interface BaileysSocketDeps {
  /** Folder for `useMultiFileAuthState` — THE store holding session keys, inside the helper. */
  authDir: string;
  /** Injectable for tests; defaults to real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface MessageContent {
  conversation?: string;
  extendedTextMessage?: { text?: string; contextInfo?: { mentionedJid?: unknown } };
  imageMessage?: {
    caption?: string | null;
    mimetype?: string | null;
    jpegThumbnail?: Uint8Array | string | null;
    fileLength?: number | Long | null;
  };
}

/** Text of a message, across the shapes Baileys uses for it. */
function textOf(message: { message?: unknown }): string | undefined {
  const content = message.message as MessageContent | null | undefined;
  if (content === null || content === undefined) return undefined;
  if (typeof content.conversation === 'string' && content.conversation.length > 0) {
    return content.conversation;
  }
  const extended = content.extendedTextMessage?.text;
  if (typeof extended === 'string' && extended.length > 0) return extended;
  // Audio, video, stickers, reactions, protocol messages and everything else are
  // deliberately NOT mapped — inventing a placeholder would put words in someone's mouth.
  // Images are the one exception, mapped as a TYPED row (never as text) below.
  return undefined;
}

/** The thumbnail as base64, whichever way Baileys serialized the bytes. */
function thumbnailOf(image: NonNullable<MessageContent['imageMessage']>): string | undefined {
  const raw = image.jpegThumbnail;
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined;
  return raw.length > 0 ? Buffer.from(raw).toString('base64') : undefined;
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
  const from = senderOf(raw);
  const image = (raw.message as MessageContent | null | undefined)?.imageMessage;
  const text = image !== undefined && image !== null ? (typeof image.caption === 'string' ? image.caption : '') : textOf(raw);
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
  const thumbnail = image !== undefined && image !== null ? thumbnailOf(image) : undefined;
  return {
    chatJid,
    message: {
      id,
      from,
      text,
      ts,
      ...(raw.key?.fromMe === true ? { fromMe: true } : {}),
      ...(mentions !== undefined ? { mentions } : {}),
      // An image is a TYPED row (ADR-0034): its caption is its text — possibly empty, and
      // an empty caption is honest where an invented "<image>" would not be. The media id
      // IS the message id; `GET /chats/:jid/media/:id` dereferences it.
      ...(image !== undefined && image !== null ? { kind: 'image' as const, mediaId: id } : {}),
      ...(thumbnail !== undefined ? { thumbnailBase64: thumbnail } : {}),
    },
  };
}

/** Minimal structural stand-in for protobuf Long, avoiding a dependency on its types. */
interface Long {
  toNumber(): number;
}

/** The minimal logger shape `downloadMediaMessage`'s context wants. Silent by design. */
interface MediaLogger {
  level: string;
  child(obj: Record<string, unknown>): MediaLogger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const silentLogger: MediaLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export async function createBaileysWaSocket(deps: BaileysSocketDeps): Promise<WaSocket> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let { state, saveCreds } = await useMultiFileAuthState(deps.authDir);

  let link: WaLinkState = 'idle';
  let qr: string | undefined;
  let sock: BaileysSocket | undefined;
  let history: WaHistoryState = { complete: false, explicit: false, progress: 0 };
  let lastSendAt = 0;

  const store = createThreadStore();
  const events = createEventBuffer(EVENT_BUFFER_SIZE);

  /**
   * Raw Baileys image messages, retained so `mediaOf` can hand them to
   * `downloadMediaMessage` later — the download needs the full protobuf row, not the seam's
   * reduced one. Bounded LRU-ish: a Map keeps insertion order, and the oldest entry is
   * evicted past the cap. An evicted raw means that image is no longer fetchable at full
   * size — the thumbnail the seam row carries is the graceful floor.
   */
  const rawImages = new Map<string, Parameters<typeof toWaMessage>[0]>();

  /** Avatar cache: url-fetch results per jid, `null` caching "has none" honestly. */
  const pictures = new Map<string, { mime: string; base64: string } | null>();

  const ingest = (raw: Parameters<typeof toWaMessage>[0], live: boolean): void => {
    const mapped = toWaMessage(raw);
    if (mapped === undefined) return;
    const { added } = store.ingest(mapped.chatJid, mapped.message, { live });
    if (!added) return;
    if (mapped.message.kind === 'image') {
      rawImages.set(`${mapped.chatJid} ${mapped.message.id}`, raw);
      if (rawImages.size > MAX_RAW_IMAGES) {
        const oldest = rawImages.keys().next().value;
        if (oldest !== undefined) rawImages.delete(oldest);
      }
    }
    // The doorbell — LIVE arrivals only. History replay is not news; a consumer paging
    // history through a thousand hints would refetch its lists a thousand times.
    if (live) events.push({ jid: mapped.chatJid, kind: 'message', ts: mapped.message.ts });
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
        if (typeof chat.id === 'string') {
          // The sync snapshot is where the unread counter SEEDS from (review F4): Baileys
          // reports it per conversation here and never maintains it live — that is the
          // thread store's job from this point on.
          const unread = (chat as { unreadCount?: number | null }).unreadCount;
          store.seedChatMeta(chat.id, {
            ...(typeof chat.name === 'string' && chat.name.length > 0 ? { name: chat.name } : {}),
            ...(typeof unread === 'number' && unread >= 0 ? { unreadCount: unread } : {}),
          });
        }
      }
      for (const message of chunk.messages ?? []) ingest(message, false);
      const progress = chunk.progress;
      history = {
        ...history,
        progress: typeof progress === 'number' ? progress : history.progress,
      };
    });

    socket.ev.on('chats.update', (updates) => {
      for (const update of updates ?? []) {
        if (typeof update.id !== 'string') continue;
        const unread = (update as { unreadCount?: number | null }).unreadCount;
        if (typeof unread === 'number' && unread >= 0) {
          // "I read it on my phone" arrives here as a snapshot; it overwrites the running
          // count, and the chat-update hint lets an open app clear its badge immediately.
          store.seedChatMeta(update.id, { unreadCount: unread });
          events.push({ jid: update.id, kind: 'chat-update', ts: Math.floor(now() / 1000) });
        }
      }
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
      // `notify` is a live arrival; `append` and history-adjacent types are replay. Only
      // the live kind may move the unread counter or ring the doorbell.
      const live = upsert.type === 'notify';
      for (const message of upsert.messages ?? []) ingest(message, live);
    });
  };

  return {
    linkState: () => link,
    currentQr: () => (link === 'linked' ? undefined : qr),

    async startLink() {
      // Idempotent while one attempt is in flight — a second call must not open a rival
      // socket racing the first for the same session.
      if (sock !== undefined && (link === 'waiting' || link === 'linked')) return;

      // CLEAR A DEAD OR HALF-LINKED STORE BEFORE PAIRING (see `shouldResetAuthStore`). The
      // in-memory `state` is reloaded too: resetting the files while continuing to hand
      // Baileys the credentials we just deleted would resume the same dead session and
      // reproduce the exact wedge this clears.
      if (shouldResetAuthStore(link)) {
        resetAuthStore(deps.authDir);
        const reloaded = await useMultiFileAuthState(deps.authDir);
        state = reloaded.state;
        saveCreds = reloaded.saveCreds;
      }

      link = 'waiting';
      connect();
    },

    listChats: () => store.listChats(),
    history: (jid) => store.history(jid),
    messagesSince: (jid, since) => store.messagesSince(jid, since),
    historyState: () => history,

    eventsSince: (cursor) => events.since(cursor),
    waitForEvents: (cursor, timeoutMs) => events.wait(cursor, timeoutMs),

    async mediaOf(jid, id) {
      const raw = rawImages.get(`${jid} ${id}`);
      // Unknown, non-image, or evicted: honestly gone. The thumbnail already delivered
      // with the message row is the graceful floor; there is nothing here to fetch.
      if (raw === undefined) return undefined;
      const image = (raw.message as MessageContent | null | undefined)?.imageMessage;
      if (image === undefined || image === null) return undefined;

      const tooLarge = (): WaMediaResult => {
        const thumbnail = thumbnailOf(image);
        return { tooLarge: true, ...(thumbnail !== undefined ? { thumbnailBase64: thumbnail } : {}) };
      };

      // Refuse BEFORE downloading when the declared size already busts the cap — pulling
      // ten megabytes to throw them away spends the user's bandwidth on a refusal.
      const declared = image.fileLength;
      const declaredBytes =
        typeof declared === 'number'
          ? declared
          : declared !== null && declared !== undefined && typeof (declared as { toNumber?: () => number }).toNumber === 'function'
            ? (declared as { toNumber: () => number }).toNumber()
            : undefined;
      if (declaredBytes !== undefined && declaredBytes > MAX_MEDIA_BYTES) return tooLarge();

      try {
        // The context wires the LIVE socket's re-request (review F5): WhatsApp media CDN
        // links expire, and without `reuploadRequest` every older image silently fails
        // instead of being re-fetched through the session.
        const buffer = (await downloadMediaMessage(
          raw as Parameters<typeof downloadMediaMessage>[0],
          'buffer',
          {},
          sock !== undefined
            ? { reuploadRequest: sock.updateMediaMessage, logger: silentLogger as never }
            : undefined,
        )) as Buffer;
        // The declared size was a claim; the bytes are the fact. Both are checked.
        if (buffer.length > MAX_MEDIA_BYTES) return tooLarge();
        const mime = typeof image.mimetype === 'string' && image.mimetype.length > 0 ? image.mimetype : 'image/jpeg';
        return { mime, base64: buffer.toString('base64') };
      } catch {
        // Expired beyond re-request, unlinked mid-download, transport hiccup: the honest
        // answer is "not fetchable", and the caller falls back to the thumbnail.
        return undefined;
      }
    },

    async pictureOf(jid) {
      const cached = pictures.get(jid);
      if (cached !== undefined) return cached ?? undefined;
      if (sock === undefined || link !== 'linked') return undefined;
      try {
        const url = await sock.profilePictureUrl(jid, 'preview');
        if (typeof url !== 'string' || url.length === 0) throw new Error('no picture');
        const response = await fetch(url);
        if (!response.ok) throw new Error(`avatar fetch ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) throw new Error('avatar size');
        const mime = response.headers.get('content-type') ?? 'image/jpeg';
        const picture = { mime, base64: bytes.toString('base64') };
        pictures.set(jid, picture);
        return picture;
      } catch {
        // "Has none" and "cannot fetch" get the same honest 404 downstream — and the same
        // cache slot, so a jid with no avatar is not re-asked on every list render.
        pictures.set(jid, null);
        return undefined;
      }
    },

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
