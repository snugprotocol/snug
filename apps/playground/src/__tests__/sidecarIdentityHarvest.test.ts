// sidecarIdentityHarvest.test.ts — TASK-20260820-host-pseudonymisation AC1 + AC2.
//
// THE INGRESS HALF of the R-9 backstop: the host observes every sidecar response at the
// ONE seat all three governed callers cross (`sidecarAppFetch` — app runtime, wizard
// probe, live pump) and harvests third-party identities into the directory the egress
// scrub reads. Two properties are load-bearing:
//
//  1. THE EXTRACTION IS THE SCRUB (the `syncStateFromChatsBody` rule): only names and
//     jids from KNOWN fields of the KNOWN name-bearing route (`/chats`) enter the
//     directory. Message text, previews, unknown keys, unknown routes — never. A
//     directory that ingested message bodies would itself become the leak.
//  2. NO SETTLE RACE: the in-memory directory is updated BEFORE the body is handed back,
//     so an app that fetches /chats and immediately sends an LLM wire cannot outrun the
//     harvest (fresh-context plan review 2026-08-20, finding 8b).
//
// Harvest scope mirrors the reference scrub's own map (examples/whatsapp/app.html
// `directory`): non-group chat names (a group SUBJECT is not a personal identifier, and
// common-word subjects like "News" would over-redact every sidecar app's wires),
// participant names, names ≥ 3 chars only, jid-placeholder names skipped — plus every
// jid, so the egress alternation catches spellings the jid pattern might not.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from '@snugprotocol/db';

import type { SnugPlatform } from '../platform/platform.js';

function desktopPlatform(seats: Partial<SnugPlatform> = {}): SnugPlatform {
  return {
    kind: 'desktop',
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
    sidecarCtl: async () => ({ running: true, nonce: 'n' }),
    ...seats,
  };
}

const CHATS_BODY = JSON.stringify({
  chats: [
    { jid: '911234567890@s.whatsapp.net', name: 'Priya Sharma', isGroup: false },
    {
      jid: 'g1@g.us',
      name: 'Weekend Plans',
      isGroup: true,
      participants: [
        { jid: '77771@lid', name: 'Rahul Verma' },
        { jid: '922222222222@s.whatsapp.net' },
      ],
    },
    // A jid-placeholder is NOT a name (the app's own rule: it would map raw jids as text).
    { jid: '913333333333@s.whatsapp.net', name: '913333333333@s.whatsapp.net', isGroup: false },
    // Too short to redact safely — the scrub skips < 3 chars, so harvesting it is noise.
    { jid: '944444444444@s.whatsapp.net', name: 'Al', isGroup: false },
    // Preview text rides chat rows; it is CONTENT, not identity.
    { jid: '955555555555@s.whatsapp.net', name: 'Sonia Rao', isGroup: false, lastMessage: { text: 'the secret sauce recipe' } },
  ],
  sync: { progress: 100, complete: true },
});

beforeEach(() => {
  vi.resetModules();
});

async function setup(body: string | ((path: string) => string)) {
  const { setPlatform } = await import('../platform/platform.js');
  const calls: string[] = [];
  setPlatform(
    desktopPlatform({
      sidecarFetch: async (method, path) => {
        calls.push(`${method} ${path}`);
        return { status: 200, body: typeof body === 'function' ? body(path) : body };
      },
    }),
  );
  const { installTestUserDb } = await import('./userdbTestHelper.js');
  const db = await installTestUserDb();
  const net = await import('../state/net.js');
  const identity = await import('../state/sidecarIdentity.js');
  return { db, net, identity, calls };
}

describe('the sidecar ingress harvest (AC1) — names and jids from /chats, nothing else', () => {
  it('holds names + jids immediately after the /chats response returns, and persists them', async () => {
    const { db, net, identity } = await setup(CHATS_BODY);

    await net.__sidecarAppFetchForTests('GET', '/chats');

    // IMMEDIATELY observable — no tick, no settle. The next call could be the LLM wire.
    const directory = identity.readIdentityDirectory(db);
    expect(directory).toContain('Priya Sharma');
    expect(directory).toContain('Rahul Verma');
    expect(directory).toContain('Sonia Rao');
    expect(directory).toContain('911234567890@s.whatsapp.net');
    expect(directory).toContain('77771@lid');
    expect(directory).toContain('922222222222@s.whatsapp.net');

    // Persisted under the one settings key, so a fresh session scrubs replayed data.
    const persisted = db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY);
    expect(persisted).toContain('Priya Sharma');
    expect(persisted).toContain('Rahul Verma');
  });

  it('never harvests group subjects, jid-placeholder names, short names, or preview text (AC2)', async () => {
    const { db, net, identity } = await setup(CHATS_BODY);

    await net.__sidecarAppFetchForTests('GET', '/chats');

    const everything = JSON.stringify([
      ...identity.readIdentityDirectory(db),
      db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY),
    ]);
    expect(everything, 'a group subject is not a personal identifier').not.toContain('Weekend Plans');
    expect(everything, 'a name shorter than 3 chars is never redacted, so never harvested').not.toContain('"Al"');
    expect(everything, 'message/preview text is content, never identity').not.toContain('secret sauce');
  });

  it('skips malformed bodies and unknown routes rather than repairing them (AC2)', async () => {
    const { db, net, identity } = await setup((path) =>
      path.startsWith('/chats/') ? JSON.stringify({ messages: [{ from: '966@lid', text: 'Meera Nair called', ts: 1 }] }) : 'not json {',
    );

    await net.__sidecarAppFetchForTests('GET', '/chats');
    expect(identity.readIdentityDirectory(db)).toHaveLength(0);

    // History rows carry jids only, and free text is content: the route is NOT harvested.
    await net.__sidecarAppFetchForTests('GET', '/chats/g1%40g.us/history');
    const directory = identity.readIdentityDirectory(db);
    expect(JSON.stringify([...directory])).not.toContain('Meera Nair');
    expect(directory).toHaveLength(0);
  });

  it('re-harvesting an unchanged body is a no-op write — the 4 s sync poll re-crosses this seat', async () => {
    const { db, net } = await setup(CHATS_BODY);
    const writes = vi.spyOn(db, 'setSetting');

    await net.__sidecarAppFetchForTests('GET', '/chats');
    await net.__sidecarAppFetchForTests('GET', '/chats');
    await net.__sidecarAppFetchForTests('GET', '/chats');

    const directoryWrites = writes.mock.calls.filter(([key]) => key === SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY);
    expect(directoryWrites, 'an unchanged /chats body must not rewrite the row per poll').toHaveLength(1);
  });

  it('C1: the harvest reads the response body ONLY — an injected header value never lands anywhere', async () => {
    const TOKEN = 'tok-SUPERSECRET-MINTED';
    const { db, net, identity } = await setup(CHATS_BODY);

    await net.__sidecarAppFetchForTests('GET', '/chats', undefined, { authorization: `Bearer ${TOKEN}` });

    const everything = JSON.stringify([
      ...identity.readIdentityDirectory(db),
      db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY),
    ]);
    expect(everything, 'C1: credential material must never enter the directory').not.toContain(TOKEN);
  });

  it('a harvest persistence failure keeps the in-memory directory — the session still scrubs', async () => {
    const { db, net, identity } = await setup(CHATS_BODY);
    vi.spyOn(db, 'setSetting').mockImplementation(() => {
      throw new Error('disk full');
    });

    // The fetch itself must survive: the app's read is not hostage to the write-behind.
    const result = await net.__sidecarAppFetchForTests('GET', '/chats');
    expect(result.status).toBe(200);
    expect(identity.readIdentityDirectory(db)).toContain('Priya Sharma');
  });
});
