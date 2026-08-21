/**
 * THE WhatsApp SOCKET SEAM (ADR-0032).
 *
 * Everything this sidecar needs from the WhatsApp library, expressed as an interface the
 * router depends on instead of the library itself. Two reasons, and the second is the
 * important one:
 *
 *  1. The suite runs against a scripted fake, so the router's refusals are tested without a
 *     network, a phone, or a real account.
 *  2. The library is a moving target. `baileys` publishes its 7.x line as release
 *     candidates and reshapes its event payloads between them; the 6.x "stable" line pulls
 *     `libsignal` from a git URL, which this repo will not take. Pinning the surface WE use
 *     to a seam this narrow means an upgrade is a change to ONE adapter file, and the
 *     router's security properties are proven against the seam either way.
 *
 * VERIFIED against the published `baileys@7.0.0-rc14` tarball (read, not remembered):
 * `makeWASocket` default export, `useMultiFileAuthState(folder) -> { state, saveCreds }`,
 * `ConnectionState.qr?: string`, `sendMessage(jid, content, options)`, and the events
 * `connection.update` / `creds.update` / `messages.upsert` / `messaging-history.set` /
 * `messaging-history.status`.
 */

import type { WaEventsPage } from './event-buffer.js';

export type { WaEventHint, WaEventKind, WaEventsPage } from './event-buffer.js';

/** One message, reduced to what analysis, reply and (v2) rendering actually need. */
export interface WaMessage {
  id: string;
  /** Sender JID. For a group this is the participant; for a DM, the other party. */
  from: string;
  /** The body — or, for an image, its caption (possibly empty). Never invented words. */
  text: string;
  /** Unix seconds, as WhatsApp reports them. */
  ts: number;
  /** True when the linked account sent it — the rows the mimic profile is built from. */
  fromMe?: boolean;
  /** JIDs this message @-mentions. The group auto-reply trigger reads this. */
  mentions?: readonly string[];
  /**
   * ABSENT for plain text (v1 consumers read those rows unchanged); `'image'` marks a
   * TYPED media row (ADR-0034) — typed rather than dropped, so a photo shows as a photo
   * instead of silently not existing, and typed rather than worded, so no placeholder
   * string ever enters a transcript as something the person wrote.
   */
  kind?: 'image';
  /** Inline preview (Baileys' jpegThumbnail), small enough to ride list responses. */
  thumbnailBase64?: string;
  /** Dereferenced by `GET /chats/:jid/media/:id` for the full bytes. */
  mediaId?: string;
}

/** One conversation the linked account can see. */
export interface WaChat {
  jid: string;
  name: string;
  /**
   * Present (as `'push'`) ONLY when `name` is the contact's own self-set push name rather
   * than one the user saved — the app renders those under WhatsApp's ~convention. Saved and
   * verified names carry no mark.
   */
  nameKind?: 'push';
  isGroup: boolean;
  participants?: readonly { jid: string; name?: string; nameKind?: 'push' }[];
  /**
   * Owned by the SIDECAR (ADR-0034/review F4): Baileys reports unread only as a snapshot
   * on synced conversations, so the adapter seeds from that and increments itself per live
   * incoming message. Consumers clear their badge locally; nothing is sent to WhatsApp.
   */
  unreadCount?: number;
  lastMessage?: { text: string; ts: number; fromMe?: boolean; kind?: 'image' };
  /** Unix seconds of the newest known activity — the chat list's sort key. */
  lastActivityTs?: number;
}

/** Full media bytes, or the structured refusal — the cap refuses, never truncates. */
export type WaMediaResult =
  | { mime: string; base64: string }
  | { tooLarge: true; thumbnailBase64?: string };

/**
 * How much of the history WhatsApp has actually delivered.
 *
 * `explicit` is the honest bit and the reason this type exists rather than a bare boolean:
 * history sync is PUSHED in chunks, and its completion is sometimes INFERRED from a timeout
 * rather than announced by the server (`messaging-history.status` carries exactly this
 * distinction). An app that renders an inferred completion as "this is everything" is
 * misdescribing the evidence its whole analysis rests on — so the fact travels all the way
 * to the UI instead of being flattened here.
 */
export interface WaHistoryState {
  complete: boolean;
  explicit: boolean;
  progress: number;
  /**
   * Live sync bookkeeping for progress surfaces (owner ask, 2026-08-18): history percent
   * alone hides the SECOND phase — name resolution, which runs on group rosters loading a
   * paced few at a time and continues after the history push completes. Computed at read
   * time, never persisted-and-trusted.
   */
  detail?: {
    groups: number;
    rostersLoaded: number;
    /** Groups whose roster is unfetchable (attempts exhausted) — subtracted from targets. */
    rostersGivenUp: number;
    names: number;
    messages: number;
  };
  /**
   * The session is WEDGED — scanned but never registered — so history sync will never
   * begin and "still syncing" would be a lie the user cannot see through. Present only
   * when true: the flag is a claim, never a default (owner-reported 2026-08-17).
   */
  needsRelink?: boolean;
}

export type WaLinkState = 'idle' | 'waiting' | 'linked' | 'closed';

/** The narrow surface the router uses. Implemented by the real adapter and by the fake. */
export interface WaSocket {
  linkState(): WaLinkState;
  /** The current QR payload while waiting, or undefined once linked (or before start). */
  currentQr(): string | undefined;
  /** Begin a link attempt. Idempotent while one is already in flight. */
  startLink(): Promise<void>;
  listChats(): readonly WaChat[];
  /** Buffered history for one thread, oldest first, or undefined when unknown. */
  history(jid: string, cursor?: string): { messages: readonly WaMessage[]; nextCursor?: string } | undefined;
  /** Messages newer than `since` (unix seconds), or undefined when the thread is unknown. */
  messagesSince(jid: string, since?: number): readonly WaMessage[] | undefined;
  historyState(): WaHistoryState;
  sendText(jid: string, text: string): Promise<{ id: string }>;

  // ---- surface v2 (ADR-0034) ----
  /** The hint stream `GET /events` pages over. Hints only — the doorbell, not the delivery. */
  eventsSince(cursor: number | undefined): WaEventsPage;
  /** Resolve when a hint newer than `cursor` exists, or after `timeoutMs`. The long-poll hold. */
  waitForEvents(cursor: number | undefined, timeoutMs: number): Promise<void>;
  /** Full image bytes for a media row, the too-large refusal, or undefined when unknown. */
  mediaOf(jid: string, id: string): Promise<WaMediaResult | undefined>;
  /** Preview-size avatar, or undefined when the jid has none we can reach. */
  pictureOf(jid: string): Promise<{ mime: string; base64: string } | undefined>;

  /**
   * THE DEEP-DELETE UNLINK (TASK-20260821 AC5). Best-effort provider logout (the phone
   * shows the companion device unlinked), then erase the auth store — session keys, the
   * minted token, and the thread cache — and arm a PERSIST TOMBSTONE so no later write
   * (the debounce flush, the process-exit flush, a `creds.update`) can re-materialize
   * what was just erased. The shell's stop is TERM-first precisely so the exit flush
   * RUNS; without the tombstone that flush would rewrite the cache into the wiped
   * directory (plan review 2026-08-21, finding 1). Never throws.
   */
  forget(): Promise<void>;
}
