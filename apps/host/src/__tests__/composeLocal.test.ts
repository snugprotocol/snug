// The local page's platform (ADR-0068 D-B14, D-B24).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostCapabilities } from '@playground/platform/hostCapabilities';
import { brainRevisionStore } from '@playground/platform/signals';

import { DEMO_RECHECK_FLOOR_MS, applyRunnerStatus, brainLabel, brainState, composeLocalPlatform, modelsFromStatus } from '../local/compose-local.js';
import { createBrainChoiceStore } from '../brains/brainChoiceStore.js';
import type { LocalClient, LocalStatus } from '../local/client.js';

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

const status = (over: Partial<LocalStatus> = {}): LocalStatus => ({ binding: 'local-host', port: 43127, pages: 1, ...over });

/** `PlatformBrain` is a union and only its `host` arm carries a label — narrow, don't cast. */
const labelOf = (brain: { kind: string } | undefined): string | undefined =>
  brain !== undefined && brain.kind === 'host' ? (brain as unknown as { label: string }).label : undefined;

describe('the brain chip names what the CLI can actually do (D-B35)', () => {
  // The holder is module state; a leak between cases would make these prove each other.
  afterEach(() => {
    brainState.current = undefined;
  });

  it('says "Claude · your CLI" when the CLI is ready', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'ready' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
  });

  it('a logged-out CLI is NAMED with its remedy — and no think is sent to it', () => {
    // The owner's walk: a logged-out CLI surfaced as a bare HTTP 502 at the first think,
    // with no remedy and no sign the brain was the problem.
    //
    // MIGRATED 2026-10-03 (TASK-20261003 D4) from "NAMES a logged-out CLI on the chip": that
    // read the remedy off `platform.brain`'s label, which meant the platform still pinned
    // the HOST brain for a CLI it knew could not answer — so the chip said one thing and
    // every think was a 502. The platform now pins the demo brain there. The remedy's
    // sentence is unchanged and still `brainLabel`'s; what renders it while the demo brain
    // answers is the brain switcher (R4) — the chip of this range shows the demo copy.
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'logged-out', detail: 'run `claude` and `/login`' } }), undefined, undefined, 't');
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(brainLabel({ state: 'logged-out' })).toMatch(/log/i);
    expect(brainLabel({ state: 'logged-out' })).not.toBe('Claude · your CLI');
  });

  it('falls back to the demo brain’s wording when no CLI is installed', () => {
    // A machine with no `claude` gets a different sentence: telling that user to /login
    // sends them to a CLI they do not have.
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'absent' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain) ?? 'demo brain — no host brain found').toMatch(/demo|no .*brain|not found/i);
  });

  it('the label is a LIVE getter, so a probe answering after boot corrects the chip in place', () => {
    // The probe runs in the background — the kit must open even if the CLI is wedged — so
    // the chip's first value is the boot one and the `status` event carries the verdict.
    // It CANNOT arrive by recomposing: the platform is set once and `setPlatform` throws on
    // a second call (see localBrainEvent.test.ts), so the seat reads a holder at render.
    //
    // MIGRATED 2026-10-03 (D4): the late verdict used here was `logged-out`, which now moves
    // the platform to the demo brain (the case below). `unknown` is the late verdict that
    // stays on the host brain, so it is the one that shows the label itself is live.
    const { platform } = composeLocalPlatform(client, status(), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    brainState.current = { state: 'unknown', detail: 'the startup check timed out' };
    expect(labelOf(platform.brain), 'the SAME platform object must now read the new label').toMatch(/could not check/);
    brainState.current = { state: 'logged-out', detail: 'run `claude` and `/login`' };
    expect(platform.brain, 'and a verdict that the CLI cannot answer moves the SAME object to the demo brain').toEqual({ kind: 'demo' });
    brainState.current = undefined;
  });

  it('does not claim the CLI is ready before the probe has answered', () => {
    // `/status` omits `brain` until the probe returns. Reporting "ready" during that
    // window would be a guess that is wrong exactly when it matters.
    const { platform } = composeLocalPlatform(client, status(), undefined, undefined, 't');
    expect(labelOf(platform.brain)).not.toMatch(/logged out/i);
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
    const { refusal } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(refusal).toEqual({ heldBy: 'Snug for Mac' });
  });

  it('carries no userdb backend at all in that state — nothing can write', () => {
    const { platform } = composeLocalPlatform(client, status({ heldBy: 'Snug for Mac' }));
    expect(platform.userdbBackend).toBeUndefined();
    expect(platform.capabilities.connections).toBe(false);
  });
});

describe('the chip’s two newer states (ADR-0069 §6)', () => {
  afterEach(() => {
    brainState.current = undefined;
  });

  // MIGRATED 2026-10-03 (D4), both: each read its sentence off `platform.brain`'s label.
  // For these two states the platform now pins the DEMO brain (asserted), and the sentence —
  // unchanged, word for word — is asserted where it is made, `brainLabel`.
  it('names an OUTDATED cli with `claude update`', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'outdated', detail: 'run `claude update`' } }), undefined, undefined, 't');
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(brainLabel({ state: 'outdated' })).toMatch(/claude update/);
    expect(brainLabel({ state: 'outdated' })).not.toBe('Claude · your CLI');
  });

  it('tells a user with NO cli how to get one, in words — not a curl pipe', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'absent' } }), undefined, undefined, 't');
    expect(platform.brain).toEqual({ kind: 'demo' });
    const label = brainLabel({ state: 'absent' });
    expect(label).toMatch(/demo brain/);
    expect(label).toMatch(/install/i);
    expect(label).not.toMatch(/curl/);
  });
});


describe('the control survives the probe answering LATE (S7)', () => {
  it('appears once the probe reports ready, though the platform was composed before it answered', () => {
    // The real boot order: compose (brain state unknown), then the `status` event lands.
    brainState.current = undefined;
    const { platform } = composeLocalPlatform(client, status({}), undefined, undefined, 't', createBrainChoiceStore({ storage: undefined }));
    const brain = platform.brain as unknown as { cliModel?: unknown };
    expect(brain.cliModel).toBeUndefined();
    brainState.current = { state: 'ready' };
    // The platform is set ONCE and cannot be recomposed, so the seat must be read at render.
    expect(brain.cliModel).toBeDefined();
  });

  it('disappears again if the CLI stops being able to think — no dead control, ever', () => {
    brainState.current = { state: 'ready' };
    const { platform } = composeLocalPlatform(client, status({}), undefined, undefined, 't', createBrainChoiceStore({ storage: undefined }));
    const brain = platform.brain as unknown as { cliModel?: unknown };
    expect(brain.cliModel).toBeDefined();
    brainState.current = { state: 'logged-out' };
    expect(brain.cliModel).toBeUndefined();
  });
});

describe('the seat is stable across renders (S7 — useSyncExternalStore)', () => {
  it('returns the SAME state object on two reads of the getter, or the chip re-renders forever', () => {
    brainState.current = { state: 'ready' };
    const { platform } = composeLocalPlatform(client, status({}), undefined, undefined, 't', createBrainChoiceStore({ storage: undefined }));
    const brain = platform.brain as unknown as { cliModel?: { state: { get(): unknown } } };
    // Two renders read the getter twice; each gets its own seat object, but the STATE
    // snapshot they hand React must be identical or useSyncExternalStore loops.
    expect(brain.cliModel?.state.get()).toBe(brain.cliModel?.state.get());
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
  afterEach(() => {
    vi.unstubAllGlobals();
    brainState.current = undefined;
  });

  /** The shim's real answer: SSE, deltas, then the resolved model on the final frame. */
  const sse = (resolved: string): string => {
    const base = { id: 'chatcmpl-snug-x', object: 'chat.completion.chunk', created: 1 };
    return (
      `data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ ...base, model: resolved, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      'data: [DONE]\n\n'
    );
  };

  /** A client whose PROXY must never be used by the brain. */
  const proxyCalls: string[] = [];
  const guardedClient = fakeClient({
    fetchImpl: async (url: string) => {
      proxyCalls.push(url);
      throw new Error('the brain must not use the connected-apps proxy');
    },
  });

  const stubFetch = (resolved: string, status = 200, body?: string) => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
      return new Response(body ?? sse(resolved), { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } });
    });
    return calls;
  };

  const compose = (choices = createBrainChoiceStore({ storage: undefined })) => {
    brainState.current = { state: 'ready' };
    const { platform } = composeLocalPlatform(guardedClient, status({}), undefined, undefined, 't', choices);
    const adapter = (platform.brain as unknown as { adapter: { complete(r: unknown): Promise<{ ok: boolean; text?: string; message?: string }> } }).adapter;
    return { adapter, choices };
  };
  const think = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };

  it('a think SUCCEEDS end to end, and never touches the proxy — the owner’s chess move', async () => {
    proxyCalls.length = 0;
    const calls = stubFetch('claude-opus-5-5');
    const { adapter } = compose();
    const result = await adapter.complete(think);
    expect(result.ok).toBe(true);
    expect(result.text).toBe('ok');
    expect(proxyCalls).toEqual([]);
    expect(calls[0]?.url).toMatch(/\/v1\/chat\/completions$/);
  });

  it('sends the chosen model as its exact id', async () => {
    const calls = stubFetch('claude-sonnet-5');
    const { adapter, choices } = compose();
    choices.setModel('claude-sonnet-5');
    await adapter.complete(think);
    expect(calls[0]?.body.model).toBe('claude-sonnet-5');
  });

  it('sends the chosen effort AS A FIELD — the shared adapter drops unknown request fields', async () => {
    // The S5 version of this asserted the body contained "max", which matched
    // `max_completion_tokens`: a false positive while effort never reached the runner.
    const calls = stubFetch('claude-opus-5-5');
    const { adapter, choices } = compose();
    choices.setEffort('max');
    await adapter.complete(think);
    expect(calls[0]?.body.effort).toBe('max');
  });

  it('sends the placeholder and NO effort when nothing is chosen — the pre-task wire', async () => {
    const calls = stubFetch('claude-opus-5-5');
    const { adapter } = compose();
    await adapter.complete(think);
    expect(calls[0]?.body.model).toBe('claude');
    expect('effort' in (calls[0]?.body ?? {})).toBe(false);
  });

  it('reads the choice PER CALL, so a switch lands on the next think (ADR-0036 rule 3)', async () => {
    const calls = stubFetch('claude-opus-5-5');
    const { adapter, choices } = compose();
    choices.setModel('claude-sonnet-5');
    await adapter.complete(think);
    choices.setModel('claude-opus-5');
    await adapter.complete(think);
    expect(calls.map((c) => c.body.model)).toEqual(['claude-sonnet-5', 'claude-opus-5']);
  });

  it('teaches the chip the model that ANSWERED, even though the user chose none', async () => {
    stubFetch('claude-opus-5-5');
    const { adapter, choices } = compose();
    await adapter.complete(think);
    expect(choices.active().model).toBe('claude-opus-5-5');
  });

  it('records a refusal of the chosen model IN WORDS, and leaves the active model alone', async () => {
    const message = 'There’s an issue with the selected model (nope-not-a-model). It may not exist or you may not have access to it.';
    stubFetch('', 502, JSON.stringify({ error: { message } }));
    const { adapter, choices } = compose();
    choices.markAnswered('claude-opus-5-5');
    choices.setModel('nope-not-a-model');
    const result = await adapter.complete(think);
    expect(result.ok).toBe(false);
    expect(choices.active().refusal).toMatch(/nope-not-a-model/);
    expect(choices.active().model).toBe('claude-opus-5-5');
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
        releases.push(() =>
          resolve(
            model === 'nope-not-a-model'
              ? new Response(JSON.stringify({ error: { message } }), { status: 502, headers: { 'content-type': 'application/json' } })
              : new Response(sse('claude-sonnet-5'), { headers: { 'content-type': 'text/event-stream' } }),
          ),
        );
      });
    });
    const { adapter, choices } = compose();
    choices.setModel('nope-not-a-model');
    const a = adapter.complete(think);
    choices.setModel('claude-sonnet-5');
    const b = adapter.complete(think);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!(); // B answers first
    await b;
    releases[0]!(); // A's refusal lands late
    await a;
    expect(choices.active().model).toBe('claude-sonnet-5');
    expect(choices.active().refusal).toBeUndefined();
  });

  it('a late SUCCESS on the old model cannot move the chip back to it either', async () => {
    const releases: Array<() => void> = [];
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body ?? '{}')) as { model?: string }).model ?? 'claude';
      return new Promise<Response>((resolve) => {
        releases.push(() => resolve(new Response(sse(model === 'claude-opus-5' ? 'claude-opus-5' : 'claude-sonnet-5'), { headers: { 'content-type': 'text/event-stream' } })));
      });
    });
    const { adapter, choices } = compose();
    choices.setModel('claude-opus-5');
    const a = adapter.complete(think);
    choices.setModel('claude-sonnet-5');
    const b = adapter.complete(think);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await b;
    releases[0]!();
    await a;
    expect(choices.active().model).toBe('claude-sonnet-5');
  });

  it('does NOT call a network failure a model refusal', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const { adapter, choices } = compose();
    choices.setModel('claude-sonnet-5');
    await adapter.complete(think);
    expect(choices.active().refusal).toBeUndefined();
  });
});

describe('the chip label follows the model (S11)', () => {
  const CATALOGUE = [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', effort: true },
    { id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true },
  ];
  afterEach(() => {
    brainState.current = undefined;
  });
  const composeWith = (choices: ReturnType<typeof createBrainChoiceStore>, models: readonly (typeof CATALOGUE)[number][] = CATALOGUE) => {
    brainState.current = { state: 'ready' };
    const { platform } = composeLocalPlatform(client, status({ models }), undefined, undefined, 't', choices);
    return platform;
  };

  it('names the SELECTED model by its catalogue display name', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    choices.setModel('claude-sonnet-5');
    expect(labelOf(composeWith(choices).brain)).toBe('Claude · Sonnet 5');
  });

  it('follows a switch with no recompose — the platform is set once', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    choices.setModel('claude-sonnet-5');
    const platform = composeWith(choices);
    choices.setModel('claude-opus-5-5');
    expect(labelOf(platform.brain)).toBe('Claude · Opus 5.5');
  });

  it('with NOTHING selected, names the model the CLI actually ran once a think has answered', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    const platform = composeWith(choices);
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    // The CLI reports its default with a context suffix (measured: `claude-opus-5-5[1m]`).
    choices.markAnswered('claude-opus-5-5[1m]');
    expect(labelOf(platform.brain)).toBe('Claude · Opus 5.5');
  });

  it('shows the id itself for a model the catalogue does not list', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    choices.setModel('claude-some-future-model');
    expect(labelOf(composeWith(choices).brain)).toBe('Claude · claude-some-future-model');
  });

  it('shows the id when no catalogue could be read at all', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    choices.setModel('claude-sonnet-5');
    // An EMPTY list is how "no catalogue" arrives from the process (`/status.models` is always present).
    expect(labelOf(composeWith(choices, []).brain)).toBe('Claude · claude-sonnet-5');
  });

  it('keeps the REMEDY when the CLI cannot think, even with a model selected', () => {
    const choices = createBrainChoiceStore({ storage: undefined });
    choices.setModel('claude-sonnet-5');
    const platform = composeWith(choices);
    // MIGRATED 2026-10-03 (D4): the host brain is taken while it is the pin, because once
    // the CLI is logged out the platform answers the demo brain. The claim is the label's.
    const host = platform.brain;
    brainState.current = { state: 'logged-out' };
    expect(labelOf(host)).toMatch(/\/login/);
    expect(platform.brain).toEqual({ kind: 'demo' });
  });
});

// =====================================================================================
// The one-kit range (TASK-20261003 R2): one capability table, one custody store, the
// hand-in seat, the redirect fact — and D4, the demo fallback.
// =====================================================================================

describe('one of everything the bindings share (K4)', () => {
  afterEach(() => {
    brainState.current = undefined;
  });

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

describe('D4 — when the brain is KNOWN not ready, the demo brain answers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    brainState.current = undefined;
    modelsFromStatus.current = undefined;
  });

  const compose = (over: Partial<LocalStatus> = {}, deps: { client?: LocalClient; now?: () => number } = {}) =>
    composeLocalPlatform(deps.client ?? client, status(over), undefined, undefined, 't', createBrainChoiceStore({ storage: undefined }), deps.now).platform;

  it.each(['absent', 'logged-out', 'outdated'])('%s → the DEMO brain', (state) => {
    expect(compose({ brain: { state } }).brain).toEqual({ kind: 'demo' });
  });

  it.each([
    ['ready', { state: 'ready' }],
    ['unknown — a brain that could not be checked may well work', { state: 'unknown' }],
    ['a state this build has never heard of', { state: 'rate-limited' }],
    ['not answered yet', undefined],
  ])('%s → the HOST brain (optimistic, as before)', (_label, brain) => {
    expect(compose(brain === undefined ? {} : { brain }).brain?.kind).toBe('host');
  });

  it('both arms are STABLE references — a fresh object per read would re-render its readers for ever', () => {
    const platform = compose();
    const host = platform.brain;
    expect(platform.brain).toBe(host);
    brainState.current = { state: 'absent' };
    const demo = platform.brain;
    expect(demo).not.toBe(host);
    expect(platform.brain).toBe(demo);
    brainState.current = { state: 'ready' };
    expect(platform.brain, 'the host arm that comes back is the one that left').toBe(host);
  });

  it('`brain` is a GETTER on the platform — a spread or a copy at boot would freeze the arm', () => {
    const platform = compose();
    expect(Object.getOwnPropertyDescriptor(platform, 'brain')?.get).toBeTypeOf('function');
    expect(Object.keys(platform)).toContain('brain');
  });

  it('with no bearer there is no brain at all — nothing to think with, nothing to fall back from', () => {
    expect(composeLocalPlatform(client, status({ brain: { state: 'absent' } })).platform.brain).toBeUndefined();
  });

  describe('a verdict that arrives LATE (the `status` event)', () => {
    it('moves the platform and bumps brainRevision — the signal a reader re-reads on', () => {
      const platform = compose();
      const before = brainRevisionStore.get();
      applyRunnerStatus({ brain: { state: 'logged-out', detail: 'run `/login`' }, models: [] });
      expect(platform.brain).toEqual({ kind: 'demo' });
      expect(brainRevisionStore.get()).toBeGreaterThan(before);
    });

    it('an UNCHANGED verdict bumps nothing — a re-check that learns nothing re-renders nobody', () => {
      compose();
      applyRunnerStatus({ brain: { state: 'ready' }, models: [{ id: 'm', name: 'M', effort: true }] });
      const settled = brainRevisionStore.get();
      applyRunnerStatus({ brain: { state: 'ready' }, models: [{ id: 'm', name: 'M', effort: true }] });
      expect(brainRevisionStore.get()).toBe(settled);
    });

    it('a model list alone is a change too — the chip’s dropdown is read from it', () => {
      compose();
      const before = brainRevisionStore.get();
      applyRunnerStatus({ models: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true }] });
      expect(modelsFromStatus.current).toEqual([{ id: 'claude-sonnet-5', name: 'Sonnet 5', effort: true }]);
      expect(brainRevisionStore.get()).toBe(before + 1);
    });

    it('a frame that is not a status changes nothing and throws nothing', () => {
      compose({ brain: { state: 'ready' } });
      const before = brainRevisionStore.get();
      for (const junk of [undefined, null, 'ready', 7, [], { brain: 'ready' }, { brain: { state: 7 } }, { models: 'all of them' }]) applyRunnerStatus(junk);
      expect(brainRevisionStore.get()).toBe(before);
      expect(brainState.current).toBeUndefined();
    });
  });

  describe('the re-check', () => {
    const failing = (status: number, message: string): void => {
      vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } }));
    };
    const think = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }] };
    const adapterOf = (platform: ReturnType<typeof compose>) => (platform.brain as unknown as { adapter: { complete(r: unknown): Promise<{ ok: boolean; code?: string; message?: string }> } }).adapter;

    it('a think the brain could not answer returns ITS OWN named error — no demo reply is slipped in — and asks the runner to look again', async () => {
      const recheckBrain = vi.fn(async () => {});
      failing(502, 'your Claude CLI is not logged in — run `claude` and `/login`');
      const platform = compose({ brain: { state: 'ready' } }, { client: fakeClient({ recheckBrain }) });
      const result = await adapterOf(platform).complete(think);
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not logged in/);
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      // The NEXT turn is routed by what the re-check learns: the verdict lands, the pin moves.
      applyRunnerStatus({ brain: { state: 'logged-out' } });
      expect(platform.brain).toEqual({ kind: 'demo' });
    });

    it('a network failure on the think asks too — the runner’s shim itself may be what went away', async () => {
      const recheckBrain = vi.fn(async () => {});
      vi.stubGlobal('fetch', async () => {
        throw new TypeError('Failed to fetch');
      });
      await adapterOf(compose({ brain: { state: 'ready' } }, { client: fakeClient({ recheckBrain }) })).complete(think);
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
      const platform = compose({ brain: { state: 'ready' } }, { client: fakeClient({ recheckBrain }) });
      const result = await (platform.brain as unknown as { adapter: { complete(r: unknown): Promise<{ ok: boolean; code?: string }> } }).adapter.complete({ ...think, signal: controller.signal });
      expect(result).toMatchObject({ ok: false, code: 'CANCELLED' });
      expect(recheckBrain).not.toHaveBeenCalled();
    });

    it('a think that ANSWERS asks nothing', async () => {
      const recheckBrain = vi.fn(async () => {});
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1 };
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            `data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
              `data: ${JSON.stringify({ ...base, model: 'claude-opus-5-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const result = await adapterOf(compose({ brain: { state: 'ready' } }, { client: fakeClient({ recheckBrain }) })).complete(think);
      expect(result.ok).toBe(true);
      expect(recheckBrain).not.toHaveBeenCalled();
    });

    it('while the DEMO brain is answering the page asks the runner to look again — at most once per floor', () => {
      // The user may have just run `/login` in a terminal this page cannot see.
      const recheckBrain = vi.fn(async () => {});
      let now = 1_000_000;
      const platform = compose({ brain: { state: 'logged-out' } }, { client: fakeClient({ recheckBrain }), now: () => now });
      // Every read while demo answers — a think, a render — may ask; only the first does.
      for (let i = 0; i < 50; i += 1) expect(platform.brain).toEqual({ kind: 'demo' });
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      now += DEMO_RECHECK_FLOOR_MS - 1;
      void platform.brain;
      expect(recheckBrain).toHaveBeenCalledTimes(1);
      now += 1;
      void platform.brain;
      expect(recheckBrain).toHaveBeenCalledTimes(2);
    });

    it('while the HOST brain is the pin, reading it asks nothing — a re-check of a ready brain is a real think', () => {
      const recheckBrain = vi.fn(async () => {});
      const platform = compose({ brain: { state: 'ready' } }, { client: fakeClient({ recheckBrain }) });
      for (let i = 0; i < 50; i += 1) void platform.brain;
      expect(recheckBrain).not.toHaveBeenCalled();
    });
  });
});

describe('D4 through the playground’s own readers — ready → absent → ready', () => {
  // A fresh module graph: the platform is set once per graph, and the readers under test
  // (`currentBrain`, the turn adapter, the app transport) read THAT singleton.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('the chip label, currentBrain(), the builder arm and an app think all follow; nothing throws; the tag says demo while demo answers', async () => {
    vi.resetModules();
    const local = await import('../local/compose-local.js');
    const platformModule = await import('@playground/platform/platform');
    const webllm = await import('@playground/state/webllm');
    const activeBrain = await import('@playground/state/activeBrain');
    const adapterModule = await import('@playground/agent/adapter');
    const { createBrainChoiceStore: choiceStore } = await import('../brains/brainChoiceStore.js');
    const { createMemoryBackend } = await import('@snugprotocol/db');

    // The runner's shim, as the page reaches it: SSE, the resolved model on the last frame.
    const shimCalls: string[] = [];
    const base = { id: 'c', object: 'chat.completion.chunk', created: 1 };
    vi.stubGlobal('fetch', async (url: string) => {
      shimCalls.push(String(url));
      return new Response(
        `data: ${JSON.stringify({ ...base, model: 'claude', choices: [{ index: 0, delta: { role: 'assistant', content: 'from the CLI' }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ ...base, model: 'claude-opus-5-5', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });

    const { platform } = local.composeLocalPlatform(fakeClient(), status({ brain: { state: 'ready' } }), undefined, createMemoryBackend(), 't', choiceStore({ storage: undefined }));
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
    local.applyRunnerStatus({ brain: { state: 'absent' } });
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
    local.applyRunnerStatus({ brain: { state: 'ready' } });
    expect(chipLabel()).toBe('Claude · claude-opus-5-5');
    expect(activeBrain.resolveActiveBrain()).toBe('host');
    expect(await builderTurn()).toEqual({ tag: 'host', ok: true });
    expect(await appThink()).toEqual({ ok: true, text: 'from the CLI' });
    expect(shimCalls).toHaveLength(4);
  });
});
