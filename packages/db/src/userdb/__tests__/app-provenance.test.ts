/**
 * TASK-20261010-host-broker PR-5 (contract v2 D-PR5-9; AC38's db half) — the imported marker.
 *
 * `appProvenance:<appId>` = strict `{imported: true, at}` (internal schema in
 * `packages/db/src/userdb/app-provenance.ts`; key functions `appProvenanceKey` /
 * `appIdFromAppProvenanceKey` in `app-settings-keys.ts`). R-77: an untrusted import carries
 * `install_source` verbatim, so a file can forge `starter:`/`agent:`/`share:` — the marker is what
 * the access provenance reads instead (`'imported'` overrides every install source, T-B's
 * `provenance.test.ts`).
 *
 * The UNTRUSTED import drops every incoming marker, then writes one for every incoming app whose
 * IDENTITY differs from the local app of the same id — identity = `install_source` + the ordered
 * list of EVERY `(version, pinned, sha256(html))` row (a planted past or pinned version marks the
 * app); identical apps keep the LOCAL marker state; a fresh device marks every app; a revived
 * deleted app is marked. A TRUSTED pull keeps; `deleteApp` sweeps; no edit clears it.
 * `readAppProvenance(value: unknown)` fails closed: a present but unparseable row → imported, no date.
 *
 * Written BEFORE the module exists (Gate 3): loaded through a VARIABLE specifier so each row reds
 * on its own (docs/lessons.md 2026-10-11).
 */

import { USERDB_TABLES } from '@snugprotocol/protocol';
import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend } from '../../persistence.js';
import { appIdFromAppProvenanceKey, appProvenanceKey } from '../app-settings-keys.js';
import { openUserDb, type UserDb } from '../userdb.js';

type AppProvenanceModule = typeof import('../app-provenance.js');
const MODULE = '../app-provenance.js';
let loading: Promise<AppProvenanceModule> | undefined;
function provenanceModule(): Promise<AppProvenanceModule> {
  loading ??= import(/* @vite-ignore */ MODULE) as Promise<AppProvenanceModule>;
  return loading;
}

const open = async (): Promise<UserDb> => {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error(`expected ok open, got ${result.status}`);
  return result.userDb;
};

const LEDGER = '0b1c7e3a-5f2d-4c8e-9a61-2d3e4f5a6b7c';
const BUDGET = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
const AT = '2026-10-03T09:00:00.000Z';

/** The marker as the host reads it — through the fail-closed reader. */
async function markerOf(db: UserDb, appId: string): Promise<{ imported: true; at?: string } | undefined> {
  const { readAppProvenance } = await provenanceModule();
  return readAppProvenance(db.getSetting(appProvenanceKey(appId))) as { imported: true; at?: string } | undefined;
}

/** Two apps with history: Ledger v1 (factory) + v2, Budget v1 — the "local" file. */
function installTwo(db: UserDb): void {
  db.installApp({ appId: LEDGER, displayName: 'Ledger', html: '<html>ledger v1</html>' });
  db.saveAppVersion(LEDGER, '<html>ledger v2</html>');
  db.installApp({ appId: BUDGET, displayName: 'Budget', html: '<html>budget v1</html>', installSource: 'starter:budget' });
}

async function doctor(bytes: Uint8Array, statements: Array<[sql: string, params?: unknown[]]>): Promise<Uint8Array> {
  const SQL = await initSqlJs({ locateFile: locateWasm });
  const raw = new SQL.Database(bytes);
  try {
    for (const [sql, params] of statements) raw.run(sql, (params ?? []) as never);
    return raw.export();
  } finally {
    raw.close();
  }
}

const backup = (db: UserDb): Promise<Uint8Array> => db.exportUserDb({ includeSecrets: true });

let db: UserDb;
beforeEach(async () => {
  db = await open();
});

// ------------------------------------------------------------------------- the pure half

describe('the key and the schema (D-PR5-9)', () => {
  it('D-PR5-9 appProvenanceKey is appProvenance:<appId>, and appIdFromAppProvenanceKey reverses it', () => {
    expect(appProvenanceKey(LEDGER)).toBe(`appProvenance:${LEDGER}`);
    expect(appIdFromAppProvenanceKey(`appProvenance:${LEDGER}`)).toBe(LEDGER);
    expect(appIdFromAppProvenanceKey('appProvenance:')).toBeUndefined();
    expect(appIdFromAppProvenanceKey(`accessWants:${LEDGER}`)).toBeUndefined();
    expect(() => appProvenanceKey('')).toThrow();
  });

  it('D-PR5-9 appProvenanceSchema is strict {imported: true, at}', async () => {
    const { appProvenanceSchema } = await provenanceModule();
    expect(appProvenanceSchema.safeParse({ imported: true, at: AT }).success).toBe(true);
    for (const value of [{ imported: false, at: AT }, { imported: true }, { imported: true, at: 'yesterday' }, { imported: true, at: AT, by: 'a file' }, { at: AT }, true, 'imported']) {
      expect(appProvenanceSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });

  it('D-PR5-9 readAppProvenance: absent → not imported; a valid row → imported with its date', async () => {
    const { readAppProvenance } = await provenanceModule();
    expect(readAppProvenance(undefined)).toBeUndefined();
    expect(readAppProvenance({ imported: true, at: AT })).toEqual({ imported: true, at: AT });
  });

  it('D-PR5-9 readAppProvenance FAILS CLOSED: a present but unparseable row → imported, no date', async () => {
    const { readAppProvenance } = await provenanceModule();
    for (const value of [null, 'junk', 42, [], {}, { imported: false, at: AT }, { imported: true }, { imported: true, at: 'not-a-date' }, { imported: true, at: AT, extra: 1 }]) {
      const read = readAppProvenance(value);
      expect(read, JSON.stringify(value)).toEqual({ imported: true });
      expect(read !== undefined && 'at' in read, JSON.stringify(value)).toBe(false);
    }
  });

  it('D-PR5-9 the key functions and the reader are exported from the package index', async () => {
    const index = (await import('../../index.js')) as Record<string, unknown>;
    for (const name of ['appProvenanceKey', 'appIdFromAppProvenanceKey', 'readAppProvenance']) {
      expect(typeof index[name], name).toBe('function');
    }
  });
});

// ------------------------------------------------------------------ the UNTRUSTED import

describe('the UNTRUSTED import marks every app whose identity differs (D-PR5-9, AC38)', () => {
  it('D-PR5-9 a fresh device marks EVERY incoming app, dated at the import', async () => {
    const donor = await open();
    installTwo(donor);
    const bytes = await backup(donor);
    await donor.close();
    const before = Date.now();

    await db.importUserDb(bytes);

    for (const appId of [LEDGER, BUDGET]) {
      const marker = await markerOf(db, appId);
      expect(marker?.imported, appId).toBe(true);
      expect(Date.parse(marker?.at ?? ''), appId).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('D-PR5-9 identical apps (a backup of this very file) are NOT marked', async () => {
    installTwo(db);
    const marker = await markerOf(db, LEDGER); // loads the module first: a missing module reds this row, not a false green
    expect(marker).toBeUndefined();

    await db.importUserDb(await backup(db));

    expect(await markerOf(db, LEDGER)).toBeUndefined();
    expect(await markerOf(db, BUDGET)).toBeUndefined();
    expect(db.listSettingKeys().filter((key) => key.startsWith('appProvenance:'))).toEqual([]);
  });

  it('D-PR5-9 identical apps keep the LOCAL marker state — a marked app stays marked with its first date', async () => {
    const donor = await open();
    installTwo(donor);
    const foreign = await backup(donor);
    await donor.close();
    await db.importUserDb(foreign); // marks both here
    const first = await markerOf(db, LEDGER);
    expect(first?.at).toBeDefined();
    // The file this device exports WITHOUT the markers, re-imported: the local state decides, not the file.
    const stripped = await doctor(await backup(db), [[`DELETE FROM ${USERDB_TABLES.settings} WHERE key LIKE 'appProvenance:%'`]]);

    await db.importUserDb(stripped);

    expect(await markerOf(db, LEDGER)).toEqual(first);
  });

  it('D-PR5-9 every INCOMING marker is dropped — a planted marker on an identical app, and an orphan marker, are gone', async () => {
    installTwo(db);
    const planted = await doctor(await backup(db), [
      [`INSERT INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [appProvenanceKey(LEDGER), JSON.stringify({ imported: true, at: AT })]],
      [`INSERT INTO ${USERDB_TABLES.settings} (key, value) VALUES (?, ?)`, [appProvenanceKey('c0ffee00-0000-4000-8000-000000000000'), JSON.stringify({ imported: true, at: AT })]],
    ]);

    await db.importUserDb(planted);

    expect(await markerOf(db, LEDGER)).toBeUndefined();
    expect(db.listSettingKeys().filter((key) => key.startsWith('appProvenance:'))).toEqual([]);
  });

  it('D-PR5-9 a changed CURRENT html marks the app (and only that app)', async () => {
    installTwo(db);
    const bytes = await doctor(await backup(db), [[`UPDATE ${USERDB_TABLES.appVersions} SET html = ? WHERE app_id = ? AND version = 2`, ['<html>ledger EVIL</html>', LEDGER]]]);

    await db.importUserDb(bytes);

    expect((await markerOf(db, LEDGER))?.imported).toBe(true);
    expect(await markerOf(db, BUDGET)).toBeUndefined();
  });

  it('D-PR5-9 a planted PAST version marks the app — the current html is identical', async () => {
    installTwo(db);
    const bytes = await doctor(await backup(db), [[`UPDATE ${USERDB_TABLES.appVersions} SET html = ? WHERE app_id = ? AND version = 1`, ['<html>ledger planted factory</html>', LEDGER]]]);

    await db.importUserDb(bytes);

    expect(db.getAppHtml(LEDGER)).toBe('<html>ledger v2</html>');
    expect((await markerOf(db, LEDGER))?.imported).toBe(true);
  });

  it('D-PR5-9 a flipped PINNED bit marks the app', async () => {
    installTwo(db);
    const bytes = await doctor(await backup(db), [[`UPDATE ${USERDB_TABLES.appVersions} SET pinned = 1 WHERE app_id = ? AND version = 2`, [LEDGER]]]);

    await db.importUserDb(bytes);

    expect((await markerOf(db, LEDGER))?.imported).toBe(true);
  });

  it('D-PR5-9 an extra or a missing version row marks the app', async () => {
    installTwo(db);
    const extra = await doctor(await backup(db), [
      [`INSERT INTO ${USERDB_TABLES.appVersions} (app_id, version, html, note, created_at, pinned) VALUES (?, 0, ?, NULL, ?, 0)`, [BUDGET, '<html>budget v0</html>', AT]],
    ]);
    await db.importUserDb(extra);
    expect((await markerOf(db, BUDGET))?.imported, 'an extra version').toBe(true);

    const local = await open();
    installTwo(local);
    const missing = await doctor(await backup(local), [[`DELETE FROM ${USERDB_TABLES.appVersions} WHERE app_id = ? AND version = 1`, [LEDGER]]]);
    await local.importUserDb(missing);
    expect((await markerOf(local, LEDGER))?.imported, 'a missing version').toBe(true);
    await local.close();
  });

  it('D-PR5-9 a different install_source marks the app (a forged starter:, agent: or share:)', async () => {
    installTwo(db);
    const bytes = await doctor(await backup(db), [
      [`UPDATE ${USERDB_TABLES.apps} SET install_source = ? WHERE app_id = ?`, ['starter:ledger', LEDGER]],
      [`UPDATE ${USERDB_TABLES.apps} SET install_source = ? WHERE app_id = ?`, ['agent:budget', BUDGET]],
    ]);

    await db.importUserDb(bytes);

    expect((await markerOf(db, LEDGER))?.imported).toBe(true);
    expect((await markerOf(db, BUDGET))?.imported).toBe(true);
  });

  it('D-PR5-9 a revived DELETED app is marked — the local file no longer holds it', async () => {
    installTwo(db);
    const before = await backup(db);
    await db.deleteApp(LEDGER);

    await db.importUserDb(before);

    expect(db.getApp(LEDGER)).toBeDefined();
    expect((await markerOf(db, LEDGER))?.imported).toBe(true);
    expect(await markerOf(db, BUDGET)).toBeUndefined();
  });
});

// ----------------------------------------------------------- the TRUSTED pull, edits, delete

describe('a TRUSTED pull keeps; no edit clears; deleteApp sweeps (D-PR5-9)', () => {
  it('D-PR5-9 a TRUSTED pull keeps the incoming markers exactly and marks nothing new', async () => {
    const donor = await open();
    installTwo(donor);
    donor.setSetting(appProvenanceKey(LEDGER), { imported: true, at: AT });
    const bytes = await backup(donor);
    await donor.close();

    await db.importUserDb(bytes, { trustedOrigin: true });

    expect(db.getSetting(appProvenanceKey(LEDGER))).toEqual({ imported: true, at: AT });
    expect(await markerOf(db, BUDGET)).toBeUndefined(); // a fresh device's trusted pull marks nothing
  });

  it('D-PR5-9 no edit clears it — a new version, a revert, a rename keep the marker', async () => {
    const donor = await open();
    installTwo(donor);
    const bytes = await backup(donor);
    await donor.close();
    await db.importUserDb(bytes);
    const marker = await markerOf(db, LEDGER);
    expect(marker?.imported).toBe(true);

    db.saveAppVersion(LEDGER, '<html>ledger v3 — mine now</html>');
    db.revertApp(LEDGER, 1);
    db.updateAppMeta(LEDGER, { displayName: 'My Ledger' });

    expect(await markerOf(db, LEDGER)).toEqual(marker);
  });

  it('D-PR5-9 deleteApp sweeps the app\'s marker and leaves a sibling\'s', async () => {
    const donor = await open();
    installTwo(donor);
    const bytes = await backup(donor);
    await donor.close();
    await db.importUserDb(bytes);
    expect((await markerOf(db, LEDGER))?.imported).toBe(true);

    await db.deleteApp(LEDGER);

    expect(db.listSettingKeys()).not.toContain(appProvenanceKey(LEDGER));
    expect((await markerOf(db, BUDGET))?.imported).toBe(true);
  });
});
