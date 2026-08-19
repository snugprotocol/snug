/**
 * THE EVENT WIRING (TASK-20260818-telepath-linking-sync).
 *
 * `thread-store.test.ts` proves the directory rules GIVEN contact rows, and
 * `message-mapping.test.ts` proves the row mapper — but until this file, nothing drove the
 * adapter's Baileys event subscriptions, which is exactly where the "Unknown contact" defect
 * lived: the store had the right precedence rules and the mapper was correct, while the wire
 * between a history chunk's `pushName`s and `rememberContacts` did not exist. Every injected
 * dependency is an untested wire (lessons.md 2026-08-17); this suite tests the wire.
 *
 * Baileys itself is mocked at the module seam: these are tests of OUR subscriptions and the
 * data they feed the store, not of WhatsApp's protocol.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (payload: unknown) => void;

interface FakeBaileysSocket {
  ev: { on(event: string, handler: Handler): void };
  emit(event: string, payload: unknown): void;
  groupMetadata: ReturnType<typeof vi.fn>;
  profilePictureUrl: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  updateMediaMessage: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(() => [] as FakeBaileysSocket[]);

vi.mock('baileys', () => {
  const makeFake = (): FakeBaileysSocket => {
    const handlers = new Map<string, Handler[]>();
    return {
      ev: {
        on(event: string, handler: Handler) {
          handlers.set(event, [...(handlers.get(event) ?? []), handler]);
        },
      },
      emit(event: string, payload: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      },
      groupMetadata: vi.fn(async () => ({ subject: undefined, participants: [] })),
      profilePictureUrl: vi.fn(async () => undefined),
      sendMessage: vi.fn(),
      updateMediaMessage: vi.fn(),
    };
  };
  return {
    default: vi.fn(() => {
      const sock = makeFake();
      created.push(sock);
      return sock;
    }),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: vi.fn(),
    useMultiFileAuthState: vi.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} })),
  };
});

import { createBaileysWaSocket } from '../baileys-socket.js';
import { createThreadStore } from '../thread-store.js';

let authDir: string;

beforeEach(() => {
  created.length = 0;
  authDir = mkdtempSync(join(tmpdir(), 'wa-sidecar-test-'));
});

afterEach(() => {
  rmSync(authDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Stand the adapter up, linked, with the newest fake Baileys socket in hand. */
async function linkedAdapter(deps: Partial<Parameters<typeof createBaileysWaSocket>[0]> = {}) {
  const adapter = await createBaileysWaSocket({ authDir, ...deps });
  await adapter.startLink();
  const fake = created.at(-1)!;
  fake.emit('connection.update', { connection: 'open' });
  return { adapter, fake };
}

/** The material a COMPLETED QR pairing writes (see isHalfLinkedStore's doc): resumable. */
function writeResumableCreds(dir: string): void {
  writeFileSync(
    join(dir, 'creds.json'),
    JSON.stringify({ me: { id: '1@s.whatsapp.net' }, account: { details: 'x' }, signalIdentities: [{ identifier: {} }] }),
  );
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('push names harvested from history rows', () => {
  it('names a DM chat from the pushName on a history message', async () => {
    // THE ISSUE-3 CORE. Baileys leaves `Chat.name` unset for 1:1 conversations and its
    // synthesized contact row usually carries no name either — the pushName riding the
    // message row is the only name source that reliably exists after a fresh link.
    const { adapter, fake } = await linkedAdapter();
    fake.emit('messaging-history.set', {
      chats: [{ id: '444@s.whatsapp.net' }],
      contacts: [],
      messages: [
        {
          key: { id: 'H1', remoteJid: '444@s.whatsapp.net', fromMe: false },
          message: { conversation: 'yo' },
          messageTimestamp: 10,
          pushName: 'Dee',
        },
      ],
    });
    const chat = adapter.listChats().find((row) => row.jid === '444@s.whatsapp.net');
    expect(chat?.name).toBe('Dee');
    expect(chat?.nameKind).toBe('push');
  });

  it('names a group participant who never had a 1:1 chat, from their history rows', async () => {
    // THE ISSUE-2 CORE ("most participants show Unknown contact"): a group member with no
    // 1:1 conversation contributes NO contact row to history sync — their pushName on the
    // messages they sent is all there is.
    const { adapter, fake } = await linkedAdapter();
    fake.groupMetadata.mockResolvedValue({
      subject: 'Crew',
      participants: [{ id: '555@s.whatsapp.net' }, { id: '666@s.whatsapp.net' }],
    });
    fake.emit('messaging-history.set', {
      chats: [{ id: 'g9@g.us', name: 'Crew' }],
      contacts: [],
      messages: [
        {
          key: { id: 'H2', remoteJid: 'g9@g.us', participant: '555@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hello crew' },
          messageTimestamp: 11,
          pushName: 'Elle',
        },
      ],
    });
    adapter.listChats(); // first read fires the lazy roster fetch
    await flush();
    const group = adapter.listChats().find((row) => row.jid === 'g9@g.us');
    expect(group?.participants).toEqual([
      { jid: '555@s.whatsapp.net', name: 'Elle', nameKind: 'push' },
      { jid: '666@s.whatsapp.net' }, // truly unknown: silent, never fabricated
    ]);
  });

  it('feeds FULL roster rows to the directory — phoneNumber pairings and name seats included', async () => {
    // THE HARDWARE FINDING (owner, 2026-08-18): rosters were mapped to bare `{id}` rows,
    // discarding the `phoneNumber` the server sends beside each LID participant
    // (baileys groups.js:337) and any name seats — so LID seats could never join the
    // saved-name directory and rendered "Unknown contact" by the hundreds.
    const { adapter, fake } = await linkedAdapter();
    fake.emit('messaging-history.set', {
      chats: [{ id: 'g7@g.us', name: 'Mapped Crew' }],
      contacts: [{ id: '999@s.whatsapp.net', name: 'Noor Saved' }],
      messages: [],
    });
    fake.groupMetadata.mockResolvedValue({
      subject: 'Mapped Crew',
      participants: [
        { id: '31337@lid', phoneNumber: '999@s.whatsapp.net' },
        { id: '41414@lid', notify: 'Riz' },
      ],
    });
    adapter.listChats();
    await flush();
    const group = adapter.listChats().find((row) => row.jid === 'g7@g.us');
    expect(group?.participants).toEqual([
      { jid: '31337@lid', name: 'Noor Saved' }, // joined to the saved name via the pairing
      { jid: '41414@lid', name: 'Riz', nameKind: 'push' }, // named from the roster's own seat
    ]);
  });

  it('paces groupMetadata fetches — a 233-group list must be a queue, not a burst', async () => {
    // Same failure mode the avatar limiter fixed: an unpaced burst of roster iqs gets
    // rate-limited into failures (the owner's cache showed 82 of 233 rosters loaded).
    const { adapter, fake } = await linkedAdapter();
    let inFlight = 0;
    let peak = 0;
    fake.groupMetadata.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { subject: 'G', participants: [] };
    });
    fake.emit('messaging-history.set', {
      chats: Array.from({ length: 12 }, (_, i) => ({ id: `grp${i}@g.us`, name: `G${i}` })),
      contacts: [],
      messages: [],
    });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.groupMetadata).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("never renames a DM partner with the user's own pushName from a fromMe row", async () => {
    // On a fromMe DM row the sender seat resolves to the PARTNER while pushName is the
    // USER's — harvesting it would caption every conversation with the user's own name.
    const { adapter, fake } = await linkedAdapter();
    fake.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { id: 'H3', remoteJid: '777@s.whatsapp.net', fromMe: true },
          message: { conversation: 'me again' },
          messageTimestamp: 12,
          pushName: 'My Own Name',
        },
      ],
    });
    const chat = adapter.listChats().find((row) => row.jid === '777@s.whatsapp.net');
    expect(chat?.name).toBe('777@s.whatsapp.net'); // honest placeholder, not the user's name
  });

  it('harvests pushName from LIVE arrivals too, not only history replay', async () => {
    const { adapter, fake } = await linkedAdapter();
    fake.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: 'L1', remoteJid: '888@s.whatsapp.net', fromMe: false },
          message: { conversation: 'live hello' },
          messageTimestamp: 13,
          pushName: 'Gia',
        },
      ],
    });
    expect(adapter.listChats().find((row) => row.jid === '888@s.whatsapp.net')?.name).toBe('Gia');
  });
});

/**
 * AVATARS (owner report 2026-08-18: "profile pics load for some and not the rest").
 *
 * `profilePictureUrl` answers `undefined` for a privacy-restricted contact AND for a
 * missing/expired tcToken — the second is transient, and caching it as a permanent "has no
 * picture" is what froze most avatars until the helper restarted. The 2026-08-17 "a failure
 * is not a fact" lesson was applied to the THROWN branch only; the `undefined`-URL branch is
 * where most real misses arrive. A miss is now remembered with a TTL: cheap enough not to
 * hammer WhatsApp per render, honest enough to heal.
 */
describe('avatar caching and pacing', () => {
  it('remembers a no-picture answer briefly, then asks again after the TTL', async () => {
    let clock = 1_000_000;
    const { adapter, fake } = await linkedAdapter({ now: () => clock });
    fake.profilePictureUrl.mockResolvedValue(undefined);

    expect(await adapter.pictureOf('111@s.whatsapp.net')).toBeUndefined();
    expect(await adapter.pictureOf('111@s.whatsapp.net')).toBeUndefined();
    // Within the TTL the miss is served from memory — one round trip, not one per render.
    expect(fake.profilePictureUrl).toHaveBeenCalledTimes(1);

    clock += 11 * 60_000; // past the TTL: the miss has expired, the question is live again
    await adapter.pictureOf('111@s.whatsapp.net');
    expect(fake.profilePictureUrl).toHaveBeenCalledTimes(2);
  });

  it('a THROWN lookup stays uncached — the very next ask retries', async () => {
    const { adapter, fake } = await linkedAdapter();
    fake.profilePictureUrl.mockRejectedValueOnce(new Error('rate limited'));
    expect(await adapter.pictureOf('222@s.whatsapp.net')).toBeUndefined();
    fake.profilePictureUrl.mockResolvedValueOnce('https://cdn.example/pic.jpg');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        headers: { get: () => 'image/jpeg' },
      })),
    );
    const picture = await adapter.pictureOf('222@s.whatsapp.net');
    expect(picture?.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    vi.unstubAllGlobals();
  });

  it('a fetched picture is cached — the second ask costs no round trip', async () => {
    const { adapter, fake } = await linkedAdapter();
    fake.profilePictureUrl.mockResolvedValue('https://cdn.example/pic.jpg');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([7]).buffer,
        headers: { get: () => 'image/jpeg' },
      })),
    );
    await adapter.pictureOf('333@s.whatsapp.net');
    await adapter.pictureOf('333@s.whatsapp.net');
    expect(fake.profilePictureUrl).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('caps concurrent lookups so a forty-row list is a queue, not a burst', async () => {
    // WhatsApp rate-limits these iqs; a burst of forty produces timeouts whose retries
    // re-enter the same burst. The cap turns first paint into a drip the server tolerates.
    const { adapter, fake } = await linkedAdapter();
    let inFlight = 0;
    let peak = 0;
    fake.profilePictureUrl.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return undefined;
    });
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => adapter.pictureOf(`${400 + i}@s.whatsapp.net`)),
    );
    expect(fake.profilePictureUrl).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

/**
 * SURVIVAL ACROSS A RESTART (ADR-0037 §1-2). The shell reaps the helper on exit — correctly
 * (one writer per session store) — which made every desktop restart a full, invisible
 * re-sync: all synced content lived in in-process Maps, and nothing reconnected until a
 * request arrived. Ask what survives (lessons.md 2026-08-17): the content must, via the
 * thread cache; and the CONNECTION must come back on its own, via boot resume.
 */
describe('the durable thread cache and boot resume', () => {
  it('restores the cached snapshot at creation, so chats exist before any sync', async () => {
    const seed = createThreadStore();
    seed.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    seed.ingest('111@s.whatsapp.net', { id: 'm1', from: '111@s.whatsapp.net', text: 'hi', ts: 5 }, { live: false });
    const cache = {
      load: vi.fn(() => ({ store: JSON.parse(JSON.stringify(seed.snapshot())), history: { complete: true, explicit: true, progress: 100 } })),
      save: vi.fn(),
    };
    const adapter = await createBaileysWaSocket({ authDir, threadCache: cache });
    expect(cache.load).toHaveBeenCalledTimes(1);
    expect(adapter.listChats().find((row) => row.jid === '111@s.whatsapp.net')?.name).toBe('Asha Rao');
    // The HISTORY STATE survived too: without it, a restored, fully-synced session would
    // report "still syncing" forever — the exact ambiguity lessons.md 2026-08-17 names.
    expect(adapter.historyState().complete).toBe(true);
  });

  it('saves a snapshot (debounced) after ingesting, carrying store AND history state', async () => {
    const cache = { load: vi.fn(() => undefined), save: vi.fn() };
    const { fake } = await linkedAdapter({ threadCache: cache, cacheDebounceMs: 10 });
    fake.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [
        {
          key: { id: 'H9', remoteJid: '555@s.whatsapp.net', fromMe: false },
          message: { conversation: 'persist me' },
          messageTimestamp: 9,
          pushName: 'Pat',
        },
      ],
      progress: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.save).toHaveBeenCalled();
    const payload = cache.save.mock.calls.at(-1)![0] as {
      store: { chats: unknown[] };
      history: { progress: number };
    };
    const revived = createThreadStore();
    revived.restore(payload.store);
    expect(revived.listChats().find((row) => row.jid === '555@s.whatsapp.net')?.name).toBe('Pat');
    expect(payload.history.progress).toBe(40);
  });

  it('resumes a completed pairing at boot, without waiting for any request', async () => {
    writeResumableCreds(authDir);
    await createBaileysWaSocket({ authDir });
    // The Baileys socket exists already: syncing continues in the background whether or not
    // Telepath (or the wizard) ever asks for anything.
    expect(created.length).toBe(1);
  });

  it('does NOT dial out at boot on a first run or a half-linked store', async () => {
    await createBaileysWaSocket({ authDir }); // empty dir: first run
    expect(created.length).toBe(0);
    writeFileSync(join(authDir, 'creds.json'), JSON.stringify({ me: { id: '1@s.whatsapp.net' } }));
    await createBaileysWaSocket({ authDir }); // half-linked: me without account/identities
    expect(created.length).toBe(0);
  });
});

/**
 * RESUME HONESTY (owner-reported on hardware, 2026-08-18). WhatsApp pushes history at
 * PAIRING; a resumed session gets new/offline messages but never a history re-push. So a
 * resume whose store is empty (lost cache, quarantined snapshot, pre-cache helper) would
 * show "still syncing 0%" FOREVER — a permanent state rendering as a normal wait, the exact
 * ambiguity lessons.md 2026-08-17 names. After a grace window with no history chunk, the
 * helper reports completion as INFERRED (`explicit:false` — the seat built for exactly
 * this claim), so the spinner retires and the app can say what actually happened.
 */
describe('resume without history', () => {
  it('reports INFERRED completion when a resumed session sees no history chunk', async () => {
    writeResumableCreds(authDir);
    const adapter = await createBaileysWaSocket({ authDir, resumeHistoryGraceMs: 10 });
    created.at(-1)!.emit('connection.update', { connection: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(adapter.historyState()).toEqual({ complete: true, explicit: false, progress: 100 });
  });

  it('a resumed session that DOES receive history keeps its real progress', async () => {
    writeResumableCreds(authDir);
    const adapter = await createBaileysWaSocket({ authDir, resumeHistoryGraceMs: 10 });
    const fake = created.at(-1)!;
    fake.emit('connection.update', { connection: 'open' });
    fake.emit('messaging-history.set', { chats: [], contacts: [], messages: [], progress: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const state = adapter.historyState();
    expect(state.complete).toBe(false);
    expect(state.progress).toBe(30);
  });

  it('a FRESH pairing keeps waiting for history — the grace applies to resumes only', async () => {
    const adapter = await createBaileysWaSocket({ authDir, resumeHistoryGraceMs: 10 });
    await adapter.startLink();
    created.at(-1)!.emit('connection.update', { connection: 'open' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(adapter.historyState().complete).toBe(false);
  });
});
