/**
 * THE HOST LIVE PUMP (ADR-0034 §2, TASK-20260817-telepath).
 *
 * The first host component that acts as a STANDING on-behalf-of-an-app reader: while
 * RunView has an eligible app mounted, this module long-polls the sidecar's `/events`
 * through the SAME governed executor every other connected read uses — same deps assembly,
 * same credential injection, same gates (C1 holds identically) — and forwards what it
 * learns into the app frame as `notifyEvent('connection-event', …)`.
 *
 * WHAT IT FORWARDS, AND WHY SO LITTLE. Hints — `{seq, jid, kind, ts}` — rebuilt
 * field-by-field, chunked per emit. Two verified facts force the shape (plan review F1/F2):
 * `hostEvent` frames ride the ordinary 256 KB class and the runner's `post()` drops an
 * oversized frame SILENTLY, so content-bearing batches could vanish undetectably; and
 * `hostEvent` frames carry no instanceId, so a stale sender is indistinguishable to the
 * app — with hints, a stale event costs one redundant governed refetch and can never
 * inject state. The doorbell is not the delivery.
 *
 * LIFECYCLE IS EPOCH-TOKENED. StrictMode double-mounts effects and RunView remounts on
 * edits; two loops racing one cursor would double-forward every hint. A superseded epoch
 * discards its own late results — it never notifies and never advances the cursor. A
 * stopped pump's in-flight long-poll is allowed to run out (≤ the hold) and is then
 * discarded; it can do nothing but resolve.
 */

import { CONNECTION_STATUS, SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';
import { createConnectedFetch } from '@snugprotocol/auth';
import type { UserDb } from '@snugprotocol/db';

import { connectedFetchDepsFor } from './net.js';
import { getUserDb } from './userdb.js';
import { getPlatform } from '../platform/platform.js';

export interface SidecarLiveHint {
  seq: number;
  jid: string;
  kind: string;
  ts: number;
}

export interface SidecarEventsPage {
  hints: readonly SidecarLiveHint[];
  nextCursor: number;
  resync: boolean;
}

export type EventsFetchResult = { ok: true; page: SidecarEventsPage } | { ok: false };

export interface SidecarLivePumpDeps {
  slot: string;
  fetchEvents(cursor: number | undefined): Promise<EventsFetchResult>;
  notify(event: string, data: unknown): void;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Gap between successful polls. The server holds, so this is a yield, not a cadence. */
  pollGapMs?: number;
}

export interface SidecarLivePump {
  /** Idempotent while running. Resolves when the loop exits (callers may ignore it). */
  start(): Promise<void>;
  stop(): void;
}

/** Frame-budget discipline: bounded hints per emit, far under the 256 KB frame class. */
const HINTS_PER_EMIT = 200;

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The four contract fields, REBUILT — whatever else a (buggy, compromised) helper smuggles
 * into a row never reaches the frame. Rows without the contract shape are dropped, not
 * repaired: a hint we cannot type is a hint we do not deliver.
 */
function cleanHints(rows: readonly unknown[]): SidecarLiveHint[] {
  const out: SidecarLiveHint[] = [];
  for (const row of rows) {
    const r = row as { seq?: unknown; jid?: unknown; kind?: unknown; ts?: unknown };
    if (typeof r.seq === 'number' && typeof r.jid === 'string' && typeof r.kind === 'string' && typeof r.ts === 'number') {
      out.push({ seq: r.seq, jid: r.jid, kind: r.kind, ts: r.ts });
    }
  }
  return out;
}

export function createSidecarLivePump(deps: SidecarLivePumpDeps): SidecarLivePump {
  const sleep = deps.sleep ?? realSleep;
  const pollGapMs = deps.pollGapMs ?? 250;
  let epoch = 0;
  let running = false;

  const run = async (myEpoch: number): Promise<void> => {
    let cursor: number | undefined;
    let failures = 0;
    try {
      while (epoch === myEpoch) {
        const result = await deps.fetchEvents(cursor);
        // The epoch is re-read AFTER every await: a superseded loop discards its own late
        // result — never notifies, never advances anything.
        if (epoch !== myEpoch) return;

        if (result.ok) {
          failures = 0;
          const page = result.page;
          if (page.resync) {
            // A gap is its own signal, never rendered as "nothing new" — the app refetches
            // its lists and resumes from the live cursor.
            deps.notify('connection-event', { slot: deps.slot, resync: true });
          } else {
            const hints = cleanHints(page.hints);
            for (let i = 0; i < hints.length; i += HINTS_PER_EMIT) {
              deps.notify('connection-event', { slot: deps.slot, hints: hints.slice(i, i + HINTS_PER_EMIT) });
            }
          }
          cursor = page.nextCursor;
          await sleep(pollGapMs);
        } else {
          failures += 1;
          await sleep(Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)));
        }
      }
    } finally {
      if (epoch === myEpoch) running = false;
    }
  };

  return {
    start() {
      if (running) return Promise.resolve();
      running = true;
      epoch += 1;
      return run(epoch);
    },
    stop() {
      epoch += 1;
      running = false;
    },
  };
}

// ---------------------------------------------------------------- the sync-state poll
//
// ADR-0037 §4: the run header shows history-sync progress while it is incomplete.
// `/session/status` is WIZARD-ONLY by contract (the ADR-0025 verify seat), so this rides
// the app-reachable `/chats` — whose response carries `sync` by design — through the SAME
// governed executor, and forwards nothing but a number and a bit.

export interface SidecarSyncState {
  progress: number;
  complete: boolean;
  /**
   * The session is wedged (scanned but never registered) or unlinked — sync will never
   * progress, so a spinner would be a lie and the poll retires. Present only when true.
   */
  needsRelink?: true;
  /**
   * The NAMES phase (owner ask 2026-08-18): group rosters load a paced few at a time and
   * carry the LID→name joins, so name resolution continues after the history percent hits
   * 100. Absent on helpers that predate the detail seat.
   */
  rosters?: { loaded: number; total: number };
  /** Names known in the helper's directory — tooltip color, never load-bearing. */
  names?: number;
}

export interface SidecarSyncPollDeps {
  /** One status read; undefined for any failure (the poll keeps the last state and retries). */
  fetchStatus(): Promise<SidecarSyncState | undefined>;
  onState(state: SidecarSyncState): void;
  sleep?: (ms: number) => Promise<void>;
  pollGapMs?: number;
}

/** Slow next to the hint pump: progress moves in percent, not in messages. */
const SYNC_POLL_GAP_MS = 4_000;

export function createSidecarSyncPoll(deps: SidecarSyncPollDeps): SidecarLivePump {
  const sleep = deps.sleep ?? realSleep;
  const pollGapMs = deps.pollGapMs ?? SYNC_POLL_GAP_MS;
  let epoch = 0;
  let running = false;

  /**
   * Consecutive polls with NO movement before the poll gives up on a stalled tail. Three
   * minutes at the 4 s gap: the roster sweep retries on an exponential backoff (20 s base,
   * doubling), so quiet stretches of a minute-plus are NORMAL mid-phase — the first guard
   * (20 s) hid the pill in every backoff gap and read as "it broke again" (hardware walk
   * 5, 2026-08-18). Movement means the (loaded, total) PAIR changed: write-offs shrink the
   * total, and that is progress toward convergence too.
   */
  const ROSTER_STALL_POLLS = 45;

  const run = async (myEpoch: number): Promise<void> => {
    let lastRosterKey: string | undefined;
    let rosterStalls = 0;
    try {
      while (epoch === myEpoch) {
        const state = await deps.fetchStatus();
        // Same discipline as the hint pump: a superseded loop discards its own late result.
        if (epoch !== myEpoch) return;
        if (state !== undefined) {
          // NEEDS-RELINK is final; COMPLETE is final once the NAMES phase is done too —
          // rosters load after the history push, and retiring on the percent alone froze
          // the header out of the phase the owner actually asked about.
          if (state.needsRelink === true) {
            deps.onState(state);
            return;
          }
          const rostersPending =
            state.rosters !== undefined && state.rosters.loaded < state.rosters.total;
          if (state.complete && !rostersPending) {
            deps.onState(state);
            return;
          }
          if (state.complete && rostersPending) {
            // A tail of rosters can be permanently unloadable (dead groups exhaust their
            // retries). A pill frozen at n/m forever is worse than none — but only after
            // minutes of TRUE silence: loaded climbing counts as movement, and so does
            // the total shrinking as write-offs land.
            const rosterKey = `${state.rosters!.loaded}/${state.rosters!.total}`;
            rosterStalls = rosterKey === lastRosterKey ? rosterStalls + 1 : 0;
            lastRosterKey = rosterKey;
            if (rosterStalls >= ROSTER_STALL_POLLS) {
              const { rosters: _stalled, ...rest } = state;
              deps.onState(rest);
              return;
            }
          }
          deps.onState(state);
        }
        // A failed read reports nothing — blanking an indicator the user is watching
        // over one hiccup is worse than a briefly stale number.
        await sleep(pollGapMs);
      }
    } finally {
      if (epoch === myEpoch) running = false;
    }
  };

  return {
    start() {
      if (running) return Promise.resolve();
      running = true;
      epoch += 1;
      return run(epoch);
    },
    stop() {
      epoch += 1;
      running = false;
    },
  };
}

/**
 * Extract the header's two numbers from a `/chats` response body — and NOTHING else. The
 * response carries chat names, jids and message previews; none of that may ride into header
 * state, however convenient the spread would be (the extraction IS the scrub). No `sync`
 * seat answers undefined: that response made no claim about sync.
 */
export function syncStateFromChatsBody(body: string): SidecarSyncState | undefined {
  try {
    const parsed = JSON.parse(body) as {
      sync?: {
        progress?: unknown;
        complete?: unknown;
        needsRelink?: unknown;
        detail?: { groups?: unknown; rostersLoaded?: unknown; names?: unknown } | null;
      } | null;
    };
    const sync = parsed.sync;
    if (sync === undefined || sync === null || typeof sync !== 'object') return undefined;
    const detail = sync.detail as
      | { groups?: unknown; rostersLoaded?: unknown; rostersGivenUp?: unknown; names?: unknown }
      | null
      | undefined;
    // Given-up groups (unfetchable rosters — left groups, community containers, exhausted
    // retries) come OFF the target: the pill converges on what is achievable instead of
    // stalling three short of a total that includes the unreachable.
    const rosters =
      detail !== null &&
      typeof detail === 'object' &&
      typeof detail.groups === 'number' &&
      typeof detail.rostersLoaded === 'number'
        ? {
            loaded: detail.rostersLoaded,
            total: Math.max(
              detail.rostersLoaded,
              detail.groups - (typeof detail.rostersGivenUp === 'number' ? detail.rostersGivenUp : 0),
            ),
          }
        : undefined;
    return {
      progress: typeof sync.progress === 'number' ? sync.progress : 0,
      complete: sync.complete === true,
      // Dropped when absent, carried when claimed: a wedged session must retire the poll
      // and hide the spinner — "syncing 0%" forever over a session that will never sync is
      // the rendered lie the wedge detector exists to prevent.
      ...(sync.needsRelink === true ? { needsRelink: true as const } : {}),
      ...(rosters !== undefined ? { rosters } : {}),
      ...(detail !== null && typeof detail === 'object' && typeof detail.names === 'number'
        ? { names: detail.names }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Eligibility is a CONNECTION FACT: an approved row whose frozen ceiling carries the
 * sidecar's symbolic host. Pending rows grant nothing (approval is the user's gesture,
 * and the pump reads on the app's behalf); ordinary API connections grant nothing (their
 * hosts are real and this transport never dials them).
 */
export function resolveSidecarSlot(db: UserDb, appId: string): string | undefined {
  return db
    .listConnections(appId)
    .find(
      (row) =>
        row.status === CONNECTION_STATUS.approved &&
        (row.allowedHosts ?? []).includes(SIDECAR_SYMBOLIC_HOST),
    )?.slot;
}

/**
 * The R-9 SCRUB population (TASK-20260820-host-pseudonymisation): any row whose host set
 * names the sidecar, in ANY status. Deliberately WIDER than `resolveSidecarSlot` above —
 * the pump reads on the app's behalf, so it needs the user's approval; the scrub only
 * redacts, so it must keep binding an app whose row is `declared` (the state every
 * IMPORTED connection lands in — the app's imported SQLite still holds replayable thread
 * content, Gate-5 review cross-file finding 1) or `revoked` (the tombstone survives and
 * so does the app's data). `allowedHosts` answers for every status: the frozen ceiling
 * when approved, the requirement-derived preview otherwise.
 */
export function appHasSidecarFact(db: UserDb, appId: string): boolean {
  return db.listConnections(appId).some((row) => (row.allowedHosts ?? []).includes(SIDECAR_SYMBOLIC_HOST));
}

/**
 * Does `appId` hold the LAST sidecar fact across ALL apps (TASK-20260821 AC5/AC6)?
 *
 * The deep-delete trigger: deleting this app is the user forgetting their WhatsApp, so
 * the helper session may be unlinked and its disk store erased. Any status counts (the
 * same width as `appHasSidecarFact` — an imported `declared` row's app still owns the
 * session's data story), and a sidecar fact on ANY OTHER app vetoes the unlink: cutting
 * the device link out from under a surviving app is the failure the orphanhood rule in
 * `wipeSidecarIdentityDirectoryIfOrphaned` already refuses at the db altitude, and the
 * two altitudes must not disagree.
 */
export function appHoldsLastSidecarFact(db: UserDb, appId: string): boolean {
  const sidecarRows = db
    .listConnections()
    .filter((row) => (row.allowedHosts ?? []).includes(SIDECAR_SYMBOLIC_HOST));
  return sidecarRows.length > 0 && sidecarRows.every((row) => row.appId === appId);
}

/** Same fact, scoped to ONE slot — the provider lane's per-call classification. */
export function isSidecarSlotFact(db: UserDb, appId: string, slot: string): boolean {
  return db
    .listConnections(appId)
    .some((row) => row.slot === slot && (row.allowedHosts ?? []).includes(SIDECAR_SYMBOLIC_HOST));
}

/**
 * The RunView wire: start the pump for `appId` if (and only if) the platform has a sidecar
 * seat and the app holds an eligible connection. Returns a stop handle either way — the
 * ineligible case hands back a no-op so the caller's cleanup has one shape.
 */
export async function startSidecarLiveForApp(
  appId: string,
  notify: (event: string, data: unknown) => void,
  onSyncState?: (state: SidecarSyncState) => void,
): Promise<() => void> {
  if (getPlatform().sidecarFetch === undefined) return () => {};
  const db = await getUserDb();
  const slot = resolveSidecarSlot(db, appId);
  if (slot === undefined) return () => {};

  // The SAME executor assembly as every app net-request and the wizard probe — the pump
  // must never become a second network path with its own gate configuration.
  const executor = createConnectedFetch(connectedFetchDepsFor(db));

  const pump = createSidecarLivePump({
    slot,
    notify,
    fetchEvents: async (cursor) => {
      try {
        const result = await executor.execute(appId, {
          url: `snug-connection://${slot}/events${cursor !== undefined ? `?cursor=${cursor}` : ''}`,
          method: 'GET',
        });
        if (!result.ok || result.status !== 200) return { ok: false };
        const parsed = JSON.parse(result.body) as {
          hints?: unknown;
          nextCursor?: unknown;
          resync?: unknown;
        };
        if (typeof parsed.nextCursor !== 'number' || !Array.isArray(parsed.hints)) return { ok: false };
        return {
          ok: true,
          page: {
            hints: parsed.hints as SidecarLiveHint[],
            nextCursor: parsed.nextCursor,
            resync: parsed.resync === true,
          },
        };
      } catch {
        return { ok: false };
      }
    },
  });
  void pump.start();

  // The header's progress feed (ADR-0037 §4), only when the caller wants it — same
  // executor, same epoch discipline, and it retires itself on the complete report.
  let stopSyncPoll: () => void = () => {};
  if (onSyncState !== undefined) {
    const syncPoll = createSidecarSyncPoll({
      onState: onSyncState,
      fetchStatus: async () => {
        try {
          const result = await executor.execute(appId, {
            url: `snug-connection://${slot}/chats`,
            method: 'GET',
          });
          if (!result.ok || result.status !== 200) return undefined;
          return syncStateFromChatsBody(result.body);
        } catch {
          return undefined;
        }
      },
    });
    void syncPoll.start();
    stopSyncPoll = () => syncPoll.stop();
  }

  return () => {
    pump.stop();
    stopSyncPoll();
  };
}
