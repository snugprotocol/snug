// LoopbackListener over tauri-plugin-oauth (ADR-0021 §2) + the desktop OAuth
// platform seam. The plugin starts a 127.0.0.1 listener and emits the full
// callback URL on `oauth://url`; the transport core (packages/auth) owns flow
// lifecycle, recorded-URI identity, TTL, and delivery discipline.
//
// RFC 8252: the authorize URL always opens in the SYSTEM browser (plugin-opener);
// the webview never navigates to a provider.

import type { LoopbackListener } from '@snugprotocol/auth';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';

export function createTauriLoopbackListener(
  onCallbackUrl: (url: string) => void,
): LoopbackListener {
  let unlisten: UnlistenFn | null = null;
  return {
    async start(opts: { fixedPort?: number }) {
      // One live subscription per listener start; re-listen after stop.
      unlisten?.();
      unlisten = await listen<string>('oauth://url', (event) => onCallbackUrl(event.payload));
      const port = await invoke<number>('plugin:oauth|start', {
        config: {
          ports: opts.fixedPort !== undefined ? [opts.fixedPort] : undefined,
          // Grandma-grade close-the-loop page; zero token material (the code/
          // state stay in the URL the listener already consumed server-side).
          response:
            '<!doctype html><meta charset="utf-8"><title>Snug</title>' +
            '<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h1>You’re connected ✓</h1>' +
            '<p>You can close this tab and return to Snug.</p></div>',
        },
      });
      return {
        port,
        stop: async () => {
          unlisten?.();
          unlisten = null;
          await invoke('plugin:oauth|cancel', { port }).catch(() => {
            // Already closed (one-shot server) — nothing to cancel.
          });
        },
      };
    },
  };
}

export async function openInSystemBrowser(url: string): Promise<void> {
  // https only: an authorize URL is always https; refuse anything else rather
  // than handing arbitrary schemes to the OS.
  if (!url.startsWith('https://')) throw new Error('refusing to open non-https URL');
  await openUrl(url);
}
