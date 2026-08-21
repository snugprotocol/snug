// starterUpdate.test.ts — TASK-20260820-starter-updates (ADR-0045).
//
// The update channel for installed starters: detection (which tile/header shows
// "update"), the update act (new PINNED version through `saveAppVersion`, starter
// contract landed atomically, declared-only connection refresh, absent-only docs,
// `starterVersion:` key), retention (credentials/connections/chat/docs untouched), and
// the two-fact vouch surviving a legitimate update while still refusing forgeries.
//
// Fixture seams mirror the sibling starter suites (`__set…ForTests`); the seam-OFF
// integration probe lives in `starterMeta.test.ts` (lessons.md 2026-08-08: at least one
// test must run the real wiring).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { starterVersionSettingKey } from '@snugprotocol/db';

import {
  __resetDeclarationManifestsForTests,
  __setDeclarationManifestsForTests,
  resolveDeclaredIntent,
} from '../starter/starterDeclaration.js';
import {
  __resetStarterDocFixturesForTests,
  __setStarterDocFixturesForTests,
} from '../starter/starterDocs.js';
import {
  __resetStarterMetaFixturesForTests,
  __setStarterMetaFixturesForTests,
} from '../starter/starterMeta.js';
import {
  __resetStarterUpdateFixturesForTests,
  __setStarterUpdateFixturesForTests,
  applyStarterUpdate,
  starterUpdateStatus,
} from '../starter/starterUpdate.js';
import {
  __resetRuntimeContractFixturesForTests,
  __setRuntimeContractFixturesForTests,
} from '../starter/starterRuntimeContract.js';
import { installTestUserDb } from './userdbTestHelper.js';

const FOLDER = 'weather';
const SOURCE = `starter:${FOLDER}`;

const HTML_V1 = '<!doctype html>\n<html><body><script>const app = "v1";</script></body></html>';
const HTML_V2 = '<!doctype html>\n<html><body><script>const app = "v2";</script></body></html>';

const MANIFEST = JSON.stringify({
  slot: 'example-api',
  provider: { name: 'Example API', docsUrl: 'https://docs.example.com/api' },
  kind: 'api_key',
  fields: [{ key: 'api_key', label: 'API key', type: 'secret', description: 'From your dashboard.' }],
  registration: {
    consoleUrl: 'https://docs.example.com/console',
    instructions: ['Open the console.', 'Create a key and paste it below.'],
  },
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: ['api.example.com'],
});

const CONTRACT_V2 = JSON.stringify({ overview: 'v2 contract — shipped by the update.' });

/** A docs bundle for the fixture starter — the whole payload of a docs-only release. */
const DOCS = {
  [FOLDER]: {
    docs: {
      'vision.md': '# Vision\n\nForecasts turned into decisions.',
      'lessons.md': '# Lessons\n\nSeeded by the docs-only release.',
    },
    prompts: { '01-build.md': '# Build prompt\n\nBuild the weather decider.' },
  },
};

const meta = (version: number): string =>
  JSON.stringify({
    version,
    appHash: 'not-checked-at-runtime',
    changelog: Array.from({ length: version }, (_, i) => ({
      version: version - i,
      date: '2026-08-21',
      title: version - i === 1 ? 'Initial release' : `Release ${version - i}`,
      sections: [{ title: "What's new", items: [`Item for v${version - i}.`] }],
    })),
  });

let db: UserDb;

/** Bundle state: html + starter.json at a given starter version (manifest constant). */
function setBundle(html: string, version: number, opts?: { contractRaw?: string }): void {
  __setDeclarationManifestsForTests({ [FOLDER]: { manifest: MANIFEST, html } });
  __setStarterMetaFixturesForTests({ [FOLDER]: meta(version) });
  __setStarterUpdateFixturesForTests({ [FOLDER]: html });
  __setRuntimeContractFixturesForTests(opts?.contractRaw === undefined ? {} : { [FOLDER]: opts.contractRaw });
}

/** The install act's db half, as RunView performs it (copy + key). */
function installAtV1(): string {
  const app = db.installApp({ displayName: 'Weather', html: HTML_V1, installSource: SOURCE });
  db.setSetting(starterVersionSettingKey(app.appId), 1);
  return app.appId;
}

beforeEach(async () => {
  db = await installTestUserDb();
});

afterEach(() => {
  __resetDeclarationManifestsForTests();
  __resetStarterMetaFixturesForTests();
  __resetStarterUpdateFixturesForTests();
  __resetRuntimeContractFixturesForTests();
  __resetStarterDocFixturesForTests();
});

describe('starterUpdateStatus — detection (AC2, AC3)', () => {
  it('bundle at the installed version: no update', async () => {
    setBundle(HTML_V1, 1);
    const appId = installAtV1();
    const status = await starterUpdateStatus(db, appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 1, updateAvailable: false, edited: false });
  });

  it('bundle ahead, unedited copy: update available', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    const status = await starterUpdateStatus(db, appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 2, updateAvailable: true, edited: false });
  });

  it('bundle ahead, user-edited copy: update available AND flagged edited', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    db.saveAppVersion(appId, '<html>my remix</html>', 'user edit');
    const status = await starterUpdateStatus(db, appId);
    expect(status).toMatchObject({ updateAvailable: true, edited: true });
  });

  it('legacy install (no key), bytes match the bundle: no update, current version reported', async () => {
    setBundle(HTML_V1, 1);
    const app = db.installApp({ displayName: 'Weather', html: HTML_V1, installSource: SOURCE });
    const status = await starterUpdateStatus(db, app.appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 1, updateAvailable: false });
  });

  it('legacy install (no key), bundle moved on: update available from v1', async () => {
    setBundle(HTML_V2, 2);
    const app = db.installApp({ displayName: 'Weather', html: HTML_V1, installSource: SOURCE });
    const status = await starterUpdateStatus(db, app.appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 2, updateAvailable: true });
  });

  it('a non-starter app has no update status', async () => {
    setBundle(HTML_V2, 2);
    const app = db.installApp({ displayName: 'Built by hand', html: HTML_V1 });
    expect(await starterUpdateStatus(db, app.appId)).toBeUndefined();
  });
});

describe('applyStarterUpdate — the update act (AC5, AC7)', () => {
  it('lands the bundle as a new pinned version with the release note and the key', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    const result = await applyStarterUpdate(db, appId);
    expect(result).toMatchObject({ status: 'updated', version: 2 });
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    const versions = db.listAppVersions(appId);
    expect(versions[0]).toMatchObject({ pinned: true, note: 'starter update to v2' });
    expect(versions.filter((v) => v.pinned).map((v) => v.version)).toEqual([versions[0]?.version, 1]);
    expect(db.getSetting(starterVersionSettingKey(appId))).toBe(2);
  });

  it('ships the starter’s NEW contract with the update (not the copy-forward)', async () => {
    setBundle(HTML_V2, 2, { contractRaw: CONTRACT_V2 });
    const appId = installAtV1();
    db.putRuntimeContract(appId, 1, { overview: 'v1 contract' });
    await applyStarterUpdate(db, appId);
    expect(db.getRuntimeContract(appId)?.overview).toBe('v2 contract — shipped by the update.');
    expect(db.getRuntimeContract(appId, 1)?.overview).toBe('v1 contract');
  });

  it('without a bundled contract, the user’s contract carries forward as any edit would', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    db.putRuntimeContract(appId, 1, { overview: 'mine' });
    await applyStarterUpdate(db, appId);
    expect(db.getRuntimeContract(appId)?.overview).toBe('mine');
  });

  it('retains credentials, the approved connection, chat, docs — and the old version stays revertable (AC7)', async () => {
    setBundle(HTML_V1, 1);
    const appId = installAtV1();
    // The user's accumulated state, all keyed by app_id and none by version:
    db.putDeclaredConnection(appId, 'example-api', JSON.parse(MANIFEST), 'starter');
    db.approveConnection(appId, 'example-api');
    db.setSecret(`auth:${appId}:api_key`, 'sk-live-EXAMPLE');
    db.upsertThread('thr-update', { appId, title: 'build thread' });
    db.appendChatMessage('thr-update', 'user', 'hello app');
    db.putAppDoc(appId, 'vision', { content: 'my own vision page' });

    setBundle(HTML_V2, 2);
    await applyStarterUpdate(db, appId);

    expect(db.getConnection(appId, 'example-api')?.status).toBe('approved');
    expect(db.getSecret(`auth:${appId}:api_key`)).toBe('sk-live-EXAMPLE');
    expect(db.listChatMessages('thr-update').map((m) => m.content)).toContain('hello app');
    expect(db.getAppDoc(appId, 'vision')?.content).toBe('my own vision page');
    // The pre-update copy is still there to go back to:
    const preUpdate = db.listAppVersions(appId).find((v) => v.version === 1);
    expect(preUpdate?.pinned).toBe(true);
    db.revertApp(appId, 1);
    expect(db.getAppHtml(appId)).toBe(HTML_V1);
  });

  it('an APPROVED connection is never re-declared by the update (the AC4 lock holds)', async () => {
    setBundle(HTML_V1, 1);
    const appId = installAtV1();
    db.putDeclaredConnection(appId, 'example-api', JSON.parse(MANIFEST), 'starter');
    db.approveConnection(appId, 'example-api');
    const before = db.getConnection(appId, 'example-api');

    setBundle(HTML_V2, 2);
    await applyStarterUpdate(db, appId);
    expect(db.getConnection(appId, 'example-api')).toEqual(before);
  });

  it('is idempotent: a second apply writes no VERSION, no HTML, and no docs (AC5)', async () => {
    // "Writes nothing" reclassified, not deleted (lessons 2026-08-18: migrate the claim):
    // the already-current branch now RUNS the absent-only docs seed for docs-only
    // releases, so the honest claim enumerates what a second apply leaves untouched —
    // including a doc the user rewrote after the first apply, which a re-seed must
    // never clobber (the wiki is living memory, ADR-0010).
    __setStarterDocFixturesForTests(DOCS);
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    await applyStarterUpdate(db, appId);
    db.putAppDoc(appId, 'vision', { content: 'my rewrite — mine to keep' });
    const versionsAfterFirst = db.listAppVersions(appId).length;
    const docsAfterFirst = db.listAppDocs(appId).length;

    const result = await applyStarterUpdate(db, appId);
    expect(result).toMatchObject({ status: 'already-current' });
    expect(db.listAppVersions(appId)).toHaveLength(versionsAfterFirst);
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(db.getSetting(starterVersionSettingKey(appId))).toBe(2);
    expect(db.listAppDocs(appId)).toHaveLength(docsAfterFirst);
    expect(db.getAppDoc(appId, 'vision')?.content).toBe('my rewrite — mine to keep');
  });

  it('heals a missing key when the bytes already match (partial-failure retry)', async () => {
    setBundle(HTML_V2, 2);
    const app = db.installApp({ displayName: 'Weather', html: HTML_V2, installSource: SOURCE });
    const result = await applyStarterUpdate(db, app.appId);
    expect(result).toMatchObject({ status: 'already-current' });
    expect(db.getSetting(starterVersionSettingKey(app.appId))).toBe(2);
  });
});

describe('docs-only releases — identical html, higher version (AC8; plan-review findings 6+12)', () => {
  // A release whose whole payload is the wiki: the bundle's bytes never change, only
  // `starter.json`'s version moves. Detection must OFFER it (byte-equality is not
  // release-equality), and taking it must land the absent docs and record the version
  // so the offer clears — without minting a pointless pinned version.
  beforeEach(() => __setStarterDocFixturesForTests(DOCS));

  it('is offered to a recorded copy; apply seeds the absent docs AND records the version', async () => {
    setBundle(HTML_V1, 2); // v2 ships the SAME bytes — the release payload is the docs
    const appId = installAtV1();

    const status = await starterUpdateStatus(db, appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 2, updateAvailable: true, edited: false });

    const result = await applyStarterUpdate(db, appId);
    expect(result).toMatchObject({ status: 'already-current', version: 2 });
    // The docs landed and the version row cleared the offer…
    expect(db.getAppDoc(appId, 'vision')?.content).toContain('Forecasts turned into decisions');
    expect(db.getSetting(starterVersionSettingKey(appId))).toBe(2);
    expect((await starterUpdateStatus(db, appId))?.updateAvailable).toBe(false);
    // …and nothing else was written: no new pinned version, bytes untouched.
    expect(db.listAppVersions(appId)).toHaveLength(1);
    expect(db.getAppHtml(appId)).toBe(HTML_V1);
  });

  it('legacy copy (no version row) at the bundle bytes: the offer STAYS — unknown means older', async () => {
    // Pre-seeding installs have no `starterVersion:` row. Deriving "current" from
    // byte-equality would hide exactly the release that exists to reach them.
    setBundle(HTML_V1, 2);
    const app = db.installApp({ displayName: 'Weather', html: HTML_V1, installSource: SOURCE });

    const status = await starterUpdateStatus(db, app.appId);
    expect(status).toMatchObject({ installedVersion: 1, latestVersion: 2, updateAvailable: true });

    const result = await applyStarterUpdate(db, app.appId);
    expect(result).toMatchObject({ status: 'already-current', version: 2 });
    expect(db.getSetting(starterVersionSettingKey(app.appId))).toBe(2);
    expect(db.getAppDoc(app.appId, 'lessons')?.content).toContain('docs-only release');
    expect((await starterUpdateStatus(db, app.appId))?.updateAvailable).toBe(false);
  });
});

describe('the two-fact vouch across updates (AC8)', () => {
  it('a legitimately updated app still declares (fact 1 follows the newest pin)', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    await applyStarterUpdate(db, appId);
    const intent = await resolveDeclaredIntent(db, appId);
    expect(intent.declaration?.slot).toBe('example-api');
    expect(intent.mismatch).toBeUndefined();
  });

  it('negative twin: current matches the bundle but no pinned version does — refused', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1(); // pinned v1 = HTML_V1 ≠ bundle
    db.saveAppVersion(appId, HTML_V2, 'hand-edit that happens to equal the bundle');
    const intent = await resolveDeclaredIntent(db, appId);
    expect(intent.mismatch).toBe('html_mismatch');
    expect(intent.declaration).toBeUndefined();
  });

  it('negative twin: newest pin matches the bundle but the RUNNING version does not — refused', async () => {
    setBundle(HTML_V2, 2);
    const appId = installAtV1();
    await applyStarterUpdate(db, appId);
    db.saveAppVersion(appId, '<html>attacker or edit</html>', 'post-update edit');
    const intent = await resolveDeclaredIntent(db, appId);
    expect(intent.mismatch).toBe('html_mismatch');
  });

  it('negative twin: ZERO pinned rows + matching current — refused (plan-review finding 6)', async () => {
    setBundle(HTML_V2, 2);
    // A forged whole-DB import can present any version-row shape; the accessor path
    // cannot produce one, so the shape is stubbed at the UserDb face — the two real-db
    // twins above cover the accessor-reachable states.
    const forged = {
      getApp: () => ({ appId: 'forged', installSource: SOURCE, currentVersion: 3 }),
      listAppVersions: () => [
        { version: 3, createdAt: 'x', htmlBytes: HTML_V2.length, pinned: false },
        { version: 1, createdAt: 'x', htmlBytes: HTML_V2.length, pinned: false },
      ],
      getAppHtml: () => HTML_V2,
    } as unknown as UserDb;
    const intent = await resolveDeclaredIntent(forged, 'forged');
    expect(intent.mismatch).toBe('html_mismatch');
  });
});
