// app-provider-setting.test.ts — TASK-20260821-ui-polish AC7/AC10 (DB half).
//
// Two NEW one-per-app rows join the `snug_settings` namespace beside `appModel:` and
// `starterVersion:` (same ADR-0036 D2 shape, same obligation):
//
//   `appProvider:<appId>` — the LLM provider this app's pin routes to. Written together
//     with `appModel:<appId>` by the selector (a pin is a pin — review finding 10);
//     absent means the app follows the resolved default provider.
//   `appRenamed:<appId>`  — the marker that the USER named this app, which is what stops
//     the announce path from clobbering the rename on the next run (Phase E).
//
// Both owe `deleteApp` a cascade entry, or a missed key silently applies to a REUSED
// app id (lessons.md 2026-08-18). These tests ARE the mutation check for those two
// cascade lines: remove either equality delete and its test here goes red.

import { beforeEach, describe, expect, it } from 'vitest';

import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';

let backend: MemoryBackend;
let db: UserDb;

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

describe('per-app provider setting — accessors', () => {
  it('round-trips picks and keeps apps independent', () => {
    const a = db.installApp({ displayName: 'a', html: '<html>a</html>' });
    const b = db.installApp({ displayName: 'b', html: '<html>b</html>' });
    db.setAppProvider(a.appId, 'anthropic');
    db.setAppProvider(b.appId, 'openai');
    expect(db.listAppProviders()).toEqual({ [a.appId]: 'anthropic', [b.appId]: 'openai' });
    // Neither touched the GLOBAL provider rows.
    expect(db.getSetting('provider')).toBeUndefined();
    expect(db.getSetting('providerChoice')).toBeUndefined();
  });

  it('clearing DELETES the row rather than storing an empty string', () => {
    const a = db.installApp({ displayName: 'a', html: '<html>a</html>' });
    db.setAppProvider(a.appId, 'openai');
    db.setAppProvider(a.appId, undefined);
    expect(db.listAppProviders()).toEqual({});
    expect(db.getSetting(`appProvider:${a.appId}`)).toBeUndefined();
  });

  it('a corrupted (non-string) stored value is skipped, not surfaced', () => {
    const a = db.installApp({ displayName: 'a', html: '<html>a</html>' });
    db.setSetting(`appProvider:${a.appId}`, 42);
    expect(db.listAppProviders()).toEqual({});
  });
});

describe('renamed-app marker — accessors', () => {
  it('marks, lists, and unmarks', () => {
    const a = db.installApp({ displayName: 'a', html: '<html>a</html>' });
    const b = db.installApp({ displayName: 'b', html: '<html>b</html>' });
    db.setAppRenamed(a.appId, true);
    expect(db.listRenamedApps()).toEqual([a.appId]);
    db.setAppRenamed(b.appId, true);
    expect(db.listRenamedApps().sort()).toEqual([a.appId, b.appId].sort());
    // Unmarking deletes the row — absence means "the app's own name flows again".
    db.setAppRenamed(a.appId, false);
    expect(db.listRenamedApps()).toEqual([b.appId]);
    expect(db.getSetting(`appRenamed:${a.appId}`)).toBeUndefined();
  });
});

describe('deleteApp cascade (AC7)', () => {
  it('sweeps the deleted app’s provider pick and rename marker — and ONLY those', async () => {
    const doomed = db.installApp({ displayName: 'doomed', html: '<html>a</html>' });
    const keeper = db.installApp({ displayName: 'keeper', html: '<html>b</html>' });
    db.setAppProvider(doomed.appId, 'openai');
    db.setAppProvider(keeper.appId, 'anthropic');
    db.setAppRenamed(doomed.appId, true);
    db.setAppRenamed(keeper.appId, true);
    // Global rows a sloppy prefix delete would take with it.
    db.setSetting('provider', 'anthropic');
    db.setSetting('providerChoice', 'openai');
    db.setSetting('providerModel:anthropic', 'claude-opus-5');
    await db.flush();

    await db.deleteApp(doomed.appId);

    expect(db.listAppProviders()).toEqual({ [keeper.appId]: 'anthropic' });
    expect(db.listRenamedApps()).toEqual([keeper.appId]);
    expect(db.getSetting('provider')).toBe('anthropic');
    expect(db.getSetting('providerChoice')).toBe('openai');
    expect(db.getSetting('providerModel:anthropic')).toBe('claude-opus-5');
  });

  it('deletes an app that never had either row without throwing', async () => {
    const app = db.installApp({ displayName: 'plain', html: '<html>v1</html>' });
    await db.flush();
    await expect(db.deleteApp(app.appId)).resolves.toBeUndefined();
  });
});
