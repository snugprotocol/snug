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
  return () => pump.stop();
}
