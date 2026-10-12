// taskShapeArming.test.ts — TASK-20261010-host-broker PR-4 Gate 5, U12 (the UI review's UI-12; the
// engine side is A11): the two rules that decide making changes on its own are written ONCE.
//
//  - "one app" (v2.1 N4): a schedule may make its changes on its own only when it asks at least one
//    app's AI and every step that names an app names that same one. The editor OFFERS the choice by
//    it (`onItsOwnApp`), `armTask` ADMITS by it and the walk APPLIES under it (`armableAppOf`).
//  - "widens" (D-PR4-8): an edit widens what an armed schedule may do when its steps changed —
//    compared schema-parsed (defaults filled) and canonically, never by raw JSON — its owning app
//    changed, or its occurrences came closer together. The editor WARNS by it and `updateTask`
//    DISARMS by it.
//
// Two copies drift: the editor would offer or warn by one rule while the engine refuses or disarms
// by another. So both live in the pure `schedule/taskShape.ts`; `editorModel` re-exports them
// (`armableAppOf as onItsOwnApp`, `widens`) — pinned BY IDENTITY — and a parser scan finds no second
// declaration of either rule anywhere under `schedule/`. The fixtures pin the rules themselves,
// including the case the editor's raw-JSON copy got wrong (a default left out vs. spelled out).
//
// Namespace imports, so a missing export is a red assertion here, never a load error.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { ScheduleSpec, ScheduleStep } from '@snugprotocol/protocol';

import * as editorModel from '../schedule/editorModel.js';
import * as taskShape from '../schedule/taskShape.js';

const SCHEDULE_DIR = path.resolve(__dirname, '..', 'schedule');
/** A fixed anchor for the interval compare — never the wall clock. */
const ANCHOR = new Date('2026-10-09T12:05:00.000Z');

const think = (appId: string, over: Record<string, unknown> = {}): ScheduleStep => ({ kind: 'app-think', appId, prompt: 'tidy the categories', context: { maxRows: 50 }, ...over }) as ScheduleStep;
const run = (appId: string): ScheduleStep => ({ kind: 'app-run', appId });
const remind: ScheduleStep = { kind: 'notify', title: 'stretch', body: 'stand up' };

const DAILY: ScheduleSpec = { kind: 'daily', time: '18:00', tz: 'device' };
const HOURLY: ScheduleSpec = { kind: 'every', n: 1, unit: 'hours', tz: 'device' };
const EVERY_2H: ScheduleSpec = { kind: 'every', n: 2, unit: 'hours', tz: 'device' };
const ONCE: ScheduleSpec = { kind: 'once', at: '2026-10-20T09:00:00.000Z', tz: 'device' } as ScheduleSpec;

type Armable = (steps: readonly ScheduleStep[]) => string | undefined;
type Widens = (before: { steps: readonly ScheduleStep[]; spec: ScheduleSpec; ownerAppId?: string }, after: { steps?: readonly ScheduleStep[]; spec?: ScheduleSpec; ownerAppId?: string }, anchor: Date) => boolean;

const shape = taskShape as unknown as { armableAppOf?: Armable; widens?: Widens };
const editor = editorModel as unknown as { onItsOwnApp?: Armable; widens?: Widens };

describe('one home — the editor re-exports the engine’s rules BY IDENTITY', () => {
  it('taskShape exports armableAppOf and widens', () => {
    expect(typeof shape.armableAppOf).toBe('function');
    expect(typeof shape.widens).toBe('function');
  });

  it('editorModel.onItsOwnApp IS taskShape.armableAppOf (the same function, not a copy)', () => {
    expect(editor.onItsOwnApp).toBeDefined();
    expect(editor.onItsOwnApp).toBe(shape.armableAppOf);
  });

  it('editorModel.widens IS taskShape.widens', () => {
    expect(editor.widens).toBeDefined();
    expect(editor.widens).toBe(shape.widens);
  });
});

describe('no second spelling of either rule under schedule/ (a parser scan; comments never count)', () => {
  /** The names a source DECLARES (a function, or a const bound to a function) — re-exports and imports are not declarations. */
  function declaredFunctions(code: string, kind: ts.ScriptKind): string[] {
    const file = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true, kind);
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.push(node.name.text);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
        names.push(node.name.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return names;
  }

  const RULES = new Set(['armableAppOf', 'onItsOwnApp', 'widens', 'widensAuthority']);

  it('the scan sees a declaration, and not a re-export or an import (it can fail)', () => {
    expect(declaredFunctions('export function widens() { return true; }', ts.ScriptKind.TS)).toEqual(['widens']);
    expect(declaredFunctions('const onItsOwnApp = (s: unknown) => s;', ts.ScriptKind.TS)).toEqual(['onItsOwnApp']);
    expect(declaredFunctions("export { armableAppOf as onItsOwnApp, widens } from './taskShape.js'; import { widens as w } from './taskShape.js';", ts.ScriptKind.TS)).toEqual([]);
    expect(declaredFunctions('// function widens() {}', ts.ScriptKind.TS)).toEqual([]);
  });

  it('armableAppOf / onItsOwnApp / widens / widensAuthority are declared in taskShape.ts ONLY', () => {
    const offenders: string[] = [];
    for (const name of readdirSync(SCHEDULE_DIR)) {
      if (!/\.tsx?$/.test(name) || name === 'taskShape.ts') continue;
      const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      for (const declared of declaredFunctions(readFileSync(path.join(SCHEDULE_DIR, name), 'utf8'), kind)) if (RULES.has(declared)) offenders.push(`${name}: ${declared}`);
    }
    expect(offenders).toEqual([]);
    const home = declaredFunctions(readFileSync(path.join(SCHEDULE_DIR, 'taskShape.ts'), 'utf8'), ts.ScriptKind.TS);
    expect(home).toEqual(expect.arrayContaining(['armableAppOf', 'widens']));
  });

  it('taskShape.ts stays pure — no React, no store, no engine import', () => {
    const source = readFileSync(path.join(SCHEDULE_DIR, 'taskShape.ts'), 'utf8');
    const file = ts.createSourceFile('taskShape.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const specifiers = file.statements
      .filter(ts.isImportDeclaration)
      .filter((decl) => decl.importClause?.isTypeOnly !== true)
      .map((decl) => (decl.moduleSpecifier as ts.StringLiteral).text);
    expect(specifiers.filter((spec) => !/^@snugprotocol\/protocol$/.test(spec) && !/^\.\/(floors|cron|types)\.js$/.test(spec)), 'only the protocol and the pure schedule maths').toEqual([]);
  });

  it('the false "lazy edge keeps the engine out of this view" comments are gone (UI-12)', () => {
    for (const name of ['ResultDetail.tsx', 'ScheduleChanges.tsx', 'editorModel.ts']) {
      const source = readFileSync(path.join(SCHEDULE_DIR, name), 'utf8');
      expect(source, name).not.toMatch(/keeps the engine out of this view/);
    }
  });
});

describe('armableAppOf — the "one app" rule (v2.1 N4), over the fixtures', () => {
  const ROWS: ReadonlyArray<readonly [string, readonly ScheduleStep[], string | undefined]> = [
    ['one ask step', [think('ledger')], 'ledger'],
    ['a reminder and an ask step', [remind, think('ledger')], 'ledger'],
    ['two ask steps of one app', [think('ledger'), think('ledger', { prompt: 'and again' })], 'ledger'],
    ['an ask step and a run step of the SAME app', [think('ledger'), run('ledger')], 'ledger'],
    ['an ask step that may look things up', [think('ledger', { tools: true })], 'ledger'],
    ['two apps’ ask steps', [think('ledger'), think('standup')], undefined],
    ['an ask step and ANOTHER app’s run step', [think('ledger'), run('weather')], undefined],
    ['a run step only — nothing asks an AI', [run('ledger')], undefined],
    ['a reminder only', [remind], undefined],
    ['nothing', [], undefined],
  ];

  it.each(ROWS)('%s', (_label, steps, expected) => {
    expect(shape.armableAppOf?.(steps)).toBe(expected);
  });

  it('the editor reads the same answer on every fixture (parity, whatever the identity pin says)', () => {
    for (const [label, steps, expected] of ROWS) expect(editor.onItsOwnApp?.(steps), label).toBe(expected);
  });
});

describe('widens — what an edit to an armed schedule widens (D-PR4-8), over the fixtures', () => {
  type Before = Parameters<Widens>[0];
  const armed: Before = { steps: [think('ledger')], spec: DAILY, ownerAppId: 'ledger' };

  const ROWS: ReadonlyArray<readonly [string, Before, Parameters<Widens>[1], boolean]> = [
    ['the same steps and spec', armed, { steps: [think('ledger')], spec: DAILY }, false],
    ['the same step with its keys in another order', armed, { steps: [{ context: { maxRows: 50 }, prompt: 'tidy the categories', appId: 'ledger', kind: 'app-think' } as ScheduleStep], spec: DAILY }, false],
    ['the same step with a default left out — schema-parsed, never raw JSON', armed, { steps: [{ kind: 'app-think', appId: 'ledger', prompt: 'tidy the categories', context: {} } as unknown as ScheduleStep], spec: DAILY }, false],
    ['a prompt changed', armed, { steps: [think('ledger', { prompt: 'tidy and sum' })], spec: DAILY }, true],
    ['*let it look things up* gained', armed, { steps: [think('ledger', { tools: true })], spec: DAILY }, true],
    ['a step added', armed, { steps: [think('ledger'), run('ledger')], spec: DAILY }, true],
    ['a shorter gap between runs', armed, { steps: [think('ledger')], spec: HOURLY }, true],
    ['a longer gap between runs', { ...armed, spec: HOURLY }, { steps: [think('ledger')], spec: EVERY_2H }, false],
    ['hourly made daily', { ...armed, spec: HOURLY }, { steps: [think('ledger')], spec: DAILY }, false],
    ['a one-off made repeating — a period gained', { ...armed, spec: ONCE }, { steps: [think('ledger')], spec: DAILY }, true],
    ['a repeating schedule made a one-off', armed, { steps: [think('ledger')], spec: ONCE }, false],
    ['the owning app changed', armed, { steps: [think('ledger')], spec: DAILY, ownerAppId: 'other' }, true],
    ['a patch that names neither steps nor spec', armed, {}, false],
    ['a patch that names only a shorter spec', armed, { spec: HOURLY }, true],
  ];

  it.each(ROWS)('%s', (_label, before, after, expected) => {
    expect(shape.widens?.(before, after, ANCHOR)).toBe(expected);
  });

  it('the editor warns by the same answer on every fixture (parity, whatever the identity pin says)', () => {
    for (const [label, before, after, expected] of ROWS) expect(editor.widens?.(before, after, ANCHOR), label).toBe(expected);
  });
});
