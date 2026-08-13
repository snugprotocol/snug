// The desktop platform's OAuth seam (TASK-20260812 whole-surface review, finding A —
// platform half). `pendingFlow` is the memory that bridges `redirectUriFor` (register
// screen AND the service's provider) and `openExternal` (where fixed-port binds). It
// must NEVER survive into a different provider/posture, and it must never outlive the
// transport's own recorded URI — a stale `bound: true` against a cleared `recorded`
// wedged `redirectUriProvider.redirectUri` into throwing forever with no reachable reset.
//
// Tauri is absent in vitest, so the shell modules this file composes are mocked at their
// own seams (oauth.ts / fs.ts / plugin-http): the subject is platform-desktop.ts's
// pendingFlow machinery, driven against the REAL transport core from packages/auth.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_FLOW_TTL_MS, SNUG_DESKTOP_OAUTH_PORT } from '@snugprotocol/auth';

/** Ports the fake listener hands out for ephemeral binds, in order. */
const ephemeralPorts = [51001, 51002, 51003];
let ephemeralIndex = 0;
let liveListeners = 0;
let startCalls: Array<{ fixedPort?: number }> = [];
let openedUrls: string[] = [];

/** The transport's own callback sink, captured so a test can drive TTL expiry through it. */
let feedCallbackUrl: ((url: string) => void) | null = null;

vi.mock('../oauth.js', () => ({
  createTauriLoopbackListener: (onCallbackUrl: (url: string) => void) => ({
    async start(opts: { fixedPort?: number }) {
      feedCallbackUrl = onCallbackUrl;
      startCalls.push(opts);
      liveListeners += 1;
      const port = opts.fixedPort ?? ephemeralPorts[ephemeralIndex++ % ephemeralPorts.length]!;
      return {
        port,
        stop: async () => {
          liveListeners -= 1;
        },
      };
    },
  }),
  openInSystemBrowser: async (url: string) => {
    openedUrls.push(url);
  },
}));

vi.mock('../fs.js', () => ({
  createTauriFileFs: () => ({
    readFile: async () => undefined,
    writeFileAtomic: async () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => new ArrayBuffer(0)) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn(async () => new Response('{}')) }));

const { createDesktopPlatform } = await import('../platform-desktop.js');

beforeEach(() => {
  ephemeralIndex = 0;
  liveListeners = 0;
  startCalls = [];
  openedUrls = [];
});

describe('pendingFlow never leaks a stale URI across sessions', () => {
  it('a DIFFERENT provider after an abandoned ephemeral flow gets a fresh binding, not the old URI', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    // Session 1: the register screen for an ephemeral-loopback provider — binds.
    const first = await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    expect(first).toBe(`http://127.0.0.1:${ephemeralPorts[0]}/callback`);

    // The user closes the wizard WITHOUT signing in. The wizard's teardown cancels.
    await oauth.cancel();

    // Session 2: a FIXED-PORT provider (Spotify-class). The register screen must show
    // the registered constant, or the entire fixed-port contract is defeated.
    const second = await oauth.redirectUriFor({ provider: 'Spotify', posture: 'loopback-fixed-port' });
    expect(second).toBe(`http://127.0.0.1:${SNUG_DESKTOP_OAUTH_PORT}/callback`);
  });

  it('a different provider WITHOUT an intervening cancel still gets its own URI', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    const first = await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    expect(first).toBe(`http://127.0.0.1:${ephemeralPorts[0]}/callback`);

    // No cancel — the wizard was force-closed on a path that (pre-fix) skipped it.
    const second = await oauth.redirectUriFor({ provider: 'Spotify', posture: 'loopback-fixed-port' });
    expect(
      second,
      'a stale pendingFlow must never serve one provider’s URI to another',
    ).toBe(`http://127.0.0.1:${SNUG_DESKTOP_OAUTH_PORT}/callback`);

    // …and the old ephemeral listener must not still be running.
    expect(liveListeners, 'the superseded ephemeral listener must be stopped').toBe(0);
  });

  it('a POSTURE change for the same provider re-resolves rather than replaying the old URI', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    await oauth.redirectUriFor({ provider: 'Ambiguous', posture: 'loopback' });
    const fixed = await oauth.redirectUriFor({ provider: 'Ambiguous', posture: 'loopback-fixed-port' });
    expect(fixed).toBe(`http://127.0.0.1:${SNUG_DESKTOP_OAUTH_PORT}/callback`);
  });

  it('the SAME provider+posture keeps the recorded string byte-identical (the two-call-sites invariant)', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    const a = await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    const b = await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    expect(b).toBe(a);
    expect(startCalls, 'a repeat call must not re-bind').toHaveLength(1);
  });

  it('the stuck-forever state is unreachable: the transport forgetting alone never wedges redirectUriFor', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    // Bind, and record what the platform believes.
    await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });

    // Now make the TRANSPORT forget WITHOUT telling the platform — the TTL auto-cancel
    // clears `recorded` from inside handleCallbackUrl, so `pendingFlow.bound` stays
    // true against an empty transport. Pre-fix, every later call threw
    // 'no desktop OAuth redirect URI recorded' with no reachable reset.
    forgetTransportRecording();

    const again = await oauth.redirectUriFor({ provider: 'Fake IdP', posture: 'loopback' });
    expect(again).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });
});

describe('fixed-port binding still happens at openExternal (display-safe render)', () => {
  it('the register screen does not bind; openExternal does', async () => {
    const platform = createDesktopPlatform();
    const oauth = platform.oauth!;

    await oauth.redirectUriFor({ provider: 'Spotify', posture: 'loopback-fixed-port' });
    expect(startCalls, 'rendering the register screen must not open a listener').toHaveLength(0);

    await oauth.openExternal('https://accounts.spotify.com/authorize?x=1');
    expect(startCalls).toEqual([{ fixedPort: SNUG_DESKTOP_OAUTH_PORT }]);
    expect(openedUrls).toEqual(['https://accounts.spotify.com/authorize?x=1']);
  });
});

/**
 * Make the transport forget its recorded URI WITHOUT the platform seam being called —
 * exactly what `handleCallbackUrl`'s TTL branch does when a callback arrives after
 * DESKTOP_FLOW_TTL_MS: `active` and `recorded` are both cleared from inside the
 * transport, and nothing informs `pendingFlow`.
 */
function forgetTransportRecording(): void {
  expect(feedCallbackUrl, 'a listener must have started for this to be meaningful').not.toBeNull();
  const past = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(past + DESKTOP_FLOW_TTL_MS + 1);
  feedCallbackUrl!('http://127.0.0.1:51001/callback?code=c&state=s');
  vi.mocked(Date.now).mockRestore();
}
