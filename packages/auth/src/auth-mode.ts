/**
 * Pure auth-mode resolution helper — ported near-verbatim from an ancestor system (AL-02 plan
 * D7), re-seated on Snug's opaque `appId` (branded tenant/user types dropped: the
 * local-first hub is single-actor, so the caller identity IS the file's owner).
 *
 * Decision matrix:
 *   - per_user  → read the caller's own user row (caller-keyed).
 *   - global    → read the shared org row.
 *   - two_layer → DEFERRED. There is no coherent single-spec merge for the four
 *                 static kinds; runtime returns TWO_LAYER_RESOLUTION_DEFERRED until
 *                 the two-layer resolution work lands (the OAuth LOOP for two-layer
 *                 specs already completes via `resolveAuthCodeLayer` — bug-1 fix —
 *                 but resolution beyond that loop stays deferred).
 *
 * Forward rule carried from the source: when the two-layer merge lands, its
 * `allowedHosts` MUST be the INTERSECTION of org and user host lists (never union —
 * a union would let a user widen an operator-set credential's allowlist).
 */

export type AuthMode = 'per_user' | 'global' | 'two_layer';

/** Stable code returned for a two_layer runtime resolution attempt. */
export const TWO_LAYER_RESOLUTION_DEFERRED = 'TWO_LAYER_RESOLUTION_DEFERRED' as const;

export interface AuthModeCaller {
  appId: string;
}

export type AuthModeResolution =
  | { kind: 'read'; layer: 'user'; appId: string }
  | { kind: 'read'; layer: 'org'; appId: string }
  | { kind: 'deferred'; code: typeof TWO_LAYER_RESOLUTION_DEFERRED };

/** Decide which credential row to read for a given auth mode. Pure; no side effects. */
export function resolveAuthMode(authMode: AuthMode, caller: AuthModeCaller): AuthModeResolution {
  switch (authMode) {
    case 'per_user':
      return { kind: 'read', layer: 'user', appId: caller.appId };
    case 'global':
      return { kind: 'read', layer: 'org', appId: caller.appId };
    case 'two_layer':
      return { kind: 'deferred', code: TWO_LAYER_RESOLUTION_DEFERRED };
    default: {
      const exhaustive: never = authMode;
      return exhaustive;
    }
  }
}
