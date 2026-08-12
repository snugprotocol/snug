// The platform seam (TASK-20260812, ADR-0021 Decision 9): the ONE interface a native
// shell implements to host the playground. Every seam is optional and its absence
// means "today's web behavior" — AC10's no-regression rests on that default. This
// module stays dependency-light on purpose (types from the packages, nothing from
// state/): it is imported before React boot, ahead of any store.

import type { DesktopRedirectPosture } from '@snugprotocol/auth';
import type { PersistenceBackend } from '@snugprotocol/db';

/**
 * Structurally identical to connectionWizard's `ConnectionChannelLike`, defined
 * locally so platform.ts never imports from state/ (which would drag stores into
 * the shell's boot path before setPlatform runs).
 */
export interface PlatformConnectionChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

export interface SnugPlatform {
  kind: 'web' | 'desktop';
  /** Outbound fetch for connected-fetch, adapters, OAuth exchange. Web: undefined → globalThis.fetch. */
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Userdb + sync-sidecar backend. Web: undefined → detectPersistenceBackend(USERDB_OPFS_DIR). */
  userdbBackend?: PersistenceBackend;
  /** OAuth transport. Web: undefined → popup + BroadcastChannel + `${origin}/oauth/callback`. */
  oauth?: {
    /** Recorded-string lifecycle: byte-identical across both OAuthService call sites. */
    redirectUriFor(flow: { provider?: string; posture: DesktopRedirectPosture }): Promise<string>;
    /** System browser (RFC 8252) — the webview is never navigated to a provider. */
    openExternal(url: string): Promise<void>;
    /** Listener-event adapter feeding the wizard's channel seam. */
    channelFor(flowId: string): PlatformConnectionChannel;
    /** Teardown of the active listener. */
    cancel(): Promise<void>;
  };
  /** Save bytes with a native dialog. Web: undefined → downloadBlob anchor. */
  saveFile?(bytes: Uint8Array, suggestedName: string): Promise<void>;
  /** Probe local Ollama. Web: undefined → no probe. */
  probeOllama?(): Promise<{ running: boolean; models: string[] }>;
  /** Registers the .snug open handler. Desktop only. */
  onOpenUserFile?(cb: (bytes: Uint8Array, path: string) => void): void;
  capabilities: { subscriptionMode: boolean; hubSyncOrigin: boolean; lanHttpPrivate: boolean };
}

const WEB_DEFAULT: SnugPlatform = {
  kind: 'web',
  capabilities: { subscriptionMode: true, hubSyncOrigin: true, lanHttpPrivate: false },
};

let current: SnugPlatform | null = null;
let readOnce = false;

/**
 * Install the platform BEFORE React boot (desktop `main-desktop.tsx` calls this
 * first). Set-once and set-before-first-read: a platform swapped mid-session would
 * split one live flow across two transports, so both misuses throw instead.
 */
export function setPlatform(platform: SnugPlatform): void {
  if (current !== null) {
    throw new Error('setPlatform called twice — the platform is set once, before boot');
  }
  if (readOnce) {
    throw new Error('setPlatform called after getPlatform was already read — no mid-session platform swaps');
  }
  current = platform;
}

/** The set platform, or the web default (today's behavior) when none was set. */
export function getPlatform(): SnugPlatform {
  readOnce = true;
  return current ?? WEB_DEFAULT;
}
