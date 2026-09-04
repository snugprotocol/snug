// app-bundle.test.ts — TASK-20260904-app-sharing, Phase 1.3 (ADR-0063).
//
// The db half of sharing: BUILD a bundle from one app in the user file (AC2–AC4),
// INSTALL a bundle as a new app (AC6), UPDATE an installed lineage from a newer bundle
// (AC12), the settings-key cascade (lesson 2026-08-18), and the first-bytes sniff that
// tells a bundle from a user file (AC14/AC15).
//
// The C1 test is a BYTE SCAN over the serialized bundle, not a field check: the thing
// that must never leave the file is a credential VALUE, and the only assertion that proves
// a value is absent is searching the bytes for it.

import {
  APP_BUNDLE_FORMAT,
  CONTAINER,
  type AppBundle,
  type ConnectionRequirement,
  appBundleSchema,
} from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import {
  buildAppBundle,
  installAppFromBundle,
  sniffSnugFile,
  updateAppFromBundle,
  type AppBundleInstallResult,
} from '../app-bundle.js';
import { shareLinkSettingKey, sharedBundleSettingKey } from '../app-settings-keys.js';
import { authConnectionCredentialSecretKey } from '../auth-secrets.js';
import { openUserDb, type ConnectionAdmissionGate, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

const SECRET_VALUE = 'sk-live-THIS-MUST-NEVER-TRAVEL-9f8e7d6c';
const V1_HTML = '<!doctype html><html><body>version one — OLD BYTES</body></html>';
const V2_HTML = '<!doctype html><html><body>version two — current</body></html>';

const weather: ConnectionRequirement = {
  slot: 'weather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  declaredApiHosts: ['api.openweathermap.org'],
};

const lanBridge: ConnectionRequirement = {
  slot: 'bridge',
  provider: { name: 'Some Bridge' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'Bridge key', type: 'secret' }],
  lanHost: { class: 'rfc1918-ipv4-literal', label: 'bridge address' },
  declaredApiHosts: ['192.168.1.20'],
};

const withUserLayer = {
  slot: 'org',
  provider: { name: 'Org Layer' },
  kind: 'oauth2_auth_code' as const,
  endpoints: { authorizeUrl: 'https://org.example/auth', tokenUrl: 'https://org.example/token' },
  declaredApiHosts: ['api.org.example'],
  userLayer: {
    kind: 'oauth2_auth_code' as const,
    provider: { name: 'Org Layer' },
    endpoints: { authorizeUrl: 'https://org.example/auth', tokenUrl: 'https://org.example/token' },
    clientCreds: [{ key: 'client_id', label: 'Client ID', type: 'text' as const }],
    declaredApiHosts: ['api.org.example'],
  },
};

async function open(admissionGate?: ConnectionAdmissionGate): Promise<UserDb> {
  backend = createMemoryBackend();
  const result = await openUserDb({
    backend,
    locateWasm,
    persistDebounceMs: 1,
    ...(admissionGate !== undefined ? { admissionGate } : {}),
  });
  if (result.status !== 'ok') throw new Error('open failed');
  return result.userDb;
}

/** A fully-furnished sharer's app: two versions, a contract, DDL, docs, three connections, secrets, chat, settings. */
async function furnishSharerApp(target: UserDb): Promise<string> {
  const app = target.installApp({
    displayName: 'Weather Wall',
    description: 'A wall of weather.',
    iconEmoji: '🌦',
    iconColor: '#3366ff',
    usesDb: true,
    html: V1_HTML,
  });
  target.saveAppVersion(app.appId, V2_HTML, 'second version');
  target.putRuntimeContract(app.appId, 2, { overview: 'A weather wall. Summarize the forecast in one sentence.' });
  await target.applyAppDdl(app.appId, ['CREATE TABLE readings (id INTEGER PRIMARY KEY, temp REAL)']);
  target.putAppDoc(app.appId, 'vision', { title: 'Vision', content: '# Vision\n\nA wall of weather.' });
  target.putAppDoc(app.appId, 'plan', { content: 'Plan: fetch, render.' });
  target.putAppDoc(app.appId, 'memory', { content: 'User prefers Celsius. Lives in Oslo.' });
  target.putDeclaredConnection(app.appId, 'weather', weather, 'inference');
  target.approveConnection(app.appId, 'weather');
  target.setSecret(authConnectionCredentialSecretKey(app.appId, 'weather', 'api_key'), SECRET_VALUE);
  target.putDeclaredConnection(app.appId, 'bridge', lanBridge, 'user');
  target.putDeclaredConnection(app.appId, 'org', withUserLayer, 'registry');
  target.putDeclaredConnection(app.appId, 'gone', { ...weather, slot: 'gone', provider: { name: 'Gone Provider' } }, 'inference');
  target.approveConnection(app.appId, 'gone');
  target.revokeConnection(app.appId, 'gone');
  target.upsertThread('t1', { appId: app.appId, title: 'chat about the wall' });
  target.appendChatMessage('t1', 'user', 'PRIVATE CHAT CONTENT about my apartment');
  target.setSetting(`appModel:${app.appId}`, 'claude-private-pick');
  return app.appId;
}

beforeEach(async () => {
  db = await open();
});

// ------------------------------------------------------------------ AC2–AC4: build

describe('buildAppBundle — what travels', () => {
  it('carries the current version only, its contract, the registered DDL, the requested docs and non-revoked requirement halves (AC2)', async () => {
    const appId = await furnishSharerApp(db);
    const bundle = await buildAppBundle(db, appId, { docs: ['vision', 'plan'], hubVersion: '0.1.2' });
    expect(appBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.format).toBe(APP_BUNDLE_FORMAT);
    expect(bundle.lineage).toBe(appId);
    expect(bundle.app).toEqual({
      displayName: 'Weather Wall',
      description: 'A wall of weather.',
      iconEmoji: '🌦',
      iconColor: '#3366ff',
      usesDb: true,
    });
    expect(bundle.html).toBe(V2_HTML);
    expect(bundle.contract?.overview).toContain('weather wall');
    expect(bundle.schema?.ddl.some((ddl) => /CREATE TABLE readings/i.test(ddl))).toBe(true);
    expect(bundle.docs?.map((doc) => doc.slug)).toEqual(['vision', 'plan']);
    expect(bundle.docs?.[0]).toEqual({ slug: 'vision', title: 'Vision', content: '# Vision\n\nA wall of weather.' });
    expect(bundle.connections.map((c) => c.slot).sort()).toEqual(['bridge', 'org', 'weather']);
    expect(bundle.producer?.hubVersion).toBe('0.1.2');
    expect(bundle.sharedAt).toMatch(/Z$/);
  });

  it('(N, C1) the serialized bundle carries no secret value, no grant field, no history, no chat, no settings (AC3)', async () => {
    const appId = await furnishSharerApp(db);
    const bundle = await buildAppBundle(db, appId, { docs: ['vision', 'plan', 'memory'] });
    const bytes = JSON.stringify(bundle);
    for (const forbidden of [
      SECRET_VALUE,
      'OLD BYTES',
      'allowed_hosts',
      'allowedHosts',
      'approved_at',
      'approvedAt',
      '"status"',
      'pending_requirement',
      '"imported"',
      '"confidence"',
      'PRIVATE CHAT CONTENT',
      'chat about the wall',
      'claude-private-pick',
      'Gone Provider',
      'install_source',
      'installSource',
    ]) {
      expect(bytes, `bundle bytes contain "${forbidden}"`).not.toContain(forbidden);
    }
  });

  it('(N) strips the collected LAN address and any userLayer (AC4)', async () => {
    const appId = await furnishSharerApp(db);
    const bundle = await buildAppBundle(db, appId, { docs: [] });
    const bridge = bundle.connections.find((c) => c.slot === 'bridge');
    expect(bridge?.lanHost).toEqual({ class: 'rfc1918-ipv4-literal', label: 'bridge address' });
    expect(bridge?.declaredApiHosts).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('192.168.1.20');
    const org = bundle.connections.find((c) => c.slot === 'org');
    expect(org).toBeDefined();
    expect(org?.userLayer).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain('userLayer');
  });

  it('applies the caller’s connection reducer (the bare-borrower hook the playground fills with the registry)', async () => {
    const appId = await furnishSharerApp(db);
    const bundle = await buildAppBundle(db, appId, {
      docs: [],
      reduceConnection: (requirement) =>
        requirement.slot === 'weather'
          ? { slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', declaredApiHosts: ['api.openweathermap.org'] }
          : requirement,
    });
    const w = bundle.connections.find((c) => c.slot === 'weather');
    expect(w?.fields).toBeUndefined();
    expect(w?.declaredApiHosts).toEqual(['api.openweathermap.org']);
  });

  it('flushes pending app writes so the DDL is current, and skips docs whose slug cannot travel (naming them)', async () => {
    const appId = await furnishSharerApp(db);
    db.putAppDoc(appId, 'Bad Slug', { content: 'not portable' });
    const bundle = await buildAppBundle(db, appId, { docs: ['vision', 'Bad Slug'] });
    expect(bundle.docs?.map((d) => d.slug)).toEqual(['vision']);
  });

  it('refuses an unknown app', async () => {
    await expect(buildAppBundle(db, 'nope', { docs: [] })).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------- AC6: install

async function sharerBundle(docs: string[] = ['vision', 'plan']): Promise<AppBundle> {
  const sharer = await open();
  const appId = await furnishSharerApp(sharer);
  const bundle = await buildAppBundle(sharer, appId, { docs });
  await sharer.close();
  return bundle;
}

describe('installAppFromBundle — the share act (AC6)', () => {
  let bundle: AppBundle;
  let result: AppBundleInstallResult;

  beforeEach(async () => {
    bundle = await sharerBundle();
    db = await open();
    result = await installAppFromBundle(db, bundle, { bundleId: 'b'.repeat(64) });
  });

  it('creates the app with install_source share:<lineage>, v1 pinned, html and identity copied', () => {
    expect(result.status).toBe('installed');
    const app = db.getApp(result.appId);
    expect(app?.installSource).toBe(`share:${bundle.lineage}`);
    expect(app?.displayName).toBe('Weather Wall');
    expect(app?.description).toBe('A wall of weather.');
    expect(app?.iconEmoji).toBe('🌦');
    expect(app?.usesDb).toBe(true);
    expect(db.getAppHtml(result.appId)).toBe(V2_HTML);
    expect(db.listAppVersions(result.appId)).toEqual([expect.objectContaining({ version: 1, pinned: true })]);
  });

  it('writes the contract on v1 and replays the DDL into the app’s own runtime (schema registered)', () => {
    expect(db.getRuntimeContract(result.appId, 1)?.overview).toContain('weather wall');
    expect(db.getAppSchema(result.appId)?.objects.some((o) => o.name === 'readings')).toBe(true);
  });

  it('seeds the docs absent-only and lands every connection as a declared row with provenance shared', () => {
    expect(db.listAppDocs(result.appId).map((d) => d.slug).sort()).toEqual(['plan', 'vision']);
    const rows = db.listConnections(result.appId);
    expect(rows.map((r) => r.slot).sort()).toEqual(['bridge', 'org', 'weather']);
    for (const row of rows) {
      expect(row.status).toBe('declared');
      expect(row.provenance).toBe('shared');
      expect(row.approvedAt).toBeUndefined();
    }
    expect(result.refusedSlots).toEqual([]);
  });

  it('records the installed bundle id per app (sharedBundle:<appId>)', () => {
    expect(db.getSetting(sharedBundleSettingKey(result.appId))).toBe('b'.repeat(64));
  });

  it('is find-or-create on the lineage: a second install returns the existing app and touches nothing', async () => {
    db.putAppDoc(result.appId, 'vision', { content: 'my edited vision' });
    const again = await installAppFromBundle(db, bundle, { bundleId: 'c'.repeat(64) });
    expect(again.status).toBe('already-installed');
    expect(again.appId).toBe(result.appId);
    expect(db.getAppDoc(result.appId, 'vision')?.content).toBe('my edited vision');
    expect(db.getSetting(sharedBundleSettingKey(result.appId))).toBe('b'.repeat(64));
  });

  it('gives the app a UNIQUE display name when one already exists (finding 18), even at the 80-char cap', async () => {
    const other = await sharerBundle();
    const forked = { ...other, lineage: '11111111-2222-4333-8444-555555555555' };
    const second = await installAppFromBundle(db, forked, { bundleId: 'd'.repeat(64) });
    expect(db.getApp(second.appId)?.displayName).toBe('Weather Wall (2)');
    const long = 'L'.repeat(80);
    db.installApp({ displayName: long, html: '<html>l</html>' });
    const longBundle = { ...other, lineage: '22222222-2222-4333-8444-555555555555', app: { ...other.app, displayName: long } };
    const third = await installAppFromBundle(db, longBundle, { bundleId: 'e'.repeat(64) });
    const name = db.getApp(third.appId)?.displayName ?? '';
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith(' (2)')).toBe(true);
  });

  it('(N) never writes a starter identity — install_source is minted from the lineage', () => {
    expect(db.getApp(result.appId)?.installSource?.startsWith('share:')).toBe(true);
    expect(db.getAppByInstallSource('starter:weather')).toBeUndefined();
  });
});

describe('installAppFromBundle — failure shapes', () => {
  it('a DDL failure is an install failure with the error text, and leaves no app behind (finding 7)', async () => {
    const bundle = await sharerBundle([]);
    db = await open();
    const broken: AppBundle = { ...bundle, schema: { ddl: ['CREATE TABLE readings (id INTEGER PRIMARY KEY, temp REAL)', 'CREATE TABLE readings (dup INTEGER)'] } };
    await expect(installAppFromBundle(db, broken, { bundleId: 'e'.repeat(64) })).rejects.toThrow(/readings/);
    expect(db.listApps()).toEqual([]);
    expect(db.getAppByInstallSource(`share:${bundle.lineage}`)).toBeUndefined();
  });

  it('a connection the admission gate refuses drops THAT slot with a note — never the install (AC6)', async () => {
    const bundle = await sharerBundle([]);
    const refusing: ConnectionAdmissionGate = (requirement, context) =>
      context.slot === 'weather'
        ? { ok: false, requirement, issues: [{ path: 'provider.name', message: 'borrow refused (test)' }] }
        : { ok: true, requirement, issues: [] };
    db = await open(refusing);
    const result = await installAppFromBundle(db, bundle, { bundleId: 'f'.repeat(64) });
    expect(result.status).toBe('installed');
    expect(result.refusedSlots.map((r) => r.slot)).toEqual(['weather']);
    expect(result.refusedSlots[0]?.reason).toContain('borrow refused');
    expect(db.listConnections(result.appId).map((r) => r.slot).sort()).toEqual(['bridge', 'org']);
  });

  it('the gate is invoked on the shared channel for every slot (the wiring, not the guard, is under test here)', async () => {
    const bundle = await sharerBundle([]);
    const seen: string[] = [];
    const recording: ConnectionAdmissionGate = (requirement, context) => {
      seen.push(context.channel);
      return { ok: true, requirement, issues: [] };
    };
    db = await open(recording);
    await installAppFromBundle(db, bundle, { bundleId: 'a'.repeat(64) });
    expect(seen).toEqual(['shared', 'shared', 'shared']);
  });
});

// --------------------------------------------------------------------- AC12: update

describe('updateAppFromBundle — update · keeps your data (AC12)', () => {
  it('lands the new html as a new PINNED version with the bundle’s contract, seeds absent docs only, refreshes declared rows only, moves the marker', async () => {
    const first = await sharerBundle(['vision']);
    db = await open();
    const installed = await installAppFromBundle(db, first, { bundleId: 'b'.repeat(64) });
    // The recipient makes it theirs: edits a doc, approves a connection, writes data.
    db.putAppDoc(installed.appId, 'vision', { content: 'my own vision now' });
    db.approveConnection(installed.appId, 'weather');
    db.setSecret(authConnectionCredentialSecretKey(installed.appId, 'weather', 'api_key'), 'recipient-key');

    const next: AppBundle = {
      ...first,
      html: '<!doctype html><html><body>version three — shared update</body></html>',
      contract: { overview: 'Updated contract.' },
      docs: [
        { slug: 'vision', content: 'sharer rewrote the vision' },
        { slug: 'lessons', content: 'new lessons doc' },
      ],
      connections: first.connections.map((c) =>
        c.slot === 'weather'
          ? { ...c, declaredApiHosts: ['api.openweathermap.org', 'pro.openweathermap.org'] }
          : c.slot === 'bridge'
            ? { ...c, provider: { name: 'Renamed Bridge' } }
            : c,
      ),
    };
    const outcome = await updateAppFromBundle(db, installed.appId, next, { bundleId: 'g'.repeat(64) });
    expect(outcome.status).toBe('updated');

    const versions = db.listAppVersions(installed.appId);
    expect(versions.map((v) => [v.version, v.pinned]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [1, true],
      [2, true],
    ]);
    expect(db.getAppHtml(installed.appId)).toContain('version three');
    expect(db.getRuntimeContract(installed.appId, 2)?.overview).toBe('Updated contract.');
    // Docs: the recipient's edit survives; the absent slug is seeded.
    expect(db.getAppDoc(installed.appId, 'vision')?.content).toBe('my own vision now');
    expect(db.getAppDoc(installed.appId, 'lessons')?.content).toBe('new lessons doc');
    // Connections: the APPROVED row is untouched (its grant + secret survive); the declared row refreshed.
    const weatherRow = db.getConnection(installed.appId, 'weather');
    expect(weatherRow?.status).toBe('approved');
    expect(weatherRow?.requirement.declaredApiHosts).toEqual(['api.openweathermap.org']);
    expect(db.getSecret(authConnectionCredentialSecretKey(installed.appId, 'weather', 'api_key'))).toBe('recipient-key');
    expect(db.getConnection(installed.appId, 'bridge')?.requirement.provider.name).toBe('Renamed Bridge');
    expect(db.getConnection(installed.appId, 'bridge')?.provenance).toBe('shared');
    expect(db.getSetting(sharedBundleSettingKey(installed.appId))).toBe('g'.repeat(64));
  });

  it('is idempotent: re-applying the installed bundle id writes nothing', async () => {
    const first = await sharerBundle(['vision']);
    db = await open();
    const installed = await installAppFromBundle(db, first, { bundleId: 'b'.repeat(64) });
    const outcome = await updateAppFromBundle(db, installed.appId, first, { bundleId: 'b'.repeat(64) });
    expect(outcome.status).toBe('already-current');
    expect(db.listAppVersions(installed.appId)).toHaveLength(1);
  });

  it('a DDL failure during an update leaves the OLD code current and the marker unmoved (finding 5)', async () => {
    const first = await sharerBundle([]);
    db = await open();
    const installed = await installAppFromBundle(db, first, { bundleId: 'b'.repeat(64) });
    const broken: AppBundle = {
      ...first,
      html: '<html>should not land</html>',
      // The first statement applies; the second fails for real (an index on a table that
      // does not exist is not an "already exists" skip) — the new html must NOT land.
      schema: { ddl: ['CREATE TABLE extra_ok (id INTEGER)', 'CREATE INDEX ix_missing ON no_such_table (col)'] },
    };
    await expect(updateAppFromBundle(db, installed.appId, broken, { bundleId: 'x'.repeat(64) })).rejects.toThrow(/no_such_table|no such table/i);
    expect(db.getAppHtml(installed.appId)).toBe(V2_HTML);
    expect(db.listAppVersions(installed.appId)).toHaveLength(1);
    expect(db.getSetting(sharedBundleSettingKey(installed.appId))).toBe('b'.repeat(64));
  });

  it('refuses to update an app that is not a shared install of this lineage', async () => {
    const first = await sharerBundle([]);
    db = await open();
    const other = db.installApp({ displayName: 'Mine', html: '<html>mine</html>' });
    await expect(updateAppFromBundle(db, other.appId, first, { bundleId: 'h'.repeat(64) })).rejects.toThrow(/lineage/);
  });
});

// ---------------------------------------------------------- cascade (lesson 2026-08-18)

describe('deleteApp cascade — the share settings rows', () => {
  it('removes sharedBundle:<appId> and every shareLink:<appId>:* row, and nothing of a sibling', async () => {
    const bundle = await sharerBundle([]);
    db = await open();
    const a = await installAppFromBundle(db, bundle, { bundleId: 'b'.repeat(64) });
    const sibling = db.installApp({ displayName: 'sibling', html: '<html>s</html>' });
    db.setSetting(shareLinkSettingKey(a.appId, 'link1'), { id: 'link1', expiresAt: '2026-10-04T00:00:00Z' });
    db.setSetting(shareLinkSettingKey(a.appId, 'link2'), { id: 'link2', expiresAt: '2026-10-04T00:00:00Z' });
    db.setSetting(sharedBundleSettingKey(sibling.appId), 'z'.repeat(64));
    db.setSetting(shareLinkSettingKey(sibling.appId, 'link9'), { id: 'link9', expiresAt: '2026-10-04T00:00:00Z' });

    db.setSecret('share:link1', JSON.stringify({ revokeToken: 't1', key: 'k1' }));
    db.setSecret('share:link2', JSON.stringify({ revokeToken: 't2', key: 'k2' }));
    db.setSecret('share:link9', JSON.stringify({ revokeToken: 't9', key: 'k9' }));

    await db.deleteApp(a.appId);

    // The link SECRETS go with the app's link records (Gate-5 finding 10); the sibling's survive.
    expect(db.getSecret('share:link1')).toBeUndefined();
    expect(db.getSecret('share:link2')).toBeUndefined();
    expect(db.getSecret('share:link9')).toBeDefined();
    expect(db.getSetting(sharedBundleSettingKey(a.appId))).toBeUndefined();
    expect(db.getSetting(shareLinkSettingKey(a.appId, 'link1'))).toBeUndefined();
    expect(db.getSetting(shareLinkSettingKey(a.appId, 'link2'))).toBeUndefined();
    expect(db.getSetting(sharedBundleSettingKey(sibling.appId))).toBe('z'.repeat(64));
    expect(db.getSetting(shareLinkSettingKey(sibling.appId, 'link9'))).toEqual({ id: 'link9', expiresAt: '2026-10-04T00:00:00Z' });
  });
});

// -------------------------------------------------------------------- sniff (AC15)

describe('sniffSnugFile — the first bytes say what a .snug file is', () => {
  const enc = (text: string) => new TextEncoder().encode(text);

  it('classifies a user file (SQLite magic), a protected user file (SNUGENC1), a bundle (JSON), and garbage', () => {
    const sqlite = new Uint8Array(100);
    sqlite.set(enc('SQLite format 3\0'));
    expect(sniffSnugFile(sqlite)).toBe('user-file');
    expect(sniffSnugFile(enc(`${CONTAINER.MAGIC}rest-of-container`))).toBe('user-file');
    expect(sniffSnugFile(enc('{"format":"snug-app-bundle/1"}'))).toBe('app-bundle');
    expect(sniffSnugFile(enc('  \n\t{"format":"x"}'))).toBe('app-bundle');
    expect(sniffSnugFile(enc('﻿{"format":"x"}'))).toBe('app-bundle');
    expect(sniffSnugFile(enc('hello'))).toBe('unknown');
    expect(sniffSnugFile(enc('['))).toBe('unknown');
    expect(sniffSnugFile(new Uint8Array(0))).toBe('unknown');
  });

  it('reads only the head — a 64 MiB file costs nothing to classify', () => {
    const head = enc('{');
    const big = new Uint8Array(4096);
    big.set(head);
    expect(sniffSnugFile(big)).toBe('app-bundle');
  });
});

describe('listSettingKeys — the prefix readers’ enumeration', () => {
  it('lists every settings key sorted, so a namespaced reader can parse rather than guess', () => {
    db.setSetting('mode', 'byok');
    db.setSetting('sharedApp:aaaa', { text: '{}' });
    db.setSetting('sharedApp:bbbb', { text: '{}' });
    expect(db.listSettingKeys()).toEqual(['mode', 'sharedApp:aaaa', 'sharedApp:bbbb']);
  });
});
