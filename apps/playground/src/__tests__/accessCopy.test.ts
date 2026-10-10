// accessCopy.test.ts — TASK-20261010-cross-app-access AC17 (+ the provenance line of AC18 /
// D11): every user-facing sentence of access between apps has ONE home, `access/copy.ts`, and
// each is pinned here byte-for-byte (explicit `toBe`, never a snapshot — a snapshot would
// bless the drift it was meant to catch).
//
// `grantStateCopy(view, now)` is THE derivation of a row's words and its one act — the seven
// states of AC17 verbatim, on every surface (the access sheet, Settings, the strip's outcome).
//
// THE VOCABULARY SCAN (D1, AC17). The engine says grant · reader · scope · log; a person reads
// *access* and *history*. The last block walks every source file under `access/` (recursively)
// except `copy.ts`, blanks the comments, and refuses a string literal that spells one of the
// four words as a whole word (case-insensitive, plural included) — the app-facing error
// messages the handler sends are string literals too, so they are scanned. It proves it can
// fail by PLANTING a sentence in a scratch file under `access/`, seeing the scan red, and
// deleting the file, before it is trusted on the real tree.
//
// What the scan tolerates, by name: identifiers and keys are not sentences (`grantId`,
// `'accessGrant:'`, `ACCESS_NOT_GRANTED`, the log kind `'granted'` — none is the whole word);
// and a literal that IS, in its entirety, one of the machine tokens the protocol or the
// ranking defines (`'reader-updated'`, `'reader-misbehaved'` — suspend reasons; `'reader'` —
// an excluded-app reason) is an enum member, not a sentence. That exemption set is pinned
// below, so a new token that spells a banned word is a deliberate edit here.
// The scan TOKENISES with the TypeScript parser (never regexes): a `//` or `/*` inside a string
// cannot blind it, a JSX text node (`<p>a reader</p>`) and a JSX attribute string are sentences
// too, every template literal is seen (nested ones included) by its LITERAL parts — a `${grant.id}`
// substitution is code, not copy — and a module specifier (`'./grants.js'`) is a file name, not a
// sentence.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { ACCESS_SUSPEND_REASONS, accessGrantSchema, type AccessGrantStatus } from '@snugprotocol/protocol';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_APP_MESSAGES,
  ACCESS_SHEET,
  CONSENT_SHEET,
  CONSENT_UI,
  EGRESS,
  GRANT_ACTS,
  SETTINGS_CARD,
  STRIP,
  STRIP_OUTCOME,
  allowLabel,
  durationOption,
  excludedFooter,
  failedWords,
  grantStateCopy,
  historyLine,
  listWords,
  openUrlCarries,
  readsWord,
  relativeTime,
  rowsWord,
  shortDate,
  tablesPhrase,
  updatePausesAccess,
  type GrantStateView,
} from '../access/copy.js';
import { nameCollides, provenanceLine, readerProvenanceKind } from '../access/provenance.js';
import { EXCLUDED_REASONS } from '../access/relevance.js';

// Local-time fixtures: every clock below is built from local components, so the pins hold in
// any timezone the suite runs in.
const NOW = new Date(2026, 9, 12, 15, 0, 0).getTime(); // Oct 12, 3 pm
const at = (month: number, day: number, hour = 12, minute = 0): string => new Date(2026, month, day, hour, minute).toISOString();
const MIN = 60_000;

const BASE: GrantStateView = {
  status: 'active',
  reads: 14,
  readerName: 'Budget',
  sourceName: 'Ledger',
  duration: 'week',
};

// ---------------------------------------------------------------------------------------------
// The words and the small pluralisers
// ---------------------------------------------------------------------------------------------

describe('the small words every sentence composes from', () => {
  it('rowsWord / readsWord pluralise once', () => {
    expect(rowsWord(0)).toBe('no rows');
    expect(rowsWord(1)).toBe('1 row');
    expect(rowsWord(412)).toBe('412 rows');
    expect(readsWord(0)).toBe('no reads yet');
    expect(readsWord(1)).toBe('1 read');
    expect(readsWord(14)).toBe('14 reads');
  });

  it('listWords joins with commas and a final "and"', () => {
    expect(listWords([])).toBe('');
    expect(listWords(['transactions'])).toBe('transactions');
    expect(listWords(['transactions', 'accounts'])).toBe('transactions and accounts');
    expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('tablesPhrase names the source and its tables', () => {
    expect(tablesPhrase('Ledger', ['transactions'])).toBe("Ledger's transactions");
    expect(tablesPhrase('Ledger', ['transactions', 'accounts'])).toBe("Ledger's transactions and accounts");
  });
});

describe('time in words — 2 min ago / an hour ago / yesterday / Oct 12', () => {
  it('relativeTime walks from just now to a date', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5 * MIN, NOW)).toBe('just now');
    expect(relativeTime(NOW - MIN, NOW)).toBe('1 min ago');
    expect(relativeTime(NOW - 2 * MIN, NOW)).toBe('2 min ago');
    expect(relativeTime(NOW - 59 * MIN, NOW)).toBe('59 min ago');
    expect(relativeTime(NOW - 60 * MIN, NOW)).toBe('an hour ago');
    expect(relativeTime(NOW - 119 * MIN, NOW)).toBe('an hour ago');
    expect(relativeTime(NOW - 5 * 60 * MIN, NOW)).toBe('5 hours ago');
    expect(relativeTime(at(9, 11, 9), NOW)).toBe('yesterday');
    expect(relativeTime(at(9, 9, 9), NOW)).toBe('Oct 9');
    expect(relativeTime(at(8, 30), NOW)).toBe('Sep 30');
  });

  it('accepts an ISO string or epoch milliseconds alike', () => {
    expect(relativeTime(new Date(NOW - 2 * MIN).toISOString(), NOW)).toBe('2 min ago');
  });

  it('shortDate is month then day, with the year only when it is not this year', () => {
    expect(shortDate(at(9, 17), NOW)).toBe('Oct 17');
    expect(shortDate(new Date(2025, 11, 3, 12).toISOString(), NOW)).toBe('Dec 3, 2025');
  });
});

// ---------------------------------------------------------------------------------------------
// grantStateCopy — the seven states of AC17, verbatim
// ---------------------------------------------------------------------------------------------

describe('grantStateCopy — ONE derivation of a row’s words and its act (AC17)', () => {
  it('live: until Oct 17 · 14 reads · last read 2 min ago · stop', () => {
    const view: GrantStateView = { ...BASE, expiresAt: at(9, 17), lastReadAt: new Date(NOW - 2 * MIN).toISOString() };
    expect(grantStateCopy(view, NOW)).toEqual({ words: 'until Oct 17 · 14 reads · last read 2 min ago', act: { kind: 'stop', label: 'stop' } });
  });

  it('paused — Budget was updated · allow again', () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'reader-updated' }, NOW)).toEqual({
      words: 'paused — Budget was updated',
      act: { kind: 'allow-again', label: 'allow again' },
    });
  });

  it('paused — arrived with an imported file · allow again', () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'imported' }, NOW)).toEqual({
      words: 'paused — arrived with an imported file',
      act: { kind: 'allow-again', label: 'allow again' },
    });
  });

  it("paused — Ledger's transactions changed · allow again", () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'source-changed', changedTable: 'transactions' }, NOW)).toEqual({
      words: "paused — Ledger's transactions changed",
      act: { kind: 'allow-again', label: 'allow again' },
    });
  });

  it('paused — Ledger now holds messages from others (no act: it cannot be allowed again while that is true)', () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'source-restricted' }, NOW)).toEqual({
      words: 'paused — Ledger now holds messages from others',
    });
  });

  it('expired Oct 17 · allow again', () => {
    const later = new Date(2026, 9, 18, 9).getTime();
    expect(grantStateCopy({ ...BASE, expiresAt: at(9, 17) }, later)).toEqual({
      words: 'expired Oct 17',
      act: { kind: 'allow-again', label: 'allow again' },
    });
  });

  it('stopped Oct 12 · remove', () => {
    expect(grantStateCopy({ ...BASE, status: 'revoked', revokedAt: at(9, 12, 9) }, NOW)).toEqual({
      words: 'stopped Oct 12',
      act: { kind: 'remove', label: 'remove' },
    });
  });

  it("a session duration reads while it's open", () => {
    expect(grantStateCopy({ ...BASE, duration: 'session', reads: 3, lastReadAt: new Date(NOW - 60 * MIN).toISOString() }, NOW)).toEqual({
      words: "while it's open · 3 reads · last read an hour ago",
      act: { kind: 'stop', label: 'stop' },
    });
  });

  it('a grant with no end reads until you stop it; no reads and no last read are said plainly', () => {
    expect(grantStateCopy({ ...BASE, duration: 'always', reads: 0 }, NOW)).toEqual({
      words: 'until you stop it · no reads yet',
      act: { kind: 'stop', label: 'stop' },
    });
  });

  it('the duration is REQUIRED: a view that does not say how long the access lasts does not type-check, so a session grant can never read as permanent', () => {
    // @ts-expect-error — `duration` is required on GrantStateView (a session view without it would read "until you stop it")
    const missing: GrantStateView = { status: 'active', reads: 3, readerName: 'Budget', sourceName: 'Ledger' };
    expect(missing.status).toBe('active');
    expect(grantStateCopy({ ...BASE, duration: 'session', reads: 3 }, NOW).words).toBe("while it's open · 3 reads");
    expect(grantStateCopy({ ...BASE, duration: 'always', reads: 3 }, NOW).words).toBe('until you stop it · 3 reads');
    // a dated duration whose date the caller did not pass still says the span, never "until you stop it"
    expect(grantStateCopy({ ...BASE, duration: 'day', reads: 3 }, NOW).words).toBe('for a day · 3 reads');
    expect(grantStateCopy({ ...BASE, duration: 'week', reads: 3 }, NOW).words).toBe('for a week · 3 reads');
  });

  it('the status is the protocol’s own union — a view built from a parsed grant needs no cast', () => {
    const status: AccessGrantStatus = 'suspended';
    const view: GrantStateView = { ...BASE, status, suspendedReason: 'imported' };
    expect(grantStateCopy(view, NOW).words).toBe('paused — arrived with an imported file');
  });

  it('a source-changed pause without a table name still reads as a sentence', () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'source-changed' }, NOW).words).toBe("paused — Ledger's data changed");
  });

  it('a reader that kept timing out is paused, and may be allowed again', () => {
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'reader-misbehaved' }, NOW)).toEqual({
      words: "paused — Budget's reads kept taking too long",
      act: { kind: 'allow-again', label: 'allow again' },
    });
  });

  it('a stopped grant outranks its expiry; an expiry outranks a pause', () => {
    const later = new Date(2026, 9, 18, 9).getTime();
    expect(grantStateCopy({ ...BASE, status: 'revoked', revokedAt: at(9, 12, 9), expiresAt: at(9, 17) }, later).words).toBe('stopped Oct 12');
    expect(grantStateCopy({ ...BASE, status: 'suspended', suspendedReason: 'imported', expiresAt: at(9, 17) }, later).words).toBe('expired Oct 17');
  });

  it('GRANT_ACTS are the three act labels', () => {
    expect(GRANT_ACTS).toEqual({ stop: 'stop', 'allow-again': 'allow again', remove: 'remove' });
  });
});

// ---------------------------------------------------------------------------------------------
// The strip, the consent sheet, the access sheet, history, Settings, the app-facing messages
// ---------------------------------------------------------------------------------------------

describe('the strip and its outcome lines (AC18 copy)', () => {
  it('the strip names the reader and quotes its purpose under "says:"', () => {
    expect(STRIP.title('Budget')).toBe("Budget wants to read another app's data");
    expect(STRIP.says('Budget')).toBe('Budget says:');
    expect(STRIP.quote('to show spending by category')).toBe('“to show spending by category”');
    expect([STRIP.review, STRIP.notNow, STRIP.stopAsking]).toEqual(['review', 'not now', 'stop asking']);
  });

  it('one outcome line per act', () => {
    expect(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'session')).toBe("Budget can now read Ledger's transactions · while it's open");
    expect(STRIP_OUTCOME.allowed('Budget', 'Ledger', ['transactions'], 'week')).toBe("Budget can now read Ledger's transactions · for a week");
    expect(STRIP_OUTCOME.undo).toBe('stop');
    expect(STRIP_OUTCOME.notNow('Budget')).toBe('not now — Budget may ask again');
    expect(STRIP_OUTCOME.wontAskAgain('Budget')).toBe("Budget won't ask this again — allow it any time from Budget's access");
    expect(STRIP_OUTCOME.muted('Budget')).toBe("Budget won't ask again — change that in Settings");
  });
});

describe('the consent sheet', () => {
  it('section titles are lowercase and name the reader where they speak of it', () => {
    expect(CONSENT_SHEET.from).toBe('from');
    expect(CONSENT_SHEET.howLong).toBe('for how long');
    expect(CONSENT_SHEET.egressTitle('Budget')).toBe('where Budget can send what it reads');
    expect(CONSENT_SHEET.moreApps).toBe('more apps…');
    expect(CONSENT_SHEET.neverShared).toBe('never shared');
    expect(CONSENT_SHEET.moreColumns(3)).toBe('+3 more');
    expect(CONSENT_SHEET.notNow).toBe('not now');
    expect(CONSENT_SHEET.dontAllow).toBe("don't allow");
    expect(CONSENT_SHEET.away).toBe("also while I'm away");
    expect(CONSENT_SHEET.awayHint('Budget')).toBe('if Budget ever runs on a schedule');
    expect(CONSENT_SHEET.pickATable).toBe('choose at least one table');
  });

  it('the durations: the session option names the reader and says when it ends', () => {
    expect(durationOption('session', 'Budget')).toEqual({ label: 'while Budget is open', hint: 'ends when you close it' });
    expect(durationOption('day', 'Budget')).toEqual({ label: 'for a day' });
    expect(durationOption('week', 'Budget')).toEqual({ label: 'for a week' });
    expect(durationOption('always', 'Budget')).toEqual({ label: 'until I stop it' });
  });

  it('the primary button names the choice', () => {
    expect(allowLabel('session')).toBe("allow while it's open");
    expect(allowLabel('day')).toBe('allow for a day');
    expect(allowLabel('week')).toBe('allow for a week');
    expect(allowLabel('always')).toBe('allow until I stop it');
  });

  it('the excluded-apps footer is ONE sentence with each reason', () => {
    expect(
      excludedFooter([
        { displayName: 'Notes', reason: 'no-tables' },
        { displayName: 'Tasks', reason: 'no-tables' },
        { displayName: 'Diary', reason: 'no-tables' },
        { displayName: 'Telepath', reason: 'sidecar' },
      ]),
    ).toBe('3 apps have no data to read · Telepath keeps messages from others to itself');
    expect(
      excludedFooter([
        { displayName: 'Notes', reason: 'no-tables' },
        { displayName: 'Photos', reason: 'too-large' },
        { displayName: 'Movies', reason: 'too-large' },
        { displayName: 'Telepath', reason: 'sidecar' },
        { displayName: 'Chat', reason: 'sidecar' },
        { displayName: 'Budget', reason: 'reader' },
      ]),
    ).toBe(
      'Notes has no data to read · 2 apps are too large to read this way · Telepath and Chat keep messages from others to themselves · Budget itself is not offered',
    );
    expect(excludedFooter([{ displayName: 'Photos', reason: 'too-large' }])).toBe('Photos is too large to read this way');
    expect(excludedFooter([])).toBe('');
  });
});

describe('the strip and consent sheet keys W3b added after the freeze (CONSENT_UI, openUrlCarries)', () => {
  it('each sentence, byte for byte', () => {
    expect(CONSENT_UI.answerOtherFirst).toBe('answer the open question first, then review');
    expect(CONSENT_UI.stopped('Budget', 'Ledger', ['transactions'])).toBe("stopped — Budget no longer reads Ledger's transactions");
    expect(CONSENT_UI.stopped('Budget', 'Ledger', ['transactions', 'accounts'])).toBe("stopped — Budget no longer reads Ledger's transactions and accounts");
    expect(CONSENT_UI.failed('choose at least one table')).toBe('that did not work — choose at least one table');
    expect(CONSENT_UI.nothingAllowed).toBe('that did not work — nothing was allowed');
    expect(CONSENT_UI.tableRows('transactions', 412)).toBe('transactions · 412 rows');
    expect(CONSENT_UI.tableRows('accounts', 1)).toBe('accounts · 1 row');
    expect(CONSENT_UI.tableRows('empty', 0)).toBe('empty · no rows');
    expect(CONSENT_UI.columnsOf('transactions')).toBe('columns of transactions');
    expect(openUrlCarries(['Ledger'])).toBe('what it read from Ledger can travel in this link');
    expect(openUrlCarries(['Ledger', 'Pantry'])).toBe('what it read from Ledger and Pantry can travel in this link');
  });

  it("failedWords says the engine's OWN refusals of an allow, and one fixed sentence for anything else (a db or protocol message never reaches the user)", () => {
    for (const reason of [
      'the asking app is not in this file',
      'an app never needs access to itself',
      'the other app is not in this file',
      'that app keeps messages from others to itself',
      'choose at least one table',
      'the other app offers no table "transactions"',
      '"secrets" has nothing that can be read',
      'that app was not offered',
    ]) {
      expect(failedWords(reason)).toBe(CONSENT_UI.failed(reason));
    }
    for (const raw of [
      'the file already holds 100 live access grants',
      'the access history of "Ledger" holds nothing that may be pruned (200 entries / 65536 bytes)',
      'an access grant may not carry a credential',
      'choose at least one table — and also this',
      '',
    ]) {
      expect(failedWords(raw)).toBe(CONSENT_UI.nothingAllowed);
    }
  });
});

describe('the access sheet, history and the Settings card (AC19 copy)', () => {
  it('the run header icon and the sheet’s sections', () => {
    expect(ACCESS_SHEET.iconLabel).toBe('access');
    expect(ACCESS_SHEET.iconTitle).toBe('what this app can read, and who can read it');
    expect(ACCESS_SHEET.title('Budget')).toBe("Budget's access");
    expect(ACCESS_SHEET.reads('Budget')).toBe('Budget reads');
    expect(ACCESS_SHEET.readBy('Ledger')).toBe('what reads Ledger');
    expect(ACCESS_SHEET.row('Budget', 'Ledger', ['transactions'])).toBe("Budget has access to Ledger's transactions");
    expect(ACCESS_SHEET.history).toBe('history');
    expect(ACCESS_SHEET.historyImported).toBe('from an imported file');
    expect(ACCESS_SHEET.noHistory).toBe('nothing read yet');
    expect(ACCESS_SHEET.whatItAsked).toBe('what it asked');
    expect(ACCESS_SHEET.declinedAsks).toBe('declined asks');
    expect(ACCESS_SHEET.allowDeclined).toBe('allow…');
    expect(ACCESS_SHEET.create('Budget')).toBe('let Budget read another app…');
    // The purpose a USER-made access carries: the host's words, never a sentence put in the app's mouth.
    expect(ACCESS_SHEET.userPurpose('Budget')).toBe('you started this yourself — Budget did not ask');
    expect(ACCESS_SHEET.nothing('Budget')).toBe('Budget reads no other app, and no app reads Budget');
    // W3b key, added after the freeze: the ⋈ sheet's ✕.
    expect(ACCESS_SHEET.close).toBe('close');
  });

  it('history rows in words', () => {
    const base = { grantId: '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f', readerAppId: 'budget', readerName: 'Budget' };
    const twoMin = new Date(NOW - 2 * MIN).toISOString();
    expect(historyLine({ ...base, at: twoMin, kind: 'read', tables: ['transactions'], rows: 412, attended: true }, NOW)).toBe(
      'read transactions · 412 rows · 2 min ago · while you were here',
    );
    expect(historyLine({ ...base, at: twoMin, kind: 'read', tables: ['transactions'], rows: 412, attended: false }, NOW)).toBe(
      'read transactions · 412 rows · 2 min ago · while you were away',
    );
    expect(historyLine({ ...base, at: twoMin, kind: 'read', tables: ['transactions', 'accounts'], rows: 1, count: 3, attended: true }, NOW)).toBe(
      'read transactions and accounts · 1 row · 3 times · 2 min ago · while you were here',
    );
    expect(historyLine({ ...base, at: twoMin, kind: 'read', rows: 0 }, NOW)).toBe('read data · no rows · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'granted' }, NOW)).toBe('allowed · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'revoked' }, NOW)).toBe('stopped · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'expired' }, NOW)).toBe('ended · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'released' }, NOW)).toBe('gave up its access · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'refused' }, NOW)).toBe('a read while you were away was refused · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'reader-updated' }, NOW)).toBe('paused — it was updated · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'imported' }, NOW)).toBe('paused — arrived with an imported file · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'source-changed' }, NOW)).toBe('paused — the data changed · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'source-restricted' }, NOW)).toBe('paused — now holds messages from others · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'reader-misbehaved' }, NOW)).toBe('paused — its reads kept taking too long · 2 min ago');
    expect(historyLine({ ...base, at: twoMin, kind: 'suspended', reason: 'free text from somewhere' }, NOW)).toBe('paused · 2 min ago');
  });

  it('the user-made purpose is one a grant record accepts (single line, no controls, nothing credential-shaped)', () => {
    const purpose = ACCESS_SHEET.userPurpose('A name that is quite long for an app, but still a name');
    const record = {
      id: '6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
      readerAppId: 'budget',
      sourceAppId: 'ledger',
      scope: { tables: [{ name: 'transactions', columns: ['amount'] }] },
      access: 'read',
      purpose,
      duration: { kind: 'always' },
      unattended: false,
      status: 'active',
      provenance: 'user',
      readerVersion: 1,
      grantedAt: '2026-10-10T09:00:00.000Z',
      updatedAt: '2026-10-10T09:00:00.000Z',
      reads: 0,
      timeouts: 0,
    };
    expect(accessGrantSchema.safeParse(record).success).toBe(true);
  });

  it('the Settings card states the switch’s custody', () => {
    expect(SETTINGS_CARD.title).toBe('access between apps');
    expect(SETTINGS_CARD.intro).toBe("which of your apps can read another app's data — the app that was read keeps a history of every read");
    expect(SETTINGS_CARD.empty).toBe("no app can read another app's data yet");
    expect(SETTINGS_CARD.neverAsk).toBe("never let apps ask to read other apps' data");
    expect(SETTINGS_CARD.neverAskHint).toBe('kept in this browser only — it does not travel with your file');
    expect(SETTINGS_CARD.mutedTitle).toBe("apps that won't ask");
    expect(SETTINGS_CARD.unmute('Budget')).toBe('let Budget ask again');
    expect(SETTINGS_CARD.clearHistory).toBe('clear history');
    expect(SETTINGS_CARD.clearHistoryHint).toBe('when access was allowed, stopped or paused stays on record');
  });

  it('the Settings card’s clear-history confirm and the creation act’s app picker (W3b keys, added after the freeze)', () => {
    expect(SETTINGS_CARD.clearArm).toBe("clear every read from every app's history?");
    expect(SETTINGS_CARD.clearConfirm).toBe('clear');
    expect(SETTINGS_CARD.clearKeep).toBe('keep');
    expect(SETTINGS_CARD.cleared).toBe('history cleared');
    expect(SETTINGS_CARD.createPick).toBe('which app');
    expect(SETTINGS_CARD.create('Budget')).toBe('let Budget read another app…');
  });

  it('the update confirm names the access that will pause', () => {
    expect(updatePausesAccess('Budget', ['Ledger'])).toBe("Budget's access to Ledger will pause until you allow it again");
    expect(updatePausesAccess('Budget', ['Ledger', 'Pantry'])).toBe("Budget's access to Ledger and Pantry will pause until you allow it again");
  });

  it('the app-facing messages the handler sends, one per refusal', () => {
    expect(ACCESS_APP_MESSAGES).toEqual({
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
      tooLarge: "the other app's data is too large to share this way",
      tookTooLong: 'the read took too long',
      noWorker: 'this host cannot run cross-app reads',
      sourceChanged: "the other app's data changed — this access is paused until the person looks again",
      askRateLimited: 'asking too often — wait a few seconds',
      queryRateLimited: 'too many reads — wait a minute',
      hostError: 'access between apps is not available right now',
    });
  });
});

describe('the egress words (AC15)', () => {
  it('EGRESS is the sentence set egress.ts composes from', () => {
    expect(EGRESS.keyed('Claude', 'Anthropic')).toBe('its AI — Claude (Anthropic), with your key');
    expect(EGRESS.keyMissing('Claude')).toBe('its AI — Claude (key missing)');
    expect(EGRESS.demo).toBe('its AI — the demo brain, which answers here and sends nothing out');
    expect(EGRESS.webllm).toBe('its AI — a model running in this tab, on this device');
    expect(EGRESS.local('localhost:11434')).toBe('its AI — your own model at localhost:11434');
    expect(EGRESS.host('Claude Code on this Mac')).toBe('its AI — Claude Code on this Mac, the AI this host provides');
    expect(EGRESS.subscription).toBe('its AI — through your Snug hub');
    expect(EGRESS.approved('GitHub', 'api.github.com')).toBe('GitHub (api.github.com) — a connection you approved');
    expect(EGRESS.declared('SimpleFIN', 'beta-bridge.simplefin.org')).toBe('SimpleFIN (beta-bridge.simplefin.org) — declared, not connected yet');
    expect(EGRESS.helper).toBe('the WhatsApp helper on this Mac');
    expect(EGRESS.helperDeclared).toBe('the WhatsApp helper on this Mac — declared, not connected yet');
    expect(EGRESS.noConnections).toBe('no connections of its own');
    expect(EGRESS.openUrl).toBe('any link it asks you to open — you see the address first');
    expect(EGRESS.away).toBe('also while you’re away — on a schedule it can read and send with no one watching');
    expect(EGRESS.closing('Ledger')).toBe('the copy is made here, on this device; Ledger keeps a history of every read');
  });
});

// ---------------------------------------------------------------------------------------------
// The reader's provenance line (AC18 / D11) — derived from the library row, never the announce
// ---------------------------------------------------------------------------------------------

describe('provenance — the reader’s line the host derives (D11)', () => {
  it('readerProvenanceKind reads installSource: absent → built; share: / agent: / starter:', () => {
    expect(readerProvenanceKind({})).toBe('built');
    expect(readerProvenanceKind({ installSource: 'share:7e2d' })).toBe('share');
    expect(readerProvenanceKind({ installSource: 'agent:6f1c1d4e-2b3a-4c5d-8e9f-0a1b2c3d4e5f' })).toBe('agent');
    expect(readerProvenanceKind({ installSource: 'starter:weather' })).toBe('starter');
  });

  it('an installSource the host does not know is NEVER read as built here — it is not built by you', () => {
    expect(readerProvenanceKind({ installSource: 'market:x' })).toBe('share');
    expect(readerProvenanceKind({ installSource: '' })).toBe('share');
  });

  it('provenanceLine: the four lines', () => {
    const createdAt = new Date(2026, 9, 3, 12).toISOString();
    expect(provenanceLine({ createdAt, currentVersion: 12 }, { collides: false })).toBe('built here · v12');
    expect(provenanceLine({ installSource: 'share:7e2d', createdAt, currentVersion: 2 }, { collides: false, now: NOW })).toBe(
      'installed from a share link on 3 Oct · not built by you',
    );
    expect(provenanceLine({ installSource: 'agent:abc', createdAt, currentVersion: 4 }, { collides: false })).toBe('handed in by your agent');
    expect(provenanceLine({ installSource: 'starter:weather', createdAt, currentVersion: 1 }, { collides: false })).toBe('a starter from Snug');
  });

  it('a share install from another year carries the year', () => {
    const createdAt = new Date(2025, 11, 3, 12).toISOString();
    expect(provenanceLine({ installSource: 'share:7e2d', createdAt, currentVersion: 1 }, { collides: false, now: NOW })).toBe(
      'installed from a share link on 3 Dec 2025 · not built by you',
    );
  });

  it('a name collision is said', () => {
    const createdAt = new Date(2026, 9, 3, 12).toISOString();
    expect(provenanceLine({ createdAt, currentVersion: 12 }, { collides: true })).toBe('built here · v12 · another app has this name');
    expect(provenanceLine({ installSource: 'agent:abc', createdAt, currentVersion: 4 }, { collides: true })).toBe(
      'handed in by your agent · another app has this name',
    );
  });

  it('nameCollides: another app with the same name — case, spacing and width folded — but never the app itself', () => {
    const apps = [
      { appId: 'a', displayName: 'Ledger' },
      { appId: 'b', displayName: '  ledger ' },
      { appId: 'c', displayName: 'Budget' },
      { appId: 'd', displayName: 'Ｂｕｄｇｅｔ' },
      { appId: 'e', displayName: 'Pantry' },
    ];
    expect(nameCollides(apps, 'a')).toBe(true);
    expect(nameCollides(apps, 'b')).toBe(true);
    expect(nameCollides(apps, 'c')).toBe(true);
    expect(nameCollides(apps, 'd')).toBe(true);
    expect(nameCollides(apps, 'e')).toBe(false);
    expect(nameCollides(apps, 'missing')).toBe(false);
  });

  it('nameCollides: a look-alike twin — Cyrillic or Greek letters, combining marks, invisible format characters — collides; a different name does not', () => {
    const apps = [
      { appId: 'real', displayName: 'Ledger' },
      { appId: 'cyrillic', displayName: 'L\u0435dger' }, // Cyrillic е
      { appId: 'budget', displayName: 'Budget' },
      { appId: 'upper', displayName: '\u0412UDGET' }, // Cyrillic В
      { appId: 'pantry', displayName: 'Pantry' },
      { appId: 'marked', displayName: 'Pa\u0301ntry' }, // a + combining acute
      { appId: 'notes', displayName: 'Notes' },
      { appId: 'greek', displayName: 'N\u03bftes' }, // Greek ο
      { appId: 'diary', displayName: 'Diary' },
      { appId: 'hidden', displayName: 'Dia\u200dry' }, // zero-width joiner
      { appId: 'plural', displayName: 'Ledgers' },
    ];
    for (const id of ['real', 'cyrillic', 'budget', 'upper', 'pantry', 'marked', 'notes', 'greek', 'diary', 'hidden']) expect(nameCollides(apps, id), id).toBe(true);
    expect(nameCollides(apps, 'plural')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// THE VOCABULARY SCAN
// ---------------------------------------------------------------------------------------------

const ACCESS_DIR = path.resolve(__dirname, '..', 'access');

/** One piece of text a person could read: as it is reported, and the words the rule is applied to. */
interface Literal {
  /** The literal as reported — a template's source text between its backticks, substitutions included. */
  text: string;
  /** Only what a person reads: a template's LITERAL parts (a `${grant.id}` substitution is code, not copy). */
  words: string;
}

/** A string that names a module — `from './grants.js'`, `import('./x.js')`, `require`-style references — is a file name, not a sentence. */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
  if (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword && parent.arguments[0] === node) return true;
  if (ts.isExternalModuleReference(parent)) return true;
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent);
}

/**
 * Every piece of text in a source, by the TypeScript parser (comments are trivia, never seen):
 * string literals (JSX attribute strings included), template literals (nested ones too), and
 * JSX text nodes — module specifiers left out.
 */
function literalsIn(code: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): Literal[] {
  const source = ts.createSourceFile(kind === ts.ScriptKind.TSX ? 'scan.tsx' : 'scan.ts', code, ts.ScriptTarget.Latest, true, kind);
  const out: Literal[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) out.push({ text: node.text, words: node.text });
    } else if (ts.isTemplateExpression(node)) {
      const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
      out.push({ text: node.getText(source).slice(1, -1), words: parts.join(' \u2026 ') });
    } else if (ts.isJsxText(node)) {
      if (node.text.trim() !== '') out.push({ text: node.text.trim(), words: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Every string literal in a source, as reported (the share-word check below reads these). */
function stringLiterals(code: string, kind?: ts.ScriptKind): string[] {
  return literalsIn(code, kind).map((literal) => literal.text);
}

const INTERNAL_WORD = /\b(grant|reader|scope|log)s?\b/i;

/** Machine tokens a literal may BE in its entirety: enum members the protocol or the ranking defines. */
const MACHINE_TOKENS: ReadonlySet<string> = new Set([...ACCESS_SUSPEND_REASONS, ...EXCLUDED_REASONS].filter((token) => INTERNAL_WORD.test(token)));

function internalWordsIn(code: string, kind?: ts.ScriptKind): string[] {
  return literalsIn(code, kind)
    .filter((literal) => INTERNAL_WORD.test(literal.words) && !MACHINE_TOKENS.has(literal.text))
    .map((literal) => literal.text);
}

const scriptKindOf = (file: string): ts.ScriptKind => (file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Every .ts/.tsx file under access/, recursively; an absent directory is an empty list. */
function accessFiles(dir: string = ACCESS_DIR): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...accessFiles(full));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

const COPY_FILE = path.join(ACCESS_DIR, 'copy.ts');

function scanOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of accessFiles()) {
    if (file === COPY_FILE) continue;
    for (const text of internalWordsIn(readFileSync(file, 'utf8'), scriptKindOf(file))) offenders.push(`${path.relative(ACCESS_DIR, file)}: '${text}'`);
  }
  return offenders;
}

describe('vocabulary scan — no file under access/ but copy.ts spells grant, reader, scope or log in a string', () => {
  it('the scanner reads sentences, not identifiers: a planted sentence is caught, keys and codes are not', () => {
    expect(internalWordsIn(`const a = 'the reader may read';`)).toEqual(['the reader may read']);
    expect(internalWordsIn(`const a = "Grant access";`)).toEqual(['Grant access']);
    expect(internalWordsIn('const a = `${n} logs kept`;')).toEqual(['${n} logs kept']);
    expect(internalWordsIn(`const a = 'out of scope';`)).toEqual(['out of scope']);
    expect(internalWordsIn(`const a = 'reader updated';`)).toEqual(['reader updated']);
    expect(
      internalWordsIn(
        `const k = 'accessGrant:' + id; const c = 'ACCESS_NOT_GRANTED'; const g = row.grantId; const kind = 'granted'; const r = 'reader-updated'; const x = 'reader';`,
      ),
    ).toEqual([]);
    expect(internalWordsIn(`// the reader's grant is the internal word\nconst x = 'access';`)).toEqual([]);
    expect(internalWordsIn(`/* scope: the granted tables */ const y = "history";`)).toEqual([]);
  });

  it('a comment marker INSIDE a string never blinds the scan — the parser, not a regex, finds where a string ends', () => {
    expect(internalWordsIn(`const a = 'path // the reader keeps a log';`)).toEqual(['path // the reader keeps a log']);
    expect(internalWordsIn(`const a = 'glob /*'; const b = 'the reader'; const c = '*/';`)).toEqual(['the reader']);
    expect(internalWordsIn('const a = `http://x`; const b = "the scope";')).toEqual(['the scope']);
  });

  it('JSX text nodes and JSX attribute strings are sentences too (the UI lands under access/ as .tsx)', () => {
    expect(internalWordsIn(`export const A = () => <p>the reader may read</p>;`)).toEqual(['the reader may read']);
    expect(internalWordsIn(`export const A = () => <div className="grant-row" title="history" />;`)).toEqual(['grant-row']);
    expect(internalWordsIn(`export const A = () => <p>{name} keeps a history</p>;`)).toEqual([]);
  });

  it('a template is read by its literal parts, nested templates included — a substitution is code', () => {
    expect(internalWordsIn('const a = `outer ${`the reader ${x}`} end`;')).toEqual(['the reader ${x}']);
    expect(internalWordsIn('const a = `${grant.id} is open`;')).toEqual([]);
    expect(internalWordsIn('const a = `${n} — the log`;')).toEqual(['${n} — the log']);
  });

  it('a module specifier names a file, not a sentence — import, export-from, dynamic import and import types', () => {
    expect(
      internalWordsIn(
        `import { a } from './grants.js'; export { b } from './log.js'; import type { C } from './scope.js'; const m = import('./reader.js'); type T = typeof import('./grants.js');`,
        ts.ScriptKind.TS,
      ),
    ).toEqual([]);
    // …but the same words in a string that is NOT a specifier are still caught
    expect(internalWordsIn(`import { a } from './grants.js'; const s = './grants.js';`, ts.ScriptKind.TS)).toEqual(['./grants.js']);
  });

  it('the machine-token exemption is exactly the three enum members that spell a banned word', () => {
    expect([...MACHINE_TOKENS].sort()).toEqual(['reader', 'reader-misbehaved', 'reader-updated']);
  });

  it('the scan BITES on the real tree: a sentence planted in a scratch file under access/ turns it red, and deleting it turns it green', () => {
    const planted = path.join(ACCESS_DIR, `zz-vocabulary-probe-${process.pid}.ts`);
    expect(scanOffenders()).toEqual([]);
    writeFileSync(planted, "// probe — deleted by accessCopy.test.ts\nexport const PROBE = 'the reader keeps a log of every grant';\n");
    try {
      expect(scanOffenders()).toEqual([`${path.basename(planted)}: 'the reader keeps a log of every grant'`]);
    } finally {
      rmSync(planted, { force: true });
    }
    expect(existsSync(planted)).toBe(false);
    expect(scanOffenders()).toEqual([]);
  });

  it('the walk sees the access modules this stage ships', () => {
    const files = accessFiles().map((file) => path.relative(ACCESS_DIR, file));
    for (const name of ['copy.ts', 'egress.ts', 'provenance.ts', 'relevance.ts']) expect(files).toContain(name);
  });

  it('every scanned file outside copy.ts is clean', () => {
    expect(scanOffenders()).toEqual([]);
  });

  it('…and copy.ts itself spells none of the four in any of its sentences — the exemption is for its comments and enum keys', () => {
    expect(internalWordsIn(readFileSync(COPY_FILE, 'utf8'), ts.ScriptKind.TS)).toEqual([]);
  });

  it('the copy never calls this feature "share" in a user-facing sentence — except the one app-facing message AC12 pins verbatim', () => {
    const shareWord = /\bshar(e|ed|ing)\b/i;
    const literals = stringLiterals(readFileSync(COPY_FILE, 'utf8'), ts.ScriptKind.TS).filter((text) => shareWord.test(text));
    expect(literals.sort()).toEqual(["the other app's data is too large to share this way", 'installed from a share link on ${installedOn} · not built by you', 'never shared'].sort());
  });
});
