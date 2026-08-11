/**
 * TASK-20260811-lean-runtime-data-chat, P3 — `buildIntentTurnContext` (ADR-0019 D9,
 * AC-F2-2).
 *
 * TESTED AT THE ASSEMBLER, per lessons 2026-08-05: the decision "what does this turn get
 * to see" is made here, so this is where it is asserted. Downstream assertions would pass
 * just as happily with the wrong context.
 *
 * THE CLAIM THAT MATTERS: a DATA turn never receives the app's code. Not because code is
 * secret — the user owns it — but because a turn holding the app's HTML plus a
 * whole-file-rewrite instruction is a turn that can rewrite the app, and the data lane
 * must not be able to. Context scoping and tool scoping are two locks on the same door
 * (the tool-set half is asserted in the router tests).
 */

import { describe, expect, it } from 'vitest';
import type { ChatIntent } from '@snugprotocol/protocol';

import { buildIntentTurnContext } from '../agent/intentContext.js';
import { installTestUserDb } from './userdbTestHelper.js';

const HTML = `<!DOCTYPE html><html><body><h1>UNIQUE_APP_CODE_MARKER</h1></body></html>`;

async function seededDb(): Promise<{ db: Awaited<ReturnType<typeof installTestUserDb>>; appId: string }> {
  const db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Pocket Ledger', description: 'tracks spending', html: HTML });
  await db.applyAppDdl(app.appId, [
    'CREATE TABLE expenses (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)',
  ]);
  db.putAppDoc(app.appId, 'vision', { title: 'Vision', content: 'UNIQUE_DOC_BODY_MARKER' });
  return { db, appId: app.appId };
}

const build = async (intent: ChatIntent): Promise<string> => {
  const { db, appId } = await seededDb();
  const { contextBlock } = await buildIntentTurnContext(db, appId, intent, `app:${appId}`);
  return contextBlock ?? '';
};

describe('data intents get the data, never the code', () => {
  for (const intent of ['data_read', 'data_write'] as const) {
    it(`${intent}: carries the DDL and the app's identity`, async () => {
      const block = await build(intent);
      expect(block).toContain('CREATE TABLE expenses');
      expect(block).toContain('Pocket Ledger');
    });

    it(`${intent}: does NOT carry the app's HTML`, async () => {
      const block = await build(intent);
      expect(block).not.toContain('UNIQUE_APP_CODE_MARKER');
      expect(block).not.toContain('```html');
    });

    it(`${intent}: does NOT carry the whole-file rewrite instruction`, async () => {
      // The instruction is what turns a context into a rebuild brief. A data turn that
      // carried it would be one tool away from rewriting the app.
      const block = await build(intent);
      expect(block).not.toMatch(/ENTIRE updated file/i);
    });

    it(`${intent}: carries doc TITLES but not doc BODIES`, async () => {
      const block = await build(intent);
      expect(block).toContain('Vision');
      expect(block).not.toContain('UNIQUE_DOC_BODY_MARKER');
    });
  }
});

describe('feature intents get the full builder context', () => {
  for (const intent of ['app_change', 'schema_change'] as const) {
    it(`${intent}: carries the app's HTML and the rewrite instruction`, async () => {
      const block = await build(intent);
      expect(block).toContain('UNIQUE_APP_CODE_MARKER');
      expect(block).toMatch(/ENTIRE updated file/i);
    });

    it(`${intent}: carries the docs in full — a code change needs the reasoning behind them`, async () => {
      const block = await build(intent);
      expect(block).toContain('UNIQUE_DOC_BODY_MARKER');
    });
  }
});

describe('question intents get description without either power', () => {
  for (const intent of ['app_question', 'other'] as const) {
    it(`${intent}: carries docs and schema but not the HTML`, async () => {
      const block = await build(intent);
      expect(block).toContain('CREATE TABLE expenses');
      expect(block).toContain('UNIQUE_DOC_BODY_MARKER');
      expect(block).not.toContain('UNIQUE_APP_CODE_MARKER');
    });
  }
});

describe('edges', () => {
  it('an app with no schema says so rather than emitting an empty section', async () => {
    const db = await installTestUserDb();
    const app = db.installApp({ displayName: 'Plain', html: HTML });
    const { contextBlock } = await buildIntentTurnContext(db, app.appId, 'data_read', `app:${app.appId}`);
    expect(contextBlock ?? '').toMatch(/no data|none registered/i);
  });

  it('an unknown app yields no context block rather than throwing', async () => {
    const db = await installTestUserDb();
    const { contextBlock } = await buildIntentTurnContext(db, 'no-such-app', 'data_read', 'app:x');
    expect(contextBlock).toBeUndefined();
  });

  it('history comes back for every intent (the conversation is not lane-scoped)', async () => {
    const { db, appId } = await seededDb();
    const threadId = `app:${appId}`;
    db.appendChatMessage(threadId, 'user', 'earlier question');
    db.appendChatMessage(threadId, 'assistant', 'earlier answer');
    for (const intent of ['data_read', 'app_change', 'other'] as const) {
      const { history } = await buildIntentTurnContext(db, appId, intent, threadId);
      expect(history.length, intent).toBe(2);
    }
  });

  it('the data lane’s context is materially smaller than the feature lane’s', async () => {
    // The point of scoping is cost as well as safety: a data question should not pay for
    // the whole app file.
    const data = await build('data_read');
    const feature = await build('app_change');
    expect(data.length).toBeLessThan(feature.length);
  });
});
