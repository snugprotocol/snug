// localSetup.test.ts — the browser suite's harness speaks the TEST build's fake-brain
// contract (TASK-20261003 R4, ADR-0071). The three variables it used to set
// (`SNUG_MCP_TEST_BRAIN`, `_BRAIN_MODEL`, `_MODELS`) described the one CLI there was; the
// test build now takes a list of fake drivers in ONE variable, and the harness's old options
// are TRANSLATED into one fake `claude` so every spec written against them stays
// byte-identical. Playwright cannot be run from a unit suite, so the translation — the part
// that would silently turn a spec's "logged-out CLI" into "no brain at all" — is pinned here.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAUDE_LEVELS, CLAUDE_REMEDY, brainsEnv, legacyClaude, type FakeBrain } from '../../e2e/local-setup.js';
import { parseLocalStatus } from '../local/client.js';

const REPO = path.resolve(__dirname, '../../../..');
const hooks = readFileSync(path.join(REPO, 'apps/host-mcp/src/main.test-hooks.ts'), 'utf8');

describe('the single-brain options are ONE fake `claude` brain', () => {
  it('no option → no variable: that runner has no brain at all', () => {
    expect(legacyClaude({})).toBeUndefined();
    expect(brainsEnv({})).toBeUndefined();
    expect(brainsEnv({ holder: 'Snug for Mac', ports: [1] })).toBeUndefined();
  });

  it.each(['logged-out', 'outdated', 'absent'])('`brain: %s` → that state, with a remedy a user could act on, and no reply', (state) => {
    const brain = legacyClaude({ brain: state });
    expect(brain).toMatchObject({ id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state, verified: true, detail: CLAUDE_REMEDY[state] });
    expect(brain?.detail, 'a not-ready brain always carries its sentence').toMatch(/`claude/);
    expect(brain !== undefined && 'reply' in brain).toBe(false);
  });

  it('`brain: ready` alone → ready, Claude’s five levels, NO catalogue, and it refuses a think by name (no reply)', () => {
    // What local.spec.ts "the chip renders the CLI control" runs on: six level options
    // (the default and the five), one model control (free text — no catalogue).
    const brain = legacyClaude({ brain: 'ready' });
    expect(brain).toEqual({ id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state: 'ready', verified: true, streaming: true, efforts: CLAUDE_LEVELS, models: [] });
    expect(CLAUDE_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('`brainModel` → it ANSWERS, with a JSON object, and reports that id as the model that ran', () => {
    // What local.spec.ts "an APP’s think reaches the brain" asserts on the chip: the resolved id.
    const brain = legacyClaude({ brain: 'ready', brainModel: 'claude-sonnet-5-e2e-resolved', models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true }] });
    expect(brain?.resolvedModel).toBe('claude-sonnet-5-e2e-resolved');
    expect(JSON.parse(brain?.reply ?? 'null')).toEqual({ message: 'pinned reply' });
    expect(brain?.models).toEqual([{ id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: CLAUDE_LEVELS }]);
  });

  it('`effort: false` was "no thinking axis": that model lists NO levels', () => {
    expect(legacyClaude({ models: [{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', effort: false }] })?.models).toEqual([{ id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] }]);
  });

  it('a model pinned with no state named was a CLI that answers: ready', () => {
    expect(legacyClaude({ brainModel: 'm' })?.state).toBe('ready');
  });

  it('`brains` wins over the single-brain options, and rides as written, in order', () => {
    const brains: FakeBrain[] = [
      { id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state: 'ready', verified: true, reply: 'a' },
      { id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'ready', verified: false, reply: 'b' },
    ];
    expect(JSON.parse(brainsEnv({ brains, brain: 'logged-out' }) ?? 'null')).toEqual(brains);
    expect(JSON.parse(brainsEnv({ brain: 'logged-out' }) ?? 'null')).toEqual([legacyClaude({ brain: 'logged-out' })]);
  });
});

describe('the two ends of the harness agree', () => {
  it('the test entry reads the variable the harness sets — and the three old ones are gone from both', () => {
    const setup = readFileSync(path.join(REPO, 'apps/host/e2e/local-setup.ts'), 'utf8');
    expect(/export const TEST_BRAINS_ENV = '([^']+)'/.exec(hooks)?.[1]).toBe('SNUG_MCP_TEST_BRAINS');
    expect(setup).toContain('SNUG_MCP_TEST_BRAINS: brains');
    for (const old of ['SNUG_MCP_TEST_BRAIN:', 'SNUG_MCP_TEST_BRAIN_MODEL', 'SNUG_MCP_TEST_MODELS']) {
      expect(setup, old).not.toContain(old);
      expect(hooks, old).not.toContain(old);
    }
  });

  it('every field the single-brain translation sends is one the test entry reads', () => {
    const read = /const \{([^}]+)\} = entry;/.exec(hooks)?.[1] ?? '';
    const names = read.split(',').map((field) => field.trim().split(/[\s=]/)[0]);
    const sent = Object.keys(legacyClaude({ brain: 'logged-out', brainModel: 'm', models: [{ id: 'a', name: 'A', effort: true }] }) ?? {});
    expect(sent.sort()).toEqual(['detail', 'efforts', 'id', 'models', 'name', 'reply', 'resolvedModel', 'state', 'streaming', 'verified', 'via']);
    for (const field of sent) expect(names, `the test entry does not read "${field}"`).toContain(field);
  });

  it('…and so is every field a spec may write on a fake brain — `afterRecheck` (a brain fixed while the page is open) included', () => {
    const read = /const \{([^}]+)\} = entry;/.exec(hooks)?.[1] ?? '';
    const names = read.split(',').map((field) => field.trim().split(/[\s=]/)[0]);
    const full: Required<FakeBrain> = {
      id: 'x',
      name: 'X',
      via: 'your x',
      state: 'logged-out',
      detail: 'd',
      verified: false,
      streaming: false,
      efforts: [],
      models: [],
      reply: 'r',
      resolvedModel: 'm',
      afterRecheck: { state: 'ready' },
    };
    for (const field of Object.keys(full)) expect(names, `the test entry does not read "${field}"`).toContain(field);
  });

  it('the remedies a spec asserts are the REAL `claude` driver’s sentences — the browser shows what ships', () => {
    // The fixture said "…then check again" while the driver said "…then reopen Snug": every
    // spec asserting a remedy asserted a sentence no user was shown (R4 verifier). The driver
    // appends the CLI's own words in brackets; the sentence before them is what is held equal.
    const driver = readFileSync(path.join(REPO, 'apps/host-mcp/src/brains/claude.ts'), 'utf8');
    const said = (name: string): string | undefined => new RegExp(`export const ${name} =\\s*'([^']+)';`).exec(driver)?.[1];
    expect(CLAUDE_REMEDY).toEqual({ 'logged-out': said('LOGGED_OUT_REMEDY'), outdated: said('OUTDATED_REMEDY'), absent: said('INSTALL_REMEDY') });
    for (const sentence of Object.values(CLAUDE_REMEDY)) expect(sentence).toMatch(/check again\.$/);
  });

  it('a fake brain, as the runner would report it, is a brain the page’s wire parser reads whole', () => {
    // The fake's own fields are the wire's (minus `reply` / `resolvedModel`, which are how
    // it answers): what a spec writes is what the chip is given.
    const { reply: _reply, resolvedModel: _model, ...wire } = legacyClaude({ brain: 'logged-out', brainModel: 'm', models: [{ id: 'a', name: 'A', effort: true }] }) ?? {};
    const status = parseLocalStatus({ binding: 'local-host', port: 1, pages: 1, brains: [wire] });
    expect(status?.brains).toEqual([wire]);
  });
});
