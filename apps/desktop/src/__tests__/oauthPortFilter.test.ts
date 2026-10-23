// The loopback listener's PORT FILTER (TASK-20261023-siwc-chatgpt-plan D10; Gate-2 blocker F2/S9).
//
// tauri-plugin-oauth emits EVERY callback on ONE global event, `oauth://url`. Until this task
// there was one listener; now the connection wizard and the ChatGPT-plan sign-in each own a
// `createDesktopOAuthTransport`, so two `createTauriLoopbackListener`s subscribe to the same
// event. Unfiltered, a ChatGPT callback would be fed to the wizard's transport (and the reverse)
// — each transport's one-shot discipline would then tear its own listener down on a callback
// that was never its own. The rule: a listener delivers ONLY payloads whose URL port is the port
// the plugin reported for THAT listener's `start()`, and it subscribes only once that port is
// known.
//
// The plugin is faked at the two Tauri seams oauth.ts uses (`invoke`, `listen`); the subject is
// the REAL `createTauriLoopbackListener`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: { payload: string }) => void>>();
  const state = {
    handlers,
    /** Ports `plugin:oauth|start` answers for ephemeral starts, in order. */
    ephemeral: [] as number[],
    /** When set, `plugin:oauth|start` waits on this before answering. */
    gate: null as Promise<void> | null,
    cancelled: [] as number[],
  };
  return {
    state,
    listen: vi.fn(async (event: string, handler: (e: { payload: string }) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => {
        set.delete(handler);
      };
    }),
    invoke: vi.fn(async (cmd: string, args?: { config?: { ports?: number[] }; port?: number }) => {
      if (cmd === 'plugin:oauth|start') {
        if (state.gate !== null) await state.gate;
        const fixed = args?.config?.ports?.[0];
        return fixed ?? state.ephemeral.shift();
      }
      if (cmd === 'plugin:oauth|cancel') {
        state.cancelled.push(args!.port!);
        return undefined;
      }
      throw new Error(`unexpected invoke ${cmd}`);
    }),
  };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => undefined) }));

const { createTauriLoopbackListener } = await import('../oauth.js');

/** What the plugin does on a request: emit the full URL on the one global event. */
function emit(url: string): void {
  for (const h of [...(tauri.state.handlers.get('oauth://url') ?? [])]) h({ payload: url });
}

const subscribers = (): number => tauri.state.handlers.get('oauth://url')?.size ?? 0;

beforeEach(() => {
  tauri.state.handlers.clear();
  tauri.state.ephemeral = [];
  tauri.state.gate = null;
  tauri.state.cancelled = [];
  tauri.listen.mockClear();
  tauri.invoke.mockClear();
});

describe('a single listener (today’s behaviour, plus the filter on a restart)', () => {
  it('delivers a callback for its own port exactly once, with the URL verbatim', async () => {
    tauri.state.ephemeral = [51001];
    const seen: string[] = [];
    const handle = await createTauriLoopbackListener((u) => seen.push(u)).start({});
    expect(handle.port).toBe(51001);

    const url = 'http://127.0.0.1:51001/callback?code=abc&state=xyz';
    emit(url);
    expect(seen).toEqual([url]);
  });

  it('a fixed-port start asks the plugin for that port and filters on it', async () => {
    const seen: string[] = [];
    const handle = await createTauriLoopbackListener((u) => seen.push(u)).start({ fixedPort: 41420 });
    expect(tauri.invoke).toHaveBeenCalledWith('plugin:oauth|start', expect.objectContaining({ config: expect.objectContaining({ ports: [41420] }) }));
    expect(handle.port).toBe(41420);
    emit('http://127.0.0.1:41420/callback?code=a&state=b');
    expect(seen).toHaveLength(1);
  });

  it('stop unsubscribes and cancels the plugin server on its own port', async () => {
    tauri.state.ephemeral = [51002];
    const seen: string[] = [];
    const handle = await createTauriLoopbackListener((u) => seen.push(u)).start({});
    await handle.stop();
    expect(tauri.state.cancelled).toEqual([51002]);
    expect(subscribers()).toBe(0);
    emit('http://127.0.0.1:51002/callback?code=late&state=s');
    expect(seen, 'a stopped listener delivers nothing').toEqual([]);
  });

  it('a restart re-subscribes on the NEW port; the old port no longer delivers', async () => {
    tauri.state.ephemeral = [51003, 51004];
    const seen: string[] = [];
    const listener = createTauriLoopbackListener((u) => seen.push(u));
    await listener.start({});
    await listener.start({});
    expect(subscribers(), 'one live subscription per listener').toBe(1);

    emit('http://127.0.0.1:51003/callback?code=old&state=s');
    emit('http://127.0.0.1:51004/callback?code=new&state=s');
    expect(seen).toEqual(['http://127.0.0.1:51004/callback?code=new&state=s']);
  });
});

describe('two listeners on the one global event (the wizard’s and the ChatGPT plan’s)', () => {
  it('a payload for B’s port reaches ONLY B', async () => {
    tauri.state.ephemeral = [49152];
    const a: string[] = [];
    const b: string[] = [];
    await createTauriLoopbackListener((u) => a.push(u)).start({ fixedPort: 41420 });
    await createTauriLoopbackListener((u) => b.push(u)).start({});

    const forB = 'http://127.0.0.1:49152/auth/callback?code=chatgpt-code&state=s';
    emit(forB);
    expect(b).toEqual([forB]);
    expect(a, 'the wizard’s listener must never see the ChatGPT callback').toEqual([]);
  });

  it('a payload for A’s port reaches ONLY A', async () => {
    tauri.state.ephemeral = [49152];
    const a: string[] = [];
    const b: string[] = [];
    await createTauriLoopbackListener((u) => a.push(u)).start({ fixedPort: 41420 });
    await createTauriLoopbackListener((u) => b.push(u)).start({});

    const forA = 'http://127.0.0.1:41420/callback?code=spotify-code&state=s';
    emit(forA);
    expect(a).toEqual([forA]);
    expect(b).toEqual([]);
  });

  it('a payload for a port NEITHER owns fires neither', async () => {
    tauri.state.ephemeral = [49152];
    const a: string[] = [];
    const b: string[] = [];
    await createTauriLoopbackListener((u) => a.push(u)).start({ fixedPort: 41420 });
    await createTauriLoopbackListener((u) => b.push(u)).start({});

    emit('http://127.0.0.1:50000/auth/callback?code=stray&state=s');
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });

  it('stopping one listener leaves the other delivering', async () => {
    tauri.state.ephemeral = [49152];
    const a: string[] = [];
    const b: string[] = [];
    const ha = await createTauriLoopbackListener((u) => a.push(u)).start({ fixedPort: 41420 });
    await createTauriLoopbackListener((u) => b.push(u)).start({});
    await ha.stop();

    emit('http://127.0.0.1:49152/auth/callback?code=c&state=s');
    expect(b).toHaveLength(1);
    expect(tauri.state.cancelled).toEqual([41420]);
  });

  it('a payload that is not a URL reaches no one (no port to match)', async () => {
    tauri.state.ephemeral = [49152];
    const b: string[] = [];
    await createTauriLoopbackListener((u) => b.push(u)).start({});
    emit('not a url :49152');
    emit('');
    expect(b).toEqual([]);
  });
});

describe('subscription happens AFTER the plugin reports the bound port', () => {
  it('a payload arriving while start is still pending is not delivered to it', async () => {
    let release!: () => void;
    tauri.state.gate = new Promise<void>((r) => {
      release = r;
    });
    tauri.state.ephemeral = [49152];
    const seen: string[] = [];
    const starting = createTauriLoopbackListener((u) => seen.push(u)).start({});

    // Let the start get as far as it can before the plugin answers.
    await Promise.resolve();
    await Promise.resolve();
    expect(tauri.listen, 'no subscription before the port is known').not.toHaveBeenCalled();
    emit('http://127.0.0.1:49152/auth/callback?code=early&state=s');

    release();
    const handle = await starting;
    expect(handle.port).toBe(49152);
    expect(seen, 'the pre-bind payload was never this listener’s to take').toEqual([]);

    emit('http://127.0.0.1:49152/auth/callback?code=on-time&state=s');
    expect(seen).toEqual(['http://127.0.0.1:49152/auth/callback?code=on-time&state=s']);
  });

  it('subscribes to the plugin’s one event name, oauth://url', async () => {
    tauri.state.ephemeral = [49152];
    await createTauriLoopbackListener(() => undefined).start({});
    expect(tauri.listen).toHaveBeenCalledTimes(1);
    expect(tauri.listen.mock.calls[0]![0]).toBe('oauth://url');
  });
});
