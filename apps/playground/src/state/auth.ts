// auth.ts — hub account state (child 5, playground half). The hub's Google OIDC
// surface only exists when the server runs with SNUG_AUTH=google; against a v1
// server (or the static demo) /auth/me is a 404 and the UI simply stays logged-out.
// Logged-out is fully functional (local-only) — login adds the hub-hosted origin.

import { createStore, useStore } from './store.js';

export interface HubUser {
  userId: string;
  email?: string;
  name?: string;
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

export function login(): void {
  globalThis.location.assign('/auth/login');
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
