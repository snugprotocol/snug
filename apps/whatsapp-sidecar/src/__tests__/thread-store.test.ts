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

// ============================ the contact directory ============================
//
// OWNER-REPORTED, 2026-08-17: Telepath showed no contact names, no group participant
// names, and "random phone numbers which are not even correct". Three causes, all here:
//
//   (1) `messaging-history.set` carries `contacts` — the address book — and the adapter
//       read only `chats` and `messages`. So the ONLY name a chat could ever have was the
//       one WhatsApp happened to put on the conversation row.
//   (2) Group participants were never populated at all, so every group message fell back
//       to its sender id.
//   (3) WhatsApp now addresses people by LID (`123456@lid`) — an INTERNAL id that is not a
//       phone number. Rendering its digits produced a plausible-looking wrong number, which
//       is worse than showing nothing: it invites the user to trust it.

describe('the contact directory', () => {
  it('prefers the name YOU saved, then verifiedName, then their own notify name', () => {
    // MIGRATED 2026-08-18: notify and verifiedName swapped places so the row-internal
    // order matches the tier order (contact > verified > push). The old order made a
    // business row carrying both learn "~acme team" at push tier — and the discarded
    // verified name could then never displace it. The saved-name-first claim, and the
    // never-invent claim below, are unchanged.
    const store = createThreadStore();
    store.rememberContacts([
      { id: '111@s.whatsapp.net', name: 'Asha (work)', notify: 'Asha R', verifiedName: 'Asha Rao Ltd' },
      { id: '222@s.whatsapp.net', notify: 'bo from accounts', verifiedName: 'Bo Chen Inc' },
      { id: '333@s.whatsapp.net', verifiedName: 'Chai Corner' },
      { id: '444@s.whatsapp.net', notify: 'Dee' },
    ]);
    expect(store.contactName('111@s.whatsapp.net')).toBe('Asha (work)');
    expect(store.contactName('222@s.whatsapp.net')).toBe('Bo Chen Inc');
    expect(store.contactName('333@s.whatsapp.net')).toBe('Chai Corner');
    expect(store.contactName('444@s.whatsapp.net')).toBe('Dee');
  });

  it('never invents a name for an unknown id', () => {
    const store = createThreadStore();
    expect(store.contactName('999@s.whatsapp.net')).toBeUndefined();
  });

  it('resolves a LID to the same person as their phone-number jid', () => {
    // THE "WRONG NUMBER" BUG. A message addressed from `77771@lid` is Asha; without the
    // mapping the UI printed "+77771", a number that belongs to nobody.
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    store.rememberLidMappings([{ lid: '77771@lid', pn: '111@s.whatsapp.net' }]);
    expect(store.contactName('77771@lid')).toBe('Asha Rao');
    expect(store.resolveIdentity('77771@lid')).toBe('111@s.whatsapp.net');
  });

  it('reads a contact whose own row carries the lid seat', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '88881@lid', lid: '88881@lid', phoneNumber: '222@s.whatsapp.net', name: 'Bo Chen' }]);
    expect(store.contactName('88881@lid')).toBe('Bo Chen');
    expect(store.contactName('222@s.whatsapp.net')).toBe('Bo Chen');
  });

  it('a later contacts.update refines a name without erasing a known one', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    store.rememberContacts([{ id: '111@s.whatsapp.net' }]); // an update carrying no name
    expect(store.contactName('111@s.whatsapp.net')).toBe('Asha Rao');
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao (mobile)' }]);
    expect(store.contactName('111@s.whatsapp.net')).toBe('Asha Rao (mobile)');
  });

  it('names a DM chat from the contact directory, not just the conversation row', () => {
    const store = createThreadStore();
    store.ingest('111@s.whatsapp.net', msg('m1', 1), { live: false });
    expect(store.listChats()[0]?.name).toBe('111@s.whatsapp.net'); // nothing known yet
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    expect(store.listChats()[0]?.name).toBe('Asha Rao');
  });

  it('carries group participants WITH their names, so a group renders senders', () => {
    const store = createThreadStore();
    store.rememberContacts([
      { id: '111@s.whatsapp.net', name: 'Asha Rao' },
      { id: '222@s.whatsapp.net', notify: 'Bo' },
    ]);
    store.setGroupMetadata('g1@g.us', {
      subject: 'Trip planning',
      participants: [{ id: '111@s.whatsapp.net' }, { id: '222@s.whatsapp.net' }, { id: '333@s.whatsapp.net' }],
    });
    const chat = store.listChats().find((row) => row.jid === 'g1@g.us')!;
    expect(chat.name).toBe('Trip planning');
    expect(chat.isGroup).toBe(true);
    // MIGRATED 2026-08-18: a notify-sourced name now also carries `nameKind: 'push'`, so the
    // consumer can render WhatsApp's ~convention. The original claim — names ride the roster,
    // an unknown gets NO seat, never a fabrication — is unchanged.
    expect(chat.participants).toEqual([
      { jid: '111@s.whatsapp.net', name: 'Asha Rao' },
      { jid: '222@s.whatsapp.net', name: 'Bo', nameKind: 'push' },
      { jid: '333@s.whatsapp.net' }, // unknown: no name seat at all, never a fabricated one
    ]);
  });

  // ---- the push-name tier (owner report 2026-08-18: "most participants show Unknown
  // contact"; the fix harvests `pushName` from every message row, which makes tier rules
  // load-bearing: a self-set name must never displace the one the USER saved).

  it('a push name fills a gap but never downgrades a saved name', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha (work)' }]);
    // The message-harvest spelling: a bare notify row, as `ingest` feeds it.
    store.rememberContacts([{ id: '111@s.whatsapp.net', notify: 'asha ✨' }]);
    expect(store.contactName('111@s.whatsapp.net')).toBe('Asha (work)');
    // And the gap-filling half: an identity with no saved name takes the push name.
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo' }]);
    expect(store.contactName('222@s.whatsapp.net')).toBe('Bo');
  });

  it('a saved name arriving later upgrades a push name', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo' }]);
    store.rememberContacts([{ id: '222@s.whatsapp.net', name: 'Robert Chen' }]);
    expect(store.contactName('222@s.whatsapp.net')).toBe('Robert Chen');
  });

  it('a newer push name replaces an older push name — people rename themselves', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo' }]);
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo 🌊' }]);
    expect(store.contactName('222@s.whatsapp.net')).toBe('Bo 🌊');
  });

  it('round-trips through snapshot/restore — the durable cache seat (ADR-0037)', () => {
    // Every desktop restart used to be a full, invisible re-sync because all of this lived
    // in in-process Maps. The snapshot must carry EVERY table a restart needs: chats (with
    // meta), messages, the name directory WITH its tiers, LID mappings, and group rosters —
    // through JSON, because that is how it crosses the disk.
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo' }]);
    store.rememberLidMappings([{ lid: '77771@lid', pn: '111@s.whatsapp.net' }]);
    store.setGroupMetadata('g1@g.us', {
      subject: 'Trip',
      participants: [{ id: '111@s.whatsapp.net' }, { id: '222@s.whatsapp.net' }],
    });
    store.ingest('g1@g.us', msg('m1', 10), { live: false });
    store.ingest('111@s.whatsapp.net', msg('m2', 20), { live: true });

    const revived = createThreadStore();
    revived.restore(JSON.parse(JSON.stringify(store.snapshot())));

    expect(revived.listChats()).toEqual(store.listChats());
    expect(revived.history('g1@g.us')).toEqual(store.history('g1@g.us'));
    expect(revived.contactName('77771@lid')).toBe('Asha Rao');
    // The TIER survived too: a push name arriving after restore must still not displace
    // the restored saved name.
    revived.rememberContacts([{ id: '111@s.whatsapp.net', notify: 'asha ✨' }]);
    expect(revived.contactName('111@s.whatsapp.net')).toBe('Asha Rao');
  });

  it('restore tolerates junk without throwing and without inventing state', () => {
    const store = createThreadStore();
    store.restore(undefined);
    store.restore(null);
    store.restore('garbage');
    store.restore({ chats: 'not-an-array', messages: 42 });
    expect(store.listChats()).toEqual([]);
  });

  it('restore refuses a name entry whose kind is a PROTOTYPE key, not a real tier', () => {
    // `'toString' in NAME_TIER` is true — `in` walks the prototype chain — so a corrupt
    // file could smuggle an entry whose tier comparisons are NaN-shaped and break the
    // tier invariant in both directions (review finding 2026-08-18).
    const store = createThreadStore();
    store.restore({ names: [['111@s.whatsapp.net', { name: 'junk', kind: 'toString' }]] });
    expect(store.contactName('111@s.whatsapp.net')).toBeUndefined();
    // A real tier restores fine beside it.
    store.restore({ names: [['111@s.whatsapp.net', { name: 'Asha', kind: 'contact' }]] });
    expect(store.contactName('111@s.whatsapp.net')).toBe('Asha');
  });

  it('a DM chat named only by push name says so, and sheds the mark when a saved name lands', () => {
    // `nameKind: 'push'` is how the app renders WhatsApp's ~convention; it must appear ONLY
    // for push-sourced names — a saved name carrying it would print a spurious ~.
    const store = createThreadStore();
    store.ingest('222@s.whatsapp.net', msg('m1', 1), { live: false });
    store.rememberContacts([{ id: '222@s.whatsapp.net', notify: 'Bo' }]);
    const pushNamed = store.listChats().find((row) => row.jid === '222@s.whatsapp.net')!;
    expect(pushNamed.name).toBe('Bo');
    expect(pushNamed.nameKind).toBe('push');
    store.rememberContacts([{ id: '222@s.whatsapp.net', name: 'Robert Chen' }]);
    const saved = store.listChats().find((row) => row.jid === '222@s.whatsapp.net')!;
    expect(saved.name).toBe('Robert Chen');
    expect(saved).not.toHaveProperty('nameKind');
  });

  it('pairs a roster-shaped row (LID id + phoneNumber seat) so saved names reach LID seats', () => {
    // THE HARDWARE FINDING (owner, 2026-08-18, second walk): 1,079 of 1,677 roster seats
    // were unmapped LIDs. `groupMetadata` participants carry `phoneNumber` beside a LID id
    // (groups.js:337) — the mapping was in our hands. A row whose ID is itself the LID
    // must pair with its phoneNumber seat even with no explicit `lid` seat.
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    store.rememberContacts([{ id: '77771@lid', phoneNumber: '111@s.whatsapp.net' }]);
    expect(store.contactName('77771@lid')).toBe('Asha Rao');
    expect(store.resolveIdentity('77771@lid')).toBe('111@s.whatsapp.net');
    // And through a roster: the participant seat gets the saved name.
    store.setGroupMetadata('g1@g.us', { subject: 'Trip', participants: [{ id: '77771@lid' }] });
    expect(store.listChats().find((c) => c.jid === 'g1@g.us')?.participants).toEqual([
      { jid: '77771@lid', name: 'Asha Rao' },
    ]);
  });

  it('a new pairing carries names ACROSS spellings — a group-learned name reaches the DM', () => {
    // HARDWARE WALK 6 (owner: "none of the individual chats has a name"): push names from
    // GROUP messages land under the sender's LID spelling, while the DM with that person is
    // keyed by phone number. The pairing alone recorded the link but copied nothing, so the
    // lookup missed in both directions and the DM stayed a bare +number.
    const store = createThreadStore();
    store.ingest('111@s.whatsapp.net', msg('m1', 5), { live: false }); // the DM, keyed by PN
    store.rememberContacts([{ id: '77771@lid', notify: 'Asha ✨' }]); // named via a group row
    expect(store.listChats()[0]?.name).toBe('111@s.whatsapp.net'); // not joinable yet
    store.rememberContacts([{ id: '77771@lid', phoneNumber: '111@s.whatsapp.net' }]); // the pairing
    const chat = store.listChats()[0]!;
    expect(chat.name).toBe('Asha ✨');
    expect(chat.nameKind).toBe('push');
    // And the reverse direction: a PN-keyed name covers the LID seat.
    const reverse = createThreadStore();
    reverse.rememberContacts([{ id: '222@s.whatsapp.net', name: 'Bo Saved' }]);
    reverse.rememberContacts([{ id: '88881@lid', phoneNumber: '222@s.whatsapp.net' }]);
    expect(reverse.contactName('88881@lid')).toBe('Bo Saved');
  });

  it('maps a group participant given by LID onto the contact behind it', () => {
    const store = createThreadStore();
    store.rememberContacts([{ id: '111@s.whatsapp.net', name: 'Asha Rao' }]);
    store.rememberLidMappings([{ lid: '77771@lid', pn: '111@s.whatsapp.net' }]);
    store.setGroupMetadata('g1@g.us', { subject: 'Trip', participants: [{ id: '77771@lid' }] });
    expect(store.listChats()[0]?.participants).toEqual([{ jid: '77771@lid', name: 'Asha Rao' }]);
  });
});
