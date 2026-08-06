/**
 * Well-known OAuth providers — pinned endpoint defaults the deterministic transformer
 * (`paramsToAuthSpec`) consults. Ported near-verbatim from OProject (AL-02 plan D7)
 * and EXTENDED in this child (plan D2/D6):
 *
 *   - `apiHosts` — the human-reviewed API-host list per provider. The ported registry
 *     carried ONLY OAuth endpoints; specs whose `declaredApiHosts` is empty lean on
 *     this list, so every entry MUST carry one. Kept deliberately minimal — each host
 *     receives the user's credential at runtime (AL-03 injection ceiling), so a
 *     narrow list is the safe list. Choices journaled in the task file.
 *   - `authorizeParams` — per-provider consent params. Google's
 *     `access_type=offline&prompt=consent` (needed for a refresh token) lives HERE and
 *     is applied only where the registry says so — never hardcoded in the OAuth
 *     service (the source system hardcoded it for every provider).
 *
 * Deliberately out of scope (carried from the source): no default scopes (silent
 * privilege widening), no runtime .well-known fetching — every entry here was
 * reviewed by a human.
 */

export interface WellKnownOauthProvider {
  /** Display name used in the spec — falls back to the input when absent. */
  displayName?: string;
  endpoints: {
    authorizeUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    revokeUrl?: string;
  };
  /** Default scopes — ALWAYS undefined by policy; callers must declare scopes. */
  scopes?: string[];
  /** PKCE recommended by the provider? Defaults to true at the transformer. */
  pkce?: boolean;
  /** Human-reviewed API hosts this provider's credential may be injected against. */
  apiHosts: string[];
  /** Extra authorize-URL query params this provider needs (e.g. Google offline access). */
  authorizeParams?: Record<string, string>;
  /**
   * "Get your key / register your app" walkthrough copy the wizard surfaces verbatim
   * (AL-04 D5). Registry and explicit user entry are the ONLY sources for this block
   * (M5): LLM-authored proposals structurally cannot carry registration fields, so a
   * phishing consoleUrl can never render with wizard-grade legitimacy.
   */
  registration?: {
    consoleUrl?: string;
    instructions?: string[];
  };
}

const GOOGLE_ENDPOINTS = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
} as const;

/** Google needs these to return a refresh token; harmless nowhere else, so scoped here. */
const GOOGLE_AUTHORIZE_PARAMS = { access_type: 'offline', prompt: 'consent' } as const;

const REGISTRY: Record<string, WellKnownOauthProvider> = {
  spotify: {
    displayName: 'Spotify',
    endpoints: {
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
    },
    pkce: true,
    apiHosts: ['api.spotify.com'],
    // Stub-grade walkthrough (AL-04 plan D5) — AL-09 polishes the wording HERE, in
    // the registry, never in wizard component copy.
    registration: {
      consoleUrl: 'https://developer.spotify.com/dashboard',
      instructions: [
        'Open the Spotify developer dashboard and create an app.',
        'Add this hub\'s OAuth callback URL as a Redirect URI in the app settings.',
        'Copy the Client ID (and Client Secret if shown) into the fields below.',
      ],
    },
  },
  google: {
    displayName: 'Google',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    apiHosts: ['www.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  // Gmail and Drive use the same Google OAuth endpoints — separate keys so a provider
  // hint of "Gmail" or "Google Drive" still resolves cleanly, with per-API hosts.
  gmail: {
    displayName: 'Gmail',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    apiHosts: ['gmail.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  googledrive: {
    displayName: 'Google Drive',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    apiHosts: ['www.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  github: {
    displayName: 'GitHub',
    endpoints: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
    },
    pkce: false,
    apiHosts: ['api.github.com'],
  },
  slack: {
    displayName: 'Slack',
    endpoints: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
    },
    pkce: false,
    apiHosts: ['slack.com'],
  },
  // Apple Music's developer-token + music-user-token dance doesn't fit
  // oauth2_auth_code cleanly; listed so lookup returns SOME entry. Authors override.
  applemusic: {
    displayName: 'Apple Music',
    endpoints: {
      authorizeUrl: 'https://music.apple.com/login',
      tokenUrl: 'https://api.music.apple.com/v1/me/storefront',
    },
    pkce: false,
    apiHosts: ['api.music.apple.com'],
  },
};

/** Normalize a provider name for lookup (lowercase, alphanum only). */
function normalizeProviderKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Look up a well-known provider's OAuth defaults by display name. Returns undefined
 * when unknown — the transformer then requires explicit endpoints AND declared hosts.
 */
export function lookupWellKnownProvider(name: string): WellKnownOauthProvider | undefined {
  return REGISTRY[normalizeProviderKey(name)];
}

/** Exposed for tests. */
export const WELL_KNOWN_PROVIDERS_REGISTRY = REGISTRY;
