// agent/chatFetch.ts — the chat's *fetch new data first*, for ONE turn
// (TASK-20261010-host-broker PR-5; contract v2 D-PR5-18, D-PR5-20 and its v2.1 answers T-D Q12,
// T-D Q13; D10, F6, F9; the Gate-5 fold G5-17, G5-19 — P3-2, P3-9, P3-10, SB-2, SB-5).
//
// `useBuilderChat`'s `send` reaches this only when the person pressed the toggle AND the turn
// opened the data door — after routing, before the shared tables are copied — and passes the
// turn's own stop. It asks through `access/fetchFirst.ts` (a lazy edge, the load-order rule) for
// the chat caller, over the run seams the page composes (`defaultAppRunDeps`, lazily too).
//
// WHAT IT ANSWERS is FACTS, never a sentence (G5-17): one `ChatFetchFact` per source asked, in the
// order asked, at most `CHAT_FETCH_FACTS_MAX` — what the user's row persists as `meta.fetched` and
// what the host re-words on every read, so a row never carries host-voiced free text (SB-5). Every
// name in a fact is ONE line (`oneLine`, P3-2 — a library name is its author's text and never adds a
// line to what the brain reads) of at most `CHAT_FETCH_SOURCE_MAX_CHARS`. A press with nothing to
// ask — the access the toggle named ended since (P3-10) — is the one `none` fact under the READER's
// name, never a silent no-op. The words are ONE home, `FETCH_FACTS` (each fact in `FETCH_FIRST`'s
// words): the note under the person's message says them, and so does the brain's one host line
// (`FETCH_FIRST.contextLine`). A stop during the fetch is the turn's to act on (`stopped`): the hook
// ends the whole turn, keeping the message with these facts. Nothing here throws — a fetch that
// could not run at all answers no facts, and the turn goes on.

import type { UserDb } from '@snugprotocol/db';
import { CHAT_FETCH_FACTS_MAX, CHAT_FETCH_SOURCE_MAX_CHARS, type ChatFetchFact } from '@snugprotocol/protocol';

import { FETCH_FIRST } from '../access/copy.js';
import type { FetchedSource } from '../access/fetchFirst.js';
import type { AccessCaller } from '../access/policy.js';
import { FETCH_FACTS } from './copy.dataWrite.js';
import { oneLine } from './sharedDdl.js';

/** What the turn's fetch came to. */
export interface ChatFetchAnswer {
  /**
   * One fact per source, in the order asked (at most `CHAT_FETCH_FACTS_MAX`) — or the one `none`
   * fact when no app lets this one ask any more. Empty only when the fetch could not run at all:
   * then nothing is said, and nothing is persisted (a persisted list is never empty).
   */
  facts: ChatFetchFact[];
  /** The facts' words as ONE host line for the turn's context — present exactly when `facts` is not empty. */
  contextLine?: string;
  /** The turn's own stop landed while the sources fetched: the hook ends the turn, keeping the message and its facts. */
  stopped: boolean;
}

const MINUTE_MS = 60_000;

/**
 * An app's name as a fact holds it: ONE line (`oneLine` — and the Arabic letter mark, the one bidi
 * mark it leaves, folded too), at most `CHAT_FETCH_SOURCE_MAX_CHARS`, never cut inside a surrogate
 * pair nor ending in a space — exactly what the fact's `source` rule admits, so a list written here
 * is always one the reader can vouch for whole.
 */
function factSource(name: string): string {
  return oneLine(name.replace(/\u061c/g, ' '))
    .slice(0, CHAT_FETCH_SOURCE_MAX_CHARS)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
}

/** One source's answer as a fact: a `recent` fetch carries its whole minutes and how it went, when they are known. */
function factOf({ sourceName, outcome, at, lastOk }: FetchedSource, now: number): ChatFetchFact {
  const source = factSource(sourceName);
  if (outcome !== 'recent') return { source, outcome };
  const age = at === undefined ? Number.NaN : now - Date.parse(at);
  return {
    source,
    outcome,
    ...(Number.isFinite(age) ? { minutes: Math.floor(Math.max(0, age) / MINUTE_MS) } : {}),
    ...(lastOk !== undefined ? { ok: lastOk } : {}),
  };
}

/** Ask the apps the chat may read to fetch new data, under the turn's own stop. Never throws: a fetch that could not run is no facts, never a failed turn. */
export async function fetchFirstForChat(db: UserDb, caller: Extract<AccessCaller, { kind: 'chat' }>, signal: AbortSignal): Promise<ChatFetchAnswer> {
  try {
    const [{ fetchFirst }, { defaultAppRunDeps }, { accessDeps, readerNameOf }] = await Promise.all([
      import('../access/fetchFirst.js'),
      import('../schedule/appRun.js'),
      import('../access/grants.js'),
    ]);
    const { asked } = await fetchFirst(db, defaultAppRunDeps(), caller, { signal });
    const now = accessDeps().now();
    // Pressed, and no app lets this one ask any more (P3-10): said under the reader's own name.
    const facts: ChatFetchFact[] =
      asked.length === 0 ? [{ source: factSource(readerNameOf(db, caller.appId)), outcome: 'none' }] : asked.slice(0, CHAT_FETCH_FACTS_MAX).map((source) => factOf(source, now));
    // The brain reads the same facts, once, as the host's — never as something the person said.
    return { facts, contextLine: FETCH_FIRST.contextLine(FETCH_FACTS.note(facts, now)), stopped: signal.aborted };
  } catch {
    return { facts: [], stopped: signal.aborted };
  }
}
