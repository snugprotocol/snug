// The local page's platform (ADR-0068 D-B14, D-B24) — and the brain it carries (ADR-0071).
//
// MIGRATED 2026-10-03 (TASK-20261003 R4, B2/B8 — named in the plan), claim by claim. The
// composition used to read ONE brain's verdict (`status.brain`) and model list, pin the host
// arm optimistically, and hang a `cliModel` seat on it. It now reads every brain the runner
// reports (`brains[]`, `active`), resolves the user's choice against them by the runner's
// own rule, and carries `platform.brainSwitch`. Each test below says what it was where the
// claim moved; the claims themselves are kept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BRAIN_AUTO, demoStandIn } from '@playground/platform/copy';
import { hostCapabilities } from '@playground/platform/hostCapabilities';
import type { BrainSwitchSeat, SnugPlatform } from '@playground/platform/platform';
import { brainRevisionStore } from '@playground/platform/signals';

import { BRAIN_CHOICE_STORAGE_KEY } from '../brains/brainChoiceStore.js';
import type { BrainWire, LocalClient, LocalStatus } from '../local/client.js';
import { DEMO_RECHECK_FLOOR_MS, RECHECK_BOUND_MS, applyRunnerStatus, brainFor, brainLabel, composeLocalPlatform, prefsFor } from '../local/compose-local.js';

/** The client's whole surface (it grew `reportHandIn`, `recheckBrain` and `stopped` in TASK-20261003). */
const fakeClient = (over: Partial<LocalClient> = {}): LocalClient => ({
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  events: () => () => {},
  reportHandIn: async () => {},
  recheckBrain: async () => {},
  stopped: { get: () => false, subscribe: () => () => {} },
  ...over,
});
const client = fakeClient();

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, brains: [], ...over });

const FIVE = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Two brains as the runner reports them — each with ITS OWN levels, per model. */
const CLAUDE: BrainWire = {
  id: 'claude',
  name: 'Claude',
  via: 'your Claude Code CLI',
  state: 'ready',
  verified: true,
  streaming: true,
  efforts: FIVE,
  models: [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: FIVE },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', efforts: FIVE },
    { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] },
  ],
  maxPromptBytes: 900_000,
};
const CODEX: BrainWire = {
  id: 'codex',
  name: 'Codex',
  via: 'your Codex CLI',
  state: 'ready',
  verified: false,
  streaming: false,
  efforts: ['minimal', 'low', 'medium', 'high'],
  models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'high'] }],
  maxPromptBytes: 120_000,
};
const claude = (over: Partial<BrainWire> = {}): BrainWire => ({ ...CLAUDE, ...over });
const codex = (over: Partial<BrainWire> = {}): BrainWire => ({ ...CODEX, ...over });
const LOGGED_OUT = 'Your Claude CLI is not logged in — run `claude` and `/login`, then check again.';

/** The runner with its default brain ready and answering. */
const READY: Partial<LocalStatus> = { active: 'claude', brains: [CLAUDE] };
/** The same runner knowing its one brain cannot answer. */
const notReady = (state: string, detail?: string): Partial<LocalStatus> => ({ brains: [claude({ state, ...(detail !== undefined ? { detail } : {}) })] });
/** Both brains ready: `auto` is Claude, Codex is there to pin. */
const BOTH: Partial<LocalStatus> = { active: 'claude', brains: [CLAUDE, CODEX] };

/** `PlatformBrain` is a union and only its `host` arm carries a label — narrow, don't cast. */
const labelOf = (brain: { kind: string } | undefined): string | undefined =>
  brain !== undefined && brain.kind === 'host' ? (brain as unknown as { label: string }).label : undefined;

const seatOf = (platform: SnugPlatform): BrainSwitchSeat => {
  if (platform.brainSwitch === undefined) throw new Error('the runner’s platform carries no brainSwitch');
  return platform.brainSwitch;
};

interface Think {
  ok: boolean;
  text?: string;
  code?: string;
  message?: string;
}
const adapterOf = (platform: SnugPlatform): { complete(request: unknown): Promise<Think> } => {
  // The host ARM, taken while it is the platform's brain.
  const brain = platform.brain as unknown as { kind: string; adapter: { complete(request: unknown): Promise<Think> } };
  if (brain.kind !== 'host') throw new Error('the demo brain is answering — there is no host adapter to call');
  return brain.adapter;
};
const think = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

/** The shim's real answer: SSE, deltas, then the resolved model on the final frame. */
const sse = (resolved: string, placeholder = 'claude'): string => {
  const base = { id: 'chatcmpl-snug-x', object: 'chat.completion.chunk', created: 1 };
  return (
    `data: ${JSON.stringify({ ...base, model: placeholder, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ ...base, model: resolved, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
    'data: [DONE]\n\n'
  );
};
const answer = (resolved: string, by?: string): Response =>
  new Response(sse(resolved, by ?? 'claude'), { headers: { 'content-type': 'text/event-stream', ...(by !== undefined ? { 'x-snug-brain': by } : {}) } });
const refusal = (statusCode: number, message: string, extra: { code?: string; by?: string } = {}): Response =>
  new Response(JSON.stringify({ error: { message, ...(extra.code !== undefined ? { code: extra.code } : {}) } }), {
    status: statusCode,
    headers: { 'content-type': 'application/json', ...(extra.by !== undefined ? { 'x-snug-brain': extra.by } : {}) },
  });

/** Stub the page's own fetch; every call's url and parsed body is recorded. */
const stubFetch = (respond: (body: Record<string, unknown>) => Response | Promise<Response>) => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(url), body });
    return respond(body);
  });
  return calls;
};

const compose = (over: Partial<LocalStatus> = {}, using: LocalClient = client): SnugPlatform =>
  composeLocalPlatform(using, status(over), undefined, undefined, 't').platform;

beforeEach(() => {
  // The composition's default choice store is over `localStorage`, which jsdom keeps for the file.
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the brain chip names what the CLI can actually do (D-B35)', () => {
  it('says "Claude · your CLI" when the CLI is ready', () => {
    expect(labelOf(compose(READY).brain)).toBe('Claude · your CLI');
  });

  it('a logged-out CLI is NAMED with its remedy — and no think is sent to it', () => {
    // The owner's walk: a logged-out CLI surfaced as a bare HTTP 502 at the first think,
    // with no remedy and no sign the brain was the problem.
    //
    // MIGRATED twice. D4 (R2) moved the platform to the demo brain there and left the
    // remedy with no surface; R4 gives it one: the seat lists the brain with the RUNNER's
    // own sentence, and the stand-in the chip and the passport read names it.
    const platform = compose(notReady('logged-out', LOGGED_OUT));
    expect(platform.brain).toEqual({ kind: 'demo' });
    const state = seatOf(platform).state.get();
    expect(state.active).toBeUndefined();
    expect(state.brains[0]).toMatchObject({ id: 'claude', state: 'logged-out', detail: LOGGED_OUT });
    expect(demoStandIn(state)).toMatchObject({ why: 'Claude · not logged in', remedy: LOGGED_OUT });
  });

  it('falls back to the demo brain’s wording when no CLI is installed', () => {
    // A machine with no `claude` gets a different sentence: telling that user to /login
    // sends them to a CLI they do not have.
    const platform = compose(notReady('absent'));
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(demoStandIn(seatOf(platform).state.get())?.why).toBe('Claude · not installed');
  });

  it('the label is a LIVE getter, so a probe answering after boot corrects the chip in place', () => {
    // The probe runs in the background — the kit must open even if the CLI is wedged — so
    // the chip's first value is the boot one and the `status` event carries the verdict.
    // It CANNOT arrive by recomposing: the platform is set once and `setPlatform` throws on
    // a second call (see localBrainEvent.test.ts), so the seat reads its sources at render.
    //
    // MIGRATED 2026-10-03 (R4): before any brain is reported the page no longer pins the
    // host arm on a guess — `active` is absent, so the demo brain answers (the runner's
    // rule, mirrored). The claim is unchanged: the SAME platform object follows the verdict.
    const platform = compose();
    expect(platform.brain).toEqual({ kind: 'demo' });
    applyRunnerStatus(READY);
    expect(labelOf(platform.brain), 'the SAME platform object must now read the new label').toBe('Claude · your CLI');
    applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
    expect(platform.brain, 'and a verdict that the CLI cannot answer moves the SAME object back').toEqual({ kind: 'demo' });
  });

  it('does not claim the CLI is ready before the probe has answered', () => {
    // `/status` lists no brain until the first probe returns. Reporting "ready" during that
    // window would be a guess that is wrong exactly when it matters.
    const state = seatOf(compose()).state.get();
    expect(state).toEqual({ choice: 'auto', brains: [], checking: false });
    expect(demoStandIn(state)?.why).toBe('looking for your agents');
  });
});

describe('the platform this binding carries', () => {
  it('turns connections ON — the one binding with connected apps', () => {
    // RunView keys its net handler on this, so host-ready.net becomes true structurally.
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.connections).toBe(true);
  });

  it('carries fetchImpl, so the executor reaches the network through the process', () => {
    expect(composeLocalPlatform(client, status()).platform.fetchImpl).toBeTypeOf('function');
  });

  it('leaves platform.oauth UNDEFINED, so the wizard keeps its web popup path', () => {
    // Setting it flips the wizard's one "not a browser" discriminator: the popup-blocker
    // escape is skipped and a handle-less pseudo-popup with no null check is installed, so
    // window.open — already past its user activation — returns null and the flow parks on
    // awaiting_callback forever.
    expect(composeLocalPlatform(client, status()).platform.oauth).toBeUndefined();
  });

  it('carries no LAN seats, so a LAN row gets the executor’s named refusal', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.lanFetch).toBeUndefined();
    expect(platform.lanPair).toBeUndefined();
    expect(platform.capabilities.lanHttpPrivate).toBe(false);
  });

  it('keeps the D15 controls off', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.brainSettings).toBe(false);
    expect(platform.capabilities.account).toBe(false);
  });

  it('keeps the per-app export on while link sharing stays off', () => {
    const { platform } = composeLocalPlatform(client, status());
    expect(platform.capabilities.appExport).toBe(true);
    expect(platform.capabilities.share).toBe(false);
  });
});

describe('when another product holds the file (D-B24)', () => {
  it('REFUSES to open rather than running read-only', () => {
    // Both of the db's save paths swallow a failed write, so a read-only page would take an
    // hour of work and lose it silently on tab close.
    const { refusal: refused } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(refused).toEqual({ heldBy: 'Snug for Mac' });
  });

  it('carries no userdb backend at all in that state — nothing can write', () => {
    const { platform } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(platform.userdbBackend).toBeUndefined();
    expect(platform.capabilities.connections).toBe(false);
  });

  it('and no brain seat of either kind — a page that will not open thinks with nothing', () => {
    const { platform } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac', ...READY }), undefined, undefined, 't');
    expect(platform.brain).toBeUndefined();
    expect(platform.brainSwitch).toBeUndefined();
  });
});

describe('the chip’s two newer states (ADR-0069 §6)', () => {
  // MIGRATED (D4 in R2, then R4): each read its sentence off `platform.brain`'s label, then
  // off a page-side `brainLabel(state)`. The platform pins the DEMO brain for both, and the
  // sentence is now the RUNNER's — each driver writes its own remedy (ADR-0071 §6) and the
  // page shows it as sent; with none sent it says the state in words.
  it('names an OUTDATED cli with `claude update`', () => {
    const detail = 'Your Claude CLI is out of date — run `claude update`, then check again.';
    const platform = compose(notReady('outdated', detail));
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(demoStandIn(seatOf(platform).state.get())).toMatchObject({ why: 'Claude · out of date', remedy: detail });
  });

  it('tells a user with NO cli how to get one, in the runner’s words — and in plain ones when it sent none', () => {
    // WAS "…in words — not a curl pipe": that the install sentence names a page to visit and
    // never a curl-into-bash line is the driver's to hold now (its sentence, its test).
    const detail = 'No Claude CLI was found — install Claude Code (code.claude.com), then run `claude` and `/login`.';
    expect(demoStandIn(seatOf(compose(notReady('absent', detail))).state.get())?.remedy).toBe(detail);
    expect(demoStandIn(seatOf(compose(notReady('absent'))).state.get())?.remedy).toBe('Claude is not installed.');
  });
});

describe('the control survives the probe answering LATE (S7)', () => {
  it('the SEAT is there from the first paint; the brain and its controls arrive when the probe reports ready', () => {
    // WAS "appears once the probe reports ready…": `cliModel` lived on the host arm and was
    // undefined until then. The switcher lives on the PLATFORM, whatever answers — it is
    // where the user reads why nothing does — and what arrives late is its contents.
    const platform = compose();
    const seat = seatOf(platform);
    expect(seat.state.get().active).toBeUndefined();
    applyRunnerStatus(READY);
    // The platform is set ONCE and cannot be recomposed, so the same seat must now say more.
    expect(seatOf(platform)).toBe(seat);
    expect(seat.state.get()).toMatchObject({ active: 'claude', brains: [CLAUDE] });
  });

  it('the controls go again if the CLI stops being able to think — no dead control, ever', () => {
    // WAS "disappears again if the CLI stops being able to think".
    const platform = compose(READY);
    const seat = seatOf(platform);
    seat.setModel('claude-sonnet-5');
    seat.setEffort('high');
    expect(seat.state.get()).toMatchObject({ active: 'claude', model: 'claude-sonnet-5', effort: 'high' });
    applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
    const state = seat.state.get();
    expect(state.active).toBeUndefined();
    expect('model' in state || 'effort' in state, 'no brain answers, so no model or level is shown').toBe(false);
    // …and the setters, with no brain to set them for, change nothing.
    const stored = localStorage.getItem(BRAIN_CHOICE_STORAGE_KEY);
    seat.setModel('claude-opus-5-5');
    seat.setEffort('low');
    expect(localStorage.getItem(BRAIN_CHOICE_STORAGE_KEY)).toBe(stored);
  });
});

describe('the seat is stable across renders (S7 — useSyncExternalStore)', () => {
  it('returns the SAME state object on two reads, or the chip re-renders forever', () => {
    const platform = compose(READY);
    expect(platform.brainSwitch).toBe(platform.brainSwitch);
    expect(seatOf(platform).state.get()).toBe(seatOf(platform).state.get());
  });

  it('gives the chip a NEW state, and notifies, when the user switches', () => {
    const seat = seatOf(compose(READY));
    let notified = 0;
    seat.state.subscribe(() => void (notified += 1));
    const before = seat.state.get();
    seat.setEffort('max');
    expect(notified).toBe(1);
    expect(seat.state.get()).not.toBe(before);
    expect(seat.state.get().effort).toBe('max');
  });
});

describe('WHICH brain answers — the runner’s rule, mirrored exactly (ADR-0071 §4, B3)', () => {
  const both = (over: { active?: string; claude?: Partial<BrainWire>; codex?: Partial<BrainWire> }) => ({
    ...(over.active !== undefined ? { active: over.active } : {}),
    brains: [claude(over.claude), codex(over.codex)],
  });

  it.each([
    ['auto → what the runner calls active', BRAIN_AUTO, both({ active: 'claude' }), 'claude'],
    ['auto, nothing active → NONE', BRAIN_AUTO, both({}), undefined],
    ['claude outdated + codex ready + auto → NONE: never another vendor without a user act', BRAIN_AUTO, both({ claude: { state: 'outdated' } }), undefined],
    ['auto follows `active`, not its own reading of a state', BRAIN_AUTO, both({ active: 'claude', claude: { state: 'unknown' } }), 'claude'],
    ['auto NEVER takes an unverified brain, even if a status named one', BRAIN_AUTO, both({ active: 'codex' }), undefined],
    ['auto, active names a brain that is not listed → NONE', BRAIN_AUTO, both({ active: 'hermes' }), undefined],
    ['a pin → that brain while it is ready', 'codex', both({ active: 'claude' }), 'codex'],
    ['an UNVERIFIED brain answers when it is pinned by id', 'codex', both({}), 'codex'],
    ['pinned codex logged-out + claude ready → NONE, never claude', 'codex', both({ active: 'claude', codex: { state: 'logged-out' } }), undefined],
    ['a pin on a brain that could not be checked → NONE: unknown is never ready', 'claude', both({ claude: { state: 'unknown' } }), undefined],
    ['a pin on a state this build has never heard of → NONE', 'claude', both({ claude: { state: 'rate-limited' } }), undefined],
    ['a pin on a brain the runner does not list → NONE', 'hermes', both({ active: 'claude' }), undefined],
    ['a pin is the pin even while the runner’s `active` is another brain', 'claude', both({ active: 'claude' }), 'claude'],
  ])('%s', (_label, choice, runner, expected) => {
    expect(brainFor(choice, runner)?.id).toBe(expected);
  });

  it('the platform follows it: pin Codex → Codex answers; back to auto → Claude', () => {
    const platform = compose(BOTH);
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    seatOf(platform).choose('codex');
    expect(labelOf(platform.brain)).toBe('Codex · your CLI');
    expect(seatOf(platform).state.get()).toMatchObject({ choice: 'codex', active: 'codex' });
    seatOf(platform).choose('auto');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
  });

  it('a pinned brain that stops being ready → the DEMO brain, though another brain is ready', () => {
    const platform = compose(BOTH);
    seatOf(platform).choose('codex');
    const logged = 'Your Codex CLI is not logged in — run `codex login`, then check again.';
    applyRunnerStatus({ active: 'claude', brains: [CLAUDE, codex({ state: 'logged-out', detail: logged })] });
    expect(platform.brain).toEqual({ kind: 'demo' });
    const state = seatOf(platform).state.get();
    expect(state).toMatchObject({ choice: 'codex' });
    expect(state.active).toBeUndefined();
    expect(demoStandIn(state)).toMatchObject({ why: 'Codex · not logged in', remedy: logged });
  });

  it('the seat refuses to pin a brain that is not ready — no dead pin', () => {
    const platform = compose({ active: 'claude', brains: [CLAUDE, codex({ state: 'logged-out' })] });
    expect(() => seatOf(platform).choose('codex')).toThrow(/not ready/);
    expect(seatOf(platform).state.get().choice).toBe('auto');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
  });

  it('the pin is judged against what the runner says NOW — a brain that became ready after boot can be pinned', () => {
    const platform = compose({ active: 'claude', brains: [CLAUDE, codex({ state: 'logged-out' })] });
    applyRunnerStatus(BOTH);
    expect(() => seatOf(platform).choose('codex')).not.toThrow();
  });

  it('the host arm’s `streaming` and prompt cap are the ANSWERING brain’s own wire entry', () => {
    const platform = compose(BOTH);
    const arm = platform.brain as unknown as { streaming: boolean; maxPromptBytes?: number; tools: boolean };
    expect([arm.streaming, arm.maxPromptBytes, arm.tools]).toEqual([true, 900_000, false]);
    seatOf(platform).choose('codex');
    // Codex answers whole, not streamed, and its limit is its own (ADR-0071).
    expect([arm.streaming, arm.maxPromptBytes, arm.tools]).toEqual([false, 120_000, false]);
  });

  it('a brain that reports no cap has none — never another brain’s, never a default', () => {
    const { maxPromptBytes: _none, ...capless } = CLAUDE;
    const arm = compose({ active: 'claude', brains: [capless] }).brain as unknown as { maxPromptBytes?: number };
    expect(arm.maxPromptBytes).toBeUndefined();
  });
});

describe('the model and the level are the answering brain’s, in its own words (ADR-0071 §5, B8)', () => {
  it('the setters write the ANSWERING brain’s entry — and each brain keeps its own', () => {
    const platform = compose(BOTH);
    const seat = seatOf(platform);
    seat.setModel('claude-sonnet-5');
    seat.setEffort('xhigh');
    seat.choose('codex');
    expect(seat.state.get(), 'Codex shows Codex’s — nothing chosen yet').toMatchObject({ active: 'codex' });
    expect('model' in seat.state.get() || 'effort' in seat.state.get()).toBe(false);
    seat.setEffort('minimal');
    expect(seat.state.get().effort).toBe('minimal');
    seat.choose('auto');
    expect(seat.state.get()).toMatchObject({ active: 'claude', model: 'claude-sonnet-5', effort: 'xhigh' });
    expect(JSON.parse(localStorage.getItem(BRAIN_CHOICE_STORAGE_KEY) ?? 'null')).toEqual({
      v: 2,
      choice: 'auto',
      prefs: { claude: { model: 'claude-sonnet-5', effort: 'xhigh' }, codex: { effort: 'minimal' } },
    });
  });

  it('a level the brain lacks is refused where it is set — Claude’s `max` is not a Codex level', () => {
    const seat = seatOf(compose(BOTH));
    seat.choose('codex');
    expect(() => seat.setEffort('max')).toThrow(/not a thinking level of codex/);
  });

  it.each([
    ['a stored level the brain no longer lists is neither sent nor shown; the model is kept', { model: 'claude-sonnet-5', effort: 'ludicrous' }, { model: 'claude-sonnet-5' }],
    ['a level kept from another model is dropped for a model with NO thinking axis (Haiku 4.5)', { model: 'claude-haiku-4-5-20251001', effort: 'low' }, { model: 'claude-haiku-4-5-20251001' }],
    ['a level the chosen model has is carried', { model: 'claude-sonnet-5', effort: 'low' }, { model: 'claude-sonnet-5', effort: 'low' }],
    ['with no model chosen the brain’s own levels are the vocabulary', { effort: 'max' }, { effort: 'max' }],
    ['a model the catalogue does not list is assumed to have the brain’s levels', { model: 'claude-some-future-model', effort: 'max' }, { model: 'claude-some-future-model', effort: 'max' }],
    ['nothing stored → nothing carried', undefined, {}],
  ])('%s', (_label, stored, carried) => {
    // MIGRATED here from brainChoiceStore "drops a stored effort that this CLI no longer
    // documents, keeping the model": the vocabulary is the wire's, so the judgement is made
    // where the level is used.
    expect(prefsFor(CLAUDE, stored)).toEqual(carried);
  });

  it('the pre-task stored shape drives the first think: the model and level a user chose before the registry', async () => {
    // The storage-migration proof at the unit seam (the e2e's chess leg is the browser one).
    localStorage.setItem(BRAIN_CHOICE_STORAGE_KEY, JSON.stringify({ model: 'claude-sonnet-5', effort: 'low' }));
    const calls = stubFetch(() => answer('claude-sonnet-5-resolved'));
    const platform = compose(READY);
    expect(seatOf(platform).state.get()).toMatchObject({ choice: 'auto', active: 'claude', model: 'claude-sonnet-5', effort: 'low' });
    expect(labelOf(platform.brain)).toBe('Claude · Sonnet 5');
    await adapterOf(platform).complete(think);
    expect(calls[0]?.body).toMatchObject({ model: 'claude-sonnet-5', effort: 'low', brain: 'auto', prefs: { claude: { model: 'claude-sonnet-5', effort: 'low' } } });
  });

  it('the standing note says thinking is never shown, and what a switch costs (Q4/Q5)', () => {
    const note = seatOf(compose(READY)).note;
    expect(note).toMatch(/Thinking itself is never shown/);
    expect(note).toMatch(/next think/i);
    expect(note).toMatch(/spends nothing/);
  });
});

describe('the brain reaches its own runner DIRECTLY — never through the connected-apps proxy (S10)', () => {
  // THE BUG THIS BLOCK EXISTS FOR (owner's walk, 2026-10-02: "the agent's move is pending"):
  // S5 routed the brain adapter through `client.fetchImpl`. That is not a general fetch — it
  // wraps every request into `POST /fetch`, the connected-apps network proxy, which re-runs the
  // executor's gates and refuses a loopback destination. Every think on Binding B failed with
  // "could not reach the local model endpoint". The earlier tests here used a fake client whose
  // fetchImpl just recorded bodies, so they passed against a path that could never work.
  // These drive the REAL global fetch, answer in the REAL shape (SSE), and fail if the proxy
  // is touched at all.

  /** A client whose PROXY must never be used by the brain. */
  const proxyCalls: string[] = [];
  const guardedClient = fakeClient({
    fetchImpl: async (url: string) => {
      proxyCalls.push(url);
      throw new Error('the brain must not use the connected-apps proxy');
    },
  });
  const ready = (over: Partial<LocalStatus> = READY) => {
    const platform = compose(over, guardedClient);
    return { platform, adapter: adapterOf(platform), seat: seatOf(platform) };
  };

  it('a think SUCCEEDS end to end, and never touches the proxy — the owner’s chess move', async () => {
    proxyCalls.length = 0;
    const calls = stubFetch(() => answer('claude-opus-5-5'));
    const result = await ready().adapter.complete(think);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok');
    expect(proxyCalls).toEqual([]);
    expect(calls[0]?.url).toMatch(/\/v1\/chat\/completions$/);
  });

  it('sends the chosen model as its exact id', async () => {
    const calls = stubFetch(() => answer('claude-sonnet-5'));
    const { adapter, seat } = ready();
    seat.setModel('claude-sonnet-5');
    await adapter.complete(think);
    expect(calls[0]?.body.model).toBe('claude-sonnet-5');
    expect(calls[0]?.body.prefs).toEqual({ claude: { model: 'claude-sonnet-5' } });
  });

  it('sends the chosen effort AS A FIELD — the shared adapter drops unknown request fields', async () => {
    // The S5 version of this asserted the body contained "max", which matched
    // `max_completion_tokens`: a false positive while effort never reached the runner.
    const calls = stubFetch(() => answer('claude-opus-5-5'));
    const { adapter, seat } = ready();
    seat.setEffort('max');
    await adapter.complete(think);
    expect(calls[0]?.body.effort).toBe('max');
    expect(calls[0]?.body.prefs).toEqual({ claude: { effort: 'max' } });
  });

  it('sends the placeholder and NO effort when nothing is chosen — the pre-task wire, plus the choice', async () => {
    const calls = stubFetch(() => answer('claude-opus-5-5'));
    await ready().adapter.complete(think);
    expect(calls[0]?.body.model).toBe('claude');
    expect('effort' in (calls[0]?.body ?? {})).toBe(false);
    // What the contract adds: the user's choice as they made it. No `prefs` with nothing in it.
    expect(calls[0]?.body.brain).toBe('auto');
    expect('prefs' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('a PINNED brain’s think names the pin and carries ONLY that brain’s entry — the top-level fields stay Claude’s form', async () => {
    const calls = stubFetch(() => answer('gpt-5.5', 'codex'));
    const { platform, seat } = ready(BOTH);
    seat.setModel('claude-sonnet-5');
    seat.setEffort('max');
    seat.choose('codex');
    seat.setModel('gpt-5.5');
    seat.setEffort('high');
    await adapterOf(platform).complete(think);
    expect(calls[0]?.body.brain).toBe('codex');
    expect(calls[0]?.body.prefs, 'Claude’s model and level do not ride a Codex think').toEqual({ codex: { model: 'gpt-5.5', effort: 'high' } });
    // The top-level `model` / `effort` mean the claude entry (the contract), so for another
    // brain they are the placeholder the route strips, and no level.
    expect(calls[0]?.body.model).toBe('claude');
    expect('effort' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('auto with a Codex preference stored → Claude, on Claude’s own preferences', async () => {
    const calls = stubFetch(() => answer('claude-opus-5-5', 'claude'));
    const { platform, seat } = ready(BOTH);
    seat.choose('codex');
    seat.setModel('gpt-5.5');
    seat.choose('auto');
    await adapterOf(platform).complete(think);
    expect(calls[0]?.body).toMatchObject({ brain: 'auto', model: 'claude' });
    expect('prefs' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('reads the choice PER CALL, so a switch lands on the next think (ADR-0036 rule 3)', async () => {
    const calls = stubFetch(() => answer('claude-opus-5-5'));
    const { adapter, seat } = ready();
    seat.setModel('claude-sonnet-5');
    await adapter.complete(think);
    seat.setModel('claude-opus-5-5');
    await adapter.complete(think);
    expect(calls.map((c) => c.body.model)).toEqual(['claude-sonnet-5', 'claude-opus-5-5']);
  });

  it('teaches the chip the model that ANSWERED, even though the user chose none', async () => {
    stubFetch(() => answer('claude-opus-5-5'));
    const { adapter, seat } = ready();
    expect(seat.state.get().answered).toBeUndefined();
    await adapter.complete(think);
    expect(seat.state.get().answered).toEqual({ brain: 'claude', model: 'claude-opus-5-5' });
  });

  it('records the brain the RUNNER names (x-snug-brain) — what answered, never what was asked', async () => {
    stubFetch(() => answer('gpt-5.5-resolved', 'codex'));
    const { platform, seat } = ready(BOTH);
    seat.choose('codex');
    await adapterOf(platform).complete(think);
    expect(seat.state.get().answered).toEqual({ brain: 'codex', model: 'gpt-5.5-resolved' });
  });

  // The three below are the ones that can tell "answered" from "asked": in the test above
  // the header names the very brain the page pinned, so an adapter that ignored the header
  // and recorded its own expectation passed it (the R4 verifier's surviving mutant).

  it('an answer on an arm the page thought had STOPPED answering is recorded against the brain the runner names — the page had no expectation to fall back on', async () => {
    // The turn adapter took the host arm; then a status landed saying Claude was logged out;
    // the runner — the authority, and by now ahead of that status — answered on Claude.
    stubFetch(() => answer('claude-opus-5-5', 'claude'));
    const { adapter, seat } = ready();
    applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
    expect(seat.state.get().active, 'the page’s own picture: nothing answers').toBeUndefined();
    const result = await adapter.complete(think);
    expect(result.ok).toBe(true);
    expect(seat.state.get().answered).toEqual({ brain: 'claude', model: 'claude-opus-5-5' });
  });

  it('a REFUSAL on such an arm is recorded against the brain the runner names — and so follows that brain, not the page’s guess', async () => {
    const message = 'Claude is at capacity — try again in a moment.';
    stubFetch(() => refusal(502, message, { by: 'claude' }));
    const { adapter, seat } = ready(BOTH);
    applyRunnerStatus({ brains: [claude({ state: 'logged-out', detail: LOGGED_OUT }), CODEX] });
    await adapter.complete(think);
    expect(seat.state.get().refusal, 'shown while nothing answers').toBe(message);
    // It is CLAUDE's: not shown under Codex's controls, and back when Claude answers again.
    seat.choose('codex');
    expect(seat.state.get().refusal).toBeUndefined();
    seat.choose('auto');
    applyRunnerStatus(BOTH);
    expect(seat.state.get()).toMatchObject({ active: 'claude', refusal: message });
  });

  it('the header out-votes the page’s own picture: the runner is the authority on which brain ran', async () => {
    stubFetch(() => answer('gpt-5.5-resolved', 'codex'));
    const { adapter, seat } = ready(BOTH);
    expect(seat.state.get()).toMatchObject({ choice: 'auto', active: 'claude' });
    await adapter.complete(think);
    expect(seat.state.get().answered).toEqual({ brain: 'codex', model: 'gpt-5.5-resolved' });
  });

  it('a brain that names no model of its own is recorded as the brain alone — its id is a placeholder, not a model', async () => {
    stubFetch(() => answer('codex', 'codex'));
    const { platform, seat } = ready(BOTH);
    seat.choose('codex');
    await adapterOf(platform).complete(think);
    expect(seat.state.get().answered).toEqual({ brain: 'codex' });
  });

  it('records a refusal of the chosen model IN WORDS, and leaves what answered alone', async () => {
    const message = 'There’s an issue with the selected model (nope-not-a-model). It may not exist or you may not have access to it.';
    let refuse = false;
    stubFetch(() => (refuse ? refusal(502, message, { by: 'claude' }) : answer('claude-opus-5-5')));
    const { adapter, seat } = ready();
    await adapter.complete(think);
    seat.setModel('nope-not-a-model');
    refuse = true;
    const result = await adapter.complete(think);
    expect(result.ok).toBe(false);
    // The runner's sentence itself — not the adapter's `HTTP 502: {"error":…}` around it.
    expect(seat.state.get().refusal).toBe(message);
    expect(seat.state.get().answered).toEqual({ brain: 'claude', model: 'claude-opus-5-5' });
  });

  it('a refusal clears when a think answers again', async () => {
    let refuse = true;
    stubFetch(() => (refuse ? refusal(502, 'Claude is at capacity — try again in a moment.', { by: 'claude' }) : answer('claude-opus-5-5')));
    const { adapter, seat } = ready();
    await adapter.complete(think);
    expect(seat.state.get().refusal).toMatch(/capacity/);
    refuse = false;
    await adapter.complete(think);
    expect(seat.state.get().refusal).toBeUndefined();
  });

  it('a refusal is its brain’s: it is not shown under ANOTHER brain’s controls, and comes back with its own', async () => {
    stubFetch((body) => (body.brain === 'codex' ? refusal(502, 'Codex has reached its usage limit.', { by: 'codex' }) : answer('claude-opus-5-5', 'claude')));
    const { platform, seat } = ready(BOTH);
    seat.choose('codex');
    await adapterOf(platform).complete(think);
    expect(seat.state.get().refusal).toBe('Codex has reached its usage limit.');
    seat.choose('auto');
    expect(seat.state.get().refusal, 'Claude is answering now').toBeUndefined();
    seat.choose('codex');
    expect(seat.state.get().refusal).toBe('Codex has reached its usage limit.');
  });

  it('a think that finishes LATE cannot overwrite what a newer one taught the chip (review, 2026-10-03)', async () => {
    // Thinks overlap (the pool runs up to four). Think A starts on a model the CLI will refuse,
    // the user switches, think B answers first — then A's refusal lands. It must not stamp a
    // refusal of a model the user already left onto the chip.
    const message = 'There’s an issue with the selected model (nope-not-a-model).';
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model;
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(model === 'nope-not-a-model' ? refusal(502, message, { by: 'claude' }) : answer('claude-sonnet-5')));
      });
    });
    const { adapter, seat } = ready();
    seat.setModel('nope-not-a-model');
    const a = adapter.complete(think);
    seat.setModel('claude-sonnet-5');
    const b = adapter.complete(think);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(); // B answers first
    await b;
    releases[0]!(); // A's refusal lands late
    await a;
    expect(seat.state.get().answered).toEqual({ brain: 'claude', model: 'claude-sonnet-5' });
    expect(seat.state.get().refusal).toBeUndefined();
  });

  it('a late SUCCESS on the old model cannot move the chip back to it either', async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? 'claude';
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(answer(model === 'claude-opus-5-5' ? 'claude-opus-5-5' : 'claude-sonnet-5')));
      });
    });
    const { adapter, seat } = ready();
    seat.setModel('claude-opus-5-5');
    const a = adapter.complete(think);
    seat.setModel('claude-sonnet-5');
    const b = adapter.complete(think);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await b;
    releases[0]!();
    await a;
    expect(seat.state.get().answered).toEqual({ brain: 'claude', model: 'claude-sonnet-5' });
  });

  it('a think that finishes after the user moved to ANOTHER BRAIN teaches the chip nothing about either', async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => void releases.push(() => resolve(answer('claude-opus-5-5', 'claude')))));
    const { platform, seat } = ready(BOTH);
    const late = adapterOf(platform).complete(think);
    seat.choose('codex');
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]!();
    await late;
    expect(seat.state.get().answered).toBeUndefined();
  });

  it('does NOT call a network failure a refusal', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const { adapter, seat } = ready();
    seat.setModel('claude-sonnet-5');
    await adapter.complete(think);
    expect(seat.state.get().refusal).toBeUndefined();
  });

  it('an answer that is not the runner’s envelope (a bare 401, an html page) records no refusal', async () => {
    let body: Response = new Response('', { status: 401 });
    stubFetch(() => body);
    const { adapter, seat } = ready();
    await adapter.complete(think);
    body = new Response('<!doctype html><title>oops</title>', { status: 500, headers: { 'content-type': 'text/html' } });
    await adapter.complete(think);
    body = new Response(JSON.stringify({ error: { message: 7 } }), { status: 502 });
    await adapter.complete(think);
    expect(seat.state.get().refusal).toBeUndefined();
  });
});

describe('the chip label follows the model (S11)', () => {
  it('names the SELECTED model by its catalogue display name', () => {
    const platform = compose(READY);
    seatOf(platform).setModel('claude-sonnet-5');
    expect(labelOf(platform.brain)).toBe('Claude · Sonnet 5');
  });

  it('follows a switch with no recompose — the platform is set once', () => {
    const platform = compose(READY);
    seatOf(platform).setModel('claude-sonnet-5');
    seatOf(platform).setModel('claude-opus-5-5');
    expect(labelOf(platform.brain)).toBe('Claude · Opus 5.5');
  });

  it('with NOTHING selected, names the model the CLI actually ran once a think has answered', async () => {
    // The CLI reports its default with a context suffix (measured: `claude-opus-5-5[1m]`).
    stubFetch(() => answer('claude-opus-5-5[1m]'));
    const platform = compose(READY);
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    await adapterOf(platform).complete(think);
    expect(labelOf(platform.brain)).toBe('Claude · Opus 5.5');
  });

  it('what ANOTHER brain answered on is not this brain’s model', async () => {
    stubFetch(() => answer('gpt-5.5', 'codex'));
    const platform = compose(BOTH);
    seatOf(platform).choose('codex');
    await adapterOf(platform).complete(think);
    expect(labelOf(platform.brain)).toBe('Codex · GPT-5.5');
    seatOf(platform).choose('auto');
    expect(labelOf(platform.brain), 'Claude has answered nothing yet').toBe('Claude · your CLI');
  });

  it('shows the id itself for a model the catalogue does not list', () => {
    expect(brainLabel(CLAUDE, 'claude-some-future-model')).toBe('Claude · claude-some-future-model');
  });

  it('shows the id when no catalogue could be read at all', () => {
    // An EMPTY list is how "no catalogue" arrives from the process.
    expect(brainLabel(claude({ models: [] }), 'claude-sonnet-5')).toBe('Claude · claude-sonnet-5');
  });

  it('names each brain by ITS name', () => {
    expect(brainLabel(CODEX, undefined)).toBe('Codex · your CLI');
    expect(brainLabel(CODEX, 'gpt-5.5')).toBe('Codex · GPT-5.5');
  });

  it('keeps the REMEDY when the CLI cannot think, even with a model selected', () => {
    // MIGRATED (D4, then R4): the remedy was the host arm's label. The arm is no longer
    // the platform's brain there, and what the user reads is the runner's own sentence —
    // never traded for a model name.
    const platform = compose(READY);
    seatOf(platform).setModel('claude-sonnet-5');
    const host = platform.brain;
    applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(demoStandIn(seatOf(platform).state.get())?.remedy).toMatch(/\/login/);
    expect(labelOf(host), 'a stale reference to the arm names no brain and no model').toBe('no agent is ready');
  });
});

// =====================================================================================
// The one-kit range (TASK-20261003 R2): one capability table, one custody store, the
// hand-in seat, the redirect fact — and D4, the demo fallback.
// =====================================================================================

describe('one of everything the bindings share (K4)', () => {
  it('the capabilities are the ONE table with what the runner does differently — nothing hand-written', () => {
    expect(composeLocalPlatform(client, status()).platform.capabilities).toEqual(hostCapabilities({ connections: true, oauthRedirect: true }));
    expect(composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' })).platform.capabilities).toEqual(hostCapabilities({ appExport: false }));
  });

  it('`oauthRedirect` is the runner’s: false when the registered port was taken, available when it says so or does not say', () => {
    expect(composeLocalPlatform(client, status({ oauthRedirect: false })).platform.capabilities.oauthRedirect).toBe(false);
    expect(composeLocalPlatform(client, status({ oauthRedirect: true })).platform.capabilities.oauthRedirect).toBe(true);
    expect(composeLocalPlatform(client, status()).platform.capabilities.oauthRedirect).toBe(true);
  });

  it('the custody seat is the kit’s ONE store: `undefined` in a patch CLEARS the field', () => {
    // The runner's own store merged a patch as it came, so a dismissed note stayed as
    // `note: undefined` — a key the chip's readers had to know to ignore.
    const { platform, custody } = composeLocalPlatform(client, status());
    custody.patch({ note: 'installed by your agent: Chess' });
    expect(platform.custody?.state.get()).toEqual({ dirty: false, readOnly: false, note: 'installed by your agent: Chess' });
    platform.custody?.dismissNote?.();
    expect(platform.custody?.state.get()).toEqual({ dirty: false, readOnly: false });
    expect('note' in platform.custody!.state.get()).toBe(false);
  });

  it('carries the agentHandIns seat — an edited copy’s update is offered here as under Binding A (K6)', () => {
    const { platform, handIns } = composeLocalPlatform(client, status());
    expect(platform.agentHandIns).toBe(handIns.seat);
    expect(platform.agentHandIns?.pending.get()).toEqual([]);
    // A page that refuses to open offers nothing.
    expect(composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' })).platform.agentHandIns).toBeUndefined();
  });
});

describe('D4 — when no brain is ready, the demo brain answers', () => {
  it.each(['absent', 'logged-out', 'outdated'])('%s → the DEMO brain', (state) => {
    expect(compose(notReady(state)).brain).toEqual({ kind: 'demo' });
  });

  it.each([
    ['could not be checked — unknown is the honest state, and never treated as ready', notReady('unknown')],
    ['a state this build has never heard of', notReady('rate-limited')],
    ['not reported yet', {}],
  ])('%s → the DEMO brain too: the page pins the host arm on the runner’s word, not on a guess', (_label, runner) => {
    // MIGRATED 2026-10-03 (R4, ADR-0071 §4/§6). These three stayed on the HOST arm —
    // "optimistic, as before": with one brain and no registry the page had to guess, and a
    // wrong guess was a 502. The runner now says which brain a think would run on
    // (`active`), and says none for all three; the page mirrors it.
    expect(compose(runner).brain).toEqual({ kind: 'demo' });
  });

  it('ready, and named active → the HOST arm', () => {
    expect(compose(READY).brain?.kind).toBe('host');
  });

  it('both arms are STABLE references — a fresh object per read would re-render its readers for ever', () => {
    const platform = compose(READY);
    const host = platform.brain;
    expect(platform.brain).toBe(host);
    applyRunnerStatus(notReady('absent'));
    const demo = platform.brain;
    expect(demo).not.toBe(host);
    expect(platform.brain).toBe(demo);
    applyRunnerStatus(READY);
    expect(platform.brain, 'the host arm that comes back is the one that left').toBe(host);
  });

  it('`brain` is a GETTER on the platform — a spread or a copy at boot would freeze the arm', () => {
    const platform = compose();
    expect(Object.getOwnPropertyDescriptor(platform, 'brain')?.get).toBeTypeOf('function');
    expect(Object.keys(platform)).toContain('brain');
  });

  it('with no bearer there is no brain at all — nothing to think with, nothing to fall back from, nothing to switch', () => {
    const { platform } = composeLocalPlatform(client, status(notReady('absent')));
    expect(platform.brain).toBeUndefined();
    expect(platform.brainSwitch).toBeUndefined();
  });

  describe('a verdict that arrives LATE (the `status` event)', () => {
    it('moves the platform and bumps brainRevision — the signal a reader re-reads on', () => {
      const platform = compose(READY);
      const before = brainRevisionStore.get();
      applyRunnerStatus(notReady('logged-out', 'run `/login`'));
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(brainRevisionStore.get()).toBeGreaterThan(before);
    });

    it('an UNCHANGED verdict bumps nothing — a re-check that learns nothing re-renders nobody', () => {
      const platform = compose();
      applyRunnerStatus(READY);
      const settled = brainRevisionStore.get();
      const state = seatOf(platform).state.get();
      applyRunnerStatus(structuredClone(READY));
      expect(brainRevisionStore.get()).toBe(settled);
      expect(seatOf(platform).state.get(), 'and the chip keeps the very same state object').toBe(state);
    });

    it('a catalogue alone is a change too — the chip’s dropdown is read from it', () => {
      const platform = compose({ active: 'claude', brains: [claude({ models: [] })] });
      const before = brainRevisionStore.get();
      applyRunnerStatus(READY);
      expect(seatOf(platform).state.get().brains[0]?.models).toEqual(CLAUDE.models);
      expect(brainRevisionStore.get()).toBe(before + 1);
    });

    it('the user’s own switch bumps it as well — the arm, or its label, has changed under its readers', () => {
      const platform = compose(BOTH);
      const before = brainRevisionStore.get();
      seatOf(platform).choose('codex');
      expect(brainRevisionStore.get()).toBe(before + 1);
    });

    it('a frame that is not a status changes nothing and throws nothing', () => {
      const platform = compose(READY);
      const before = brainRevisionStore.get();
      const state = seatOf(platform).state.get();
      for (const junk of [undefined, null, 'ready', 7, [], {}, { brain: 'ready' }, { brain: { state: 'absent' }, models: [] }, { active: 'codex' }, { brains: 'all of them' }]) applyRunnerStatus(junk);
      expect(brainRevisionStore.get()).toBe(before);
      expect(seatOf(platform).state.get()).toBe(state);
      expect(platform.brain?.kind, 'the legacy single-brain frame in particular must not read as "no brain"').toBe('host');
    });

    it('lands on the page’s composition only — one that refused to open hears nothing', () => {
      const first = compose(READY);
      composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
      applyRunnerStatus(notReady('absent'));
      expect(first.brain?.kind, 'the earlier composition’s door closed with the new one').toBe('host');
    });
  });

  describe('a think that was not answered', () => {
    it('returns ITS OWN named error — no demo reply is slipped in — and asks the runner to look again', async () => {
      const recheckBrain = vi.fn(async () => {});
      stubFetch(() => refusal(502, 'Your Claude CLI is not logged in — run `claude` and `/login`.', { by: 'claude' }));
      const platform = compose(READY, fakeClient({ recheckBrain }));
      const result = await adapterOf(platform).complete(think);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not logged in/);
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      expect(seatOf(platform).state.get().checking, 'and the chip shows it is checking').toBe(true);
      // The NEXT turn is routed by what the re-check learns: the verdict lands, the pin moves.
      applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(seatOf(platform).state.get()).toMatchObject({ checking: false, refusal: 'Your Claude CLI is not logged in — run `claude` and `/login`.' });
    });

    it('the runner’s 503 `no-brain` is recorded against the brain the choice MEANT — the runner named none', async () => {
      const recheckBrain = vi.fn(async () => {});
      const calls = stubFetch(() => refusal(503, 'Codex is not ready — the demo brain will answer until it is.', { code: 'no-brain' }));
      const platform = compose(BOTH, fakeClient({ recheckBrain }));
      const seat = seatOf(platform);
      seat.choose('codex');
      const result = await adapterOf(platform).complete(think);
      expect(result.ok).toBe(false);
      expect(calls[0]?.body.brain).toBe('codex');
      expect(seat.state.get().refusal).toBe('Codex is not ready — the demo brain will answer until it is.');
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      // The page did not out-vote the runner: the pin is still the user's, and what the
      // re-check learns decides the next think.
      expect(seat.state.get().choice).toBe('codex');
    });

    it('a network failure on the think asks too — the runner’s shim itself may be what went away', async () => {
      const recheckBrain = vi.fn(async () => {});
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('Failed to fetch');
      });
      await adapterOf(compose(READY, fakeClient({ recheckBrain }))).complete(think);
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('a think the USER stopped says nothing about the brain — no re-check', async () => {
      const recheckBrain = vi.fn(async () => {});
      const controller = new AbortController();
      vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
        controller.abort();
        init?.signal?.throwIfAborted();
        throw new DOMException('aborted', 'AbortError');
      });
      const platform = compose(READY, fakeClient({ recheckBrain }));
      const result = await adapterOf(platform).complete({ ...think, signal: controller.signal });
      expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
      expect(recheckBrain).not.toHaveBeenCalled();
      expect(seatOf(platform).state.get().checking).toBe(false);
    });

    it('a think that ANSWERS asks nothing', async () => {
      const recheckBrain = vi.fn(async () => {});
      stubFetch(() => answer('claude-opus-5-5'));
      const result = await adapterOf(compose(READY, fakeClient({ recheckBrain }))).complete(think);
      expect(result.ok).toBe(true);
      expect(recheckBrain).not.toHaveBeenCalled();
    });

    it('a think sent on an arm that has just stopped answering goes to the RUNNER, which is the authority — never a throw', async () => {
      // The turn adapter took the host arm a moment before the verdict landed.
      const calls = stubFetch(() => refusal(503, 'No brain is ready.', { code: 'no-brain' }));
      const platform = compose(READY);
      const adapter = adapterOf(platform);
      applyRunnerStatus(notReady('logged-out', LOGGED_OUT));
      const result = await adapter.complete(think);
      expect(result.ok).toBe(false);
      expect(calls[0]?.body).toMatchObject({ brain: 'auto', model: 'claude' });
      expect('prefs' in (calls[0]?.body ?? {})).toBe(false);
    });
  });

  describe('looking again while the demo brain stands in', () => {
    const standIn = (over: Partial<LocalStatus> = notReady('logged-out', LOGGED_OUT)) => {
      vi.useFakeTimers();
      const recheckBrain = vi.fn(async () => {});
      const platform = compose(over, fakeClient({ recheckBrain }));
      return { platform, recheckBrain };
    };
    const comeBack = (): void => {
      window.dispatchEvent(new Event('focus'));
    };

    it('asks ONCE when the page opens on a brain that is not ready — the user may be about to fix it', () => {
      const { recheckBrain } = standIn();
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('READING the brain asks nothing, however often — the ask is not in the getter', () => {
      // MIGRATED from "…asks the runner to look again — at most once per floor", which drove
      // the ask by READING `platform.brain`: a network request fired while React rendered
      // (the R2 verifier's finding). The floor and the once are kept, below; the trigger is
      // the stand-in beginning, changing, or the user coming back to the page.
      const { platform, recheckBrain } = standIn();
      for (let i = 0; i < 50; i += 1) expect(platform.brain).toEqual({ kind: 'demo' });
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS * 3);
      for (let i = 0; i < 50; i += 1) void platform.brain;
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('asks again when the user comes back to the page — at most once per floor', () => {
      const { recheckBrain } = standIn();
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS);
      comeBack();
      expect(recheckBrain).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 20; i += 1) comeBack();
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS - 1);
      expect(recheckBrain, 'twenty returns inside the floor are still one ask owed').toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(recheckBrain).toHaveBeenCalledTimes(3);
    });

    it('an ask inside the floor is OWED, not dropped: back from a quick `/login`, the page asks as soon as it may', () => {
      const { recheckBrain } = standIn();
      vi.advanceTimersByTime(20_000);
      comeBack();
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS - 20_000);
      expect(recheckBrain).toHaveBeenCalledTimes(2);
      // …and owes nothing more until the user is back again.
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS * 4);
      expect(recheckBrain).toHaveBeenCalledTimes(2);
    });

    it('the floor runs on the MONOTONIC clock — a wall clock set back a day does not owe the next ask for a day', () => {
      // Found by this suite: with the floor on `Date.now()`, a composition whose last ask
      // sat "in the future" owed its next one for the whole difference — and a wait past
      // 2^31 ms is a 1 ms timer, re-armed for ever.
      const { recheckBrain } = standIn();
      vi.setSystemTime(Date.now() - 86_400_000);
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS);
      comeBack();
      expect(recheckBrain).toHaveBeenCalledTimes(2);
    });

    it('an owed ask is not made once a brain is answering', () => {
      const { recheckBrain } = standIn();
      vi.advanceTimersByTime(20_000);
      comeBack();
      applyRunnerStatus(READY);
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS);
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('a tab shown again counts as coming back; a tab hidden does not', () => {
      const { recheckBrain } = standIn();
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS);
      const visibility = vi.spyOn(document, 'visibilityState', 'get');
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(recheckBrain).toHaveBeenCalledTimes(2);
      visibility.mockRestore();
    });

    it('a brain the runner has NOT CHECKED YET at boot: the page asks, and SHOWS that it is checking until the first round lands', () => {
      // The common first second of every page: the runner looks at its brains when the first
      // page asks, never before, and a real CLI takes seconds to answer.
      const notChecked = { brains: [claude({ state: 'unknown', detail: 'Snug is still checking this brain.' })] };
      const { platform, recheckBrain } = standIn(notChecked);
      const seat = seatOf(platform);
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      expect(seat.state.get().checking).toBe(true);
      applyRunnerStatus(READY);
      expect(seat.state.get()).toMatchObject({ checking: false, active: 'claude' });
      expect(platform.brain?.kind).toBe('host');
    });

    it('…while a brain KNOWN not ready at boot is asked about quietly — no "checking" the user did not ask for', () => {
      const { platform, recheckBrain } = standIn();
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      expect(seatOf(platform).state.get().checking).toBe(false);
    });

    it('asks when the stand-in BEGINS after boot: a brain that went away, a pin that stopped being ready', () => {
      const { platform, recheckBrain } = standIn(BOTH);
      expect(recheckBrain).not.toHaveBeenCalled();
      seatOf(platform).choose('codex');
      applyRunnerStatus({ active: 'claude', brains: [CLAUDE, codex({ state: 'logged-out' })] });
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('while a brain is answering nothing asks — a re-check of a ready brain is a real think', () => {
      // WAS "while the HOST brain is the pin, reading it asks nothing".
      const { platform, recheckBrain } = standIn(READY);
      for (let i = 0; i < 50; i += 1) void platform.brain;
      comeBack();
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS * 2);
      comeBack();
      expect(recheckBrain).not.toHaveBeenCalled();
    });

    it('before the runner has reported ANY brain nothing asks — its first probe is already under way', () => {
      const { recheckBrain } = standIn({});
      comeBack();
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS * 2);
      comeBack();
      expect(recheckBrain).not.toHaveBeenCalled();
    });
  });

  describe('“check again” — the explicit act (B8)', () => {
    const open = (over: Partial<LocalStatus> = READY) => {
      vi.useFakeTimers();
      const recheckBrain = vi.fn(async () => {});
      const platform = compose(over, fakeClient({ recheckBrain }));
      return { platform, seat: seatOf(platform), recheckBrain };
    };
    const settled = async (promise: Promise<void>): Promise<boolean> => {
      let done = false;
      void promise.then(() => void (done = true));
      await Promise.resolve();
      await Promise.resolve();
      return done;
    };

    it('asks the runner, shows `checking`, and resolves when the next status lands — with what it learned', async () => {
      const { platform, seat, recheckBrain } = open(notReady('logged-out', LOGGED_OUT));
      recheckBrain.mockClear();
      const checking = seat.recheck();
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      expect(seat.state.get().checking).toBe(true);
      expect(await settled(checking)).toBe(false);
      applyRunnerStatus(READY);
      expect(await settled(checking)).toBe(true);
      expect(seat.state.get()).toMatchObject({ checking: false, active: 'claude' });
      expect(platform.brain?.kind, 'picked up with no reload').toBe('host');
    });

    it('a status that says the SAME thing still ends the check — the answer is "nothing changed"', async () => {
      const { seat } = open(READY);
      const checking = seat.recheck();
      applyRunnerStatus(structuredClone(READY));
      expect(await settled(checking)).toBe(true);
      expect(seat.state.get().checking).toBe(false);
    });

    it('stops waiting after the bound — a status that never comes must not leave the chip checking for ever', async () => {
      const { seat } = open(READY);
      const checking = seat.recheck();
      vi.advanceTimersByTime(RECHECK_BOUND_MS - 1);
      expect(await settled(checking)).toBe(false);
      expect(seat.state.get().checking).toBe(true);
      vi.advanceTimersByTime(1);
      expect(await settled(checking)).toBe(true);
      expect(seat.state.get().checking).toBe(false);
      // The bound is the runner's floor plus a probe: an ask inside the floor is owed there.
      expect(RECHECK_BOUND_MS).toBeGreaterThan(DEMO_RECHECK_FLOOR_MS);
    });

    it('is not re-entrant: a second press while one is out joins it, and sends nothing', () => {
      const { seat, recheckBrain } = open(READY);
      const first = seat.recheck();
      expect(seat.recheck()).toBe(first);
      expect(recheckBrain).toHaveBeenCalledTimes(1);
    });

    it('a check that has ended can be asked for again', async () => {
      const { seat, recheckBrain } = open(READY);
      const first = seat.recheck();
      applyRunnerStatus(structuredClone(READY));
      await first;
      const second = seat.recheck();
      expect(second).not.toBe(first);
      expect(recheckBrain).toHaveBeenCalledTimes(2);
      expect(seat.state.get().checking).toBe(true);
    });

    it('`checking` changes the state object, and does NOT bump brainRevision — what answers has not changed', () => {
      const { seat } = open(READY);
      const before = brainRevisionStore.get();
      const state = seat.state.get();
      void seat.recheck();
      expect(seat.state.get()).not.toBe(state);
      expect(brainRevisionStore.get()).toBe(before);
    });

    it('counts toward the page’s floor: the stand-in does not ask again on top of it', () => {
      const { seat, recheckBrain } = open(notReady('logged-out', LOGGED_OUT));
      vi.advanceTimersByTime(DEMO_RECHECK_FLOOR_MS);
      void seat.recheck();
      applyRunnerStatus(notReady('outdated'));
      window.dispatchEvent(new Event('focus'));
      expect(recheckBrain, 'the boot ask and the explicit one').toHaveBeenCalledTimes(2);
    });
  });
});

describe('D4 through the playground’s own readers — ready → absent → ready', () => {
  // A fresh module graph: the platform is set once per graph, and the readers under test
  // (`currentBrain`, the turn adapter, the app transport) read THAT singleton.
  afterEach(() => {
    vi.resetModules();
  });

  it('the chip label, currentBrain(), the builder arm and an app think all follow; nothing throws; the tag says demo while demo answers', async () => {
    vi.resetModules();
    const local = await import('../local/compose-local.js');
    const platformModule = await import('@playground/platform/platform');
    const webllm = await import('@playground/state/webllm');
    const activeBrain = await import('@playground/state/activeBrain');
    const adapterModule = await import('@playground/agent/adapter');
    const { createMemoryBackend } = await import('@snugprotocol/db');

    // The runner's shim, as the page reaches it: SSE, the resolved model on the last frame.
    const shimCalls: string[] = [];
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1 };
    vi.stubGlobal('fetch', async (url: string) => {
      shimCalls.push(String(url));
      return new Response(
        `data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: 'from the CLI' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ ...base, model: 'claude-opus-5-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream', 'x-snug-brain': 'claude' } },
      );
    });

    const { platform } = local.composeLocalPlatform(fakeClient(), status({ active: 'claude', brains: [claude({ models: [] })] }), undefined, createMemoryBackend(), 't');
    platformModule.setPlatform(platform);

    /** What the chip renders: the host brain's own label, or the demo brain's fixed one. */
    const chipLabel = (): string => {
      const brain = webllm.currentBrain();
      return brain.kind === 'host' ? brain.label : 'demo brain';
    };
    /** The builder's arm: the config useBuilderChat builds for this brain, its stamp, and its turn. */
    const builderTurn = async (): Promise<{ tag: string; ok: boolean }> => {
      const config = webllm.currentBrain().kind === 'host' ? ({ mode: 'host', provider: 'mock' } as const) : ({ mode: 'byok', provider: 'mock' } as const);
      const result = await adapterModule.createTurnAdapter(config, 'chat').complete({ system: 's', messages: [{ role: 'user', content: 'build me an app' }] });
      return { tag: adapterModule.adapterKindFor(adapterModule.routeOf(config)), ok: result.ok };
    };
    /** An app's think, by the adapter the app transport builds for this brain. */
    const appThink = async (): Promise<{ ok: boolean; text?: string }> => {
      const config = webllm.currentBrain().kind === 'host' ? ({ mode: 'host', provider: 'mock' } as const) : ({ mode: 'byok', provider: 'mock' } as const);
      const result = await adapterModule.createTurnAdapter(config, 'app').complete({ system: 's', messages: [{ role: 'user', content: 'move e4' }] });
      return result.ok ? { ok: true, text: result.text } : { ok: false };
    };

    // READY.
    expect(chipLabel()).toBe('Claude · your CLI');
    expect(webllm.currentBrain().kind).toBe('host');
    expect(activeBrain.resolveActiveBrain()).toBe('host');
    expect(await builderTurn()).toEqual({ tag: 'host', ok: true });
    expect(await appThink()).toEqual({ ok: true, text: 'from the CLI' });
    expect(shimCalls).toHaveLength(2);

    // ABSENT — the probe's verdict arrives as a status event.
    local.applyRunnerStatus({ brains: [claude({ state: 'absent', models: [] })] });
    expect(chipLabel()).toBe('demo brain');
    expect(webllm.currentBrain()).toEqual({ kind: 'demo', reason: 'host' });
    expect(activeBrain.resolveActiveBrain()).toBe('demo');
    expect(await builderTurn()).toEqual({ tag: 'demo', ok: true });
    const demo = await appThink();
    expect(demo.ok).toBe(true);
    expect(demo.text).not.toBe('from the CLI');
    expect(shimCalls, 'while the demo brain answers, NOTHING is sent to the shim — never a 502').toHaveLength(2);

    // READY again. (The label now names the model the CLI answered on before it went away —
    // S11: with nothing selected, the chip names what actually ran.)
    local.applyRunnerStatus({ active: 'claude', brains: [claude({ models: [] })] });
    expect(chipLabel()).toBe('Claude · claude-opus-5-5');
    expect(activeBrain.resolveActiveBrain()).toBe('host');
    expect(await builderTurn()).toEqual({ tag: 'host', ok: true });
    expect(await appThink()).toEqual({ ok: true, text: 'from the CLI' });
    expect(shimCalls).toHaveLength(4);
  });
});
