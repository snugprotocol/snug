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

import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  type WASocket as BaileysSocket,
} from 'baileys';
import { createFileAuthState } from './auth-state.js';
import { createEventBuffer } from './event-buffer.js';
import type { ThreadCache } from './thread-cache.js';
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
 * Is the store WEDGED — a scan that started an identity but never completed pairing?
 *
 * **DO NOT reintroduce `registered` as the signal.** The first version of this function did,
 * and it was wrong in the most expensive way: in `baileys@7.0.0-rc14`, `creds.registered` is
 * set to true in EXACTLY ONE place — `Socket/messages-recv.js:940`, inside the
 * `link_code_pairing` (phone-number code) flow. The QR flow never touches it: `pair-success`
 * runs `configureSuccessfulPairing`, which writes `me`, `account`, `signalIdentities` and
 * `platform`, and leaves `registered` at its `initAuthCreds` default of `false`.
 *
 * Every session THIS helper creates is QR-paired, so `registered: false` is the permanent,
 * correct steady state here. The old check therefore fired on every healthy session: the app
 * told the user to re-link, re-linking ran `shouldResetAuthStore`, which DELETED the working
 * session, and the loop repeated (owner-reported 2026-08-18, after re-pairing twice). A false
 * positive on this predicate does not merely mislead — it destroys the thing it calls broken.
 *
 * The honest signal is the material a COMPLETED pairing leaves behind. `me` alone is not
 * enough: it is written during the handshake. `account` and a non-empty `signalIdentities`
 * are what a session actually needs to resume, so their absence beside a saved `me` is the
 * real interrupted-scan shape.
 *
 * Absent `me` is a FIRST RUN, not a wedge. An unreadable or missing store makes no claim at
 * all and answers false: a value we cannot read is not evidence of a fault.
 */
export function isHalfLinkedStore(authDir: string): boolean {
  const material = readCredsMaterial(authDir);
  if (material === undefined || !material.scanStarted) return false;
  return !(material.hasAccount && material.hasIdentities);
}

/**
 * The ONE reading of what pairing left in `creds.json` (review finding 2026-08-18: the
 * half-linked and resumable predicates had grown two byte-identical copies of this read).
 * `undefined` means the store made no claim at all — missing or unreadable.
 */
function readCredsMaterial(
  authDir: string,
): { scanStarted: boolean; hasAccount: boolean; hasIdentities: boolean } | undefined {
  try {
    const raw = readFileSync(join(authDir, 'creds.json'), 'utf8');
    const creds = JSON.parse(raw) as { me?: unknown; account?: unknown; signalIdentities?: unknown };
    return {
      scanStarted: creds.me !== undefined && creds.me !== null,
      hasAccount: creds.account !== undefined && creds.account !== null,
      hasIdentities: Array.isArray(creds.signalIdentities) && creds.signalIdentities.length > 0,
    };
  } catch {
    return undefined;
  }
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
  /** Durable content cache (ADR-0037): restored at boot, saved on a debounce as sync runs. */
  threadCache?: ThreadCache;
  /** Snapshot write debounce; injectable so tests need not wait five real seconds. */
  cacheDebounceMs?: number;
  /** How long a RESUMED session waits for a history chunk before inferring completion. */
  resumeHistoryGraceMs?: number;
  /** Beat of the background roster sweep; injectable so tests need not wait twenty seconds. */
  rosterSweepMs?: number;
  /** First retry delay after a roster fetch fails; doubles per failure. Injectable for tests. */
  rosterRetryBaseMs?: number;
  /** First sweep-wide pause after a server throttle; doubles while throttled. Injectable. */
  rosterCooldownBaseMs?: number;
}

/**
 * Is this roster failure an ANSWER rather than weather? `item-not-found` (the group no
 * longer exists) and `forbidden`/`not-authorized` (we are not in it) are definitive — the
 * roster will never load, and retrying spends iq budget learning nothing. Everything else
 * (timeouts, `rate-overlimit`, transport hiccups) says nothing about the group itself.
 */
function isPermanentRosterRefusal(message: string): boolean {
  return /item-not-found|forbidden|not-authorized/i.test(message);
}

/**
 * Can this store RESUME — has a pairing ever COMPLETED here?
 *
 * The same material predicate as `isHalfLinkedStore`, asked in the affirmative: `me` plus
 * `account` plus a non-empty `signalIdentities` is what `configureSuccessfulPairing` writes,
 * for QR and phone-code flows alike (never `registered` — see the warning above). Missing or
 * unreadable creds answer false: an absent claim is not a resumable session.
 */
export function isResumableStore(authDir: string): boolean {
  const material = readCredsMaterial(authDir);
  return material !== undefined && material.scanStarted && material.hasAccount && material.hasIdentities;
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

/**
 * Map a Baileys message onto the seam's shape, or undefined when it is not a text message.
 *
 * `senderPushName` rides beside the row when the SENDER's self-set display name is known and
 * the row is not the user's own: on a fromMe row the sender seat resolves to the chat PARTNER
 * while `pushName` is the USER's name, so harvesting it would rename everyone as the user.
 * Push names are the only name source for a group member with no 1:1 chat (history-sync
 * contact rows are synthesized one-per-conversation), which made discarding them the dominant
 * cause of "Unknown contact" (owner report 2026-08-18).
 */
export function toWaMessage(raw: {
  key?: { id?: string | null; remoteJid?: string | null; participant?: string | null; fromMe?: boolean | null };
  message?: unknown;
  messageTimestamp?: number | Long | null;
  pushName?: string | null;
}): { chatJid: string; message: WaMessage; senderPushName?: string } | undefined {
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
  const pushName = raw.key?.fromMe === true ? undefined : raw.pushName;
  return {
    chatJid,
    ...(typeof pushName === 'string' && pushName.trim().length > 0
      ? { senderPushName: pushName.trim() }
      : {}),
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

/** A tiny FIFO slot limiter — the pacing primitive the avatar and roster fetches share. */
function createSlotLimiter(maxConcurrent: number): { acquire(): Promise<void>; release(): void } {
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    acquire: () =>
      new Promise((resolve) => {
        if (active < maxConcurrent) {
          active += 1;
          resolve();
        } else {
          waiters.push(() => {
            active += 1;
            resolve();
          });
        }
      }),
    release: () => {
      active -= 1;
      waiters.shift()?.();
    },
  };
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

/** Pino calls both ways — `warn(obj, msg)` and `warn(msg)`; keep whichever seats exist. */
function writeTerminalLine(level: 'warn' | 'error', obj: unknown, msg?: unknown): void {
  const text = typeof obj === 'string' ? obj : typeof msg === 'string' ? msg : '';
  const data = typeof obj === 'object' && obj !== null ? [obj] : [];
  console.error(`[baileys ${level}] ${text}`, ...data);
}

/**
 * The socket's logger (TASK-20260822-wa-authstate-corruption AC5). Baileys' default pino
 * prints info-level protocol housekeeping — "identity key changed…", "resyncing regular…"
 * — straight into the desktop terminal. This is the warn floor: faults still surface with
 * their diagnostic payload, chatter does not. `level` is read by Baileys itself (its
 * trace-only decode paths check it), so 'warn' is a claim the library acts on.
 */
const warnFloorLogger: MediaLogger = {
  level: 'warn',
  child: () => warnFloorLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (obj, msg) => writeTerminalLine('warn', obj, msg),
  error: (obj, msg) => writeTerminalLine('error', obj, msg),
};

export async function createBaileysWaSocket(deps: BaileysSocketDeps): Promise<WaSocket> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let { state, saveCreds } = await createFileAuthState(deps.authDir);

  let link: WaLinkState = 'idle';
  let qr: string | undefined;
  let sock: BaileysSocket | undefined;
  let history: WaHistoryState = { complete: false, explicit: false, progress: 0 };
  let lastSendAt = 0;
  /** True when this process connected by RESUMING stored creds rather than pairing fresh. */
  let resumedSession = false;
  /** Whether any `messaging-history.set` chunk has arrived this process lifetime. */
  let sawHistoryChunk = false;

  // The store owns its change signal (ADR-0037 §1): every mutation that changed durable
  // state schedules a save BY CONSTRUCTION — no event handler can forget to. `scheduleSave`
  // is declared below; the arrow defers the read until events actually fire.
  const store = createThreadStore(undefined, () => scheduleSave());
  const events = createEventBuffer(EVENT_BUFFER_SIZE);

  // ---- THE DURABLE CACHE (ADR-0037 §1): restore first, so chats exist before any sync.
  // The payload carries the HISTORY STATE beside the store: without it, a restored,
  // fully-synced session would report "still syncing" forever — exactly the ambiguity
  // lessons.md 2026-08-17 warns renders as a lie the user cannot see through.
  if (deps.threadCache !== undefined) {
    const cached = deps.threadCache.load() as { store?: unknown; history?: unknown } | undefined;
    if (cached !== undefined && cached !== null && typeof cached === 'object') {
      store.restore(cached.store);
      const savedHistory = cached.history as Partial<WaHistoryState> | null | undefined;
      if (savedHistory !== null && typeof savedHistory === 'object') {
        history = {
          complete: savedHistory.complete === true,
          explicit: savedHistory.explicit === true,
          progress: typeof savedHistory.progress === 'number' ? savedHistory.progress : 0,
        };
      }
    }
  }

  const cacheDebounceMs = deps.cacheDebounceMs ?? 5_000;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * THE PERSIST TOMBSTONE (TASK-20260821 AC5). Once `forget()` has erased the auth store,
   * NOTHING may write into that directory again from this process: not the debounce
   * flush, not the process-exit flush (which the shell's TERM-first reap exists to run),
   * not a late `creds.update`. Every writer below checks this flag — a wipe followed by
   * any one of those writes would ship the user's WhatsApp content back onto the disk
   * they just asked to be cleared (plan review 2026-08-21, finding 1).
   */
  let forgotten = false;
  const persistNow = (): void => {
    if (forgotten) return;
    deps.threadCache?.save({
      store: store.snapshot(),
      history,
      // Diagnostics only — restore() ignores this seat. It exists so a stalled sweep can
      // be read off the cache file instead of guessed at (hardware walk 5, 2026-08-18).
      rosterDiagnostics: {
        rostersLoaded: rosterLoaded.size,
        rostersGivenUp: rostersGivenUp(),
        errors: Object.fromEntries(rosterErrorCounts),
      },
    });
  };
  /**
   * Throttle-style: the first change opens a window, everything else in it rides along in
   * one write. History sync mutates the store thousands of times a minute; the disk sees a
   * snapshot every few seconds, and the process-exit flush below catches the tail.
   */
  const scheduleSave = (): void => {
    if (forgotten || deps.threadCache === undefined || saveTimer !== undefined) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persistNow();
    }, cacheDebounceMs);
    saveTimer.unref?.();
  };
  if (deps.threadCache !== undefined) {
    // The shell's reap sends SIGTERM first (KILL only as the backstop — `reap_child` in
    // sidecar.rs, pinned by its own test); `cli.ts` turns that into `server.close()` →
    // `process.exit(0)`, and 'exit' handlers run synchronously on that path — so this
    // final write catches the debounce window's tail. A SIGKILL (backstop or crash) skips
    // it, costing at most one debounce window of re-syncable rows.
    process.once('exit', persistNow);
  }

  /**
   * Raw Baileys image messages, retained so `mediaOf` can hand them to
   * `downloadMediaMessage` later — the download needs the full protobuf row, not the seam's
   * reduced one. Bounded LRU-ish: a Map keeps insertion order, and the oldest entry is
   * evicted past the cap. An evicted raw means that image is no longer fetchable at full
   * size — the thumbnail the seam row carries is the graceful floor.
   */
  const rawImages = new Map<string, Parameters<typeof toWaMessage>[0]>();

  /**
   * Avatar cache. A HIT is kept for the session. A MISS is kept only until `missUntil`:
   * `profilePictureUrl` answers `undefined` both for a genuinely picture-less contact and
   * for transient conditions (privacy tcToken missing or expired), and the two are
   * indistinguishable in the reply — so "has none" is never allowed to be permanent
   * (owner-reported 2026-08-18: one bad moment froze most avatars until a helper restart).
   */
  const pictures = new Map<string, { picture: { mime: string; base64: string } } | { missUntil: number }>();

  /** How long a no-picture answer is trusted before the question goes live again. */
  const PICTURE_MISS_TTL_MS = 10 * 60_000;

  /**
   * At most this many lookups of one kind in flight. Every visible chat row asks for its
   * avatar on first paint, and a chat list of 233 groups asks for 233 rosters — an uncapped
   * burst of iqs gets rate-limited into timeouts whose retries re-enter the same burst. A
   * drip is slower to fill the list and reliably fills it.
   */
  const pictureSlots = createSlotLimiter(3);
  const rosterSlots = createSlotLimiter(3);
  const acquirePictureSlot = pictureSlots.acquire;
  const releasePictureSlot = pictureSlots.release;
  const acquireRosterSlot = rosterSlots.acquire;
  const releaseRosterSlot = rosterSlots.release;

  /**
   * Roster bookkeeping. LOADED rosters are never refetched this process lifetime (and a
   * cache-restored roster counts as loaded — no refetch burst at every boot); a FAILED
   * fetch gets bounded retries on the sweep beat below, because on real hardware the old
   * retry-on-next-list-read scheme left 98 of 233 rosters unloaded after 14 minutes —
   * which the user experiences as names that simply stop arriving (2026-08-18).
   */
  const ROSTER_MAX_ATTEMPTS = 5;
  const rosterLoaded = new Set<string>();
  const rosterInFlight = new Set<string>();
  /**
   * Retry bookkeeping with EXPONENTIAL BACKOFF (hardware walk 4, 2026-08-18): a retry per
   * sweep beat burned every attempt inside one ~2-minute throttle window and wrote off 106
   * of 233 groups. Doubling the spacing (20 s base, five attempts ≈ 10 minutes of
   * coverage) means a throttle costs one attempt, not all of them — while write-offs of
   * genuinely dead groups still land fast enough for the progress pill to converge within
   * minutes, not an hour.
   */
  const rosterAttempts = new Map<string, { attempts: number; nextAt: number }>();
  const rosterRetryBaseMs = deps.rosterRetryBaseMs ?? 20_000;
  /** Failure classes, aggregated for the cache diagnostics — message → count, capped. */
  const rosterErrorCounts = new Map<string, number>();
  /**
   * Sweep-wide THROTTLE cooldown (hardware walk 6): `rate-overlimit` is Meta's server
   * telling this whole session to slow down — 287 of them in one evening burned the retry
   * budgets of groups that were perfectly loadable. When it appears, everything pauses
   * (60 s, doubling to 10 min while it persists; reset on the next success), and the
   * throttled attempt is NOT charged to the group.
   */
  let rosterCooldownUntil = 0;
  let rosterCooldownStreak = 0;
  const rosterCooldownBaseMs = deps.rosterCooldownBaseMs ?? 60_000;
  const rostersGivenUp = (): number => {
    let count = 0;
    for (const [jid, tries] of rosterAttempts) {
      if (tries.attempts >= ROSTER_MAX_ATTEMPTS && !rosterLoaded.has(jid)) count += 1;
    }
    return count;
  };

  /**
   * Fetch a group's subject and participants (owner-reported 2026-08-17: group senders
   * showed as ids because no roster was ever loaded). Paced like the avatar lookups: a
   * chat list of 233 groups fired 233 concurrent metadata iqs, and the rate-limited
   * failures left most rosters unloaded. A queue loads them all, just not at once.
   */
  const ensureGroupRoster = (jid: string): void => {
    if (!jid.endsWith('@g.us') || sock === undefined || link !== 'linked') return;
    if (now() < rosterCooldownUntil) return; // the server asked the whole session to wait
    if (rosterLoaded.has(jid) || rosterInFlight.has(jid)) return;
    const tries = rosterAttempts.get(jid);
    if (tries !== undefined && (tries.attempts >= ROSTER_MAX_ATTEMPTS || now() < tries.nextAt)) return;
    rosterInFlight.add(jid);
    void (async () => {
      await acquireRosterSlot();
      try {
        const metadata = await sock!.groupMetadata(jid);
        // FULL rows, not bare ids (hardware finding 2026-08-18): each participant is a
        // Contact — a LID id with a `phoneNumber` pairing (groups.js:337) and sometimes
        // name seats. Feeding them to the directory is what joins LID roster seats to the
        // saved names; dropping them rendered "Unknown contact" by the hundreds.
        store.rememberContacts((metadata?.participants ?? []) as never);
        store.setGroupMetadata(jid, {
          subject: metadata?.subject,
          participants: (metadata?.participants ?? []).map((participant) => ({ id: participant.id })),
        });
        rosterLoaded.add(jid);
        rosterCooldownStreak = 0; // the server is answering again
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120) || 'unknown';
        if (/rate-overlimit/i.test(reason)) {
          // The MOMENT is bad, not the group: pause the sweep, charge nobody.
          rosterCooldownStreak += 1;
          rosterCooldownUntil =
            now() + Math.min(rosterCooldownBaseMs * 2 ** (rosterCooldownStreak - 1), 600_000);
        } else if (isPermanentRosterRefusal(reason)) {
          // An ANSWER: the group is gone or we are not in it. Write it off now — the pill's
          // target shrinks by exactly this group, and no further iq is spent on it.
          rosterAttempts.set(jid, { attempts: ROSTER_MAX_ATTEMPTS, nextAt: now() });
        } else {
          const attempts = (rosterAttempts.get(jid)?.attempts ?? 0) + 1;
          rosterAttempts.set(jid, {
            attempts,
            nextAt: now() + rosterRetryBaseMs * 2 ** (attempts - 1),
          });
        }
        // Aggregate the failure CLASS (never per-group detail) and persist it: a steady
        // state of failures used to write nothing to disk, which made the stall invisible
        // to diagnosis — the cache aged while the sweep silently burned retries.
        if (rosterErrorCounts.size < 20 || rosterErrorCounts.has(reason)) {
          rosterErrorCounts.set(reason, (rosterErrorCounts.get(reason) ?? 0) + 1);
        }
        scheduleSave();
      } finally {
        rosterInFlight.delete(jid);
        releaseRosterSlot();
      }
    })();
  };

  const ingest = (raw: Parameters<typeof toWaMessage>[0], live: boolean): void => {
    const mapped = toWaMessage(raw);
    if (mapped === undefined) return;
    // Harvest the sender's push name BEFORE the row lands, so a brand-new chat is born named
    // rather than named on the next refresh. The store's tier rules make this safe (a push
    // name never displaces a saved one) and cheap (an unchanged name skips the refresh pass).
    if (mapped.senderPushName !== undefined) {
      store.rememberContacts([{ id: mapped.message.from, notify: mapped.senderPushName }]);
    }
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
    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      logger: warnFloorLogger,
    });
    sock = socket;

    // Tombstone-guarded: Baileys fires this during logout teardown too, and a post-forget
    // credential write would re-materialize the store the wipe just erased.
    socket.ev.on('creds.update', () => {
      if (!forgotten) void saveCreds();
    });

    socket.ev.on('connection.update', (update) => {
      if (typeof update.qr === 'string' && update.qr.length > 0) {
        qr = update.qr;
        link = 'waiting';
      }
      if (update.connection === 'open') {
        link = 'linked';
        qr = undefined;
        // RESUME HONESTY (owner-reported 2026-08-18): WhatsApp pushes history at PAIRING;
        // a resumed session never gets a re-push. A resume whose store lost its history
        // (no cache, quarantined snapshot, pre-cache helper) would therefore report
        // "still syncing 0%" FOREVER — a permanent state rendering as a normal wait. After
        // a grace window with no history chunk, completion is reported as INFERRED
        // (`explicit:false` is the seat built for exactly this claim), so the spinner
        // retires and the app can say what actually happened.
        if (resumedSession && !history.complete) {
          const grace = setTimeout(() => {
            if (!sawHistoryChunk && !history.complete) {
              history = { complete: true, explicit: false, progress: 100 };
              scheduleSave();
            }
          }, deps.resumeHistoryGraceMs ?? 60_000);
          grace.unref?.();
        }
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

    // THE ADDRESS BOOK (owner-reported 2026-08-17: no contact names anywhere). History sync
    // carries `contacts` alongside `chats`/`messages`, and the live directory arrives as its
    // own events — reading only the conversation rows meant a chat could be named ONLY by
    // whatever WhatsApp happened to stamp on it, which for most DMs is nothing.
    socket.ev.on('contacts.upsert', (contacts) => store.rememberContacts(contacts ?? []));
    socket.ev.on('contacts.update', (contacts) => store.rememberContacts((contacts ?? []) as never));

    // LID ↔ phone pairings. A LID is an INTERNAL address, not a phone number: rendering its
    // digits produced a plausible-looking wrong number — worse than showing nothing, because
    // it invites the user to trust it.
    socket.ev.on('lid-mapping.update', (mapping) => store.rememberLidMappings([mapping as never]));

    socket.ev.on('messaging-history.set', (chunk) => {
      sawHistoryChunk = true;
      store.rememberContacts((chunk.contacts ?? []) as never);
      store.rememberLidMappings((chunk.lidPnMappings ?? []) as never);
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
      scheduleSave();
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
      scheduleSave();
    });

    socket.ev.on('messages.upsert', (upsert) => {
      // `notify` is a live arrival; `append` and history-adjacent types are replay. Only
      // the live kind may move the unread counter or ring the doorbell.
      const live = upsert.type === 'notify';
      for (const message of upsert.messages ?? []) ingest(message, live);
    });
  };

  // ADR-0037 §2: a COMPLETED pairing resumes at boot, without waiting for a wizard or an
  // app request — that is what lets sync continue in the background after a shell restart.
  // The material predicate keeps this honest: a first run or a half-linked wedge makes no
  // outbound connection at all.
  if (isResumableStore(deps.authDir)) {
    resumedSession = true;
    connect();
  }

  // A cache-restored roster is already loaded — refetching all of them at every boot would
  // re-create the burst the limiter exists to prevent.
  for (const row of store.listChats()) {
    if (row.isGroup && row.participants !== undefined) rosterLoaded.add(row.jid);
  }

  // THE ROSTER SWEEP: missing rosters are fetched on this beat, unprompted — names must
  // keep arriving whether or not the app happens to re-read the chat list. Bounded per
  // group by ROSTER_MAX_ATTEMPTS; a fully-loaded state makes this a no-op scan.
  const rosterSweep = setInterval(() => {
    if (link !== 'linked') return;
    for (const row of store.listChats()) {
      if (row.isGroup) ensureGroupRoster(row.jid);
    }
  }, deps.rosterSweepMs ?? 20_000);
  rosterSweep.unref?.();

  return {
    linkState: () => link,
    currentQr: () => (link === 'linked' ? undefined : qr),

    async startLink() {
      // Idempotent while one attempt is in flight — a second call must not open a rival
      // socket racing the first for the same session. `idle`-with-a-socket is the boot
      // RESUME in flight (above): resetting the store under it would destroy a working
      // session, so that state returns here too; only `closed` may retry the connect.
      if (sock !== undefined && link !== 'closed') return;

      // CLEAR A DEAD OR HALF-LINKED STORE BEFORE PAIRING (see `shouldResetAuthStore`). The
      // in-memory `state` is reloaded too: resetting the files while continuing to hand
      // Baileys the credentials we just deleted would resume the same dead session and
      // reproduce the exact wedge this clears.
      if (shouldResetAuthStore(link)) {
        resetAuthStore(deps.authDir);
        const reloaded = await createFileAuthState(deps.authDir);
        state = reloaded.state;
        saveCreds = reloaded.saveCreds;
      }

      link = 'waiting';
      // A pairing-driven connect is NOT a resume: history is coming, so the resume grace
      // (which infers completion) must never arm against it.
      resumedSession = false;
      connect();
    },

    listChats: () => {
      const rows = store.listChats();
      // Lazily fill group rosters as the list is read — the first read returns what is
      // known and the next one carries the names, rather than blocking the list on a
      // round trip per group.
      for (const row of rows) if (row.isGroup) ensureGroupRoster(row.jid);
      return rows;
    },
    history: (jid) => store.history(jid),
    messagesSince: (jid, since) => store.messagesSince(jid, since),
    historyState: () => {
      // Progress DETAIL rides every read (owner ask 2026-08-18): the history percent hides
      // the second phase — name resolution via the paced roster sweep — which continues
      // after the history push completes. Computed here, never persisted-and-trusted.
      const stats = store.stats();
      const detail = {
        groups: stats.groups,
        rostersLoaded: rosterLoaded.size,
        rostersGivenUp: rostersGivenUp(),
        names: stats.names,
        messages: stats.messages,
      };
      // The wedge is checked on READ, from disk, because it can only change through a
      // pairing attempt (which rewrites the store) — and reading it here means every
      // history and messages response carries the fact, with no extra route and no
      // background poll. Cheap: one small file, only while unlinked or empty.
      if (!history.complete && isHalfLinkedStore(deps.authDir)) {
        return { ...history, needsRelink: true, detail };
      }
      return { ...history, detail };
    },

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
      // An expired miss reads as "not cached": the question is live again.
      const readCache = (key: string): { hit: boolean; value?: { mime: string; base64: string } } => {
        const entry = pictures.get(key);
        if (entry === undefined) return { hit: false };
        if ('picture' in entry) return { hit: true, value: entry.picture };
        if (entry.missUntil > now()) return { hit: true };
        pictures.delete(key);
        return { hit: false };
      };

      const direct = readCache(jid);
      if (direct.hit) return direct.value;
      if (sock === undefined || link !== 'linked') return undefined;

      // A LID and a phone jid are the same person; ask under the canonical spelling so one
      // fetch serves both and a LID-addressed group member is not treated as a stranger.
      const canonical = store.resolveIdentity(jid);
      if (canonical !== jid) {
        const viaCanonical = readCache(canonical);
        if (viaCanonical.hit) return viaCanonical.value;
      }

      await acquirePictureSlot();
      try {
        const url = await sock.profilePictureUrl(canonical, 'preview');
        // NO URL is ambiguous: a contact with a default avatar answers this way, but so does
        // a missing/expired privacy token. Trust it briefly — enough to stop a round trip
        // per row per render — never permanently (a failure is not a fact, lessons.md
        // 2026-08-17; this branch is where most real misses arrive).
        if (typeof url !== 'string' || url.length === 0) {
          const miss = { missUntil: now() + PICTURE_MISS_TTL_MS };
          pictures.set(jid, miss);
          if (canonical !== jid) pictures.set(canonical, miss);
          return undefined;
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`avatar fetch ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) throw new Error('avatar size');
        const mime = response.headers.get('content-type') ?? 'image/jpeg';
        const picture = { mime, base64: bytes.toString('base64') };
        pictures.set(jid, { picture });
        if (canonical !== jid) pictures.set(canonical, { picture });
        return picture;
      } catch {
        // A THROWN failure — a hiccup, a rate limit — is not cached at all: the next list
        // render asks again, now paced by the slot limiter instead of re-entering a burst.
        return undefined;
      } finally {
        releasePictureSlot();
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

    async forget() {
      // Order matters, and each step is why the previous one is safe:
      //  1. TOMBSTONE FIRST — from this line no debounce flush, exit flush, or
      //     `creds.update` can write into the store again (see the `forgotten` doc).
      //  2. Cancel the pending debounce, so the wipe below cannot race a queued save.
      //  3. LOGOUT before the wipe — the unlink frame needs the very credentials the wipe
      //     destroys. Best-effort: an offline phone or an already-dead socket must not
      //     keep the disk dirty, so failures fall through to the erase.
      //  4. Erase the auth store LAST: session keys, minted token, thread cache — all of
      //     it lives in `authDir` (the thread cache is created beside the keys for
      //     exactly this shared-lifetime sweep).
      forgotten = true;
      if (saveTimer !== undefined) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
      }
      const active = sock;
      sock = undefined;
      link = 'idle';
      qr = undefined;
      try {
        await active?.logout();
      } catch {
        /* offline, unpaired, or already unlinked — the erase below is the contract */
      }
      try {
        void active?.end(undefined);
      } catch {
        /* already closed */
      }
      resetAuthStore(deps.authDir);
    },
  };
}
