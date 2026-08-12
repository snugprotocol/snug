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

import { createTauriFileFs } from './fs.js';
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
  let pendingFlow: { provider: string; posture: LoopbackPosture; bound: boolean } | null = null;

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
    fetchImpl: (input, init) => tauriFetch(remapUrl(input), init),
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
        if (pendingFlow !== null && pendingFlow.bound) {
          // Active flow: the recorded string, byte-identical for both service
          // call sites and any re-render of the register screen.
          return transport.redirectUriProvider.redirectUri(pendingFlow.provider) as string;
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
        const ch: ChannelLike = {
          onmessage: null,
          close: () => {
            channels.delete(flowId);
          },
        };
        channels.set(flowId, ch);
        return ch;
      },
      cancel: async () => {
        pendingFlow = null;
        channels.clear();
        await transport.cancel();
      },
    },
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
    capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  };
}
