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
  /**
   * The PINNED-TLS LAN transport (ADR-0023 Decision 3; P0 amendment 6) — the
   * shell's `lan_fetch` command. Reaches a device on the user's own network
   * whose certificate is signed by a private CA, verifying it against a TOFU
   * fingerprint recorded at pairing.
   *
   * Web: ABSENT, and absence is the entire web story — a browser cannot pin a
   * certificate, so a LAN row on web is DISCLOSED as desktop-only rather than
   * attempted. The executor treats absence as a named refusal and never as a
   * reason to fall back to `fetchImpl`, so this seat cannot silently become a
   * way to dial a private address from a page.
   *
   * Note this is NOT a variant of `fetchImpl`: the pin is a required third
   * argument, because a pinless call to this transport is a different (pair
   * mode) trust decision that only the wizard's pairing step may make.
   */
  lanFetch?: (url: string, init: RequestInit, pin: string) => Promise<Response>;
  /**
   * PAIR MODE — the shell's `lan_fetch` in `mode:'pair'` (ADR-0023 D2; P0
   * amendment 5). The ONE call that accepts a LAN device's certificate without
   * a pin, because there is no pin yet: the rustls verifier accepts and
   * CAPTURES the leaf (fingerprint + CN) and hands it back beside the response,
   * so the wizard writes pin + minted key in a single step.
   *
   * A SEPARATE SEAT FROM `lanFetch`, NEVER A MODE ARGUMENT ON IT, and that
   * separation is the guard. `lanFetch` is threaded into the connected-fetch
   * deps; this is not, and must never be — a request-time path to
   * accept-and-capture would trust whatever answers at the address, which is
   * the accept-invalid-certs decision this whole design exists to avoid. The
   * ONLY legitimate caller is the wizard's pairing step, which runs after the
   * user has approved the row and pressed a physical button on the device.
   *
   * The `pin` in the answer is OPTIONAL on purpose: when the verifier never
   * ran, its absence is the truth and the wizard must refuse to record rather
   * than store a fingerprint that would fail every later request.
   */
  lanPair?: (
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ) => Promise<{ status: number; body: string; pin?: { fingerprint: string; cn: string } }>;
  /**
   * THE SIDECAR SEATS (ADR-0032) — the WhatsApp helper's lifecycle and transport. Desktop
   * only: both resolve to Rust commands, and a browser tab cannot open a unix socket.
   *
   * They are TWO seats and the wizard requires BOTH before it offers the flow, because
   * they answer different questions: `sidecarCtl` starts and reports the helper (and is
   * the only source of the spawn nonce the pairing routes demand), `sidecarFetch` talks to
   * it. A capability test satisfied by either alone would advertise a flow that fails
   * midway — the same reason the LAN seats above are checked as a pair.
   *
   * Note what none of these seats accepts: a socket path, a host, or a port. The Rust side
   * names the socket, so no caller here — wizard, app, or otherwise — can point the transport
   * somewhere else.
   *
   * `sidecarFetch` is the APP door and refuses every pairing route in Rust. `sidecarWizardFetch`
   * is the WIZARD door and admits them, and it is a SEPARATE COMMAND rather than a flag
   * because the distinction that matters is "who is calling" — a parameter would be a claim
   * the caller makes, and an app can make any claim. Command identity is not forgeable from
   * an app iframe: capabilities are scoped to the main window and the in-shell gate asserts
   * IPC unreachability per command. The wizard seat also carries the spawn nonce, read from
   * shell state, never from the webview.
   *
   * (Until 2026-08-17 this comment claimed the pairing calls went "through `sidecarCtl`'s
   * nonce rather than through this seat". They did not — the wizard called `sidecarFetch`,
   * which refused them, so linking could never start. The claim was about a surface nobody
   * had run.)
   */
  sidecarCtl?: (action: 'start' | 'stop' | 'status') => Promise<{ running: boolean; nonce?: string }>;
  sidecarFetch?: (
    method: string,
    pathAndQuery: string,
    body?: string,
  ) => Promise<{ status: number; body: string }>;
  sidecarWizardFetch?: (
    method: string,
    pathAndQuery: string,
    body?: string,
  ) => Promise<{ status: number; body: string }>;
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
    /**
     * Teardown. FLOW-SCOPED when `flowId` is given — it evicts only that flow's channel
     * and, if that flow owns the live listener, stops it; a flow the caller is not
     * tearing down survives untouched. Without `flowId` it is the global teardown, which
     * also clears any listener/URI bound before a flow existed (`redirectUriFor` runs at
     * register-screen render, well before the wizard has an active flow).
     */
    cancel(flowId?: string): Promise<void>;
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
