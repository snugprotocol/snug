// The local page's platform (ADR-0068 D-B14, D-B24).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { brainState, composeLocalPlatform } from '../local/compose-local.js';
import { createBrainChoiceStore } from '../brains/brainChoiceStore.js';
import type { LocalClient, LocalStatus } from '../local/client.js';

const client = {
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  status: async () => ({ binding: 'local-host', port: 43127, pages: 1 }),
  events: () => () => {},
} as unknown as LocalClient;

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

  it('NAMES a logged-out CLI on the chip, with the remedy', () => {
    // The owner's walk: a logged-out CLI surfaced as a bare HTTP 502 at the first think,
    // with no remedy and no sign the brain was the problem. The chip must say so before
    // the user asks an app to think.
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'logged-out', detail: 'run `claude` and `/login`' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toMatch(/log/i);
    expect(labelOf(platform.brain)).not.toBe('Claude · your CLI');
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
    const { platform } = composeLocalPlatform(client, status(), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toBe('Claude · your CLI');
    brainState.current = { state: 'logged-out', detail: 'run `claude` and `/login`' };
    expect(labelOf(platform.brain), 'the SAME platform object must now read the new label').toMatch(/log/i);
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

  it('names an OUTDATED cli with `claude update` on the chip', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'outdated', detail: 'run `claude update`' } }), undefined, undefined, 't');
    expect(labelOf(platform.brain)).toMatch(/claude update/);
    expect(labelOf(platform.brain)).not.toBe('Claude · your CLI');
  });

  it('tells a user with NO cli how to get one, in words — not a curl pipe', () => {
    const { platform } = composeLocalPlatform(client, status({ brain: { state: 'absent' } }), undefined, undefined, 't');
    const label = labelOf(platform.brain) ?? '';
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
  const guardedClient = {
    ...client,
    fetchImpl: async (url: string) => {
      proxyCalls.push(url);
      throw new Error('the brain must not use the connected-apps proxy');
    },
  } as unknown as LocalClient;

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
    brainState.current = { state: 'logged-out' };
    expect(labelOf(platform.brain)).toMatch(/\/login/);
  });
});
