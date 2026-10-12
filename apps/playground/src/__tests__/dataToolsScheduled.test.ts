// dataToolsScheduled.test.ts — TASK-20261010-host-broker PR-4 (AC29; contract v2 D-PR4-16, D-PR4-2,
// D-PR4-5; D8 of the design review).
//
// The SCHEDULED variant of `data_propose_write`: `buildDataTools({…, scheduled: {armed, onProposal}})`.
// Nobody is watching, so the tool stages a SCHEDULE proposal item (`{appId, sql, summary?, counts}`)
// for the run's result instead of a chat card, and it admits ONLY through the one gate
// (`schedule/proposalGate.ts`): one statement, no params, the item schema, no credential, the app
// not mid-change, a dry-run count. At most three a run. Another app's (shared) table is refused by
// name exactly as the chat refuses it — a cross-app item never applies (D-PR4-2).
//
// What the model reads back is the contract's words, byte for byte:
//   unarmed  — Proposed — it waits for the user’s OK on the result
//   armed    — Proposed — this schedule may make it on its own when it finishes, within its limits; the user can undo it
//   armed, but `ownCapturable` refuses it —
//              Proposed — but it can’t be made on its own (<rule>) and waits for the user’s OK; to make it
//              applicable use literal values, a WHERE on UPDATE/DELETE, no functions, arithmetic or conflict clause
//              (AMENDED by PR-4 Gate-5 J1 — the rule said "literal values or ?", which led the model to an
//              unbound `?` that binds NULL; D-PR4-16's quoted answer is amended with it)
//   credential — that change carries a value that looks like a credential — it was not proposed
// and every "Proposed" answer carries D8's sentence: never say a change was made — say what you
// proposed; the host reports what it made.
//
// Assumed seam (Q-T-A-4): `scheduled: { armed: boolean; onProposal(item: ScheduleProposalItem): boolean | void }`;
// the input keeps the chat tool's `{statements, params?, summary}` shape; a non-empty `params`
// is refused (a schedule proposal item has no params seat), never silently dropped.
//
// RED until the `scheduled` option lands in `agent/dataTools.ts` (today the option is ignored and
// the chat answer comes back) and `ownCapturable` is exported from `@snugprotocol/db`.

import { ownCapturable, type UserDb } from '@snugprotocol/db';
import { getToolPrompt, type ToolPromptName } from '@snugprotocol/knowledge';
import type { ScheduleProposalItem } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHAT_DOOR } from '../access/copy.js';
import type { MaterialisedSet } from '../access/service.js';
import { DATA_PROPOSE_WRITE_TOOL_NAME, buildDataTools, type SharedTablesSeat } from '../agent/dataTools.js';
import { OWN_CAPTURE_RULE } from '../schedule/proposalGate.js';
import { execFrame, exportFrame } from './dbFrames.js';
import { installTestUserDb } from './userdbTestHelper.js';

const UNARMED = 'Proposed — it waits for the user’s OK on the result';
const ARMED = 'Proposed — this schedule may make it on its own when it finishes, within its limits; the user can undo it';
// AMENDED by PR-4 Gate-5 J1 (OWN_CAPTURE_RULE loses "or ?"): was
//   `… to make it applicable use literal values or ?, a WHERE on UPDATE/DELETE, no functions, arithmetic or conflict clause`
const OWN_RULE = 'literal values, a WHERE on UPDATE/DELETE, no functions, arithmetic or conflict clause';
const armedButNot = (rule: string): string =>
  `Proposed — but it can’t be made on its own (${rule}) and waits for the user’s OK; to make it applicable use ${OWN_RULE}`;
const CREDENTIAL = 'that change carries a value that looks like a credential — it was not proposed';
/** D8 — the first letter may be capitalised where it opens a sentence; the rest is byte for byte. */
const D8 = /[Nn]ever say a change was made — say what you proposed; the host reports what it made/;

let db: UserDb;
let appId: string;

async function realBytes(): Promise<string> {
  const result = await db.driver.handle(appId, exportFrame());
  return result.ok ? (result.bytesBase64 ?? '') : '';
}

beforeEach(async () => {
  db = await installTestUserDb();
  const app = db.installApp({ displayName: 'Budget', html: '<html>budget</html>' });
  appId = app.appId;
  await db.applyAppDdl(appId, ['CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL, cents INTEGER NOT NULL)']);
  for (const [index, label] of ['coffee', 'tea', 'rent'].entries()) {
    const result = await db.driver.handle(appId, execFrame('INSERT INTO t (id, label, cents) VALUES (?, ?, ?)', [index + 1, label, (index + 1) * 100]));
    if (!result.ok) throw new Error('seed failed');
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Built {
  propose: (input: Record<string, unknown>) => Promise<string>;
  staged: ScheduleProposalItem[];
}

function scheduledTools(options: { armed: boolean; shared?: SharedTablesSeat; accept?: () => boolean | void }): Built {
  const staged: ScheduleProposalItem[] = [];
  const tools = buildDataTools({
    appId,
    getDb: () => Promise.resolve(db),
    ...(options.shared !== undefined ? { shared: options.shared } : {}),
    scheduled: {
      armed: options.armed,
      onProposal: (item: ScheduleProposalItem) => {
        staged.push(item);
        return options.accept?.();
      },
    },
  });
  const tool = tools.find((entry) => entry.def.name === DATA_PROPOSE_WRITE_TOOL_NAME);
  if (tool === undefined) throw new Error('the scheduled data_propose_write is missing');
  return { propose: async (input) => String(await tool.run(input)), staged };
}

describe('the scheduled data_propose_write — unarmed: it waits for the user’s OK', () => {
  it('one DML statement is staged as a schedule proposal item with its dry-run count; the answer is the unarmed sentence + D8; the real table is untouched', async () => {
    const before = await realBytes();
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DELETE FROM t WHERE id = 1'], summary: 'drop the stale row' });
    expect(staged).toEqual([{ appId, sql: 'DELETE FROM t WHERE id = 1', summary: 'drop the stale row', counts: { changes: 1 } }]);
    expect(answer).toContain(UNARMED);
    expect(answer).toMatch(D8);
    expect(answer).not.toContain('on its own');
    expect(answer).not.toContain('NOT applied — the user must approve it'); // the chat's card words are not a schedule's
    expect(await realBytes()).toBe(before);
  });

  it('unarmed, even a change the capture walk would refuse is simply proposed (no “can’t be made on its own”)', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['UPDATE t SET cents = cents + 1 WHERE id = 1'], summary: 'bump' });
    expect(staged).toHaveLength(1);
    expect(answer).toContain(UNARMED);
    expect(answer).not.toContain('can’t be made on its own');
  });
});

describe('the scheduled data_propose_write — armed: the ownCapturable answer', () => {
  it('a capturable change (literal values, a WHERE) → the armed sentence + D8; staged', async () => {
    const sql = "UPDATE t SET label = 'chai' WHERE id = 2";
    expect(ownCapturable(sql)).toEqual({ ok: true });
    const { propose, staged } = scheduledTools({ armed: true });
    const answer = await propose({ statements: [sql], summary: 'rename' });
    expect(staged).toEqual([{ appId, sql, summary: 'rename', counts: { changes: 1 } }]);
    expect(answer).toContain(ARMED);
    expect(answer).toMatch(D8);
  });

  const UNCAPTURABLE = [
    ['arithmetic', 'UPDATE t SET cents = cents + 1 WHERE id = 1'],
    ['a function', "UPDATE t SET label = upper('x') WHERE id = 1"],
    ['no WHERE on DELETE', 'DELETE FROM t'],
    ['no WHERE on UPDATE', "UPDATE t SET label = 'x'"],
    ['a conflict clause', "INSERT OR REPLACE INTO t (id, label, cents) VALUES (1, 'x', 1)"],
  ] as const;

  for (const [name, sql] of UNCAPTURABLE) {
    it(`${name} → still proposed, but the answer names the rule and says it waits for the user’s OK (+ D8)`, async () => {
      const verdict = ownCapturable(sql);
      expect(verdict.ok).toBe(false);
      const rule = verdict.ok ? '' : verdict.rule;
      const { propose, staged } = scheduledTools({ armed: true });
      const answer = await propose({ statements: [sql], summary: 'tidy' });
      expect(staged).toHaveLength(1);
      expect(staged[0]?.sql).toBe(sql);
      expect(answer).toContain(armedButNot(rule));
      expect(answer).not.toContain(ARMED);
      expect(answer).toMatch(D8);
    });
  }
});

describe('the scheduled data_propose_write — what it refuses (nothing staged)', () => {
  it('a credential in the change → the credential sentence; never staged; the value is not echoed', async () => {
    const { propose, staged } = scheduledTools({ armed: true });
    const answer = await propose({ statements: ["UPDATE t SET label = 'Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij.klmnopqrst' WHERE id = 1"], summary: 'store the key' });
    expect(answer).toContain(CREDENTIAL);
    expect(answer).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(staged).toEqual([]);
  });

  it('a credential in the summary is refused the same way', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DELETE FROM t WHERE id = 1'], summary: 'use ghp_0123456789abcdefghijABCDEFGHIJ' });
    expect(answer).toContain(CREDENTIAL);
    expect(answer).not.toContain('ghp_0123456789');
    expect(staged).toEqual([]);
  });

  it('two statements → refused (one statement a proposal)', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DELETE FROM t WHERE id = 1', 'DELETE FROM t WHERE id = 2'], summary: 'two' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('two statements in ONE string → refused', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DELETE FROM t WHERE id = 1; DELETE FROM t WHERE id = 2'], summary: 'two' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('params → refused (a schedule proposal carries no bound values), never staged with the values dropped', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['UPDATE t SET label = ? WHERE id = 1'], params: [['chai']], summary: 'bound' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('DDL and a nested SELECT → refused', async () => {
    const { propose, staged } = scheduledTools({ armed: true });
    expect((await propose({ statements: ['DROP TABLE t'], summary: 'gone' })).startsWith('Error:')).toBe(true);
    expect((await propose({ statements: ['UPDATE t SET cents = (SELECT MAX(cents) FROM t) WHERE id = 2'], summary: 'max' })).startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('a change that fails its dry run → refused; nothing staged', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['UPDATE t SET nope = 1 WHERE id = 1'], summary: 'x' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('the app mid-change (inTransaction) → refused before any dry run; nothing staged', async () => {
    vi.spyOn(db.driver, 'inTransaction').mockResolvedValue(true);
    const scratch = vi.spyOn(db, 'scratchRun');
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DELETE FROM t WHERE id = 1'], summary: 'x' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(answer).not.toContain('Proposed');
    expect(scratch).not.toHaveBeenCalled();
    expect(staged).toEqual([]);
  });

  it('another app’s (shared) table → refused BY NAME exactly as the chat refuses it — a cross-app item is never staged', async () => {
    const set: MaterialisedSet = {
      tables: [
        {
          grantId: 'g-ledger',
          sourceAppId: 'ledger-app',
          sourceName: 'Ledger',
          alias: 'ledger',
          name: 'ledger__transactions',
          table: 'transactions',
          columns: ['id', 'amount'],
          types: ['INTEGER', 'REAL'],
          rows: [[1, 12.5]],
          truncated: false,
          duration: 'always',
        },
      ],
      skipped: [],
      readOnlyTables: ['ledger__transactions'],
    };
    const recordRead = vi.fn(() => Promise.resolve({ recorded: ['g-ledger'], refused: [] }));
    const { propose, staged } = scheduledTools({ armed: true, shared: { set, recordRead } });
    const answer = await propose({ statements: ['UPDATE ledger__transactions SET amount = 0 WHERE id = 1'], summary: 'zero it' });
    expect(answer).toBe(`Error: ${CHAT_DOOR.readOnly('Ledger')}`);
    expect(staged).toEqual([]);
    expect(recordRead).not.toHaveBeenCalled();
  });
});

describe('the scheduled data_propose_write — at most three a run', () => {
  it('the fourth proposal is not staged and is not answered “Proposed”', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    for (const id of [1, 2, 3]) {
      expect(await propose({ statements: [`DELETE FROM t WHERE id = ${id}`], summary: `row ${id}` })).toContain(UNARMED);
    }
    const fourth = await propose({ statements: ["UPDATE t SET label = 'x' WHERE id = 1"], summary: 'one more' });
    expect(staged).toHaveLength(3);
    expect(fourth).not.toContain('Proposed —');
  });

  it('a refused proposal does not use up one of the three', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    await propose({ statements: ['DROP TABLE t'], summary: 'no' });
    for (const id of [1, 2, 3]) await propose({ statements: [`DELETE FROM t WHERE id = ${id}`], summary: `row ${id}` });
    expect(staged).toHaveLength(3);
  });
});

describe('the chat’s variant is unchanged', () => {
  it('without `scheduled`, the chat tool still answers its approval-card words and stages a chat proposal', async () => {
    const proposals: unknown[] = [];
    const tools = buildDataTools({ appId, getDb: () => Promise.resolve(db), onProposal: (p) => void proposals.push(p) });
    const tool = tools.find((entry) => entry.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!;
    const answer = String(await tool.run({ statements: ['DELETE FROM t WHERE id = 1'], summary: 'stale' }));
    expect(answer.startsWith('Proposed (NOT applied — the user must approve it):')).toBe(true);
    expect(proposals).toHaveLength(1);
  });
});

// =================================================================================================
// PR-4 Gate-5 — J1 (no unbound placeholder), J2 (the scheduled tool's OWN definition), J10 (the
// failure says SQLite's reason and the cap). The chat's definition stays byte-identical to `main`.
// =================================================================================================

/** The scheduled data_propose_write's definition as the brain is handed it. */
function scheduledDef(armed = false): { name: string; description: string; inputSchema: Record<string, unknown> } {
  const tools = buildDataTools({ appId, getDb: () => Promise.resolve(db), scheduled: { armed, onProposal: () => undefined } });
  const tool = tools.find((entry) => entry.def.name === DATA_PROPOSE_WRITE_TOOL_NAME);
  if (tool === undefined) throw new Error('the scheduled data_propose_write is missing');
  return tool.def as unknown as { name: string; description: string; inputSchema: Record<string, unknown> };
}

const NO_PARAMS_WORDS = 'write the values into the statement itself';

describe('PR-4 Gate-5 J1 — an unbound placeholder is never proposed, and nothing tells the model to write one', () => {
  it('OWN_CAPTURE_RULE no longer offers "or ?" — literal values, a WHERE, no functions, arithmetic or conflict clause', () => {
    expect(OWN_CAPTURE_RULE).toBe(OWN_RULE);
    expect(OWN_CAPTURE_RULE).not.toMatch(/\?/);
  });

  for (const armed of [true, false]) {
    it(`${armed ? 'armed' : 'unarmed'}: a \`?\` with no params → refused with the no-params sentence; nothing staged; no "Proposed"`, async () => {
      const { propose, staged } = scheduledTools({ armed });
      const answer = await propose({ statements: ['UPDATE t SET label = ? WHERE id = 1'], summary: 'bound' });
      expect(answer.startsWith('Error:')).toBe(true);
      expect(answer).toContain(NO_PARAMS_WORDS);
      expect(answer).not.toContain('Proposed');
      expect(staged).toEqual([]);
    });
  }

  it.each([':v', '@v', '$v', '?1'])('armed: the placeholder %s with no params → refused, nothing staged', async (mark) => {
    const { propose, staged } = scheduledTools({ armed: true });
    const answer = await propose({ statements: [`UPDATE t SET label = ${mark} WHERE id = 1`], summary: 'bound' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(answer).toContain(NO_PARAMS_WORDS);
    expect(staged).toEqual([]);
  });

  it('the passing twin: a `?` inside a quoted value is text — proposed and staged', async () => {
    const { propose, staged } = scheduledTools({ armed: true });
    const answer = await propose({ statements: ["UPDATE t SET label = 'what?' WHERE id = 1"], summary: 'quoted' });
    expect(answer).toContain(ARMED);
    expect(staged).toHaveLength(1);
  });

  it('no answer the scheduled tool gives — proposed, armed-but-not, or refused — contains "or ?"', async () => {
    const answers: string[] = [];
    for (const armed of [true, false]) {
      const { propose } = scheduledTools({ armed });
      answers.push(await propose({ statements: ["UPDATE t SET label = 'chai' WHERE id = 2"], summary: 'rename' }));
      answers.push(await propose({ statements: ['UPDATE t SET cents = cents + 1 WHERE id = 1'], summary: 'bump' }));
      answers.push(await propose({ statements: ['UPDATE t SET label = ? WHERE id = 1'], summary: 'bound' }));
      answers.push(await propose({ statements: ['UPDATE t SET label = ? WHERE id = 1'], params: [['x']], summary: 'params' }));
      answers.push(await propose({ statements: ['DROP TABLE t'], summary: 'gone' }));
    }
    for (const answer of answers) expect(answer).not.toContain('or ?');
  });
});

describe('PR-4 Gate-5 J2 — the scheduled data_propose_write has its OWN definition', () => {
  it('its description is the knowledge store’s `data-propose-write-scheduled` prompt — never the chat’s', () => {
    const def = scheduledDef();
    expect(def.name).toBe(DATA_PROPOSE_WRITE_TOOL_NAME);
    expect(def.description).toBe(getToolPrompt('data-propose-write-scheduled' as ToolPromptName));
    expect(def.description).not.toBe(getToolPrompt('data-propose-write'));
  });

  it('the description never offers params, and never says only the user’s approval runs a change (false under an armed schedule)', () => {
    for (const armed of [true, false]) {
      const def = scheduledDef(armed);
      expect(def.description).not.toMatch(/params/);
      expect(def.description).not.toMatch(/only the user/i);
    }
  });

  it('its input schema: `statements` is ONE string (minItems 1, maxItems 1) beside `summary` — and there is NO `params` property', () => {
    const schema = scheduledDef().inputSchema as { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[] };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['statements', 'summary']);
    expect(schema.properties?.statements).toMatchObject({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 1 });
    expect(schema.properties?.summary).toMatchObject({ type: 'string' });
    expect(JSON.stringify(schema)).not.toMatch(/params/);
  });

  it('the runtime refusal of params stays (a model that sends them anyway is told, never silently dropped)', async () => {
    const { propose, staged } = scheduledTools({ armed: true });
    const answer = await propose({ statements: ["UPDATE t SET label = 'x' WHERE id = 1"], params: [['chai']], summary: 'bound' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(staged).toEqual([]);
  });

  it('the CHAT’s definition is byte-identical to main’s: the chat prompt and the {statements, params, summary} schema', () => {
    const tools = buildDataTools({ appId, getDb: () => Promise.resolve(db), onProposal: () => undefined });
    const chat = tools.find((entry) => entry.def.name === DATA_PROPOSE_WRITE_TOOL_NAME)!.def;
    expect(JSON.stringify(chat)).toBe(
      JSON.stringify({
        name: 'data_propose_write',
        description: getToolPrompt('data-propose-write'),
        inputSchema: {
          type: 'object',
          properties: {
            statements: { type: 'array', items: { type: 'string' } },
            params: { type: 'array' },
            summary: { type: 'string' },
          },
          required: ['statements', 'summary'],
        },
      }),
    );
  });
});

describe('PR-4 Gate-5 J10 — a failed change says SQLite’s reason; an invalid one names the cap', () => {
  it('a NOT NULL failure on the copy: `Error: that change failed on a copy of the data — <SQLite’s words>; it was not proposed`', async () => {
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ["INSERT INTO t (id, label) VALUES (4, 'x')"], summary: 'add' });
    expect(answer.startsWith('Error: that change failed on a copy of the data — ')).toBe(true);
    expect(answer).toContain('NOT NULL constraint failed');
    expect(answer.endsWith('; it was not proposed')).toBe(true);
    expect(answer).not.toContain('check the table and column names');
    expect(staged).toEqual([]);
  });

  it('an unknown column says so (SQLite’s detail), never a generic sentence', async () => {
    const { propose } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['UPDATE t SET nope = 1 WHERE id = 1'], summary: 'x' });
    expect(answer).toContain('no such column');
  });

  it('the detail is scrubbed with the deliver policy: a credential-shaped value in SQLite’s words never reaches the model', async () => {
    // The gate refuses a credential in the statement itself before any copy runs, so the copy's words are
    // the only way one could ride the answer — they are made to carry one here.
    const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ';
    vi.spyOn(db, 'scratchRun').mockResolvedValue({ statements: [{ error: `CHECK constraint failed: label <> '${KEY}'` }] } as never);
    const { propose, staged } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ["UPDATE t SET label = 'x' WHERE id = 1"], summary: 'x' });
    expect(answer.startsWith('Error: that change failed on a copy of the data — ')).toBe(true);
    expect(answer).toContain('CHECK constraint failed');
    expect(answer).not.toContain(KEY);
    expect(staged).toEqual([]);
  });

  it('`invalid` names the 2,048-character cap', async () => {
    const { propose } = scheduledTools({ armed: false });
    const answer = await propose({ statements: ['DROP TABLE t'], summary: 'gone' });
    expect(answer.startsWith('Error:')).toBe(true);
    expect(answer).toMatch(/2,048 characters/);
  });
});
