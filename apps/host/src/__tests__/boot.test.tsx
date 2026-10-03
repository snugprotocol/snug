// boot.test.tsx — TASK-20261003 K2/K4/K6 (ADR-0072 §2): the binding is decided ONCE, at
// runtime, by the one boot.
//
//   1. `/oauth/callback` → the callback page ALONE. Under the kit's hash router that
//      document rendered the hub, so an OAuth flow on the runner could never complete.
//   2. The runner — asked for ONLY at the literal `http://127.0.0.1`: one bounded GET of
//      `/status`. The runner's shape → the local composition; a refusal carrying the
//      runner's marker → "open it from your agent"; anything else → not a runner.
//   3. Everything else → the probe and the hosted composition, as before. A loopback
//      static server is file-class and its custody copy says so.
//
// And under the runner the page reads NO embedded bundle block and NO `snug-db` block: the
// file is the runner's and apps arrive as its events.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createMemoryBackend } from '@snugprotocol/db';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { custodyDisclosure } from '@playground/platform/copy';

import { upsertBundleBlock, writeDbBlock, DB_BLOCK_FORMAT } from '../../../../scripts/lib/page-blocks.mjs';
import { OAUTH_CALLBACK_PATH, RUNNER_STATUS_BOUND_MS, askRunner, isRunnerOrigin, planBoot, type BootWindow } from '../boot.js';
import type { ComposeDocument } from '../compose.js';
import { RUNNER_MARKER_HEADER, type LocalClient } from '../local/client.js';
import { decideBinding, readBindingEnv, type ProbeResult } from '../probe.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = 'a'.repeat(64);
const WIRE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../host-mcp/src/__tests__/fixtures/status-wire.json'), 'utf8')) as Record<string, unknown>;
const wasm = (): Uint8Array => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

interface Fake {
  win: BootWindow;
  /** Every request the page made to its own origin. */
  requests: { path: string; headers: Headers }[];
  replaced: unknown[][];
  stored: Map<string, string>;
}

/** A window at `url`, whose own origin answers through `serve` (default: nothing is listening). */
function windowAt(url: string, serve?: (path: string, init?: RequestInit) => Response | Promise<Response>, stored: Record<string, string> = {}): Fake {
  const parsed = new URL(url);
  const requests: Fake['requests'] = [];
  const replaced: unknown[][] = [];
  const session = new Map(Object.entries(stored));
  const win: BootWindow = {
    location: { protocol: parsed.protocol, hostname: parsed.hostname, pathname: parsed.pathname, hash: parsed.hash, search: parsed.search, href: parsed.href },
    history: { state: null, replaceState: (...args: unknown[]) => void replaced.push(args) },
    fetch: async (input, init) => {
      requests.push({ path: input, headers: new Headers(init?.headers) });
      if (serve === undefined) throw new TypeError('Failed to fetch');
      return serve(input, init);
    },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => void session.set(key, value),
      removeItem: (key: string) => void session.delete(key),
    } as Storage,
  };
  return { win, requests, replaced, stored: session };
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const refusal = (status: number): Response => new Response('', { status, headers: { [RUNNER_MARKER_HEADER]: '1' } });
/** A runner: the wire fixture for the right bearer, its marked 401 for anything else. */
const runner = (status: Record<string, unknown> = WIRE) => (path: string, init?: RequestInit): Response =>
  path === '/status' && new Headers(init?.headers).get('authorization') === `Bearer ${TOKEN}` ? json(status) : refusal(401);

// ---------------------------------------------------------------- the runner's one origin

describe('isRunnerOrigin — literals, not "a loopback host"', () => {
  it('only http://127.0.0.1', () => {
    expect(isRunnerOrigin({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    for (const [protocol, hostname] of [
      ['http:', 'localhost'],
      ['http:', 'snug.localhost'],
      ['http:', '[::1]'],
      ['http:', '0.0.0.0'],
      ['http:', '127.0.0.5'],
      ['http:', '192.168.1.20'],
      ['http:', '10.0.0.4'],
      ['https:', '127.0.0.1'],
      ['file:', ''],
      ['about:', ''],
      ['https:', 'x.frame.claudeusercontent.com'],
    ] as const) {
      expect(isRunnerOrigin({ protocol, hostname }), `${protocol}//${hostname}`).toBe(false);
    }
  });
});

describe('askRunner — never asks, and never claims a token, anywhere but the runner’s origin', () => {
  it.each([
    'http://localhost:43127/',
    'http://snug.localhost:43127/',
    'http://[::1]:43127/',
    'http://0.0.0.0:43127/',
    'http://127.0.0.5:43127/',
    'http://192.168.1.20:43127/',
    'http://10.0.0.4:43127/',
    'https://127.0.0.1:43127/',
    'file:///Users/someone/snug-host.html',
  ])('%s', async (origin) => {
    // The address carries what LOOKS like a launch token, and a server that would answer as
    // a runner: neither may be touched. A fragment offered as a bearer to whatever serves
    // `localhost` today is a credential handed to a hosts-file entry.
    const fake = windowAt(`${origin}#token=${TOKEN}`, runner());
    expect(await askRunner(fake.win)).toEqual({ kind: 'none' });
    expect(fake.requests, 'no /status request').toEqual([]);
    expect(fake.replaced, 'the fragment is not stripped — nothing claimed it').toEqual([]);
    expect([...fake.stored.keys()], 'nothing is remembered').toEqual([]);
  });
});

describe('askRunner at http://127.0.0.1 — one bounded GET of /status', () => {
  it('claims the token from the fragment, strips it from the address bar, and sends it as the bearer — ONCE', async () => {
    const fake = windowAt(`http://127.0.0.1:43127/#token=${TOKEN}`, runner());
    const answer = await askRunner(fake.win);
    expect(answer).toMatchObject({ kind: 'runner', token: TOKEN, status: { binding: 'local-host', port: 43127, oauthRedirect: true } });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.path).toBe('/status');
    expect(fake.requests[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(fake.replaced).toEqual([[null, '', '/#/']]);
    expect(fake.stored.get('snug-host-token')).toBe(TOKEN);
  });

  it('a reload: the token remembered for this tab is the bearer', async () => {
    const fake = windowAt('http://127.0.0.1:43127/#/settings', runner(), { 'snug-host-token': TOKEN });
    expect((await askRunner(fake.win)).kind).toBe('runner');
    expect(fake.replaced, 'a route is not a token: nothing to strip').toEqual([]);
  });

  it('no token held: the request carries NO authorization header, and the runner’s marked 401 → "open it from your agent"', async () => {
    const fake = windowAt('http://127.0.0.1:43127/', runner());
    expect(await askRunner(fake.win)).toEqual({ kind: 'refused' });
    expect(fake.requests[0]!.headers.has('authorization')).toBe(false);
  });

  it('a stale token (the runner restarted): its marked 401 is the same refusal', async () => {
    const fake = windowAt('http://127.0.0.1:43127/', runner(), { 'snug-host-token': 'b'.repeat(64) });
    expect(await askRunner(fake.win)).toEqual({ kind: 'refused' });
  });

  it('a marked 403 is a refusal too (a foreign Origin, a wrong Host)', async () => {
    expect(await askRunner(windowAt('http://127.0.0.1:43127/', () => refusal(403)).win)).toEqual({ kind: 'refused' });
  });

  it.each([
    ['a 404 — a static server has no /status', () => new Response('not served: /status', { status: 404 })],
    ['a 401 WITHOUT the marker — somebody else’s server', () => new Response('', { status: 401 })],
    ['a 403 WITHOUT the marker', () => new Response('', { status: 403 })],
    ['a marker on a status that is not a refusal', () => refusal(500)],
    ['a 200 that is not JSON (an SPA fallback serving index.html)', () => new Response('<!doctype html><title>dev server</title>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['a 200 whose JSON is not a runner’s status', () => json({ status: 'ok' })],
    ['a 200 naming another binding', () => json({ ...WIRE, binding: 'artifact' })],
    ['a redirect', () => new Response('', { status: 302, headers: { location: '/login' } })],
  ])('%s → NOT a runner', async (_label, serve) => {
    const fake = windowAt(`http://127.0.0.1:43123/snug-host.html#token=${TOKEN}`, serve);
    expect(await askRunner(fake.win)).toEqual({ kind: 'none' });
    expect(fake.requests).toHaveLength(1);
  });

  it('nothing listening → not a runner', async () => {
    expect(await askRunner(windowAt('http://127.0.0.1:43127/').win)).toEqual({ kind: 'none' });
  });

  it('an origin that never answers → not a runner, INSIDE the bound', async () => {
    let aborted = false;
    const fake = windowAt(
      'http://127.0.0.1:43127/',
      (_path, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const began = Date.now();
    expect(await askRunner(fake.win, { boundMs: 40 })).toEqual({ kind: 'none' });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(aborted, 'the request is abandoned, not left open behind the page').toBe(true);
    expect(RUNNER_STATUS_BOUND_MS).toBe(1_500);
  });

  it('a 200 with the runner’s shape but NO bearer held is not believed — a runner never answers that', async () => {
    const fake = windowAt('http://127.0.0.1:43127/', () => json(WIRE));
    expect(await askRunner(fake.win)).toEqual({ kind: 'none' });
  });

  it('works where sessionStorage THROWS on read (an opaque or storage-denied page): this load still claims the token', async () => {
    const fake = windowAt(`http://127.0.0.1:43127/#token=${TOKEN}`, runner());
    Object.defineProperty(fake.win, 'sessionStorage', {
      get(): never {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect((await askRunner(fake.win)).kind).toBe('runner');
  });
});

// ------------------------------------------------------------------------- the plan

const STAMP = '0.1.0 abcdef1';
const KIT = `<!doctype html>\n<html><head><meta name="snug-host-build" content="${STAMP}" /><script type="module">/* kit */</script></head><body><div id="root"></div>\n</body></html>\n`;
const LINEAGE = '0f5e1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const BUNDLE = { format: 'snug-app-bundle/1', lineage: LINEAGE, sharedAt: '2026-09-05T00:00:00.000Z', app: { displayName: 'Pomodoro', usesDb: false }, html: '<!doctype html><html><body>v1</body></html>', connections: [] };

/** A page that carries BOTH an embedded bundle and a `snug-db` block — an artifact page, with every read counted. */
function documentWithBlocks(): { doc: ComposeDocument; reads: string[] } {
  const withBundle = upsertBundleBlock(KIT, LINEAGE, JSON.stringify(BUNDLE));
  const page = writeDbBlock(withBundle, { manifest: { format: DB_BLOCK_FORMAT, bytes: 3, sha256: 'a'.repeat(64), saved: 2, savedAt: 'x' }, base64: 'AQID' });
  const db = /<script type="text\/plain" id="snug-db">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? null;
  const bundles = [...page.matchAll(/<script type="application\/snug-app-bundle\+json" data-lineage="([^"]+)">([\s\S]*?)<\/script>/g)];
  expect(db, 'the fixture really carries a db block').not.toBeNull();
  expect(bundles, 'the fixture really carries a bundle block').toHaveLength(1);
  const reads: string[] = [];
  return {
    reads,
    doc: {
      querySelector: (selector) => {
        reads.push(`querySelector ${selector}`);
        return selector.includes('snug-host-build') ? { getAttribute: () => STAMP } : null;
      },
      getElementById: (id) => {
        reads.push(`getElementById ${id}`);
        return id === 'snug-db' && db !== null ? { textContent: db } : null;
      },
      querySelectorAll: (selector) => {
        reads.push(`querySelectorAll ${selector}`);
        return bundles.map((m) => ({ getAttribute: (n: string) => (n === 'data-lineage' ? m[1]! : null), textContent: m[2]! }));
      },
    },
  };
}

const emptyDoc: ComposeDocument = { querySelector: () => null, getElementById: () => null, querySelectorAll: () => [] };

/** The probe, stood in for: what a real one answers for this window (memory, the demo brain). */
const probeStub = () => {
  const probe = vi.fn(async (win: Parameters<typeof readBindingEnv>[0]): Promise<ProbeResult> => ({
    binding: decideBinding(readBindingEnv(win)),
    // The rung a loopback page gets in a real browser (OPFS/IndexedDB), over memory bytes.
    storage: { backend: { ...createMemoryBackend(), kind: 'idb' }, kind: 'idb' },
    brain: { brain: { kind: 'demo' }, legs: { sample: 'absent', complete: 'absent', local: 'absent' } },
  }));
  return probe;
};

const fakeClient = (): LocalClient => ({
  fetchImpl: async () => new Response('ok'),
  fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
  events: () => () => {},
  reportHandIn: async () => {},
  recheckBrain: async () => {},
  stopped: { get: () => false, subscribe: () => () => {} },
});

describe('planBoot — the order', () => {
  it('(1) /oauth/callback is decided FIRST: no token claim, no /status, no probe, no document read', async () => {
    // At the runner's own origin, with a token in the fragment and a runner that would
    // answer: the callback document must still do none of it.
    const fake = windowAt(`http://127.0.0.1:43127${OAUTH_CALLBACK_PATH}?code=abc&state=xyz#token=${TOKEN}`, runner());
    const probe = probeStub();
    const { doc, reads } = documentWithBlocks();
    expect(await planBoot(fake.win, doc, { probe, wasm })).toEqual({ kind: 'oauth-callback' });
    expect(fake.requests).toEqual([]);
    expect(fake.replaced).toEqual([]);
    expect([...fake.stored.keys()]).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
  });

  it('(1) …on any origin — the web playground’s own popup path is the same document', async () => {
    const fake = windowAt(`https://x.frame.claudeusercontent.com${OAUTH_CALLBACK_PATH}?code=abc&state=xyz`);
    expect((await planBoot(fake.win, emptyDoc, { probe: probeStub(), wasm })).kind).toBe('oauth-callback');
  });

  it('(1) only that exact path — the hub served at / is not a callback', async () => {
    const fake = windowAt('http://127.0.0.1:43127/oauth/callback/extra', () => new Response('', { status: 404 }));
    expect((await planBoot(fake.win, emptyDoc, { probe: probeStub(), wasm })).kind).toBe('hosted');
  });

  it('(2) a runner → the LOCAL composition: the runner’s file, the runner’s binding — and the probe never runs', async () => {
    const fake = windowAt(`http://127.0.0.1:43127/#token=${TOKEN}`, runner());
    const probe = probeStub();
    const createClient = vi.fn(fakeClient);
    const plan = await planBoot(fake.win, emptyDoc, { probe, wasm, createClient });
    expect(plan.kind).toBe('runner');
    if (plan.kind !== 'runner') return;
    expect(createClient).toHaveBeenCalledWith(TOKEN);
    expect(plan.composition.platform.binding).toBe('local-host');
    expect(plan.composition.platform.userdbBackend?.kind).toBe('file');
    expect(plan.composition.platform.capabilities.connections).toBe(true);
    expect(plan.composition.platform.capabilities.oauthRedirect).toBe(true);
    expect(plan.composition.platform.brain?.kind).toBe('host');
    expect(probe).not.toHaveBeenCalled();
  });

  it('(2) under the runner the page reads NO embedded bundle block and NO snug-db block (K6)', async () => {
    // The page the runner serves is the SAME file the artifact route hands in to. A copy
    // carrying blocks must not install them here, from a document, into the user's real file.
    const fake = windowAt(`http://127.0.0.1:43127/#token=${TOKEN}`, runner());
    const { doc, reads } = documentWithBlocks();
    const plan = await planBoot(fake.win, doc, { probe: probeStub(), wasm, createClient: fakeClient });
    expect(plan.kind).toBe('runner');
    expect(reads, 'the document is not read at all').toEqual([]);
    if (plan.kind !== 'runner') return;
    // No boot-time hand-in exists on this plan, and nothing is offered: what the file holds
    // is what the runner's file holds.
    expect(plan.composition.handIns.seat.pending.get()).toEqual([]);
    expect(plan.composition.platform.userdbBackend?.kind).toBe('file');
  });

  it('(2) the positive twin: the SAME document on the hosted path IS read — the blocks are real', async () => {
    const fake = windowAt('https://x.frame.claudeusercontent.com/');
    const { doc, reads } = documentWithBlocks();
    const probe = vi.fn(async (): Promise<ProbeResult> => ({
      binding: 'artifact',
      storage: { backend: createMemoryBackend(), kind: 'memory' },
      brain: { brain: { kind: 'demo' }, legs: { sample: 'null', complete: 'absent', local: 'absent' } },
      host: { legs: { sample: 'null', artifact: 'resolved', downloads: 'null' }, artifact: { publish: async () => ({ version: 'v' }) }, guardTripped: false, rejected: false },
    }));
    const plan = await planBoot(fake.win, doc, { probe, wasm });
    expect(plan.kind).toBe('hosted');
    expect(reads).toContain('getElementById snug-db');
  });

  it('(2) a runner whose file another product holds → the held refusal, naming the holder', async () => {
    const fake = windowAt(`http://127.0.0.1:43127/#token=${TOKEN}`, runner({ ...WIRE, heldBy: 'Snug for Mac' }));
    const plan = await planBoot(fake.win, emptyDoc, { probe: probeStub(), wasm, createClient: fakeClient });
    expect(plan).toMatchObject({ kind: 'refusal', refusal: { kind: 'held', heldBy: 'Snug for Mac' } });
  });

  it('(2) a runner that will not let the page in → "open it from your agent" — and the probe never runs', async () => {
    const fake = windowAt('http://127.0.0.1:43127/', runner());
    const probe = probeStub();
    expect(await planBoot(fake.win, emptyDoc, { probe, wasm })).toEqual({ kind: 'refusal', refusal: { kind: 'no-token' } });
    expect(probe).not.toHaveBeenCalled();
  });

  it('(3) a loopback STATIC server is file-class, and its custody copy says "in this browser" — not "on this Mac"', async () => {
    const fake = windowAt('http://127.0.0.1:43123/snug-host.html', () => new Response('not served: /status', { status: 404 }));
    const probe = probeStub();
    const plan = await planBoot(fake.win, emptyDoc, { probe, wasm });
    expect(plan.kind).toBe('hosted');
    if (plan.kind !== 'hosted') return;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(plan.composition.platform.binding).toBe('file');
    expect(plan.composition.platform.capabilities.connections).toBe(false);
    const copy = custodyDisclosure(plan.composition.platform.binding, plan.composition.platform.userdbBackend?.kind, plan.composition.custody.get());
    expect(copy.label).toBe('your file: in this browser');
    expect(copy.body).not.toMatch(/Snug\/user\.snug|on this Mac/);
  });

  it('(3) everywhere else the probe decides, and the page’s own origin is asked nothing', async () => {
    for (const url of ['https://x.frame.claudeusercontent.com/', 'file:///Users/someone/snug-host.html', 'http://localhost:5173/']) {
      const fake = windowAt(url, runner());
      const probe = probeStub();
      const plan = await planBoot(fake.win, emptyDoc, { probe, wasm });
      expect(plan.kind, url).toBe('hosted');
      expect(fake.requests, url).toEqual([]);
      expect(probe, url).toHaveBeenCalledTimes(1);
    }
  });
});

// ------------------------------------------------- what the runner pushes after boot

describe('followRunner — the runner’s events reach the UI’s signals, not DOM events (K4/K6)', () => {
  afterEach(() => {
    vi.resetModules();
  });

  /** A fresh graph: the page's user db is a singleton, and the signals are module state. */
  async function follow() {
    vi.resetModules();
    const helper = await import('@playground/__tests__/userdbTestHelper');
    const db = await helper.installTestUserDb();
    const signals = await import('@playground/platform/signals');
    const local = await import('../local/compose-local.js');
    const { followRunner } = await import('../boot.js');
    local.brainState.current = undefined;
    let push: (name: string, data: unknown) => void = () => undefined;
    const reports: unknown[] = [];
    const client: LocalClient = {
      ...fakeClient(),
      events: (onEvent) => {
        push = onEvent;
        return () => undefined;
      },
      reportHandIn: async (report) => void reports.push(report),
    };
    const composition = local.composeLocalPlatform(client, { binding: 'local-host', port: 43127, pages: 1 }, wasm(), createMemoryBackend(), TOKEN);
    followRunner(client, composition);
    return { db, signals, local, composition, reports, push: (name: string, data: unknown) => push(name, data) };
  }

  it('a late `status` moves the brain and bumps brainRevision', async () => {
    const f = await follow();
    const before = f.signals.brainRevisionStore.get();
    expect(f.composition.platform.brain?.kind).toBe('host');
    f.push('status', { brain: { state: 'absent' }, models: [] });
    expect(f.composition.platform.brain).toEqual({ kind: 'demo' });
    expect(f.signals.brainRevisionStore.get()).toBeGreaterThan(before);
    f.local.brainState.current = undefined;
  });

  it('a `hand-in` is APPLIED: the app is in the file, the note is on the custody store, the library revision is bumped, and the runner is told', async () => {
    const f = await follow();
    const before = f.signals.libraryRevisionStore.get();
    f.push('hand-in', { id: 'c'.repeat(32), bundle: BUNDLE });
    await vi.waitFor(() => expect(f.signals.libraryRevisionStore.get()).toBe(before + 1));
    expect(f.db.listApps().map((app) => app.displayName)).toEqual(['Pomodoro']);
    expect(f.composition.custody.get().note).toBe('installed by your agent: Pomodoro');
    expect(f.composition.platform.custody?.state.get().note).toBe('installed by your agent: Pomodoro');
    expect(f.reports).toEqual([{ id: 'c'.repeat(32), outcome: 'installed' }]);
  });

  it('a `hand-in` that fails in a way nobody foresaw is SAID on the custody chip — never an unhandled rejection', async () => {
    // Nothing awaits the applying (it runs off the event stream), so a rejection there had
    // no one to hear it: an unhandled rejection in the page, and a hand-in that went nowhere
    // without a word. A frame whose data is JSON `null` stands in for "nobody foresaw".
    const f = await follow();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      f.push('hand-in', null);
      await vi.waitFor(() => expect(f.composition.custody.get().note).toMatch(/^the handed-in app could not be applied: /));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
      expect(f.db.listApps()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('an event it does not know is ignored — a newer runner must not break an older page', async () => {
    const f = await follow();
    const before = [f.signals.brainRevisionStore.get(), f.signals.libraryRevisionStore.get()];
    f.push('brains', { anything: true });
    f.push('shutdown', {}); // the CLIENT's business (it never reaches this handler in the page)
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect([f.signals.brainRevisionStore.get(), f.signals.libraryRevisionStore.get()]).toEqual(before);
    expect(f.db.listApps()).toEqual([]);
  });
});

// ------------------------------------------------------------- the callback, rendered

describe('boot at /oauth/callback — the callback page ALONE', () => {
  const realUrl = window.location.href;
  let container: HTMLDivElement | undefined;

  afterEach(() => {
    container?.remove();
    container = undefined;
    window.history.replaceState(null, '', realUrl);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('delivers the code over BroadcastChannel and renders no hub — with no request, no token claim and no platform', async () => {
    vi.resetModules();
    const posted: { channel: string; message: unknown }[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor(private readonly name: string) {}
        postMessage(message: unknown): void {
          posted.push({ channel: this.name, message });
        }
        close(): void {}
      },
    );
    const fetchSpy = vi.fn(async () => json(WIRE));
    vi.stubGlobal('fetch', fetchSpy);
    vi.spyOn(window, 'close').mockImplementation(() => undefined);

    // A state as the wizard signs it: `<base64url(payload)>.<signature>`.
    const payload = Buffer.from(JSON.stringify({ appId: 'app-1', flowId: 'flow-9' })).toString('base64url');
    const state = `${payload}.signature`;
    window.history.replaceState(null, '', `${OAUTH_CALLBACK_PATH}?code=the-code&state=${state}#token=${TOKEN}`);

    container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);

    const platformModule = await import('@playground/platform/platform');
    const setPlatform = vi.spyOn(platformModule, 'setPlatform');
    const { boot } = await import('../boot.js');
    await act(async () => {
      await boot();
    });

    expect(posted).toEqual([{ channel: 'snug-oauth-flow-9', message: { appId: 'app-1', flowId: 'flow-9', code: 'the-code', state } }]);
    expect(container.textContent).toContain('sign-in complete');
    // The hub is not here: no shell, no shelf, no chips.
    expect(container.querySelector('.shell')).toBeNull();
    expect(container.querySelector('[data-testid="brain-chip"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(setPlatform).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('snug-host-token'), 'a fragment on the callback URL is nobody’s token').toBeNull();
    expect(window.location.hash, 'and it is not stripped — nothing claimed it').toBe(`#token=${TOKEN}`);
  });
});
