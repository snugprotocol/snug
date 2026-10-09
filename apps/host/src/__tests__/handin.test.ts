// handin.test.ts — TASK-20260905-binding-a-artifacts AC8: the hand-in over a REAL user db,
// blocks produced by the ONE grammar (`page-blocks`), hostile fixtures included.
//
// TASK-20261003 K4/K6: `applyAgentBundles` is the ONE core — the page's embedded blocks
// (Binding A, at boot) and the runner's events (Binding B, live) both go through it. It was
// `handInFromPage` until then; the rename is the only change to the cases below, and the
// new ones (the tombstone option, the seat, the parity statement) follow them.
import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';
import { agentDismissedSettingKey, agentInstallSource, sharedBundleSettingKey } from '@snugprotocol/db';
import { appBundleId, type AppBundle } from '@snugprotocol/protocol';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';

import { CONNECTIONS_UNAVAILABLE } from '@playground/platform/availability';

import { readBundleBlocks, upsertBundleBlock, type BundleBlockRead } from '../../../../scripts/lib/page-blocks.mjs';
import { applyAgentBundles, applyPendingHandIn, createHandInSeat, describeHandIn, readBundleBlocksFromDocument, type HandInOutcome } from '../handin.js';

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

describe('applyAgentBundles', () => {
  it('installs a new lineage as an owned agent app; the same block on the next boot is skipped as current', async () => {
    const first = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(first.installed).toHaveLength(1);
    const appId = first.installed[0]!.appId;
    expect(db.getApp(appId)?.installSource).toBe(agentInstallSource(LINEAGE_A));
    expect(db.getAppHtml(appId)).toBe(HTML_V1);
    expect(db.listAppDocs(appId).map((d) => d.slug)).toEqual(['vision']);
    const again = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(again).toMatchObject({ installed: [], updated: [], pending: [], skipped: [{ lineage: LINEAGE_A, reason: 'current' }] });
    expect(db.listApps()).toHaveLength(1);
  });

  it('a changed html for an UNEDITED copy lands as a new pinned version; the hostile html survives the block round trip intact', async () => {
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    const appId = installed[0]!.appId;
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    expect(outcome.updated).toEqual([{ appId, displayName: 'Pomodoro', version: 2 }]);
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(db.listAppVersions(appId).filter((v) => v.pinned).map((v) => v.version).sort()).toEqual([1, 2]);
    expect(db.listAppVersions(appId).find((v) => v.version === 2)?.note).toBe('updated by your agent');
  });

  it('an EDITED copy is never superseded: the hand-in is pending (zero versions written) until applyPendingHandIn', async () => {
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    const appId = installed[0]!.appId;
    db.saveAppVersion(appId, USER_EDIT, 'user edit');
    const before = db.listAppVersions(appId).length;
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
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
    const outcome = await applyAgentBundles(db, blocksOf(bundle(built.appId, HTML_V2)));
    expect(outcome.updated).toEqual([{ appId: built.appId, displayName: 'Built here', version: 2 }]);
    expect(db.getApp(built.appId)?.installSource).toBeUndefined();
    expect(db.listApps()).toHaveLength(1);
  });

  it('delete holds: a tombstoned bundle id is skipped; a NEW bundle id from the agent installs again', async () => {
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(installed[0]!.appId);
    expect(db.getSetting(agentDismissedSettingKey(LINEAGE_A))).toBe(await appBundleId(bundle(LINEAGE_A, HTML_V1)));
    const same = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(same).toMatchObject({ installed: [], skipped: [{ lineage: LINEAGE_A, reason: 'dismissed' }] });
    expect(db.listApps()).toHaveLength(0);
    const newer = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    expect(newer.installed).toHaveLength(1);
  });

  it('(N, D4) a bundle carrying connections is refused by name — nothing installs, the other block still lands', async () => {
    const withConnections = bundle(LINEAGE_A, HTML_V1, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await applyAgentBundles(db, blocksOf(withConnections, bundle(LINEAGE_B, HTML_V1)));
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]!.reason).toMatch(/connection/);
    expect(outcome.installed).toHaveLength(1);
    expect(db.listApps()).toHaveLength(1);
    expect(db.getSetting(sharedBundleSettingKey(outcome.installed[0]!.appId))).toBeDefined();
  });

  it('(K4) the refusal says "connections aren’t available" in the kit’s ONE sentence — the tile, the passport and the chat card say the same', async () => {
    // The hand-in wrote its own ("connected apps are not available inside an artifact"),
    // which was also wrong under every other binding this core serves (a chat, a plain file).
    const withConnections = bundle(LINEAGE_A, HTML_V1, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await applyAgentBundles(db, blocksOf(withConnections));
    expect(CONNECTIONS_UNAVAILABLE).toBe('connections aren’t available in this host');
    expect(outcome.refused[0]!.reason).toBe(`"Pomodoro" asks for 1 connection(s) — ${CONNECTIONS_UNAVAILABLE}, so this hand-in was refused`);
    // Under the runner connections ARE available; the refusal there is about who makes one.
    const local = await applyAgentBundles(db, blocksOf(withConnections), { binding: 'local-host' });
    expect(local.refused[0]!.reason).not.toContain(CONNECTIONS_UNAVAILABLE);
    expect(local.refused[0]!.reason).toContain('A bundle cannot bring a connection.');
  });

  it('(N) hostile blocks are refused by name, never thrown: not JSON, not a bundle, a lineage that disagrees, a non-UUID lineage', async () => {
    const blocks: BundleBlockRead[] = [
      { lineage: LINEAGE_A, json: '{not json', index: 0, end: 0 },
      { lineage: LINEAGE_A, json: JSON.stringify({ format: 'other' }), index: 0, end: 0 },
      { lineage: LINEAGE_B, json: JSON.stringify(bundle(LINEAGE_A, HTML_V1)), index: 0, end: 0 },
      { lineage: 'starter:chess', json: JSON.stringify(bundle(LINEAGE_A, HTML_V1)), index: 0, end: 0 },
    ];
    const outcome = await applyAgentBundles(db, blocks);
    expect(outcome.refused).toHaveLength(4);
    expect(outcome.refused[2]!.reason).toMatch(/does not match/);
    expect(db.listApps()).toHaveLength(0);
  });

  it('describeHandIn says what happened in one line, or nothing', async () => {
    expect(describeHandIn({ installed: [], updated: [], pending: [], skipped: [], refused: [] })).toBeUndefined();
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
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
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    db.saveAppVersion(installed[0]!.appId, USER_EDIT, 'user edit');
    const withConnections = bundle(LINEAGE_A, HTML_V2, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await applyAgentBundles(db, blocksOf(withConnections));
    expect(outcome.pending).toEqual([]);
    expect(outcome.refused).toHaveLength(1);
    expect(outcome.refused[0]!.reason).toMatch(/connection/);
  });

  it('(security review 3) a `share:` copy whose own id is the lineage is never a lifted-from target — the block installs a separate owned app', async () => {
    const { installAppFromBundle } = await import('@snugprotocol/db');
    const shared = await installAppFromBundle(db, bundle(LINEAGE_A, HTML_V1), { bundleId: 'from-the-sharer' });
    const outcome = await applyAgentBundles(db, blocksOf(bundle(shared.appId, HTML_V2)));
    expect(outcome.installed).toHaveLength(1);
    expect(outcome.installed[0]!.appId).not.toBe(shared.appId);
    expect(db.getAppHtml(shared.appId)).toBe(HTML_V1);
  });

  it('(correctness review 10) the tombstone applies only when NO target exists — a live app still takes a rolled-back bundle', async () => {
    const first = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(first.installed[0]!.appId); // tombstone = X (v1's id)
    const second = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2))); // Y installs
    expect(second.installed).toHaveLength(1);
    const rolledBack = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1))); // X again, app present → update, not "dismissed"
    expect(rolledBack.updated).toHaveLength(1);
    expect(db.getAppHtml(second.installed[0]!.appId)).toBe(HTML_V1);
  });
});

// ------------------------------------------------------------------ the one-kit range

describe('the tombstone, behind an option (K6)', () => {
  it('an EXPLICIT hand-in clears the tombstone and installs — the user’s agent is handing the app in again, now', async () => {
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(installed[0]!.appId);
    expect(db.getSetting(agentDismissedSettingKey(LINEAGE_A))).toBeDefined();

    const again = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)), { explicit: true });
    expect(again.skipped).toEqual([]);
    expect(again.installed).toHaveLength(1);
    expect(db.getApp(again.installed[0]!.appId)?.installSource).toBe(agentInstallSource(LINEAGE_A));
    expect(db.getSetting(agentDismissedSettingKey(LINEAGE_A)), 'the tombstone is CLEARED, not merely stepped over').toBeUndefined();
  });

  it('…so the page’s own block for that lineage is not dismissed again on the next boot either', async () => {
    // The tombstone is cleared rather than bypassed: with it left in place, a Binding-A
    // page carrying the same bundle would read "dismissed" for an app that is installed.
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    await db.deleteApp(installed[0]!.appId);
    await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)), { explicit: true });
    const boot = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    expect(boot.skipped).toEqual([{ lineage: LINEAGE_A, reason: 'current' }]);
  });

  it('explicit changes NOTHING else: an edited copy is still only offered, a connection is still refused', async () => {
    const { installed } = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)), { explicit: true });
    db.saveAppVersion(installed[0]!.appId, USER_EDIT, 'user edit');
    const offered = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2)), { explicit: true });
    expect(offered.updated).toEqual([]);
    expect(offered.pending).toHaveLength(1);
    expect(db.getAppHtml(installed[0]!.appId)).toBe(USER_EDIT);

    const withConnections = bundle(LINEAGE_B, HTML_V1, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const refused = await applyAgentBundles(db, blocksOf(withConnections), { explicit: true, binding: 'local-host' });
    expect(refused.installed).toEqual([]);
    expect(refused.refused[0]!.reason).toMatch(/connect it yourself in Snug/);
  });
});

describe('PARITY — one core, two bindings, ONE difference (K4/K6)', () => {
  /** The same story under each binding's options, on its own fresh db. */
  const story = async (options: Parameters<typeof applyAgentBundles>[2]): Promise<Record<string, unknown>> => {
    const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
    if (opened.status !== 'ok') throw new Error('open failed');
    const fresh = opened.userDb;
    const shape = (o: HandInOutcome) => ({
      installed: o.installed.map((a) => a.displayName),
      updated: o.updated.map((a) => `${a.displayName} v${a.version}`),
      pending: o.pending.map((p) => p.displayName),
      skipped: o.skipped.map((s) => s.reason),
      refused: o.refused.length,
    });
    const steps: Record<string, unknown> = {};
    const first = await applyAgentBundles(fresh, blocksOf(bundle(LINEAGE_A, HTML_V1)), options);
    steps.install = shape(first);
    steps.again = shape(await applyAgentBundles(fresh, blocksOf(bundle(LINEAGE_A, HTML_V1)), options));
    steps.update = shape(await applyAgentBundles(fresh, blocksOf(bundle(LINEAGE_A, HTML_V2)), options));
    fresh.saveAppVersion(first.installed[0]!.appId, USER_EDIT, 'user edit');
    steps.edited = shape(await applyAgentBundles(fresh, blocksOf(bundle(LINEAGE_A, HTML_V1)), options));
    steps.hostile = shape(await applyAgentBundles(fresh, [{ lineage: LINEAGE_B, json: '{not json' }], options));
    await fresh.deleteApp(first.installed[0]!.appId);
    // The bundle the app WAS when it was deleted (v2): that is the id the tombstone names.
    steps.afterDelete = shape(await applyAgentBundles(fresh, blocksOf(bundle(LINEAGE_A, HTML_V2)), options));
    await fresh.close();
    return steps;
  };

  it('install, re-hand-in, update, an edited copy and a hostile block behave IDENTICALLY; only a deleted app differs', async () => {
    const page = await story({ binding: 'artifact' }); // Binding A: blocks riding the page, re-read every boot
    const runner = await story({ binding: 'local-host', explicit: true }); // Binding B: the agent's tool call
    const { afterDelete: pageAfterDelete, ...pageRest } = page;
    const { afterDelete: runnerAfterDelete, ...runnerRest } = runner;
    expect(runnerRest).toEqual(pageRest);
    // THE ONE DIFFERENCE. A block riding a page is re-read on every load, so honouring it
    // after a delete would resurrect the app each time the page opens: it stays deleted.
    // The runner's hand-in is the agent acting NOW, at the user's request: it installs.
    expect(pageAfterDelete).toEqual({ installed: [], updated: [], pending: [], skipped: ['dismissed'], refused: 0 });
    expect(runnerAfterDelete).toEqual({ installed: ['Pomodoro'], updated: [], pending: [], skipped: [], refused: 0 });
  });
});

describe('the hand-in seat — what is offered, and when an offer is withdrawn (K6)', () => {
  /** An edited copy with a newer version handed in: one pending entry on the seat. */
  const offered = async () => {
    const seat = createHandInSeat();
    const first = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    const appId = first.installed[0]!.appId;
    db.saveAppVersion(appId, USER_EDIT, 'user edit');
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2)));
    seat.absorb(db, outcome);
    return { seat, appId, bundleId: outcome.pending[0]!.bundleId };
  };

  it('offers an edited copy’s update and applies it on request — never before', async () => {
    const { seat, appId, bundleId } = await offered();
    expect(seat.seat.pending.get()).toEqual([{ appId, displayName: 'Pomodoro', bundleId }]);
    expect(db.getAppHtml(appId)).toBe(USER_EDIT);
    const applied = await seat.seat.apply(appId);
    expect(applied.version).toBe(3);
    expect(db.getAppHtml(appId)).toBe(HTML_V2);
    expect(seat.seat.pending.get(), 'pruned when APPLIED').toEqual([]);
    await expect(seat.seat.apply(appId)).rejects.toThrow(/nothing is pending/);
  });

  it('tells its subscribers when an offer arrives and when it is taken', async () => {
    const seat = createHandInSeat();
    let notified = 0;
    seat.seat.pending.subscribe(() => void (notified += 1));
    const first = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V1)));
    db.saveAppVersion(first.installed[0]!.appId, USER_EDIT, 'user edit');
    seat.absorb(db, await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2))));
    expect(notified).toBe(1);
    await seat.seat.apply(first.installed[0]!.appId);
    expect(notified).toBe(2);
  });

  it('the snapshot is STABLE between changes — a fresh array per read would re-render its reader for ever', async () => {
    const { seat } = await offered();
    expect(seat.seat.pending.get()).toBe(seat.seat.pending.get());
  });

  it('pruned when the app is DELETED — an offer for an app that is gone is nobody’s', async () => {
    const { seat, appId } = await offered();
    await db.deleteApp(appId);
    expect(seat.seat.pending.get()).toEqual([]);
    await expect(seat.seat.apply(appId)).rejects.toThrow(/nothing is pending/);
  });

  it('pruned when the app is MADE CURRENT by another path — the offered version is what the app already is', async () => {
    const { seat, appId } = await offered();
    // The user takes the same version through a second seat (another tab's offer, say).
    const other = createHandInSeat();
    other.absorb(db, await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, HTML_V2))));
    await other.seat.apply(appId);
    expect(seat.seat.pending.get()).toEqual([]);
  });

  it('pruned when a LATER hand-in updates the app directly — the older offer must not outlive it', async () => {
    const { seat, appId } = await offered();
    // The user reverts to the agent's version (unedited again), and the agent hands in v3.
    db.saveAppVersion(appId, HTML_V1, 'reverted');
    const v3 = '<!doctype html><html><body>timer v3</body></html>';
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, v3)));
    expect(outcome.updated).toHaveLength(1);
    seat.absorb(db, outcome);
    expect(seat.seat.pending.get()).toEqual([]);
    expect(db.getAppHtml(appId)).toBe(v3);
  });

  it('a newer offer for the same app REPLACES the older one — one offer per app', async () => {
    const { seat, appId, bundleId } = await offered();
    const v3 = '<!doctype html><html><body>timer v3</body></html>';
    const outcome = await applyAgentBundles(db, blocksOf(bundle(LINEAGE_A, v3)));
    seat.absorb(db, outcome);
    const pending = seat.seat.pending.get();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.appId).toBe(appId);
    expect(pending[0]!.bundleId).not.toBe(bundleId);
    await seat.seat.apply(appId);
    expect(db.getAppHtml(appId)).toBe(v3);
  });
});
