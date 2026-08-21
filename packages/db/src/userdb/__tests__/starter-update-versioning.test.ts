/**
 * TASK-20260820-starter-updates (ADR-0045) — the db mechanics behind starter updates.
 *
 * A starter update lands the new bundle as a NEW PINNED version of the user's copy, so
 * "factory" becomes plural: the install-day v1 AND every starter update are factory
 * snapshots. Four rules carry that:
 *
 *  (i)   `saveAppVersion` can pin (opts.pinned) — and a pinned update must survive the
 *        retention prune exactly as install-day v1 does.
 *  (ii)  `saveAppVersion` can land a contract ATOMICALLY (opts.contract). The ADR-0018
 *        copy-forward default is for user edits; a factory update ships factory contract,
 *        and doing it in the same synchronous call closes the window where new HTML
 *        durably runs under the old contract (plan-review finding 3).
 *  (iii) `resetToFactory` restores the NEWEST pinned version — after an update, "reset
 *        to factory" means the starter you are on, not the day you installed. Single-pin
 *        apps (every app that predates this change) behave identically.
 *  (iv)  `starterVersion:<appId>` is a per-app row in the shared `snug_settings`
 *        namespace, so `deleteApp` must sweep it (lessons.md 2026-08-18: a namespaced
 *        key chosen over a column names its delete path in the same change, or a missed
 *        key silently applies to a REUSED app id).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { runtimeContractSchema } from '@snugprotocol/protocol';
import { locateWasm } from '../../__tests__/helpers.js';
import { createMemoryBackend, type MemoryBackend } from '../../persistence.js';
import { openUserDb, type UserDb } from '../userdb.js';
import { appIdFromStarterVersionSettingKey, starterVersionSettingKey } from '../app-settings-keys.js';

let backend: MemoryBackend;
let db: UserDb;

const OLD_CONTRACT = runtimeContractSchema.parse({ overview: 'v1 of the starter contract.' });
const NEW_CONTRACT = runtimeContractSchema.parse({ overview: 'v2 of the starter contract — shipped by the update.' });

beforeEach(async () => {
  backend = createMemoryBackend();
  const result = await openUserDb({ backend, locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

describe('saveAppVersion opts.pinned (ADR-0045 rule i)', () => {
  it('lands a pinned version that the retention prune keeps alongside factory v1', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    db.saveAppVersion(app.appId, '<html>update</html>', 'starter update to v2', undefined, { pinned: true });
    // Enough unpinned edits that both pins fall below the retention floor.
    for (let i = 3; i <= 10; i += 1) db.saveAppVersion(app.appId, `<html>v${i}</html>`);
    const versions = db.listAppVersions(app.appId);
    expect(versions.filter((v) => v.pinned).map((v) => v.version)).toEqual([2, 1]);
    expect(db.getAppHtml(app.appId, 2)).toBe('<html>update</html>');
    expect(db.getAppHtml(app.appId, 1)).toBe('<html>v1</html>');
  });

  it('defaults to unpinned — existing call shapes are unchanged', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    const meta = db.saveAppVersion(app.appId, '<html>edit</html>', 'an ordinary edit');
    expect(meta.pinned).toBe(false);
    expect(db.listAppVersions(app.appId).filter((v) => v.pinned)).toHaveLength(1);
  });
});

describe('saveAppVersion opts.contract (ADR-0045 rule ii)', () => {
  it('overrides copy-forward: the new version carries the supplied contract, prior versions keep theirs', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, 1, OLD_CONTRACT);
    db.saveAppVersion(app.appId, '<html>update</html>', 'starter update to v2', undefined, {
      pinned: true,
      contract: NEW_CONTRACT,
    });
    expect(db.getRuntimeContract(app.appId)?.overview).toBe(NEW_CONTRACT.overview);
    expect(db.getRuntimeContract(app.appId, 1)?.overview).toBe(OLD_CONTRACT.overview);
  });

  it('without opts.contract the copy-forward default still applies', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, 1, OLD_CONTRACT);
    db.saveAppVersion(app.appId, '<html>edit</html>');
    expect(db.getRuntimeContract(app.appId)?.overview).toBe(OLD_CONTRACT.overview);
  });

  it('validates at the boundary: an invalid contract rejects BEFORE any row is written', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    expect(() =>
      db.saveAppVersion(app.appId, '<html>update</html>', 'starter update to v2', undefined, {
        pinned: true,
        contract: { overview: 42 } as never,
      }),
    ).toThrow();
    // The failed update left NOTHING behind — no orphan pinned row, version unchanged.
    expect(db.getApp(app.appId)?.currentVersion).toBe(1);
    expect(db.listAppVersions(app.appId)).toHaveLength(1);
  });
});

describe('resetToFactory restores the NEWEST pinned version (ADR-0045 rule iii)', () => {
  it('after a pinned update, reset lands the updated starter, not install-day bytes', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>FACTORY-v1</html>' });
    db.saveAppVersion(app.appId, '<html>FACTORY-v2</html>', 'starter update to v2', undefined, { pinned: true });
    db.saveAppVersion(app.appId, '<html>user edit</html>');
    const meta = db.resetToFactory(app.appId);
    expect(db.getAppHtml(app.appId)).toBe('<html>FACTORY-v2</html>');
    expect(meta.note).toBe('reset to factory (v2)');
  });

  it('single pinned version: behavior is exactly the pre-ADR-0045 one', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>FACTORY</html>' });
    for (let i = 2; i <= 9; i += 1) db.saveAppVersion(app.appId, `<html>v${i}</html>`);
    db.resetToFactory(app.appId);
    expect(db.getAppHtml(app.appId)).toBe('<html>FACTORY</html>');
  });

  it('reset copies the contract from the version it restores (ADR-0018 D2(ii), now aimed at the newest pin)', () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>' });
    db.putRuntimeContract(app.appId, 1, OLD_CONTRACT);
    db.saveAppVersion(app.appId, '<html>update</html>', 'starter update to v2', undefined, {
      pinned: true,
      contract: NEW_CONTRACT,
    });
    db.saveAppVersion(app.appId, '<html>user edit</html>');
    db.resetToFactory(app.appId);
    expect(db.getRuntimeContract(app.appId)?.overview).toBe(NEW_CONTRACT.overview);
  });
});

describe('the starterVersion settings row (ADR-0045 rule iv)', () => {
  it('key helpers: one shape, parsed not prefix-tested', () => {
    expect(starterVersionSettingKey('abc')).toBe('starterVersion:abc');
    expect(() => starterVersionSettingKey('')).toThrow();
    expect(appIdFromStarterVersionSettingKey('starterVersion:abc')).toBe('abc');
    expect(appIdFromStarterVersionSettingKey('starterVersion:')).toBeUndefined();
    expect(appIdFromStarterVersionSettingKey('model')).toBeUndefined();
  });

  it('deleteApp sweeps the row; an unrelated app keeps its own', async () => {
    const app = db.installApp({ displayName: 'A', html: '<html>v1</html>', installSource: 'starter:chess' });
    const other = db.installApp({ displayName: 'B', html: '<html>v1</html>', installSource: 'starter:gmail' });
    db.setSetting(starterVersionSettingKey(app.appId), 3);
    db.setSetting(starterVersionSettingKey(other.appId), 1);
    await db.deleteApp(app.appId);
    expect(db.getSetting(starterVersionSettingKey(app.appId))).toBeUndefined();
    expect(db.getSetting(starterVersionSettingKey(other.appId))).toBe(1);
  });
});
