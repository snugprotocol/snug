// The desktop SnugPlatform (task file "Pinned shared contract"; ADR-0021).
// Assembles Tauri-backed implementations of the playground's platform seams.
// Policy lives in the packages (host ceilings, C1 injection, magic checks) —
// this file only supplies capability.

import {
  createDesktopOAuthTransport,
  resolveDesktopPosture,
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
import { createTauriLoopbackListener, openInSystemBrowser } from './oauth.js';

export { resolveDesktopPosture };
export type { DesktopRedirectPosture };

const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';

type ChannelLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
};

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

  return {
    kind: 'desktop',
    fetchImpl: (input, init) => tauriFetch(input, init),
    userdbBackend: createFileBackend(createTauriFileFs(), 'Snug'),
    oauth: {
      async redirectUriFor(flow: { provider?: string; posture: DesktopRedirectPosture }) {
        if (flow.posture !== 'loopback' && flow.posture !== 'loopback-fixed-port') {
          // The wizard refuses these postures before ever asking for a URI
          // (AC6); reaching here is a programming error, not a user state.
          throw new Error(`unsupported desktop posture: ${flow.posture}`);
        }
        const { redirectUri } = await transport.beginFlow({
          posture: flow.posture,
          appId: flow.provider ?? 'unknown',
        });
        return redirectUri;
      },
      openExternal: openInSystemBrowser,
      channelFor(flowId: string): ChannelLike {
        const ch: ChannelLike = {
          onmessage: null,
          close: () => {
            channels.delete(flowId);
            void transport.cancel();
          },
        };
        channels.set(flowId, ch);
        return ch;
      },
      cancel: () => transport.cancel(),
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
