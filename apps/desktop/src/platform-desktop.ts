// The desktop SnugPlatform (task file "Pinned shared contract"; ADR-0021).
// Assembles Tauri-backed implementations of the playground's platform seams.
// Policy lives in the packages (host ceilings, C1 injection, magic checks) —
// this file only supplies capability.
//
// OAuth call order (pinned by the wizard, state/connectionWizard.ts):
//   redirectUriFor (register-screen display AND the service's provider)
//   → channelFor(flowId) → openExternal(authorizeUrl) → …callback…
// Listener lifecycle rules that order implies (W2a review concern):
//   - redirectUriFor must be DISPLAY-SAFE for `loopback-fixed-port`: it returns
//     the constant without binding, so rendering the register screen never
//     leaks a listener. The listener binds in openExternal — the last awaited
//     step before the system browser opens, so a bind collision surfaces as an
//     honest wizard error, never a dead callback.
//   - For ephemeral `loopback` the port IS the URI, so the first call begins
//     the flow (bounded by the transport's 10-min TTL + cancel-on-teardown).
//   - With a flow active, every call returns the recorded string (the
//     oauth-service two-call-sites invariant).

import {
  buildLoopbackRedirectUri,
  createDesktopOAuthTransport,
  SNUG_DESKTOP_OAUTH_PORT,
  type CallbackDelivery,
  type DesktopRedirectPosture,
} from '@snugprotocol/auth';
import { createFileBackend } from '@snugprotocol/db';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

import type { SnugPlatform } from '@playground/platform/platform';

import { createAppUpdates } from './app-updates.js';
import { createTauriFileFs } from './fs.js';
import { lanFetch, lanPair } from './lan-fetch.js';
import { sidecarCtl, sidecarFetch, sidecarWizardFetch } from './sidecar.js';
import { remapUrl } from './net-remap.js';
import { createTauriLoopbackListener, openInSystemBrowser } from './oauth.js';

const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';

type ChannelLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
};

type LoopbackPosture = 'loopback' | 'loopback-fixed-port';

export function createDesktopPlatform(): SnugPlatform {
  // Delivery fan-out: the transport core pushes CallbackDelivery; the wizard
  // subscribes per-flowId through channelFor (mirrors the web BroadcastChannel
  // naming, so connectionWizard's guards run unchanged).
  const channels = new Map<string, ChannelLike>();
  const onDelivery = (d: CallbackDelivery): void => {
    const ch = channels.get(d.flowId);
    ch?.onmessage?.({ data: { appId: d.appId, flowId: d.flowId, code: d.code, state: d.state } });
  };

  const transport = createDesktopOAuthTransport({
    listener: createTauriLoopbackListener((url) => transport.handleCallbackUrl(url)),
    onDelivery,
  });

  // The flow the wizard is assembling, remembered between redirectUriFor and
  // openExternal (the wizard always calls them in that order within a flow).
  //
  // It is a CACHE OF THE CURRENT FLOW, never a memory that outlives one (whole-surface
  // review finding A). `redirectUriFor` runs at register-screen RENDER time, before the
  // wizard has an active flow, so exits in that window used to leave this set: the next
  // session then read the previous provider's ephemeral URI as its "register this
  // exactly" value — defeating the fixed-port contract — and never bound its listener.
  // Two invariants close that off, both enforced in `redirectUriFor`:
  //   1. a provider OR posture that differs from the recorded one RESETS rather than
  //      replaying a stale string;
  //   2. `bound` is only trusted while the TRANSPORT still holds a recording; once the
  //      transport has forgotten (its TTL auto-cancel clears `recorded` from the inside,
  //      telling nobody) we re-bind instead of throwing 'no redirect URI recorded'
  //      forever with no reachable reset.
  let pendingFlow: {
    provider: string;
    posture: LoopbackPosture;
    bound: boolean;
    /** Set at `channelFor` — the handle a flow-scoped `cancel(flowId)` matches on. */
    flowId?: string;
  } | null = null;

  const assertLoopback = (posture: DesktopRedirectPosture): LoopbackPosture => {
    if (posture !== 'loopback' && posture !== 'loopback-fixed-port') {
      // The wizard refuses these postures before ever asking for a URI (AC6);
      // reaching here is a programming error, not a user state.
      throw new Error(`unsupported desktop posture: ${posture}`);
    }
    return posture;
  };

  return {
    kind: 'desktop',
    // `remapUrl` is the debug-gate host remap (net-remap.ts) — identity in every
    // production run (empty table unless the debug-only gate config armed it).
    //
    // `maxRedirections: 0` is how `redirect: 'manual'` is SPELLED on this
    // transport, and it is load-bearing, not belt-and-braces. The plugin's JS
    // shim (@tauri-apps/plugin-http 2.5.9, dist-js/index.js) reads exactly four
    // fields off `init` — maxRedirections, connectTimeout, proxy, danger — and
    // NEVER reads `init.redirect`; the value is then dropped by
    // `new Request(input, init)` before anything crosses to Rust. Rust installs
    // `Policy::none()` only when maxRedirections == Some(0); otherwise reqwest's
    // default `Policy::limited(10)` follows up to ten hops, and reqwest strips
    // only Authorization/Cookie/Proxy-Authorization across hosts — so INJECTED
    // headers (X-API-Key, HMAC signature seats) would ride to the redirect
    // target. That would void connected-fetch gate 9 and oauth-service postForm's
    // B2 guard ("a credential POST never follows a redirect") silently: the
    // executor sees only the final 200. Hence the explicit field.
    //
    // The merge is additive and non-mutating: `init.redirect` is preserved as the
    // portable statement of intent, the caller's object is never written to, and
    // a caller that deliberately passes its own maxRedirections cannot raise it
    // (this spread comes last). A plugin upgrade that starts honouring
    // `init.redirect` must RE-PROVE it in src/__tests__/netTransport.test.ts
    // before this field is dropped.
    fetchImpl: (input, init) => tauriFetch(remapUrl(input), { ...init, maxRedirections: 0 }),
    // THE PINNED-TLS LAN TRANSPORT (ADR-0023 D3). A DIFFERENT transport from
    // the one above, not a variant of it: `tauriFetch` verifies against the
    // public root store, which is exactly what a bridge's private-CA
    // certificate cannot satisfy. This one carries the TOFU pin into a rustls
    // verifier the shell owns, and every guard the plugin path gets from its
    // capability scope (host class) or its init fields (redirects, size) this
    // path enforces in Rust instead — see src-tauri/src/lanfetch.rs.
    //
    // No `remapUrl` here, and that is deliberate rather than an omission: the
    // debug gate's remap points at a loopback stub, and the Rust host-class
    // check refuses loopback outright (P0 amendment 13 — which is precisely why
    // the LAN fixture is a Rust-boundary test rather than a 127.0.0.1 stub).
    // Passing a URL through a remap that can only produce a refusal would
    // manufacture a failure mode that does not exist in production.
    lanFetch,
    // PAIR MODE, on its OWN seat (ADR-0023 D2). It sits beside `lanFetch` on
    // the platform because the WIZARD needs it, and nowhere near the executor's
    // deps because a request path that can accept-and-capture is a request path
    // that trusts anything answering at the address. `connectedFetchDepsFor`
    // threads `lanFetch` alone; that asymmetry is pinned by test on both sides.
    lanPair,
    // THE SIDECAR SEATS (ADR-0032). Both are threaded, and the wizard requires both
    // before it offers the flow: one starts the helper and carries its spawn nonce, the
    // other talks to it. Unlike the LAN pair above there is no asymmetry to preserve —
    // neither seat accepts a socket path, a host or a port, so neither can be aimed
    // anywhere the Rust side did not choose.
    sidecarCtl,
    sidecarFetch,
    sidecarWizardFetch,
    // The directory is the Rust command's concern: read_user_file/write_user_file
    // ALREADY scope every name into ~/Snug and REFUSE any name with a path
    // separator (userfile.rs `valid_name`). So the backend's own `${dir}/${file}`
    // prefixing must NOT reach Rust — `createTauriFileFs` reduces the path to its
    // basename before the invoke. The dir label here is cosmetic ('Snug' matches
    // where the bytes actually land) and never becomes part of the Rust name.
    userdbBackend: createFileBackend(createTauriFileFs(), 'Snug'),
    oauth: {
      async redirectUriFor(flow: { provider?: string; posture: DesktopRedirectPosture }) {
        const posture = assertLoopback(flow.posture);
        const provider = flow.provider ?? 'unknown';

        // A request that does not MATCH what is pending is a different flow, whatever
        // the wizard's own bookkeeping says (finding A). Reset rather than replay: a
        // stale string here is the wrong "register this exactly" value on a screen
        // whose entire job is to be byte-exact.
        if (pendingFlow !== null && (pendingFlow.provider !== provider || pendingFlow.posture !== posture)) {
          pendingFlow = null;
          await transport.cancel();
        }

        if (pendingFlow !== null && pendingFlow.bound) {
          // Active flow: the recorded string, byte-identical for both service
          // call sites and any re-render of the register screen.
          //
          // The transport is the AUTHORITY on whether a recording still exists. Its TTL
          // auto-cancel clears `recorded` from the inside and tells nobody, so a
          // `bound` flag trusted blindly wedged this call into throwing forever with no
          // reachable reset. Treat a transport that has forgotten as an unbound flow
          // and fall through to re-bind.
          try {
            return transport.redirectUriProvider.redirectUri(pendingFlow.provider) as string;
          } catch {
            pendingFlow = null;
          }
        }

        pendingFlow = { provider, posture, bound: false };
        if (posture === 'loopback-fixed-port') {
          // Display-safe: constant URI, no listener until openExternal.
          return buildLoopbackRedirectUri(SNUG_DESKTOP_OAUTH_PORT);
        }
        // Ephemeral: the bound port IS the URI; TTL + cancel bound the listener.
        const { redirectUri } = await transport.beginFlow({ posture, appId: provider });
        pendingFlow.bound = true;
        return redirectUri;
      },
      openExternal: async (url: string) => {
        if (pendingFlow !== null && !pendingFlow.bound) {
          // Fixed-port bind happens here — last awaited step before the system
          // browser opens. A collision rejects into the wizard's error path.
          await transport.beginFlow({ posture: pendingFlow.posture, appId: pendingFlow.provider });
          pendingFlow.bound = true;
        }
        await openInSystemBrowser(url);
      },
      channelFor(flowId: string): ChannelLike {
        // The wizard calls this AFTER the mint, so this is where the listener/URI the
        // pending flow already owns acquires the flowId a scoped cancel names.
        if (pendingFlow !== null) pendingFlow.flowId = flowId;
        const ch: ChannelLike = {
          onmessage: null,
          close: () => {
            channels.delete(flowId);
          },
        };
        channels.set(flowId, ch);
        return ch;
      },
      /**
       * FLOW-SCOPED when `flowId` is given (finding B): it evicts only that flow's
       * channel, and stops the listener only when that flow is the one holding it. An
       * unscoped cancel fired from a losing concurrent start used to clear the whole
       * channel map and stop the live listener — killing the flow that had just won and
       * parking the wizard on 'awaiting_callback' with nothing left to deliver.
       *
       * Without a `flowId` it is the global teardown, which is what a dismissal needs:
       * it also clears a listener bound before any flow existed (`redirectUriFor` runs
       * at register-screen render), which no scoped cancel can reach.
       */
      cancel: async (flowId?: string) => {
        if (flowId !== undefined) {
          channels.delete(flowId);
          // Stop the listener ONLY when this flow is demonstrably the one holding it.
          // `pendingFlow === null` means nothing is pending to tear down; a different
          // flowId means the listener belongs to somebody else. Either way, leaving it
          // alone is the safe direction — a global cancel is always still reachable.
          if (pendingFlow === null || pendingFlow.flowId !== flowId) return;
        } else {
          channels.clear();
        }
        pendingFlow = null;
        await transport.cancel();
      },
    },
    // The GENERIC link opener (Gate-5, TASK-20260822): openInSystemBrowser is the
    // side-effect-free primitive (https guard + plugin-opener) — deliberately NOT
    // oauth.openExternal, whose pending-flow bind must stay OAuth-only.
    openExternalUrl: (url: string) => openInSystemBrowser(url),
    async saveFile(bytes: Uint8Array, suggestedName: string) {
      // Dialog AND write both live in one Rust command: the webview never
      // names a filesystem path, so there is no consent-free write to forge.
      await invoke('export_user_bytes', bytes, {
        headers: { 'suggested-name': encodeURIComponent(suggestedName) },
      });
    },
    async probeOllama() {
      try {
        const res = await tauriFetch(OLLAMA_TAGS_URL, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return { running: false, models: [] };
        const body = (await res.json()) as { models?: Array<{ name?: string }> };
        const models = (body.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => typeof n === 'string');
        return { running: true, models };
      } catch {
        return { running: false, models: [] };
      }
    },
    onOpenUserFile(cb: (bytes: Uint8Array, path: string) => void) {
      const deliver = async (path: string): Promise<void> => {
        try {
          const raw = await invoke<ArrayBuffer>('read_opened_file', { path });
          cb(new Uint8Array(raw), path);
        } catch {
          // Path not allowlisted or unreadable — openfile.rs already refused;
          // nothing to surface (the OS event was not a user-meaningful open).
        }
      };
      void listen<string[]>('snug:opened-files', (e) => {
        for (const p of e.payload) void deliver(p);
      });
      void invoke<string[]>('pending_opened_files').then((paths) => {
        for (const p of paths) void deliver(p);
      });
    },
    // THE SHELL UPDATE CHANNEL (ADR-0047). check/downloadAndInstall ride the updater
    // plugin (artifact-signature verified in Rust); relaunch reaps the sidecar first
    // — the ordering is pinned by appUpdates.test.ts's call-order spy, never by prose.
    appUpdates: createAppUpdates(),
    // hubAuth stays absent-and-off by design (ADR-0052 §5): the shell has no hub
    // login surface — BYOK/local only — and stating it here would imply a knob.
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}
