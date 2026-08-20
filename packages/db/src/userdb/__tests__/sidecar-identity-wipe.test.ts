// sidecar-identity-wipe.test.ts — TASK-20260820-host-pseudonymisation AC13 + AC1 (persistence half).
//
// The host-side identity directory (harvested third-party names/jids, threat-model R-9)
// persists under ONE `snug_settings` key — a namespaced key rather than a new table, per
// the ADR-0036 D2 precedent in app-settings-keys.ts: a `snug_` table is a spec-normative
// format change (USERDB_SCHEMA_VERSION bump + migration + spec-changelog) and this store
// is host-internal, not portable-format material.
//
// LIFECYCLE (owner decision 2026-08-20): the directory is a persisted third-party-PII
// asset, so it is WIPED when the last approved sidecar-ceiling connection goes away —
// through EITHER of the only two seams that remove one: `revokeConnection` (tombstone;
// status leaves `approved`) and `deleteApp` (cascade removes the rows). Wiping on the
// LAST one only: a second app's live sidecar connection still needs its scrub directory.
import { beforeEach, describe, expect, it } from 'vitest';

import { CONNECTION_STATUS, SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from '../sidecar-identity-keys.js';
import { openUserDb, type UserDb } from '../userdb.js';

const open = async (backend: MemoryBackend): Promise<UserDb> => {
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

// The whatsapp starter's requirement shape (examples/whatsapp/connection.json):
// linked_device must declare exactly the field its minted session token fills.
const sidecarRequirement = (slot: string) =>
  ({
    slot,
    provider: { name: 'WhatsApp' },
    kind: 'linked_device',
    fields: [{ key: 'sidecar_token', label: 'Helper access token', type: 'secret' }],
    declaredApiHosts: [SIDECAR_SYMBOLIC_HOST],
  }) as const;

const apiRequirement = {
  slot: 'weather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  declaredApiHosts: ['api.openweathermap.org'],
} as const;

const DIRECTORY = ['Priya Sharma', '919876543210@s.whatsapp.net'];

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  db = await open(backend);
});

describe('the identity directory is wiped with the LAST sidecar-ceiling connection', () => {
  it('revoking the only sidecar connection deletes the directory row', () => {
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    const row = db.revokeConnection('app-1', 'whatsapp');

    expect(row.status).toBe(CONNECTION_STATUS.revoked);
    // Probe for the VALUE being gone, not merely falsy — the byte-probe posture.
    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toBeUndefined();
  });

  it('revoking ONE of two sidecar connections keeps the directory — the survivor still scrubs', () => {
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.putDeclaredConnection('app-2', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-2', 'whatsapp');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    db.revokeConnection('app-1', 'whatsapp');
    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toEqual(DIRECTORY);

    db.revokeConnection('app-2', 'whatsapp');
    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toBeUndefined();
  });

  it('revoking an ORDINARY api connection never touches the directory', () => {
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.putDeclaredConnection('app-3', 'weather', apiRequirement, 'starter');
    db.approveConnection('app-3', 'weather');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    db.revokeConnection('app-3', 'weather');

    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toEqual(DIRECTORY);
  });

  it('deleteApp of the app holding the last sidecar connection wipes through the cascade', async () => {
    db.installApp({ appId: 'app-1', displayName: 'Telepath', html: '<p>t</p>' });
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    await db.deleteApp('app-1');

    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toBeUndefined();
  });

  it('deleteApp of an UNRELATED app keeps the directory', async () => {
    db.installApp({ appId: 'app-9', displayName: 'Chess', html: '<p>c</p>' });
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);

    await db.deleteApp('app-9');

    expect(db.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toEqual(DIRECTORY);
  });
});

describe('the directory persists like any settings row (AC1, persistence half)', () => {
  it('survives a flush + reopen of the same backend', async () => {
    db.putDeclaredConnection('app-1', 'whatsapp', sidecarRequirement('whatsapp'), 'starter');
    db.approveConnection('app-1', 'whatsapp');
    db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, DIRECTORY);
    await db.flush();

    const reopened = await open(backend);
    expect(reopened.getSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY)).toEqual(DIRECTORY);
  });
});
