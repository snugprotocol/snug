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

/** One brain as the runner reports it (the `brains[]` wire — ADR-0071, B2). */
const claude = (state: string, detail?: string) => ({
  id: 'claude',
  name: 'Claude',
  via: 'your Claude Code CLI',
  state,
  ...(detail !== undefined ? { detail } : {}),
  verified: true,
  streaming: true,
  efforts: [],
  models: [],
});

describe('the probe’s verdict must survive a page that was not listening yet (D-B35)', () => {
  it('is READ from /status, not only pushed — the emit fires before any browser exists', async () => {
    // MEASURED: `runner.start()` kicks the probe off, and the page has not fetched
    // `/events` yet — the CLI answers in ~2 s but the emit can land in ZERO subscribers,
    // and a fire-and-forget event is then simply lost. The first version of this feature
    // relied on the push alone, so the chip silently kept its boot label forever.
    // `/status` already carries the brains, so a page that reads it on boot cannot miss.
    const { composeLocalPlatform } = await import('../local/compose-local.js');
    const client = {
      fetchImpl: async () => new Response('ok'),
      fs: { readFile: async () => undefined, writeFileAtomic: async () => {} },
      events: () => () => {},
      reportHandIn: async () => {},
      recheckBrain: async () => {},
      stopped: { get: () => false, subscribe: () => () => {} },
    } as never;

    // The boot status is what the page fetched BEFORE subscribing — it already knows.
    // MIGRATED 2026-10-03 (TASK-20261003 B2): the verdict rode `brain: { state }`; it rides
    // the brain's own entry in `brains[]` now. The claim is unchanged.
    const { platform } = composeLocalPlatform(
      client,
      { binding: 'local-host', port: 43127, pages: 1, brains: [claude('logged-out')] } as never,
      undefined,
      undefined,
      't',
    );
    // MIGRATED 2026-10-03 (TASK-20261003 D4): this read the remedy off the host brain's
    // label. What "the page already knows" MEANS changed: a CLI known to be logged out is no
    // longer pinned as the brain with a sentence on it — the demo brain is pinned, from the
    // very first paint, so no think is sent to a brain that cannot answer. The claim under
    // test is unchanged: the verdict in the boot read is honoured without any event.
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(platform.brainSwitch?.state.get().brains[0]?.state).toBe('logged-out');
  });
});

describe('the late-arrival path, driven directly (D-B35)', () => {
  it('a status event updates the SAME platform object — no second setPlatform', async () => {
    // The e2e cannot force this ordering: with a pinned state the verdict is already in the
    // boot `/status` read, so the SSE path never runs there (measured — that test passed
    // against a deliberately reintroduced crash and proved nothing about it). Here the
    // ordering is forced.
    const { applyRunnerStatus, composeLocalPlatform } = await import('../local/compose-local.js');
    const { brainRevisionStore } = await import('@playground/platform/signals');

    // Boot with NO brain yet: the probe is still running.
    const { platform } = composeLocalPlatform(
      { fetchImpl: async () => new Response('ok'), fs: { readFile: async () => undefined, writeFileAtomic: async () => {} }, events: () => () => {}, reportHandIn: async () => {}, recheckBrain: async () => {}, stopped: { get: () => false, subscribe: () => () => {} } } as never,
      { binding: 'local-host', port: 43127, pages: 1, brains: [] } as never,
      undefined,
      undefined,
      't',
    );
    const brainOf = (p: typeof platform): string | undefined => {
      const b = p.brain as { kind: string; label?: string } | undefined;
      return b?.kind === 'host' ? b.label : undefined;
    };
    // MIGRATED 2026-10-03 (R4, ADR-0071 §4): before any brain was reported the page pinned
    // the host arm on a guess ("Claude · your CLI"). It pins what the runner says a think
    // would run on, and until the probe answers that is nothing — the demo brain.
    expect(platform.brain).toEqual({ kind: 'demo' });

    // The verdict lands the way the boot's event handler lands it.
    // MIGRATED 2026-10-03 (D4, K4): it was a bare write to the holder followed by a DOM
    // `CustomEvent` nothing listened to, and the object then read a logged-out LABEL. It is
    // `applyRunnerStatus` now — the composition's sources, then the revision the UI
    // subscribes to.
    const before = brainRevisionStore.get();
    applyRunnerStatus({ active: 'claude', brains: [claude('ready')] });

    // THE POINT: the same object the page already handed to setPlatform now answers
    // differently. A recomposed platform could not be installed — setPlatform throws.
    expect(brainOf(platform)).toBe('Claude · your CLI');
    expect(brainRevisionStore.get(), 'and the readers are told').toBe(before + 1);

    // …and a verdict that the CLI cannot answer moves the SAME object back to the demo brain.
    applyRunnerStatus({ brains: [claude('logged-out', 'run `/login`')] });
    expect(platform.brain).toEqual({ kind: 'demo' });
    expect(brainRevisionStore.get()).toBe(before + 2);
  });
});
