// appContextCaps.test.ts — TASK-20260905-binding-a-artifacts AC3: `buildAppTurnContext`
// takes per-call caps. The host kit passes `HOST_CONTEXT_CAPS` (html UNBOUNDED — it rides
// whole or the builder refuses; docs/schema/history shrunk to leave room under 64 KiB);
// with no caps the bytes are exactly today's (the web twin).
import { beforeEach, describe, expect, it } from 'vitest';

import { CONTEXT_CAPS, TRUNCATION_MARKER, buildAppTurnContext } from '../agent/appContext.js';
import { HOST_CONTEXT_CAPS } from '../agent/promptBudget.js';
import { installTestUserDb } from './userdbTestHelper.js';

const html = (kb: number): string => `<!doctype html><html><body>${'x'.repeat(kb * 1024)}</body></html>`;

describe('buildAppTurnContext caps', () => {
  let db: Awaited<ReturnType<typeof installTestUserDb>>;
  let appId: string;
  beforeEach(async () => {
    db = await installTestUserDb();
    appId = db.installApp({ displayName: 'Big', usesDb: true, html: html(200) }).appId;
    db.putAppDoc(appId, 'vision', { content: 'v'.repeat(30_000) });
    db.upsertThread('t', { appId, title: 't' });
    for (let i = 0; i < 20; i++) db.appendChatMessage('t', i % 2 === 0 ? 'user' : 'assistant', `turn ${i} ${'h'.repeat(1_000)}`);
  });

  it('default caps: a 200 KB html is cut at 140,000 chars with the marker (today’s bytes)', async () => {
    const ctx = await buildAppTurnContext(db, appId, 't');
    expect(ctx.contextBlock).toContain(TRUNCATION_MARKER);
    expect(ctx.contextBlock).not.toContain(html(200));
    expect(CONTEXT_CAPS.html).toBe(140_000);
  });

  it('host caps: the html rides WHOLE (never the marker); docs and history shrink to the host caps', async () => {
    const ctx = await buildAppTurnContext(db, appId, 't', HOST_CONTEXT_CAPS);
    expect(ctx.contextBlock).toContain(html(200));
    expect(HOST_CONTEXT_CAPS.html).toBe(Number.POSITIVE_INFINITY);
    const docsSection = ctx.contextBlock!.split('### App knowledge docs')[1]!.split('### Current app code')[0]!;
    expect(docsSection).toContain(TRUNCATION_MARKER);
    expect(docsSection.length).toBeLessThan(HOST_CONTEXT_CAPS.docs + 200);
    const historyChars = ctx.history.reduce((n, m) => n + m.content.length, 0);
    expect(historyChars).toBeLessThanOrEqual(HOST_CONTEXT_CAPS.history);
    expect(ctx.history.at(-1)?.content.startsWith('turn 19')).toBe(true);
  });

  it('a partial override keeps every other cap at its default', async () => {
    const ctx = await buildAppTurnContext(db, appId, 't', { history: 0 });
    expect(ctx.history).toEqual([]);
    expect(ctx.contextBlock).toContain(TRUNCATION_MARKER); // html still at 140,000
  });
});
