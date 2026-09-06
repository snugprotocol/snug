// agent-handin.test.ts — TASK-20260905-binding-a-artifacts AC8 (ADR-0065 §6): the `agent`
// provenance arm of the bundle install/update acts.
//
// Inside a Claude artifact the agent hands apps in as `snug-app-bundle/1` blocks embedded
// in the page. The kit installs a new lineage as an OWNED app (`install_source =
// 'agent:<lineage>'`), updates an unedited copy as a new pinned version with data kept,
// and honours a delete through a tombstone. Three rules the plan review made hard:
//   - a bundle carrying `connections` is a REFUSAL under `agent` (D4 — nothing installs);
//   - an edited copy (current ≠ newest pinned) is never superseded — `isEditedCopy` is the
//     ONE predicate the boot and the run header share;
//   - the lifted-from app (bundle.lineage === appId) takes the update in place, its own
//     install_source untouched; a `share:` copy is NOT an agent target.

import { appBundleId, type AppBundle, type ConnectionRequirement } from '@snugprotocol/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend } from '../../persistence.js';
import {
  AGENT_INSTALL_SOURCE_PREFIX,
  agentInstallSource,
  buildAppBundle,
  installAppFromBundle,
  isEditedCopy,
  shareInstallSource,
  updateAppFromBundle,
} from '../app-bundle.js';
import { AGENT_DISMISSED_SETTING_PREFIX, agentDismissedSettingKey, lineageFromAgentDismissedSettingKey, sharedBundleSettingKey } from '../app-settings-keys.js';
import { USERDB_ERROR_CODES, openUserDb, type UserDb } from '../userdb.js';

const V1 = '<!doctype html><html><body>agent v1</body></html>';
const V2 = '<!doctype html><html><body>agent v2 — edited by the agent</body></html>';
const USER_EDIT = '<!doctype html><html><body>the user changed this in the kit</body></html>';

const weather: ConnectionRequirement = {
  slot: 'weather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
  declaredApiHosts: ['api.openweathermap.org'],
};

async function open(): Promise<UserDb> {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  return result.userDb;
}

/** A bundle the AGENT built: html + DDL + a doc, no connections. Built from a scratch db so the lineage is a real UUID. */
async function agentBundle(html: string, opts: { connections?: boolean; lineage?: string } = {}): Promise<{ bundle: AppBundle; bundleId: string }> {
  const scratch = await open();
  const app = scratch.installApp({ displayName: 'Pomodoro', usesDb: true, html, ...(opts.lineage !== undefined ? { appId: opts.lineage } : {}) });
  await scratch.applyAppDdl(app.appId, ['CREATE TABLE sessions (id INTEGER PRIMARY KEY, minutes INTEGER)']);
  scratch.putAppDoc(app.appId, 'vision', { title: 'Vision', content: 'A pomodoro timer.' });
  if (opts.connections === true) scratch.putDeclaredConnection(app.appId, 'weather', weather, 'inference');
  const bundle = await buildAppBundle(scratch, app.appId, { docs: ['vision'] });
  await scratch.close();
  return { bundle, bundleId: await appBundleId(bundle) };
}

let db: UserDb;
beforeEach(async () => {
  db = await open();
});

describe('agentInstallSource — the identity', () => {
  it('spells `agent:<lineage>` and can never collide with a share or starter identity', () => {
    expect(AGENT_INSTALL_SOURCE_PREFIX).toBe('agent:');
    const lineage = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    expect(agentInstallSource(lineage)).toBe(`agent:${lineage}`);
    expect(agentInstallSource(lineage)).not.toBe(shareInstallSource(lineage));
    expect(agentInstallSource(lineage).startsWith('starter:')).toBe(false);
  });
});

describe('install under `agent` provenance', () => {
  it('installs a new lineage as an OWNED app: agent install_source, the agent note, the bundle id recorded, find-or-create on reload', async () => {
    const { bundle, bundleId } = await agentBundle(V1);
    const first = await installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' });
    expect(first.status).toBe('installed');
    const app = db.getApp(first.appId);
    expect(app?.installSource).toBe(agentInstallSource(bundle.lineage));
    expect(db.getAppHtml(first.appId)).toBe(V1);
    expect(db.listAppVersions(first.appId)[0]?.note).toBe('installed by your agent');
    expect(db.getSetting(sharedBundleSettingKey(first.appId))).toBe(bundleId);
    expect(db.listAppDocs(first.appId).map((d) => d.slug)).toEqual(['vision']);
    // The same block on the next boot installs nothing twice.
    const again = await installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' });
    expect(again).toMatchObject({ status: 'already-installed', appId: first.appId });
    expect(db.listApps()).toHaveLength(1);
  });

  it('(N, D4) a bundle carrying connections is REFUSED under `agent` — nothing installs, the code names it', async () => {
    const { bundle, bundleId } = await agentBundle(V1, { connections: true });
    expect(bundle.connections).toHaveLength(1);
    await expect(installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' })).rejects.toMatchObject({
      code: USERDB_ERROR_CODES.AGENT_CONNECTIONS_REFUSED,
    });
    expect(db.listApps()).toHaveLength(0);
    // Positive twin: the SAME bundle installs on the `shared` channel (its connections declared).
    const shared = await installAppFromBundle(db, bundle, { bundleId });
    expect(shared.status).toBe('installed');
    expect(db.listConnections(shared.appId).map((c) => c.slot)).toEqual(['weather']);
  });

  it('the default provenance is still `shared` — byte-for-byte the ADR-0063 behaviour', async () => {
    const { bundle, bundleId } = await agentBundle(V1);
    const result = await installAppFromBundle(db, bundle, { bundleId });
    expect(db.getApp(result.appId)?.installSource).toBe(shareInstallSource(bundle.lineage));
    expect(db.listAppVersions(result.appId)[0]?.note).toBe('installed from a shared app');
  });
});

describe('isEditedCopy — the one predicate', () => {
  it('is false after an install, true after the user saves a different html, false again once a pinned update is current', async () => {
    const { bundle, bundleId } = await agentBundle(V1);
    const { appId } = await installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' });
    expect(isEditedCopy(db, appId)).toBe(false);
    db.saveAppVersion(appId, USER_EDIT, 'user edit');
    expect(isEditedCopy(db, appId)).toBe(true);
    // A revert to the pinned bytes (same html as the newest pinned) reads as unedited again.
    db.saveAppVersion(appId, V1, 'back to the pinned bytes');
    expect(isEditedCopy(db, appId)).toBe(false);
  });

  it('a kit-built app pins v1 at install, so a later user save reads as edited — the agent’s first hand-back is OFFERED, never auto-applied', () => {
    const app = db.installApp({ displayName: 'Built here', html: V1 });
    expect(isEditedCopy(db, app.appId)).toBe(false);
    db.saveAppVersion(app.appId, USER_EDIT, 'edit');
    expect(isEditedCopy(db, app.appId)).toBe(true);
  });
});

describe('update under `agent` provenance', () => {
  it('lands the new html as a pinned version with the agent note; data, docs and chat kept; idempotent on the bundle id', async () => {
    const first = await agentBundle(V1);
    const { appId } = await installAppFromBundle(db, first.bundle, { bundleId: first.bundleId, provenance: 'agent' });
    db.putAppDoc(appId, 'memory', { content: 'the user likes 50-minute sessions' });
    db.upsertThread('t1', { appId, title: 'about the timer' });
    db.appendChatMessage('t1', 'user', 'make sessions longer');

    const second = await agentBundle(V2, { lineage: first.bundle.lineage });
    expect(second.bundle.lineage).toBe(first.bundle.lineage);
    const result = await updateAppFromBundle(db, appId, second.bundle, { bundleId: second.bundleId, provenance: 'agent' });
    expect(result).toMatchObject({ status: 'updated', version: 2 });
    expect(db.getAppHtml(appId)).toBe(V2);
    const versions = db.listAppVersions(appId);
    expect(versions.find((v) => v.version === 2)).toMatchObject({ pinned: true, note: 'updated by your agent' });
    expect(versions.find((v) => v.version === 1)?.pinned).toBe(true); // the previous version stays revertable
    expect(db.listAppDocs(appId).map((d) => d.slug).sort()).toEqual(['memory', 'vision']);
    expect(db.listChatMessages('t1')).toHaveLength(1);
    expect(db.getSetting(sharedBundleSettingKey(appId))).toBe(second.bundleId);
    expect(await updateAppFromBundle(db, appId, second.bundle, { bundleId: second.bundleId, provenance: 'agent' })).toEqual({ status: 'already-current' });
  });

  it('the lifted-from app (bundle.lineage === appId) takes the update in place; its own install_source is untouched', async () => {
    // The user built this app in the kit (no install_source); the agent lifted it, edited it, hands it back.
    const built = db.installApp({ displayName: 'Built in the kit', usesDb: true, html: V1 });
    const bundle = await agentBundle(V2, { lineage: built.appId });
    const result = await updateAppFromBundle(db, built.appId, bundle.bundle, { bundleId: bundle.bundleId, provenance: 'agent' });
    expect(result).toMatchObject({ status: 'updated', version: 2 });
    expect(db.getAppHtml(built.appId)).toBe(V2);
    expect(db.getApp(built.appId)?.installSource).toBeUndefined();
    // Positive twin of the rule that stays: the SHARED channel still refuses that target.
    const other = await agentBundle(V1, { lineage: built.appId });
    await expect(updateAppFromBundle(db, built.appId, other.bundle, { bundleId: other.bundleId })).rejects.toMatchObject({
      code: USERDB_ERROR_CODES.NOT_FOUND,
    });
  });

  it('(N, security review 3) a `share:` copy whose OWN id is the lineage is not a lifted-from target either', async () => {
    const first = await agentBundle(V1);
    const shared = await installAppFromBundle(db, first.bundle, { bundleId: first.bundleId });
    // The agent lifted the share copy itself: lineage = the share copy's app id.
    const lifted = await agentBundle(V2, { lineage: shared.appId });
    await expect(updateAppFromBundle(db, shared.appId, lifted.bundle, { bundleId: lifted.bundleId, provenance: 'agent' })).rejects.toMatchObject({
      code: USERDB_ERROR_CODES.NOT_FOUND,
    });
    expect(db.getAppHtml(shared.appId)).toBe(V1);
  });

  it('(N) a `share:` copy of the same lineage is NOT an agent target', async () => {
    const first = await agentBundle(V1);
    const shared = await installAppFromBundle(db, first.bundle, { bundleId: first.bundleId });
    const second = await agentBundle(V2, { lineage: first.bundle.lineage });
    await expect(updateAppFromBundle(db, shared.appId, second.bundle, { bundleId: second.bundleId, provenance: 'agent' })).rejects.toMatchObject({
      code: USERDB_ERROR_CODES.NOT_FOUND,
    });
    expect(db.getAppHtml(shared.appId)).toBe(V1);
  });

  it('(N, D4) an update bundle carrying connections is refused BEFORE any DDL or version lands', async () => {
    const first = await agentBundle(V1);
    const { appId } = await installAppFromBundle(db, first.bundle, { bundleId: first.bundleId, provenance: 'agent' });
    const second = await agentBundle(V2, { lineage: first.bundle.lineage, connections: true });
    await expect(updateAppFromBundle(db, appId, second.bundle, { bundleId: second.bundleId, provenance: 'agent' })).rejects.toMatchObject({
      code: USERDB_ERROR_CODES.AGENT_CONNECTIONS_REFUSED,
    });
    expect(db.getAppHtml(appId)).toBe(V1);
    expect(db.listAppVersions(appId)).toHaveLength(1);
    expect(db.listConnections(appId)).toHaveLength(0);
  });
});

describe('delete honours the hand-in — the tombstone', () => {
  it('deleting an `agent:` app writes `agentDismissed:<lineage>` = its bundle id and cascades the bundle marker', async () => {
    const { bundle, bundleId } = await agentBundle(V1);
    const { appId } = await installAppFromBundle(db, bundle, { bundleId, provenance: 'agent' });
    await db.deleteApp(appId);
    expect(db.getApp(appId)).toBeUndefined();
    expect(db.getSetting(sharedBundleSettingKey(appId))).toBeUndefined();
    expect(db.getSetting(agentDismissedSettingKey(bundle.lineage))).toBe(bundleId);
    expect(AGENT_DISMISSED_SETTING_PREFIX).toBe('agentDismissed:');
    expect(lineageFromAgentDismissedSettingKey(agentDismissedSettingKey(bundle.lineage))).toBe(bundle.lineage);
    expect(lineageFromAgentDismissedSettingKey('appModel:x')).toBeUndefined();
  });

  it('(N) deleting a `share:` copy, or a built app no agent ever touched, writes no tombstone', async () => {
    const { bundle, bundleId } = await agentBundle(V1);
    const shared = await installAppFromBundle(db, bundle, { bundleId });
    await db.deleteApp(shared.appId);
    expect(db.getSetting(agentDismissedSettingKey(bundle.lineage))).toBeUndefined();
    const built = db.installApp({ displayName: 'Built', html: V1 });
    await db.deleteApp(built.appId);
    expect(db.listSettingKeys().filter((key) => key.startsWith(AGENT_DISMISSED_SETTING_PREFIX))).toHaveLength(0);
  });

  it('a lifted-from app the agent updated IN PLACE tombstones under its own id on delete (correctness review 5)', async () => {
    const built = db.installApp({ displayName: 'Built in the kit', usesDb: true, html: V1 });
    const lifted = await agentBundle(V2, { lineage: built.appId });
    await updateAppFromBundle(db, built.appId, lifted.bundle, { bundleId: lifted.bundleId, provenance: 'agent' });
    await db.deleteApp(built.appId);
    expect(db.getSetting(agentDismissedSettingKey(built.appId))).toBe(lifted.bundleId);
  });
});
