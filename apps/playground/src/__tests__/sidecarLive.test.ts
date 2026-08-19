// TASK-20260817-telepath Phase D (ADR-0034 §2): the host live pump.
//
// THE SHAPE UNDER TEST. The pump is the first host component that acts as a STANDING
// on-behalf-of-an-app reader: it long-polls the sidecar's `/events` through the SAME
// governed executor every other connected read uses, and forwards what it learns into the
// app frame via `notifyEvent`. Three properties carry the design and each gets hostile
// fixtures:
//
//   (1) HINTS ONLY, REBUILT FIELD-BY-FIELD. `hostEvent` frames ride the ordinary 256 KB
//       class and the runner's `post()` drops an oversized frame SILENTLY — so the pump
//       enforces the hint shape itself rather than trusting the helper, and chunks its
//       emits. A pump that forwarded whatever arrived would be one compromised helper away
//       from a silent delivery failure (or worse, a content leak into a surface no test
//       watches).
//   (2) LIFECYCLE IS EPOCH-TOKENED. StrictMode double-mounts effects; RunView remounts on
//       edits. Two loops racing one cursor double-forward every hint. A superseded epoch
//       discards its own late results — it never notifies, never advances state.
//   (3) ELIGIBILITY IS A CONNECTION FACT, not a vibe: an approved row whose frozen ceiling
//       carries the sidecar's symbolic host. Driven against the REAL user db and the real
//       admission gate (eight-seams defect #7: every app test injected a fake transport,
//       so nothing tested that production supplies one).

import { describe, expect, it } from 'vitest';

import { SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';

import { createSidecarLivePump, resolveSidecarSlot, type EventsFetchResult } from '../state/sidecarLive.js';
import { installTestUserDb } from './userdbTestHelper.js';

/** A fetch script: each call shifts the next step; the last step repeats forever. */
function scriptedFetch(steps: Array<() => EventsFetchResult | Promise<EventsFetchResult>>) {
  const calls: Array<number | undefined> = [];
  let i = 0;
  return {
    calls,
    fn: async (cursor: number | undefined): Promise<EventsFetchResult> => {
      calls.push(cursor);
      const step = steps[Math.min(i, steps.length - 1)]!;
      i += 1;
      return step();
    },
  };
}

const hint = (seq: number, jid = 'a@g.us') => ({ seq, jid, kind: 'message', ts: seq * 10 });

/** A step that parks the loop forever — the long-poll that never answers. */
const parked = (): Promise<EventsFetchResult> => new Promise<EventsFetchResult>(() => {});

/**
 * A test sleep that yields a real MACROTASK. A microtask-only sleep starves timers: a
 * repeating fetch script then spins the loop forever and the test's own setTimeout never
 * fires (this crashed the worker before it was a comment).
 */
const immediateSleep = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('forwarding', () => {
  it('forwards a hint batch to notify and advances the cursor', async () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const fetch = scriptedFetch([
      () => ({ ok: true, page: { hints: [hint(1), hint(2)], nextCursor: 2, resync: false } }),
      parked,
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: (event, data) => emitted.push({ event, data }),
      sleep: immediateSleep,
    });
    pump.start();
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('connection-event');
    expect(emitted[0]!.data).toEqual({
      slot: 'whatsapp',
      hints: [
        { seq: 1, jid: 'a@g.us', kind: 'message', ts: 10 },
        { seq: 2, jid: 'a@g.us', kind: 'message', ts: 20 },
      ],
    });
    // The next poll carried the advanced cursor.
    expect(fetch.calls[1]).toBe(2);
  });

  it('forwards resync as its own signal — a gap is never rendered as "nothing new"', async () => {
    const emitted: Array<{ data: unknown }> = [];
    const fetch = scriptedFetch([
      () => ({ ok: true, page: { hints: [], nextCursor: 41, resync: true } }),
      parked,
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: (_event, data) => emitted.push({ data }),
      sleep: immediateSleep,
    });
    pump.start();
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.data).toEqual({ slot: 'whatsapp', resync: true });
    expect(fetch.calls[1]).toBe(41);
  });

  it('REBUILDS every hint field-by-field — extra keys from the wire never reach the frame', async () => {
    // The C1-adjacent pin: whatever a (buggy, compromised) helper smuggles into a hint
    // row — a token, a message body, a name — the pump forwards only the four fields the
    // contract names. The negative is asserted on the SERIALIZED payload, the same form
    // that would cross postMessage.
    const emitted: unknown[] = [];
    const dirty = {
      seq: 1,
      jid: 'a@g.us',
      kind: 'message',
      ts: 10,
      token: 'SECRET-BEARER-VALUE',
      body: 'THE MESSAGE TEXT',
    };
    const fetch = scriptedFetch([
      () => ({ ok: true, page: { hints: [dirty as never], nextCursor: 1, resync: false } }),
      parked,
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: (_event, data) => emitted.push(data),
      sleep: immediateSleep,
    });
    pump.start();
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();

    const wire = JSON.stringify(emitted);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('MESSAGE TEXT');
    expect((emitted[0] as { hints: Array<Record<string, unknown>> }).hints[0]).toEqual({
      seq: 1,
      jid: 'a@g.us',
      kind: 'message',
      ts: 10,
    });
  });

  it('chunks an oversized batch into bounded emits — post() drops oversized frames silently', async () => {
    const emitted: Array<{ data: { hints?: unknown[] } }> = [];
    const many = Array.from({ length: 450 }, (_, i) => hint(i + 1));
    const fetch = scriptedFetch([
      () => ({ ok: true, page: { hints: many, nextCursor: 450, resync: false } }),
      parked,
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: (_event, data) => emitted.push({ data: data as { hints?: unknown[] } }),
      sleep: immediateSleep,
    });
    pump.start();
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();

    expect(emitted.length).toBeGreaterThan(1);
    for (const emit of emitted) expect((emit.data.hints ?? []).length).toBeLessThanOrEqual(200);
    expect(emitted.flatMap((e) => e.data.hints ?? [])).toHaveLength(450);
  });
});

describe('lifecycle — the epoch token', () => {
  it('stop() ends the loop: no fetch and no notify after the in-flight call settles', async () => {
    const emitted: unknown[] = [];
    const fetch = scriptedFetch([
      () => ({ ok: true, page: { hints: [hint(1)], nextCursor: 1, resync: false } }),
      () => ({ ok: true, page: { hints: [hint(2)], nextCursor: 2, resync: false } }),
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: (_event, data) => emitted.push(data),
      sleep: immediateSleep,
    });
    const run = pump.start();
    await new Promise((r) => setTimeout(r, 5));
    pump.stop();
    await run;
    const callsAtStop = fetch.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch.calls.length).toBe(callsAtStop);
  });

  it('a superseded epoch DISCARDS its late result — StrictMode cannot double-forward', async () => {
    // mount → unmount → remount in one tick, the StrictMode shape. The first loop's fetch
    // is parked; the remount starts a second loop. When the first fetch finally resolves
    // with a hint batch, its epoch is stale — nothing may be emitted for it.
    const emitted: unknown[] = [];
    let releaseFirst: ((r: EventsFetchResult) => void) | undefined;
    let firstCall = true;
    const fetchEvents = async (): Promise<EventsFetchResult> => {
      if (firstCall) {
        firstCall = false;
        return new Promise<EventsFetchResult>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return parked();
    };
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents,
      notify: (_event, data) => emitted.push(data),
      sleep: immediateSleep,
    });
    const first = pump.start();
    pump.stop(); // the unmount
    pump.start(); // the remount — second loop parks on its own fetch
    releaseFirst!({ ok: true, page: { hints: [hint(7)], nextCursor: 7, resync: false } });
    await first;
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();

    expect(emitted).toEqual([]);
  });

  it('start() while running is a no-op — one loop, one cursor, never rivals', async () => {
    const fetch = scriptedFetch([parked]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: () => {},
      sleep: immediateSleep,
    });
    pump.start();
    pump.start();
    pump.start();
    await new Promise((r) => setTimeout(r, 10));
    pump.stop();
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('failure — backoff', () => {
  it('backs off exponentially on failure and resets after a success', async () => {
    const sleeps: number[] = [];
    const fetch = scriptedFetch([
      () => ({ ok: false as const }),
      () => ({ ok: false as const }),
      () => ({ ok: false as const }),
      () => ({ ok: true, page: { hints: [], nextCursor: 0, resync: false } }),
      () => ({ ok: false as const }),
      parked,
    ]);
    const pump = createSidecarLivePump({
      slot: 'whatsapp',
      fetchEvents: fetch.fn,
      notify: () => {},
      sleep: (ms) =>
        new Promise((resolve) => {
          sleeps.push(ms);
          setTimeout(resolve, 0);
        }),
    });
    pump.start();
    await new Promise((r) => setTimeout(r, 20));
    pump.stop();

    const failureSleeps = sleeps.filter((ms) => ms >= 1_000);
    expect(failureSleeps.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
    // After the success the NEXT failure starts the ladder over.
    expect(failureSleeps[3]).toBe(1_000);
  });
});

describe('eligibility — a connection fact, on the real user db', () => {
  // The whatsapp starter's requirement, verbatim shape (examples/whatsapp/connection.json).
  const REQUIREMENT = {
    slot: 'whatsapp',
    provider: { name: 'WhatsApp' },
    kind: 'linked_device',
    // No `fields`: WhatsApp is a PINNED registry provider, so the manifest channel may not
    // author credential-prompt copy — the registry substitutes its own (anti brand-hijack).
    declaredApiHosts: [SIDECAR_SYMBOLIC_HOST],
  };

  it('resolves the slot ONLY for an approved row whose ceiling carries the symbolic host', async () => {
    const db = await installTestUserDb();
    db.putDeclaredConnection('app-1', 'whatsapp', REQUIREMENT, 'starter');

    // Declared is not approved: the pump must not run before the user's gesture.
    expect(resolveSidecarSlot(db, 'app-1')).toBeUndefined();

    db.approveConnection('app-1', 'whatsapp');
    expect(resolveSidecarSlot(db, 'app-1')).toBe('whatsapp');

    // Another app's approval grants nothing here.
    expect(resolveSidecarSlot(db, 'app-2')).toBeUndefined();
  });

  it('never resolves a slot from an ordinary api connection — symbolic host or nothing', async () => {
    const db = await installTestUserDb();
    db.putDeclaredConnection(
      'app-3',
      'weather',
      {
        slot: 'weather',
        provider: { name: 'OpenWeather' },
        kind: 'api_key',
        declaredApiHosts: ['api.openweathermap.org'],
      },
      'starter',
    );
    db.approveConnection('app-3', 'weather');
    expect(resolveSidecarSlot(db, 'app-3')).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the sync-state poll
//
// ADR-0037 §4 (owner interview 2026-08-18): the run header shows history-sync progress.
// `/session/status` is WIZARD-ONLY by contract (the ADR-0025 verify seat), so the host poll
// rides the app-reachable `/chats` — whose response carries `sync` by design — and forwards
// NOTHING but the two numbers the header needs. Same epoch discipline as the hint pump.

import { createSidecarSyncPoll, syncStateFromChatsBody } from '../state/sidecarLive.js';

describe('the sync-state poll', () => {
  it('reports progress while incomplete and STOPS once complete', async () => {
    const statuses = [
      { progress: 20, complete: false },
      { progress: 70, complete: false },
      { progress: 100, complete: true },
      { progress: 100, complete: true }, // must never be reached: polling past complete is waste
    ];
    let asks = 0;
    const reports: unknown[] = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => statuses[asks++],
      onState: (state) => reports.push(state),
      sleep: async () => {},
    });
    await poll.start();
    expect(reports).toEqual(statuses.slice(0, 3));
    expect(asks).toBe(3);
  });

  it('a superseded poll never reports its late result', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reports: unknown[] = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => {
        await gate;
        return { progress: 10, complete: false };
      },
      onState: (state) => reports.push(state),
      sleep: async () => {},
    });
    const done = poll.start();
    poll.stop();
    release?.();
    await done;
    expect(reports).toEqual([]);
  });

  it('retires on a NEEDS-RELINK report — a wedged session must not spin forever', async () => {
    // `/chats` serves the restored cache even for a wedged session, answering
    // `{complete:false, needsRelink:true}` indefinitely. Without this exit the header
    // shows "syncing 0%" forever — contradicting the app's own relink prompt — and the
    // host burns a governed read every few seconds for the life of the view.
    const wedged = { progress: 0, complete: false, needsRelink: true as const };
    let asks = 0;
    const reports: unknown[] = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => {
        asks += 1;
        return wedged;
      },
      onState: (state) => reports.push(state),
      sleep: async () => {},
    });
    await poll.start();
    expect(reports).toEqual([wedged]);
    expect(asks).toBe(1);
  });

  it('a failed read keeps the last state on screen — no report, then retry', async () => {
    const answers = [
      { progress: 30, complete: false },
      undefined, // one bad read must not blank an indicator the user is watching
      { progress: 60, complete: false },
      { progress: 100, complete: true },
    ];
    let asks = 0;
    const reports: unknown[] = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => answers[asks++],
      onState: (state) => reports.push(state),
      sleep: async () => {},
    });
    await poll.start();
    expect(reports).toEqual([answers[0], answers[2], answers[3]]);
  });
});

describe('syncStateFromChatsBody — the extraction is the scrub', () => {
  it('keeps the two numbers and NOTHING else from a chats response', () => {
    const body = JSON.stringify({
      chats: [{ jid: '111@s.whatsapp.net', name: 'Asha', lastMessage: { text: 'secret', ts: 1 } }],
      sync: { complete: false, explicit: false, progress: 37, needsRelink: false },
    });
    // The header needs a number and a bit; message content, names and jids must not ride
    // along into header state, however convenient the object spread would be.
    expect(syncStateFromChatsBody(body)).toEqual({ progress: 37, complete: false });
  });

  it('answers undefined for junk, and defaults progress honestly', () => {
    expect(syncStateFromChatsBody('not json')).toBeUndefined();
    expect(syncStateFromChatsBody(JSON.stringify({ chats: [] }))).toBeUndefined();
    expect(syncStateFromChatsBody(JSON.stringify({ sync: { complete: true } }))).toEqual({
      progress: 0,
      complete: true,
    });
  });

  it('carries needsRelink through when the helper claims it, and only then', () => {
    expect(
      syncStateFromChatsBody(JSON.stringify({ sync: { complete: false, progress: 0, needsRelink: true } })),
    ).toEqual({ progress: 0, complete: false, needsRelink: true });
    // The flag is a claim, never a default (the wedge detector's own rule).
    expect(
      syncStateFromChatsBody(JSON.stringify({ sync: { complete: false, progress: 5, needsRelink: false } })),
    ).toEqual({ progress: 5, complete: false });
  });
});

// -------------------------------------------------- the names phase (owner ask 2026-08-18)
//
// History percent hides the SECOND phase: name resolution rides group rosters loading a
// paced few at a time, and continues after the history push completes. The poll now keeps
// going through that phase and retires when rosters are done — or quietly gives up when
// they stall, because a frozen progress pill is worse than none.

describe('the sync poll through the names phase', () => {
  const state = (over: Record<string, unknown>) => ({ progress: 100, complete: true, ...over });

  it('keeps polling while rosters are loading, and retires when they are done', async () => {
    const answers = [
      state({ rosters: { loaded: 90, total: 233 }, names: 1500 }),
      state({ rosters: { loaded: 180, total: 233 }, names: 1550 }),
      state({ rosters: { loaded: 233, total: 233 }, names: 1561 }),
      state({ rosters: { loaded: 233, total: 233 }, names: 1561 }), // must never be reached
    ];
    let asks = 0;
    const reports: unknown[] = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => answers[asks++] as never,
      onState: (s) => reports.push(s),
      sleep: async () => {},
    });
    await poll.start();
    expect(asks).toBe(3);
    expect(reports).toEqual(answers.slice(0, 3));
  });

  it('quietly gives up when rosters STALL — a frozen pill is worse than none', async () => {
    const stuck = state({ rosters: { loaded: 230, total: 233 }, names: 1561 });
    let asks = 0;
    const reports: Array<{ rosters?: unknown }> = [];
    const poll = createSidecarSyncPoll({
      fetchStatus: async () => {
        asks += 1;
        return stuck as never;
      },
      onState: (s) => reports.push(s as never),
      sleep: async () => {},
    });
    await poll.start();
    expect(asks).toBeLessThanOrEqual(8); // bounded, not forever
    // The FINAL report clears the roster seat so the header hides rather than freezing.
    expect(reports.at(-1)?.rosters).toBeUndefined();
  });

  it('extracts the roster detail from the chats body — numbers only', () => {
    const body = JSON.stringify({
      chats: [{ jid: 'x@s.whatsapp.net', name: 'Private' }],
      sync: {
        complete: true,
        explicit: true,
        progress: 100,
        detail: { groups: 233, rostersLoaded: 98, names: 1561, messages: 16627 },
      },
    });
    expect(syncStateFromChatsBody(body)).toEqual({
      progress: 100,
      complete: true,
      rosters: { loaded: 98, total: 233 },
      names: 1561,
    });
  });

  it('tolerates a helper with NO detail seat — the old shape retires on complete', () => {
    expect(syncStateFromChatsBody(JSON.stringify({ sync: { complete: true, progress: 100 } }))).toEqual({
      progress: 100,
      complete: true,
    });
  });
});
