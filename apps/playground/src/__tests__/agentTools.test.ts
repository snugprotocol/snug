// Child-2 (TASK-20260803-schema-doc-tools): the direct-mode tool set grows schema_apply
// and app_doc_write. Both resolve their target through the artifact sink's host-side
// pin (never an LLM-claimed id), and schema_apply works BEFORE the first artifact write
// (the sink pre-mints the builder thread's app id so schema-first building is possible).

import { describe, expect, it } from 'vitest';
import {
  APP_DOC_WRITE_TOOL_NAME,
  ARTIFACT_EDIT_TOOL_NAME,
  RUNTIME_CONTRACT_WRITE_TOOL_NAME,
  SCHEMA_APPLY_TOOL_NAME,
} from '@snugprotocol/knowledge';

import type { ScheduleProposal } from '@snugprotocol/protocol';

import { createAppTargetSink } from '../agent/artifactSink.js';
import { SCHEDULE_PROPOSE_TOOL_NAME, buildScheduleProposeTool } from '../agent/scheduleProposeTool.js';
import { buildByokTools } from '../agent/tools.js';
import { installTestUserDb } from './userdbTestHelper.js';

const html = `<!DOCTYPE html><html><head><title>Portfolio</title></head></html>`;
const noopHooks = { onArtifact: () => undefined };

describe('schema_apply tool', () => {
  it('applies statements to the pinned app and reports the registered schema', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Portfolio', html });
    const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, noopHooks, { getDb: () => Promise.resolve(db) });
    const schemaApply = tools.find((t) => t.def.name === SCHEMA_APPLY_TOOL_NAME)!;

    const result = await schemaApply.run({
      statements: ['CREATE TABLE holdings (symbol TEXT PRIMARY KEY, qty REAL)', 'CREATE TABLE trades (id INTEGER PRIMARY KEY, symbol TEXT)'],
    });
    expect(String(result)).toContain('holdings');
    expect(db.getAppSchema(app.appId)?.objects.map((o) => o.name)).toEqual(['holdings', 'trades']);
    expect(db.listAppMigrations(app.appId)).toHaveLength(2);
  });

  it('schema-first: works before the first artifact write, and the app then installs under the SAME id', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, noopHooks, { getDb: () => Promise.resolve(db) });
    const schemaApply = tools.find((t) => t.def.name === SCHEMA_APPLY_TOOL_NAME)!;

    await schemaApply.run({ statements: ['CREATE TABLE habits (id INTEGER PRIMARY KEY, name TEXT)'] });
    const write = await sink.write(html, 'Habits');
    expect(db.getAppSchema(write.id)?.objects.map((o) => o.name)).toEqual(['habits']);
    expect(db.listApps()).toHaveLength(1);
  });

  it('surfaces failures as tool-result text (bad SQL, reserved names) without persisting anything', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'P', html });
    const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, noopHooks, { getDb: () => Promise.resolve(db) });
    const schemaApply = tools.find((t) => t.def.name === SCHEMA_APPLY_TOOL_NAME)!;

    const bad = await schemaApply.run({ statements: ['CREATE TABLE snug_evil (v)'] });
    expect(String(bad)).toMatch(/^Error:/);
    expect(db.getAppSchema(app.appId)).toBeUndefined();
    const empty = await schemaApply.run({ statements: [] });
    expect(String(empty)).toMatch(/^Error:/);
  });
});

describe('app_doc_write tool', () => {
  it('writes wiki docs for the pinned app and fires the hook', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'P', html });
    const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
    const written: string[] = [];
    const tools = buildByokTools(
      sink,
      { onArtifact: () => undefined, onDocWritten: (_appId, slug) => written.push(slug) },
      { getDb: () => Promise.resolve(db) },
    );
    const docWrite = tools.find((t) => t.def.name === APP_DOC_WRITE_TOOL_NAME)!;

    await docWrite.run({ slug: 'vision', title: 'Vision', content: '# What this app is for' });
    await docWrite.run({ slug: 'next-tasks', content: '- add dark mode' });
    expect(db.getAppDoc(app.appId, 'vision')).toMatchObject({ title: 'Vision', content: '# What this app is for' });
    expect(db.getAppDoc(app.appId, 'next-tasks')?.content).toContain('dark mode');
    expect(written).toEqual(['vision', 'next-tasks']);
  });

  it('rejects bad slugs and empty content as tool-result text', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'P', html });
    const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, noopHooks, { getDb: () => Promise.resolve(db) });
    const docWrite = tools.find((t) => t.def.name === APP_DOC_WRITE_TOOL_NAME)!;

    expect(String(await docWrite.run({ slug: 'Not A Slug', content: 'x' }))).toMatch(/^Error:/);
    expect(String(await docWrite.run({ slug: 'vision', content: '' }))).toMatch(/^Error:/);
    expect(db.listAppDocs(app.appId)).toHaveLength(0);
  });
});

describe('tool set shape', () => {
  it('ships seven tools with store-sourced names', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, noopHooks, { getDb: () => Promise.resolve(db) });
    expect(tools.map((t) => t.def.name)).toEqual([
      'snug_app_builder',
      'artifact_write',
      // TASK-20260811 (ADR-0019 D10): targeted edits, beside the whole-file write.
      ARTIFACT_EDIT_TOOL_NAME,
      SCHEMA_APPLY_TOOL_NAME,
      APP_DOC_WRITE_TOOL_NAME,
      // TASK-20260811 (ADR-0018 D5): the builder also authors the app's RUNTIME contract.
      RUNTIME_CONTRACT_WRITE_TOOL_NAME,
      // TASK-20261009 (ADR-0074 §4): the builder may SUGGEST a schedule — propose-only.
      SCHEDULE_PROPOSE_TOOL_NAME,
    ]);
    for (const tool of tools) expect(tool.def.description.length).toBeGreaterThan(100);
  });
});

// TASK-20261009-scheduling-framework P1: `schedule_propose` stages ONE suggestion per turn on the
// message (through the hook) and creates nothing. The SINK PINS THE APP: every app step is for
// the thread's app, resolved host-side; a step naming another app, a step carrying queries, a
// step for an app the file does not hold yet, an unreadable when and a cadence under the
// suggested floor are each refused in the tool result — before anything is staged.
describe('schedule_propose tool', () => {
  const NOW = new Date('2026-10-09T12:20:00.000Z');
  const steps = [{ kind: 'app-think', prompt: 'Sum up yesterday.' }];

  async function setup(options: { withApp?: boolean; hook?: boolean } = {}) {
    const db = await installTestUserDb();
    const app = options.withApp === false ? undefined : db.installApp({ displayName: 'Ledger', html, usesDb: true });
    const staged: Array<{ proposal: ScheduleProposal; appId: string | undefined }> = [];
    const sink = createAppTargetSink({ ...(app !== undefined ? { pinnedAppId: app.appId } : {}), getDb: () => Promise.resolve(db) });
    const tool = buildScheduleProposeTool({
      getDb: () => Promise.resolve(db),
      resolveAppId: () => sink.ensureTargetId(),
      now: () => NOW,
      ...(options.hook === false
        ? {}
        : {
            onProposal: (proposal, appId) => {
              if (staged.length > 0) return false;
              staged.push({ proposal, appId });
              return true;
            },
          }),
    });
    return { db, app, staged, tool };
  }

  it('stages one proposal with the pinned app on every app step and the when read from the sentence; creates nothing', async () => {
    const { db, app, staged, tool } = await setup();
    const answer = String(await tool.run({ title: 'morning summary', when: 'every weekday at 8', steps }));
    expect(answer).toContain('Suggested (NOT scheduled');
    expect(answer).toContain('Weekdays at 8:00 AM');
    expect(staged).toHaveLength(1);
    expect(staged[0]?.appId).toBe(app?.appId);
    expect(staged[0]?.proposal).toEqual({
      title: 'morning summary',
      steps: [{ kind: 'app-think', appId: app?.appId, prompt: 'Sum up yesterday.', context: { maxRows: 50 } }],
      spec: { kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '08:00', tz: 'device' },
    });
    expect(db.listScheduledTasks()).toHaveLength(0);
  });

  it('takes the host’s spec shape when the sentence cannot say it, and a run step’s input verbatim', async () => {
    const { app, staged, tool } = await setup();
    const spec = { kind: 'monthly', on: { kind: 'nth', nth: 2, weekday: 'tue' }, time: '09:30', tz: 'device' };
    await tool.run({ title: 'second tuesday', spec, steps: [{ kind: 'app-run', input: { units: 'metric' } }] });
    expect(staged[0]?.proposal.spec).toEqual(spec);
    expect(staged[0]?.proposal.steps).toEqual([{ kind: 'app-run', appId: app?.appId, input: { units: 'metric' } }]);
  });

  it('refuses a step naming another app, a step carrying queries, and an unreadable when — nothing staged', async () => {
    const { staged, tool } = await setup();
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps: [{ kind: 'app-think', appId: 'someone-else', prompt: 'p' }] }))).toMatch(/^Error: a step may only be for THIS app/);
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps: [{ kind: 'app-think', prompt: 'p', context: { sql: ['SELECT 1'] } }] }))).toMatch(/^Error: leave queries out/);
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps: [{ kind: 'app-think', prompt: 'p', sql: ['SELECT 1'] }] }))).toMatch(/^Error: leave queries out/);
    expect(String(await tool.run({ title: 'x', when: 'whenever you like', steps }))).toMatch(/^Error: give "when" as a plain sentence/);
    expect(String(await tool.run({ title: 'x', steps }))).toMatch(/^Error: give "when"/);
    expect(String(await tool.run({ title: '', when: 'every day at 8', steps }))).toMatch(/^Error: "title"/);
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps: [] }))).toMatch(/^Error: "steps"/);
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps: [{ kind: 'dance' }] }))).toMatch(/^Error: each step/);
    expect(staged).toEqual([]);
  });

  it('refuses a cadence under the suggested floor before staging, naming the floor', async () => {
    const { staged, tool } = await setup();
    const answer = String(await tool.run({ title: 'x', when: 'every 5 minutes', steps }));
    expect(answer).toMatch(/^Error: too often/);
    expect(answer).toContain('suggest a slower cadence');
    expect(staged).toEqual([]);
  });

  it('a thread with no app yet: a reminder is staged with no owner, an app step is refused by name', async () => {
    const { staged, tool } = await setup({ withApp: false });
    expect(String(await tool.run({ title: 'x', when: 'every day at 8', steps }))).toMatch(/^Error: an app-think or app-run step needs an installed app/);
    expect(String(await tool.run({ title: 'nudge', when: 'every day at 20:00', steps: [{ kind: 'notify', title: 'hi', body: 'there' }] }))).toContain('Suggested');
    expect(staged[0]?.appId).toBeUndefined();
    expect(staged[0]?.proposal.steps).toEqual([{ kind: 'notify', title: 'hi', body: 'there' }]);
  });

  it('a second proposal in one turn is NOT staged and the model is told; without a surface it says so too', async () => {
    const { staged, tool } = await setup();
    await tool.run({ title: 'one', when: 'every day at 8', steps });
    expect(String(await tool.run({ title: 'two', when: 'every day at 9', steps }))).toMatch(/^NOT staged: a suggestion is already waiting/);
    expect(staged).toHaveLength(1);
    const { tool: surfaceless } = await setup({ hook: false });
    expect(String(await surfaceless.run({ title: 'x', when: 'every day at 8', steps }))).toMatch(/^NOT staged: suggestions cannot be shown/);
  });
});
