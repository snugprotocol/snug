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
import type { CallbackDelivery, CallbackErrorDelivery, RedirectUriProvider } from './oauth-service.js';

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

/** The redirect path every existing caller gets; the ChatGPT-plan sign-in passes `/auth/callback`. */
export const DEFAULT_LOOPBACK_CALLBACK_PATH = '/callback';

/**
 * The one URI builder — literal `127.0.0.1`, never `localhost` (Spotify bans it;
 * RFC 8252 §7.3 prefers the literal). Every desktop redirect URI flows through here.
 * `path` (TASK-20261023-siwc-chatgpt-plan D10) defaults to `/callback`, so the URI every
 * registered provider knows is unchanged.
 */
export function buildLoopbackRedirectUri(port: number, path: string = DEFAULT_LOOPBACK_CALLBACK_PATH): string {
  return `http://127.0.0.1:${port}${path}`;
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
    /**
     * The redirect PATH (TASK-20261023-siwc-chatgpt-plan D10). Default `/callback` — every
     * existing caller unchanged; the ChatGPT-plan sign-in needs `/auth/callback` exactly,
     * because OpenAI's registration binds the client to that path. Threaded into
     * `buildLoopbackRedirectUri`, so the authorize request and the token exchange name the
     * same recorded URI.
     */
    path?: string;
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

/** The unsigned `{appId, flowId}` prefix of a `signState` token, or undefined when it has no such shape. */
function peekStateChannel(state: string): { appId: string; flowId: string } | undefined {
  try {
    const payload = JSON.parse(base64UrlToUtf8(state.split('.')[0] ?? '')) as { appId?: unknown; flowId?: unknown };
    if (typeof payload.appId !== 'string' || typeof payload.flowId !== 'string') return undefined;
    return { appId: payload.appId, flowId: payload.flowId };
  } catch {
    return undefined;
  }
}

export function createDesktopOAuthTransport(deps: {
  listener: LoopbackListener;
  onDelivery: (d: CallbackDelivery) => void;
  /**
   * OPT-IN error delivery (TASK-20261023-siwc-chatgpt-plan D10): a `?error=…&state=…` callback
   * (no `code`) is dropped unless this handler is present — the wizard's instance passes none
   * and keeps its behaviour byte-for-byte; the ChatGPT-plan instance passes one so a declined
   * consent ends the flow by name instead of waiting out the TTL. Reached only from
   * `handleCallbackUrl`, and only for a state that peeks to the active flow.
   */
  onError?: (e: CallbackErrorDelivery) => void;
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

    async beginFlow({ posture, appId, path }) {
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

      const uri = buildLoopbackRedirectUri(handle.port, path ?? DEFAULT_LOOPBACK_CALLBACK_PATH);
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

      let params: URLSearchParams;
      try {
        params = new URL(url).searchParams;
      } catch {
        return; // not a URL — drop, keep listening
      }
      const state = params.get('state');
      if (state === null || state === '') return;

      // Unsigned peek for channel naming ONLY (OAuthCallbackPage's documented
      // discipline) — NO signature validation here; a forged state can name a
      // channel, it cannot pass `handleCallback`'s verifyState downstream.
      const peeked = peekStateChannel(state);
      if (peeked === undefined) return; // malformed state — drop, keep listening

      const code = params.get('code');
      if (code === null || code === '') {
        // No code: a provider error callback (`?error=access_denied&state=…`). Delivered
        // ONLY to an instance that opted in (D10); otherwise dropped, listener kept —
        // the wizard's behaviour byte-for-byte.
        const error = params.get('error');
        if (deps.onError === undefined || error === null || error === '') return;
        active = null;
        void flow.stop().catch(() => undefined);
        const errorDescription = params.get('error_description');
        deps.onError({
          ...peeked,
          state,
          error,
          ...(errorDescription !== null && errorDescription !== '' ? { errorDescription } : {}),
        });
        return;
      }

      // One-shot: tear the listener down, but KEEP the recorded URI — the token
      // exchange's redirectUri() call happens after this point.
      active = null;
      void flow.stop().catch(() => undefined);
      const clientId = params.get('client_id');
      deps.onDelivery({
        ...peeked,
        code,
        state,
        ...(clientId !== null && clientId !== '' ? { clientId } : {}),
      });
    },

    async cancel(): Promise<void> {
      recorded = null;
      await stopActive();
    },
  };
}
