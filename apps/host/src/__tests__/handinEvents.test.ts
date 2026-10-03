// AC8 — a hand-in arriving while the page is already running.
//
// MIGRATED 2026-10-03 (TASK-20261003 K4/K6). This file used to MOCK `../handin.js` and assert
// which arguments reached the mock. The core is now `applyAgentBundles` (one core for both
// bindings), the note is the ONE summary (`describeHandIn` — `describeLocalHandIn`, a second
// sentence for the same fact, is gone), the event carries an id and the page reports the
// outcome back. So the same five claims are made against the REAL core over a REAL user db —
// a mock could not have shown that the connections refusal really reads for this binding, or
// that an offered update really reaches the seat — and the K6 claims follow them.

import { createMemoryBackend, openUserDb, type UserDb } from '@snugprotocol/db';
import type { AppBundle } from '@snugprotocol/protocol';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHandInSeat, describeHandIn, type HandInSeat } from '../handin.js';
import type { HandInReport } from '../local/client.js';
import { HAND_IN_DB_BOUND_MS, applyHandInEvent, reportFor } from '../local/handinEvents.js';

const require = createRequire(import.meta.url);
const locateWasm = (): string => require.resolve('sql.js/dist/sql-wasm.wasm');

const LINEAGE = '0123abcd-4567-49ab-8def-0123456789ab';
const ID = 'e'.repeat(32);
const V1 = '<!doctype html><html><body>chess v1</body></html>';
const V2 = '<!doctype html><html><body>chess v2</body></html>';
const EDIT = '<!doctype html><html><body>the user changed this</body></html>';

const bundle = (html = V1, extra: Partial<AppBundle> = {}): AppBundle => ({
  format: 'snug-app-bundle/1',
  lineage: LINEAGE,
  sharedAt: '2026-09-07T00:00:00.000Z',
  app: { displayName: 'Chess', usesDb: false },
  html,
  connections: [],
  ...extra,
});

let db: UserDb;
let seat: HandInSeat;
let reports: HandInReport[];
let notes: string[];
let libraryChanges: number;

beforeEach(async () => {
  const opened = await openUserDb({ backend: createMemoryBackend(), locateWasm, persistDebounceMs: 1 });
  if (opened.status !== 'ok') throw new Error('open failed');
  db = opened.userDb;
  seat = createHandInSeat();
  reports = [];
  notes = [];
  libraryChanges = 0;
});

const deps = () => ({
  getDb: async () => db,
  handIns: seat,
  onLibraryChanged: () => void (libraryChanges += 1),
  onNote: (note: string) => void notes.push(note),
  report: (report: HandInReport) => void reports.push(report),
});

describe('applying a delivered bundle', () => {
  it('applies it and tells the surfaces, so the hub does not show a stale shelf', async () => {
    const outcome = await applyHandInEvent({ id: ID, bundle: bundle() }, deps());
    expect(outcome.installed).toHaveLength(1);
    expect(db.listApps().map((app) => app.displayName)).toEqual(['Chess']);
    expect(libraryChanges).toBe(1);
    // The ONE summary — the sentence Binding A's boot puts on the same chip.
    expect(notes).toEqual(['installed by your agent: Chess']);
  });

  it('is the local-host binding, so the connections refusal reads for THIS binding', async () => {
    const withConnections = bundle(V1, {
      connections: [{ slot: 'weather', provider: { name: 'OpenWeather' }, kind: 'api_key', fields: [{ key: 'api_key', label: 'API key', type: 'secret' }], declaredApiHosts: ['api.openweathermap.org'] }],
    });
    const outcome = await applyHandInEvent({ id: ID, bundle: withConnections }, deps());
    expect(outcome.refused[0]!.reason).toMatch(/connect it yourself in Snug/);
    expect(outcome.refused[0]!.reason).not.toMatch(/inside an artifact/);
    expect(db.listApps()).toHaveLength(0);
  });

  it('reads the lineage from the BUNDLE, not from the envelope — and takes a bundle sent as text', async () => {
    const outcome = await applyHandInEvent({ id: ID, bundle: JSON.stringify(bundle()) }, deps());
    expect(outcome.installed).toHaveLength(1);
    expect(db.getApp(outcome.installed[0]!.appId)?.installSource).toBe(`agent:${LINEAGE}`);
  });

  it('refreshes the library even when nothing applied — a stale shelf is the failure mode', async () => {
    const outcome = await applyHandInEvent({ id: ID, bundle: 'not json' }, deps());
    expect(outcome.refused).toHaveLength(1);
    expect(libraryChanges).toBe(1);
  });
});

describe('the note the user reads', () => {
  it('says nothing when nothing happened', async () => {
    await applyHandInEvent({ id: ID, bundle: bundle() }, deps());
    notes.length = 0;
    await applyHandInEvent({ id: ID, bundle: bundle() }, deps()); // the same bundle again: current
    expect(notes).toEqual([]);
    expect(describeHandIn({ installed: [], updated: [], pending: [], skipped: [], refused: [] })).toBeUndefined();
  });

  it('carries a refusal’s own reason rather than a generic failure', async () => {
    await applyHandInEvent({ id: ID, bundle: { format: 'nope' } }, deps());
    expect(notes[0]).toMatch(/^refused: the handed-in block is not a Snug app bundle/);
  });
});

describe('the outcome goes back to the tool that sent the bundle (K6)', () => {
  it('installed, then updated to the version it landed as, then already current', async () => {
    await applyHandInEvent({ id: ID, bundle: bundle(V1) }, deps());
    await applyHandInEvent({ id: 'a'.repeat(32), bundle: bundle(V2) }, deps());
    await applyHandInEvent({ id: 'b'.repeat(32), bundle: bundle(V2) }, deps());
    expect(reports).toEqual([
      { id: ID, outcome: 'installed' },
      { id: 'a'.repeat(32), outcome: 'updated', version: 2 },
      { id: 'b'.repeat(32), outcome: 'current' },
    ]);
  });

  it('offered — an edited copy is never superseded, the offer reaches the seat, and the agent is told it is waiting', async () => {
    const first = await applyHandInEvent({ id: ID, bundle: bundle(V1) }, deps());
    const appId = first.installed[0]!.appId;
    db.saveAppVersion(appId, EDIT, 'user edit');
    reports.length = 0;

    await applyHandInEvent({ id: ID, bundle: bundle(V2) }, deps());
    expect(reports).toEqual([{ id: ID, outcome: 'offered' }]);
    expect(db.getAppHtml(appId)).toBe(EDIT);
    // Binding B's seat — the run header's "update from your agent" reads this.
    expect(seat.seat.pending.get()).toMatchObject([{ appId, displayName: 'Chess' }]);
    expect(notes.at(-1)).toMatch(/you edited it, so the update is offered in the app/);
    await seat.seat.apply(appId);
    expect(db.getAppHtml(appId)).toBe(V2);
  });

  it('refused, with the reason', async () => {
    await applyHandInEvent({ id: ID, bundle: { ...bundle(), lineage: 'starter:chess' } }, deps());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ id: ID, outcome: 'refused' });
    expect(reports[0]!.reason).toMatch(/not a Snug app bundle|does not match/);
  });

  it('a user file that cannot be opened is a refusal the agent AND the user hear about — never a silent nothing', async () => {
    const outcome = await applyHandInEvent(
      { id: ID, bundle: bundle() },
      {
        ...deps(),
        getDb: async () => {
          throw new Error('the file is locked');
        },
      },
    );
    expect(outcome.refused[0]!.reason).toBe('your Snug file could not be opened (the file is locked)');
    expect(reports).toEqual([{ id: ID, outcome: 'refused', reason: 'your Snug file could not be opened (the file is locked)' }]);
    expect(notes[0]).toMatch(/could not be opened/);
  });

  it('an event with no id (an older runner) is applied and reports nothing', async () => {
    const report = vi.fn();
    const outcome = await applyHandInEvent({ bundle: bundle() }, { ...deps(), report });
    expect(outcome.installed).toHaveLength(1);
    expect(report).not.toHaveBeenCalled();
  });

  it('the report is sent BEFORE the surfaces are told — the tool’s bound is short and a slow re-render must not spend it', async () => {
    const order: string[] = [];
    await applyHandInEvent(
      { id: ID, bundle: bundle() },
      { ...deps(), report: () => void order.push('report'), onLibraryChanged: () => void order.push('library') },
    );
    expect(order).toEqual(['report', 'library']);
  });
});

describe('a hand-in is never left hanging and never rejects (K6)', () => {
  // The page's user db does not REJECT when the file cannot open — `getUserDb()` simply never
  // settles (the App shows its recovery surface instead). Awaited unbounded, the refusal
  // above could never be reported, and the tool's 5 s wait ran out into "sent — not
  // confirmed": the one answer that tells the agent nothing about a file that is broken.
  const never = (): Promise<UserDb> => new Promise<UserDb>(() => undefined);
  const hung = Symbol('hung');
  const orHung = <T,>(work: Promise<T>): Promise<T | typeof hung> => Promise.race([work, new Promise<typeof hung>((resolve) => setTimeout(() => resolve(hung), 1_500))]);

  it('a user file that NEVER opens is refused inside the bound — the agent and the user are told, in time', async () => {
    const outcome = await orHung(applyHandInEvent({ id: ID, bundle: bundle() }, { ...deps(), getDb: never, dbBoundMs: 25 }));
    if (outcome === hung) throw new Error('the hand-in waited on a file that never opens');
    expect(outcome.refused[0]!.reason).toBe('your Snug file could not be opened (it did not open in time)');
    expect(reports).toEqual([{ id: ID, outcome: 'refused', reason: 'your Snug file could not be opened (it did not open in time)' }]);
    expect(notes[0]).toMatch(/could not be opened/);
  });

  it('a file that opens AFTER the bound takes nothing — the agent was told "refused", and must not find the app installed anyway', async () => {
    const late = (): Promise<UserDb> => new Promise<UserDb>((resolve) => setTimeout(() => resolve(db), 60));
    const outcome = await orHung(applyHandInEvent({ id: ID, bundle: bundle() }, { ...deps(), getDb: late, dbBoundMs: 20 }));
    if (outcome === hung) throw new Error('the hand-in waited on a file that never opens');
    expect(outcome.refused).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(db.listApps()).toEqual([]);
    expect(seat.seat.pending.get()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  it('a file that opens INSIDE the bound is applied as ever, and the bound’s timer is cleared — not left to fire after every hand-in', async () => {
    // A bound no other timer in this path uses, so its own `setTimeout` can be told apart.
    const BOUND = 43_210;
    const set = vi.spyOn(globalThis, 'setTimeout');
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    try {
      const prompt = (): Promise<UserDb> => new Promise<UserDb>((resolve) => queueMicrotask(() => resolve(db)));
      const outcome = await applyHandInEvent({ id: ID, bundle: bundle() }, { ...deps(), getDb: prompt, dbBoundMs: BOUND });
      expect(outcome.installed).toHaveLength(1);
      expect(reports).toEqual([{ id: ID, outcome: 'installed' }]);
      const armed = set.mock.calls.findIndex(([, ms]) => ms === BOUND);
      expect(armed, 'the bound was armed').not.toBe(-1);
      expect(clear).toHaveBeenCalledWith(set.mock.results[armed]!.value);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it('the default bound sits INSIDE the runner’s wait for the outcome, with room for the report’s round trip', () => {
    // The runner's constant lives in Node code this page cannot import; its source is read.
    const runner = readFileSync(path.resolve(__dirname, '../../../host-mcp/src/runner.ts'), 'utf8');
    const wait = /^const HAND_IN_WAIT_MS = ([\d_]+);$/m.exec(runner)?.[1];
    expect(wait, 'the runner’s HAND_IN_WAIT_MS moved or was renamed').toBeDefined();
    expect(HAND_IN_DB_BOUND_MS).toBeLessThanOrEqual(Number(wait!.replaceAll('_', '')) - 1_000);
    expect(HAND_IN_DB_BOUND_MS).toBeGreaterThanOrEqual(1_000); // a db still opening at page load is not "cannot open"
  });

  it('a shelf refresh that FAILS does not reject the hand-in — the app is in the file and the tool has its answer', async () => {
    const work = applyHandInEvent(
      { id: ID, bundle: bundle() },
      {
        ...deps(),
        onLibraryChanged: async () => {
          throw new Error('the list could not be read');
        },
      },
    );
    await expect(work).resolves.toMatchObject({ installed: [{ displayName: 'Chess' }] });
    expect(reports).toEqual([{ id: ID, outcome: 'installed' }]);
  });

  it('the page’s real case — the file cannot open, so the refresh that reads it fails too: still one refusal, still no rejection', async () => {
    const locked = async (): Promise<never> => {
      throw new Error('the file is locked');
    };
    const work = applyHandInEvent({ id: ID, bundle: bundle() }, { ...deps(), getDb: locked, onLibraryChanged: locked });
    await expect(work).resolves.toMatchObject({ refused: [{ reason: 'your Snug file could not be opened (the file is locked)' }] });
    expect(reports).toEqual([{ id: ID, outcome: 'refused', reason: 'your Snug file could not be opened (the file is locked)' }]);
  });
});

describe('an explicit hand-in brings a deleted app back (K6 — the ONE difference from a page block)', () => {
  it('the agent hands in the very bundle the user deleted: it installs, and says so', async () => {
    const first = await applyHandInEvent({ id: ID, bundle: bundle() }, deps());
    await db.deleteApp(first.installed[0]!.appId);
    reports.length = 0;
    const again = await applyHandInEvent({ id: ID, bundle: bundle() }, deps());
    expect(again.installed).toHaveLength(1);
    expect(again.skipped).toEqual([]);
    expect(reports).toEqual([{ id: ID, outcome: 'installed' }]);
  });
});

describe('reportFor', () => {
  const empty = { installed: [], updated: [], pending: [], skipped: [], refused: [] };
  it('maps each outcome to the runner’s word', () => {
    expect(reportFor({ ...empty, installed: [{ appId: 'a', displayName: 'A' }] })).toEqual({ outcome: 'installed' });
    expect(reportFor({ ...empty, updated: [{ appId: 'a', displayName: 'A', version: 7 }] })).toEqual({ outcome: 'updated', version: 7 });
    expect(reportFor({ ...empty, skipped: [{ lineage: LINEAGE, reason: 'current' }] })).toEqual({ outcome: 'current' });
    expect(reportFor({ ...empty, refused: [{ lineage: LINEAGE, reason: 'no' }] })).toEqual({ outcome: 'refused', reason: 'no' });
  });
});
