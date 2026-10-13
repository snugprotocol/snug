// chatSharedRouting.test.tsx — TASK-20261013-rail-chat-access (AC1, AC3, AC4).
//
// THE OWNER'S BUG: Standup was granted the weather app's data, and asked about it the chat
// answered "Standup only has its own tables and a GitHub connection — do you want me to add
// weather…?". That is the ROUTER's clarification: the classifier was told only the app's OWN
// tables, so a question about granted data never routed to the data lane — and the chat door
// (which materialises the granted tables) opens only on a data-lane turn.
//
// AT THE HOOK, with the harness of chatCrossAppTurn.test.tsx: the chat brain is the LOCAL route
// (the chat door opens — `chatDoorOpen`), the classifier is a recorder, Budget holds a real grant
// on Ledger's `transactions`. The classifier must be told, in its host-facts line, what Ledger
// shares — names only, through the policy's own `materialise` admission, performing nothing.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { FRAME_TYPES, PROTOCOL_VERSION } from '@snugprotocol/protocol';

import { NO_ACCESS_ASKS_KEY, collectSources } from '../access/consent.js';
import { __setAccessDepsForTests, createGrantFromDecision, resetAccessSession, revokeAccess, type AnyAccessGrant, type CreateGrantInput } from '../access/grants.js';
import { sharedSourceSummaries } from '../access/service.js';
import { configureScopedRead, resetScopedReadForTests, type WorkerLike } from '../access/scopedRead.js';
import { createScopedReadResponder } from '../access/scopedRead.worker.js';
import type { BuildHandlers, BuilderTurn } from '../agent/builder.js';
import { resetThreadSessions } from '../agent/threadSessions.js';
import { useBuilderChat, type BuilderChat } from '../agent/useBuilderChat.js';
import { writeFlag } from '../state/browserFlags.js';
import { modeStore } from '../state/mode.js';
import { installTestUserDb, locateWasm } from './userdbTestHelper.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const THREAD = 'app:shared-routing';

/** What the stubbed classifier answers, and every request it was sent (the router's prompt). */
let intent = 'data_read';
const classifierRequests: string[] = [];

vi.mock('../agent/inferrerAdapter.js', () => ({
  completeWithAdapter: () => async () => ({ ok: true as const, text: '{}' }),
  liveInferenceAdapter: async () => ({
    ok: true as const,
    adapter: {
      complete: async (request: unknown) => {
        classifierRequests.push(JSON.stringify(request));
        return { ok: true as const, text: `{"intent":"${intent}","confidence":0.9}`, toolCalls: [], stopReason: 'end' as const };
      },
    },
  }),
}));

/** The turns the recorder saw, and what it runs INSIDE each turn with the tools it was sent. */
const sends: Array<{ contextBlock?: string | undefined }> = [];

vi.mock('../agent/builder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/builder.js')>();
  return {
    ...actual,
    createDirectBuilder: () => ({
      send: async (turn: string | BuilderTurn, handlers: BuildHandlers) => {
        void handlers;
        sends.push({ contextBlock: typeof turn === 'string' ? undefined : turn.contextBlock });
        return { ok: true as const, text: 'done' };
      },
    }),
  };
});

let db: UserDb;
let budget: string;
let ledger: string;
let grant: AnyAccessGrant;
let container: HTMLDivElement | undefined;
let root: Root | undefined;
let seq = 0;

function inlineWorkers(): () => WorkerLike {
  return () => {
    const respond = createScopedReadResponder();
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        void (async () => {
          const answer = await respond(msg);
          if (answer !== undefined) worker.onmessage?.({ data: answer });
        })();
      },
      terminate() {},
    };
    return worker;
  };
}

async function exec(appId: string, sql: string): Promise<void> {
  const result = await db.driver.handle(appId, { v: PROTOCOL_VERSION, type: FRAME_TYPES.dbRequest, requestId: `x-${++seq}`, instanceId: 'frame', op: 'exec', sql });
  if (!result.ok) throw new Error(`exec failed: ${JSON.stringify(result)}`);
}

function renderChat(): { chat: () => BuilderChat } {
  const holder: { current: BuilderChat | null } = { current: null };
  function Harness(): ReactElement {
    holder.current = useBuilderChat(THREAD, { pinnedAppId: budget });
    return <span />;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Harness />);
  });
  return {
    chat: () => {
      if (holder.current === null) throw new Error('hook not rendered');
      return holder.current;
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
  }
}

async function sendAndSettle(text: string): Promise<BuilderChat> {
  const { chat } = renderChat();
  await act(async () => {
    chat().send(text);
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await settle();
    if (!chat().busy) return chat();
  }
  throw new Error('the turn never settled');
}


const classifierSaw = (): string => classifierRequests.join('\n');

beforeEach(async () => {
  sends.length = 0;
  classifierRequests.length = 0;
  intent = 'data_read';
  modeStore.set('local');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  resetAccessSession();
  resetScopedReadForTests();
  db = await installTestUserDb();
  resetThreadSessions({ threadId: THREAD });
  __setAccessDepsForTests({ getDb: () => Promise.resolve(db) });
  budget = db.installApp({ displayName: 'Budget', html: '<!doctype html><title>b</title>', usesDb: true }).appId;
  ledger = db.installApp({ displayName: 'Ledger', html: '<!doctype html><title>l</title>', usesDb: true }).appId;
  await db.applyAppDdl(budget, ['CREATE TABLE expenses (id INTEGER PRIMARY KEY, cents INTEGER)']);
  await db.applyAppDdl(ledger, ['CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, category TEXT)']);
  await exec(ledger, "INSERT INTO transactions (id, amount, category) VALUES (1, 1200, 'food'), (2, 5000, 'rent')");
  configureScopedRead({ createWorker: inlineWorkers(), wasm: { wasmUrl: locateWasm() } });
  grant = await grantLedger(false);
});

async function grantLedger(write: boolean, reader = (): string => budget): Promise<AnyAccessGrant> {
  const ranked = await collectSources(db, reader());
  const source = [...ranked.matched, ...ranked.rest].find((candidate) => candidate.appId === ledger)!;
  return createGrantFromDecision(db, {
    readerAppId: reader(),
    source,
    tables: [{ name: 'transactions', withheld: [], ...(write ? { write: true } : {}) }],
    duration: 'day',
    unattended: false,
    purpose: 'to see my spending',
    provenance: 'user',
    now: Date.now(),
  } as unknown as CreateGrantInput);
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  modeStore.set('byok');
  writeFlag(NO_ACCESS_ASKS_KEY, false);
  resetAccessSession();
  resetScopedReadForTests();
  __setAccessDepsForTests();
  vi.restoreAllMocks();
});

describe('AC1/AC4 — the router is told what other apps share with this one', () => {
  it('a live grant puts the source, its table and its columns on the classifier’s Shared line', async () => {
    await sendAndSettle('what did I spend on food in the ledger?');
    expect(classifierSaw()).toContain('Shared with this app: Ledger: transactions(id, amount, category)');
  });

  it('…and so the data lane runs with the door open — the turn’s context carries Ledger’s table', async () => {
    await sendAndSettle('what did I spend on food in the ledger?');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.contextBlock ?? '').toMatch(/ledger__transactions/);
  });

  it('a revoked grant shares nothing — the line reads as the sentinel', async () => {
    await revokeAccess(grant.id);
    await sendAndSettle('what did I spend on food in the ledger?');
    expect(classifierSaw()).toContain('Shared with this app: (nothing shared with this app)');
    expect(classifierSaw()).not.toContain('Ledger: transactions');
  });
});

describe('AC3 — sharedSourceSummaries: the materialise admission, names only, performing nothing', () => {
  const chatCaller = () => ({ kind: 'chat' as const, appId: budget, threadId: THREAD });

  it('lists a live read grant as `Source: table(col, …)`', () => {
    expect(sharedSourceSummaries(db, chatCaller(), Date.now())).toEqual(['Ledger: transactions(id, amount, category)']);
  });

  it('marks a table the grant lets this app change', async () => {
    await revokeAccess(grant.id);
    await grantLedger(true);
    expect(sharedSourceSummaries(db, chatCaller(), Date.now())).toEqual(['Ledger: transactions(id, amount, category) · can be changed']);
  });

  it('an expired grant is absent (a day grant, read two days on)', () => {
    expect(sharedSourceSummaries(db, chatCaller(), Date.now() + 2 * 24 * 60 * 60 * 1000)).toEqual([]);
  });

  it('another reader’s grant is absent — Ledger shares with Budget, not with Notes', () => {
    const notes = db.installApp({ displayName: 'Notes', html: '<!doctype html><title>n</title>', usesDb: true }).appId;
    expect(sharedSourceSummaries(db, { kind: 'chat', appId: notes, threadId: 'app:notes' }, Date.now())).toEqual([]);
  });

  it('performs nothing: no history line on the source, no read noted on the grant', () => {
    const before = db.listAccessLog(ledger).length;
    const lastReadBefore = (db.getAccessGrant(grant.id) as { lastReadAt?: string } | undefined)?.lastReadAt;
    sharedSourceSummaries(db, chatCaller(), Date.now());
    expect(db.listAccessLog(ledger)).toHaveLength(before);
    expect((db.getAccessGrant(grant.id) as { lastReadAt?: string } | undefined)?.lastReadAt).toBe(lastReadBefore);
  });
});
