// The brain probe's late answer (D-B35), at the seam where it is APPLIED.
//
// WHY THIS FILE EXISTS. `composeLocal.test.ts` proves the chip's LABEL is computed from a
// brain state. It cannot prove the page may apply that state, because it never touches the
// platform singleton — and the first attempt did it by recomposing and calling
// `setPlatform` again, which throws by design: the platform is set once, before boot, and
// `setPlatform` refuses both a second call and any call after `getPlatform` has been read
// (`platform/platform.ts:432-439`). A page that did that would crash the moment the probe
// answered — the one path this whole decision exists to make better.

import { describe, expect, it } from 'vitest';

import { setPlatform, getPlatform } from '@playground/platform/platform';

describe('the platform singleton refuses mid-session swaps', () => {
  it('throws on a second setPlatform — so a late probe must NOT recompose', () => {
    const platform = { kind: 'host', binding: 'local-host', capabilities: {} } as never;
    setPlatform(platform);
    getPlatform();
    expect(() => setPlatform(platform)).toThrow(/set once|already read/i);
  });
});

describe('the probe’s verdict must survive a page that was not listening yet (D-B35)', () => {
  it('is READ from /status, not only pushed — the emit fires before any browser exists', async () => {
    // MEASURED: `runner.start()` kicks the probe off, and the page has not fetched
    // `/events` yet — the CLI answers in ~2 s but the emit can land in ZERO subscribers,
    // and a fire-and-forget event is then simply lost. The first version of this feature
    // relied on the push alone, so the chip silently kept its boot label forever.
    // `/status` already carries `brain`, so a page that reads it on boot cannot miss.
    const { composeLocalPlatform, brainState } = await import('../local/compose-local.js');
    brainState.current = undefined;
    const client = {
      fetchImpl: async () => new Response('ok'),
      fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
      status: async () => ({ binding: 'local-host', port: 43127, pages: 1, brain: { state: 'logged-out' } }),
      events: () => () => {},
    } as never;

    // The boot status is what the page fetched BEFORE subscribing — it already knows.
    const { platform } = composeLocalPlatform(
      client,
      { binding: 'local-host', port: 43127, pages: 1, brain: { state: 'logged-out' } } as never,
      undefined,
      undefined,
      't',
    );
    const brain = platform.brain as { kind: string; label?: string } | undefined;
    expect(brain?.kind === 'host' ? brain.label : undefined).toMatch(/log/i);
  });
});

describe('the late-arrival path, driven directly (D-B35)', () => {
  it('a status event updates the SAME platform object — no second setPlatform', async () => {
    // The e2e cannot force this ordering: with a pinned state the verdict is already in the
    // boot `/status` read, so the SSE path never runs there (measured — that test passed
    // against a deliberately reintroduced crash and proved nothing about it). Here the
    // ordering is forced.
    const { composeLocalPlatform, brainState } = await import('../local/compose-local.js');
    brainState.current = undefined;

    // Boot with NO brain yet: the probe is still running.
    const { platform } = composeLocalPlatform(
      { fetchImpl: async () => new Response('ok'), fs: { readFile: async () => undefined, writeFileAtomic: async () => {} }, status: async () => ({}), events: () => () => {} } as never,
      { binding: 'local-host', port: 43127, pages: 1 } as never,
      undefined,
      undefined,
      't',
    );
    const brainOf = (p: typeof platform): string | undefined => {
      const b = p.brain as { kind: string; label?: string } | undefined;
      return b?.kind === 'host' ? b.label : undefined;
    };
    expect(brainOf(platform)).toBe('Claude · your CLI');

    // The verdict lands the way `main.tsx`'s status handler lands it.
    brainState.current = { state: 'logged-out', detail: 'run `/login`' };

    // THE POINT: the same object the page already handed to setPlatform now reads the new
    // label. A recomposed platform could not be installed — setPlatform throws.
    expect(brainOf(platform)).toMatch(/log/i);
    brainState.current = undefined;
  });
});
