/**
 * TASK-20260811-lean-runtime-data-chat, P4 — the `artifact_edit` tool (ADR-0019 D10).
 *
 * WHY A SECOND WRITE TOOL. `artifact_write` takes the ENTIRE file, so "make the button
 * blue" costs a full rewrite of a 100 KB app — slow, expensive, and a fresh chance to
 * lose something that was working. This is the owner's "edit only the needed parts".
 *
 * UNIQUE-MATCH-OR-FAIL IS THE WHOLE SAFETY STORY. The edit is applied host-side and every
 * `oldString` must appear EXACTLY once. An ambiguous match is the dangerous case — the
 * model meant one occurrence and would silently get another — so it fails the whole call
 * rather than guessing. The model can then retry with more context or fall back to a
 * whole-file write, both of which are cheap; a wrong edit is not.
 *
 * ATOMIC: any failure leaves the version history untouched. A partially-applied edit would
 * be worse than a refused one.
 */

import { describe, expect, it } from 'vitest';
import { ARTIFACT_EDIT_TOOL_NAME } from '@snugprotocol/knowledge';
import type { AgentTool } from '@snugprotocol/adapters';

import { createAppTargetSink } from '../agent/artifactSink.js';
import { buildByokTools } from '../agent/tools.js';
import { installTestUserDb } from './userdbTestHelper.js';

const HTML = `<!DOCTYPE html>
<html>
  <head><title>Counter</title></head>
  <body>
    <button id="inc" style="color: red">increment</button>
    <button id="dec" style="color: green">decrement</button>
  </body>
</html>`;

async function pinned(): Promise<{
  db: Awaited<ReturnType<typeof installTestUserDb>>;
  appId: string;
  tool: AgentTool;
}> {
  const db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Counter', html: HTML });
  const sink = createAppTargetSink({ pinnedAppId: app.appId, getDb: () => Promise.resolve(db) });
  const tools = buildByokTools(sink, { onArtifact: () => undefined }, { getDb: () => Promise.resolve(db) });
  const tool = tools.find((entry) => entry.def.name === ARTIFACT_EDIT_TOOL_NAME);
  if (tool === undefined) throw new Error('artifact_edit is not registered');
  return { db, appId: app.appId, tool };
}

describe('applying an edit', () => {
  it('replaces a unique string and lands a NEW version', async () => {
    const { db, appId, tool } = await pinned();

    const result = await tool.run({
      edits: [{ oldString: '<button id="inc" style="color: red">', newString: '<button id="inc" style="color: blue">' }],
    });

    expect(String(result)).not.toMatch(/^Error:/);
    const html = db.getAppHtml(appId) ?? '';
    expect(html).toContain('style="color: blue"');
    expect(html).not.toContain('style="color: red"');
    expect(db.getApp(appId)?.currentVersion).toBe(2);
  });

  it('leaves everything it was not asked to change byte-identical', async () => {
    const { db, appId, tool } = await pinned();

    await tool.run({ edits: [{ oldString: 'increment', newString: 'add one' }] });

    const html = db.getAppHtml(appId) ?? '';
    expect(html).toContain('<title>Counter</title>');
    expect(html).toContain('style="color: green"');
    expect(html.replace('add one', 'increment')).toBe(HTML);
  });

  it('applies several edits in one call', async () => {
    const { db, appId, tool } = await pinned();

    await tool.run({
      edits: [
        { oldString: 'color: red', newString: 'color: blue' },
        { oldString: 'color: green', newString: 'color: teal' },
      ],
    });

    const html = db.getAppHtml(appId) ?? '';
    expect(html).toContain('color: blue');
    expect(html).toContain('color: teal');
    expect(db.getApp(appId)?.currentVersion).toBe(2);
  });

  it('produces the SAME result a whole-file write would have', async () => {
    // The invariant that makes this tool safe to add: it is a cheaper route to a version
    // that `artifact_write` could have produced, not a different kind of write.
    const { db, appId, tool } = await pinned();
    await tool.run({ edits: [{ oldString: 'color: red', newString: 'color: blue' }] });
    expect(db.getAppHtml(appId)).toBe(HTML.replace('color: red', 'color: blue'));
  });

  it('the edited version carries the runtime contract forward (ADR-0018 D2)', async () => {
    const { db, appId, tool } = await pinned();
    const { runtimeContractSchema } = await import('@snugprotocol/protocol');
    db.putRuntimeContract(appId, 1, runtimeContractSchema.parse({ overview: 'A counter app.' }));

    await tool.run({ edits: [{ oldString: 'color: red', newString: 'color: blue' }] });

    expect(db.getRuntimeContract(appId)?.overview).toBe('A counter app.');
  });
});

describe('unique-match-or-fail', () => {
  it('refuses an AMBIGUOUS match and changes nothing', async () => {
    const { db, appId, tool } = await pinned();

    // '<button' appears twice — the model meant one of them and cannot say which.
    const result = await tool.run({ edits: [{ oldString: '<button', newString: '<a' }] });

    expect(String(result)).toMatch(/^Error:/);
    expect(String(result)).toMatch(/2|twice|more than once|unique/i);
    expect(db.getAppHtml(appId)).toBe(HTML);
    expect(db.getApp(appId)?.currentVersion).toBe(1);
  });

  it('refuses a MISSING match and changes nothing', async () => {
    const { db, appId, tool } = await pinned();

    const result = await tool.run({ edits: [{ oldString: 'this text is not in the file', newString: 'x' }] });

    expect(String(result)).toMatch(/^Error:/);
    expect(db.getAppHtml(appId)).toBe(HTML);
    expect(db.getApp(appId)?.currentVersion).toBe(1);
  });

  it('ATOMIC: one bad edit in a batch discards the whole batch', async () => {
    const { db, appId, tool } = await pinned();

    const result = await tool.run({
      edits: [
        { oldString: 'color: red', newString: 'color: blue' },
        { oldString: 'not present anywhere', newString: 'x' },
      ],
    });

    expect(String(result)).toMatch(/^Error:/);
    // The FIRST edit was valid; it must not have landed on its own.
    expect(db.getAppHtml(appId)).toBe(HTML);
    expect(db.getApp(appId)?.currentVersion).toBe(1);
  });

  it('checks uniqueness against the text as it stands AFTER earlier edits in the batch', async () => {
    // Sequential application can CREATE an ambiguity that did not exist at the start.
    const { db, appId, tool } = await pinned();

    const result = await tool.run({
      edits: [
        { oldString: 'color: green', newString: 'color: red' },
        // now 'color: red' matches twice
        { oldString: 'color: red', newString: 'color: black' },
      ],
    });

    expect(String(result)).toMatch(/^Error:/);
    expect(db.getAppHtml(appId)).toBe(HTML);
  });
});

describe('validation and edges', () => {
  it('rejects a malformed edits argument without throwing', async () => {
    const { tool } = await pinned();
    for (const bad of [{}, { edits: [] }, { edits: 'nope' }, { edits: [{ oldString: 5, newString: 'x' }] }]) {
      await expect(tool.run(bad as Record<string, unknown>)).resolves.toMatch(/^Error:/);
    }
  });

  it('rejects an empty oldString — it would match everywhere', async () => {
    const { tool } = await pinned();
    expect(String(await tool.run({ edits: [{ oldString: '', newString: 'x' }] }))).toMatch(/^Error:/);
  });

  it('allows an empty newString (deleting a fragment)', async () => {
    const { db, appId, tool } = await pinned();
    await tool.run({ edits: [{ oldString: ' style="color: red"', newString: '' }] });
    expect(db.getAppHtml(appId) ?? '').toContain('<button id="inc">');
  });

  it('refuses when the app has no artifact yet', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const tools = buildByokTools(sink, { onArtifact: () => undefined }, { getDb: () => Promise.resolve(db) });
    const tool = tools.find((entry) => entry.def.name === ARTIFACT_EDIT_TOOL_NAME)!;

    const result = await tool.run({ edits: [{ oldString: 'a', newString: 'b' }] });

    expect(String(result)).toMatch(/^Error:/);
    expect(db.listApps()).toHaveLength(0);
  });

  it('the target is host-pinned — the tool schema has no app id seat', async () => {
    const { tool } = await pinned();
    const properties = (tool.def.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(properties)).toEqual(['edits']);
  });
});
