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

  const run = async (myEpoch: number): Promise<void> => {
    try {
      while (epoch === myEpoch) {
        const state = await deps.fetchStatus();
        // Same discipline as the hint pump: a superseded loop discards its own late result.
        if (epoch !== myEpoch) return;
        if (state !== undefined) {
          deps.onState(state);
          // COMPLETE and NEEDS-RELINK are both final: polling past either would spend a
          // governed read every few seconds forever, to learn a fact that no longer
          // changes on its own (a relink restarts the pump, and the poll with it).
          if (state.complete || state.needsRelink === true) return;
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
      sync?: { progress?: unknown; complete?: unknown; needsRelink?: unknown } | null;
    };
    const sync = parsed.sync;
    if (sync === undefined || sync === null || typeof sync !== 'object') return undefined;
    return {
      progress: typeof sync.progress === 'number' ? sync.progress : 0,
      complete: sync.complete === true,
      // Dropped when absent, carried when claimed: a wedged session must retire the poll
      // and hide the spinner — "syncing 0%" forever over a session that will never sync is
      // the rendered lie the wedge detector exists to prevent.
      ...(sync.needsRelink === true ? { needsRelink: true as const } : {}),
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
