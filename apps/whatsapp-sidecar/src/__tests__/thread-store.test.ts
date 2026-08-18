/**
 * TASK-20260817-telepath Phase B (ADR-0034, review F4): the thread store — the piece of the
 * Baileys adapter that OWNS the unread counter and the chat-list metadata.
 *
 * Baileys reports unread only as a snapshot on synced conversations; nothing in the library
 * maintains a live counter. So the sidecar does, here, and the rules are worth their own
 * suite because every failure mode is silent: a counter that increments on the user's OWN
 * messages nags them about themselves; one that increments on history replay invents a
 * thousand unread; one that double-counts a deduped row inflates forever.
 */

import { describe, expect, it } from 'vitest';
import { createThreadStore } from '../thread-store.js';
import type { WaMessage } from '../wa-socket.js';

const msg = (id: string, ts: number, extra: Partial<WaMessage> = {}): WaMessage => ({
  id,
  from: 'them@s.whatsapp.net',
  text: `body ${id}`,
  ts,
  ...extra,
});

describe('the unread counter', () => {
  it('increments on a LIVE incoming message only', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 1), { live: false }); // history replay
    store.ingest('t@g.us', msg('m2', 2), { live: true });
    store.ingest('t@g.us', msg('m3', 3), { live: true });
    expect(store.listChats()[0]?.unreadCount).toBe(2);
  });

  it('never counts the user’s OWN sends as unread', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 1, { fromMe: true }), { live: true });
    expect(store.listChats()[0]?.unreadCount ?? 0).toBe(0);
  });

  it('a deduplicated row counts ZERO times more — history and live overlap', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 1), { live: true });
    store.ingest('t@g.us', msg('m1', 1), { live: true });
    expect(store.listChats()[0]?.unreadCount).toBe(1);
  });

  it('a snapshot seed OVERWRITES the running count — the phone’s read state wins', () => {
    // `chats.update` carrying unreadCount: 0 is how "I read it on my phone" arrives.
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 1), { live: true });
    store.ingest('t@g.us', msg('m2', 2), { live: true });
    store.seedChatMeta('t@g.us', { unreadCount: 0 });
    expect(store.listChats()[0]?.unreadCount).toBe(0);
    // …and the next live arrival counts from there, not from the stale total.
    store.ingest('t@g.us', msg('m3', 3), { live: true });
    expect(store.listChats()[0]?.unreadCount).toBe(1);
  });
});

describe('chat-list metadata', () => {
  it('tracks lastMessage and lastActivityTs by NEWEST timestamp, not arrival order', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m2', 20), { live: false });
    store.ingest('t@g.us', msg('m1', 10), { live: false }); // an older row arriving late
    const chat = store.listChats()[0]!;
    expect(chat.lastActivityTs).toBe(20);
    expect(chat.lastMessage?.text).toBe('body m2');
  });

  it('carries the image kind on lastMessage so the list can say “📷 Photo” honestly', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 1, { kind: 'image', text: '' }), { live: false });
    expect(store.listChats()[0]?.lastMessage?.kind).toBe('image');
  });

  it('a name learned later upgrades a jid-named chat and never downgrades a real name', () => {
    const store = createThreadStore();
    store.rememberChat('t@g.us');
    store.rememberChat('t@g.us', 'The Group');
    store.rememberChat('t@g.us', 'Imposter Rename'); // real names are not re-guessed
    expect(store.listChats()[0]?.name).toBe('The Group');
  });
});

describe('retention', () => {
  it('caps a thread at the configured size, evicting the OLDEST rows', () => {
    const store = createThreadStore(3);
    for (let i = 1; i <= 5; i += 1) store.ingest('t@g.us', msg(`m${i}`, i), { live: false });
    const rows = store.history('t@g.us')!.messages;
    expect(rows.map((row) => row.id)).toEqual(['m3', 'm4', 'm5']);
  });

  it('answers undefined for a thread it has never seen — unknown is not empty', () => {
    const store = createThreadStore();
    expect(store.history('nope@g.us')).toBeUndefined();
    expect(store.messagesSince('nope@g.us')).toBeUndefined();
  });

  it('filters messagesSince strictly AFTER the watermark', () => {
    const store = createThreadStore();
    store.ingest('t@g.us', msg('m1', 10), { live: false });
    store.ingest('t@g.us', msg('m2', 20), { live: false });
    expect(store.messagesSince('t@g.us', 10)?.map((row) => row.id)).toEqual(['m2']);
  });
});
