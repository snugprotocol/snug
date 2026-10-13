/**
 * TASK-20261010-host-broker PR-5 Gate 5 — the chat cards' answer vocabularies (G5-1) and the chat's
 * fetch facts (G5-17). INTERNAL protocol surface: OUT of `json-schemas.ts` SOURCES, like
 * `own-undo.ts` and `app-provenance.ts`.
 *
 * WHY THE VOCABULARIES LIVE HERE. A card on a chat message is a proposal with an act on it until it
 * is ANSWERED, and "answered" is a resolution VALUE the reader accepts — never a key that is merely
 * present. Two places decide it: the playground's readers (which card comes back, and with which
 * acts) and the db's untrusted import (which cards a foreign file may not carry live). When they
 * read a card differently, a planted `outcome: null` keeps an *apply* the import believed settled
 * (DB-1, SA-1, SB-1). So each list is spelled ONCE, here, where both can import it — the db cannot
 * import the playground's.
 *
 * THE FETCH FACTS. What the chat's *fetch new data first* came to is persisted on the user's row as
 * STRUCTURED facts — never a sentence: a fact names a source and an outcome, and the host re-words
 * it on read from its own copy, so a row can never carry host-voiced free text (SB-5). A fact is the
 * step's `fetched` seat's twin (`schedule.ts`, D-PR5-19) with the chat's two extra outcomes and the
 * age of a recent fetch.
 */

import { z } from 'zod';
import { STEP_SAW_MAX_ENTRIES, STEP_SAW_NAME_MAX_CHARS } from './schedule.js';

// ------------------------------------------------------------------ the answer vocabularies

/** A staged schedule suggestion's `resolution` (`meta.schedule`): the user scheduled it, declined it, or it went stale. */
export const SCHEDULE_CARD_RESOLUTIONS = ['scheduled', 'declined', 'stale'] as const;
export type ScheduleCardResolution = (typeof SCHEDULE_CARD_RESOLUTIONS)[number];

/** The app's own change's `outcome` (`meta.dataWrite`): settled one way or another, or put back (`undone`). */
export const DATA_WRITE_OUTCOMES = ['applied', 'declined', 'drifted', 'failed', 'undone'] as const;
export type DataWriteOutcome = (typeof DATA_WRITE_OUTCOMES)[number];

/** The chat's change to another app's data's `outcome` (`meta.accessWrite`) — no `undone`: its undo lives in the access history, not on the card. */
export const ACCESS_WRITE_OUTCOMES = ['applied', 'declined', 'drifted', 'failed'] as const;
export type AccessWriteOutcome = (typeof ACCESS_WRITE_OUTCOMES)[number];

/** The chat's ASK card's `resolution.kind` (`meta.access`): the user allowed, said not now, or declined — or the sheet could not act. */
export const ACCESS_CARD_RESOLUTIONS = ['allowed', 'not-now', 'declined', 'failed'] as const;
export type AccessCardResolutionKind = (typeof ACCESS_CARD_RESOLUTIONS)[number];

// ------------------------------------------------------------------ the chat's fetch facts

/**
 * What the chat's *fetch new data first* came to for one source: new data (`fresh`), a fetch moments
 * ago reused (`recent`), it did not finish (`failed`), not asked — past the cap or out of time
 * (`skipped`), the user stopped it (`stopped`), or no app lets this one ask any more (`none` — the
 * fetch's one fact, its `source` the READER's name).
 */
export const CHAT_FETCH_OUTCOMES = ['fresh', 'recent', 'failed', 'skipped', 'stopped', 'none'] as const;
export type ChatFetchOutcome = (typeof CHAT_FETCH_OUTCOMES)[number];

/** At most this many facts on one row — the step's `fetched` cap. */
export const CHAT_FETCH_FACTS_MAX = STEP_SAW_MAX_ENTRIES;
/** A fact's `source` is at most this many characters — the step's source-name cap. */
export const CHAT_FETCH_SOURCE_MAX_CHARS = STEP_SAW_NAME_MAX_CHARS;

/**
 * What a fact's `source` may not carry — what a name folded to ONE line never holds: every control
 * character (`\p{Cc}`: C0 — tab and the line breaks among them — DEL, and C1, NEL among them), the
 * line and paragraph separators, and the bidi marks (U+061C, U+200E, U+200F), embeddings and
 * overrides (U+202A–U+202E) and isolates (U+2066–U+2069). Not every format character: a joiner
 * (U+200D) is the glue of an emoji sequence an app's name may hold, and the host shows every name
 * in its own `<bdi>`.
 */
const UNSAFE_SOURCE_CHAR_RULE = /[\p{Cc}\u2028\u2029\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** A source app's name as one line: not blank, no unsafe character, no leading or trailing whitespace. */
const isOneLineName = (name: string): boolean => !UNSAFE_SOURCE_CHAR_RULE.test(name) && name.trim() !== '' && name.trim() === name;

/**
 * One fact. STRICT: it carries no free text — a source name, an outcome, and for a `recent` fetch
 * the whole minutes since it ran and whether it went well. The host re-words it from its own copy.
 */
const chatFetchFactSchema = z.strictObject({
  source: z
    .string()
    .min(1)
    .max(CHAT_FETCH_SOURCE_MAX_CHARS)
    .refine(isOneLineName, 'source must be one line of text — no control, line-separator or bidi characters, and no leading or trailing whitespace'),
  outcome: z.enum(CHAT_FETCH_OUTCOMES),
  minutes: z.int().min(0).optional(),
  ok: z.boolean().optional(),
});
export type ChatFetchFact = z.infer<typeof chatFetchFactSchema>;

/** The user row's `meta.fetched`: 1..8 facts, in the order the sources were asked. A list the reader cannot vouch for whole is no list. */
export const chatFetchFactsSchema = z.array(chatFetchFactSchema).min(1).max(CHAT_FETCH_FACTS_MAX);
