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
//
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-3, D-PR6-6; AC40f): the schedule LISTENER
// snippet is RETIRED — section 6 of the copy-exactly hooks block (`useSnugSchedule`,
// `proposeSchedule`, `scheduleInputKey`, `onHostEvent`) is the one way an app answers a run. So:
// the heading "## The Schedule Listener (copy beside the hooks block)" becomes "## The Schedule
// Hook"; the page keeps ONE javascript fence, the COMPONENT that mounts the hook; the
// content-sync rows that read the old snippet are RE-HOMED on the embedded file
// (`packages/sdk/embedded/snug-hooks.js`) — the kv key and the event names still read from the
// module SDK's source, the bounds from the protocol; every "listener" sentence is rewritten.
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
/** The copy-exactly hooks block every app carries (PR-6: sections 1–7) — the form the KB teaches. */
const EMBEDDED_HOOKS = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'embedded', 'snug-hooks.js'), 'utf8');
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

/** The module SDK's remembered-runs bound, read from its source so both forms forget at the same size. */
const SDK_REMEMBERED_RUNS = (() => {
  const match = /const REMEMBERED_RUNS = (\d+);/.exec(SDK_SCHEDULE_SOURCE);
  if (match === null) throw new Error('packages/sdk/src/schedule.ts no longer declares REMEMBERED_RUNS');
  return Number(match[1]);
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

/**
 * One numbered section of the embedded hooks block: from the `// ====` line above `// <n>.` to the
 * line before the `// ====` line above the next numbered banner (or the end of the file).
 * `undefined` while the section does not exist — a red row, never a thrown suite.
 */
function embeddedSection(n: number): string | undefined {
  const lines = EMBEDDED_HOOKS.split('\n');
  const at = lines.findIndex((line) => line.trim().startsWith(`// ${n}. `));
  if (at < 1) return undefined;
  const next = lines.findIndex((line, i) => i > at && /^\s*\/\/ \d+\. /.test(line));
  return lines.slice(at - 1, next === -1 ? undefined : next - 1).join('\n');
}

/**
 * The text of every call to `callee` in `code`, from the callee to its balancing `)`. The fences
 * carry no unbalanced parenthesis inside a string, so a paren count is enough here.
 */
function callBlocks(code: string, callee: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const pattern = new RegExp(`\\b${callee}\\(`, 'g');
  for (const match of code.matchAll(pattern)) {
    const start = match.index as number;
    let depth = 0;
    let end = start + callee.length;
    for (; end < code.length; end += 1) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')' && --depth === 0) break;
    }
    out.push({ index: start, text: code.slice(start, end + 1) });
  }
  return out;
}

/** The nearest enclosing declaration before `index` whose name matches `name` (a component, a handler). */
function enclosingName(code: string, index: number, name: RegExp): string | undefined {
  const before = code.slice(0, index);
  const declared = [...before.matchAll(/(?:function\s+([A-Za-z_]\w*)\s*\(|(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?(?:\(|function\b|[A-Za-z_]\w*\s*=>))/g)]
    .map((m) => (m[1] ?? m[2]) as string)
    .filter((declaredName) => name.test(declaredName));
  return declared.at(-1);
}

/** Whether `index` sits inside a JSX event attribute — `onClick={…}` and its kin. */
function insideJsxHandler(code: string, index: number): boolean {
  for (const match of code.matchAll(/\bon[A-Z]\w*=\{/g)) {
    const open = (match.index as number) + match[0].length - 1;
    if (open > index) break;
    let depth = 0;
    let close = open;
    for (; close < code.length; close += 1) {
      if (code[close] === '{') depth += 1;
      else if (code[close] === '}' && --depth === 0) break;
    }
    if (index > open && index < close) return true;
  }
  return false;
}

/** The Snug names a page teaches — the hooks and the helpers an app calls — never React's own hooks. */
const SNUG_NAMES = /\b(use(?:Snug\w*|PersistedState|AppDB|ConnectedFetch|HostEvents)|proposeSchedule|scheduleInputKey|onHostEvent)\b/g;

/** PR-6 (D-PR6-6): the one migration sentence, verbatim. */
const SCHEDULE_MIGRATION =
  'An app that still carries the older schedule listener: delete it, `SCHEDULE_HANDLED` included, when you copy section 6 — both would answer.';

describe('P4 — the file is in the store, out of the inline core, with its headings pinned', () => {
  it('exists, renders, and is NOT in the inline core (a tool-free brain gets the amended rule in 10 and 80 instead)', () => {
    expect(rendered(KB_FILE)).toContain('# Scheduled Runs');
    expect(INLINE_KNOWLEDGE_CORE_FILES).not.toContain(KB_FILE);
  });

  it('the heading tree is pinned — these are the retrieval keys (PR-6: "## The Schedule Hook")', () => {
    const section = getKnowledgeBase().find((doc) => doc.file === KB_FILE)!;
    expect(section.headingTree).toEqual([
      '# Scheduled Runs',
      "## The Host's Scheduler Is the One Timer",
      '## The Scheduled-Run Handshake',
      // PR-6 (D-PR6-6): "## The Schedule Listener (copy beside the hooks block)" → the hook. The rest unchanged.
      '## The Schedule Hook',
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
    // PR-6: `{{protocolVersion}}` is no longer pinned here — the only place 85 used it was the
    // retired listener's `data.v !==` guard (D-PR6-6); the bridge's guard is section 1's now.
    for (const literal of Object.values(FRAME_TYPES)) expect(text, `source retypes ${literal}`).not.toContain(literal);
  });

  // ---- PR-6 (D-PR6-6; AC40f): ONE javascript fence, the COMPONENT -------------------------------
  it('PR-6: the page keeps exactly ONE javascript fence, and it sits under "## The Schedule Hook"', () => {
    const text = rendered(KB_FILE);
    expect(fencedJs(text)).toHaveLength(1);
    const hookStart = text.indexOf('\n## The Schedule Hook\n');
    expect(hookStart, 'the "## The Schedule Hook" section').toBeGreaterThanOrEqual(0);
    const hookEnd = text.indexOf('\n## ', hookStart + 1);
    expect(fencedJs(text.slice(hookStart, hookEnd === -1 ? undefined : hookEnd))).toHaveLength(1);
    // "## Suggesting a Schedule" keeps its heading and prose; its raw-post fence is GONE.
    const suggestStart = text.indexOf('\n## Suggesting a Schedule\n');
    expect(suggestStart).toBeGreaterThanOrEqual(0);
    const suggestEnd = text.indexOf('\n## ', suggestStart + 1);
    expect(fencedJs(text.slice(suggestStart, suggestEnd === -1 ? undefined : suggestEnd))).toHaveLength(0);
  });

  it('PR-6: the fence is the component — useSnugSchedule(onScheduledRun) mounted ONCE in the component that calls useSnugApp, before any early return', () => {
    const [component] = fencedJs(rendered(KB_FILE));
    expect(component).toBeDefined();
    const code = component as string;
    const mounts = callBlocks(code, 'useSnugSchedule');
    expect(mounts, 'useSnugSchedule is mounted once').toHaveLength(1);
    expect(mounts[0]?.text).toBe('useSnugSchedule(onScheduledRun)');
    const app = callBlocks(code, 'useSnugApp');
    expect(app, 'the component calls useSnugApp').toHaveLength(1);
    const componentOfMount = enclosingName(code, mounts[0]!.index, /^[A-Z]/);
    expect(componentOfMount, 'the hook is mounted inside a component').toBeDefined();
    expect(enclosingName(code, app[0]!.index, /^[A-Z]/), 'useSnugApp and useSnugSchedule share one component').toBe(componentOfMount);
    // Before any early return: no JSX/null return precedes the mount.
    const firstRender = code.search(/\breturn\s*(?:\(\s*<|<|null\b)/);
    if (firstRender !== -1) expect(mounts[0]!.index, 'the hook is called before the first render return').toBeLessThan(firstRender);
    // Never inside an effect or a condition's body: hooks are called at the top level.
    for (const effect of callBlocks(code, 'useEffect')) expect(effect.text).not.toContain('useSnugSchedule(');
  });

  it('PR-6: the handler answers { ok, summary, notify? } over the app\'s own hooks — no plumbing, no timers', () => {
    const [component] = fencedJs(rendered(KB_FILE));
    const code = component ?? '';
    expect(code).toMatch(/\bonScheduledRun\b/);
    expect(code).toMatch(/useAppDB\(\)|useConnectedFetch\(\)/);
    expect(code).toMatch(/\bok: (?:true|false)\b/);
    expect(code).toMatch(/\bsummary:/);
    expect(code).toMatch(/\bnotify\b/);
    // NEGATIVE: the retired snippet's plumbing is gone — never a raw post, a second listener, the old set.
    expect(code).not.toContain('SnugBridge.post');
    expect(code).not.toContain('postMessage(');
    expect(code).not.toContain("addEventListener('message'");
    expect(code).not.toContain('snugDbRequest');
    expect(code).not.toContain('SCHEDULE_HANDLED');
    expect(code).not.toContain(`'${REQUEST_EVENT}'`);
    expect(code).not.toContain(`'${RUN_EVENT}'`);
    expect(code).not.toMatch(/setTimeout|setInterval/);
  });

  it('PR-6: the suggestion is proposeSchedule({ title, steps, spec }) from a user act, its boolean honoured — never a raw SnugBridge.post', () => {
    const [component] = fencedJs(rendered(KB_FILE));
    const code = component ?? '';
    const calls = callBlocks(code, 'proposeSchedule');
    expect(calls, 'one proposeSchedule call').toHaveLength(1);
    const call = calls[0]!;
    // `true` means SENT: the app remembers "suggested" only then.
    expect(code).toMatch(/if \((?:[^()]*&&\s*)?proposeSchedule\(\{[\s\S]*?\}\)\)\s*\{?\s*setSuggested\(true\)/);
    // The proposal shape scheduleProposalSchema has: a title, steps naming only THIS app, a spec.
    expect(call.text).toMatch(/title: '[^']+'/);
    const stepAppId = /steps: \[\{ kind: 'app-run', appId: '([^']+)'/.exec(call.text)?.[1];
    const ownAppId = /appId: '([^']+)'/.exec(callBlocks(code, 'useSnugApp')[0]?.text ?? '')?.[1];
    expect(stepAppId, 'the step is an app-run naming an appId').toBeDefined();
    expect(stepAppId, 'the step names THIS app — the appId passed to useSnugApp').toBe(ownAppId);
    expect(call.text).toMatch(/spec: \{ kind: '(?:once|every|daily|weekly|monthly|custom)'/);
    // From a user act: inside an on…/handle… handler or a JSX on…={…} attribute — never the
    // scheduled handler, never an effect.
    const handler = enclosingName(code, call.index, /^(?:on|handle)[A-Z]/);
    const fromUserAct = insideJsxHandler(code, call.index) || (handler !== undefined && handler !== 'onScheduledRun');
    expect(fromUserAct, `proposeSchedule is called from a user act (nearest handler: ${handler})`).toBe(true);
    for (const effect of callBlocks(code, 'useEffect')) expect(effect.text).not.toContain('proposeSchedule(');
  });

  it('PR-6: every Snug hook the page names is a function the embedded hooks block defines', () => {
    const names = new Set([...rendered(KB_FILE).matchAll(SNUG_NAMES)].map((m) => m[1] as string));
    for (const name of ['useSnugSchedule', 'proposeSchedule']) expect(names, `85 teaches ${name}`).toContain(name);
    for (const name of names) expect(EMBEDDED_HOOKS, `embedded/snug-hooks.js defines ${name}`).toContain(`function ${name}(`);
  });

  // ---- PR-6: the content-sync rows RE-HOMED on the embedded file (section 6) ---------------------
  it('PR-6: section 6 hears the SDK’s run event, reads the input under the SDK’s kv key, and answers ONE result on the real app-event frame type', () => {
    const six = embeddedSection(6);
    expect(six, 'the embedded hooks block has a section 6').toBeDefined();
    const code = six as string;
    expect(code).toContain(`function scheduleInputKey(runId) { return '${KV_PREFIX}' + runId; }`);
    expect(code).toContain(`onHostEvent('${RUN_EVENT}',`);
    expect(code).toContain("snugDbRequest('kvGet', { key: scheduleInputKey(data.runId) })");
    expect(code).toContain(`SnugBridge.post({ type: '${FRAME_TYPES.appEvent}', event: '${RESULT_EVENT}', data: result });`);
    // No plumbing of its own: the bridge's helpers, never a hand-rolled postMessage.
    expect(code).not.toContain('postMessage(');
  });

  it('PR-6: section 6 is idempotent by runId (remembered BEFORE the kv read, the module’s bound), and a throw becomes a BOUNDED ok:false', () => {
    const code = embeddedSection(6) ?? '';
    expect(code).toContain('if (snugScheduleAnswered.has(data.runId)) return;');
    expect(code.indexOf('snugScheduleAnswered.add(data.runId);'), 'remembered').toBeGreaterThanOrEqual(0);
    expect(code.indexOf('snugScheduleAnswered.add(data.runId);'), 'remembered BEFORE the kv round trip').toBeLessThan(code.indexOf("snugDbRequest('kvGet'"));
    expect(code).toContain(`const SNUG_SCHEDULE_REMEMBERED = ${SDK_REMEMBERED_RUNS};`);
    expect(code).toMatch(/catch \(err\) \{\s*const message = err && err\.message;\s*result = \{ ok: false, summary: typeof message === 'string' && message !== '' \? message\.slice\(0, (\d+)\) : 'the scheduled run failed' \};/);
    expect(/message\.slice\(0, (\d+)\)/.exec(code)?.[1]).toBe(String(SCHEDULE_STEP_SUMMARY_MAX_CHARS));
  });

  it('PR-6: section 6’s result bounds and proposal post are the protocol’s and the SDK’s — never retyped', () => {
    const code = embeddedSection(6) ?? '';
    expect(code).toContain(`out.summary = raw.summary.slice(0, ${SCHEDULE_STEP_SUMMARY_MAX_CHARS});`);
    expect(code).toContain(`out.notify = { title: n.title.slice(0, ${SCHEDULE_TITLE_MAX_CHARS}), body: n.body.slice(0, ${SCHEDULE_NOTIFY_BODY_MAX_CHARS}) };`);
    expect(code).toContain(`SnugBridge.post({ type: '${FRAME_TYPES.appEvent}', event: '${REQUEST_EVENT}', data: proposal });`);
    // Once per page, and the flag is set only AFTER a successful post (D-PR6-3).
    const post = code.indexOf(`event: '${REQUEST_EVENT}'`);
    const flag = code.indexOf('snugScheduleProposed = true;');
    expect(post).toBeGreaterThanOrEqual(0);
    expect(flag, 'the once-per-page flag is set after the post').toBeGreaterThan(post);
    // Strict at the top level: only title, steps, spec.
    expect(code).toContain("if (key !== 'title' && key !== 'steps' && key !== 'spec') return false;");
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
    // PR-6 (D-PR6-3): the embedded block and `@snugprotocol/sdk` carry the SAME two names now — the
    // page names them (was: "the module form is named beside the embedded snippet").
    expect(text).toMatch(/`useSnugSchedule\(/);
    expect(text).toMatch(/`proposeSchedule\(/);
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
    // PR-6 (D-PR6-6, :207-209): "until the listener ships" is rewritten — the hook is what ships now.
    expect(text).toContain(`records *${RESULT_STATUS_WORD.failed}* after ${RESULT_TIMEOUT_S} s`);
    expect(text).not.toContain('until the listener ships');
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
  it('10 keeps its sentence and now names the host’s scheduler as the one timer and the HOOK as the only way in (PR-6: listener → hook)', () => {
    const text = prose(rendered(KB_OVERVIEW));
    expect(text).toMatch(/never send one from a timer, an interval, or on load/);
    expect(text).toContain("The host's scheduler is the one timer");
    expect(text).toContain('the schedule hook in "Scheduled Runs" is the only way an app takes part');
    expect(text).not.toContain('the schedule listener');
    expect(text).toContain('- "Scheduled Runs" —'); // the section map
  });

  it('80 keeps "## Never Think on a Timer" with setInterval / on load / bill, and names the one timer', () => {
    const text = prose(rendered(KB_CDN));
    expect(text).toMatch(/## Never Think on a Timer/);
    expect(text).toMatch(/setInterval/);
    expect(text).toContain('The ONE timer is the host\'s scheduler');
    expect(text).toContain('an app never arms a timer of its own to think, fetch or remind');
    // PR-6 (D-PR6-6, 80:53): the same rename as 10 — the hook, never the listener.
    expect(text).toContain('the schedule hook in "Scheduled Runs" is the only way an app takes part');
    expect(text).not.toContain('the schedule listener');
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-6; AC40f): KB 85 reads true against the hook.
// Every "listener" sentence the contract lists (:24, :65-66, :118, :142, :155-156, :164, :207-209)
// is rewritten; the idempotency and handover bodies no longer name `SCHEDULE_HANDLED` and still
// tell the author to persist the runId before a side effect — through `db.exec`, FIRST; the one
// migration sentence names the retired set exactly once.
// =========================================================================================
describe('PR-6 — KB 85 reads true against the schedule hook (D-PR6-6)', () => {
  /** One `##` section of the rendered page, up to the next `##`. */
  const section85 = (heading: string): string => {
    const text = rendered(KB_FILE);
    const start = text.indexOf(`\n${heading}\n`);
    expect(start, `${heading} is in the file`).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\n## ', start + heading.length + 1);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it('carries the migration sentence exactly once, verbatim', () => {
    expect(prose(rendered(KB_FILE)).split(SCHEDULE_MIGRATION).length - 1).toBe(1);
  });

  it('names `SCHEDULE_HANDLED` ONLY in the migration sentence — never in a rule body or the fence', () => {
    const text = prose(rendered(KB_FILE));
    expect(text.split('SCHEDULE_HANDLED').length - 1, 'one mention, the migration sentence').toBe(1);
    expect(section85('## Rules for a Scheduled Handler')).not.toContain('SCHEDULE_HANDLED');
    expect(fencedJs(rendered(KB_FILE)).join('\n')).not.toContain('SCHEDULE_HANDLED');
  });

  it('says "listener" nowhere but the migration sentence — every listener sentence is rewritten', () => {
    const text = prose(rendered(KB_FILE)).replace(SCHEDULE_MIGRATION, ' ');
    expect(text.match(/\blisteners?\b/i)?.[0], 'a listener sentence survived').toBeUndefined();
    // The scan can fail: the planted old sentence is caught.
    expect('this listener is the only way an app takes part'.match(/\blisteners?\b/i)).not.toBeNull();
  });

  it('the rewritten listener sentences say "hook" — :24, :65-66 (verbatim per the contract), :155-156', () => {
    const text = prose(rendered(KB_FILE));
    expect(text).toMatch(/it ANSWERS a scheduled run through [^.;]*\bhook\b/);
    expect(text).toMatch(/[Aa]n app without the hook cannot be asked/);
    expect(text).toMatch(/\bhook is the only way an app takes part/);
  });

  it('idempotency and handover: the hook remembers runIds for THIS page only; a handed-over run reaches a fresh page; persist the runId through `db.exec` FIRST — never `usePersistedState`', () => {
    const rules = prose(section85('## Rules for a Scheduled Handler'));
    expect(rules).toMatch(/\*\*Idempotent by `runId`\.\*\*/);
    expect(rules).toMatch(/\*\*One instance — and the same `runId` can reach a different one\.\*\*/);
    expect(rules).toMatch(/this page only/i);
    expect(rules).toMatch(/fresh page/i);
    // Still tells the author to persist the runId before a side effect — and HOW: db.exec first.
    expect(rules).toMatch(/`runId`[^.]*`db\.exec`[^.]*\bfirst\b/i);
    expect(rules).toContain('never `usePersistedState`');
    // NEGATIVE: the old advice — "your own persisted state" — would send the author to the fire-and-forget kvSet.
    expect(rules).not.toMatch(/remember the `runId` you acted on in your own persisted state/);
  });

  it('suggesting: "true means the suggestion was sent — remember it only then"', () => {
    const text = prose(rendered(KB_FILE));
    expect(text).toMatch(/`?true`? means the suggestion was sent — remember it only then/i);
  });

  it('prompts/README.md’s row for 85 says "the schedule hook" — never the listener snippet', () => {
    const readme = readFileSync(path.join(repoRoot, 'packages', 'knowledge', 'prompts', 'README.md'), 'utf8');
    const lines = readme.split('\n');
    const start = lines.findIndex((line) => line.includes('85-scheduled-runs.md'));
    expect(start, 'the README lists 85').toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && /[├└]── /.test(line));
    const row = prose(lines.slice(start, end === -1 ? undefined : end).join(' ').replace(/[│├└─←]/g, ' '));
    expect(row).toContain('the schedule hook');
    expect(row).not.toMatch(/\blistener\b/);
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

// TASK-20261010-host-broker PR-4 (AC32e; D-PR4-22): KB 85 learns that a schedule may make changes on
// its own — ONE sentence in the timer section (only the USER turns that on, for its own app's data,
// with an undo) and ONE bullet under "What the Host Shows"; NO new heading (the heading tree above
// stays pinned — the retrieval keys do not move). An app can never arm it: the KB names no seat an
// app could write.
describe('PR-4 — KB 85: a schedule may make changes on its own (one sentence, one bullet, no new heading)', () => {
  const TIMER = "## The Host's Scheduler Is the One Timer";
  const HANDSHAKE = '## The Scheduled-Run Handshake';
  const SHOWS = '## What the Host Shows';

  /** The text of one `##` section of the rendered file (up to the next `##` heading). */
  const section = (heading: string): string => {
    const text = rendered(KB_FILE);
    const start = text.indexOf(heading);
    expect(start, `${heading} is in the file`).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\n## ', start + heading.length);
    return text.slice(start, next === -1 ? undefined : next);
  };

  it('the timer section carries the sentence: only the user turns it on, for its own app’s data, with an undo', () => {
    expect(rendered(KB_FILE).indexOf(HANDSHAKE)).toBeGreaterThan(rendered(KB_FILE).indexOf(TIMER));
    expect(prose(section(TIMER))).toMatch(/[Aa] schedule may make changes on its own — only the user turns that on, for its own app's data, with an undo/);
  });

  it('"What the Host Shows" gains one bullet about the changes a schedule made on its own, with their undo', () => {
    const bullets = section(SHOWS)
      .split('\n')
      .filter((line) => /^\s*[-*] /.test(line));
    const about = bullets.filter((line) => /on its own/.test(line));
    expect(about, 'one bullet names it').toHaveLength(1);
    expect(prose(section(SHOWS))).toMatch(/undo/);
  });

  it('NEGATIVE: the KB names no seat an app could write to arm it — the user turns it on in the host', () => {
    const text = rendered(KB_FILE);
    expect(text).not.toContain('writeAuthority');
    expect(text).not.toContain('ownUndo:');
    expect(prose(text)).not.toMatch(/your app (can|may) (turn|switch) (it|this) on/i);
  });
});
