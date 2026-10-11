// TASK-20261009-scheduling-framework P4/P5 — the app-authoring KB teaches scheduled runs
// (ADR-0074 §3 the kv handshake, §4 the suggest-only ladder, §6 the unattended posture).
//
// TWO CLAIMS, TESTED SEPARATELY — the auth-KB / runtime-contract-KB pattern:
//
//  1. CONTENT SYNC. The listener snippet names the REAL frame types through placeholders
//     (the rendered text carries `FRAME_TYPES` values, the source carries none), the real
//     event names the module SDK posts and listens for, the real kv key, the protocol's
//     bounds — never retyped. A snippet that drifts from `packages/sdk/src/schedule.ts`
//     produces apps whose runs the host records as "not supported", and nothing else
//     would catch it.
//  2. RETRIEVAL DELIVERY. The KB reaches the builder ONLY as `searchKnowledge`'s top
//     sections. "schedule" must rank this file first; the phrasings a builder actually
//     uses must reach it in the top five; and the headings are pinned, because they are
//     the retrieval keys (ADR-0004).
//
// The amended timer rule in 10 and 80 is pinned here too: the rule still forbids the app's
// own timers (binding-a-rules.test.ts keeps its sentence) AND now names the one sanctioned
// timer and the one way in.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  FRAME_TYPES,
  PROTOCOL_VERSION,
  SCHEDULE_APP_INPUT_MAX_BYTES,
  SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_NOTIFY_BODY_MAX_CHARS,
  SCHEDULE_STEP_SUMMARY_MAX_CHARS,
  SCHEDULE_TITLE_MAX_CHARS,
} from '@snugprotocol/protocol';

import { INLINE_KNOWLEDGE_CORE_FILES, getKnowledgeBase, searchKnowledge } from '../index.js';
import { promptFilesOnDisk, repoRoot } from './helpers.js';

const KB_FILE = 'knowledge-base/app-authoring/85-scheduled-runs.md';
const KB_OVERVIEW = 'knowledge-base/app-authoring/10-overview-and-contract.md';
const KB_CDN = 'knowledge-base/app-authoring/80-cdn-compatibility.md';

/** The event names and the kv key, read from the module SDK SOURCE so the two forms cannot drift. */
const SDK_SCHEDULE_SOURCE = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'src', 'schedule.ts'), 'utf8');
const sdkConst = (name: string): string => {
  const match = new RegExp(`export const ${name} = '([^']+)';`).exec(SDK_SCHEDULE_SOURCE);
  if (match === null) throw new Error(`packages/sdk/src/schedule.ts no longer exports ${name}`);
  return match[1] as string;
};
const RUN_EVENT = sdkConst('SCHEDULE_RUN_EVENT');
const RESULT_EVENT = sdkConst('SCHEDULE_RESULT_EVENT');
const REQUEST_EVENT = sdkConst('SCHEDULE_REQUEST_EVENT');
const KV_PREFIX = (() => {
  const match = /return `(snug:schedule:)\$\{runId\}`;/.exec(SDK_SCHEDULE_SOURCE);
  if (match === null) throw new Error('packages/sdk/src/schedule.ts no longer builds the kv key as `snug:schedule:${runId}`');
  return match[1] as string;
})();

/** The status words the host prints, read from the playground's ONE copy table — the KB may not spell a word of its own. */
const RESULT_STATUS_WORD: Readonly<Record<string, string>> = (() => {
  const copySource = readFileSync(path.join(repoRoot, 'apps', 'playground', 'src', 'schedule', 'copy.ts'), 'utf8');
  const block = /export const RESULT_STATUS_WORD[^{]*\{([\s\S]*?)\};/.exec(copySource);
  if (block === null) throw new Error('apps/playground/src/schedule/copy.ts no longer exports RESULT_STATUS_WORD');
  const words: Record<string, string> = {};
  for (const entry of (block[1] as string).matchAll(/^\s*'?([\w-]+)'?:\s*'([^']+)'/gm)) words[entry[1] as string] = entry[2] as string;
  return words;
})();

/** The engine's result bound, read from its source (`appRun.ts`), so "90 s" here is the engine's 90 s. */
const RESULT_TIMEOUT_S = (() => {
  const engineSource = readFileSync(path.join(repoRoot, 'apps', 'playground', 'src', 'schedule', 'appRun.ts'), 'utf8');
  const match = /export const SCHEDULE_RESULT_TIMEOUT_MS = ([\d_]+);/.exec(engineSource);
  if (match === null) throw new Error('apps/playground/src/schedule/appRun.ts no longer exports SCHEDULE_RESULT_TIMEOUT_MS');
  return Number((match[1] as string).replace(/_/g, '')) / 1000;
})();

function rendered(file: string): string {
  const section = getKnowledgeBase().find((doc) => doc.file === file);
  expect(section, `${file} missing from the knowledge base`).toBeDefined();
  return (section as { text: string }).text;
}

/** The text as sentences: the files are hard-wrapped, and a claim must not hide across a line break. */
const prose = (text: string): string => text.replace(/\s+/g, ' ');

function source(file: string): string {
  const entry = promptFilesOnDisk().find((f) => f.rel === file);
  if (entry === undefined) throw new Error(`${file} is not on disk`);
  return entry.content;
}

/** Every fenced ```javascript block in the rendered teaching. */
const fencedJs = (text: string): string[] => [...text.matchAll(/```javascript\r?\n([\s\S]*?)\r?\n```/g)].map((m) => (m[1] as string).trim());

describe('P4 — the file is in the store, out of the inline core, with its headings pinned', () => {
  it('exists, renders, and is NOT in the inline core (a tool-free brain gets the amended rule in 10 and 80 instead)', () => {
    expect(rendered(KB_FILE)).toContain('# Scheduled Runs');
    expect(INLINE_KNOWLEDGE_CORE_FILES).not.toContain(KB_FILE);
  });

  it('the heading tree is pinned — these are the retrieval keys', () => {
    const section = getKnowledgeBase().find((doc) => doc.file === KB_FILE)!;
    expect(section.headingTree).toEqual([
      '# Scheduled Runs',
      "## The Host's Scheduler Is the One Timer",
      '## The Scheduled-Run Handshake',
      '## The Schedule Listener (copy beside the hooks block)',
      '## Rules for a Scheduled Handler',
      '## Suggesting a Schedule',
      '## What the Host Shows',
    ]);
  });
});

describe('P4 content sync — the handshake the KB teaches is the one the SDK implements', () => {
  it('the SOURCE names no frame type literally — placeholders only (the scanners pin this store-wide; here by name)', () => {
    const text = source(KB_FILE);
    expect(text).toContain('{{frameType:hostEvent}}');
    expect(text).toContain('{{frameType:appEvent}}');
    expect(text).toContain('{{protocolVersion}}');
    for (const literal of Object.values(FRAME_TYPES)) expect(text, `source retypes ${literal}`).not.toContain(literal);
  });

  it('the RENDERED listener filters on the real host-event frame type, the real event name, the parent window and the wire version', () => {
    const [listener] = fencedJs(rendered(KB_FILE));
    expect(listener).toBeDefined();
    expect(listener).toContain("addEventListener('message'");
    expect(listener).toContain('event.source !== window.parent');
    expect(listener).toContain(`data.v !== ${PROTOCOL_VERSION}`);
    expect(listener).toContain(`data.type !== '${FRAME_TYPES.hostEvent}'`);
    expect(listener).toContain(`data.event !== '${RUN_EVENT}'`);
  });

  it('reads the input back through the bridge’s own kvGet under the SDK’s kv key, and answers with SnugBridge.post on the real app-event frame type', () => {
    const [listener] = fencedJs(rendered(KB_FILE));
    expect(listener).toContain(`snugDbRequest('kvGet', { key: '${KV_PREFIX}' + hint.runId })`);
    expect(listener).toContain(`SnugBridge.post({ type: '${FRAME_TYPES.appEvent}', event: '${RESULT_EVENT}', data: answer })`);
    // The result shape the host parses — ok, summary?, notify? — and nothing else.
    expect(listener).toContain('const answer = { ok: !!(result && result.ok) }');
    expect(listener).toContain('answer.summary = result.summary');
    expect(listener).toContain('answer.notify = { title: String(result.notify.title), body: String(result.notify.body) }');
    // Idempotent by runId, and a throw becomes ok:false — the SDK’s two guarantees.
    expect(listener).toContain('SCHEDULE_HANDLED.has(hint.runId)');
    expect(listener).toMatch(/catch \(err\) \{\s*result = \{ ok: false/);
    // No plumbing of its own: the bridge's helpers, never a hand-rolled postMessage.
    expect(listener).not.toContain('postMessage(');
  });

  it('the suggestion snippet posts the real app-event frame type with the request event name the host consumes', () => {
    const [, suggestion] = fencedJs(rendered(KB_FILE));
    expect(suggestion).toBeDefined();
    expect(suggestion).toContain(`type: '${FRAME_TYPES.appEvent}'`);
    expect(suggestion).toContain(`event: '${REQUEST_EVENT}'`);
    // The proposal shape — title, steps naming only this app, spec — as scheduleProposalSchema has it.
    expect(suggestion).toMatch(/title: '/);
    expect(suggestion).toContain("steps: [{ kind: 'app-run', appId: 'your-app-id', input: { fetch: true } }]");
    expect(suggestion).toContain("spec: { kind: 'daily', time: '07:00', tz: 'device' }");
  });

  it('states the bounds it claims, in agreement with the protocol constants', () => {
    const text = rendered(KB_FILE);
    expect(text).toContain(`${SCHEDULE_APP_INPUT_MAX_BYTES / 1024} KiB`);
    expect(text).toContain(SCHEDULE_STEP_SUMMARY_MAX_CHARS.toLocaleString('en-US'));
    expect(text).toContain(`title ≤ ${SCHEDULE_TITLE_MAX_CHARS}`);
    expect(text).toContain(`body ≤ ${SCHEDULE_NOTIFY_BODY_MAX_CHARS}`);
    expect(SCHEDULE_MIN_INTERVAL_MS.other).toBe(15 * 60_000);
    expect(text).toContain('a floor of fifteen minutes');
  });

  it('teaches the rules by name: idempotent by runId, a summary not data, notify a suggestion, suggest once after a user act, never own timers, needs-you', () => {
    const text = prose(rendered(KB_FILE));
    expect(text).toMatch(/\*\*Idempotent by `runId`\.\*\*/);
    expect(text).toMatch(/\*\*A result is a summary, not data\.\*\*/);
    expect(text).toMatch(/\*\*`notify` is a suggestion\.\*\*/);
    expect(text).toMatch(/\*\*Suggest ONCE, and only after a user act or a first successful fetch\*\*/);
    expect(text).toMatch(/\*\*Never own timers\.\*\*/);
    // TASK-20261010-host-broker: one instance per app — the run executes inside the open page, never beside it.
    expect(text).toMatch(/\*\*One instance — and the same `runId` can reach a different one\.\*\*/);
    expect(text).not.toContain('You may not be the only instance');
    expect(text).toContain('never two copies at once');
    expect(text).not.toContain('beside a visible copy');
    expect(text).toContain('`NET_CONFIRM_DENIED`');
    expect(text).toContain('*needs you*');
    expect(text).toContain('*run now and review*');
    expect(text).toContain('*not supported*');
    // The strip's three acts, as copy.ts spells them (SUGGESTION_ACTIONS / CONSENT).
    expect(text).toContain('*schedule it* / *not now* / *stop suggestions from this app*');
    // The module form is named beside the embedded snippet.
    expect(text).toContain('`useSnugSchedule(handler)`');
    expect(text).toContain('`proposeSchedule(proposal)`');
  });

  it('the status words are copy.RESULT_STATUS_WORD’s; an unanswered run is *failed* after the engine’s bound, *not supported* is for an app that never announces; the host titles the notification (S8)', () => {
    const text = prose(rendered(KB_FILE));
    for (const status of ['ok', 'failed', 'needs-you', 'no-handler']) {
      const word = RESULT_STATUS_WORD[status];
      expect(word, `copy.ts names ${status}`).toBeDefined();
      expect(text, status).toContain(`*${word}*`);
    }
    expect(text).toContain(
      `A run the app does not answer within ${RESULT_TIMEOUT_S} s is recorded as *${RESULT_STATUS_WORD.failed}*; *${RESULT_STATUS_WORD['no-handler']}* is for an app that never announces at all.`,
    );
    expect(text).not.toMatch(/never answers is recorded as \*not supported\*/);
    expect(text).toContain(`records *${RESULT_STATUS_WORD.failed}* after ${RESULT_TIMEOUT_S} s until the listener ships`);
    // The notification: the host decides the title (the app's name); the app's words read under it.
    expect(text).toContain('carries your app\'s name as its title — the host decides the title, never your handler — and reads "<your app>: <your title> — <your body>" under it');
  });

  it('the kv key is exempt from the frame scanners ONLY as the key — the exemption helper leaves a frame-shaped neighbour to be caught', async () => {
    const { withoutNonFrameSnugMentions } = await import('./helpers.js');
    expect(withoutNonFrameSnugMentions(`'${KV_PREFIX}' + hint.runId`)).toBe("'' + hint.runId");
    expect(withoutNonFrameSnugMentions('snug:schedule-run')).toBe('snug:schedule-run'); // still scanned, still a violation
  });
});

describe('P4 — the "Never think on a timer" rule is amended in 10 and 80, not replaced', () => {
  it('10 keeps its sentence and now names the host’s scheduler as the one timer and the listener as the only way in', () => {
    const text = prose(rendered(KB_OVERVIEW));
    expect(text).toMatch(/never send one from a timer, an interval, or on load/);
    expect(text).toContain("The host's scheduler is the one timer");
    expect(text).toContain('the schedule listener in "Scheduled Runs" is the only way an app takes part');
    expect(text).toContain('- "Scheduled Runs" —'); // the section map
  });

  it('80 keeps "## Never Think on a Timer" with setInterval / on load / bill, and names the one timer', () => {
    const text = prose(rendered(KB_CDN));
    expect(text).toMatch(/## Never Think on a Timer/);
    expect(text).toMatch(/setInterval/);
    expect(text).toContain('The ONE timer is the host\'s scheduler');
    expect(text).toContain('an app never arms a timer of its own to think, fetch or remind');
  });
});

describe('P4 retrieval delivery — build-time queries reach the teaching', () => {
  it('"schedule" ranks the file FIRST', () => {
    const [top] = searchKnowledge('schedule');
    expect(top?.file, `top hit: ${top?.file}#${top?.heading}`).toBe(KB_FILE);
  });

  const queries = [
    'run the app on a schedule',
    'scheduled run every morning',
    'suggest a schedule for this app',
    'daily fetch while nobody is looking',
    'schedule-run host event',
    'recurring reminder every hour',
  ];
  for (const query of queries) {
    it(`"${query}" returns the scheduled-runs file in the top 5`, () => {
      const hits = searchKnowledge(query).slice(0, 5);
      expect(
        hits.some((hit) => hit.file === KB_FILE),
        `top-5 for "${query}": ${hits.map((h) => `${h.file}#${h.heading}`).join(' | ')}`,
      ).toBe(true);
    });
  }

  it('does NOT displace the sections that own the SDK call or the template', () => {
    expect(searchKnowledge('sendMessage').slice(0, 2).map((hit) => hit.file)).not.toContain(KB_FILE);
    expect(searchKnowledge('mandatory html template').slice(0, 1).map((hit) => hit.file)).not.toContain(KB_FILE);
  });
});
