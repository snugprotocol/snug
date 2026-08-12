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

import { createAppTargetSink } from '../agent/artifactSink.js';
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
  it('ships six tools with store-sourced names', async () => {
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
    ]);
    for (const tool of tools) expect(tool.def.description.length).toBeGreaterThan(100);
  });
});
