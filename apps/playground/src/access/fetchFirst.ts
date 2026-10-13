// access/fetchFirst.ts — *fetch new data first*: the host doors ask the apps they may read to
// fetch before the turn or the step reads them (TASK-20261010-host-broker PR-5; ADR-0076 §6;
// contract v2 D-PR5-18 and its v2.1 answers T-D Q4–Q6; P1, SC7, F6, S14).
//
// ONE function for both doors — the chat's toggle and a schedule's tick — reached through a lazy
// import at each call site. It lists the caller's ADMITTED access carrying `refresh` (a schedule's
// needs `unattended` too — `refreshableReads`, the policy's own answer), one per source, at most
// `REFRESH_FIRST_MAX_SOURCES` (the rest `skipped`), and asks each IN TURN through the service's
// host-only `refreshFor` — never the engine directly. A door joins a refresh already in flight; its
// own signal abandons only its own wait (`stopped`), and nothing after it is asked. In a schedule's
// run (`run`), the ceiling counts what the run spent so far plus the earlier sources' calls, nothing
// is folded into the day, the calls come back to the run, and a source is not asked when less of the
// run's budget is left than a frame is given to announce itself (`SCHEDULE_ANNOUNCE_TIMEOUT_MS`,
// Gate-5 fold P3-5) — a dispatch that could never be answered in time would only burn the source's
// cooldown and write a `timeout` line. It never throws: a source that could not be asked reads `failed`.
// Every source's name is folded to ONE line here (`oneLine`, P3-2), so both doors — the chat's note
// and its line for the brain, the schedule's step fact — say the same name and no name adds a line.
// The words for each outcome are `access/copy.ts`'s `FETCH_FIRST` — the caller says them.

import type { UserDb } from '@snugprotocol/db';
import { REFRESH_FIRST_MAX_SOURCES } from '@snugprotocol/protocol';

import { oneLine } from '../agent/sharedDdl.js';
import { SCHEDULE_ANNOUNCE_TIMEOUT_MS, type AppRunDeps } from '../schedule/appRun.js';
import type { Calls } from '../schedule/protection.js';
import { accessDeps } from './grants.js';
import type { AccessCaller } from './policy.js';
import { accessService, refreshableReads, type AccessRefreshForAnswer } from './service.js';

/** The two doors that fetch first; an app's own frame asks through the `refresh` op instead. */
export type FetchFirstCaller = Extract<AccessCaller, { kind: 'chat' } | { kind: 'schedule' }>;

/** What asking one source came to (T-D Q5): new data, a fetch inside the cooldown used, a failure (busy included), not asked, or the door's own stop. */
export type FetchedSourceOutcome = 'fresh' | 'recent' | 'failed' | 'skipped' | 'stopped';

export interface FetchedSource {
  sourceAppId: string;
  /** The source's library name, folded to one line (`oneLine`) — what the words say. */
  sourceName: string;
  outcome: FetchedSourceOutcome;
  /** `recent`: when the fetch it used happened (ISO). */
  at?: string;
  /** `recent`: whether that fetch delivered — absent when it is not known (it was another door's, still in flight or long gone). */
  lastOk?: boolean;
}

export interface FetchFirstOptions {
  /** The door's own stop: it abandons this door's wait, never a run another door shares. */
  signal: AbortSignal;
  /** A schedule's run: what it spent so far, and the instant (on `Date.now()`'s clock) the fetch must be done by. */
  run?: { spent(): Calls; deadline: number };
}

export interface FetchFirstResult {
  /** One entry per source, in the order asked; empty when no access lets the caller ask. */
  asked: readonly FetchedSource[];
  /** What the fetches spent — folded into the day by the engine unless `run` is given. */
  calls: Calls;
}

/** The engine's answer, read for the door (T-D Q5): `fresh`, `recent`, or — any refusal or failure, the one-instance rule included — `failed`. */
async function read(sourceAppId: string, sourceName: string, answer: AccessRefreshForAnswer | undefined): Promise<FetchedSource> {
  const { outcome } = answer ?? {};
  if (outcome === undefined || !outcome.ok) return { sourceAppId, sourceName, outcome: 'failed' };
  if (outcome.fresh) return { sourceAppId, sourceName, outcome: 'fresh' };
  // A fetch inside the cooldown: when it happened, and how it went when that is known — the engine's own memory.
  const { lastRefreshOf } = await import('./refresh.js');
  const last = lastRefreshOf(sourceAppId);
  return { sourceAppId, sourceName, outcome: 'recent', ...(last !== undefined ? { at: last.at } : {}), ...(last?.ok !== undefined ? { lastOk: last.ok } : {}) };
}

export async function fetchFirst(db: UserDb, deps: AppRunDeps, caller: FetchFirstCaller, options: FetchFirstOptions): Promise<FetchFirstResult> {
  const { signal, run } = options;
  const calls: Calls = { ai: 0, net: 0 };
  // One per source, in the caller's grant order: the first admitted access to each source is the one asked.
  const sources = new Map<string, { grantId: string; sourceName: string }>();
  try {
    for (const row of refreshableReads(db, caller, accessDeps().now())) {
      if (!sources.has(row.grant.sourceAppId)) sources.set(row.grant.sourceAppId, { grantId: row.grant.id, sourceName: oneLine(row.sourceName) });
    }
  } catch {
    return { asked: [], calls }; // the file could not be read — nothing was asked
  }

  const service = accessService();
  const asked: FetchedSource[] = [];
  let tried = 0;
  let stopped = false;
  for (const [sourceAppId, { grantId, sourceName }] of sources) {
    // Past the cap, after the door's stop, or with too little of the run's budget left to be answered: not asked.
    const outOfTime = run !== undefined && run.deadline - Date.now() < SCHEDULE_ANNOUNCE_TIMEOUT_MS;
    if (stopped || signal.aborted || outOfTime || tried >= REFRESH_FIRST_MAX_SOURCES) {
      asked.push({ sourceAppId, sourceName, outcome: 'skipped' });
      continue;
    }
    tried += 1;
    let answer: AccessRefreshForAnswer | undefined;
    try {
      answer = await service.refreshFor(caller, grantId, {
        deps,
        signal,
        // In a schedule's run the ceiling counts what the run spent AND the sources asked before this one.
        ...(run !== undefined ? { run: { spent: () => ({ ai: run.spent().ai + calls.ai, net: run.spent().net + calls.net }), deadline: run.deadline } } : {}),
      });
    } catch {
      answer = undefined; // a refresh failure never throws out of here
    }
    if (answer !== undefined) {
      calls.ai += answer.calls.ai;
      calls.net += answer.calls.net;
    }
    if (signal.aborted) {
      // The door's own stop, while this source was being waited on: nothing after it is asked.
      asked.push({ sourceAppId, sourceName, outcome: 'stopped' });
      stopped = true;
      continue;
    }
    asked.push(await read(sourceAppId, sourceName, answer));
  }
  return { asked, calls };
}
