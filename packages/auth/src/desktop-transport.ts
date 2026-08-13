/**
 * Desktop loopback OAuth transport core (TASK-20260812 P1, AC5 / ADR-0021).
 *
 * Transport-agnostic on purpose: the Tauri shell injects a `LoopbackListener`
 * (tauri-plugin-oauth behind a Rust command) and receives `CallbackDelivery`s to
 * feed the wizard's channel adapter — this file has NO tauri imports, so
 * `packages/auth` stays browser-safe and DI-pure.
 *
 * Division of labor (mirrors OAuthCallbackPage): this transport is DELIVERY-ONLY.
 * The unsigned peek at the state payload names the delivery's appId/flowId channel
 * and nothing else — signature, nonce, TTL-of-state and flowId BINDING are enforced
 * downstream by `handleCallback`, which takes `expectedFlowId` from the caller's own
 * held copy. The code-injection-with-VALID-state attack (a local process racing the
 * redirect with its own authorization code) is defeated by provider PKCE binding,
 * which is why the registry structurally refuses `pkce:false` + a loopback posture.
 */

import { base64UrlToUtf8 } from './base64url.js';
import type { CallbackDelivery, RedirectUriProvider } from './oauth-service.js';

/**
 * The ONE registered desktop loopback port for `loopback-fixed-port` (exact-match)
 * providers — a stable copy-paste redirect URI that survives restarts. A collision is
 * an honest error naming this port, NEVER a silent fallback (a fallback port would
 * break the URI the user registered in the provider dashboard anyway).
 */
export const SNUG_DESKTOP_OAUTH_PORT = 41420;

/**
 * Mirrors `STATE_TTL_MS` in oauth-service.ts (10 min, not exported there): a flow
 * whose state the verifier would already reject as expired is not worth listening
 * for — the transport tears the listener down instead of delivering a dead callback.
 */
export const DESKTOP_FLOW_TTL_MS = 10 * 60 * 1000;

/** Loopback HTTP listener seam the shell implements. Binds 127.0.0.1 only. */
export interface LoopbackListener {
  start(opts: { fixedPort?: number }): Promise<{ port: number; stop(): Promise<void> }>;
}

/**
 * The one URI builder — literal `127.0.0.1`, never `localhost` (Spotify bans it;
 * RFC 8252 §7.3 prefers the literal). Every desktop redirect URI flows through here.
 */
export function buildLoopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export interface DesktopOAuthTransport {
  /**
   * The recorded-string seam for `OAuthService`: both service call sites (authorize
   * URL and token exchange) read the SAME recorded bytes — even after the listener
   * was torn down on callback receipt, because the token exchange happens later.
   */
  redirectUriProvider: RedirectUriProvider;
  beginFlow(opts: {
    posture: 'loopback' | 'loopback-fixed-port';
    appId: string;
    /** Reserved for the shell's channel adapter; deliveries use the PEEKED ids. */
    flowId?: string;
  }): Promise<{ redirectUri: string }>;
  /** Feed the raw URL the listener saw; parses code/state and delivers (or drops). */
  handleCallbackUrl(url: string): void;
  /** Stops any active listener and clears the recorded URI. Idempotent. */
  cancel(): Promise<void>;
}

interface ActiveFlow {
  startedAt: number;
  stop(): Promise<void>;
}

export function createDesktopOAuthTransport(deps: {
  listener: LoopbackListener;
  onDelivery: (d: CallbackDelivery) => void;
  clock?: () => number;
}): DesktopOAuthTransport {
  const clock = deps.clock ?? (() => Date.now());

  let active: ActiveFlow | null = null;
  /** Kept SEPARATE from `active`: delivery stops the listener but the token exchange
   *  still needs the byte-identical URI afterwards. Only cancel/TTL clears it. */
  let recorded: { appId: string; uri: string } | null = null;

  const stopActive = async (): Promise<void> => {
    const flow = active;
    active = null;
    if (flow !== null) await flow.stop().catch(() => undefined);
  };

  return {
    redirectUriProvider: {
      redirectUri(appId: string): string {
        if (recorded === null) {
          throw new Error('no desktop OAuth redirect URI recorded — beginFlow must run first');
        }
        if (recorded.appId !== appId) {
          throw new Error('recorded desktop redirect URI belongs to another app — restart the connect flow');
        }
        return recorded.uri;
      },
    },

    async beginFlow({ posture, appId }) {
      // Single-flight, cancel-old: the newest user intent wins (the wizard's own
      // teardown-then-assign popup pattern). Refusing instead would strand the user
      // behind a zombie listener that only an explicit cancel could clear.
      await stopActive();
      recorded = null;

      const fixed = posture === 'loopback-fixed-port';
      let handle: { port: number; stop(): Promise<void> };
      try {
        handle = await deps.listener.start(fixed ? { fixedPort: SNUG_DESKTOP_OAUTH_PORT } : {});
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          fixed
            ? `could not open the sign-in listener on port ${SNUG_DESKTOP_OAUTH_PORT} — another program may be using it (${detail})`
            : `could not open the sign-in listener (${detail})`,
        );
      }
      if (fixed && handle.port !== SNUG_DESKTOP_OAUTH_PORT) {
        // A listener that "helpfully" bound elsewhere would silently break the
        // dashboard-registered URI — refuse instead.
        await handle.stop().catch(() => undefined);
        throw new Error(
          `sign-in listener bound port ${handle.port} instead of the registered ${SNUG_DESKTOP_OAUTH_PORT} — refusing`,
        );
      }

      const uri = buildLoopbackRedirectUri(handle.port);
      recorded = { appId, uri };
      active = { startedAt: clock(), stop: () => handle.stop() };
      return { redirectUri: uri };
    },

    handleCallbackUrl(url: string): void {
      const flow = active;
      if (flow === null) return; // cancelled, expired, or already delivered
      if (clock() - flow.startedAt > DESKTOP_FLOW_TTL_MS) {
        // The state verifier would reject this flow as expired anyway — auto-cancel.
        active = null;
        recorded = null;
        void flow.stop().catch(() => undefined);
        return;
      }

      let code: string | null;
      let state: string | null;
      try {
        const parsed = new URL(url);
        code = parsed.searchParams.get('code');
        state = parsed.searchParams.get('state');
      } catch {
        return; // not a URL — drop, keep listening
      }
      if (code === null || code === '' || state === null || state === '') return;

      // Unsigned peek for channel naming ONLY (OAuthCallbackPage's documented
      // discipline) — NO signature validation here; a forged state can name a
      // channel, it cannot pass `handleCallback`'s verifyState downstream.
      let appId: string;
      let flowId: string;
      try {
        const payload = JSON.parse(base64UrlToUtf8(state.split('.')[0] ?? '')) as {
          appId?: unknown;
          flowId?: unknown;
        };
        if (typeof payload.appId !== 'string' || typeof payload.flowId !== 'string') return;
        appId = payload.appId;
        flowId = payload.flowId;
      } catch {
        return; // malformed state — drop, keep listening
      }

      // One-shot: tear the listener down, but KEEP the recorded URI — the token
      // exchange's redirectUri() call happens after this point.
      active = null;
      void flow.stop().catch(() => undefined);
      deps.onDelivery({ appId, flowId, code, state });
    },

    async cancel(): Promise<void> {
      recorded = null;
      await stopActive();
    },
  };
}
