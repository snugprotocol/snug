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

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  logout: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

const created = vi.hoisted(() => [] as FakeBaileysSocket[]);
/** The mocked auth store's writer — the forget tombstone must silence it (AC5). */
const saveCredsSpy = vi.hoisted(() => vi.fn(async () => {}));

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
      logout: vi.fn(async () => {}),
      end: vi.fn(async () => {}),
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
    useMultiFileAuthState: vi.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: saveCredsSpy })),
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
    expect(adapter.historyState()).toMatchObject({ complete: true, explicit: false, progress: 100 });
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

/**
 * PROACTIVE ROSTER LOADING + PROGRESS DETAIL (owner hardware walk 3, 2026-08-18).
 *
 * Rosters loaded only when the app happened to re-read `/chats`, and a failure waited for
 * the NEXT read to retry — on real hardware that meant 98 of 233 rosters after 14 minutes
 * and "no new names coming through". The helper now sweeps missing rosters itself on a
 * paced beat with bounded attempts, treats cache-restored rosters as already loaded, and
 * reports `{groups, rostersLoaded, names, messages}` on the sync state so the header can
 * show name-resolution progress as its own phase.
 */
describe('roster sweep and sync detail', () => {
  it('retries a failed roster on the sweep beat, without waiting for another list read', async () => {
    const { adapter, fake } = await linkedAdapter({ rosterSweepMs: 10, rosterRetryBaseMs: 5 });
    fake.groupMetadata
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({ subject: 'Healed', participants: [{ id: '555@s.whatsapp.net' }] });
    fake.emit('messaging-history.set', {
      chats: [{ id: 'g1@g.us', name: 'Healed' }],
      contacts: [],
      messages: [],
    });
    adapter.listChats(); // first attempt fails
    await new Promise((resolve) => setTimeout(resolve, 80)); // the sweep retries on its own
    const group = adapter.listChats().find((row) => row.jid === 'g1@g.us');
    expect(group?.participants).toEqual([{ jid: '555@s.whatsapp.net' }]);
    expect(fake.groupMetadata.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('BACKS OFF between retries — a throttle window must not burn every attempt', async () => {
    // On real hardware, retry-per-sweep-beat spent all attempts inside ~2 minutes of rate
    // limiting and wrote off 106 of 233 groups (hardware walk 4, 2026-08-18). Retries now
    // double their spacing per failure, so attempts outlive any plausible throttle window.
    const { adapter, fake } = await linkedAdapter({ rosterSweepMs: 5, rosterRetryBaseMs: 40 });
    fake.groupMetadata.mockRejectedValue(new Error('rate limited'));
    fake.emit('messaging-history.set', { chats: [{ id: 'g2@g.us', name: 'Slow' }], contacts: [], messages: [] });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 100 ms with base 40: the initial try, one retry at ~40, one at ~120 (not yet) — the
    // sweep beat alone (every 5 ms) would have made twenty.
    expect(fake.groupMetadata.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('a DEFINITIVE refusal writes the group off at once — no retry budget for the dead', async () => {
    // `item-not-found` / `forbidden` are answers, not weather: the group is gone or we
    // have no access (110 + 14 of the owner's 233 groups). Retrying them five times spent
    // real iq budget learning nothing.
    const { adapter, fake } = await linkedAdapter({ rosterSweepMs: 2, rosterRetryBaseMs: 1 });
    fake.groupMetadata.mockRejectedValue(new Error('item-not-found'));
    fake.emit('messaging-history.set', { chats: [{ id: 'g3@g.us', name: 'Dead' }], contacts: [], messages: [] });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.groupMetadata.mock.calls.length).toBe(1);
    // The consumer subtracts given-up groups from the target, so the pill CONVERGES on
    // what is achievable instead of stalling at n/m forever.
    expect(adapter.historyState().detail?.rostersGivenUp).toBe(1);
  });

  it("a THROTTLE pauses the whole sweep and never consumes a group's budget", async () => {
    // `rate-overlimit` is Meta's server saying "slow down" — 287 of them in one evening
    // burned the retry budgets of groups that were perfectly loadable. A throttle is
    // evidence about the MOMENT, not the group: pause everything, keep every attempt.
    const { adapter, fake } = await linkedAdapter({
      rosterSweepMs: 2,
      rosterRetryBaseMs: 1,
      rosterCooldownBaseMs: 60_000, // a long pause the test window never crosses
    });
    fake.groupMetadata.mockRejectedValue(new Error('rate-overlimit'));
    fake.emit('messaging-history.set', {
      chats: [
        { id: 'gA@g.us', name: 'A' },
        { id: 'gB@g.us', name: 'B' },
      ],
      contacts: [],
      messages: [],
    });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The first burst hits the wall; the cooldown then gates EVERYTHING — dozens of sweep
    // beats pass without another call, and nothing is written off.
    expect(fake.groupMetadata.mock.calls.length).toBeLessThanOrEqual(3);
    expect(adapter.historyState().detail?.rostersGivenUp).toBe(0);
  });

  it('persists the failure CLASSES to the cache, so a stalled sweep is diagnosable from disk', async () => {
    // A failing-only steady state used to write NOTHING (saves ride store changes), so the
    // cache aged silently while retries burned — the stall could only be guessed at.
    const cache = { load: vi.fn(() => undefined), save: vi.fn() };
    const { adapter, fake } = await linkedAdapter({
      threadCache: cache,
      cacheDebounceMs: 10,
      rosterSweepMs: 2,
      rosterRetryBaseMs: 1,
    });
    fake.groupMetadata.mockRejectedValue(new Error('item-not-found'));
    fake.emit('messaging-history.set', { chats: [{ id: 'g5@g.us', name: 'Gone' }], contacts: [], messages: [] });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const payload = cache.save.mock.calls.at(-1)?.[0] as {
      rosterDiagnostics?: { errors: Record<string, number> };
    };
    expect(payload?.rosterDiagnostics?.errors['item-not-found']).toBeGreaterThanOrEqual(1);
  });

  it('treats a cache-restored roster as loaded — no refetch burst at every boot', async () => {
    const seed = createThreadStore();
    seed.seedChatMeta('g3@g.us', { name: 'Restored', isGroup: true });
    seed.setGroupMetadata('g3@g.us', { subject: 'Restored', participants: [{ id: '111@s.whatsapp.net' }] });
    const cache = {
      load: () => ({ store: JSON.parse(JSON.stringify(seed.snapshot())), history: { complete: true, explicit: true, progress: 100 } }),
      save: vi.fn(),
    };
    const { adapter, fake } = await linkedAdapter({ threadCache: cache, rosterSweepMs: 5 });
    adapter.listChats();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fake.groupMetadata).not.toHaveBeenCalled();
  });

  it('reports sync DETAIL — groups, rosters loaded, names, messages — on the history state', async () => {
    const { adapter, fake } = await linkedAdapter();
    fake.groupMetadata.mockResolvedValue({ subject: 'Crew', participants: [{ id: '222@s.whatsapp.net', notify: 'Bo' }] });
    fake.emit('messaging-history.set', {
      chats: [{ id: 'g4@g.us', name: 'Crew' }],
      contacts: [{ id: '111@s.whatsapp.net', name: 'Asha' }],
      messages: [
        {
          key: { id: 'D1', remoteJid: '111@s.whatsapp.net', fromMe: false },
          message: { conversation: 'hi' },
          messageTimestamp: 5,
          pushName: 'Asha R',
        },
      ],
    });
    adapter.listChats();
    await flush();
    const detail = adapter.historyState().detail;
    expect(detail?.groups).toBe(1);
    expect(detail?.rostersLoaded).toBe(1);
    expect(detail?.names).toBeGreaterThanOrEqual(2); // Asha (contact) + Bo (roster push seat)
    expect(detail?.messages).toBe(1);
  });
});

/**
 * THE DEEP-DELETE UNLINK (TASK-20260821 AC5) and its persist tombstone.
 *
 * The dangerous half of `forget` is not the wipe — it is every write that can run AFTER
 * the wipe. The shell's reap is TERM-first precisely so the process-exit flush runs, and
 * that flush is the SAME `persistNow` the debounce path calls; a `creds.update` fired by
 * logout teardown reaches `saveCreds` the same way. Proving both writers dead through
 * their reachable paths is what proves the exit flush dead too (the 'exit' event itself
 * cannot be driven safely in-process).
 */
describe('forget — the deep-delete unlink (TASK-20260821 AC5)', () => {
  const historyRow = (id: string, ts: number): unknown => ({
    chats: [],
    contacts: [],
    messages: [
      {
        key: { id, remoteJid: '555@s.whatsapp.net', fromMe: false },
        message: { conversation: 'row' },
        messageTimestamp: ts,
        pushName: 'Pat',
      },
    ],
    progress: 10,
  });

  it('logs out, erases the auth dir, and the tombstone stops every later write', async () => {
    writeResumableCreds(authDir);
    writeFileSync(join(authDir, 'thread-cache.json'), 'cached-bytes');
    writeFileSync(join(authDir, 'session-123.json'), 'signal-session');
    const cache = { load: vi.fn(() => undefined), save: vi.fn() };
    // Capture the adapter's REAL process-exit flush: it registers `persistNow` on
    // 'exit', and that handler — not the debounce — is what the shell's TERM-first reap
    // exists to run. Simulating the exit means CALLING the registered listener; merely
    // letting timers elapse never reaches it (a first cut of this test proved exactly
    // that, by surviving a deleted tombstone guard).
    const listenersBefore = process.listeners('exit');
    const { adapter, fake } = await linkedAdapter({ threadCache: cache, cacheDebounceMs: 5 });
    const exitFlush = process.listeners('exit').find((l) => !listenersBefore.includes(l));
    if (exitFlush === undefined) throw new Error('the adapter registered no exit flush');
    // A debounced save is PENDING when forget arrives — the exact race the plan review
    // named: wipe, then the queued flush re-writes the cache into the wiped directory.
    fake.emit('messaging-history.set', historyRow('H1', 9));

    await adapter.forget();

    expect(fake.logout).toHaveBeenCalledTimes(1);
    expect(readdirSync(authDir)).toEqual([]);

    const savesAtWipe = cache.save.mock.calls.length;
    const credsSavesAtWipe = saveCredsSpy.mock.calls.length;
    // The pending debounce window elapses…
    await new Promise((resolve) => setTimeout(resolve, 40));
    // …new store mutations arrive (a late history chunk)…
    fake.emit('messaging-history.set', historyRow('H2', 10));
    await new Promise((resolve) => setTimeout(resolve, 40));
    // …a logout-teardown credential update fires…
    fake.emit('creds.update', {});
    // …and the process exits through the TERM path, running the REAL exit flush.
    (exitFlush as () => void)();

    expect(cache.save.mock.calls.length).toBe(savesAtWipe);
    expect(saveCredsSpy.mock.calls.length).toBe(credsSavesAtWipe);
    expect(readdirSync(authDir)).toEqual([]);
  });

  it('still erases the store when logout throws — an offline phone must not keep the disk dirty', async () => {
    writeResumableCreds(authDir);
    const { adapter, fake } = await linkedAdapter();
    fake.logout.mockRejectedValueOnce(new Error('offline'));

    await adapter.forget();

    expect(readdirSync(authDir)).toEqual([]);
    expect(adapter.linkState()).toBe('idle');
  });
});
