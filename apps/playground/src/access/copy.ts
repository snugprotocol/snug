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
//
// THE VOICE. Lowercase-leading, plain words, no exclamation marks. Apostrophes are the
// straight ones the task file pins ("while it's open", "Budget's access"); the typographic
// quote marks wrap the app's purpose and the away line keeps the house’s curly apostrophe
// because the egress block pins it.

import type { AccessDuration, AccessGrantStatus, AccessLogEntry, AccessSuspendReason } from '@snugprotocol/protocol';

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
export const DURATION_WORDS: Readonly<Record<AccessDuration, string>> = {
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
  title: (readerName: string): string => `${readerName} wants to read another app's data`,
  says: (readerName: string): string => `${readerName} says:`,
  /** The purpose, quoted — rendered as a text node in a bidi-isolated block, never markup. */
  quote: (purpose: string): string => `“${purpose}”`,
  review: 'review',
  notNow: 'not now',
  stopAsking: 'stop asking',
} as const;

/** One line for the visit after the act (AC18 `data-outcome`). */
export const STRIP_OUTCOME = {
  allowed: (readerName: string, sourceName: string, tables: readonly string[], duration: AccessDuration): string =>
    `${readerName} can now read ${tablesPhrase(sourceName, tables)} · ${DURATION_WORDS[duration]}`,
  /** The undo on the allowed line. */
  undo: 'stop',
  notNow: (readerName: string): string => `not now — ${readerName} may ask again`,
  wontAskAgain: (readerName: string): string => `${readerName} won't ask this again — allow it any time from ${readerName}'s access`,
  muted: (readerName: string): string => `${readerName} won't ask again — change that in Settings`,
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
  awayHint: (readerName: string): string => `if ${readerName} ever runs on a schedule`,
  notNow: 'not now',
  dontAllow: "don't allow",
  pickATable: 'choose at least one table',
} as const;

/**
 * Sentences the strip and the consent sheet needed beyond the frozen set (W3b, UI-1 — keys
 * ADDED after the freeze, nothing renamed).
 */
export const CONSENT_UI = {
  /** The strip's note when *review* has to wait: a network or link confirm is open (the yield rule). */
  answerOtherFirst: 'answer the open question first, then review',
  /** The strip's line after its *stop* (the undo of an allow). */
  stopped: (readerName: string, sourceName: string, tables: readonly string[]): string =>
    `stopped — ${readerName} no longer reads ${tablesPhrase(sourceName, tables)}`,
  /** The strip's line when the allow could not be written — the engine's reason in words (only through `failedWords`). */
  failed: (message: string): string => `that did not work — ${message}`,
  /** The strip's line when the allow could not be written for a reason the user has no words for (W3b fix lane). */
  nothingAllowed: 'that did not work — nothing was allowed',
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

export const EGRESS = {
  keyed: (brainName: string, providerName: string): string => `its AI — ${brainName} (${providerName}), with your key`,
  keyMissing: (brainName: string): string => `its AI — ${brainName} (key missing)`,
  demo: 'its AI — the demo brain, which answers here and sends nothing out',
  webllm: 'its AI — a model running in this tab, on this device',
  local: (address: string): string => `its AI — your own model at ${address}`,
  host: (label: string): string => `its AI — ${label}, the AI this host provides`,
  subscription: 'its AI — through your Snug hub',
  approved: (providerName: string, host: string): string => `${providerName} (${host}) — a connection you approved`,
  declared: (providerName: string, host: string): string => `${providerName} (${host}) — declared, not connected yet`,
  helper: 'the WhatsApp helper on this Mac',
  helperDeclared: 'the WhatsApp helper on this Mac — declared, not connected yet',
  /** Never "no network" — the brain line above it may well be a network. */
  noConnections: 'no connections of its own',
  openUrl: 'any link it asks you to open — you see the address first',
  away: 'also while you’re away — on a schedule it can read and send with no one watching',
  closing: (sourceName: string): string => `the copy is made here, on this device; ${sourceName} keeps a history of every read`,
} as const;

/** The keyed providers' names on the brain line: "Claude (Anthropic)". */
export const BRAIN_NAMES: Readonly<Record<'anthropic' | 'openai', { brain: string; provider: string }>> = {
  anthropic: { brain: 'Claude', provider: 'Anthropic' },
  openai: { brain: 'GPT', provider: 'OpenAI' },
};

// ---------------------------------------------------------------------------------------------
// The reader's provenance line (D11) — composed by provenance.ts
// ---------------------------------------------------------------------------------------------

export const PROVENANCE = {
  built: (version: number): string => `built here · v${version}`,
  share: (installedOn: string): string => `installed from a share link on ${installedOn} · not built by you`,
  agent: 'handed in by your agent',
  starter: 'a starter from Snug',
  collides: 'another app has this name',
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

export const ACCESS_SHEET = {
  iconLabel: 'access',
  iconTitle: 'what this app can read, and who can read it',
  title: (appName: string): string => `${appName}'s access`,
  reads: (appName: string): string => `${appName} reads`,
  readBy: (appName: string): string => `what reads ${appName}`,
  row: (readerName: string, sourceName: string, tables: readonly string[]): string => `${readerName} has access to ${tablesPhrase(sourceName, tables)}`,
  history: 'history',
  historyImported: 'from an imported file',
  noHistory: 'nothing read yet',
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
} as const;

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
 * One history row in words, without the app's name (the row shows it beside these words):
 * "read transactions · 412 rows · 2 min ago · while you were here". A suspension's free-text
 * reason is shown only when it is one of the protocol's reasons — anything else reads "paused".
 */
export function historyLine(
  entry: Pick<AccessLogEntry, 'at' | 'kind' | 'tables' | 'rows' | 'count' | 'attended' | 'reason'>,
  now: number,
): string {
  const when = relativeTime(entry.at, now);
  switch (entry.kind) {
    case 'read': {
      const parts = [`read ${entry.tables !== undefined && entry.tables.length > 0 ? listWords(entry.tables) : 'data'}`];
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
  intro: "which of your apps can read another app's data — the app that was read keeps a history of every read",
  empty: "no app can read another app's data yet",
  neverAsk: "never let apps ask to read other apps' data",
  /** The switch's custody, stated (Q15): per browser, like the schedule's. */
  neverAskHint: 'kept in this browser only — it does not travel with your file',
  mutedTitle: "apps that won't ask",
  unmute: (appName: string): string => `let ${appName} ask again`,
  clearHistory: 'clear history',
  clearHistoryHint: 'when access was allowed, stopped or paused stays on record',
  create: ACCESS_SHEET.create,
  // W3b keys, added after the freeze: *clear history*'s inline confirm and the creation act's picker.
  clearArm: "clear every read from every app's history?",
  clearConfirm: 'clear',
  clearKeep: 'keep',
  /** The status line after the clear. */
  cleared: 'history cleared',
  /** The accessible name of the creation act's app picker. */
  createPick: 'which app',
} as const;

/** The update confirm names the access that will pause (AC21) beside the schedules. */
export function updatePausesAccess(readerName: string, sourceNames: readonly string[]): string {
  return `${readerName}'s access to ${listWords(sourceNames)} will pause until you allow it again`;
}

// ---------------------------------------------------------------------------------------------
// The app-facing messages the handler sends (AC11–13) — scanned like every other sentence
// ---------------------------------------------------------------------------------------------

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
} as const;
