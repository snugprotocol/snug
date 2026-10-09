// proposalWriter.test.ts — TASK-20261009-scheduling-framework P6/P7 (ADR-0074 §4 and its Gate-5
// amendment: ONE consent surface, ONE writer). Every proposal channel — the builder's card, the
// chat lane's card, the app's suggestion strip — lands on `enableProposedTask`, and nothing else
// in `src/` creates a task with a provenance that is not the user's own. The scan reads every
// `createTask(` call under `src/` (tests excluded, the definition and its re-export excluded),
// takes the call's argument text, and refuses any call outside `schedule/enableProposedTask.ts`
// whose provenance is not the literal `'user'`. It proves it can fail on a planted call first.
//
// Then the writer itself: re-parses, pins the owner, records provenance and owner, and hands the
// engine's own refusal back in words.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import { NO_OWNER_REFUSAL, OTHER_APP_REFUSAL, enableProposedTask, namesOnly, parseProposalOrReason } from '../schedule/enableProposedTask.js';
import { __resetSchedulerForTests } from '../schedule/scheduler.js';
import { installTestUserDb } from './userdbTestHelper.js';

const SRC = path.resolve(__dirname, '..');
const WRITER = path.join('schedule', 'enableProposedTask.ts');
/** Where `createTask` is defined and where it is re-exported — not callers. */
const DEFINERS = new Set([path.join('schedule', 'acts.ts'), path.join('schedule', 'scheduler.ts')]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === '__tests__' || entry === 'node_modules') continue;
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out.sort();
}

/** Source text with `//` and block comments blanked, so prose cannot trip or satisfy the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The argument text of every `createTask(` CALL in a source (balanced parentheses; a definition `function createTask(` is skipped). */
export function createTaskCalls(source: string): string[] {
  const code = stripComments(source);
  const calls: string[] = [];
  const pattern = /\bcreateTask\s*\(/g;
  for (const match of code.matchAll(pattern)) {
    const before = code.slice(Math.max(0, match.index - 20), match.index);
    if (/function\s*$/.test(before) || /\.\s*$/.test(before)) continue; // a definition, or a member named createTask
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (i < code.length && depth > 0) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    calls.push(code.slice(start, i - 1));
  }
  return calls;
}

/** A call's provenance, as written: the literal, or `?` when it is not a literal. */
export function provenanceOf(call: string): string {
  const literal = /provenance\s*:\s*'([a-z]+)'/.exec(call);
  if (literal !== null) return literal[1] as string;
  return /provenance\s*:/.test(call) || /\bprovenance\b/.test(call) ? '?' : 'absent';
}

describe('the scan can fail', () => {
  it('finds a planted non-user call and reads a literal provenance', () => {
    const planted = `const r = await createTask({ title: t, steps, spec, provenance: 'app', ownerAppId: id });`;
    expect(createTaskCalls(planted)).toHaveLength(1);
    expect(provenanceOf(createTaskCalls(planted)[0] as string)).toBe('app');
    expect(provenanceOf(`createTask({ provenance: input.provenance })`)).toBe('?');
    expect(provenanceOf(`createTask({ ...input })`)).toBe('absent');
    expect(createTaskCalls(`export async function createTask(input: X) { return x; }`)).toEqual([]);
    expect(createTaskCalls(`// createTask('app')\nconst a = 1;`)).toEqual([]);
    expect(createTaskCalls(`createTask({ a: f(1, (2)) }); createTask({ provenance: 'user' })`)).toHaveLength(2);
  });
});

describe('ONE writer for every proposal channel (P6)', () => {
  it('every createTask call outside enableProposedTask.ts is the user’s own; the writer passes the channel through', () => {
    const offenders: string[] = [];
    let writerCalls = 0;
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file);
      if (DEFINERS.has(rel)) continue;
      const calls = createTaskCalls(readFileSync(file, 'utf8'));
      if (rel === WRITER) {
        writerCalls += calls.length;
        for (const call of calls) expect(provenanceOf(call), `${rel}: the writer records the channel`).toBe('?');
        continue;
      }
      for (const call of calls) {
        if (provenanceOf(call) !== 'user') offenders.push(`${rel}: createTask(${call.trim().slice(0, 80)}…)`);
      }
    }
    expect(writerCalls, 'the writer calls createTask exactly once').toBe(1);
    expect(offenders).toEqual([]);
  });

  it('the surfaces that stage proposals import the writer, not the engine’s createTask', () => {
    for (const rel of [path.join('views', 'ChatLog.tsx'), path.join('schedule', 'SuggestionStrip.tsx'), path.join('schedule', 'scheduleRequest.ts')]) {
      const code = stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
      expect(code, `${rel} reaches the engine directly`).not.toMatch(/\bcreateTask\b/);
      expect(code, `${rel} enables through the writer`).toMatch(/enableProposedTask|acceptSuggestion/);
    }
  });
});

describe('enableProposedTask — the writer (P7)', () => {
  let db: UserDb;
  let ledger: string;
  let other: string;

  beforeEach(async () => {
    __resetSchedulerForTests();
    db = await installTestUserDb();
    ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>', usesDb: true }).appId;
    other = db.installApp({ displayName: 'Other', html: '<!doctype html><title>o</title>' }).appId;
  });

  afterEach(() => {
    __resetSchedulerForTests();
  });

  const think = (appId: string) => ({ kind: 'app-think' as const, appId, prompt: 'Sum it up.', context: { maxRows: 50 } });
  const daily = { kind: 'daily' as const, time: '08:00', tz: 'device' as const };

  it('creates the task ENABLED with the channel’s provenance and the owner, for each channel', async () => {
    for (const provenance of ['builder', 'chat', 'app'] as const) {
      const result = await enableProposedTask({ proposal: { title: `via ${provenance}`, steps: [think(ledger)], spec: daily }, provenance, ownerAppId: ledger });
      expect(result.ok, provenance).toBe(true);
      if (!result.ok) continue;
      expect(result.task).toMatchObject({ enabled: true, provenance, ownerAppId: ledger, title: `via ${provenance}`, cron: '0 8 * * *' });
      expect(result.task.appVersions).toEqual({ [ledger]: 1 });
    }
    expect(db.listScheduledTasks()).toHaveLength(3);
  });

  it('re-parses: an unparseable proposal is refused in words and nothing is written', async () => {
    const result = await enableProposedTask({ proposal: { title: 'x', steps: [], spec: daily }, provenance: 'builder' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/can’t be read/);
    expect(parseProposalOrReason('junk').ok).toBe(false);
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('refuses a step that names an app other than the owner; an app suggestion needs an owner', async () => {
    const foreign = { title: 'x', steps: [think(other)], spec: daily };
    expect(await enableProposedTask({ proposal: foreign, provenance: 'app', ownerAppId: ledger })).toEqual({ ok: false, reason: OTHER_APP_REFUSAL });
    expect(await enableProposedTask({ proposal: foreign, provenance: 'chat', ownerAppId: ledger })).toEqual({ ok: false, reason: OTHER_APP_REFUSAL });
    expect(await enableProposedTask({ proposal: foreign, provenance: 'app' })).toEqual({ ok: false, reason: NO_OWNER_REFUSAL });
    expect(namesOnly(foreign, ledger)).toBe(false);
    expect(namesOnly({ title: 'x', steps: [{ kind: 'notify', title: 'a', body: 'b' }], spec: daily }, ledger)).toBe(true);
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('a reminder-only proposal from the builder needs no owner', async () => {
    const result = await enableProposedTask({ proposal: { title: 'nudge', steps: [{ kind: 'notify', title: 'hi', body: 'there' }], spec: daily }, provenance: 'builder' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.task.ownerAppId).toBeUndefined();
    expect(result.task.missedPolicy).toBe('run-once');
  });

  it('the engine’s floors and refusals come back in the engine’s words: too often, an app not installed', async () => {
    const tooOften = await enableProposedTask({ proposal: { title: 'x', steps: [think(ledger)], spec: { kind: 'every', n: 5, unit: 'minutes', tz: 'device' } }, provenance: 'chat', ownerAppId: ledger });
    expect(tooOften.ok).toBe(false);
    if (!tooOften.ok) expect(tooOften.reason).toContain('a schedule that was suggested or imported may run at most every 15 minutes');
    await db.deleteApp(ledger);
    const gone = await enableProposedTask({ proposal: { title: 'x', steps: [think(ledger)], spec: daily }, provenance: 'app', ownerAppId: ledger });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toContain('is not installed in this file');
    expect(db.listScheduledTasks()).toHaveLength(0);
  });
});
