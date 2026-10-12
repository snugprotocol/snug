// agent/chatFetch.ts — the chat's *fetch new data first*, for ONE turn
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-18, D-PR5-20 and its v2.1 answers T-D Q12,
// T-D Q13; D10, F6, F9).
//
// `useBuilderChat`'s `send` reaches this only when the person pressed the toggle AND the turn
// opened the data door — after routing, before the shared tables are copied — and passes the
// turn's own stop. It asks through `access/fetchFirst.ts` (a lazy edge, the load-order rule) for
// the chat caller, over the run seams the page composes (`defaultAppRunDeps`, lazily too), and
// words what came of it ONCE, in `access/copy.ts`'s `FETCH_FIRST`: the note the person reads under
// their message (persisted with it, `meta.fetchNote`) and the same fact as one host line in the
// turn's context. A stop during the fetch is the turn's to act on: the hook ends the whole turn,
// keeping the message with the note this answers. Nothing here throws — a fetch that could not run
// is said as nothing at all, and the turn goes on.

import type { UserDb } from '@snugprotocol/db';

import { FETCH_FIRST, relativeTime } from '../access/copy.js';
import type { FetchedSource } from '../access/fetchFirst.js';
import { accessDeps } from '../access/grants.js';
import type { AccessCaller } from '../access/policy.js';

/** What the turn's fetch came to, in words — nothing at all when no source was asked. */
export interface ChatFetchOutcome {
  /** The host's note on the person's message: `FETCH_FIRST`'s words, one fact per source asked. */
  note?: string;
  /** The same fact as ONE host line for the turn's context — present exactly when `note` is. */
  contextLine?: string;
}

/** The facts of a note, side by side. */
const FACT_SEPARATOR = ' · ';

/** Ask the apps the chat may read to fetch new data, under the turn's own stop. Never throws: a fetch that could not run is a note, never a failed turn. */
export async function fetchFirstForChat(db: UserDb, caller: Extract<AccessCaller, { kind: 'chat' }>, signal: AbortSignal): Promise<ChatFetchOutcome> {
  try {
    const [{ fetchFirst }, { defaultAppRunDeps }] = await Promise.all([import('../access/fetchFirst.js'), import('../schedule/appRun.js')]);
    const { asked } = await fetchFirst(db, defaultAppRunDeps(), caller, { signal });
    if (asked.length === 0) return {};
    const now = accessDeps().now();
    const fact = ({ sourceName, outcome, at, lastOk }: FetchedSource): string => {
      switch (outcome) {
        case 'fresh':
          return FETCH_FIRST.done(sourceName);
        case 'recent':
          // The fetch inside the cooldown that this turn used: when it was, and how it went when that is known.
          if (at === undefined) return FETCH_FIRST.recentUsed(sourceName);
          return lastOk === undefined ? FETCH_FIRST.askedRecently(sourceName, relativeTime(at, now)) : FETCH_FIRST.recent(sourceName, relativeTime(at, now), lastOk);
        case 'failed':
          return FETCH_FIRST.failed(sourceName);
        case 'skipped':
          return FETCH_FIRST.skipped(sourceName);
        case 'stopped':
          return FETCH_FIRST.stopped(sourceName);
      }
    };
    const note = asked.map(fact).join(FACT_SEPARATOR);
    // The brain reads the same fact, once, as the host's — never as something the person said.
    return { note, contextLine: `The host, before this turn: ${note}` };
  } catch {
    return {};
  }
}
