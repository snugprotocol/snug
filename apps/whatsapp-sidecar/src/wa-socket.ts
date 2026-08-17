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

/** One message, reduced to what analysis and reply actually need. */
export interface WaMessage {
  id: string;
  /** Sender JID. For a group this is the participant; for a DM, the other party. */
  from: string;
  text: string;
  /** Unix seconds, as WhatsApp reports them. */
  ts: number;
  /** True when the linked account sent it — the rows the mimic profile is built from. */
  fromMe?: boolean;
  /** JIDs this message @-mentions. The group auto-reply trigger reads this. */
  mentions?: readonly string[];
}

/** One conversation the linked account can see. */
export interface WaChat {
  jid: string;
  name: string;
  isGroup: boolean;
  participants?: readonly { jid: string; name?: string }[];
}

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
}
