// The on-demand starter source (TASK-20260905-host-kit AC14, A3): cards from inline
// metadata, each starter's bundle loaded on click from the content-pinned package through
// ONE `<script>` element with SRI, a registration protocol, and a NAMED failure — never a
// hang. The fixture index has two starters; a hostile payload (html carrying `</script>`
// and `<!--`) must come back byte-identical, because the wrapper is a script, not markup.
import { describe, expect, it, vi } from 'vitest';

import {
  STARTER_LOAD_REFUSAL,
  STARTER_REGISTER_GLOBAL,
  StarterLoadError,
  createStarterSource,
  starterScriptUrl,
  type StarterPayload,
  type StartersIndex,
} from '../starterLoader.js';

import fixture from './fixtures/starters-index.json';

const index = fixture as StartersIndex;

interface FakeScript {
  src: string;
  integrity: string;
  crossOrigin: string | null;
  async: boolean;
  onerror: null | ((e: unknown) => void);
  onload: null | (() => void);
  removed: boolean;
}

function harness(over: { timeoutMs?: number } = {}) {
  const scripts: FakeScript[] = [];
  const registry: Record<string, unknown> = {};
  const host = {
    createScript: (): FakeScript => ({ src: '', integrity: '', crossOrigin: null, async: false, onerror: null, onload: null, removed: false }),
    attach: (s: FakeScript) => {
      scripts.push(s);
    },
    detach: (s: FakeScript) => {
      s.removed = true;
    },
  };
  const source = createStarterSource(index, {
    scripts: host as never,
    registry,
    timeoutMs: over.timeoutMs ?? 20_000,
  });
  const register = (payload: unknown): void => {
    (registry[STARTER_REGISTER_GLOBAL] as (p: unknown) => void)(payload);
  };
  const payload = (folder: string, html = `<h1>${folder}</h1>`): StarterPayload => ({
    format: 'snug-starter/1',
    folder,
    version: index.version,
    html,
    authoring: { docs: { 'vision.md': `# ${folder}` }, prompts: { '01-build.md': 'build it' } },
  });
  return { scripts, registry, source, register, payload };
}

describe('the catalogue and the inline metadata (first paint, no network)', () => {
  it('appFolders() lists the index, sorted, synchronously', () => {
    const { source } = harness();
    expect(source.appFolders()).toEqual(['chess', 'weather']);
  });
  it('meta/contract/manifest come from the index and never append a script', async () => {
    const { source, scripts } = harness();
    expect(JSON.parse((await source.meta('chess'))!)).toMatchObject({ version: 2 });
    expect(await source.contract('chess')).toContain('snug-runtime-contract/1');
    expect(await source.manifest('chess')).toBeUndefined();
    expect(await source.manifest('weather')).toContain('"weather"');
    expect(await source.meta('weather')).toBeUndefined();
    expect(scripts).toHaveLength(0);
  });
  it('an unknown folder resolves undefined everywhere, and html() rejects by name', async () => {
    const { source } = harness();
    expect(await source.meta('nope')).toBeUndefined();
    await expect(source.html('nope')).rejects.toMatchObject({ reason: 'unknown_starter' });
  });
});

describe('the loader — one pinned script element per starter', () => {
  it('starterScriptUrl pins the exact package version and file on jsDelivr /npm/', () => {
    expect(starterScriptUrl(index, 'chess')).toBe('https://cdn.jsdelivr.net/npm/@snugprotocol/starters@0.1.0-fixture/chess.js');
  });

  it('html() appends exactly one script with src, sha384 integrity and crossorigin=anonymous', async () => {
    const { source, scripts, register, payload } = harness();
    const pending = source.html('chess');
    expect(scripts).toHaveLength(1);
    const s = scripts[0]!;
    expect(s.src).toBe(starterScriptUrl(index, 'chess'));
    expect(s.integrity).toBe(`sha384-${index.starters.chess!.sha384}`);
    expect(s.crossOrigin).toBe('anonymous');
    register(payload('chess'));
    expect(await pending).toBe('<h1>chess</h1>');
  });

  it('the registration protocol: a hostile html (`</script>` + `<!--`) comes back byte-identical', async () => {
    const hostile = '<script>alert(1)</script><!-- c --> </script >   end';
    const { source, register, payload } = harness();
    const pending = source.html('chess');
    register(payload('chess', hostile));
    expect(await pending).toBe(hostile);
  });

  it('concurrent asks for one starter share one script; a second starter gets its own', async () => {
    const { source, scripts, register, payload } = harness();
    const a = source.html('chess');
    const b = source.html('chess');
    const c = source.contract('chess'); // inline — no script
    const w = source.html('weather');
    expect(scripts).toHaveLength(2);
    register(payload('chess'));
    register(payload('weather'));
    expect(await a).toBe('<h1>chess</h1>');
    expect(await b).toBe('<h1>chess</h1>');
    expect(await c).toContain('snug-runtime-contract');
    expect(await w).toBe('<h1>weather</h1>');
    // Loaded once: a later ask appends nothing.
    await source.html('chess');
    expect(scripts).toHaveLength(2);
  });

  it('authoring() is the bundles of the starters loaded so far — the one just installed is among them', async () => {
    const { source, register, payload } = harness();
    expect(await source.authoring()).toEqual({});
    const pending = source.html('chess');
    register(payload('chess'));
    await pending;
    expect(await source.authoring()).toEqual({
      chess: { docs: { 'vision.md': '# chess' }, prompts: { '01-build.md': 'build it' } },
    });
  });

  it('a script error rejects with the NAMED refusal (offline copy), removes the element, and a retry appends a fresh one', async () => {
    const { source, scripts } = harness();
    const first = source.html('chess');
    scripts[0]!.onerror?.(new Event('error'));
    await expect(first).rejects.toBeInstanceOf(StarterLoadError);
    await expect(first).rejects.toMatchObject({ reason: 'load_failed', message: STARTER_LOAD_REFUSAL });
    expect(STARTER_LOAD_REFUSAL).toMatch(/^starters load from the network/);
    expect(scripts[0]!.removed).toBe(true);
    const second = source.html('chess');
    expect(scripts).toHaveLength(2);
    void second.catch(() => undefined);
  });

  it('a script that loads but never registers times out by name — never a hang', async () => {
    vi.useFakeTimers();
    try {
      const { source, scripts } = harness({ timeoutMs: 1000 });
      const pending = source.html('chess');
      scripts[0]!.onload?.();
      const settled = pending.then(
        () => 'resolved',
        (e: unknown) => e,
      );
      await vi.advanceTimersByTimeAsync(1001);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(StarterLoadError);
      expect((outcome as StarterLoadError).reason).toBe('timeout');
      expect(scripts[0]!.removed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a payload of the wrong shape (or wrong format literal) is refused by name; a payload nobody asked for is ignored', async () => {
    const { source, register, payload } = harness();
    const pending = source.html('chess');
    register({ folder: 'chess', html: 'x' }); // no format
    await expect(pending).rejects.toMatchObject({ reason: 'bad_payload' });
    // `authoring: null` must settle as bad_payload too — never throw inside the hook.
    const again = source.html('chess');
    expect(() => register({ ...payload('chess'), authoring: null })).not.toThrow();
    await expect(again).rejects.toMatchObject({ reason: 'bad_payload' });
    expect(() => register(payload('weather'))).not.toThrow(); // unsolicited — dropped
    expect(await source.authoring()).toEqual({});
  });

  it('a payload from another package VERSION is refused — the pin is the contract', async () => {
    const { source, register, payload } = harness();
    const pending = source.html('chess');
    register({ ...payload('chess'), version: '9.9.9' });
    await expect(pending).rejects.toMatchObject({ reason: 'bad_payload' });
  });

  it('installs the registry hook once and keeps it across sources on the same page', () => {
    const { registry } = harness();
    const hook = registry[STARTER_REGISTER_GLOBAL];
    expect(typeof hook).toBe('function');
    createStarterSource(index, { scripts: { createScript: () => ({}), attach() {}, detach() {} } as never, registry, timeoutMs: 1 });
    expect(registry[STARTER_REGISTER_GLOBAL]).toBe(hook);
  });
});

describe('the aliased module — what the playground actually imports in the kit build', () => {
  it('starterSource() reads the virtual index and lists the fixture starters', async () => {
    const mod = await import('../starterSource.js');
    expect(mod.starterSource().appFolders()).toEqual(['chess', 'weather']);
    expect(mod.starterSource()).toBe(mod.starterSource());
  });
});
