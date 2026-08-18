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

import { mkdtempSync, rmSync } from 'node:fs';
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
async function linkedAdapter() {
  const adapter = await createBaileysWaSocket({ authDir });
  await adapter.startLink();
  const fake = created.at(-1)!;
  fake.emit('connection.update', { connection: 'open' });
  return { adapter, fake };
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
