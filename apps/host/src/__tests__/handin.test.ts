// handin.test.ts — TASK-20260905-binding-a-artifacts AC8: the boot-time hand-in over a REAL
// user db, blocks produced by the ONE grammar (`page-blocks`), hostile fixtures included.
import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';
import { agentDismissedSettingKey, agentInstallSource, sharedBundleSettingKey } from '@snugprotocol/db';
import { appBundleId, type AppBundle } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';

import { readBundleBlocks, upsertBundleBlock, type BundleBlockRead } from '../../../../scripts/lib/page-blocks.mjs';
import { applyPendingHandIn, describeHandIn, handInFromPage, readBundleBlocksFromDocument } from '../handin.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const PAGE = '<!doctype html>\n<html><head><script type="module">/* kit */</script></head><body><div id="root"></div>\n</body></html>\n';
const LINEAGE_A = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const LINEAGE_B = '11111111-2222-4333-8444-555555555555';
const HTML_V1 = '<!doctype html><html><body>timer v1</body></html>';
const HTML_V2 = '<!doctype html><html><body>timer v2 <script>alert("</script>")</script><!-- x --></body></html>';
const USER_EDIT = '<!doctype html><html><body>the user changed this</body></html>';

const bundle = (lineage: string, html: string, extra: Partial<AppBundle> = {}): AppBundle => ({
  format: 'snug-app-bundle/1',
  lineage,
  sharedAt: '2026-09-05T00:00:00.000Z',
  app: { displayName: 'Pomodoro', usesDb: true },
  html,
  schema: { ddl: ['CREATE TABLE sessions (id INTEGER PRIMARY KEY, minutes INTEGER)'] },
  docs: [{ slug: 'vision', title: 'Vision', content: 'A pomodoro timer.' }],
  connections: [],
  ...extra,
});

const blocksOf = (...bundles: AppBundle[]): BundleBlockRead[] =>
  readBundleBlocks(bundles.reduce((page, b) => upsertBundleBlock(page, b.lineage, JSON.stringify(b)), PAGE));

let db: UserDb;
beforeEach(async () => {
  const result = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (result.status !== 'ok') throw new Error('open failed');
  db = result.userDb;
});

describe('handInFromPage', () => {
  it('installs a new lineage as an owned agent app; the same block on the next boot is skipped as current', async () => {
    const first = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(first.installed).toHaveLength(1);
    const appId = first.installed[0]!.appId;
    expect(db.getApp(appId)?.installSource).toBe(agentInstallSource(LINEAGE_A));
    expect(db.getAppHtml(appId)).toBe(HTML_V1);
    expect(db.listAppDocs(appId).map((d) => d.slug)).toEqual(['vision']);
    const again = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(again).toMatchObject({ installed: [], updated: [], pending: [], skipped: [{ lineage: LINEAGE_A, reason: 'current' }] });
    expect(db.listApps()).toHaveLength(1);
  });

  it('a changed html for an UNEDITED copy lands as a new pinned version; the hostile html survives the block round trip intact', async () => {
    const { installed } = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    const appId = installed[0]!.appId;
    const outcome = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    expect(outcome.updated).toEqual([{ appId, displayName: 'Pomodoro', version: 2 }]);
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(db.listAppVersions(appId).filter((v) => v.pinned).map((v) => v.version).sort()).toEqual([1, 2]);
    expect(db.listAppVersions(appId).find((v) => v.version === 2)?.note).toBe('updated by your agent');
  });

  it('an EDITED copy is never superseded: the hand-in is pending (zero versions written) until applyPendingHandIn', async () => {
    const { installed } = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    const appId = installed[0]!.appId;
    db.saveAppVersion(appId, USER_EDIT, 'user edit');
    const before = db.listAppVersions(appId).length;
    const outcome = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    expect(outcome.updated).toEqual([]);
    expect(outcome.pending).toHaveLength(1);
    expect(outcome.pending[0]).toMatchObject({ lineage: LINEAGE_A, appId, displayName: 'Pomodoro' });
    expect(db.listAppVersions(appId)).toHaveLength(before);
    expect(db.getAppHtml(appId)).toBe(USER_EDIT);
    const applied = await applyPendingHandIn(db, outcome.pending[0]!);
    expect(applied.version).toBe(before + 1);
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(db.getAppHtml(appId, 2)).toBe(USER_EDIT); // the user's version stays revertable
  });

  it('the lifted-from app (a kit-built app whose id is the lineage) takes the update in place; its install_source stays absent', async () => {
    const built = db.installApp({ displayName: 'Built here', usesDb: true, html: HTML_V1 });
    const outcome = await handInFromPage(db, blocksOf(bundle(built.appId, HTML_V2)));
    expect(outcome.updated).toEqual([{ appId: built.appId, displayName: 'Built here', version: 2 }]);
    expect(db.getApp(built.appId)?.installSource).toBeUndefined();
    expect(db.listApps()).toHaveLength(1);
  });

  it('delete holds: a tombstoned bundle id is skipped; a NEW bundle id from the agent installs again', async () => {
    const { installed } = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(installed[0]!.appId);
    expect(db.getSetting(agentDismissedSettingKey(LINEAGE_A))).toBe(await appBundleId(bundle(LINEAGE_A, HTML_V1)));
    const same = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(same).toMatchObject({ installed: [], skipped: [{ lineage: LINEAGE_A, reason: 'dismissed' }] });
    expect(db.listApps()).toHaveLength(0);
    const newer = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    expect(newer.installed).toHaveLength(1);
  });

  it('(N, D4) a bundle carrying connections is refused by name — nothing installs, the other block still lands', async () => {
    const withConnections = bundle(LINEAGE_A, HTML_V1, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await handInFromPage(db, blocksOf(withConnections, bundle(LINEAGE_B, HTML_V1)));
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]!.reason).toMatch(/connection/);
    expect(outcome.installed).toHaveLength(1);
    expect(db.listApps()).toHaveLength(1);
    expect(db.getSetting(sharedBundleSettingKey(outcome.installed[0]!.appId))).toBeDefined();
  });

  it('(N) hostile blocks are refused by name, never thrown: not JSON, not a bundle, a lineage that disagrees, a non-UUID lineage', async () => {
    const blocks: BundleBlockRead[] = [
      { lineage: LINEAGE_A, json: '{not json', index: 0, end: 0 },
      { lineage: LINEAGE_A, json: JSON.stringify({ format: 'other' }), index: 0, end: 0 },
      { lineage: LINEAGE_B, json: JSON.stringify(bundle(LINEAGE_A, HTML_V1)), index: 0, end: 0 },
      { lineage: 'starter:chess', json: JSON.stringify(bundle(LINEAGE_A, HTML_V1)), index: 0, end: 0 },
    ];
    const outcome = await handInFromPage(db, blocks);
    expect(outcome.refused).toHaveLength(4);
    expect(outcome.refused[2]!.reason).toMatch(/does not match/);
    expect(db.listApps()).toHaveLength(0);
  });

  it('describeHandIn says what happened in one line, or nothing', async () => {
    expect(describeHandIn({ installed: [], updated: [], pending: [], skipped: [], refused: [] })).toBeUndefined();
    const outcome = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(describeHandIn(outcome)).toBe('installed by your agent: Pomodoro');
  });
});

describe('readBundleBlocksFromDocument — the DOM at boot', () => {
  it('reads every bundle block with its lineage and text, in page order', () => {
    const page = upsertBundleBlock(upsertBundleBlock(PAGE, LINEAGE_A, JSON.stringify(bundle(LINEAGE_A, HTML_V2))), LINEAGE_B, JSON.stringify(bundle(LINEAGE_B, HTML_V1)));
    // The vitest environment is jsdom: a parsed document (scripts never run under DOMParser).
    const parsed = new DOMParser().parseFromString(page, 'text/html');
    const blocks = readBundleBlocksFromDocument(parsed);
    expect(blocks.map((b) => b.lineage)).toEqual([LINEAGE_A, LINEAGE_B]);
    expect((JSON.parse(blocks[0]!.json) as AppBundle).html).toBe(HTML_V2);
  });
});

describe('the review’s hand-in rules', () => {
  it('(N, security review 4) a connections-bearing bundle for an EDITED copy is refused at the boundary — never offered', async () => {
    const { installed } = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    db.saveAppVersion(installed[0]!.appId, USER_EDIT, 'user edit');
    const withConnections = bundle(LINEAGE_A, HTML_V2, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await handInFromPage(db, blocksOf(withConnections));
    expect(outcome.pending).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]!.reason).toMatch(/connection/);
  });

  it('(security review 3) a `share:` copy whose own id is the lineage is never a lifted-from target — the block installs a separate owned app', async () => {
    const { installAppFromBundle } = await import('@snugprotocol/db');
    const shared = await installAppFromBundle(db, bundle(LINEAGE_A, HTML_V1), { bundleId: 'from-the-sharer' });
    const outcome = await handInFromPage(db, blocksOf(bundle(shared.appId, HTML_V2)));
    expect(outcome.installed).toHaveLength(1);
    expect(outcome.installed[0]!.appId).not.toBe(shared.appId);
    expect(db.getAppHtml(shared.appId)).toBe(HTML_V1);
  });

  it('(correctness review 10) the tombstone applies only when NO target exists — a live app still takes a rolled-back bundle', async () => {
    const first = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(first.installed[0]!.appId); // tombstone = X (v1's id)
    const second = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V2))); // Y installs
    expect(second.installed).toHaveLength(1);
    const rolledBack = await handInFromPage(db, blocksOf(bundle(LINEAGE_A, HTML_V1))); // X again, app present → update, not "dismissed"
    expect(rolledBack.updated).toHaveLength(1);
    expect(db.getAppHtml(second.installed[0]!.appId)).toBe(HTML_V1);
  });
});
