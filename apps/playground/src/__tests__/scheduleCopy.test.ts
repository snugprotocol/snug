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
// What the scan can and cannot see. It reads string literals ('…', "…", `…`) with comments
// blanked, and matches the whole word, case-insensitively — so `taskId`, `scheduleRuns:` and
// `'schedule:' + task.id` pass (identifiers and keys are not sentences), while `'a task was
// missed'` and `"Task"` do not. It does NOT see JSX text nodes (`<p>a task</p>`) — those are
// not string literals — and it does NOT police "run": "run" is the sanctioned APP VERB ("run
// Ledger", "run now", "runs while…"), and a regex cannot tell the verb from the noun. Both
// gaps are closed by the copy-review at Gate 5, not by this file. The scan tolerates the
// directories being empty or absent (today `schedule/` holds only `copy.ts`), and proves it
// can fail on a planted sentence before it is trusted on the real tree.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APP_UNREACHABLE_SUMMARY,
  AUTH_REPAIR_VIA_SCHEDULE,
  CONSENT,
  DELEGATED_CONFIRM,
  EMPTY,
  MISSED_ACTIONS,
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
import { ACTIONS } from '../schedule/copy.editor.js';
import { needsYouTitle } from '../schedule/copy.result.js';
import { PAUSE_AFTER_FAILURES, PAUSE_AFTER_UNSEEN } from '../schedule/protection.js';

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

  it('RUNNING_CHIP: the label and its one act (security F15) — and, since TASK-20261010-host-broker PR-1, where a delegated run is running', () => {
    expect(RUNNING_CHIP).toEqual({ label: 'a schedule is running', cancel: 'cancel', inApp: expect.any(Function) });
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
// THE VOCABULARY SCAN
// ---------------------------------------------------------------------------------------------

const PLAYGROUND_SRC = path.resolve(__dirname, '..');

/** Source text with `//` and block comments blanked — a rule must not be tripped (or satisfied) by prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Every string literal in a source: single-, double- and backtick-quoted, comments already blanked. */
function stringLiterals(code: string): string[] {
  const literal = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  return [...code.matchAll(literal)].map((match) => match[0].slice(1, -1));
}

const INTERNAL_WORD = /\b(task|proposal)s?\b/i;

/** The internal words, spelled as a WHOLE word inside a string literal — `taskId` and `'schedule:' + id` pass. */
function internalWordsIn(code: string): string[] {
  return stringLiterals(stripComments(code)).filter((text) => INTERNAL_WORD.test(text));
}

/** The files the scan covers; an absent directory is an empty list, not a failure. */
function uiFiles(): string[] {
  const scheduleDir = path.join(PLAYGROUND_SRC, 'schedule');
  const viewsDir = path.join(PLAYGROUND_SRC, 'views');
  const under = (dir: string, keep: (name: string) => boolean): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && keep(entry.name))
          .map((entry) => path.join(dir, entry.name))
      : [];
  return [...under(scheduleDir, () => true), ...under(viewsDir, (name) => /^Schedule.*\.tsx$/.test(name))].sort();
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

  it('the surface copy modules compose from copy.ts and never carry a pluraliser or a status word of their own (M5, M12)', () => {
    for (const name of ['copy.page.ts', 'copy.editor.ts', 'copy.result.ts']) {
      const code = stripComments(readFileSync(path.join(PLAYGROUND_SRC, 'schedule', name), 'utf8'));
      expect(code, `${name} spells its own AI-call plural`).not.toMatch(/AI \$\{[^}]*\? 'call' : 'calls'\}/);
      expect(code, `${name} spells "no AI calls" itself`).not.toContain("'no AI calls'");
      expect(code, `${name} has a status table of its own`).not.toMatch(/STATUS_WORD\s*[:=]/);
      expect(code, `${name} has a relative clock of its own`).not.toMatch(/function (relativeTime|absoluteTime)\b/);
    }
  });

  it('every scanned file outside copy.ts is clean — copy.ts is where the words are decided, and its sentences are pinned above', () => {
    const offenders: string[] = [];
    for (const file of uiFiles()) {
      if (path.basename(file) === 'copy.ts' && path.basename(path.dirname(file)) === 'schedule') continue;
      for (const text of internalWordsIn(readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(PLAYGROUND_SRC, file)}: '${text}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('…and copy.ts itself spells neither word in any of its sentences — the exemption is for its comments, not its strings', () => {
    const copy = readFileSync(path.join(PLAYGROUND_SRC, 'schedule', 'copy.ts'), 'utf8');
    expect(internalWordsIn(copy)).toEqual([]);
  });
});
