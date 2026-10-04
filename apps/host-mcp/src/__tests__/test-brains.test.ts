// The TEST build's brains (K5, ADR-0071): fake drivers, described by one env var.
//
// The browser suite drives the real process, and the real process must never reach the
// developer's real CLIs — a suite that did would spend their subscription on thinks nobody
// asked for (it once did). So the test entry's registry is built ONLY from
// `SNUG_MCP_TEST_BRAINS`, and with nothing given there is no brain at all.

import { describe, expect, it } from 'vitest';

import { createBrainRegistry } from '../brains/registry.js';
import { fakeDriversFromEnv, TEST_BRAINS_ENV } from '../main.test-hooks.js';

const spec = (...brains: unknown[]): string => JSON.stringify(brains);
const CLAUDE = { id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state: 'ready', verified: true };

const frames = async (driver: ReturnType<typeof fakeDriversFromEnv>[number]): Promise<Array<Record<string, unknown> | string>> => {
  const body = await driver.create().complete({ messages: [{ role: 'user', content: 'x' }] });
  return body
    .split('\n\n')
    .filter((frame) => frame !== '')
    .map((frame) => (frame === 'data: [DONE]' ? frame : (JSON.parse(frame.slice('data: '.length)) as Record<string, unknown>)));
};

describe('fakeDriversFromEnv', () => {
  it('is named with the prefix the release gate sweeps for', () => {
    expect(TEST_BRAINS_ENV).toBe('SNUG_MCP_TEST_BRAINS');
  });

  it('with nothing given there is NO brain — the unpinned test build can reach no CLI', () => {
    expect(fakeDriversFromEnv(undefined)).toEqual([]);
    expect(fakeDriversFromEnv('')).toEqual([]);
    expect(createBrainRegistry({ drivers: fakeDriversFromEnv(undefined) }).statuses()).toEqual({ brains: [] });
  });

  it('makes one driver per entry, in order, whose probe answers the pinned state at once', async () => {
    const drivers = fakeDriversFromEnv(
      spec(CLAUDE, { id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'logged-out', detail: 'run `codex login`', verified: false, streaming: false }),
    );
    const registry = createBrainRegistry({ drivers });
    await registry.probe();
    expect(registry.statuses()).toEqual({
      active: 'claude',
      brains: [
        { id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state: 'ready', verified: true, streaming: true, efforts: [], models: [] },
        { id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'logged-out', detail: 'run `codex login`', verified: false, streaming: false, efforts: [], models: [] },
      ],
    });
  });

  it('carries a catalogue, and judges a level by the chosen model’s own', () => {
    const [driver] = fakeDriversFromEnv(
      spec({ ...CLAUDE, efforts: ['low', 'high'], models: [{ id: 'm-think', name: 'Thinker', efforts: ['low', 'high', 'max'] }, { id: 'm-plain', name: 'Plain', efforts: [] }] }),
    );
    expect(driver!.catalog()).toEqual({ efforts: ['low', 'high'], models: [{ id: 'm-think', name: 'Thinker', efforts: ['low', 'high', 'max'] }, { id: 'm-plain', name: 'Plain', efforts: [] }] });
    expect(driver!.acceptsEffort('m-think', 'max')).toBe(true);
    expect(driver!.acceptsEffort('m-plain', 'low')).toBe(false);
    expect(driver!.acceptsEffort(undefined, 'high')).toBe(true);
    expect(driver!.acceptsEffort(undefined, 'max')).toBe(false);
    // A model the catalogue does not list is free text, held to the shape that could ride argv.
    expect(driver!.acceptsEffort('m-other', 'low')).toBe(true);
    expect(driver!.acceptsModel('m-other')).toBe(true);
    expect(driver!.acceptsModel('--flag')).toBe(false);
  });

  it('a fake with a `reply` streams it in the real brain’s frames, and reports `<id>-fake` as the model that answered', async () => {
    const [driver] = fakeDriversFromEnv(spec({ ...CLAUDE, reply: '{"message":"pinned reply"}' }));
    // The SHAPE the real brains answer: a fake that answered plain JSON once let a page-side
    // bug pass.
    expect(await frames(driver!)).toMatchObject([
      { object: 'chat.completion.chunk', model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: '{"message":"pinned reply"}' }, finish_reason: null }] },
      { object: 'chat.completion.chunk', model: 'claude-fake', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      'data: [DONE]',
    ]);
  });

  it('…or the `resolvedModel` it was given — what a spec that asserts "the chip names what ANSWERED" pins', async () => {
    const [driver] = fakeDriversFromEnv(spec({ ...CLAUDE, reply: 'ok', resolvedModel: 'claude-sonnet-5-e2e-resolved' }));
    expect((await frames(driver!))[1]).toMatchObject({ model: 'claude-sonnet-5-e2e-resolved' });
  });

  it('a fake WITHOUT a reply refuses by name — the 502 a brain that cannot answer gives', async () => {
    const [driver] = fakeDriversFromEnv(spec({ id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'ready', verified: false }));
    await expect(driver!.create().complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/fake "codex" brain has no reply/);
  });

  it('passes a state it does not know straight through — that is how a spec shows the page an unknown one', async () => {
    const registry = createBrainRegistry({ drivers: fakeDriversFromEnv(spec({ ...CLAUDE, state: 'hibernating', detail: 'wake it up' })) });
    await registry.probe();
    expect(registry.statuses()).toMatchObject({ brains: [{ state: 'hibernating', detail: 'wake it up' }] });
    expect(registry.statuses()).not.toHaveProperty('active');
  });

  it('`afterRecheck` is what its probe answers from the SECOND round on — a brain the user fixed while the page was open', async () => {
    const registry = createBrainRegistry({
      drivers: fakeDriversFromEnv(spec({ ...CLAUDE, state: 'logged-out', detail: 'run /login', afterRecheck: { state: 'ready' } })),
      recheckFloorMs: 0,
    });
    await registry.probe();
    expect(registry.statuses()).toMatchObject({ brains: [{ state: 'logged-out', detail: 'run /login' }] });
    expect(registry.statuses()).not.toHaveProperty('active');
    await registry.probe();
    expect(registry.statuses()).toMatchObject({ active: 'claude', brains: [{ state: 'ready' }] });
    expect(registry.statuses().brains[0]).not.toHaveProperty('detail');
    await registry.probe();
    expect(registry.statuses()).toMatchObject({ active: 'claude', brains: [{ state: 'ready' }] });
  });

  it.each([
    ['an afterRecheck with no state', spec({ ...CLAUDE, afterRecheck: { detail: 'x' } })],
    ['not JSON', '{nope'],
    ['not an array', '{"id":"claude"}'],
    ['an entry that is not an object', '["claude"]'],
    ['an entry with no id', spec({ name: 'X', via: 'x', state: 'ready', verified: true })],
    ['an entry whose verified is not a boolean', spec({ ...CLAUDE, verified: 'yes' })],
    ['a model with no efforts list', spec({ ...CLAUDE, models: [{ id: 'm', name: 'M' }] })],
  ])('fails LOUDLY on %s — a typo in a spec must not read as "no brain"', (_label, value) => {
    expect(() => fakeDriversFromEnv(value)).toThrow(/SNUG_MCP_TEST_BRAINS/);
  });
});
