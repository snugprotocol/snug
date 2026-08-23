// auth.ts — hub account state (child 5, playground half). The hub's Google OIDC
// surface only exists when the server runs with SNUG_AUTH=google; against a v1
// server (or the static demo) /auth/me is a 404 and the UI simply stays logged-out.
// Logged-out is fully functional (local-only) — login adds the hub-hosted origin.

import { createStore, useStore } from './store.js';
import { getPlatform } from '../platform/platform.js';

export interface HubUser {
  userId: string;
  email?: string;
  name?: string;
  /** Google avatar URL. Omitted (never null) when the id_token carried no `picture` claim. */
  picture?: string;
}

export type AuthState =
  | { state: 'unknown' }
  | { state: 'unavailable' } // hub has no auth surface (v1 server / static hosting)
  | { state: 'anonymous' }
  | { state: 'signed-in'; user: HubUser };

export const authStore = createStore<AuthState>({ state: 'unknown' });

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const doFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** The double-submit CSRF token lives in the non-httpOnly `snug_csrf` cookie. */
export function readCsrfToken(): string | undefined {
  const match = /(?:^|;\s*)snug_csrf=([^;]+)/.exec(globalThis.document?.cookie ?? '');
  return match?.[1] === undefined || match[1] === '' ? undefined : decodeURIComponent(match[1]);
}

export async function refreshAuth(fetchImpl: FetchLike = doFetch): Promise<AuthState> {
  // ADR-0052 §5: sign-in is flag-gated OFF by default — the probe itself does not
  // fire, so a static host answering 401 can no longer conjure the button. The
  // launch posture is structural, not an accident of what /auth/me returns.
  if (getPlatform().capabilities.hubAuth !== true) {
    const gated: AuthState = { state: 'unavailable' };
    authStore.set(gated);
    return gated;
  }
  let next: AuthState;
  try {
    const response = await fetchImpl('/auth/me', { credentials: 'include' });
    if (response.status === 200) {
      const body = (await response.json()) as HubUser;
      next = { state: 'signed-in', user: body };
    } else if (response.status === 401) {
      next = { state: 'anonymous' };
    } else {
      next = { state: 'unavailable' };
    }
  } catch {
    next = { state: 'unavailable' };
  }
  authStore.set(next);
  return next;
}

/** Starts the hub login; `returnTo` (same-origin path) brings the user back where they were. */
export function login(returnTo?: string): void {
  const target = returnTo ?? globalThis.location?.pathname ?? '/';
  globalThis.location.assign(`/auth/login?return=${encodeURIComponent(target)}`);
}

export async function logout(fetchImpl: FetchLike = doFetch): Promise<void> {
  const csrf = readCsrfToken();
  await fetchImpl('/auth/logout', {
    method: 'POST',
    credentials: 'include',
    headers: csrf !== undefined ? { 'x-snug-csrf': csrf } : {},
  }).catch(() => undefined);
  await refreshAuth(fetchImpl);
}

export function useAuth(): AuthState {
  return useStore(authStore);
}
