// access/copy.ts — every user-facing sentence of access between apps, in ONE module
// (TASK-20261010-cross-app-access AC17; ADR-0075 §4, §5, §7, §8; D1).
//
// Pure strings and small pure functions, no React, no store: each is pinned byte-for-byte in
// `__tests__/accessCopy.test.ts`, and the same file's vocabulary scan refuses an internal word
// spelled inside a string literal anywhere else under `access/`.
//
// THE VOCABULARY. The engine says grant · reader · source · scope · log to itself (the spec
// always says *access grant*). A person reads *access* (the noun: "Budget has access to
// Ledger's transactions"), *allow* and *stop* (the verbs), *reads* / *is read by*, and
// *history* (never "log"). This feature is never called "share" — ADR-0063 owns that word for
// app sharing; the only spellings here are the share LINK an app was installed from (the
// provenance line), the *never shared* mark on a credential-named column (AC18), and the one
// app-facing refusal AC12 quotes verbatim.
//
// FROZEN AFTER W3a: later lanes ADD keys, never rename — the engine and the UI import these
// names, and the handler's app-facing messages are part of the app contract the KB documents.
// TASK-20261010-host-broker PR-2 (ADR-0076 §1–§3) added the doors' sentences: `CHAT_DOOR` (what
// a brain reads about a shared table), `ACCESS_CARD` (the brain's ask card), the sheet's
// `askedInChat`, `EGRESS.chat`, and `EGRESS.away` / `awayHint` now name the reader — a signature
// change on two keys, which every caller under access/ follows.
//
// TASK-20261010-host-broker PR-3 (ADR-0076 §4–§8; D-PR3-23/24/25; contract v2.1 U-Q1..Q8, U-Q17,
// E1-Q1, E1-Q2, E2-Q3) added the write, the undo and the refresh: the sheet's write toggle, column
// chooser and options row, the strip's and the card's "read and change" lines, the history's
// `wrote` / `undone` / `refreshed` rows, the ⋈ sheet's *undo* with its armed question, and the
// app-facing refusals a write or a refresh is answered with. Every one is pinned by bytes in
// accessCopy.test.ts; the engine lanes IMPORT these names and never word a sentence themselves
// (D-PR3-25). A sentence an app is answered with reveals no fact about the source and invites no
// re-ask (DS19): a refusal names the RULE, never the row, the value or the column's content.
//
// TASK-20261010-host-broker PR-5 (ADR-0076 §7, §11; contract v2 D-PR5-2…24 and its v2.1 notes)
// added discovery and the doors' new verbs: what an app would like to read (`ACCESS_WANTS` — the
// host's words around the app's own, never "declaration"), the Hub tile's line (`HUB_TILE`),
// *apps that could work together* in Settings, the source's offer on the ⋈ sheet, the declared
// and offered forms of the consent sheet, the *imported* provenance, the chat's cross-app change
// (`CHAT_DOOR`'s new keys — what a brain reads, so the house's curly apostrophe), and *fetch new
// data first* (`FETCH_FIRST` — ONE home for the chat's note and the schedule's step fact —
// and `CHAT_FETCH`). A refresh that was stopped ends `failed` like one that failed, so
// `REFRESH_HISTORY_WORDS.failed` says what is true of both: the fetch didn't finish.
//
// THE VOICE. Lowercase-leading, plain words, no exclamation marks. Apostrophes are the
// straight ones the task file pins ("while it's open", "Budget's access"); the typographic
// quote marks wrap the app's purpose and the away line keeps the house’s curly apostrophe
// because the egress block pins it. Every sentence PR-3 added outside `EGRESS.*` and
// `CHAT_DOOR.*` keeps the straight apostrophe (DS22).

import {
  ACCESS_WRITE_MAX_ROWS,
  REFRESH_FIRST_MAX_SOURCES,
  type AccessDuration,
  type AccessGrantStatus,
  type AccessLogEntry,
  type AccessLogVia,
  type AccessRefreshReason,
  type AccessSuspendReason,
} from '@snugprotocol/protocol';

import type { ExcludedReason } from './relevance.js';

// ---------------------------------------------------------------------------------------------
// The small words
// ---------------------------------------------------------------------------------------------

/** "no rows" · "1 row" · "412 rows". */
export function rowsWord(n: number): string {
  if (n === 0) return 'no rows';
  return `${n} ${n === 1 ? 'row' : 'rows'}`;
}

/** "no reads yet" · "1 read" · "14 reads". */
export function readsWord(n: number): string {
  if (n === 0) return 'no reads yet';
  return `${n} ${n === 1 ? 'read' : 'reads'}`;
}

/** "a" · "a and b" · "a, b and c" — the ONE list joiner. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "Ledger's transactions" · "Ledger's transactions and accounts". */
/** The ONE clause every pair sentence is built from (Gate-5 fold IB-8): "could read Ledger's transactions". */
const couldReadTables = (sourceName: string, tables: readonly string[]): string => `could read ${tablesPhrase(sourceName, tables)}`;
/** The Hub's clause, with no tables named: "could read Ledger's data". */
const couldReadData = (sourceName: string): string => `could read ${sourceName}'s data`;

export function tablesPhrase(sourceName: string, tables: readonly string[]): string {
  return `${sourceName}'s ${listWords(tables)}`;
}

// ---------------------------------------------------------------------------------------------
// Time in words — 2 min ago / an hour ago / yesterday / Oct 12
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const toMs = (value: string | number): number => (typeof value === 'number' ? value : Date.parse(value));

/** "Oct 17" — month then day, local time; ", 2025" only when it is not `now`'s year. */
export function shortDate(value: string | number, now: number = Date.now()): string {
  const date = new Date(toMs(value));
  const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${date.getFullYear()}`;
}

/** "3 Oct" — day then month, the provenance line's form (D11); " 2025" only when it is not `now`'s year. */
export function dayMonth(value: string | number, now: number = Date.now()): string {
  const date = new Date(toMs(value));
  const base = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  return date.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${date.getFullYear()}`;
}

const sameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * When something happened, in words: "just now" (under a minute, or a clock that ran ahead) ·
 * "2 min ago" · "an hour ago" · "5 hours ago" (under a day) · "yesterday" (the calendar day
 * before) · "Oct 9".
 */
export function relativeTime(value: string | number, now: number): string {
  const ms = toMs(value);
  const elapsed = now - ms;
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < 2 * HOUR_MS) return 'an hour ago';
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} hours ago`;
  if (sameLocalDay(new Date(ms), new Date(now - DAY_MS))) return 'yesterday';
  return shortDate(ms, now);
}

// ---------------------------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------------------------

/** A duration as the end of a sentence: "… · while it's open" (the strip's outcome, a live row). */
const DURATION_WORDS: Readonly<Record<AccessDuration, string>> = {
  session: "while it's open",
  day: 'for a day',
  week: 'for a week',
  always: 'until you stop it',
};

/** The consent sheet's radio: the session grant is named for the reader and says when it ends (D13). */
export function durationOption(duration: AccessDuration, readerName: string): { label: string; hint?: string } {
  switch (duration) {
    case 'session':
      return { label: `while ${readerName} is open`, hint: 'ends when you close it' };
    case 'day':
      return { label: 'for a day' };
    case 'week':
      return { label: 'for a week' };
    case 'always':
      return { label: 'until I stop it' };
    default: {
      const never: never = duration;
      return never;
    }
  }
}

const ALLOW_FOR: Readonly<Record<AccessDuration, string>> = {
  session: "while it's open",
  day: 'for a day',
  week: 'for a week',
  always: 'until I stop it',
};

/** The primary button names the choice: "allow while it's open". */
export function allowLabel(duration: AccessDuration): string {
  return `allow ${ALLOW_FOR[duration]}`;
}

// ---------------------------------------------------------------------------------------------
// The strip (ADR-0074 §4's rule: a strip, never a modal) and its outcome lines
// ---------------------------------------------------------------------------------------------

export const STRIP = {
  /** PR-3 (D-PR3-4/23, DS2): an ask that carried `access: 'write'` says so in its title; a read ask keeps the 1.1 title. */
  title: (readerName: string, wantsWrite = false): string =>
    wantsWrite ? `${readerName} wants to read — and change — another app's data` : `${readerName} wants to read another app's data`,
  says: (readerName: string): string => `${readerName} says:`,
  /** The purpose, quoted — rendered as a text node in a bidi-isolated block, never markup. */
  quote: (purpose: string): string => `“${purpose}”`,
  review: 'review',
  notNow: 'not now',
  stopAsking: 'stop asking',
} as const;

/**
 * "read Ledger's transactions" · "read and change Ledger's transactions" (every allowed table may
 * be changed) · "read Ledger's transactions and accounts, and change transactions" (some may) —
 * `write` is the written tables (U-Q8); an empty list is the 1.1 sentence.
 */
function readAndChangeWords(sourceName: string, tables: readonly string[], write: readonly string[]): string {
  if (write.length === 0) return `read ${tablesPhrase(sourceName, tables)}`;
  const written = new Set(write);
  if (tables.every((table) => written.has(table))) return `read and change ${tablesPhrase(sourceName, tables)}`;
  return `read ${tablesPhrase(sourceName, tables)}, and change ${listWords(write)}`;
}

/** One line for the visit after the act (AC18 `data-outcome`). */
export const STRIP_OUTCOME = {
  /**
   * PR-3 (D-PR3-23, DS2): the written tables, when any — "Budget can now read and change Ledger's transactions · while it's open".
   * PR-5 (D-PR5-15; D17): `notChange` when the ask wanted to change rows and the person ticked none —
   * folded into the clause, "Budget can now read — not change — Ledger's transactions · for a day".
   */
  allowed: (
    readerName: string,
    sourceName: string,
    tables: readonly string[],
    duration: AccessDuration,
    write: readonly string[] = [],
    opts: { notChange?: boolean } = {},
  ): string =>
    opts.notChange === true && write.length === 0
      ? `${readerName} can now read — not change — ${tablesPhrase(sourceName, tables)} · ${DURATION_WORDS[duration]}`
      : `${readerName} can now ${readAndChangeWords(sourceName, tables, write)} · ${DURATION_WORDS[duration]}`,
  /** The undo on the allowed line. */
  undo: 'stop',
  notNow: (readerName: string): string => `not now — ${readerName} may ask again`,
  wontAskAgain: (readerName: string): string => `${readerName} won't ask this again — allow it any time from ${readerName}'s access`,
  muted: (readerName: string): string => `${readerName} won't ask again — change that in Settings`,
} as const;

// ---------------------------------------------------------------------------------------------
// What an app would like to read (TASK-20261010-host-broker PR-5, D-PR5-2/3; D4, D5)
// ---------------------------------------------------------------------------------------------

/**
 * The shared install preview's note over the app's own access-wants meta: ONE sentence in the
 * host's words, then ONE line before the app's first purpose, which the surface quotes. The person
 * never reads "declaration" (that word is a starter's `connection.json`, glossary): the host says
 * *would like to read*, and every form says nothing is read until they allow it.
 */
export const ACCESS_WANTS = {
  /** `names`: the wants' hint tables (else their hint words), at most three; `more`: how many beyond them. No name at all → the may-ask form. */
  preview: (appName: string, names: readonly string[], more: number): string =>
    names.length === 0
      ? `${appName} may ask to read your other apps' data — nothing is read until you allow it`
      : `${appName} would like to read data like ${more > 0 ? `${names.join(', ')} and ${more} more` : listWords(names)} from your other apps — nothing is read until you allow it`,
  /** Said before the app's purpose, which the surface quotes (`CONSENT_SHEET.quote`) — never "would like to: “to …”" (D4). */
  forWhat: (appName: string): string => `what ${appName} says it's for:`,
} as const;

// ---------------------------------------------------------------------------------------------
// The consent sheet
// ---------------------------------------------------------------------------------------------

export const CONSENT_SHEET = {
  title: STRIP.title,
  says: STRIP.says,
  quote: STRIP.quote,
  from: 'from',
  howLong: 'for how long',
  egressTitle: (readerName: string): string => `where ${readerName} can send what it reads`,
  moreApps: 'more apps…',
  /** The mark on a credential-named column: listed, never in what is allowed (D23). */
  neverShared: 'never shared',
  moreColumns: (n: number): string => `+${n} more`,
  away: "also while I'm away",
  /** PR-2 (DS-7): a scheduled *ask <app>'s AI* reads the away set too, so the hint names it. */
  awayHint: (readerName: string): string => `if ${readerName} ever runs on a schedule — or its AI is asked on one`,
  notNow: 'not now',
  dontAllow: "don't allow",
  pickATable: 'choose at least one table',
  /**
   * The title of an ask the USER started from host chrome — theirs, never the app's want (W6 key, added after the freeze).
   * PR-5 (D-PR5-15; DS22): the chat's ask that wants to change rows says so, as the strip's write title does.
   */
  userTitle: (readerName: string, wantsWrite = false): string =>
    wantsWrite ? `let ${readerName} read and change another app's data` : `let ${readerName} read another app's data`,
  /** The instruction while no app is chosen — there is no table on screen to tick yet (W6 key, added after the freeze). */
  pickAnApp: 'choose an app',
  /**
   * The says-line of an ask the chat's AI made (TASK-20261010-host-broker PR-2, DS-15): the
   * user's ask (D3) in the AI's words, so the sheet says where they came from and quotes them.
   */
  askedInChat: (readerName: string): string => `asked in ${readerName}’s chat:`,
  // TASK-20261010-host-broker PR-3 (D-PR3-23; DS3–DS6, DS18, DS23): the write toggle, the column
  // chooser, the options row and the one breath under a ticked write.
  /** The per-table write toggle (`access-write-<app>-<t>`), OFF until the person ticks it. */
  canChange: 'can also change rows',
  /** The per-table disclosure that swaps the chips for pre-ticked column boxes (DS5). */
  chooseColumns: 'choose columns…',
  /** The 8-cut inside the column chooser: "show all 10 columns". */
  showAllColumns: (n: number): string => `show all ${n} columns`,
  /** A table whose every column is unticked cannot be allowed — the `pickATable` twin. */
  pickAColumn: 'choose at least one column',
  /** The `access-kv` option: the source's settings & notes (`snug_kv`) join what may be read (DS23). */
  settingsAndNotes: (sourceName: string): string => `${sourceName}'s settings & notes`,
  settingsAndNotesHint: (sourceName: string): string => `what ${sourceName} keeps outside its tables — never its connections or keys`,
  /** The `access-refresh` option: the reader may ask the source to fetch before a read (DS23, S7). */
  fetchFirst: (sourceName: string): string => `may ask ${sourceName} to fetch new data before reading it`,
  fetchFirstHint: (sourceName: string): string =>
    `through ${sourceName}'s own connections, at most once every five minutes, counted on your daily schedule limits`,
  /** Under a ticked write toggle, one breath: the bound, where the changes are listed, and that each can be undone (DS3/DS4/DS18; U-Q3 names the reader). */
  undoNote: (sourceName: string, table: string, readerName: string): string =>
    `while you're here, ${readerName} can change up to ${ACCESS_WRITE_MAX_ROWS} rows at a time in ${sourceName}'s ${table}; every change is listed in ${sourceName}'s access and can be undone for seven days`,
  /** The ONE disclosure the toggles and the options row live under (`access-options-more`) — open at once when they matter (DS6). */
  moreOptions: 'more options…',
  /** What the disclosure's summary describes for a screen reader (Gate-5 UI-2): opening it also puts a change toggle on each ticked table. */
  moreOptionsHint: 'also shows a change toggle on each ticked table',
  // TASK-20261010-host-broker PR-5 (D-PR5-3, D-PR5-5; D4, D7): the declared form's says-line and
  // the source's offer, which is read-only by construction.
  /** The declared form's says-line, before the app's quoted purpose — the preview's own words (one home). */
  declaredSays: ACCESS_WANTS.forWhat,
  /** The title of the sheet a SOURCE's offer opens, pinned to that source: what the person is letting happen, never "Budget wants …". */
  offerTitle: (readerName: string, sourceName: string): string => `let ${readerName} read ${sourceName}'s data`,
  /** `moreOptionsHint`'s twin on an offer, where no table can be changed: only the two options are behind the disclosure (D7). */
  moreOptionsOfferHint: 'also shows settings & notes and fetching new data first',
} as const;

/**
 * Sentences the strip and the consent sheet needed beyond the frozen set (W3b, UI-1 — keys
 * ADDED after the freeze, nothing renamed).
 */
export const CONSENT_UI = {
  /** The strip's note when *review* has to wait: a network or link confirm is open (the yield rule). */
  answerOtherFirst: 'answer the open question first, then review',
  /** The strip's line after its *stop* (the undo of an allow). PR-3 (DS2): "no longer reads or changes" when the access carried write — `write` is the written tables (U-Q8). */
  stopped: (readerName: string, sourceName: string, tables: readonly string[], write: readonly string[] = []): string =>
    `stopped — ${readerName} no longer ${write.length > 0 ? 'reads or changes' : 'reads'} ${tablesPhrase(sourceName, tables)}`,
  /** The strip's line when the allow could not be written — the engine's reason in words (only through `failedWords`). */
  failed: (message: string): string => `that did not work — ${message}`,
  /** The strip's line when the allow could not be written for a reason the user has no words for (W3b fix lane). */
  nothingAllowed: 'that did not work — nothing was allowed',
  /** A pair's ask whose wish or app changed between the listing and the tap (PR-5 D-PR5-6a `gone`). */
  changedSince: 'that changed since it was listed — nothing was allowed',
  /** A table on the sheet with its row count: "transactions · 412 rows". */
  tableRows: (table: string, rowCount: number): string => `${table} · ${rowsWord(rowCount)}`,
  /** The accessible name of a table's column chips. */
  columnsOf: (table: string): string => `columns of ${table}`,
} as const;

/**
 * The allow refusals the access engine ITSELF words for a person (`createGrantFromDecision`, the
 * pending's own *not offered*) — said as they are. Every other message (a file or protocol
 * refusal: the live-access cap, a full history, a record the schema refused) carries internal
 * words and caps, so it is never shown: the line says nothing was allowed instead.
 */
const SAYABLE_ALLOW_REFUSALS: readonly RegExp[] = [
  /^the asking app is not in this file$/,
  /^an app never needs access to itself$/,
  /^the other app is not in this file$/,
  /^that app keeps messages from others to itself$/,
  /^choose at least one table$/,
  // PR-3 (D-PR3-23): every readable column of a table left unticked — the sheet forbids it, the writer refuses it in the same words.
  /^choose at least one column$/,
  /^the other app offers no table "[^"\n]{1,64}"$/,
  /^"[^"\n]{1,64}" has nothing that can be read$/,
  /^that app was not offered$/,
];

/** The strip's line for a failed allow: the engine's own reason when it is one of its sentences, else `nothingAllowed`. */
export function failedWords(message: string): string {
  return SAYABLE_ALLOW_REFUSALS.some((rule) => rule.test(message)) ? CONSENT_UI.failed(message) : CONSENT_UI.nothingAllowed;
}

/** The open-link confirm's extra line while the app holds live access (AC18): what it read can leave in the address. */
export function openUrlCarries(sourceNames: readonly string[]): string {
  return `what it read from ${listWords(sourceNames)} can travel in this link`;
}

/**
 * The excluded apps, as ONE footer sentence (AC16): "3 apps have no data to read · Telepath
 * keeps messages from others to itself". Clauses in a fixed order — no data, too large,
 * messages from others, the asking app — and empty when nothing was excluded.
 */
export function excludedFooter(excluded: ReadonlyArray<{ displayName: string; reason: ExcludedReason }>): string {
  const named = (reason: ExcludedReason): string[] => excluded.filter((app) => app.reason === reason).map((app) => app.displayName);
  const clauses: string[] = [];
  const noTables = named('no-tables');
  if (noTables.length === 1) clauses.push(`${noTables[0]} has no data to read`);
  else if (noTables.length > 1) clauses.push(`${noTables.length} apps have no data to read`);
  const tooLarge = named('too-large');
  if (tooLarge.length === 1) clauses.push(`${tooLarge[0]} is too large to read this way`);
  else if (tooLarge.length > 1) clauses.push(`${tooLarge.length} apps are too large to read this way`);
  const sidecar = named('sidecar');
  if (sidecar.length === 1) clauses.push(`${sidecar[0]} keeps messages from others to itself`);
  else if (sidecar.length > 1) clauses.push(`${listWords(sidecar)} keep messages from others to themselves`);
  for (const self of named('reader')) clauses.push(`${self} itself is not offered`);
  return clauses.join(' · ');
}

// ---------------------------------------------------------------------------------------------
// "Where Budget can send what it reads" (AC15; ADR-0075 §8) — composed by egress.ts
// ---------------------------------------------------------------------------------------------

/**
 * The D9 data-use sentence (TASK-20261023-siwc-chatgpt-plan; ADR-0078 §9), the ONE non-legal home:
 * the egress line above, the Settings consent band and the Welcome read it from here (the legal
 * modules restate it literally — they may import nothing from the app). Settled by the security
 * review: OpenAI's documents never say which policy covers plan traffic, so this says exactly that
 * and never the two claims D9 forbids about training or retention (the copy pins walk every source).
 */
export const CHATGPT_DATA_USE =
  "In this mode your requests go to OpenAI under your ChatGPT account. OpenAI's documents don't say which data policy covers them, so assume your ChatGPT data controls ('Improve the model for everyone') apply. Snug and the app can't see your ChatGPT conversations or memories.";

/** Where a person manages the plan's usage — OpenAI's required indicator links here everywhere it renders (AC7, D5). */
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';

export const EGRESS = {
  keyed: (brainName: string, providerName: string): string => `its AI — ${brainName} (${providerName}), with your key`,
  keyMissing: (brainName: string): string => `its AI — ${brainName} (key missing)`,
  demo: 'its AI — the demo brain, which answers here and sends nothing out',
  webllm: 'its AI — a model running in this tab, on this device',
  local: (address: string): string => `its AI — your own model at ${address}`,
  host: (label: string): string => `its AI — ${label}, the AI this host provides`,
  subscription: 'its AI — through your Snug hub',
  /**
   * The ChatGPT plan (TASK-20261023-siwc-chatgpt-plan D9, ADR-0078 §9): the data-use sentence
   * VERBATIM, settled by the security review — OpenAI's documents never say which policy covers
   * plan traffic, so this says exactly that — and never the two claims D9 forbids about training or retention.
   */
  chatgpt: `its AI — your ChatGPT plan (OpenAI). ${CHATGPT_DATA_USE}`,
  approved: (providerName: string, host: string): string => `${providerName} (${host}) — a connection you approved`,
  declared: (providerName: string, host: string): string => `${providerName} (${host}) — declared, not connected yet`,
  helper: 'the WhatsApp helper on this Mac',
  helperDeclared: 'the WhatsApp helper on this Mac — declared, not connected yet',
  /** Never "no network" — the brain line above it may well be a network. */
  noConnections: 'no connections of its own',
  openUrl: 'any link it asks you to open — you see the address first',
  /** PR-2 (D-PR2-12): the chat beside the app is the same AI, and reads what the app may — said where the door is open. */
  chat: (readerName: string): string => `the chat beside ${readerName} — the same AI — whenever you ask it about ${readerName}’s data`,
  /** PR-2 (DS-7): a scheduled *ask <app>'s AI* reads the away set too, so the line names it. */
  away: (readerName: string): string => `also while you’re away — on a schedule it can read and send with no one watching, and so can a scheduled *ask ${readerName}’s AI*`,
  /**
   * "of its reads", never "every": the history is capped, coalesced and clearable (W6 finding 43).
   * PR-3 (D-PR3-23, DS4): "and changes" when any write is ticked — the block lists the places data
   * can GO, so a write adds no line of its own, only this ending.
   */
  closing: (sourceName: string, canChange = false): string =>
    `the copy is made here, on this device; ${sourceName} keeps a history of its reads${canChange ? ' and changes' : ''}`,
} as const;

/** The keyed providers' names on the brain line: "Claude (Anthropic)" — and the plan's, in the same shape. */
export const BRAIN_NAMES: Readonly<Record<'anthropic' | 'openai' | 'chatgpt', { brain: string; provider: string }>> = {
  anthropic: { brain: 'Claude', provider: 'Anthropic' },
  openai: { brain: 'GPT', provider: 'OpenAI' },
  chatgpt: { brain: 'ChatGPT plan', provider: 'OpenAI' },
};

// ---------------------------------------------------------------------------------------------
// The chat and scheduler doors (TASK-20261010-host-broker PR-2; ADR-0076 §1–§3; D-PR2-10/13/17;
// DS-11) — what a BRAIN reads about the tables another app let this one read. Composed by
// `agent/sharedDdl.ts` (the one renderer both doors call) and the data tools; the identifier
// quoting is the renderer's, the date and duration words are this file's own.
// ---------------------------------------------------------------------------------------------

/** "id INTEGER" · "note" (the dump allowed no type text for it). */
const columnWords = (name: string, type: string | undefined): string => (type === undefined || type === '' ? name : `${name} ${type}`);

export const CHAT_DOOR = {
  /**
   * The heading per source: how long the access lasts, in the sheet's own words. PR-5 (D-PR5-13):
   * on a `data_write` turn a source with a table the chat may change drops *read-only ·* — and only that.
   */
  heading: (sourceName: string, duration: AccessDuration, expiresAt: string | undefined, now: number, writable = false): string =>
    `### From ${sourceName} (${writable ? '' : 'read-only · '}access ${duration === 'session' ? "while it's open" : expiresAt !== undefined ? `until ${shortDate(expiresAt, now)}` : 'until you stop it'})`,
  /** One table: its full name in the copy, its columns with their types, and the row count — or the cut. PR-5 (D-PR5-13): `write` marks a table the chat may change. */
  tableLine: (name: string, columns: readonly string[], types: readonly string[], rows: number, truncated: boolean, totalRows?: number, write = false): string => {
    const signature = columns.map((column, i) => columnWords(column, types[i])).join(', ');
    const count = truncated ? (totalRows !== undefined ? `showing ${rows} of ${totalRows} rows` : `showing the first ${rows} rows`) : rowsWord(rows);
    return `${name}(${signature}) — ${count}${write ? ' · can be changed' : ''}`;
  },
  /** Said ONCE after the last source. */
  rule: 'the tables under *From …* above are copies of other apps’ data the user allowed this chat to read — query them with data_query by their full names as written (ledger__transactions); never propose a change to them',
  /** A source whose copy could not be made this turn — a note, never a refusal of the turn. */
  unreadable: (sourceName: string): string => `${sourceName}’s data could not be read this time`,
  /** The data tool's answer when the access ended between the copy and the read. */
  ended: (sourceName: string): string => `${sourceName}’s access ended — ask the user to allow it again`,
  /** The propose tool's refusal of a change that names a shared table (D-PR2-17). */
  readOnly: (sourceName: string): string => `${sourceName}’s data can’t be part of a change here — read it with data_query and propose the change with the values`,
  // TASK-20261010-host-broker PR-5 (D-PR5-11, D-PR5-13): the chat may propose ONE change to a table
  // the user let it change — said in the closing line of a `data_write` turn, and refused by rule.
  // Each refusal names what to do instead and never a row, a value or a column's content (DS19).
  /** REPLACES `rule` on a `data_write` turn whose block marks a table *can be changed* — said once, after the last source. */
  changes:
    'the tables under *From …* above are copies of other apps’ data the user allowed this chat to read — query them with data_query by their full names as written (ledger__transactions); a table marked *can be changed* may take ONE change through data_propose_write — one INSERT, UPDATE or DELETE on that table alone, naming it once at the start, with plain values written in (no ?, no arithmetic, functions or ON CONFLICT) and a WHERE on every UPDATE or DELETE — which the user applies on its card; never propose a change to any other of them',
  /** A batch of more than one statement on another app's table. */
  oneChange: 'a change to another app’s table is one statement at a time — propose just one',
  /** `params` beside a statement on another app's table. */
  valuesIn: 'a change to another app’s table carries its values written into the statement — no parameters',
  /** A table the user did not let this chat change (its settings & notes never can be). */
  readOnlyTable: (sourceName: string, table: string): string => `${sourceName}’s ${table} can’t be changed here — only a table marked *can be changed* can`,
  /** The source is in the middle of a change of its own. */
  busy: (sourceName: string): string => `${sourceName} is in the middle of a change — propose it again in a moment`,
  /** The plan changes nothing — no card for it. */
  noRows: (sourceName: string): string => `that change would change no rows in ${sourceName} — check what it names with data_query first`,
  /** The statement carries a character a change to another app's data may not (an invisible format character, or past the length rule). */
  unsafeText: 'that statement holds characters a change to another app’s data can’t carry — write it in plain text',
  /** The statement is not one plain change of the one table it names. */
  plainChange: (sourceName: string): string =>
    `a change to ${sourceName}’s data is one plain INSERT INTO, UPDATE or DELETE FROM its table, named once by its full name, with nothing before it — write it that way`,
  /** The tool's answer once the card is staged — the brain's own statement is echoed beside it. */
  proposed: (n: number, sourceName: string): string => `Proposed — it would change ${rowsWord(n)} in ${sourceName}; it waits for the user’s OK on the card`,
} as const;

/**
 * The brain's ASK card (D-PR2-11; DS-2, DS-5, DS-16): `access_propose` staged on the agent's
 * message. The lead line is the anti-imitation line every model-authored card carries; the
 * title is the sheet's own (`CONSENT_SHEET.userTitle`); the outcome line after an allow is the
 * strip's (`STRIP_OUTCOME.allowed`), without its undo.
 */
export const ACCESS_CARD = {
  lead: 'the agent asks:',
  review: 'review',
  notNow: 'not now',
  notNowLine: 'not now — the agent may ask again',
  declined: 'you said don’t allow — the agent won’t ask this again',
  /** While the sheet its *review* opened is up. */
  waiting: 'waiting for your review',
  /** The thread's app is gone — there is nothing left to ask for (added by the implementation lane; see the task's Gate-4 record). */
  stale: 'this app is gone — nothing to ask for',
} as const;

// ---------------------------------------------------------------------------------------------
// The reader's provenance line (D11) — composed by provenance.ts
// ---------------------------------------------------------------------------------------------

export const PROVENANCE = {
  built: (version: number): string => `built here · v${version}`,
  share: (installedOn: string): string => `installed from a share link on ${installedOn} · not built by you`,
  agent: 'handed in by your agent',
  starter: 'a starter from Snug',
  collides: 'another app has this name',
  /**
   * PR-5 (D-PR5-9; D16): an app an imported file brought in or changed — it overrides every install
   * source, which the file could have written itself. `day` is the marker's date in `dayMonth`'s
   * words; a marker that did not parse has none (the fail-closed read), and says so without one.
   */
  imported: (day?: string): string =>
    day !== undefined ? `arrived with a file you imported on ${day} · Snug can't tell who made it` : "arrived with a file you imported · Snug can't tell who made it",
} as const;

// ---------------------------------------------------------------------------------------------
// A row's state — the ONE derivation (AC17)
// ---------------------------------------------------------------------------------------------

/** What a row needs to say its state — a view over the record plus the two names. */
export interface GrantStateView {
  /** The protocol's own union (D24's rule: derived, never retyped). */
  status: AccessGrantStatus;
  suspendedReason?: AccessSuspendReason;
  expiresAt?: string;
  revokedAt?: string;
  reads: number;
  lastReadAt?: string;
  readerName: string;
  sourceName: string;
  /** The granted table whose columns changed (`source-changed`), when the engine knows it. */
  changedTable?: string;
  /**
   * The duration the user chose — REQUIRED, so a memory grant can never be described as
   * permanent by a caller that forgot it. A dated grant reads from `expiresAt` when it is given;
   * otherwise the words are the duration's own ("while it's open", "until you stop it", …).
   */
  duration: AccessDuration;
}

export type GrantActKind = 'stop' | 'allow-again' | 'remove';

export const GRANT_ACTS: Readonly<Record<GrantActKind, string>> = {
  stop: 'stop',
  'allow-again': 'allow again',
  remove: 'remove',
};

const act = (kind: GrantActKind): { kind: GrantActKind; label: string } => ({ kind, label: GRANT_ACTS[kind] });

function pausedWords(view: GrantStateView): string {
  switch (view.suspendedReason) {
    case 'reader-updated':
      return `paused — ${view.readerName} was updated`;
    case 'imported':
      return 'paused — arrived with an imported file';
    case 'source-changed':
      return view.changedTable !== undefined
        ? `paused — ${tablesPhrase(view.sourceName, [view.changedTable])} changed`
        : `paused — ${view.sourceName}'s data changed`;
    case 'source-restricted':
      return `paused — ${view.sourceName} now holds messages from others`;
    case 'reader-misbehaved':
      return `paused — ${view.readerName}'s reads kept taking too long`;
    case undefined:
      return 'paused';
    default: {
      const never: never = view.suspendedReason;
      return never;
    }
  }
}

/**
 * A row's words and its ONE act. Precedence: stopped → expired → paused → live. A pause
 * because the source now holds messages from others has no act — allowing again could not
 * succeed while that is true.
 */
export function grantStateCopy(
  view: GrantStateView,
  now: number,
): { words: string; act?: { kind: 'stop' | 'allow-again' | 'remove'; label: string } } {
  if (view.status === 'revoked') {
    return { words: view.revokedAt !== undefined ? `stopped ${shortDate(view.revokedAt, now)}` : 'stopped', act: act('remove') };
  }
  if (view.expiresAt !== undefined && toMs(view.expiresAt) <= now) {
    return { words: `expired ${shortDate(view.expiresAt, now)}`, act: act('allow-again') };
  }
  if (view.status === 'suspended') {
    const words = pausedWords(view);
    return view.suspendedReason === 'source-restricted' ? { words } : { words, act: act('allow-again') };
  }
  const until = view.expiresAt !== undefined ? `until ${shortDate(view.expiresAt, now)}` : DURATION_WORDS[view.duration];
  const parts = [until, readsWord(view.reads)];
  if (view.lastReadAt !== undefined) parts.push(`last read ${relativeTime(view.lastReadAt, now)}`);
  return { words: parts.join(' · '), act: act('stop') };
}

// ---------------------------------------------------------------------------------------------
// The access sheet (the run header's ⋈) and the history
// ---------------------------------------------------------------------------------------------

/** Why an undo could not be done — the engine's tokens (E1-Q2); `ACCESS_SHEET.undoFailed` words them. */
export type UndoFailureReason = 'busy' | 'changed' | 'gone' | 'failed';

const UNDO_FAILURE_WORDS: Readonly<Record<UndoFailureReason, (sourceName: string) => string>> = {
  busy: (sourceName) => `${sourceName} is busy — try again in a moment`,
  changed: (sourceName) => `${sourceName} changed these rows since`,
  gone: () => 'the change is gone — it can no longer be undone',
  failed: (sourceName) => `${sourceName} failed to put the rows back`,
};

const isUndoFailureReason = (reason: string): reason is UndoFailureReason => Object.prototype.hasOwnProperty.call(UNDO_FAILURE_WORDS, reason);

export const ACCESS_SHEET = {
  iconLabel: 'access',
  /** PR-3 (D-PR3-24, DS21): the sheet shows changes too. */
  iconTitle: 'what this app can read or change, and who can read or change it',
  title: (appName: string): string => `${appName}'s access`,
  reads: (appName: string): string => `${appName} reads`,
  readBy: (appName: string): string => `what reads ${appName}`,
  row: (readerName: string, sourceName: string, tables: readonly string[]): string => `${readerName} has access to ${tablesPhrase(sourceName, tables)}`,
  /** A stopped, expired or paused row — never "has access" beside words that say it has not (W6 key, added after the freeze). */
  endedRow: (readerName: string, sourceName: string, tables: readonly string[]): string => `${readerName}'s access to ${tablesPhrase(sourceName, tables)}`,
  history: 'history',
  historyImported: 'from an imported file',
  /** True before the first read, change or fetch AND after *clear history* (which keeps each access's read count) — W6 finding 39; PR-3 (DS21) counts changes and fetches too. */
  noHistory: 'nothing on record yet',
  whatItAsked: 'what it asked',
  declinedAsks: 'declined asks',
  allowDeclined: 'allow…',
  create: (readerName: string): string => `let ${readerName} read another app…`,
  /**
   * The PURPOSE an access the user made from host chrome carries (`provenance: 'user'`): the
   * host's words, never the creation act's label — a sheet that quotes "Budget says:" must not
   * put a sentence in Budget's mouth (the sheet skips that quote for a user-made access).
   */
  userPurpose: (readerName: string): string => `you started this yourself — ${readerName} did not ask`,
  nothing: (appName: string): string => `${appName} reads no other app, and no app reads ${appName}`,
  /** The ⋈ sheet's ✕ (W3b key, added after the freeze). */
  close: 'close',
  // TASK-20261010-host-broker PR-5 (D-PR5-3/4/5; D3, D6): the source's offer under *what reads
  // Ledger*, the reader's pair act under *Budget reads*, and the declared ask's persisted purpose.
  /** The offer block's heading, on a source with tables and at least one app that could read them. */
  offerTitle: (sourceName: string): string => `let another app read ${sourceName}'s data`,
  /** The accessible name of the offer's app picker. */
  offerPick: 'which app',
  /** The offer's act, naming the picked app and this one — the ask it opens is still the reader's, pinned to this source. */
  offer: (readerName: string, sourceName: string): string => `let ${readerName} read ${sourceName}…`,
  /**
   * The PURPOSE an access started from what the app would like to read carries (`provenance:
   * 'user'`): the host's words — the app's own purpose is quoted on the sheet, never persisted on
   * a record the person made (S16c).
   */
  declaredPurpose: (readerName: string): string => `you started this from what ${readerName} said it would like to read`,
  /** The reader's pair act: the source and the tables its declaration matched — host words, never the app's purpose. */
  pair: (sourceName: string, tables: readonly string[]): string => `${couldReadTables(sourceName, tables)} — review…`,
  /** Its accessible name, naming both apps (D3). */
  pairName: (readerName: string, sourceName: string, tables: readonly string[]): string => `${SETTINGS_CARD.pairRow(readerName, sourceName, tables)} — review`,
  // TASK-20261010-host-broker PR-3 (D-PR3-24; DS7, DS12, DS14): the write badge, *what it changed*,
  // and *undo* behind its armed confirm.
  /** The badge beside a live row's words (`access-row-write`) — no second act (MUST 17). */
  canChange: 'can also change rows',
  /** The same badge on a stopped, expired or paused row. */
  couldChange: 'could also change rows',
  /** The disclosure over a `wrote` row's statement — the `whatItAsked` twin. */
  whatItChanged: 'what it changed',
  /** The act on a `wrote` row whose journal entry is live (`access-history-undo`); also the confirm group's name (U-Q10). */
  undo: 'undo',
  /** The armed question (DS12, S18): the count, the table, and that nothing happens when the source changed the rows since (U-Q2 names the source); it agrees in number with the count (Gate-5 UI-1). */
  undoArm: (table: string, n: number, sourceName: string): string =>
    `put ${rowsWord(n)} in ${table} back as ${n === 1 ? 'it was' : 'they were'} before this change? (if ${sourceName} changed ${n === 1 ? 'it' : 'them'} since, nothing happens)`,
  undoYes: 'yes, undo',
  undoKeep: 'keep',
  /** The one outcome line after a done undo (`access-history-undo-outcome`). */
  undone: 'undone',
  /**
   * The outcome line when the undo could not be done (E1-Q2): the engine's reason token worded
   * with the source's name — `busy` · `changed` · `gone` · `failed`; a reason outside the four is
   * the engine's own words, said after the dash as given.
   */
  undoFailed: (reason: string, sourceName = 'the other app'): string =>
    `couldn't undo — ${isUndoFailureReason(reason) ? UNDO_FAILURE_WORDS[reason](sourceName) : reason}`,
  /** The who of a history row for an act from host chrome (`via: 'user'`) — the reader's name moves into the sentence (DS7; U-Q17). */
  you: 'you',
} as const;

/**
 * The undo of an app's OWN change (TASK-20261010-host-broker PR-4, D-PR4-19; D16, D20) — a change
 * the user applied from the chat or a result, or one a schedule made on its own. ONE home: the
 * chat card, the result page and the schedule's changes list compose it from here. Only the
 * question is its own (no other app to name — the rows are this app's, so the app is the place);
 * every other word is the ⋈ sheet's, reused, never respelled.
 */
export const OWN_UNDO = {
  undo: ACCESS_SHEET.undo,
  /** The armed question: the count in `rowsWord`'s words, the app, and that nothing happens when the rows changed since; it agrees in number with the count. */
  arm: (n: number, appName: string): string =>
    `put ${rowsWord(n)} in ${appName} back as ${n === 1 ? 'it was' : 'they were'} before this change? (if ${n === 1 ? 'it' : 'they'} changed since, nothing happens)`,
  yes: ACCESS_SHEET.undoYes,
  keep: ACCESS_SHEET.undoKeep,
  undone: ACCESS_SHEET.undone,
  /** The outcome line when it could not be done — the engine's reason token (`busy` · `changed` · `gone` · `failed`). */
  failed: ACCESS_SHEET.undoFailed,
} as const;

/**
 * The tail of an own change's line once the journal holds its undo no longer, while the change is
 * younger than its seven days — undone and gone, or given way early in its bucket (TASK-20261010-
 * host-broker PR-4 Gate 5, U2). ONE home: the chat's data-write card and the result page's made line
 * both end on it. Its own export, not an `OWN_UNDO` key — those are the ⋈ sheet's words, reused.
 */
export const OWN_UNDO_NO_LONGER = 'can no longer be undone';

/**
 * What an app's OWN change is answered with while that app is mid-change (its frame's BEGIN — the
 * driver's `inTransaction`): the app by its name, so the user and the model know what to wait for
 * (TASK-20261010-host-broker PR-4, D-PR4-5; T-A-12). ONE home: the write broker's own writes and
 * the schedule's proposal gate (and the scheduled agent through it) say it from here.
 */
export function appMidChange(appName: string): string {
  return `${appName} is in the middle of a change — try later`;
}

const SUSPEND_HISTORY_WORDS: Readonly<Record<AccessSuspendReason, string>> = {
  'reader-updated': 'it was updated',
  imported: 'arrived with an imported file',
  'source-changed': 'the data changed',
  'source-restricted': 'now holds messages from others',
  'reader-misbehaved': 'its reads kept taking too long',
};

const isSuspendReason = (reason: string | undefined): reason is AccessSuspendReason =>
  reason !== undefined && Object.prototype.hasOwnProperty.call(SUSPEND_HISTORY_WORDS, reason);

/**
 * Why a fetch the reader asked for did not deliver — a `refreshed` line's reason, ONE of the
 * protocol's `ACCESS_REFRESH_REASONS`, worded like `SUSPEND_HISTORY_WORDS` (D-PR3-6, DS13): a
 * function of the SOURCE's name (U-Q6). A handler's own text never reaches a line. PR-5 (D-PR5-17;
 * D13): a fetch the person cancelled ends `failed` too — no new token — so its words are true of
 * both: the fetch didn't finish.
 */
export const REFRESH_HISTORY_WORDS: Readonly<Record<AccessRefreshReason, (sourceName: string) => string>> = {
  'no-handler': (sourceName) => `${sourceName} can't fetch on request`,
  timeout: () => 'took too long',
  capped: (sourceName) => `${sourceName} is at the daily limit`,
  refused: (sourceName) => `a change ${sourceName} tried to send was refused`,
  failed: (sourceName) => `${sourceName}'s fetch didn't finish`,
};

const isRefreshReason = (reason: string | undefined): reason is AccessRefreshReason =>
  reason !== undefined && Object.prototype.hasOwnProperty.call(REFRESH_HISTORY_WORDS, reason);

/** Which door a `wrote` line came through, when it is worth a clause: "from its chat" · "on a schedule" — an app's own write says neither. */
function viaWords(via: AccessLogVia | undefined): string | undefined {
  switch (via) {
    case 'chat':
      return 'from its chat';
    case 'schedule':
      return 'on a schedule';
    case 'app':
    case 'user':
    case undefined:
      return undefined;
    default: {
      const never: never = via;
      return never;
    }
  }
}

/**
 * One history row in words, without the app's name (the row shows it beside these words):
 * "read transactions · 412 rows · 2 min ago · while you were here". A suspension's free-text
 * reason is shown only when it is one of the protocol's reasons — anything else reads "paused".
 *
 * PR-3 (D-PR3-24; DS7, DS13; U-Q1, U-Q5): `wrote` → "changed 3 rows in transactions · 2 min ago"
 * (+ " · from its chat" / " · on a schedule" after the time); `undone` → "undid Budget's change to
 * transactions · 3 rows put back · 2 min ago" — the reader's name moves INTO the sentence because
 * the row's who is "you"; `refreshed` → "asked Ledger to fetch new data · 2 min ago" (+ the
 * reason's words from `REFRESH_HISTORY_WORDS` before the time). `readerName` and `sourceName` are
 * the names those two sentences need — the row's reader (the sheet reads it off the entry) and
 * the sheet's own app; a line said without them names "the change" and "this app" instead.
 */
export function historyLine(
  entry: Pick<AccessLogEntry, 'at' | 'kind' | 'tables' | 'rows' | 'count' | 'attended' | 'reason' | 'via' | 'changes'>,
  now: number,
  readerName?: string,
  sourceName?: string,
): string {
  const when = relativeTime(entry.at, now);
  const tables = entry.tables !== undefined && entry.tables.length > 0 ? listWords(entry.tables) : undefined;
  switch (entry.kind) {
    case 'read': {
      const parts = [`read ${tables ?? 'data'}`];
      if (entry.rows !== undefined) parts.push(rowsWord(entry.rows));
      if (entry.count !== undefined && entry.count > 1) parts.push(`${entry.count} times`);
      parts.push(when);
      if (entry.attended !== undefined) parts.push(entry.attended ? 'while you were here' : 'while you were away');
      return parts.join(' · ');
    }
    case 'granted':
      return `allowed · ${when}`;
    case 'revoked':
      return `stopped · ${when}`;
    case 'expired':
      return `ended · ${when}`;
    case 'released':
      return `gave up its access · ${when}`;
    case 'refused':
      return `a read while you were away was refused · ${when}`;
    case 'suspended':
      return isSuspendReason(entry.reason) ? `paused — ${SUSPEND_HISTORY_WORDS[entry.reason]} · ${when}` : `paused · ${when}`;
    case 'wrote': {
      const parts = [`changed ${entry.changes !== undefined ? rowsWord(entry.changes) : 'rows'}${tables !== undefined ? ` in ${tables}` : ''}`, when];
      const via = viaWords(entry.via);
      if (via !== undefined) parts.push(via);
      return parts.join(' · ');
    }
    case 'undone': {
      const whose = readerName !== undefined ? `${readerName}'s change` : 'the change';
      const parts = [`undid ${whose}${tables !== undefined ? ` to ${tables}` : ''}`];
      if (entry.changes !== undefined) parts.push(`${rowsWord(entry.changes)} put back`);
      parts.push(when);
      return parts.join(' · ');
    }
    case 'refreshed': {
      const source = sourceName ?? 'this app';
      const parts = [`asked ${source} to fetch new data`];
      if (isRefreshReason(entry.reason)) parts.push(REFRESH_HISTORY_WORDS[entry.reason](source));
      parts.push(when);
      return parts.join(' · ');
    }
    default: {
      const never: never = entry.kind;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Settings → access between apps
// ---------------------------------------------------------------------------------------------

export const SETTINGS_CARD = {
  title: 'access between apps',
  /** PR-3 (D-PR3-24, DS21): the card says change too. */
  intro: "which of your apps can read — or change, when you allowed it — another app's data; the app that was read keeps a history of its reads and changes",
  empty: "no app can read another app's data yet",
  neverAsk: "never let apps ask to read other apps' data",
  /** The switch's custody, stated (Q15): per browser, like the schedule's. */
  neverAskHint: 'kept in this browser only — it does not travel with your file',
  mutedTitle: "apps that won't ask",
  unmute: (appName: string): string => `let ${appName} ask again`,
  clearHistory: 'clear history',
  /** PR-3 (D-PR3-6/24, DS21): `clearAccessLog` keeps every non-read kind — the acts, and every change. */
  clearHistoryHint: 'when access was allowed, stopped or paused — and every change — stays on record',
  create: ACCESS_SHEET.create,
  // W3b keys, added after the freeze: *clear history*'s inline confirm and the creation act's picker.
  clearArm: "clear every read from every app's history?",
  clearConfirm: 'clear',
  clearKeep: 'keep',
  /** The status line after the clear. */
  cleared: 'history cleared',
  /** The accessible name of the creation act's app picker. */
  createPick: 'which app',
  // TASK-20261010-host-broker PR-5 (D-PR5-4; D3): *apps that could work together* — pairs from what
  // the apps say they would like to read, matched to another app's tables. Never "works with":
  // nothing is shared until the person allows it.
  pairsTitle: 'apps that could work together',
  /** One pair: the reader, the source and the tables its declaration matched — the purpose is quoted below it. */
  pairRow: (readerName: string, sourceName: string, tables: readonly string[]): string => `${readerName} ${couldReadTables(sourceName, tables)}`,
  /** The row's act. */
  pairReview: 'review…',
  /** The act's accessible name: the row's sentence, then the act. */
  pairReviewName: (readerName: string, sourceName: string, tables: readonly string[]): string => `${SETTINGS_CARD.pairRow(readerName, sourceName, tables)} — review`,
} as const;

// ---------------------------------------------------------------------------------------------
// The Hub tile (TASK-20261010-host-broker PR-5, D-PR5-6, D-PR5-7; D2, D3) — report-only
// ---------------------------------------------------------------------------------------------

/** "reads 1 other app" · "read by 2 apps" — distinct apps; a count of 0 says nothing. */
const readsApps = (n: number): string => `reads ${n} other ${n === 1 ? 'app' : 'apps'}`;
const readByApps = (n: number): string => `read by ${n} ${n === 1 ? 'app' : 'apps'}`;

export const HUB_TILE = {
  /** The tile's access line, VISIBLE inside the tile's link so it is part of its name: "reads 1 other app · read by 2 apps"; empty at 0 · 0 (no line). */
  accessWords: (reads: number, readBy: number): string => [...(reads > 0 ? [readsApps(reads)] : []), ...(readBy > 0 ? [readByApps(readBy)] : [])].join(' · '),
  /** The sibling act on a tile whose app could read another's — host words only, never the app's purpose. */
  couldRead: (sourceName: string): string => `${couldReadData(sourceName)} — review…`,
  /** Its accessible name, naming both apps. */
  couldReadName: (appName: string, sourceName: string): string => `${appName} ${couldReadData(sourceName)} — review`,
} as const;

/** The update confirm names the access that will pause (AC21) beside the schedules. */
export function updatePausesAccess(readerName: string, sourceNames: readonly string[]): string {
  return `${readerName}'s access to ${listWords(sourceNames)} will pause until you allow it again`;
}

// ---------------------------------------------------------------------------------------------
// The app-facing messages the handler sends (AC11–13) — scanned like every other sentence
// ---------------------------------------------------------------------------------------------

/**
 * The rule a write was refused under (D-PR3-12/15; E1-Q1) — the engine's tokens, worded here:
 * `statement` (every parse refusal: not one plain INSERT, UPDATE or DELETE with literal values) ·
 * `table` (a trigger, virtual, WITHOUT ROWID, a REPLACE clause, a foreign-key action, a CHECK over
 * an unshared column, a DELETE on a partly shared table) · `no-where` · `column` (withheld,
 * credential-named or masked) · `computed` · `value` (a credential-shaped literal, parameter or
 * captured cell) · `too-many` · `too-large` · `waiting` (the live-entry cap or the row cap).
 */
export type WriteRefusalRule = 'statement' | 'table' | 'no-where' | 'column' | 'computed' | 'value' | 'too-many' | 'too-large' | 'waiting';

/** Each rule in words — none names a row, a value or a column's content (DS19). */
const WRITE_REFUSAL_WORDS = {
  statement: 'only one plain INSERT, UPDATE or DELETE with literal values is allowed',
  table: "that table can't be changed from another app",
  'no-where': 'names no rows — a change to every row is made in the other app itself',
  column: "a column it names isn't shared",
  computed: "a computed column can't be used in a change",
  value: "a value in it can't be matched",
  'too-many': `too many rows — at most ${ACCESS_WRITE_MAX_ROWS} at a time`,
  'too-large': 'too large to undo',
  waiting: 'too many changes are waiting to be undone — undo them or wait',
} as const satisfies Readonly<Record<WriteRefusalRule, string>>;

/** A rule said in its own words — the form the copy's pins read it in. */
export type WriteRefusalWords = (typeof WRITE_REFUSAL_WORDS)[WriteRefusalRule];

const isWriteRefusalRule = (rule: WriteRefusalRule | WriteRefusalWords): rule is WriteRefusalRule => Object.prototype.hasOwnProperty.call(WRITE_REFUSAL_WORDS, rule);

/** Why a fetch the reader asked for failed, for the reader (U-Q4; E2-Q3): no source fact, no re-ask. `no-handler` is the one sentence the handler sends on its own too. */
const REFRESH_FAILED_WORDS: Readonly<Record<AccessRefreshReason, string>> = {
  'no-handler': 'the other app does not fetch on request',
  timeout: 'the other app took too long',
  capped: "the day's schedule limit is reached — try again tomorrow",
  refused: 'a change the other app tried to send was refused',
  failed: "the other app's fetch failed",
};

export const ACCESS_APP_MESSAGES = {
  invalidRequest: 'that ask could not be read',
  notGranted: 'no access — ask first',
  notNow: 'the person said not now — you may ask again later',
  declined: 'the person said no to this ask',
  muted: 'the person turned off asks from this app',
  askingOff: 'asks to read other apps are turned off here',
  pending: 'an ask is already waiting for the person',
  unattended: 'no one is looking — ask while the app is open',
  noSources: 'there is no other app with data to read',
  revoked: 'this access was stopped',
  paused: 'this access is paused',
  expired: 'this access has ended',
  queryRefused: 'only one read-only SELECT is allowed',
  queryFailed: 'the read failed',
  /** AC12's wording, verbatim. */
  tooLarge: "the other app's data is too large to share this way",
  tookTooLong: 'the read took too long',
  /** AC12/the engine's wording, verbatim. */
  noWorker: 'this host cannot run cross-app reads',
  sourceChanged: "the other app's data changed — this access is paused until the person looks again",
  askRateLimited: 'asking too often — wait a few seconds',
  queryRateLimited: 'too many reads — wait a minute',
  hostError: 'access between apps is not available right now',
  // TASK-20261010-host-broker PR-3 (D-PR3-13/15/17/24; DS19): the write and the refresh — every
  // one reveals no source fact and invites no re-ask.
  /** Rule 7 of a `write`: the named table carries no `write` (`ACCESS_NOT_GRANTED`). */
  writeNotGranted: 'this access is read-only for that table',
  /** `ACCESS_WRITE_REFUSED`: the rule's token (E1-Q1), or the rule in its own words. */
  writeRefused: (rule: WriteRefusalRule | WriteRefusalWords): string => `the change was refused — ${isWriteRefusalRule(rule) ? WRITE_REFUSAL_WORDS[rule] : rule}`,
  /** `ACCESS_BUSY` (retryable): the target holds an open transaction, or changed between the dry run and the apply — no count. */
  busy: 'the other app is in the middle of a change — try again',
  /** A `refresh` under an access without `refresh` (`ACCESS_NOT_GRANTED`). */
  refreshNotGranted: 'this access does not allow asking for new data',
  /** `ACCESS_REFRESH_FAILED`: the source never announced a handler (`refreshFailed('no-handler')`'s sentence, as its own key). */
  refreshNoHandler: REFRESH_FAILED_WORDS['no-handler'],
  /** `ACCESS_REFRESH_FAILED` with its reason (E2-Q3). */
  refreshFailed: (reason: AccessRefreshReason): string => REFRESH_FAILED_WORDS[reason],
  /** `ACCESS_REFRESH_FAILED` (not retryable): the three gates — no scheduler, no state row, or everything paused (S7). */
  refreshOff: 'schedules are off for this file',
  /** `ACCESS_REFRESH_FAILED` (not retryable): the person stopped the fetch the app was waiting on (PR-5, D-PR5-17) — never the failure's words. */
  refreshStopped: "the other app's fetch was stopped before it finished",
} as const;

// ---------------------------------------------------------------------------------------------
// *Fetch new data first* — the chat's and the schedule's doors (TASK-20261010-host-broker PR-5,
// D-PR5-18, D-PR5-20; D10, D15b/e). ONE home: the chat's note on the person's message, the turn's
// host line and the schedule's step fact all say these; nothing respells them. *New data*, never
// *look up*. `when` arrives already worded ("4 min ago").
// ---------------------------------------------------------------------------------------------

export const FETCH_FIRST = {
  done: (sourceName: string): string => `fetched new data from ${sourceName} first`,
  /** A fetch inside the source's cooldown: the last one's time and whether it delivered. */
  recent: (sourceName: string, when: string, ok: boolean): string =>
    ok ? `${sourceName} fetched new data ${when} — used that` : `${sourceName} couldn't fetch new data ${when} — used what it had`,
  /** The step fact's `recent`, where no time travels with the run. */
  recentUsed: (sourceName: string): string => `${sourceName} had fetched new data just before — used that`,
  /** Inside the cooldown with no outcome known (the last ask was another door's, still in flight or long gone). */
  askedRecently: (sourceName: string, when: string): string => `${sourceName} was asked for new data ${when}`,
  failed: (sourceName: string): string => `${sourceName} couldn't fetch new data — answered from what it had`,
  /** Past the cap of sources, or with no time left before the run's bound. */
  skipped: (sourceName: string): string => `${sourceName} wasn't asked for new data this time`,
  /** The person stopped the turn while the source was fetching. */
  stopped: (sourceName: string): string => `stopped while ${sourceName} was fetching new data`,
  /** The person pressed *fetch new data first* but no app lets this one ask any more (an access ended since — Gate-5 fold P3-10). */
  nothingToAsk: (readerName: string): string => `no app lets ${readerName} ask for new data now — answered from what it had`,
  /** The ONE host line the chat's brain reads about the fetch (Gate-5 fold P3-2): the names in it are `oneLine`-folded. */
  contextLine: (note: string): string => `The host, before this turn: ${note}`,
} as const;

/** The chat's toggle beside *send* (D-PR5-20): up to two sources by name, more by count — the names then ride the title. */
export const CHAT_FETCH = {
  /** The label names only the sources a fetch asks — at most `REFRESH_FIRST_MAX_SOURCES`, in order — and counts the rest (Gate-5 fold P3-6). */
  first: (names: readonly string[]): string => {
    const asked = names.slice(0, REFRESH_FIRST_MAX_SOURCES);
    const rest = names.length - asked.length;
    return `fetch new data from ${listWords(asked)} first${rest > 0 ? ` (+${rest} not asked)` : ''}`;
  },
  /**
   * Under the PRESSED toggle (TASK-20261013-rail-chat-access AC7): what the press arranged — a press
   * only arms the next send (D-PR5-20), and without this line it read as "nothing happened".
   */
  armed: (names: readonly string[]): string => `your next message asks ${listWords(names.slice(0, REFRESH_FIRST_MAX_SOURCES))} for new data first`,
  /** The toggle's title: the sources asked by name, then the ones it never asks. */
  firstNamed: (names: readonly string[]): string => {
    const asked = names.slice(0, REFRESH_FIRST_MAX_SOURCES);
    const rest = names.slice(REFRESH_FIRST_MAX_SOURCES);
    return `fetch new data from ${listWords(asked)} first${rest.length > 0 ? ` — ${listWords(rest)} ${rest.length === 1 ? "isn't" : "aren't"} asked (at most ${REFRESH_FIRST_MAX_SOURCES} each time)` : ''}`;
  },
} as const;
