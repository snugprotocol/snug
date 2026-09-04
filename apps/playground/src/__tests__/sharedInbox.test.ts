// sharedInbox.test.ts — TASK-20260904-app-sharing AC14/AC16 (the shelf's semantics).
//
// Memory-first: a received bundle sits in the module store; only an explicit act
// (persist: true) writes a `sharedApp:` row. The cap refuses the 13th with a note,
// never evicts. Identity is recomputed from bytes on hydrate, so a hand-edited row
// under the wrong key is dropped rather than shown. And nothing on the shelf ever
// creates an app/version/connection/doc/migration row until install (the table sweep).

import { APP_BUNDLE_FORMAT, appBundleId, appBundleSchema } from '@snugprotocol/protocol';
import { SHARED_APP_SETTING_PREFIX, sharedAppSettingKey } from '@snugprotocol/db';
import type { UserDb } from '@snugprotocol/db';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_SHARED_INBOX,
  __resetSharedInboxForTests,
  bundleIdFromSharedRouteId,
  hydrateSharedInbox,
  isSharedId,
  isUnownedId,
  keepSharedEntry,
  listSharedEntries,
  receiveSharedBundle,
  removeSharedEntry,
  sharedInboxNoteStore,
  sharedRouteIdFor,
} from '../share/sharedInbox.js';
import { installTestUserDb } from './userdbTestHelper.js';

const LINEAGE = '0b6e5a1c-8d5e-4f13-9a2b-7c1d2e3f4a5b';

function bundleText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: APP_BUNDLE_FORMAT,
    lineage: LINEAGE,
    sharedAt: '2026-09-04T01:00:00.000Z',
    app: { displayName: 'Weather Wall', usesDb: false },
    html: '<!doctype html><html><body>hi</body></html>',
    connections: [],
    ...overrides,
  });
}

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __resetSharedInboxForTests();
});

describe('receiveSharedBundle — memory first, persisted on an explicit act', () => {
  it('a link visit (persist: false) lands in memory only — no settings row', async () => {
    const result = await receiveSharedBundle(bundleText(), { source: 'link', persist: false });
    expect(result.ok).toBe(true);
    expect(listSharedEntries()).toHaveLength(1);
    expect(listSharedEntries()[0]?.kept).toBe(false);
    expect(db.listSettingKeys().filter((k) => k.startsWith(SHARED_APP_SETTING_PREFIX))).toEqual([]);
  });

  it('an opened attachment (persist: true) writes the row under the CONTENT id', async () => {
    const result = await receiveSharedBundle(bundleText(), { source: 'file', persist: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.kept).toBe(true);
    const expectedId = await appBundleId(appBundleSchema.parse(JSON.parse(bundleText())));
    expect(result.entry.bundleId).toBe(expectedId);
    expect(db.getSetting(sharedAppSettingKey(expectedId))).toMatchObject({ source: 'file' });
  });

  it('keep promotes a memory entry to the file; remove deletes both', async () => {
    const received = await receiveSharedBundle(bundleText(), { source: 'link', persist: false });
    if (!received.ok) throw new Error('receive failed');
    const kept = await keepSharedEntry(received.entry.bundleId);
    expect(kept?.kept).toBe(true);
    expect(db.getSetting(sharedAppSettingKey(received.entry.bundleId))).toBeDefined();
    await removeSharedEntry(received.entry.bundleId);
    expect(listSharedEntries()).toEqual([]);
    expect(db.getSetting(sharedAppSettingKey(received.entry.bundleId))).toBeUndefined();
  });

  it('the same bundle twice is one entry (duplicate: true), and a persisting re-receipt keeps it', async () => {
    const first = await receiveSharedBundle(bundleText(), { source: 'link', persist: false });
    const second = await receiveSharedBundle(bundleText(), { source: 'file', persist: true });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.entry.bundleId).toBe(first.entry.bundleId);
    expect(listSharedEntries()).toHaveLength(1);
    expect(listSharedEntries()[0]?.kept).toBe(true);
  });

  it('names the refusal: not-a-bundle, not-json, invalid, too-large', async () => {
    expect((await receiveSharedBundle('{"hello":1}', { source: 'file', persist: true })).ok).toBe(false);
    expect((await receiveSharedBundle('nope', { source: 'file', persist: true })).ok).toBe(false);
    const invalid = await receiveSharedBundle(bundleText({ html: '' }), { source: 'file', persist: true });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.reason).toBe('invalid');
    expect(listSharedEntries()).toEqual([]);
  });

  it('refuses the 13th with a note — never evicts a share the user has not seen (finding 21)', async () => {
    for (let i = 0; i < MAX_SHARED_INBOX; i++) {
      const result = await receiveSharedBundle(bundleText({ app: { displayName: `App ${i}`, usesDb: false } }), {
        source: 'link',
        persist: false,
      });
      expect(result.ok, `bundle ${i}`).toBe(true);
    }
    const thirteenth = await receiveSharedBundle(bundleText({ app: { displayName: 'App 13', usesDb: false } }), {
      source: 'link',
      persist: false,
    });
    expect(thirteenth.ok).toBe(false);
    if (!thirteenth.ok) expect(thirteenth.reason).toBe('shelf-full');
    expect(listSharedEntries()).toHaveLength(MAX_SHARED_INBOX);
    expect(listSharedEntries()[0]?.bundle.app.displayName).toBe('App 0');
  });
});

describe('hydrateSharedInbox — the file is the truth for kept rows', () => {
  it('reads kept rows back, keeps memory-only entries, drops a row whose bytes do not match its key, and leaves an unparseable row alone (finding 11)', async () => {
    const kept = await receiveSharedBundle(bundleText(), { source: 'file', persist: true });
    const memoryOnly = await receiveSharedBundle(bundleText({ app: { displayName: 'Link Only', usesDb: false } }), {
      source: 'link',
      persist: false,
    });
    if (!kept.ok || !memoryOnly.ok) throw new Error('setup');
    // A forged row: someone's bundle stored under a different id.
    db.setSetting(sharedAppSettingKey('f'.repeat(64)), { text: bundleText({ app: { displayName: 'Forged', usesDb: false } }), receivedAt: 'x', source: 'file' });
    // A damaged row.
    db.setSetting(sharedAppSettingKey('e'.repeat(64)), { text: 'garbage' });
    await hydrateSharedInbox();
    const names = listSharedEntries().map((e) => e.bundle.app.displayName).sort();
    expect(names).toEqual(['Link Only', 'Weather Wall']);
    expect(db.getSetting(sharedAppSettingKey('f'.repeat(64)))).toBeUndefined();
    // A row THIS build cannot parse may be a newer format a newer hub reads — invisible
    // here, never deleted (the hydrate runs after every sync pull and would sync the
    // deletion back).
    expect(db.getSetting(sharedAppSettingKey('e'.repeat(64)))).toBeDefined();
    expect(sharedInboxNoteStore.get()).toBeNull();
  });
});

describe('(N) a received bundle is inert until install (AC16)', () => {
  it('writes no app, version, connection, doc or migration row and runs no DDL', async () => {
    const hostile = bundleText({
      app: { displayName: '<img src=x onerror=alert(1)>', usesDb: true },
      html: '<html><script>fetch("https://evil.example")</script></html>',
      schema: { ddl: ['CREATE TABLE t (id INTEGER)'] },
      docs: [{ slug: 'vision', content: '<img src=x onerror=alert(1)>' }],
      connections: [
        {
          slot: 'x',
          provider: { name: 'Evil' },
          kind: 'api_key',
          fields: [{ key: 'k', label: 'Paste your password', type: 'secret' }],
          declaredApiHosts: ['evil.example'],
        },
      ],
    });
    const result = await receiveSharedBundle(hostile, { source: 'file', persist: true });
    expect(result.ok).toBe(true);
    expect(db.listApps()).toEqual([]);
    expect(db.listConnections()).toEqual([]);
    // No app id exists to hold docs, versions or migrations — the only row is the shelf row.
    const keys = db.listSettingKeys();
    expect(keys.filter((k) => k.startsWith(SHARED_APP_SETTING_PREFIX))).toHaveLength(1);
  });
});

describe('route ids', () => {
  it('shared-- ids are unowned, decode to a 64-hex bundle id only, and never collide with starters', () => {
    const id = sharedRouteIdFor('a'.repeat(64));
    expect(isSharedId(id)).toBe(true);
    expect(isUnownedId(id)).toBe(true);
    expect(isUnownedId('starter--chess')).toBe(true);
    expect(isUnownedId('some-uuid')).toBe(false);
    expect(bundleIdFromSharedRouteId(id)).toBe('a'.repeat(64));
    expect(bundleIdFromSharedRouteId('shared--not-hex')).toBeUndefined();
    expect(bundleIdFromSharedRouteId('starter--chess')).toBeUndefined();
  });
});
