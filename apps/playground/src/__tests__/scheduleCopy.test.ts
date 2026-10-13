// scheduleCopy.test.ts — TASK-20261009-scheduling-framework C8 (ADR-0074 §5, §6; Q8): every
// user-facing sentence of the scheduling feature has ONE home, `schedule/copy.ts`, and each
// is pinned byte-for-byte here (pure functions; explicit `toBe`, never a snapshot — a snapshot
// would bless a drift it was meant to catch).
//
// THE VOCABULARY TEST (Q8, design F13). Internally the engine says task · run · proposal ·
// catch-up; a person reads *schedule* · *result* · *missed* · *suggestion* · *changes waiting
// for your OK*. The last block scans every source file under `schedule/` and every
// `views/Schedule*.tsx` for a string literal that spells the whole word "task" or "proposal",
// and refuses it anywhere but `copy.ts` — the one file where the words are decided.
//
// What the scan can and cannot see (TASK-20261010-host-broker PR-4, D-PR4-21 — the parse upgrade).
// It walks the TypeScript parser's tree through the shared helper `./literalsIn.ts` (the walker
// `accessCopy.test.ts` introduced): string literals, JSX attribute strings, template literals by
// their literal parts AND JSX text nodes (`<p>a task</p>`, which the old regex scan could not see)
// are sentences; comments are trivia; a module specifier is a file name; identifiers and keys are
// not sentences (`taskId`, `scheduleRuns:` and `'schedule:' + task.id` pass). It matches the whole
// word, case-insensitively, and does NOT police "run": "run" is the sanctioned APP VERB ("run
// Ledger", "run now", "runs while…"), and no parser can tell the verb from the noun — that gap is
// closed by the copy-review at Gate 5. It also refuses *routine* and *automation* (copy.ts:15-17).
// The scan covers `schedule/*`, `views/Schedule*.tsx`, `access/refresh.ts` and the chat card's
// words `agent/copy.dataWrite.ts` (AC32d), and proves it can fail before it is trusted.
//
// PR-4 also pins every sentence the contract gives byte for byte (D-PR4-18/20): the tick, the
// chooser's hints, the held reasons, the step words' tools tail, and the home of every fixed
// sentence the surfaces print.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SCHEDULE_HELD_REASONS, type ScheduleStep } from '@snugprotocol/protocol';

import {
  APP_UNREACHABLE_SUMMARY,
  AUTH_REPAIR_VIA_REFRESH,
  AUTH_REPAIR_VIA_SCHEDULE,
  CONSENT,
  DELEGATED_CONFIRM,
  EMPTY,
  MISSED_ACTIONS,
  REFRESH_RUN,
  RESULT_STATUS_WORD,
  RUNNING_CHIP,
  SCHEDULED_NEXT,
  SCHEDULE_CARD,
  STEP_STATUS_WORD,
  SUGGESTION_ACTIONS,
  SUGGESTION_OUTCOME,
  WORDS,
  aiCalls,
  alertLabel,
  alreadyRunning,
  alertSentence,
  appMissing,
  blockedHere,
  capped,
  ceilingWarning,
  closedAfterChange,
  chatOffer,
  costLine,
  followerTab,
  globalPaused,
  handedOverTwice,
  hostHonesty,
  imported,
  missedHeadline,
  missedPolicyLabel,
  missedPolicySentence,
  missedRow,
  needsYou,
  needsYouAlreadyAsked,
  needsYouDeclined,
  needsYouUnanswered,
  nextLine,
  noHandler,
  paused,
  runningProgress,
  stepLabel,
  stepWords,
  suggestionStrip,
} from '../schedule/copy.js';
import { ACTIONS, CHANGES_CONTROL, CONSENT_ROWS, STEPS } from '../schedule/copy.editor.js';
import { CHANGES_LINK, HELD_WHY, MADE, needsYouTitle } from '../schedule/copy.result.js';
import { PAUSE_AFTER_FAILURES, PAUSE_AFTER_UNSEEN } from '../schedule/protection.js';
import { literalsIn, scriptKindOf } from './literalsIn.js';

describe('vocabulary (Q8) — the five nouns and the three step kinds', () => {
  it('WORDS is the user-facing vocabulary, nothing internal', () => {
    expect(WORDS).toEqual({
      item: 'schedule',
      items: 'schedules',
      result: 'result',
      results: 'results',
      missed: 'missed',
      suggestion: 'suggestion',
      changesWaiting: 'changes waiting for your OK',
      // AMENDED by D-PR4-18 (TASK-20261010-host-broker PR-4): the result page's first section, *changes it made*.
      changesMade: 'changes it made',
    });
  });

  it('stepLabel names the three kinds with the app, lowercase-leading like every other label', () => {
    expect(stepLabel('notify')).toBe('remind me');
    expect(stepLabel('app-run', 'Ledger')).toBe('run Ledger');
    expect(stepLabel('app-think', 'Ledger')).toBe('ask Ledger’s AI');
  });

  it('stepLabel without an app name (a step whose app was deleted) still reads as a sentence', () => {
    expect(stepLabel('app-run')).toBe('run this app');
    expect(stepLabel('app-think')).toBe('ask this app’s AI');
    expect(stepLabel('notify', 'Ledger')).toBe('remind me');
  });

  it('stepWords: ONE step in words — the label, then the step’s own words; a run step’s input only where asked for (M6)', () => {
    expect(stepWords({ kind: 'notify', title: 'Water', body: 'the ferns' })).toBe('remind me: Water — the ferns');
    expect(stepWords({ kind: 'app-think', appId: 'x', prompt: 'Sum it', context: { maxRows: 5 } }, 'Ledger')).toBe('ask Ledger’s AI: Sum it');
    expect(stepWords({ kind: 'app-run', appId: 'x' }, 'Weather')).toBe('run Weather');
    expect(stepWords({ kind: 'app-run', appId: 'x', input: { fetch: true } }, 'Weather')).toBe('run Weather');
    expect(stepWords({ kind: 'app-run', appId: 'x', input: { fetch: true } }, 'Weather', { withInput: true })).toBe('run Weather · {"fetch":true}');
    expect(stepWords({ kind: 'app-run', appId: 'x' }, undefined, { withInput: true })).toBe('run this app');
  });

  it('aiCalls is the ONE pluraliser (M12): none, one, many', () => {
    expect(aiCalls(0)).toBe('no AI calls');
    expect(aiCalls(1)).toBe('1 AI call');
    expect(aiCalls(2)).toBe('2 AI calls');
    expect(aiCalls(100)).toBe('100 AI calls');
  });
});

describe('status words (M5) — the one table every surface prints', () => {
  it('RESULT_STATUS_WORD: a word per run status, never colour alone', () => {
    expect(RESULT_STATUS_WORD).toEqual({
      pending: 'missed',
      running: 'running',
      ok: 'done',
      failed: 'failed',
      skipped: 'skipped',
      'needs-you': 'needs you',
      interrupted: 'interrupted',
      capped: 'capped',
      'no-handler': 'not supported',
    });
  });

  it('STEP_STATUS_WORD: a word per step status, the same words where the statuses meet', () => {
    expect(STEP_STATUS_WORD).toEqual({ ok: 'done', failed: 'failed', blocked: 'blocked', refused: 'refused', 'no-handler': 'not supported', skipped: 'skipped' });
    expect(STEP_STATUS_WORD.ok).toBe(RESULT_STATUS_WORD.ok);
    expect(STEP_STATUS_WORD['no-handler']).toBe(RESULT_STATUS_WORD['no-handler']);
  });
});

describe('hostHonesty — what THIS host can do, in words (ADR-0074 §5, E9)', () => {
  it('web: runs while this tab is open', () => {
    expect(hostHonesty({ kind: 'web' })).toBe('runs while this tab is open');
  });

  it('desktop: runs while Snug for Mac is open', () => {
    expect(hostHonesty({ kind: 'desktop' })).toBe('runs while Snug for Mac is open');
    expect(hostHonesty({ kind: 'desktop', hostLabel: 'Snug for Mac', wakeMode: 'page' })).toBe('runs while Snug for Mac is open');
  });

  it('host (an artifact): runs while this artifact is open; on the memory rung it says the page keeps nothing', () => {
    expect(hostHonesty({ kind: 'host' })).toBe('runs while this artifact is open');
    expect(hostHonesty({ kind: 'host', storageRung: 'durable' })).toBe('runs while this artifact is open');
    expect(hostHonesty({ kind: 'host', storageRung: 'memory' })).toBe(
      'runs while this artifact is open — this page keeps nothing after it closes',
    );
  });

  it('the seat’s hostLabel is the subject — a host names itself, the kind only supplies the default', () => {
    expect(hostHonesty({ kind: 'host', hostLabel: 'this page' })).toBe('runs while this page is open');
    expect(hostHonesty({ kind: 'web', hostLabel: 'this window' })).toBe('runs while this window is open');
  });

  it('when sibling tabs cannot be seen (no locks — an opaque origin, file://) the sentence says so; `true` and absent say nothing', () => {
    expect(hostHonesty({ kind: 'host', canSeeSiblingTabs: false })).toBe(
      'runs while this artifact is open · other tabs can’t be seen from here',
    );
    expect(hostHonesty({ kind: 'host', storageRung: 'memory', canSeeSiblingTabs: false })).toBe(
      'runs while this artifact is open — this page keeps nothing after it closes · other tabs can’t be seen from here',
    );
    expect(hostHonesty({ kind: 'web', canSeeSiblingTabs: true })).toBe('runs while this tab is open');
  });

  it('background wake (deferred — ADR-0074 §8) has its own sentence so a later shell cannot inherit the page one', () => {
    expect(hostHonesty({ kind: 'desktop', wakeMode: 'background' })).toBe('runs in the background while Snug for Mac is running');
  });

  it('nextLine: the next occurrence, with the honesty tail', () => {
    expect(nextLine('tomorrow at 8:00 AM')).toBe('tomorrow at 8:00 AM — if Snug is open; otherwise it will ask when you return');
  });
});

describe('policies — the missed-run choice and the alert choice', () => {
  it('missedPolicyLabel names the three policies', () => {
    expect(missedPolicyLabel('ask')).toBe('ask me');
    expect(missedPolicyLabel('run-once')).toBe('run once when it opens');
    expect(missedPolicyLabel('skip')).toBe('skip');
    expect(missedPolicySentence).toBe('if Snug was closed at the time:');
  });

  it('alertLabel names the two alerts', () => {
    expect(alertLabel('inbox')).toBe('in Snug');
    expect(alertLabel('notification')).toBe('with a notification');
    expect(alertSentence).toBe('tell me:');
  });
});

describe('states — each with its ONE action (design F14)', () => {
  it('needs-you: the refusing gate said no; the one act opens the app visibly', () => {
    expect(needsYou('Ledger', 'post to Notion')).toEqual({
      text: 'Ledger needs your OK — Snug doesn’t post to Notion while you’re away',
      action: 'run now and review',
    });
  });

  it('no-handler: the app has no schedule hook yet; the one act opens it', () => {
    expect(noHandler('Ledger')).toEqual({ text: 'Ledger doesn’t know how to run on a schedule yet', action: 'open Ledger' });
  });

  it('blocked here: names the reason and offers no act (there is none on this host)', () => {
    expect(blockedHere('it needs your home network')).toEqual({ text: 'not available in this host — it needs your home network' });
    expect('action' in blockedHere('x')).toBe(false);
  });

  it('app missing: the step’s app was deleted; the one act removes the step', () => {
    expect(appMissing).toEqual({ text: 'this app was deleted', action: 'remove step' });
  });

  it('paused: the three reasons (E7, E8), each with resume as the one act', () => {
    expect(paused('failures')).toEqual({ text: 'paused: 5 failures in a row', action: 'resume' });
    expect(paused('ignored')).toEqual({ text: 'paused: nobody opened 30 results', action: 'resume' });
    expect(paused('app-updated')).toEqual({ text: 'paused: this app was updated', action: 'resume' });
  });

  it('paused: the default counts are the engine’s own thresholds (M13: protection.ts, never restated)', () => {
    expect(paused('failures').text).toBe(`paused: ${PAUSE_AFTER_FAILURES} failures in a row`);
    expect(paused('ignored').text).toBe(`paused: nobody opened ${PAUSE_AFTER_UNSEEN} results`);
  });

  it('paused: the engine may pass the count it actually used', () => {
    expect(paused('failures', 3).text).toBe('paused: 3 failures in a row');
    expect(paused('ignored', 12).text).toBe('paused: nobody opened 12 results');
    expect(paused('app-updated', 7).text).toBe('paused: this app was updated');
  });

  it('capped: the daily ceiling, named', () => {
    expect(capped('AI call')).toBe('daily AI call limit reached — resumes tomorrow');
    expect(capped('network call')).toBe('daily network call limit reached — resumes tomorrow');
  });

  it('imported: arrived disabled with a foreign file; the one act is review', () => {
    expect(imported).toEqual({ text: 'arrived with an imported file — review before turning on', action: 'review' });
  });

  it('the follower tab and the global pause', () => {
    expect(followerTab).toBe('scheduling runs in another tab');
    expect(globalPaused).toBe('all schedules are paused');
  });
});

describe('the missed card (E4; design F5)', () => {
  it('missedHeadline: plural and singular, with the AI-call tail only when there is one', () => {
    expect(missedHeadline(3, 2)).toBe('3 schedules were missed while Snug was closed · 2 AI calls');
    expect(missedHeadline(1, 1)).toBe('1 schedule was missed while Snug was closed · 1 AI call');
    expect(missedHeadline(3, 0)).toBe('3 schedules were missed while Snug was closed');
    expect(missedHeadline(1, 0)).toBe('1 schedule was missed while Snug was closed');
  });

  it('missedRow: a collapsed candidate says how many times and that it runs once; a single miss says once', () => {
    expect(missedRow('every weekday at 8:00 AM', 4)).toBe('every weekday at 8:00 AM · missed 4 times → runs once');
    expect(missedRow('every weekday at 8:00 AM', 2)).toBe('every weekday at 8:00 AM · missed 2 times → runs once');
    expect(missedRow('every weekday at 8:00 AM', 1)).toBe('every weekday at 8:00 AM · missed once');
    expect(missedRow('tomorrow at 9:00 AM', 0)).toBe('tomorrow at 9:00 AM · missed once');
  });

  it('MISSED_ACTIONS: the card’s acts and the row’s acts', () => {
    expect(MISSED_ACTIONS).toEqual({ runAll: 'run them', skipAll: 'skip', details: 'details', run: 'run now', skip: 'skip', undo: 'undo', cancel: 'cancel' });
  });

  it('runningProgress counts the queue', () => {
    expect(runningProgress(2, 4)).toBe('running 2 of 4…');
    expect(runningProgress(1, 1)).toBe('running 1 of 1…');
  });
});

describe('cost (design F8) — what a schedule spends and where the rows go', () => {
  it('costLine: calls a week on the brain, and the privacy half only when rows are sent', () => {
    expect(costLine({ perWeek: 7, brainLabel: 'Claude', appName: 'Ledger', sendsRows: true })).toBe(
      '≈ 7 AI calls a week on Claude · sends rows from Ledger to that provider',
    );
    expect(costLine({ perWeek: 7, brainLabel: 'Claude', appName: 'Ledger', sendsRows: false })).toBe('≈ 7 AI calls a week on Claude');
    expect(costLine({ perWeek: 1, brainLabel: 'Claude', appName: 'Ledger', sendsRows: false })).toBe('≈ 1 AI call a week on Claude');
  });

  it('costLine: a reminder-only schedule spends nothing, and says so instead of "0 calls"', () => {
    expect(costLine({ perWeek: 0, brainLabel: 'Claude', appName: 'Ledger', sendsRows: false })).toBe('no AI calls');
  });

  it('ceilingWarning names the ceiling this schedule would hit (E7, 80 %)', () => {
    expect(ceilingWarning('AI call')).toBe('this would hit the daily AI call limit — runs will be capped');
  });
});

describe('consent (security F10) — one surface that shows what will run', () => {
  it('CONSENT: the heading, the five rows, the two acts', () => {
    expect(CONSENT).toEqual({
      heading: 'what will run',
      prompt: 'prompt',
      queries: 'queries',
      input: 'input',
      hosts: 'may call',
      cost: 'daily cost',
      enable: 'schedule it',
      notNow: 'not now',
    });
  });
});

describe('suggestions (ADR-0074 §4) — the run-header strip, never a modal', () => {
  it('suggestionStrip names the app and what it suggests', () => {
    expect(suggestionStrip('Weather', 'every day at 7:00 AM')).toBe('Weather suggests: every day at 7:00 AM');
  });

  it('SUGGESTION_ACTIONS: accept, decline, mute — and accept reads the same as the consent act', () => {
    expect(SUGGESTION_ACTIONS).toEqual({ accept: 'schedule it', decline: 'not now', mute: 'stop suggestions from this app' });
    expect(SUGGESTION_ACTIONS.accept).toBe(CONSENT.enable);
    expect(SUGGESTION_ACTIONS.decline).toBe(CONSENT.notNow);
  });

  it('SUGGESTION_OUTCOME: the strip after its one act (PR-B P3)', () => {
    expect(SUGGESTION_OUTCOME.scheduled('Sat, Oct 10, 7:00 AM UTC')).toBe('scheduled — next Sat, Oct 10, 7:00 AM UTC');
    expect(SUGGESTION_OUTCOME.declined).toBe('not now — nothing was scheduled');
    expect(SUGGESTION_OUTCOME.muted('Weather')).toBe('Weather won’t suggest schedules again — change that in Settings');
    expect(SUGGESTION_OUTCOME.open).toBe('open');
  });
});

describe('the schedule card (ADR-0074 §4) — the builder’s and the chat lane’s suggestion (PR-B P1)', () => {
  it('SCHEDULE_CARD: the provenance line, the acts (the consent surface’s), the states', () => {
    expect(SCHEDULE_CARD.lead).toBe('the agent suggests a schedule:');
    expect(SCHEDULE_CARD.next('Sat, Oct 10, 8:00 AM UTC')).toBe('next Sat, Oct 10, 8:00 AM UTC');
    expect(SCHEDULE_CARD.noNext).toBe('no next time within 400 days');
    expect(SCHEDULE_CARD.accept).toBe(CONSENT.enable);
    expect(SCHEDULE_CARD.decline).toBe(CONSENT.notNow);
    expect(SCHEDULE_CARD.edit).toBe('edit…');
    expect(SCHEDULE_CARD.open).toBe('open');
    expect(SCHEDULE_CARD.scheduled('Sat, Oct 10, 8:00 AM UTC')).toBe('scheduled — next Sat, Oct 10, 8:00 AM UTC');
    expect(SCHEDULE_CARD.declined).toBe('not now — nothing was scheduled');
    expect(SCHEDULE_CARD.stale).toBe('this suggestion is out of date — the app is gone or the time has passed');
  });
});

describe('SCHEDULED_NEXT (M7) — the one sentence every suggestion surface ends on', () => {
  it('pins the three arms', () => {
    expect(SCHEDULED_NEXT.scheduled('Sat, Oct 10, 8:00 AM UTC')).toBe('scheduled — next Sat, Oct 10, 8:00 AM UTC');
    expect(SCHEDULED_NEXT.declined).toBe('not now — nothing was scheduled');
    expect(SCHEDULED_NEXT.open).toBe('open');
  });

  it('the card, the strip and the sheet REFERENCE it — the same function and strings, never a restatement', () => {
    expect(SCHEDULE_CARD.scheduled).toBe(SCHEDULED_NEXT.scheduled);
    expect(SCHEDULE_CARD.declined).toBe(SCHEDULED_NEXT.declined);
    expect(SCHEDULE_CARD.open).toBe(SCHEDULED_NEXT.open);
    expect(SUGGESTION_OUTCOME.scheduled).toBe(SCHEDULED_NEXT.scheduled);
    expect(SUGGESTION_OUTCOME.declined).toBe(SCHEDULED_NEXT.declined);
    expect(SUGGESTION_OUTCOME.open).toBe(SCHEDULED_NEXT.open);
    expect(ACTIONS.scheduled).toBe(SCHEDULED_NEXT.scheduled);
  });

  it('no surface copy module spells the sentence itself', () => {
    for (const name of ['copy.page.ts', 'copy.editor.ts', 'copy.result.ts']) {
      const code = stripComments(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', name), 'utf8'));
      expect(code, `${name} restates "scheduled — next"`).not.toContain('scheduled — next');
      expect(code, `${name} restates the declined line`).not.toContain('nothing was scheduled');
    }
  });
});

describe('the chat offer (E10) — deterministic, dismissible, one act', () => {
  it('chatOffer quotes the phrase and offers review', () => {
    expect(chatOffer('every weekday at 8')).toEqual({ text: 'looks like a schedule: every weekday at 8', action: 'review' });
  });
});

describe('empty states and the running chip', () => {
  it('EMPTY: the page and the create bar’s placeholder', () => {
    expect(EMPTY).toEqual({
      page: 'nothing scheduled yet — describe what and when, or start from a template',
      createPlaceholder: 'describe what and when — every weekday at 8, summarise my ledger',
    });
  });

  it('RUNNING_CHIP: the label and its one act (security F15) — and, since TASK-20261010-host-broker PR-1, where a delegated run is running — and, since PR-3 (D-PR3-19), what a refresh another app asked for is fetching', () => {
    // v2.2 note (b): PR-5 (D-PR5-17) adds the fetch chip's label and its two acts — widened, not weakened.
    expect(RUNNING_CHIP).toEqual({
      label: 'a schedule is running',
      cancel: 'cancel',
      inApp: expect.any(Function),
      fetching: expect.any(Function),
      fetchingIn: expect.any(Function),
      cancelFetch: expect.any(Function),
      stopWaiting: 'stop waiting',
      stopWaitingFor: expect.any(Function),
      moreFetchesShort: expect.any(Function),
      moreFetches: expect.any(Function),
    });
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-1 — the delegated run's sentences (ADR-0077 §3–§5; contract v2
// "schedule/copy.ts" block). Single-homed here like every other: the dialog's host-composed
// title and body, the three *needs you* sentences that say WHETHER the user declined, nobody
// answered, or the app asked again; the two handover failures; the chip's *running in <app>*;
// the reconnect chip's attribution. "run" stays a verb; "task"/"proposal" never appear (the
// scan below covers these, as it covers every file under `schedule/`).
//
// Two layers: (1) each export exists and its sentence carries every DYNAMIC part it was handed
// — the property the surfaces rely on; (2) the byte-for-byte pins of the contract's text, so a
// rewording is a visible decision rather than a drift.
// ---------------------------------------------------------------------------------------------

describe('the delegated run (TASK-20261010-host-broker PR-1) — exports and their dynamic parts', () => {
  it('DELEGATED_CONFIRM: a host title, a body that quotes the schedule and names app/method/host, an after-run body, two acts', () => {
    expect(typeof DELEGATED_CONFIRM.title).toBe('string');
    const body = DELEGATED_CONFIRM.body('Morning post', 'Notes', 'POST', 'api.example.com');
    for (const part of ['Morning post', 'Notes', 'POST', 'api.example.com']) expect(body).toContain(part);
    const after = DELEGATED_CONFIRM.afterRunBody('Notes', 'DELETE', 'api.example.com');
    for (const part of ['Notes', 'DELETE', 'api.example.com']) expect(after).toContain(part);
    expect(typeof DELEGATED_CONFIRM.allow).toBe('string');
    expect(typeof DELEGATED_CONFIRM.deny).toBe('string');
    expect(DELEGATED_CONFIRM.allow).not.toBe(DELEGATED_CONFIRM.deny);
  });

  it('the dialog title is the HOST’s sentence — it never carries the schedule’s own title', () => {
    expect(DELEGATED_CONFIRM.title).not.toContain('Morning post');
    expect(DELEGATED_CONFIRM.body('Morning post', 'Notes', 'POST', 'api.example.com')).not.toBe(DELEGATED_CONFIRM.title);
  });

  it('the three *needs you* sentences carry the app and what it tried, and one act: review', () => {
    for (const sentence of [needsYouDeclined, needsYouUnanswered, needsYouAlreadyAsked]) {
      const copy = sentence('Ledger', 'post to api.github.com');
      expect(copy.text).toContain('Ledger');
      expect(copy.text).toContain('post to api.github.com');
      expect(copy.action).toBe(needsYou('Ledger', 'post to api.github.com').action);
    }
    // Three DIFFERENT sentences — the point is to say which of the three happened.
    const texts = new Set([needsYouDeclined, needsYouUnanswered, needsYouAlreadyAsked].map((f) => f('Ledger', 'post').text));
    expect(texts.size).toBe(3);
  });

  it('the two handover failures name the app (and, after a change was sent, the host to check)', () => {
    expect(handedOverTwice('Ledger')).toContain('Ledger');
    const closed = closedAfterChange('Ledger', 'api.github.com');
    expect(closed).toContain('Ledger');
    expect(closed).toContain('api.github.com');
  });

  it('RUNNING_CHIP.inApp names the app; AUTH_REPAIR_VIA_SCHEDULE is a short attribution line', () => {
    expect(RUNNING_CHIP.inApp('Weather')).toContain('Weather');
    expect(typeof AUTH_REPAIR_VIA_SCHEDULE).toBe('string');
    expect(AUTH_REPAIR_VIA_SCHEDULE.length).toBeGreaterThan(0);
  });

  it('copy.result.ts: the needs-you card title names the app (`needsYouTitle`)', () => {
    expect(needsYouTitle('Ledger')).toContain('Ledger');
  });

  it('none of the new sentences spells "task" or "proposal"', () => {
    const sentences = [
      DELEGATED_CONFIRM.title,
      DELEGATED_CONFIRM.body('T', 'A', 'POST', 'h'),
      DELEGATED_CONFIRM.afterRunBody('A', 'POST', 'h'),
      DELEGATED_CONFIRM.allow,
      DELEGATED_CONFIRM.deny,
      needsYouDeclined('A', 'v').text,
      needsYouUnanswered('A', 'v').text,
      needsYouAlreadyAsked('A', 'v').text,
      handedOverTwice('A'),
      closedAfterChange('A', 'h'),
      RUNNING_CHIP.inApp('A'),
      AUTH_REPAIR_VIA_SCHEDULE,
      needsYouTitle('A'),
    ];
    expect(sentences.filter((text) => /\b(task|proposal)s?\b/i.test(text))).toEqual([]);
  });
});

describe('the delegated run — the contract’s text, byte for byte', () => {
  // Gate-5 fold F-5: the app name is DELIMITED — `“<appName>”`, like the schedule's title — in both bodies.
  it('DELEGATED_CONFIRM', () => {
    expect(DELEGATED_CONFIRM.title).toBe('a schedule wants to make a change');
    expect(DELEGATED_CONFIRM.body('Morning post', 'Notes', 'POST', 'api.example.com')).toBe(
      '“Morning post” is running “Notes” and wants to send a POST request to api.example.com. You didn’t click this — allow it once, or don’t. Nothing is remembered; no answer in a minute means nothing is sent.',
    );
    expect(DELEGATED_CONFIRM.afterRunBody('Notes', 'POST', 'api.example.com')).toBe(
      '“Notes” ran a schedule here earlier, so Snug asks every time: it wants to send a POST request to api.example.com. Allow it once, or don’t — nothing is remembered until you reopen the app.',
    );
    expect(DELEGATED_CONFIRM.allow).toBe('allow once');
    expect(DELEGATED_CONFIRM.deny).toBe('don’t send');
  });

  it('the three *needs you* sentences', () => {
    expect(needsYouDeclined('Ledger', 'post to api.github.com')).toEqual({
      text: 'you said don’t send — Ledger didn’t post to api.github.com',
      action: 'run now and review',
    });
    expect(needsYouUnanswered('Ledger', 'post to api.github.com')).toEqual({
      text: 'Ledger asked to post to api.github.com and nobody answered in a minute — nothing was sent',
      action: 'run now and review',
    });
    expect(needsYouAlreadyAsked('Ledger', 'post to api.github.com')).toEqual({
      text: 'Ledger tried to post to api.github.com again after you answered — nothing more was sent',
      action: 'run now and review',
    });
  });

  it('the handover failures, the chip and the reconnect attribution', () => {
    expect(handedOverTwice('Ledger')).toBe('Ledger opened and closed twice while this ran — nothing was recorded');
    expect(closedAfterChange('Ledger', 'api.github.com')).toBe('Ledger was closed after a change was sent to api.github.com — check there before running again');
    expect(RUNNING_CHIP.inApp('Weather')).toBe('running in Weather');
    expect(AUTH_REPAIR_VIA_SCHEDULE).toBe('a schedule ran into this');
    expect(needsYouTitle('Ledger')).toBe('Ledger needs your OK');
  });
});

// TASK-20261010-host-broker PR-1, Gate-5 fold F-11: two sentences that were literals in the code
// move HERE — `runPlacement.ts`'s refusal of a second run and `appRun.ts`'s unreachable live frame.
// Pinned byte for byte, free of the internal words, and no longer spelled in the two modules.
describe('the delegated run — the two sentences folded into copy.ts (Gate-5 fold F-11)', () => {
  it('`alreadyRunning(appName)` and `APP_UNREACHABLE_SUMMARY`: their text, no "task"/"proposal", and single-homed (the old literals are gone from `runPlacement.ts` and `appRun.ts`)', () => {
    expect(alreadyRunning('Weather')).toBe('Weather is already running another schedule');
    expect(alreadyRunning('Ledger')).toContain('Ledger');
    expect(APP_UNREACHABLE_SUMMARY).toBe('the open app could not be reached');
    expect([alreadyRunning('A'), APP_UNREACHABLE_SUMMARY].filter((text) => /\b(task|proposal)s?\b/i.test(text))).toEqual([]);
    const code = (file: string): string => stripComments(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', file), 'utf8'));
    expect(stringLiterals(code('runPlacement.ts')).filter((text) => text.includes('is already running another schedule'))).toEqual([]);
    expect(stringLiterals(code('appRun.ts')).filter((text) => text.includes('could not be reached'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-3 — the refresh's sentences (contract v2 D-PR3-17, D-PR3-19;
// DS8, DS20). A refresh another app asked for runs the SOURCE's own code: the running chip says
// what it is fetching and who asked (`RUNNING_CHIP.fetching(sourceName)` as the label,
// `REFRESH_RUN.title(requestedBy)` as the title — also the delegated record's `title`), and the
// reconnect chip attributes a 401 the refresh hit (`AUTH_REPAIR_VIA_REFRESH`). Single-homed here
// like every other sentence; "run" stays a verb; "task"/"proposal" never appear. Two layers, as for
// the delegated run: the dynamic parts, then the contract's text byte for byte.
// ---------------------------------------------------------------------------------------------

describe('the refresh another app asked for (TASK-20261010-host-broker PR-3) — exports and their dynamic parts', () => {
  it('REFRESH_RUN.title names who asked; RUNNING_CHIP.fetching names the app that fetches; AUTH_REPAIR_VIA_REFRESH is a short attribution line', () => {
    expect(REFRESH_RUN.title('Budget')).toContain('Budget');
    expect(RUNNING_CHIP.fetching('Ledger')).toContain('Ledger');
    expect(typeof AUTH_REPAIR_VIA_REFRESH).toBe('string');
    expect(AUTH_REPAIR_VIA_REFRESH.length).toBeGreaterThan(0);
  });

  it('the refresh attribution is NOT the schedule one — the chip says which kind of run hit the connection', () => {
    expect(AUTH_REPAIR_VIA_REFRESH).not.toBe(AUTH_REPAIR_VIA_SCHEDULE);
    expect(RUNNING_CHIP.fetching('Ledger')).not.toBe(RUNNING_CHIP.inApp('Ledger'));
  });

  it('none of the new sentences spells "task" or "proposal"', () => {
    const sentences = [REFRESH_RUN.title('A'), RUNNING_CHIP.fetching('A'), AUTH_REPAIR_VIA_REFRESH];
    expect(sentences.filter((text) => /\b(task|proposal)s?\b/i.test(text))).toEqual([]);
  });
});

describe('the refresh — the contract’s text, byte for byte (D-PR3-19)', () => {
  it('REFRESH_RUN.title, RUNNING_CHIP.fetching and AUTH_REPAIR_VIA_REFRESH', () => {
    expect(REFRESH_RUN.title('Budget')).toBe('Budget asked');
    expect(RUNNING_CHIP.fetching('Ledger')).toBe('fetching new data in Ledger');
    expect(AUTH_REPAIR_VIA_REFRESH).toBe('a fetch another app asked for ran into this');
  });
});

// ---------------------------------------------------------------------------------------------
// THE VOCABULARY SCAN — on the TypeScript-compiler walker (TASK-20261010-host-broker PR-4, D-PR4-21)
// ---------------------------------------------------------------------------------------------
//
// The regex scan this block replaced could not see JSX text (`<p>a task</p>` is not a string
// literal). It now walks the parser's tree through the ONE shared helper `./literalsIn.ts` (the
// walker `accessCopy.test.ts` introduced): string literals, JSX attribute strings, template
// literals by their literal parts, and JSX text nodes are all sentences; comments are trivia and a
// module specifier is a file name. A literal that IS, in its entirety, a pinned machine token is an
// enum member, not a sentence — the exemption list is pinned below, so a new one is a deliberate
// edit here. Existing JSX text that trips the scan is reported by the test lane and fixed in copy,
// never exempted.

const PLAYGROUND_SRC = path.resolve(__dirname, '..');

/** Source text with `//` and block comments blanked — for the code-shape checks below (the scan itself parses). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every string literal in a source, as reported — by the parser, the scan's own walker. */
function stringLiterals(code: string, kind: ts.ScriptKind = ts.ScriptKind.TS): string[] {
  return literalsIn(code, kind).map((literal) => literal.text);
}

const INTERNAL_WORD = /\b(task|proposal)s?\b/i;
/** copy.ts:15-17 — "routine" and "automation" read as someone else's product (Q8). */
const FOREIGN_WORD = /\b(routine|automation)s?\b/i;

/**
 * Machine tokens a literal may BE in its entirety (an enum member or a storage key the engine
 * defines, never a sentence). Pinned: a new entry is a deliberate edit here, never a quiet one.
 */
const MACHINE_TOKENS: ReadonlySet<string> = new Set<string>([]);

/** The internal words, spelled as a WHOLE word in a piece of text a person could read — `taskId` and `'schedule:' + id` pass. */
function internalWordsIn(code: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): string[] {
  return literalsIn(code, kind)
    .filter((literal) => INTERNAL_WORD.test(literal.words) && !MACHINE_TOKENS.has(literal.text))
    .map((literal) => literal.text);
}

function foreignWordsIn(code: string, kind: ts.ScriptKind = ts.ScriptKind.TSX): string[] {
  return literalsIn(code, kind)
    .filter((literal) => FOREIGN_WORD.test(literal.words))
    .map((literal) => literal.text);
}

/** The single files beyond the two globs that the scan covers (PR-3's refresh engine; PR-4's chat-card words, D-PR4-19). */
const EXTRA_FILES = [path.join('access', 'refresh.ts'), path.join('agent', 'copy.dataWrite.ts')] as const;

/** The modules PR-4 adds under schedule/ (the contract's module list) — scanned by the `schedule/*` glob like every other. */
const PR4_SCHEDULE_MODULES = ['appAgent.ts', 'proposalGate.ts', 'applyArmed.ts'] as const;

/** The files the scan covers; an absent directory or extra file is an empty list, not a failure (the presence of each is pinned separately). */
function uiFiles(): string[] {
  const scheduleDir = path.join(PLAYGROUND_SRC, 'schedule');
  const viewsDir = path.join(PLAYGROUND_SRC, 'views');
  const under = (dir: string, keep: (name: string) => boolean): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && keep(entry.name))
          .map((entry) => path.join(dir, entry.name))
      : [];
  const extras = EXTRA_FILES.map((rel) => path.join(PLAYGROUND_SRC, rel)).filter((file) => existsSync(file));
  return [...under(scheduleDir, () => true), ...under(viewsDir, (name) => /^Schedule.*\.tsx$/.test(name)), ...extras].sort();
}

const isScheduleCopy = (file: string): boolean => path.basename(file) === 'copy.ts' && path.basename(path.dirname(file)) === 'schedule';

function scanOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of uiFiles()) {
    if (isScheduleCopy(file)) continue;
    for (const text of internalWordsIn(readFileSync(file, 'utf8'), scriptKindOf(file))) offenders.push(`${path.relative(PLAYGROUND_SRC, file)}: '${text}'`);
  }
  return offenders;
}

describe('vocabulary scan — no UI file spells "task" or "proposal" as a user-facing word', () => {
  it('the scanner can fail: a planted sentence is caught, an identifier or a settings key is not', () => {
    expect(internalWordsIn(`const label = 'a task was missed';`)).toEqual(['a task was missed']);
    expect(internalWordsIn(`const label = "Tasks";`)).toEqual(['Tasks']);
    expect(internalWordsIn('const t = `${n} proposals waiting`;')).toEqual(['${n} proposals waiting']);
    expect(internalWordsIn(`const key = 'schedule:' + task.id; const id = row.taskId; const k = 'scheduleRuns:';`)).toEqual([]);
    expect(internalWordsIn(`// a task is the internal word\nconst x = 'schedule';`)).toEqual([]);
    expect(internalWordsIn(`/* proposal: the data-write card */ const y = "result";`)).toEqual([]);
  });

  it('D-PR4-21: JSX TEXT is a sentence now — the regex scan could not see it; the walker does', () => {
    expect(internalWordsIn('export const A = () => <p>a task was missed</p>;')).toEqual(['a task was missed']);
    expect(internalWordsIn('export const A = () => <p>{n} proposals waiting</p>;')).toEqual(['proposals waiting']);
    expect(internalWordsIn('export const A = () => <button aria-label="stop the task">x</button>;')).toEqual(['stop the task']);
    // An identifier inside an expression container is code: `{task.title}` reads nothing.
    expect(internalWordsIn('export const A = ({ task }) => <p>{task.title}</p>;')).toEqual([]);
  });

  it('a comment marker INSIDE a string never blinds the scan, and a module specifier is a file name', () => {
    expect(internalWordsIn(`const a = 'path // a task'; const b = '*/';`)).toEqual(['path // a task']);
    expect(internalWordsIn(`import { x } from './task.js'; export { y } from './proposal.js';`, ts.ScriptKind.TS)).toEqual([]);
    expect(internalWordsIn(`import { x } from './task.js'; const s = './task.js';`, ts.ScriptKind.TS)).toEqual(['./task.js']);
  });

  it('a template is read by its literal parts — a `${task.id}` substitution is code', () => {
    expect(internalWordsIn('const a = `${task.id} is due`;')).toEqual([]);
    expect(internalWordsIn('const a = `outer ${`the task ${x}`} end`;')).toEqual(['the task ${x}']);
  });

  it('the machine-token exemption is pinned — today it is empty: no literal in the scanned tree is an enum member that spells either word', () => {
    expect([...MACHINE_TOKENS].sort()).toEqual([]);
  });

  it('the walk sees copy.ts and the three surface copy modules, and tolerates the rest of the tree being empty', () => {
    const files = uiFiles().map((file) => path.relative(PLAYGROUND_SRC, file));
    for (const name of ['copy.ts', 'copy.page.ts', 'copy.editor.ts', 'copy.result.ts', 'routes.ts']) expect(files).toContain(path.join('schedule', name));
    expect(files, 'copy.bits.ts was renamed to copy.result.ts (M22)').not.toContain(path.join('schedule', 'copy.bits.ts'));
  });

  it('the walk covers the delegated run’s new modules (TASK-20261010-host-broker PR-1) — it globs `schedule/*.ts`, so they are scanned by the same rule', () => {
    const files = uiFiles().map((file) => path.relative(PLAYGROUND_SRC, file));
    for (const name of ['runPlacement.ts', 'runScopedGate.ts', 'scheduledTransport.ts', 'RunningChip.tsx']) {
      expect(files).toContain(path.join('schedule', name));
    }
  });

  it('the walk covers the .tsx surfaces too, whose JSX text it now reads (D-PR4-21)', () => {
    const files = uiFiles().map((file) => path.relative(PLAYGROUND_SRC, file));
    for (const name of ['EnableConsent.tsx', 'ScheduleEditor.tsx', 'StepsEditor.tsx', 'ScheduleRow.tsx', 'ResultDetail.tsx', 'ResultsList.tsx', 'ScheduleSettingsCard.tsx']) {
      expect(files).toContain(path.join('schedule', name));
    }
    expect(files).toContain(path.join('views', 'ScheduleView.tsx'));
  });

  it.each(PR4_SCHEDULE_MODULES)('the walk sees PR-4’s new schedule/%s (the contract’s module list) — absent is red here, never created', (name) => {
    const files = uiFiles().map((file) => path.relative(PLAYGROUND_SRC, file));
    expect(existsSync(path.join(PLAYGROUND_SRC, 'schedule', name)), `schedule/${name} exists`).toBe(true);
    expect(files).toContain(path.join('schedule', name));
  });

  it('the refresh engine (`access/refresh.ts`, PR-3) and the chat card’s words (`agent/copy.dataWrite.ts`, D-PR4-19) are scanned by the same rule (AC32d)', () => {
    const files = uiFiles().map((file) => path.relative(PLAYGROUND_SRC, file));
    expect(existsSync(path.join(PLAYGROUND_SRC, 'access', 'refresh.ts')), 'access/refresh.ts exists').toBe(true);
    expect(files).toContain(path.join('access', 'refresh.ts'));
    expect(existsSync(path.join(PLAYGROUND_SRC, 'agent', 'copy.dataWrite.ts')), 'agent/copy.dataWrite.ts exists — the card’s ONE home (D-PR4-19)').toBe(true);
    expect(files).toContain(path.join('agent', 'copy.dataWrite.ts'));
  });

  it('the scan BITES in memory on a real .tsx surface: clean as shipped, red with a JSX sentence appended — the file is never written', () => {
    const file = path.join(PLAYGROUND_SRC, 'schedule', 'ScheduleRow.tsx');
    const original = readFileSync(file, 'utf8');
    expect(internalWordsIn(original, ts.ScriptKind.TSX)).toEqual([]);
    expect(internalWordsIn(`${original}\nexport const VocabularyProbe = () => <p>this task was missed</p>;\n`, ts.ScriptKind.TSX)).toEqual(['this task was missed']);
    expect(readFileSync(file, 'utf8'), 'the proof reads the file and never writes it').toBe(original);
  });

  it.each([...PR4_SCHEDULE_MODULES.map((name) => path.join('schedule', name)), path.join('agent', 'copy.dataWrite.ts')])(
    'the scan BITES on %s’s bytes in memory: clean as shipped, red with a sentence appended — never created or written here',
    (rel) => {
      const file = path.join(PLAYGROUND_SRC, rel);
      expect(existsSync(file), `${rel} exists`).toBe(true);
      const original = readFileSync(file, 'utf8');
      const kind = scriptKindOf(file);
      expect(internalWordsIn(original, kind)).toEqual([]);
      expect(internalWordsIn(`${original}\nexport const VOCABULARY_PROBE = 'a proposal for this task';\n`, kind)).toEqual(['a proposal for this task']);
      expect(readFileSync(file, 'utf8')).toBe(original);
    },
  );

  it('the surface copy modules compose from copy.ts and never carry a pluraliser or a status word of their own (M5, M12)', () => {
    for (const name of ['copy.page.ts', 'copy.editor.ts', 'copy.result.ts']) {
      const code = stripComments(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', name), 'utf8'));
      expect(code, `${name} spells its own AI-call plural`).not.toMatch(/AI \$\{[^}]*\? 'call' : 'calls'\}/);
      expect(code, `${name} spells "no AI calls" itself`).not.toContain("'no AI calls'");
      expect(code, `${name} has a status table of its own`).not.toMatch(/STATUS_WORD\s*[:=]/);
      expect(code, `${name} has a relative clock of its own`).not.toMatch(/function (relativeTime|absoluteTime)\b/);
    }
  });

  it('every scanned file outside copy.ts is clean — JSX text included; copy.ts is where the words are decided, and its sentences are pinned above', () => {
    expect(scanOffenders()).toEqual([]);
  });

  it('the refresh engine (`access/refresh.ts`, TASK-20261010-host-broker PR-3) is held to the same rule — its sentences come from copy.ts, its strings spell neither word', () => {
    const file = path.join(PLAYGROUND_SRC, 'access', 'refresh.ts');
    expect(existsSync(file), 'access/refresh.ts exists').toBe(true);
    expect(internalWordsIn(readFileSync(file, 'utf8'), ts.ScriptKind.TS)).toEqual([]);
  });

  it('…and copy.ts itself spells neither word in any of its sentences — the exemption is for its comments, not its strings', () => {
    const copy = readFileSync(path.join(PLAYGROUND_SRC, 'schedule', 'copy.ts'), 'utf8');
    expect(internalWordsIn(copy, ts.ScriptKind.TS)).toEqual([]);
  });

  it('no scanned file spells "routine" or "automation" in a sentence — copy.ts:15-17 bans both (D-PR4-20: the chooser’s hints say neither)', () => {
    expect(foreignWordsIn(`const a = 'your morning routine';`)).toEqual(['your morning routine']);
    expect(foreignWordsIn('export const A = () => <p>an automation</p>;')).toEqual(['an automation']);
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      for (const text of foreignWordsIn(readFileSync(file, 'utf8'), scriptKindOf(file))) offenders.push(`${path.relative(PLAYGROUND_SRC, file)}: '${text}'`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-4 — the contract's sentences, byte for byte (D-PR4-18, D-PR4-20)
// ---------------------------------------------------------------------------------------------

const SCHEDULE_COPY_MODULES = ['copy.ts', 'copy.page.ts', 'copy.editor.ts', 'copy.result.ts'] as const;

/** Every piece of text the four schedule copy modules hold, joined — where a fixed sentence must live. */
function scheduleCopyText(): string {
  return SCHEDULE_COPY_MODULES.flatMap((name) => literalsIn(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', name), 'utf8'), ts.ScriptKind.TS).map((literal) => literal.words)).join('\n');
}

const TOOLS_THINK: ScheduleStep = { kind: 'app-think', appId: 'x', prompt: 'Sum it', context: { maxRows: 5 }, tools: true };

describe('PR-4 — the tick, the chooser and the step words (D-PR4-20)', () => {
  it('CONSENT_ROWS.onItsOwn(appName): the one tick, in the contract’s words', () => {
    expect(CONSENT_ROWS.onItsOwn('Ledger')).toBe('let it make its changes to Ledger’s data on its own — never another app’s · up to 200 rows each time · undo any of it for seven days');
  });

  it('STEPS.kindHint: ONE hint per kind — ask and run, in the contract’s words; never *routine* (Q: called as kindHint(kind, appName))', () => {
    expect(STEPS.kindHint('app-think', 'Ledger')).toBe('Ledger’s AI answers from Ledger’s data — Ledger doesn’t need to open');
    expect(STEPS.kindHint('app-run', 'Ledger')).toBe('Ledger itself does the job, the way it was built — in the app if it’s open, out of sight if not');
    expect(STEPS.kindHint('app-run', 'Ledger')).not.toMatch(FOREIGN_WORD);
    expect(STEPS.kindHint('app-run', 'Ledger')).not.toMatch(/\bbackground\b/);
  });

  it('stepWords appends *· may look things up* to an ask step that may look things up — and only to that one', () => {
    expect(stepWords(TOOLS_THINK, 'Ledger')).toBe('ask Ledger’s AI: Sum it · may look things up');
    expect(stepWords({ kind: 'app-think', appId: 'x', prompt: 'Sum it', context: { maxRows: 5 } }, 'Ledger')).toBe('ask Ledger’s AI: Sum it');
  });
});

describe('PR-4 — the held reasons: ONE table, one sentence each (D-PR4-11, D-PR4-18)', () => {
  /**
   * A held sentence may name the app (busy does): read it either way. `full` names the bucket's live
   * count read at render (PR-4 Gate-5 U14, `HELD_WHY.full(appName, live)`) — read here at the bucket's
   * cap, 20, the count the contract's sentence spells.
   */
  const why = (reason: string): string => {
    const entry = (HELD_WHY as Record<string, string | ((appName: string, live: number) => string)>)[reason];
    return typeof entry === 'function' ? entry('Ledger', 20) : (entry ?? '');
  };

  it('HELD_WHY has exactly the protocol’s held reasons — a new reason is a type error, never a missing line', () => {
    expect(Object.keys(HELD_WHY).sort()).toEqual([...SCHEDULE_HELD_REASONS].sort());
    expect([...SCHEDULE_HELD_REASONS]).toEqual(['busy', 'changed', 'cannot-undo', 'full', 'failed', 'over-limit', 'stopped']);
  });

  it('each sentence is the contract’s, byte for byte', () => {
    expect(why('cannot-undo')).toBe('not made — it couldn’t be undone, so it waits for you (applying it here can’t be undone either)');
    expect(why('over-limit')).toBe('not made — it would pass the 200 rows this schedule may change each time');
    expect(why('busy')).toBe('not made — Ledger was in the middle of a change');
    expect(why('stopped')).toBe('not made — it was stopped from making changes on its own');
    expect(why('changed')).toBe('not made — the data moved since the AI looked');
    expect(why('full')).toBe('not made — 20 earlier changes can still be undone; it will make changes again as they age out');
    expect(why('failed')).toBe('not made — something went wrong; nothing was changed');
  });
});

describe('PR-4 — every fixed sentence the surfaces print lives in a schedule copy module (one home; D-PR4-18/20)', () => {
  const FIXED: readonly string[] = [
    // the consent's tick (D-PR4-20)
    'off: its changes wait for your OK on the result',
    'it runs more than 20 times a week — once 20 changes are waiting to age out, the rest wait for your OK',
    // the consent's rows for an ask step (D-PR4-20)
    // INVERTED by PR-4 Gate-5 U3 (ADR-0076 §9: GET-only is not read-only — the orchestrator's decision, reversal word "read-only").
    // Was: 'may look up (read only — it can’t send or change anything there; it can use them without asking you each time)',
    'may look things up through (it only asks, never posts — but what it asks can carry your data; it can use them without asking you each time)',
    'it only asks, never posts',
    'it only reads data',
    'look-ups each time',
    // the editor (D-PR4-8, D-PR4-20)
    'let it look things up',
    'it can choose its own questions over',
    'this brain will answer without looking things up',
    'changes it suggests:',
    'wait for my OK',
    'make them on its own',
    'changing what it does stops it making changes on its own — you’ll confirm again before saving',
    // the editor's disarm hint (PR-4 Gate-5 U8)
    'save to keep it waiting for your OK, or choose make them on its own',
    // the row, the menu, Settings (D-PR4-8, D-PR4-10)
    'makes changes on its own',
    'stop making changes on its own',
    'it won’t change data on its own any more — turn it back on from edit',
    'stop every schedule making changes on its own',
    'no longer makes changes on its own',
    'arrived with an imported file',
    'resuming won’t let it make changes on its own until you confirm again',
    'its changes from the last seven days can’t be undone after this',
    // the result page (D-PR4-18)
    'this schedule makes changes on its own',
    'you applied this',
    'undo ended after seven days',
    'can’t be undone',
    // the result page's link to the changes list (PR-4 Gate-5 U6)
    'this schedule’s changes you can still undo',
    'didn’t need to look anything up',
    'out of sight while it was closed',
    'you allowed it',
    'may look things up',
  ];

  it.each(FIXED)('%j', (sentence) => {
    expect(scheduleCopyText()).toContain(sentence);
  });

  it('none of them spells task, proposal, routine, automation or "background"; each keeps the typographic apostrophe', () => {
    for (const sentence of FIXED) {
      expect(sentence, sentence).not.toMatch(INTERNAL_WORD);
      expect(sentence, sentence).not.toMatch(FOREIGN_WORD);
      expect(sentence, sentence).not.toMatch(/\bbackground\b/i);
      expect(sentence, sentence).not.toMatch(/[A-Za-z]'[A-Za-z]/);
    }
  });

  it('the word *background* is never shown on the result page’s step facts — no schedule copy module spells it in a PR-4 sentence (D-PR4-18)', () => {
    const offenders = SCHEDULE_COPY_MODULES.flatMap((name) =>
      literalsIn(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', name), 'utf8'), ts.ScriptKind.TS)
        .map((literal) => literal.words)
        .filter((words) => /\bbackground\b/i.test(words) && /(out of sight|didn’t open|while it was)/.test(words)),
    );
    expect(offenders).toEqual([]);
  });
});

// =============================================================================================
// TASK-20261010-host-broker PR-4 Gate 5 — the UI fold's sentences (U3, U5, U6, U8, U13, U14). U3 is
// the orchestrator's decision under the owner's delegation of copy (reversal word "read-only"): the
// consent and the editor stop promising what ADR-0076 §9 says is false (*GET-only is not
// read-only* — what it asks can carry the user's data). Sentences the fold record spells are pinned
// byte for byte; a sentence it names only by its key (`armedLost`, `savedButWaits`) is pinned by
// what it must carry.
// =============================================================================================

describe('PR-4 Gate-5 U3 — the look-up words promise only what is true (ADR-0076 §9)', () => {
  const LOOK_UP_TRUE = 'may look things up through (it only asks, never posts — but what it asks can carry your data; it can use them without asking you each time)';

  it('CONSENT_ROWS.lookUps: the fold record’s sentence, then the names — *none* for none (D-I4-10)', () => {
    expect(CONSENT_ROWS.lookUps(['Spotify', 'Bank'])).toBe(`${LOOK_UP_TRUE}: Spotify, Bank`);
    expect(CONSENT_ROWS.lookUps([])).toBe(`${LOOK_UP_TRUE}: none`);
  });

  it('STEPS.toolsLine: *… and ask <App>’s connections (it only asks, never posts) · up to 10 AI calls each time*', () => {
    expect(STEPS.toolsLine('Ledger')).toBe(
      'it can choose its own questions over Ledger’s data and what you let it read from other apps, and ask Ledger’s connections (it only asks, never posts) · up to 10 AI calls each time',
    );
  });

  it('NEGATIVE: neither says *read only* nor *can’t send* — in any spelling', () => {
    for (const sentence of [CONSENT_ROWS.lookUps(['Spotify']), CONSENT_ROWS.lookUps([]), STEPS.toolsLine('Ledger')]) {
      expect(sentence, sentence).not.toMatch(/read[\s-]only/i);
      expect(sentence, sentence).not.toMatch(/can[’']t send/i);
      expect(sentence, sentence).not.toMatch(/cannot send/i);
    }
  });

  it('NEGATIVE: no schedule copy module keeps the old promise anywhere', () => {
    const text = scheduleCopyText();
    expect(text).not.toContain('read only — it can’t send or change anything there');
    expect(text).not.toContain('— read only');
  });
});

describe('PR-4 Gate-5 — the editor’s and the result page’s new sentences (U5, U6, U8, U13, U14)', () => {
  it('U6: CHANGES_LINK says what the list holds — *this schedule’s changes you can still undo*, never *every change*', () => {
    expect(CHANGES_LINK).toBe('this schedule’s changes you can still undo');
    expect(CHANGES_LINK).not.toMatch(/\bevery\b/);
  });

  it('U8: CHANGES_CONTROL.disarmedHint — the way out of the disarmed attention line, in the fold record’s words', () => {
    expect(CHANGES_CONTROL.disarmedHint).toBe('save to keep it waiting for your OK, or choose make them on its own');
  });

  it('U5: CHANGES_CONTROL.armedLost — its own sentence (not the widening warning), saying it stops making changes on its own', () => {
    expect(typeof CHANGES_CONTROL.armedLost).toBe('string');
    expect(CHANGES_CONTROL.armedLost).toContain('on its own');
    expect(CHANGES_CONTROL.armedLost).not.toBe(CHANGES_CONTROL.armedWarning);
    expect(CHANGES_CONTROL.armedLost).not.toMatch(INTERNAL_WORD);
    expect(CHANGES_CONTROL.armedLost).not.toMatch(/[A-Za-z]'[A-Za-z]/);
  });

  it('U13: ACTIONS.savedButWaits(refusal) says the schedule WAS saved, then the refusal — never the refusal alone', () => {
    const refusal = 'app "ledger" is not installed in this file';
    const line = ACTIONS.savedButWaits(refusal);
    expect(line).toContain(refusal);
    expect(line).not.toBe(refusal);
    expect(line.replace(refusal, '')).toMatch(/sav|schedul/i);
    expect(line.replace(refusal, '')).not.toMatch(INTERNAL_WORD);
  });

  it('U14: HELD_WHY.full(appName, live) names the LIVE count read at render — the cap is no longer spelled into it', () => {
    const full = HELD_WHY.full as (appName: string, live: number) => string;
    expect(full('Ledger', 3)).toBe('not made — 3 earlier changes can still be undone; it will make changes again as they age out');
    expect(full('Ledger', 20)).toBe('not made — 20 earlier changes can still be undone; it will make changes again as they age out');
  });

  it('U2: MADE keeps *undo ended after seven days* — said only past the seven days (resultDetail.test.tsx); the neutral line has ONE home (dataWriteCard.test.tsx)', () => {
    expect(MADE.undoEnded).toBe('undo ended after seven days');
  });
});

// ---------------------------------------------------------------------------------------------
// TASK-20261010-host-broker PR-5 (AC39b, AC39d; contract v2 D-PR5-17, D-PR5-19, D-PR5-24). The new
// schedule/ sentences — the fetching chip, the after-fetch dialog, the editor's tick and its two
// lines, the consent row, the step fact's `none` — each in ONE schedule copy module, typographic
// apostrophes, never *task*/*proposal*/*routine*/*automation*/*background*, and the fetch says
// *new data*, never *look up*. The words built from `FETCH_FIRST` live in `access/copy.ts` and are
// pinned in fetchFirst.test.ts; here only the schedule/ homes.
// ---------------------------------------------------------------------------------------------

describe('PR-5 — the fetch’s schedule/ sentences (D-PR5-17, D-PR5-19, D-PR5-24)', () => {
  const PR5_FIXED: readonly string[] = [
    // the chip (D-PR5-17)
    'fetching in',
    'stop waiting',
    'it may still finish fetching',
    // the after-run dialog, after a fetch (D-PR5-17; D12(ii))
    'fetched new data here earlier, so Snug asks every time',
    // the editor's tick and its lines (D-PR5-19)
    'fetch new data first from the apps',
    'counted on your daily limits',
    'this does nothing until one does',
    // the consent row (D-PR5-19)
    'first asks the apps',
    // the step fact's `none` (D-PR5-19)
    'didn’t fetch first — no app lets',
    'ask for new data any more',
  ];

  it.each(PR5_FIXED)('%j lives in a schedule copy module', (fragment) => {
    expect(scheduleCopyText()).toContain(fragment);
  });

  it('none of them spells task, proposal, routine, automation, background or *look up*; each keeps the typographic apostrophe', () => {
    for (const fragment of PR5_FIXED) {
      expect(fragment, fragment).not.toMatch(INTERNAL_WORD);
      expect(fragment, fragment).not.toMatch(FOREIGN_WORD);
      expect(fragment, fragment).not.toMatch(/\bbackground\b/i);
      expect(fragment, fragment).not.toMatch(/look(ed|ing)?[\s-]?up/i);
      expect(fragment, fragment).not.toMatch(/[A-Za-z]'[A-Za-z]/);
    }
  });

  it('RUNNING_CHIP gains fetchingIn / cancelFetch / stopWaiting / moreFetches — *fetching in Ledger*, *and 1 more fetch*; PR-3’s `fetching` stays', () => {
    expect(RUNNING_CHIP.fetchingIn('Ledger')).toBe('fetching in Ledger');
    expect(RUNNING_CHIP.moreFetches(1)).toBe('and 1 more fetch');
    expect(RUNNING_CHIP.cancelFetch('Ledger')).toContain('Ledger');
    expect(RUNNING_CHIP.cancelFetch('Ledger')).not.toMatch(INTERNAL_WORD);
    expect(RUNNING_CHIP.stopWaiting).toBeDefined();
    expect(RUNNING_CHIP.fetching('Ledger'), 'the PR-3 key keeps its bytes').toBe('fetching new data in Ledger');
  });

  it('DELEGATED_CONFIRM.afterFetchBody delimits the app name like afterRunBody (“Ledger”) and is its own sentence', () => {
    const body = DELEGATED_CONFIRM.afterFetchBody('Ledger', 'POST', 'api.example.com');
    expect(body).toContain('“Ledger”');
    expect(body).not.toMatch(INTERNAL_WORD);
    expect(body).not.toBe(DELEGATED_CONFIRM.afterRunBody('Ledger', 'POST', 'api.example.com'));
  });

  it('STEPS.fetchFirst — the tick’s words, in the editor’s copy module', async () => {
    const editor = (await import('../schedule/copy.editor.js')) as unknown as { STEPS: Record<string, unknown> };
    expect(editor.STEPS.fetchFirst).toBeDefined();
  });

  it('the walk sees PR-5’s new schedule/fetchFirstFacts.ts — and the scan BITES on it in memory', () => {
    const file = path.join(PLAYGROUND_SRC, 'schedule', 'fetchFirstFacts.ts');
    expect(existsSync(file), 'schedule/fetchFirstFacts.ts exists').toBe(true);
    expect(uiFiles().map((f) => path.relative(PLAYGROUND_SRC, f))).toContain(path.join('schedule', 'fetchFirstFacts.ts'));
    const original = readFileSync(file, 'utf8');
    expect(internalWordsIn(original, ts.ScriptKind.TS)).toEqual([]);
    expect(internalWordsIn(`${original}\nexport const VOCABULARY_PROBE = 'a proposal for this task';\n`, ts.ScriptKind.TS)).toEqual(['a proposal for this task']);
  });
});
