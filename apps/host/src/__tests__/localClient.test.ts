// The page's half of the loopback contract (ADR-0068 D-B16).
//
// The reconstruction cases here are not hypothetical: each one is a shape that makes
// `new Response(...)` THROW, which the executor would then report to the app as a transport
// failure for a request that actually succeeded.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  RUNNER_MARKER_HEADER,
  RUNNER_STOPPED_MESSAGE,
  claimTokenFromFragment,
  createLocalClient,
  isRunnerRefusal,
  parseLocalStatus,
  parseStatusEvent,
  responseFromEnvelope,
  serializeBody,
} from '../local/client.js';

const TOKEN = 'a'.repeat(64);

describe('claiming the token from the fragment', () => {
  const win = (hash: string, stored: string | null = null) => {
    const store = new Map<string, string>();
    if (stored !== null) store.set('snug-host-token', stored);
    const replaceState = vi.fn();
    return {
      win: {
        location: { hash, pathname: '/', search: '' },
        history: { replaceState },
        sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
      },
      replaceState,
      store,
    };
  };

  it('reads the token and REMOVES it from the address bar', () => {
    const { win: w, replaceState } = win(`#token=${TOKEN}`);
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
    // The router reads location.hash on its first render; a leftover #token= would be
    // treated as a route, and the address bar would show the credential.
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/');
  });

  it('remembers it for a reload, when the fragment is gone', () => {
    const { win: w } = win('#/', TOKEN);
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
  });

  it('returns nothing for a tab opened without one', () => {
    expect(claimTokenFromFragment(win('#/').win)).toBeUndefined();
  });

  it('ignores a fragment that is not a well-formed token', () => {
    expect(claimTokenFromFragment(win('#token=short').win)).toBeUndefined();
  });

  it('works with NO sessionStorage at all — the guarded accessor answered undefined', () => {
    // K4: the caller hands in `safeSessionStorage(window)`, which is undefined where the
    // global throws. This load still works; a reload has nothing to remember it by.
    const replaceState = vi.fn();
    const w = { location: { hash: `#token=${TOKEN}`, pathname: '/', search: '' }, history: { replaceState }, sessionStorage: undefined };
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#/');
    expect(claimTokenFromFragment({ ...w, location: { hash: '#/', pathname: '/', search: '' } })).toBeUndefined();
  });

  it('survives sessionStorage throwing (a private window)', () => {
    const w = {
      location: { hash: `#token=${TOKEN}`, pathname: '/', search: '' },
      history: { replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
      },
    };
    // This load still works; only the reload does not.
    expect(claimTokenFromFragment(w)).toBe(TOKEN);
  });
});

describe('rebuilding a Response the executor can gate', () => {
  it('carries status, headers and body', async () => {
    const response = responseFromEnvelope({
      ok: true,
      status: 200,
      headers: [['content-type', 'application/json']],
      bodyBase64: Buffer.from('{"a":1}').toString('base64'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it.each([204, 205, 304])('handles %i — a null-body status with a body THROWS', (status) => {
    // A provider answering 204 to a DELETE is ordinary. Constructing that Response with a
    // body would throw inside fetchImpl and reach the app as NET_FETCH_FAILED on a request
    // that in fact succeeded.
    const response = responseFromEnvelope({ ok: true, status, bodyBase64: Buffer.from('ignored').toString('base64') });
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('clamps a status outside 200–599 rather than throwing', () => {
    expect(responseFromEnvelope({ ok: true, status: 0 }).status).toBe(200);
    expect(responseFromEnvelope({ ok: true, status: 999 }).status).toBe(599);
  });

  it('drops a statusText outside the reason-phrase grammar', () => {
    expect(() => responseFromEnvelope({ ok: true, status: 200, statusText: 'bad\nnewline' })).not.toThrow();
  });

  it('keeps a statusText inside the reason-phrase grammar — obs-text included — and drops DEL', () => {
    // The grammar is HTAB / SP / VCHAR / obs-text (0x80–0xFF). The range used to be spelled
    // with a RAW U+0080 in the source, invisible in an editor; it is escapes now, and this
    // pins both of its edges.
    expect(responseFromEnvelope({ ok: true, status: 200, statusText: 'Not Found' }).statusText).toBe('Not Found');
    expect(responseFromEnvelope({ ok: true, status: 200, statusText: 'caf\u00e9 \u0080' }).statusText).toBe('caf\u00e9 \u0080');
    expect(responseFromEnvelope({ ok: true, status: 200, statusText: 'a\u007fb' }).statusText).toBe('');
    expect(responseFromEnvelope({ ok: true, status: 200, statusText: 'snow \u2603' }).statusText).toBe('');
  });

  it('preserves a 3xx as data, so the executor’s own redirect gate is what refuses it', () => {
    const response = responseFromEnvelope({ ok: true, status: 302, headers: [['content-type', 'text/html']] });
    expect(response.status).toBe(302);
  });

  it('a body that is not base64 is a NAMED failure, not an empty success', () => {
    // The decode is `@snugprotocol/db`'s (one decoder — K4), which is total: it answers
    // undefined for garbage. Treating that as "no body" would hand an app an empty 200.
    expect(() => responseFromEnvelope({ ok: true, status: 200, bodyBase64: '%%% not base64 %%%' })).toThrow(/not base64/);
  });

  it('round-trips bytes above 0x7F without mangling them', () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x41]);
    const response = responseFromEnvelope({ ok: true, status: 200, bodyBase64: Buffer.from(bytes).toString('base64') });
    return response.arrayBuffer().then((buffer) => expect(new Uint8Array(buffer)).toEqual(bytes));
  });
});

describe('serializing a request body', () => {
  it('passes a string through — what the executor always sends', () => {
    expect(serializeBody('{"a":1}')).toBe('{"a":1}');
  });

  it('encodes URLSearchParams — what the OAuth service sends', () => {
    // JSON.stringify of URLSearchParams is "{}", which would make every token exchange,
    // refresh and revoke a silently empty POST.
    const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r1' });
    expect(serializeBody(params)).toBe('grant_type=refresh_token&refresh_token=r1');
  });

  it('leaves an absent body absent', () => {
    expect(serializeBody(undefined)).toBeUndefined();
    expect(serializeBody(null)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ the one-kit range

describe('the status wire — ONE fixture, read by the process’s route test and by this client (B2)', () => {
  // MIGRATED 2026-10-03 (TASK-20261003 B2 — named in the plan). The wire carried ONE brain
  // (`brain: { state, detail }`) and its model list (`models: [{ id, name, effort }]`). It
  // carries every brain the runner knows now — `brains[]`, each with its own state, levels
  // and catalogue — and `active`, the brain a think sent under `auto` would run on. The two
  // legacy fields are gone from both ends (the page ships with the process: one build).
  const wire = JSON.parse(readFileSync(path.resolve(__dirname, '../../../host-mcp/src/__tests__/fixtures/status-wire.json'), 'utf8')) as { brains: unknown[] };

  it('parses the fixture: the binding, the port, the pages and the redirect fact', () => {
    const status = parseLocalStatus(wire);
    expect(status).toMatchObject({ binding: 'local-host', port: 43127, pages: 1, oauthRedirect: true });
  });

  it('parses the fixture’s brains WHOLE — every field the runner sends for a brain is one the page reads', () => {
    const status = parseLocalStatus(wire);
    expect(status?.active).toBe('claude');
    expect(status?.brains).toEqual(wire.brains);
    expect(status?.brains.map((brain) => [brain.id, brain.state, brain.verified])).toEqual([
      ['claude', 'ready', true],
      ['codex', 'logged-out', false],
    ]);
    // Per-model levels, in the brain's own words; a model with none says so by an empty list.
    expect(status?.brains[0]?.models.map((model) => [model.id, model.efforts.length])).toEqual([
      ['claude-sonnet-5-5', 5],
      ['claude-haiku-4-5-20251001', 0],
    ]);
    expect(status?.brains[1]?.detail).toBe('Your Codex CLI is not logged in — run `codex login`, then check again.');
  });

  it('reads the optional seats when they are well-formed, and drops them when they are not', () => {
    const base = { binding: 'local-host', port: 43127, pages: 0 };
    const codex = { id: 'codex', name: 'Codex', via: 'your Codex CLI', state: 'ready', verified: false, streaming: false, efforts: ['low'], models: [{ id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low'] }] };
    expect(parseLocalStatus({ ...base, heldBy: 'Snug for Mac', oauthRedirect: false, active: 'codex', brains: [codex] })).toEqual({
      ...base,
      heldBy: 'Snug for Mac',
      oauthRedirect: false,
      active: 'codex',
      brains: [codex],
    });
    // A seat of the wrong shape is ABSENT, never cast through: the page then says "not known".
    expect(parseLocalStatus({ ...base, heldBy: 7, oauthRedirect: 'yes', active: 7, brains: 'claude' })).toEqual({ ...base, brains: [] });
    expect(parseLocalStatus({ ...base, active: '' })).toEqual({ ...base, brains: [] });
  });

  it('a runner that has reported no brain yet is a status with NONE — not a refusal to parse', () => {
    expect(parseLocalStatus({ binding: 'local-host', port: 43127, pages: 1 })).toEqual({ binding: 'local-host', port: 43127, pages: 1, brains: [] });
  });

  it('the LEGACY single-brain fields are not read: a status that carries only them reports no brain', () => {
    const status = parseLocalStatus({ binding: 'local-host', port: 43127, pages: 1, brain: { state: 'ready' }, models: [{ id: 'm', name: 'M', effort: true }] });
    expect(status).toEqual({ binding: 'local-host', port: 43127, pages: 1, brains: [] });
  });

  describe('one brain entry', () => {
    const good = { id: 'claude', name: 'Claude', via: 'your Claude Code CLI', state: 'ready', verified: true, streaming: true, efforts: ['low'], models: [{ id: 'm', name: 'M', efforts: [] }] };
    const brainsOf = (entry: unknown): unknown => parseLocalStatus({ binding: 'local-host', port: 1, pages: 0, brains: [entry, { ...good, id: 'other' }] })?.brains;

    it('keeps the optional detail and cap when they are well-formed', () => {
      expect(brainsOf({ ...good, state: 'logged-out', detail: 'run `/login`', maxPromptBytes: 900_000 })).toEqual([
        { ...good, state: 'logged-out', detail: 'run `/login`', maxPromptBytes: 900_000 },
        { ...good, id: 'other' },
      ]);
    });

    it('ignores fields it does not know — a newer runner may say more', () => {
      expect(brainsOf({ ...good, colour: 'ember', models: [{ id: 'm', name: 'M', efforts: [], context: 1_000_000 }] })).toEqual([good, { ...good, id: 'other' }]);
    });

    it('a STATE it has never heard of is kept as the string it is — the chip renders it as unknown, with its detail', () => {
      expect(brainsOf({ ...good, state: 'rate-limited', detail: 'try again at noon' })).toEqual([
        { ...good, state: 'rate-limited', detail: 'try again at noon' },
        { ...good, id: 'other' },
      ]);
    });

    it.each([
      ['no id', { ...good, id: undefined }],
      ['an empty id', { ...good, id: '' }],
      ['a name that is not a string', { ...good, name: 7 }],
      ['no via', { ...good, via: undefined }],
      ['a state that is not a string', { ...good, state: { ready: true } }],
      ['`verified` that is not a boolean — never guessed: an unverified brain must not pass as verified', { ...good, verified: 'yes' }],
      ['no `verified` at all', { ...good, verified: undefined }],
      ['`streaming` that is not a boolean', { ...good, streaming: 1 }],
      ['levels that are not strings', { ...good, efforts: ['low', 2] }],
      ['levels that are not a list', { ...good, efforts: 'low' }],
      ['models that are not a list', { ...good, models: 'all of them' }],
      ['a model with no id', { ...good, models: [{ name: 'M', efforts: [] }] }],
      ['a model whose levels are not a list', { ...good, models: [{ id: 'm', name: 'M', efforts: true }] }],
      ['a string', 'claude'],
      ['null', null],
    ])('drops an entry with %s, and keeps the well-formed one beside it', (_label, entry) => {
      expect(brainsOf(entry)).toEqual([{ ...good, id: 'other' }]);
    });

    it.each([
      ['a detail that is not a string', { detail: 7 }],
      ['a cap that is not a number', { maxPromptBytes: '900000' }],
      ['a cap that is not a positive size', { maxPromptBytes: 0 }],
      ['a cap that is not finite', { maxPromptBytes: Number.POSITIVE_INFINITY }],
    ])('drops %s and keeps the brain', (_label, extra) => {
      expect(brainsOf({ ...good, ...extra })).toEqual([good, { ...good, id: 'other' }]);
    });
  });

  it.each([
    ['null', null],
    ['a string', 'local-host'],
    ['an array', []],
    ['another binding', { binding: 'artifact', port: 1, pages: 0 }],
    ['no binding', { port: 43127, pages: 1 }],
    ['a port that is not a number', { binding: 'local-host', port: '43127', pages: 1 }],
    ['no pages', { binding: 'local-host', port: 43127 }],
  ])('refuses %s — a 200 from something that is not a runner is not a runner', (_label, value) => {
    expect(parseLocalStatus(value)).toBeUndefined();
  });

  describe('the `status` EVENT — the same brains, late', () => {
    it('parses the fixture as an event: what answers under auto, and every brain', () => {
      expect(parseStatusEvent(wire)).toEqual({ active: 'claude', brains: wire.brains });
    });

    it('an event with brains and NO `active` says none is ready — absence is the fact, not a gap', () => {
      const event = parseStatusEvent({ brains: wire.brains });
      expect(event).toEqual({ brains: wire.brains });
      expect(event !== undefined && 'active' in event).toBe(false);
    });

    it.each([undefined, null, 'ready', 7, [], {}, { brain: { state: 'ready' } }, { brains: 'all of them' }, { active: 'claude' }])(
      'a frame that carries no brains list (%j) is not a status at all',
      (frame) => {
        expect(parseStatusEvent(frame)).toBeUndefined();
      },
    );
  });
});

describe('the runner’s refusal marker', () => {
  it('is the process’s own constant — the page cannot import it, so it is pinned against the source', () => {
    const gates = readFileSync(path.resolve(__dirname, '../../../host-mcp/src/loopback-gates.ts'), 'utf8');
    expect(/export const RUNNER_MARKER_HEADER = '([^']+)'/.exec(gates)?.[1]).toBe(RUNNER_MARKER_HEADER);
    expect(gates).toContain("[RUNNER_MARKER_HEADER]: '1'");
  });

  it('is read off a response: the header AND its value', () => {
    expect(isRunnerRefusal(new Response('', { status: 401, headers: { [RUNNER_MARKER_HEADER]: '1' } }))).toBe(true);
    expect(isRunnerRefusal(new Response('', { status: 401 }))).toBe(false);
    expect(isRunnerRefusal(new Response('', { status: 401, headers: { [RUNNER_MARKER_HEADER]: 'yes' } }))).toBe(false);
  });
});

/** A fetch whose answers a test scripts per path. */
function scripted(routes: Record<string, (init: RequestInit | undefined) => Response | Promise<Response>>) {
  const calls: { path: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path: input, init });
    const route = routes[input];
    if (route === undefined) throw new TypeError('Failed to fetch');
    return route(init);
  };
  return { calls, fetchImpl };
}

const refusal = (status: number): Response => new Response('', { status, headers: { [RUNNER_MARKER_HEADER]: '1' } });
const BYTES = new Uint8Array([1, 2, 3]);

describe('a stopped runner is SAID, on the write that found it (K7)', () => {
  const write = async (response: () => Response | Promise<Response>) => {
    const net = scripted({ '/userdb/user.snug': response });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    const outcome = await client.fs.writeFileAtomic('Snug/user.snug', BYTES).then(
      () => 'saved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    return { client, net, outcome };
  };

  it('a 401 — the runner restarted and this page’s bearer is nobody’s', async () => {
    const { client, outcome } = await write(() => refusal(401));
    expect(client.stopped.get()).toBe(true);
    expect(outcome).toBe(RUNNER_STOPPED_MESSAGE);
  });

  it('a bare 401 too — whatever answers there now, this page’s bearer admits no write', async () => {
    const { client } = await write(() => new Response('', { status: 401 }));
    expect(client.stopped.get()).toBe(true);
  });

  it('a network failure — nothing is listening where the runner was', async () => {
    const { client, outcome } = await write(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(client.stopped.get()).toBe(true);
    expect(outcome).toBe(RUNNER_STOPPED_MESSAGE);
  });

  it('a refusal carrying the marker — the runner is draining and will take no more writes', async () => {
    const { client } = await write(() => refusal(503));
    expect(client.stopped.get()).toBe(true);
  });

  it('NOT every failure: a 500 or a held file is a failed save, and the runner is still there', async () => {
    for (const status of [500, 423, 413]) {
      const { client, outcome } = await write(() => new Response('', { status }));
      expect(client.stopped.get(), String(status)).toBe(false);
      expect(outcome).toBe(`saving your file failed (${status})`);
    }
  });

  it('a successful write stops nothing', async () => {
    const { client, outcome } = await write(() => new Response(null, { status: 204 }));
    expect(outcome).toBe('saved');
    expect(client.stopped.get()).toBe(false);
  });

  it('once stopped it takes NO further edits — the next write is refused without a request', async () => {
    const { client, net } = await write(() => refusal(401));
    const requests = net.calls.length;
    await expect(client.fs.writeFileAtomic('Snug/user.snug', BYTES)).rejects.toThrow(RUNNER_STOPPED_MESSAGE);
    expect(net.calls.length, 'a stopped page must not keep knocking').toBe(requests);
  });

  it('tells its subscribers ONCE', async () => {
    const net = scripted({ '/userdb/user.snug': () => refusal(401) });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    let told = 0;
    client.stopped.subscribe(() => void (told += 1));
    await client.fs.writeFileAtomic('Snug/user.snug', BYTES).catch(() => undefined);
    await client.fs.writeFileAtomic('Snug/user.snug', BYTES).catch(() => undefined);
    expect(told).toBe(1);
  });

  it('a READ that fails is not "stopped" — absence and failure keep their own meanings', async () => {
    const net = scripted({ '/userdb/user.snug': () => new Response('', { status: 404 }) });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    expect(await client.fs.readFile('Snug/user.snug')).toBeUndefined();
    expect(client.stopped.get()).toBe(false);
  });
});

/** An SSE body a test feeds frame by frame and can end. */
function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    send: (name: string, data: unknown) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)),
    end: () => controller.close(),
  };
}

describe('the event stream says when the runner went away (K7)', () => {
  /** Timers a test turns by hand: the reconnect loop sleeps and reads the clock through these. */
  const clock = () => {
    let now = 0;
    const sleepers: Array<() => void> = [];
    return {
      now: () => now,
      sleep: (ms: number) =>
        new Promise<void>((resolve) => {
          sleepers.push(() => {
            now += ms;
            resolve();
          });
        }),
      /** Let the loop's current sleep finish. */
      tick: async () => {
        await vi.waitFor(() => expect(sleepers.length).toBeGreaterThan(0));
        sleepers.shift()!();
      },
    };
  };

  it('delivers events, and a `shutdown` event stops the page at once', async () => {
    const live = stream();
    const net = scripted({ '/events': () => live.response });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    const seen: [string, unknown][] = [];
    const close = client.events((name, data) => void seen.push([name, data]));
    live.send('status', { brain: { state: 'ready' } });
    await vi.waitFor(() => expect(seen).toEqual([['status', { brain: { state: 'ready' } }]]));
    expect(client.stopped.get()).toBe(false);

    live.send('shutdown', {});
    await vi.waitFor(() => expect(client.stopped.get()).toBe(true));
    expect(seen, 'shutdown is the client’s own business, not an event for the page').toHaveLength(1);
    close();
  });

  it('a stream that is LOST and does not come back within the bound → stopped', async () => {
    const first = stream();
    let opened = 0;
    const net = scripted({
      '/events': () => {
        opened += 1;
        if (opened === 1) return first.response;
        throw new TypeError('Failed to fetch');
      },
    });
    const time = clock();
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl, now: time.now, sleep: time.sleep, reconnectBoundMs: 1_000, retryMs: 400 });
    const close = client.events(() => undefined);
    await vi.waitFor(() => expect(opened).toBe(1));
    first.end();

    // Lost at t=0. Retries at 400 and 800 fail and are inside the bound; at 1200 it is past.
    await time.tick();
    await vi.waitFor(() => expect(opened).toBe(2));
    expect(client.stopped.get()).toBe(false);
    await time.tick();
    await vi.waitFor(() => expect(opened).toBe(3));
    expect(client.stopped.get()).toBe(false);
    await time.tick();
    await vi.waitFor(() => expect(client.stopped.get()).toBe(true));
    close();
  });

  it('a stream that is lost and COMES BACK inside the bound is not a stopped runner — and keeps delivering', async () => {
    const first = stream();
    const second = stream();
    let opened = 0;
    const net = scripted({
      '/events': () => {
        opened += 1;
        return opened === 1 ? first.response : second.response;
      },
    });
    const time = clock();
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl, now: time.now, sleep: time.sleep, reconnectBoundMs: 1_000, retryMs: 400 });
    const seen: string[] = [];
    const close = client.events((name) => void seen.push(name));
    await vi.waitFor(() => expect(opened).toBe(1));
    first.end(); // a laptop lid, a dropped connection
    await time.tick();
    await vi.waitFor(() => expect(opened).toBe(2));
    second.send('hand-in', { bundle: {} });
    await vi.waitFor(() => expect(seen).toEqual(['hand-in']));
    expect(client.stopped.get()).toBe(false);
    close();
  });

  it('each loss gets its OWN bound — a stream that came back does not carry the earlier outage with it', async () => {
    const first = stream();
    const second = stream();
    let opened = 0;
    const net = scripted({
      '/events': () => {
        opened += 1;
        if (opened === 1) return first.response;
        if (opened === 2) return second.response;
        throw new TypeError('Failed to fetch');
      },
    });
    const time = clock();
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl, now: time.now, sleep: time.sleep, reconnectBoundMs: 1_000, retryMs: 400 });
    const close = client.events(() => undefined);
    await vi.waitFor(() => expect(opened).toBe(1));
    first.end(); // lost at t=0…
    await time.tick(); // …back at t=400
    await vi.waitFor(() => expect(opened).toBe(2));
    second.end(); // lost AGAIN at t=400: the bound runs from here, to t=1400
    await time.tick(); // t=800
    await vi.waitFor(() => expect(opened).toBe(3));
    await time.tick(); // t=1200 — 800 ms into THIS outage, 1200 ms after the first one
    await vi.waitFor(() => expect(opened).toBe(4));
    expect(client.stopped.get(), 'the first outage must not be counted against the second').toBe(false);
    await time.tick(); // t=1600
    await vi.waitFor(() => expect(client.stopped.get()).toBe(true));
    close();
  });

  it('a reconnect the runner REFUSES is a stopped runner at once — a new runner holds a new bearer', async () => {
    const first = stream();
    let opened = 0;
    const net = scripted({
      '/events': () => {
        opened += 1;
        return opened === 1 ? first.response : refusal(401);
      },
    });
    const time = clock();
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl, now: time.now, sleep: time.sleep, reconnectBoundMs: 60_000, retryMs: 400 });
    const close = client.events(() => undefined);
    await vi.waitFor(() => expect(opened).toBe(1));
    first.end();
    await time.tick();
    await vi.waitFor(() => expect(client.stopped.get()).toBe(true));
    expect(opened).toBe(2);
    close();
  });

  it('unsubscribing ends the loop quietly — a page that left is not a runner that stopped', async () => {
    const live = stream();
    const net = scripted({ '/events': () => live.response });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    const close = client.events(() => undefined);
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    close();
    live.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.stopped.get()).toBe(false);
    expect(net.calls).toHaveLength(1);
  });
});

describe('what the page tells the runner (K6, D4)', () => {
  it('reports a hand-in’s outcome on the bearer route, as JSON', async () => {
    const net = scripted({ '/hand-in/outcome': () => new Response(null, { status: 204 }) });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    await client.reportHandIn({ id: 'f'.repeat(32), outcome: 'updated', version: 3 });
    const { init } = net.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'f'.repeat(32), outcome: 'updated', version: 3 });
  });

  it('a report that cannot be delivered is swallowed — the tool says "not confirmed", the page does not break', async () => {
    const client = createLocalClient(TOKEN, { fetch: scripted({}).fetchImpl });
    await expect(client.reportHandIn({ id: 'f'.repeat(32), outcome: 'installed' })).resolves.toBeUndefined();
    expect(client.stopped.get(), 'a failed report is not evidence the runner stopped').toBe(false);
  });

  it('asks for the brain to be probed again, with the bearer', async () => {
    const net = scripted({ '/brain/recheck': () => new Response(null, { status: 202 }) });
    const client = createLocalClient(TOKEN, { fetch: net.fetchImpl });
    await client.recheckBrain();
    expect(net.calls[0]!.init?.method).toBe('POST');
    expect(new Headers(net.calls[0]!.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    await expect(createLocalClient(TOKEN, { fetch: scripted({}).fetchImpl }).recheckBrain()).resolves.toBeUndefined();
  });
});
