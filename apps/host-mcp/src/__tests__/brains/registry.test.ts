// The brain registry (ADR-0071 §1, §4; criteria B1, B3, B4, B6).
//
// What this file holds still:
//   · the contract is not Claude-shaped — a driver that is not a child process at all, with
//     its own vocabulary, rides the same registry and the same wire;
//   · nothing is probed until somebody asks, and never twice inside the floor;
//   · selection NEVER moves a think to another vendor: `auto` is the default brain or
//     nothing, a pin is that brain or nothing, and an unverified brain answers only a pin;
//   · the shipped registry hands every driver ONE child environment, built by allowlist.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { argvPromptLimit, CHILD_ENV_ALLOWLIST, type Brain, type BrainDriver, type BrainReadiness } from '../../brains/brain.js';
import { PROMPT_TOO_LARGE } from '../../brains/claude.js';
import { CODEX_SENTENCES } from '../../brains/codex-events.js';
import { BRAIN_PROBE_FLOOR_MS, createBrainRegistry, machineDrivers, NOT_PROBED_DETAIL } from '../../brains/registry.js';
import { brainOf, fakeDriver } from '../fixtures/fake-brains.js';
import { fakeSpawner } from '../fixtures/fake-claude-child.js';
import { CODEX_SUCCESS_STREAM, fakeCodexSpawner } from '../fixtures/fake-codex-child.js';

const answeringBrain = (stop: () => void = () => {}): Brain => brainOf(undefined, stop);

describe('the contract is not Claude-shaped (B1)', () => {
  // A brain that is NOT a child process: no binary, no argv, no pool. Its probe is a slow
  // asynchronous ask, its remedy is its own sentence, its levels are its own words, and its
  // prompt limit is a number the transport gave it.
  const oracle = (): BrainDriver => ({
    id: 'oracle',
    name: 'Oracle',
    via: 'a model service on this machine',
    verified: true,
    streaming: false,
    maxPromptBytes: 4_096,
    probe: () => new Promise((resolve) => setTimeout(() => resolve({ state: 'logged-out', detail: 'The oracle is asleep — wake it from its menu-bar icon, then check again.' }), 15)),
    catalog: () => ({
      efforts: ['brief', 'thorough'],
      models: [
        { id: 'oracle-small', name: 'Small', efforts: [] },
        { id: 'oracle-large', name: 'Large', efforts: ['brief', 'thorough', 'exhaustive'] },
      ],
    }),
    acceptsModel: (model) => model.startsWith('oracle-'),
    acceptsEffort: (_model, effort) => effort === 'brief' || effort === 'thorough',
    create: () => answeringBrain(),
  });

  it('carries every fact of such a driver onto the wire, in the driver’s own words', async () => {
    const registry = createBrainRegistry({ drivers: [oracle()], defaultBrain: 'oracle' });
    await registry.probe();
    expect(registry.statuses()).toEqual({
      brains: [
        {
          id: 'oracle',
          name: 'Oracle',
          via: 'a model service on this machine',
          state: 'logged-out',
          detail: 'The oracle is asleep — wake it from its menu-bar icon, then check again.',
          verified: true,
          streaming: false,
          efforts: ['brief', 'thorough'],
          models: [
            { id: 'oracle-small', name: 'Small', efforts: [] },
            { id: 'oracle-large', name: 'Large', efforts: ['brief', 'thorough', 'exhaustive'] },
          ],
          maxPromptBytes: 4_096,
        },
      ],
    });
  });

  it('answers through it once it is ready — `auto` is the DEFAULT brain, whichever that is', async () => {
    const driver = { ...oracle(), probe: async (): Promise<BrainReadiness> => ({ state: 'ready' }) };
    const registry = createBrainRegistry({ drivers: [driver], defaultBrain: 'oracle' });
    await registry.probe();
    expect(registry.statuses().active).toBe('oracle');
    const resolved = registry.resolve('auto');
    expect(resolved.ok && resolved.driver.id).toBe('oracle');
  });

  it('a driver with no prompt limit puts none on the wire', async () => {
    const registry = createBrainRegistry({ drivers: [fakeDriver('claude')] });
    expect(registry.statuses().brains[0]).not.toHaveProperty('maxPromptBytes');
  });
});

describe('probes are lazy (B1)', () => {
  it('building the registry probes nothing and creates nothing', async () => {
    const claude = fakeDriver('claude');
    createBrainRegistry({ drivers: [claude] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(claude.probes).toBe(0);
    expect(claude.created).toBe(0);
  });

  it('reading statuses probes nothing: a brain nobody has asked yet is `unknown`, said as still being checked, and is not active', () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude] });
    const { active, brains } = registry.statuses();
    expect(active).toBeUndefined();
    expect(brains[0]).toMatchObject({ id: 'claude', state: 'unknown', detail: NOT_PROBED_DETAIL });
    expect(claude.probes).toBe(0);
  });

  it('a think sent before any probe answered is NOT placed — an unchecked brain is not a ready one', () => {
    const registry = createBrainRegistry({ drivers: [fakeDriver('claude')] });
    expect(registry.resolve('auto').ok).toBe(false);
    expect(registry.resolve('claude').ok).toBe(false);
  });

  it('one probe() asks EVERY driver, once, and tells its subscribers once when the round has landed', async () => {
    const claude = fakeDriver('claude');
    const codex = fakeDriver('codex', { readiness: { state: 'logged-out', detail: 'run `codex login`' } });
    const registry = createBrainRegistry({ drivers: [claude, codex] });
    const heard = vi.fn();
    registry.subscribe(heard);
    await registry.probe();
    expect([claude.probes, codex.probes]).toEqual([1, 1]);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(registry.statuses().brains.map(({ id, state }) => [id, state])).toEqual([
      ['claude', 'ready'],
      ['codex', 'logged-out'],
    ]);
  });

  it('never runs two rounds at once — a second ask while one is in flight is THAT round', async () => {
    let finish: (value: BrainReadiness) => void = () => {};
    const slow = fakeDriver('claude', { probe: vi.fn(() => new Promise<BrainReadiness>((resolve) => (finish = resolve))) });
    const registry = createBrainRegistry({ drivers: [slow] });
    const first = registry.probe();
    const second = registry.probe();
    expect(second).toBe(first);
    expect(slow.probe).toHaveBeenCalledTimes(1);
    finish({ state: 'ready' });
    await first;
  });

  it('a fast driver’s verdict is readable while a slow one is still being asked', async () => {
    let finish: (value: BrainReadiness) => void = () => {};
    const slow = fakeDriver('claude', { probe: () => new Promise<BrainReadiness>((resolve) => (finish = resolve)) });
    const fast = fakeDriver('codex', { readiness: { state: 'absent', detail: 'install it' } });
    const registry = createBrainRegistry({ drivers: [slow, fast] });
    const round = registry.probe();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(registry.statuses().brains.map(({ state }) => state)).toEqual(['unknown', 'absent']);
    finish({ state: 'ready' });
    await round;
    expect(registry.statuses().brains.map(({ state }) => state)).toEqual(['ready', 'absent']);
  });

  it('a probe that throws leaves that brain’s last verdict standing, and the round still lands', async () => {
    let calls = 0;
    const flaky = fakeDriver('claude', {
      probe: async () => {
        calls += 1;
        if (calls > 1) throw new Error('probe blew up at /Users/someone/.claude');
        return { state: 'logged-out', detail: 'run /login' };
      },
    });
    const registry = createBrainRegistry({ drivers: [flaky], recheckFloorMs: 0 });
    const heard = vi.fn();
    registry.subscribe(heard);
    await registry.probe();
    await registry.probe();
    expect(calls).toBe(2);
    expect(heard).toHaveBeenCalledTimes(2);
    expect(registry.statuses().brains[0]).toMatchObject({ state: 'logged-out', detail: 'run /login' });
    expect(JSON.stringify(registry.statuses())).not.toContain('blew up');
  });

  it('a catalogue that throws is an EMPTY catalogue — one driver’s bug must not take `/status` down', () => {
    const broken = fakeDriver('claude', {
      catalog: () => {
        throw new Error('the cache moved');
      },
    });
    const registry = createBrainRegistry({ drivers: [broken, fakeDriver('codex')] });
    expect(registry.statuses().brains[0]).toMatchObject({ id: 'claude', efforts: [], models: [] });
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const registry = createBrainRegistry({ drivers: [fakeDriver('claude')] });
    const heard = vi.fn();
    const unsubscribe = registry.subscribe(heard);
    await registry.probe();
    unsubscribe();
    await registry.probe();
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe('a re-check is at most one round per floor (D4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Every probe of a READY `claude` is a real (tiny) think on the user's subscription, and a
  // page may ask after every failed think — so the page's eagerness is bounded HERE, where
  // the cost is.
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it('outside the floor it runs at once', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude], recheckFloorMs: 30_000 });
    await registry.probe();
    await vi.advanceTimersByTimeAsync(30_000);
    registry.recheck();
    await settle();
    expect(claude.probes).toBe(2);
  });

  it('asked five times INSIDE the floor it is OWED once — and runs when the floor allows, not before', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude], recheckFloorMs: 30_000 });
    await registry.probe();
    claude.readiness = { state: 'logged-out', detail: 'run /login' };
    for (let i = 0; i < 5; i += 1) registry.recheck();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(claude.probes, 'not inside the floor').toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claude.probes, 'owed, and paid when the floor allowed').toBe(2);
    expect(registry.statuses().brains[0]).toMatchObject({ state: 'logged-out' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claude.probes, 'five asks were ONE owed re-check').toBe(2);
  });

  it('with no round ever run, a re-check is the first round', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude], recheckFloorMs: 30_000 });
    registry.recheck();
    await settle();
    expect(claude.probes).toBe(1);
  });

  it('asked while a round is in flight it starts nothing', async () => {
    let finish: (value: BrainReadiness) => void = () => {};
    const slow = fakeDriver('claude', { probe: vi.fn(() => new Promise<BrainReadiness>((resolve) => (finish = resolve))) });
    const registry = createBrainRegistry({ drivers: [slow], recheckFloorMs: 0 });
    const round = registry.probe();
    registry.recheck();
    registry.recheck();
    expect(slow.probe).toHaveBeenCalledTimes(1);
    finish({ state: 'ready' });
    await round;
  });

  it('a stopped registry owes nothing — no probe fires after stop', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude], recheckFloorMs: 30_000 });
    await registry.probe();
    registry.recheck(); // owed, at the floor
    registry.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    registry.recheck();
    await registry.probe();
    expect(claude.probes).toBe(1);
  });

  it('the shipped floor is tens of seconds — a probe is not free', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude] });
    await registry.probe();
    registry.recheck();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claude.probes).toBe(1);
    expect(BRAIN_PROBE_FLOOR_MS).toBeGreaterThanOrEqual(10_000);
    await vi.advanceTimersByTimeAsync(BRAIN_PROBE_FLOOR_MS);
    expect(claude.probes).toBe(2);
  });
});

describe('selection never re-routes a think to another vendor (ADR-0071 §4; B3, B6)', () => {
  const READY: BrainReadiness = { state: 'ready' };
  const OUTDATED: BrainReadiness = { state: 'outdated', detail: 'run `claude update`' };
  const LOGGED_OUT: BrainReadiness = { state: 'logged-out', detail: 'run `codex login`' };

  const registryOf = async (claude: BrainReadiness | undefined, codex: BrainReadiness | undefined, codexVerified = false) => {
    const drivers = [
      ...(claude !== undefined ? [fakeDriver('claude', { readiness: claude })] : []),
      ...(codex !== undefined ? [fakeDriver('codex', { readiness: codex, verified: codexVerified })] : []),
    ];
    const registry = createBrainRegistry({ drivers });
    await registry.probe();
    return registry;
  };
  const answeredBy = (registry: Awaited<ReturnType<typeof registryOf>>, choice: string | undefined): string | undefined => {
    const resolved = registry.resolve(choice);
    return resolved.ok ? resolved.driver.id : undefined;
  };

  it.each([
    // choice,   claude,      codex,       codex verified, → who answers
    ['auto', READY, READY, false, 'claude'],
    [undefined, READY, READY, false, 'claude'],
    ['auto', READY, LOGGED_OUT, false, 'claude'],
    // The default brain is not ready: NONE — the page's demo brain answers. Never Codex,
    // verified or not: that would move an app's context to another vendor with no user act.
    ['auto', OUTDATED, READY, false, undefined],
    ['auto', OUTDATED, READY, true, undefined],
    ['auto', undefined, READY, true, undefined],
    // A pin names one brain. Not ready → NONE, never the other one.
    ['codex', READY, LOGGED_OUT, false, undefined],
    ['claude', OUTDATED, READY, true, undefined],
    // A pin is the ONE way an unverified brain answers.
    ['codex', READY, READY, false, 'codex'],
    ['codex', OUTDATED, READY, false, 'codex'],
    ['claude', READY, READY, true, 'claude'],
    // A brain this runner does not have.
    ['hermes', READY, READY, true, undefined],
    ['', READY, READY, true, undefined],
  ] as const)('choice %j with claude %j and codex %j (verified: %j) → %j', async (choice, claude, codex, codexVerified, expected) => {
    expect(answeredBy(await registryOf(claude, codex, codexVerified), choice)).toBe(expected);
  });

  it('`active` is what `auto` would run on NOW — and absent when that is nothing', async () => {
    expect((await registryOf(READY, READY)).statuses().active).toBe('claude');
    expect((await registryOf(OUTDATED, READY, true)).statuses()).not.toHaveProperty('active');
    expect((await registryOf(undefined, READY, true)).statuses()).not.toHaveProperty('active');
  });

  it('an UNVERIFIED default brain is never taken by `auto` — it answers only when pinned by id (B6)', async () => {
    const registry = createBrainRegistry({ drivers: [fakeDriver('codex', { verified: false })], defaultBrain: 'codex' });
    await registry.probe();
    expect(registry.statuses()).not.toHaveProperty('active');
    expect(registry.resolve('auto').ok).toBe(false);
    expect(answeredBy(registry, 'codex')).toBe('codex');
  });

  it('says WHY in one sentence when it cannot place a think — the remedy the driver gave, never a blank', async () => {
    const registry = await registryOf(OUTDATED, LOGGED_OUT);
    const auto = registry.resolve('auto');
    const pinned = registry.resolve('codex');
    const missing = registry.resolve('hermes');
    expect(auto).toEqual({ ok: false, message: 'CLAUDE is not ready — run `claude update`' });
    expect(pinned).toEqual({ ok: false, message: 'CODEX is not ready — run `codex login`' });
    expect(missing).toEqual({ ok: false, message: 'this runner has no brain called "hermes"' });
    expect(createBrainRegistry({ drivers: [] }).resolve('auto')).toEqual({ ok: false, message: 'this runner has no brain called "claude"' });
  });

  it('a verdict that changed is honoured by the very next think — ready → logged-out → ready', async () => {
    const claude = fakeDriver('claude');
    const registry = createBrainRegistry({ drivers: [claude], recheckFloorMs: 0 });
    await registry.probe();
    expect(answeredBy(registry, 'auto')).toBe('claude');
    claude.readiness = { state: 'logged-out', detail: 'run /login' };
    await registry.probe();
    expect(answeredBy(registry, 'auto')).toBeUndefined();
    claude.readiness = { state: 'ready' };
    await registry.probe();
    expect(answeredBy(registry, 'auto')).toBe('claude');
  });
});

describe('a brain is made once, on first use, and every one made is reaped (B1)', () => {
  it('create() runs at the first think that resolves to the driver — not before, and not again', async () => {
    const claude = fakeDriver('claude');
    const codex = fakeDriver('codex');
    const registry = createBrainRegistry({ drivers: [claude, codex] });
    await registry.probe();
    expect([claude.created, codex.created]).toEqual([0, 0]);
    const first = registry.resolve('auto');
    const second = registry.resolve('claude');
    expect([claude.created, codex.created]).toEqual([1, 0]);
    expect(first.ok && second.ok && first.brain === second.brain).toBe(true);
  });

  it('stop() reaps EVERY created brain — reverting it would leave pre-warmed children behind — and places nothing afterwards', async () => {
    const stops = { claude: vi.fn(), codex: vi.fn(), never: vi.fn() };
    const registry = createBrainRegistry({
      drivers: [
        fakeDriver('claude', { create: () => answeringBrain(stops.claude) }),
        fakeDriver('codex', { create: () => answeringBrain(stops.codex) }),
        fakeDriver('unused', { create: () => answeringBrain(stops.never) }),
      ],
    });
    await registry.probe();
    registry.resolve('claude');
    registry.resolve('codex');
    registry.stop();
    expect(stops.claude).toHaveBeenCalledTimes(1);
    expect(stops.codex).toHaveBeenCalledTimes(1);
    expect(stops.never).not.toHaveBeenCalled();
    expect(registry.resolve('claude')).toEqual({ ok: false, message: 'the runner is stopping' });
  });

  it('refuses two drivers with one id — the wire and the pin would both be ambiguous', () => {
    expect(() => createBrainRegistry({ drivers: [fakeDriver('claude'), fakeDriver('claude')] })).toThrow(/claude/);
  });
});

// ------------------------------------------------------------- the shipped registry

describe('the shipped drivers (the release entry’s registry)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'snug-brains-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * THE HOSTILE PARENT (B4). The twelve `CLAUDE_*` names were measured in a live Claude Code
   * session on 2026-09-07 — the messaging token and socket are a live IPC channel back into
   * it — and the keys are every credential variable either vendor's CLI reads. A brain on a
   * key is not "the user's own agent" (D15), and a key that reached a child would be one
   * process away from an app's think.
   */
  const HOSTILE_PARENT: Record<string, string> = {
    HOME: '/Users/x',
    PATH: '/usr/bin',
    SHELL: '/bin/zsh',
    USER: 'x',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp/x',
    TERM: 'xterm-256color',
    CLAUDECODE: 'canary-1',
    CLAUDE_CODE_ENTRYPOINT: 'canary-2',
    CLAUDE_CODE_SESSION_ID: 'canary-3',
    CLAUDE_CODE_CHILD_SESSION: 'canary-4',
    CLAUDE_CODE_EXECPATH: 'canary-5',
    CLAUDE_CODE_MESSAGING_SOCKET: 'canary-6',
    CLAUDE_CODE_MESSAGING_TOKEN: 'canary-7',
    CLAUDE_CODE_ENABLE_TASKS: 'canary-8',
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'canary-9',
    CLAUDE_AGENT_SDK_VERSION: 'canary-10',
    CLAUDE_PID: 'canary-11',
    CLAUDE_EFFORT: 'canary-12',
    ANTHROPIC_API_KEY: 'canary-sk-ant',
    ANTHROPIC_AUTH_TOKEN: 'canary-ant-token',
    ANTHROPIC_BASE_URL: 'https://canary.example',
    OPENAI_API_KEY: 'canary-sk-openai',
    OPENAI_BASE_URL: 'https://canary.example',
    CODEX_API_KEY: 'canary-codex-key',
    CODEX_ACCESS_TOKEN: 'canary-codex-token',
    CODEX_HOME: '/Users/x/canary-codex-home',
    SNUG_HOME: '/Users/x/canary-snug-home',
    NODE_OPTIONS: '--require /canary.js',
  };

  /** Every environment any driver handed to any child it started. */
  const shipped = () => {
    const claude = fakeSpawner();
    const codex = fakeCodexSpawner(() => ({ stdout: CODEX_SUCCESS_STREAM }));
    const cwds: Record<string, Set<string | undefined>> = { claude: new Set(), codex: new Set() };
    const drivers = machineDrivers(
      { home },
      {
        parentEnv: HOSTILE_PARENT,
        execDir: '/opt/node/bin',
        claude: {
          resolveBinary: () => '/Users/x/.local/bin/claude',
          models: () => [],
          spawnBinary: (_binary, args, env, cwd) => {
            cwds.claude!.add(cwd);
            return claude.spawnChild(args, env);
          },
        },
        codex: {
          resolveBinary: () => '/Users/x/.local/bin/codex',
          spawn: (binary, args, options) => {
            cwds.codex!.add(options.cwd);
            return codex.spawn(binary, args, options);
          },
        },
      },
    );
    return { drivers, claude, codex, cwds };
  };
  const think = { messages: [{ role: 'system', content: 'be a brain' }, { role: 'user', content: 'ping' }] };

  it('are `claude` then `codex` — and only Claude’s posture has been proven on a real login', () => {
    const { drivers } = shipped();
    expect(drivers.map(({ id, verified, streaming }) => ({ id, verified, streaming }))).toEqual([
      { id: 'claude', verified: true, streaming: true },
      { id: 'codex', verified: false, streaming: false },
    ]);
  });

  it('say who they are in the words the page’s wire fixture pins — the fixture is the real drivers, not an invention', () => {
    const wire = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'status-wire.json'), 'utf8')) as { brains: Array<Record<string, unknown>> };
    const identity = ({ id, name, via, verified, streaming }: Record<string, unknown>) => ({ id, name, via, verified, streaming });
    const { drivers } = shipped();
    expect(drivers.map((driver) => identity(driver as unknown as Record<string, unknown>))).toEqual(wire.brains.map(identity));
    // The fixture was written on a Mac: its prompt limit is macOS's, for both brains.
    expect(wire.brains.map((brain) => brain.maxPromptBytes)).toEqual([argvPromptLimit('darwin'), argvPromptLimit('darwin')]);
    expect(drivers.map((driver) => driver.maxPromptBytes)).toEqual([argvPromptLimit(), argvPromptLimit()]);
    // Claude's levels are its CLI's five; a model with no thinking axis has none.
    expect(drivers[0]!.catalog().efforts).toEqual(wire.brains[0]!.efforts);
    // Codex's not-logged-in sentence is the one the fixture shows.
    expect(wire.brains[1]!.detail).toBe(CODEX_SENTENCES.loggedOut);
  });

  it('Claude’s catalogue becomes per-model levels: the five where the model has a thinking axis, none where it does not', () => {
    const [claude] = machineDrivers(
      { home },
      {
        parentEnv: HOSTILE_PARENT,
        claude: {
          resolveBinary: () => '/x/claude',
          models: () => [
            { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', effort: true },
            { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', effort: false },
          ],
        },
      },
    );
    const five = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(claude!.catalog()).toEqual({
      efforts: five,
      models: [
        { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts: five },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
      ],
    });
    // A level is judged for the chosen model: Haiku has none; a model the catalogue does
    // not list — free text, the CLI's to refuse by name — may carry any of the five.
    expect(claude!.acceptsEffort('claude-sonnet-5-5', 'xhigh')).toBe(true);
    expect(claude!.acceptsEffort('claude-haiku-4-5-20251001', 'low')).toBe(false);
    expect(claude!.acceptsEffort(undefined, 'max')).toBe(true);
    expect(claude!.acceptsEffort('claude-some-new-model', 'low')).toBe(true);
    expect(claude!.acceptsEffort('claude-sonnet-5-5', 'ultra'), 'not one of Claude’s five — that is Codex’s word').toBe(false);
    expect(claude!.acceptsEffort(undefined, 'quick'), 'ADR-0067’s tier is another axis on another binding').toBe(false);
    // The model is free text held to the shape that can ride argv (ADR-0070 §4).
    expect(claude!.acceptsModel('claude-opus-5-5[1m]')).toBe(true);
    expect(claude!.acceptsModel('--dangerously-skip-permissions')).toBe(false);
  });

  it('a think too large for the command line is a NAMED refusal on Claude too (E2BIG), not "spawn E2BIG"', async () => {
    const [claude] = machineDrivers(
      { home },
      {
        parentEnv: HOSTILE_PARENT,
        claude: {
          resolveBinary: () => '/x/claude',
          models: () => [],
          spawnBinary: () => {
            throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
          },
        },
      },
    );
    await expect(claude!.create().complete(think)).rejects.toThrow(PROMPT_TOO_LARGE);
    expect(PROMPT_TOO_LARGE).not.toMatch(/E2BIG|spawn/);
  });

  it('EVERY child of EVERY driver — probe, catalogue and think — gets the allowlist and nothing else (C1)', async () => {
    const { drivers, claude, codex } = shipped();
    for (const driver of drivers) {
      await driver.probe();
      const brain = driver.create();
      await brain.complete(think).catch(() => {});
      brain.stop();
    }
    const envs = [...claude.children.map((child) => child.env), ...codex.children.map((child) => child.options.env)];
    // claude: a probe, a think and its pre-warmed replacement; codex: `login status`, a think.
    expect(claude.children.length).toBeGreaterThanOrEqual(3);
    expect(codex.children.length).toBeGreaterThanOrEqual(2);
    for (const env of envs) {
      expect(Object.keys(env).filter((name) => !(CHILD_ENV_ALLOWLIST as readonly string[]).includes(name))).toEqual([]);
      expect(JSON.stringify(env)).not.toContain('canary');
      // Codex finds its login through HOME; a CODEX_HOME of the parent's would point it at
      // somebody else's.
      expect(env).not.toHaveProperty('CODEX_HOME');
      expect(env.HOME).toBe('/Users/x');
      // The Node that runs this process leads the child's PATH: both CLIs' npm installs are
      // `#!/usr/bin/env node` shims (measured, exit 127 without one).
      expect(env.PATH).toBe(`/opt/node/bin${path.delimiter}/usr/bin`);
    }
  });

  it('the registry holds the ONLY whole-environment read under src/ — every other module is handed it or reads a name', () => {
    // The release gate (`scripts/check-host-mcp.mjs`) counts these in the shipped bundle and
    // allows one. This is the same count on the sources, where the offender has a file name.
    const src = path.join(__dirname, '..', '..');
    const whole = (file: string): number =>
      (readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .match(/process\.env(?!\s*(?:\.[A-Za-z_$]|\[["'`]))/g) ?? []).length;
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.name === '__tests__' ? [] : entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith('.ts') ? [path.join(dir, entry.name)] : [],
      );
    const readers = walk(src)
      // The TEST entry reads its hooks through constants (`process.env[NAME]`); it never ships.
      .filter((file) => !file.endsWith('main.test-hooks.ts'))
      .map((file) => [path.relative(src, file), whole(file)] as const)
      .filter(([, count]) => count > 0);
    expect(readers).toEqual([[path.join('brains', 'registry.ts'), 1]]);
  });

  it('the whole child env is ONE object, built once and shared — not one read per driver', async () => {
    const { drivers, claude, codex } = shipped();
    for (const driver of drivers) await driver.probe();
    expect(codex.children[0]!.options.env).toBe(claude.children[0]!.env);
  });

  it('each driver thinks in its OWN neutral directory under the Snug home — created 0700 for Codex, and empty', async () => {
    const { drivers, cwds } = shipped();
    for (const driver of drivers) {
      await driver.probe();
      const brain = driver.create();
      await brain.complete(think).catch(() => {});
      brain.stop();
    }
    const claudeDir = path.join(home, 'host', 'brain');
    const codexDir = path.join(home, 'host', 'brain-codex');
    expect([...cwds.claude!]).toEqual([claudeDir]);
    expect([...cwds.codex!]).toEqual([codexDir]);
    expect(existsSync(claudeDir)).toBe(true);
    expect(statSync(codexDir).mode & 0o777).toBe(0o700);
  });
});
