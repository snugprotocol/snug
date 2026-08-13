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

import type {
  ConnectionKind,
  ConnectionRequest,
  ConnectionRequirement,
  ConnectionTestRequest,
} from '@snugprotocol/protocol';

/**
 * How a provider's OAuth flow can receive its redirect on the DESKTOP shell
 * (TASK-20260812-desktop-hub-scaffold, plan decision 1; RFC 8252's transport ladder).
 *
 * Human-authored, dashboard-verified REGISTRY DATA — never a requirement seat, never
 * inferred. The wizard renders the posture-matched registration walkthrough and, when
 * the running shell build does not implement a posture, refuses HONESTLY at wizard
 * entry instead of failing mid-flow (AC6).
 *
 *  - 'loopback'            — any-port `http://127.0.0.1:{port}` listener (RFC 8252 §7.3);
 *                            only for providers that honor any port at request time.
 *  - 'loopback-fixed-port' — exact-match providers: ONE registered loopback URI on the
 *                            pinned desktop port, so the user's dashboard registration
 *                            survives restarts.
 *  - 'custom-scheme'       — private-use scheme deep link (reserved; not built).
 *  - 'https-bridge'        — provider accepts only https redirects; needs the hosted
 *                            bridge page (reserved; refusal path ships first).
 *  - 'device-flow'         — RFC 8628; the refusing posture for flows where every
 *                            redirect transport is unusable (e.g. no PKCE → loopback
 *                            is undefendable).
 */
export type DesktopRedirectPosture =
  | 'loopback'
  | 'loopback-fixed-port'
  | 'custom-scheme'
  | 'https-bridge'
  | 'device-flow';

/**
 * Resolve the desktop redirect posture for a FLOW — the same `option ?? entry` seat
 * rule `requirementFromRegistryEntry` uses (ADR-0020: an option overrides credential-
 * FLOW seats; hosts/identity stay the entry's). `undefined` means the registry does
 * not vouch for ANY desktop OAuth transport — the wizard must refuse, never guess.
 */
export function resolveDesktopPosture(
  entry: WellKnownOauthProvider,
  option?: WellKnownAuthOption,
): DesktopRedirectPosture | undefined {
  return option?.desktopRedirectPosture ?? entry.desktopRedirectPosture;
}

/**
 * One ALTERNATE way in to a provider (TASK-20260812-auth-kind-choice, D1).
 *
 * An option is a COMPLETE credential flow: its own kind, fields, endpoints and
 * walkthrough. It deliberately has NO identity seats — `displayName`, `apiHosts` and
 * `aliases` belong to the ENTRY, because which hosts a credential may be injected
 * against is a per-provider decision, never a per-flow one. The TOP-LEVEL entry is
 * always the DEFAULT option; this type exists only for the alternates.
 */
export interface WellKnownAuthOption {
  /** Stable id for the option (choice handler + tests); `[a-z0-9_]` only. */
  id: string;
  /** Human label the choice card renders — "Sign in with Coinbase", not a kind name. */
  label: string;
  kind: ConnectionKind;
  fields?: WellKnownOauthProvider['fields'];
  endpoints?: WellKnownOauthProvider['endpoints'];
  registration?: WellKnownOauthProvider['registration'];
  /** Where THIS option's credential is sent — same seat rules as the entry's. */
  request?: WellKnownOauthProvider['request'];
  /** How THIS option's connection is verified — same seat rules as the entry's. */
  testRequest?: WellKnownOauthProvider['testRequest'];
  authorizeParams?: Record<string, string>;
  pkce?: boolean;
  /**
   * Desktop redirect transport for THIS option's flow — overrides the entry's posture
   * (flow seat per ADR-0020; hosts/identity stay the entry's). Deliberately NO
   * `browserCallable` here: whether a provider's API answers a browser is a
   * per-provider fact, never a per-flow one.
   */
  desktopRedirectPosture?: DesktopRedirectPosture;
}

export interface WellKnownOauthProvider {
  /** Display name used in the spec — falls back to the input when absent. */
  displayName?: string;
  /**
   * The provider's credential KIND — REQUIRED, and required on purpose (D1,
   * TASK-20260812). The inferrer's registry rung used to hardcode
   * `'oauth2_auth_code'` for every hit, which routed API-key providers (Coinbase,
   * OpenWeather, CoinGecko) into an OAuth connect step that cannot succeed. The entry
   * is the authority on its own kind; an optional seat with a default would reintroduce
   * exactly that bug for the next entry someone adds — a default is a hardcode with
   * better manners. Enforced by the AC3 structural suite (and by tsc, now that the
   * package's test script type-checks).
   */
  kind: ConnectionKind;
  /**
   * OAuth endpoints — OPTIONAL as of the Dynamic Auth v2 rewrite (fold T-M1).
   *
   * They were required when the registry served exactly one consumer: the OAuth branch of
   * `paramsToAuthSpec`. The registry-borrow ban now consults this same registry for ALL
   * kinds (`requirement-admission.ts`), so a static-kind provider — an exchange with an
   * HMAC-signed API key and no OAuth flow at all — must be representable by its
   * `apiHosts` and `registration` alone. Requiring empty endpoint URLs to satisfy the
   * type would have meant inventing URLs that do not exist, which is worse than absent:
   * `deriveConnectionAllowedHosts` unions endpoint hosts into the FROZEN ceiling, so a
   * placeholder URL would silently widen it.
   *
   * TYPE CHANGE ONLY in P0 — the static-kind DATA entries are P4. Consumers that need
   * endpoints must narrow explicitly; the OAuth transformer already does.
   */
  endpoints?: {
    authorizeUrl: string;
    tokenUrl: string;
    refreshUrl?: string;
    revokeUrl?: string;
  };
  /** Default scopes — ALWAYS undefined by policy; callers must declare scopes. */
  scopes?: string[];
  /** PKCE recommended by the provider? Defaults to true at the transformer. */
  pkce?: boolean;
  /**
   * Desktop redirect transport for the DEFAULT flow, verified against the provider's
   * own redirect-URI documentation (source cited per entry). Options may override
   * (flow seat). Absent on non-OAuth entries. STRUCTURAL RULE, pinned by test: a
   * loopback-class posture is only representable beside PKCE — `pkce:false` +
   * loopback leaves auth-code injection undefendable (P0 amendment 2).
   */
  desktopRedirectPosture?: DesktopRedirectPosture;
  /**
   * Can this provider's API be called from a BROWSER page (CORS)? Tri-state on
   * purpose (2026-08-12 BYOK CORS advisory, docs/next-steps.md): `true`/`false` are
   * DOCUMENTED facts the wizard may disclose; ABSENT means unknown and is disclosed
   * as unknown — never rendered as "works". Entry-level only, like `apiHosts`.
   */
  browserCallable?: boolean;
  /**
   * Human-authored near-miss names that should short-circuit INFERENCE to this entry —
   * "Coinbase Pro" is Coinbase for authoring purposes (D3, TASK-20260812).
   *
   * AUTHORING SCOPE ONLY. These are consulted exclusively by the inferrer's rung 1 via
   * `resolveInferrerAlias`; they are deliberately NOT part of `lookupWellKnownProvider`,
   * whose comment prohibits exactly that (resolution would hand a brand-adjacent
   * declaration this entry's pinned hosts and walkthrough as if it had asked for them).
   * The BAN path already treats these names as brand-adjacent and refuses their authored
   * fields — the alias changes none of that.
   */
  aliases?: string[];
  /**
   * Human label for the DEFAULT option ("API key", "Personal access token").
   * Required in practice the moment `authOptions` exists — the choice card must name
   * every option including the default; pinned by test rather than by type so
   * single-option entries stay untouched.
   */
  optionLabel?: string;
  /**
   * ALTERNATE auth options for providers that genuinely offer more than one way in
   * (owner decision Q2, 2026-08-12: human-authored variants; Coinbase + GitHub first).
   * The default stays at top level; the wizard/recovery use the default unless the
   * USER chooses otherwise via the choice card (Q1/Q4 — choice persists on the `user`
   * channel and R3 makes it durable).
   */
  authOptions?: WellKnownAuthOption[];
  /** Human-reviewed API hosts this provider's credential may be injected against. */
  apiHosts: string[];
  /**
   * The provider's credential FIELD LIST — the seat the static-kind entries needed
   * (TASK-20260810 P4, fold T-M1).
   *
   * THE DEFECT THIS CLOSES. Without it every static-kind provider collapsed to the
   * transformer's one generic input, which is the owner's founding report: "Coinbase
   * needs key + secret + passphrase" rendered as a single nameless box, so the user had
   * no way to know which of three secrets to paste where. Field DEFINITIONS only —
   * key/label/type — never values; this registry ships in a public repo (C1).
   *
   * WHY THE REGISTRY IS THE RIGHT HOME. `requirement-admission.ts` REFUSES a borrowing
   * channel that authors `fields` (Guard 2b) precisely because the registry had nothing
   * to substitute in. These entries are that missing pinned value: authored here, by a
   * human, in a reviewed PR — the one channel Guard 2b exempts.
   *
   * Shape-compatible with `connectionFieldSchema` (packages/protocol) by construction;
   * pinned by a test that composes each entry into a real `connectionRequirement` and
   * parses it, so a drift here fails in packages/auth rather than mid-substitution in
   * front of a user.
   */
  fields?: Array<{
    key: string;
    label: string;
    type: 'text' | 'secret' | 'password' | 'url';
    description?: string;
    placeholder?: string;
    required?: boolean;
  }>;
  /**
   * WHERE the typed credential is sent — the pinned request templates (ADR-0022 §1,
   * TASK-20260812-desktop-auth-awareness P3). Same shapes as the requirement schema's
   * `connectionRequestSchema` by construction (the types ARE the protocol's), pinned by
   * the AC3 structural suite composing every entry through `requirementFromRegistryEntry`
   * and parsing it.
   *
   * THE DEFECT THIS CLOSES. Guard 2b refuses a borrowing channel that AUTHORS `request`
   * (where a typed secret goes is exactly what a prompt-injected requirement must not
   * choose) — but the registry had nothing to substitute, so a PINNED provider could
   * never carry a signing template at all: the executor fell to the kind default
   * (`X-Api-Key` for `api_key`) and Coinbase's saved credential was read by no code
   * path. These seats are the missing pinned value: human-authored, docs-cited, in a
   * reviewed PR — the one channel Guard 2b exempts — and substituted on every channel's
   * borrow hit by `applyRegistryValues` (amendment 1c).
   *
   * Template VALUES are `{{…}}` references linted against the entry's OWN field keys
   * (registry-template-parity.test.ts) — never literal credentials (C1).
   */
  request?: ConnectionRequest;
  /**
   * HOW a connection is verified — the wizard's "test this connection" probe (ADR-0022
   * §1). GET + path-only by the protocol schema's construction: a probe that could
   * choose its method or host would be a write primitive and a second host channel.
   * The host comes from the frozen ceiling, i.e. from `apiHosts` above.
   */
  testRequest?: ConnectionTestRequest;
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
    kind: 'oauth2_auth_code',
    endpoints: {
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
    },
    pkce: true,
    // VERIFIED 2026-08-12: Spotify permits loopback redirect URIs ONLY as the explicit
    // literal `http://127.0.0.1:PORT` (or `[::1]`), BANS `localhost`, and matches the
    // registered URI exactly — so the desktop flow needs ONE stable registered port,
    // not an ephemeral one (an ephemeral port would invalidate the user's dashboard
    // registration on every restart).
    // https://developer.spotify.com/documentation/web-api/tutorials/migration-insecure-redirect-uri
    desktopRedirectPosture: 'loopback-fixed-port',
    apiHosts: ['api.spotify.com'],
    // KEY IS `client_id`, matching the oauth2_auth_code shape used at
    // demoRequirement.ts:265. A PKCE flow needs the Client ID and NOTHING else from the
    // user — no client secret, which is exactly what the walkthrough below promises. A
    // `client_secret` field here would contradict the pinned copy and teach the user to
    // paste a secret this hub must never hold.
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        type: 'text',
        description: 'From your Spotify app\'s settings page. Not the client secret — PKCE needs no secret.',
      },
    ],
    // Wizard-grade walkthrough (HARVESTED from AL-09 / TASK-20260807 AC10, verbatim —
    // polished HERE per AL-04 plan D5: registry data, never wizard component copy).
    // PKCE flow: no client secret step.
    registration: {
      consoleUrl: 'https://developer.spotify.com/dashboard',
      instructions: [
        'Open the Spotify developer dashboard (link above), sign in with your own Spotify account, and choose "Create app".',
        'Give the app any name and description — this is YOUR registration; Snug never sees it.',
        'In the app\'s settings, add the "redirect URI to register" shown below as a Redirect URI — copy it exactly as displayed, then save. Spotify matches it character for character and refuses sign-in on any mismatch.',
        'On the same settings page, copy the Client ID into the field below. Leave the client secret alone — this hub signs in with PKCE and never needs one.',
        'New Spotify apps start in Development mode: only users you list may sign in, which is fine for your own hub — add family members under "User Management" if they will use this app too.',
      ],
    },
  },
  google: {
    displayName: 'Google',
    kind: 'oauth2_auth_code',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    // VERIFIED 2026-08-12: Google's Desktop-app client type accepts loopback redirects
    // `http://127.0.0.1:{port}` with ANY port chosen at request time (RFC 8252 §7.3);
    // the loopback deprecation applies to Android/Chrome-app/iOS client types, NOT
    // desktop. Same posture for gmail/googledrive below — one Google OAuth surface.
    // https://developers.google.com/identity/protocols/oauth2/native-app
    desktopRedirectPosture: 'loopback',
    apiHosts: ['www.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  // Gmail and Drive use the same Google OAuth endpoints — separate keys so a provider
  // hint of "Gmail" or "Google Drive" still resolves cleanly, with per-API hosts.
  gmail: {
    displayName: 'Gmail',
    kind: 'oauth2_auth_code',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    // Same Google desktop-client loopback policy — citation at the `google` entry.
    desktopRedirectPosture: 'loopback',
    apiHosts: ['gmail.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  googledrive: {
    displayName: 'Google Drive',
    kind: 'oauth2_auth_code',
    endpoints: { ...GOOGLE_ENDPOINTS },
    pkce: true,
    // Same Google desktop-client loopback policy — citation at the `google` entry.
    desktopRedirectPosture: 'loopback',
    apiHosts: ['www.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
  },
  github: {
    displayName: 'GitHub',
    // `bearer_token`, WITH OAuth endpoints kept — the ONE entry where kind and
    // endpoints disagree BY DESIGN (D5, owner decision Q1). The field comment below
    // already argues a PAT is a bearer token; the endpoints stay for requirements that
    // DO run the app flow, and they are CEILING-LOAD-BEARING: `deriveConnectionAllowedHosts`
    // unions endpoint hosts regardless of kind, so removing them later would NARROW a
    // frozen ceiling and mass-demote existing approvals on the next sync (review m8).
    kind: 'bearer_token',
    optionLabel: 'Personal access token (recommended)',
    endpoints: {
      authorizeUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
    },
    pkce: false,
    apiHosts: ['api.github.com'],
    // VERIFIED 2026-08-12: the GitHub REST API "supports cross-origin resource sharing
    // (CORS) for AJAX requests from any origin" (Access-Control-Allow-Origin: *).
    // https://docs.github.com/en/rest/using-the-rest-api/using-cors-and-jsonp-to-make-cross-origin-requests
    browserCallable: true,
    // OAUTH APP — the alternate way in (TASK-20260812-auth-kind-choice). The endpoints
    // above already exist for exactly this flow (D5); the option makes it CHOOSABLE
    // instead of latent. GitHub OAuth apps do not support PKCE, so the token exchange
    // needs the app's client secret — collected as a credential field and held by the
    // hub's secret store like any other secret, never shipped in this registry (C1).
    authOptions: [
      {
        id: 'oauth_app',
        label: 'Sign in with GitHub (OAuth app)',
        kind: 'oauth2_auth_code',
        endpoints: {
          authorizeUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
        },
        pkce: false,
        // VERIFIED 2026-08-12: GitHub supports the device flow (RFC 8628, opt-in per
        // app). NOT a loopback posture, structurally: this option is `pkce:false`, so
        // a local process racing the loopback redirect could inject its own code with
        // the valid state and nothing would refuse it. The shell does not implement
        // device flow yet — the wizard therefore refuses honestly and steers to the
        // PAT default, which is the intended outcome.
        // https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
        desktopRedirectPosture: 'device-flow',
        fields: [
          {
            key: 'client_id',
            label: 'Client ID',
            type: 'text',
            description: "From your OAuth app's settings page on GitHub.",
          },
          {
            key: 'client_secret',
            label: 'Client secret',
            type: 'secret',
            description: 'GitHub OAuth apps have no PKCE, so the token exchange needs the secret. Generate one on the same settings page.',
          },
        ],
        registration: {
          consoleUrl: 'https://github.com/settings/developers',
          instructions: [
            'Open GitHub → Settings → Developer settings → OAuth Apps and choose "New OAuth App".',
            'Add the "redirect URI to register" shown below as the Authorization callback URL — copy it exactly.',
            'Copy the Client ID, then generate and copy a client secret, and paste both below.',
          ],
        },
      },
    ],
    // KEY IS `token` — the field key `bearer_token` requirements are built around
    // everywhere else (demoRequirement.ts:221, the taught-template lint's TAUGHT_FIELD_KEYS).
    // The `my-repos` starter models a Personal Access Token as a bearer token rather than
    // an OAuth app, which is honest: a PAT IS a bearer token, and asking the user to
    // register an OAuth app to read their own repos is a worse walkthrough for the same
    // access. The OAuth `endpoints` above stay for the requirements that DO run the app
    // flow — substitution writes them, and a `bearer_token` requirement simply never
    // reads them.
    fields: [
      {
        key: 'token',
        label: 'Personal access token',
        type: 'secret',
        description: 'A fine-grained or classic PAT with read access to the repositories you want listed.',
      },
    ],
    registration: {
      consoleUrl: 'https://github.com/settings/tokens',
      instructions: [
        'Open GitHub → Settings → Developer settings → Personal access tokens.',
        'Generate a token with READ-ONLY repository access — this app only lists repositories.',
        'Copy the token now: GitHub shows it once and cannot show it again.',
        'Paste it below.',
      ],
    },
  },
  slack: {
    displayName: 'Slack',
    kind: 'oauth2_auth_code',
    endpoints: {
      authorizeUrl: 'https://slack.com/oauth/v2/authorize',
      tokenUrl: 'https://slack.com/api/oauth.v2.access',
    },
    pkce: false,
    // VERIFIED 2026-08-12: Slack requires HTTPS redirect URLs ("must match or be a
    // subdirectory of a Redirect URL configured under App Management") — a loopback
    // http listener is unregistrable, so desktop needs the hosted https bridge.
    // Until the bridge ships, the wizard refuses honestly (AC6); Slack's non-OAuth
    // options, where authored, stay connectable.
    // https://docs.slack.dev/authentication/installing-with-oauth/
    desktopRedirectPosture: 'https-bridge',
    apiHosts: ['slack.com'],
  },
  // ───────────────────────────────────────────────────── the STATIC-KIND entries (P4)
  //
  // Three providers with NO OAuth flow at all. They are here for two reasons, and the
  // second is the security one:
  //
  //  1. They carry the `fields` and `registration` data that Guard 2b in
  //     `requirement-admission.ts` needs in order to have something to substitute. A
  //     static kind whose field list lives nowhere leaves the user at one generic input.
  //  2. Listing them EXTENDS THE BORROW BAN to their names and hosts. `findBorrowedEntry`
  //     indexes `apiHosts` at call time, so the moment these entries exist, a starter or
  //     an LLM proposal that names "Coinbase" — or that declares `api.coinbase.com` under
  //     a lookalike name — has the pinned values substituted over its own. That reach is
  //     the point, and it is pinned by test rather than left as a side effect.
  //
  // NO `endpoints` (the reason P0 made the seat optional): these providers have no
  // authorize/token URLs, and inventing placeholders would union a nonexistent host into
  // the FROZEN ceiling via `deriveConnectionAllowedHosts`. NO `scopes`, per the standing
  // registry posture — default scopes are silent privilege widening.
  coinbase: {
    displayName: 'Coinbase',
    kind: 'api_key',
    optionLabel: 'API key (recommended)',
    aliases: ['Coinbase Pro'],
    // RETAIL OAUTH — the alternate way in (TASK-20260812-auth-kind-choice). Coinbase
    // also offers a standard OAuth2 authorization-code flow for retail accounts via
    // login.coinbase.com. It is NOT the default: the API-key surface is what the
    // founding starter and the KB-taught template sign against, and OAuth requires
    // the user to register an OAuth2 app first. The user may still choose it — the
    // choice card offers both, and a choice persists on the `user` channel.
    authOptions: [
      {
        id: 'oauth',
        label: 'Sign in with Coinbase (OAuth)',
        kind: 'oauth2_auth_code',
        endpoints: {
          authorizeUrl: 'https://login.coinbase.com/oauth2/auth',
          tokenUrl: 'https://login.coinbase.com/oauth2/token',
        },
        pkce: true,
        // VERIFIED 2026-08-12 (as AMBIGUOUS): Coinbase's OAuth2 docs show only
        // `http://localhost:{port}` development examples and never state that the
        // `127.0.0.1` loopback LITERAL is registrable, nor an any-port policy — and
        // registered URIs are matched exactly. Ambiguity resolves to the REFUSING
        // posture, never an optimistic loopback (task rule): the wizard refuses on
        // desktop until the https bridge ships; the api_key default stays usable.
        // https://docs.cdp.coinbase.com/coinbase-app/oauth2-integration/integrations
        desktopRedirectPosture: 'https-bridge',
        fields: [
          {
            key: 'client_id',
            label: 'Client ID',
            type: 'text',
            description: 'From your OAuth2 app in the Coinbase Developer Platform. PKCE needs no client secret.',
          },
        ],
        registration: {
          consoleUrl: 'https://portal.cdp.coinbase.com/',
          instructions: [
            'Sign in to the Coinbase Developer Platform (link above) and create an OAuth2 application.',
            'Add the "redirect URI to register" shown below to the app — copy it exactly as displayed.',
            'Copy the Client ID into the field below. Leave the client secret alone — this hub signs in with PKCE and never needs one.',
          ],
        },
      },
    ],
    // The founding defect, fixed at the source: three DISTINCT secrets, each named and
    // described, so the user knows which value goes in which box before pasting. The
    // labels match Coinbase's own console wording — a label that renames the provider's
    // artifact is how a user pastes the wrong secret.
    apiHosts: ['api.coinbase.com'],
    // VERIFIED 2026-08-12: api.coinbase.com does not answer browser CORS preflights —
    // the motivating case of the 2026-08-12 BYOK CORS advisory (docs/next-steps.md):
    // a browser hub gets an opaque "Failed to fetch"; desktop's native fetch is the
    // advisory's rung 2. The wizard discloses this BEFORE credentials are pasted.
    browserCallable: false,
    fields: [
      {
        key: 'api_key',
        label: 'API key name',
        type: 'text',
        description: 'The key identifier shown when you created the key.',
      },
      {
        key: 'api_secret',
        label: 'API secret',
        type: 'secret',
        description: 'Shown ONCE at creation time. Coinbase cannot show it again.',
      },
      {
        // KEY IS `passphrase`, NOT `api_passphrase` — and the difference is not cosmetic.
        // The KB-taught Coinbase template signs with `CB-ACCESS-PASSPHRASE: {{passphrase}}`,
        // and the template engine resolves a token against the FIELD KEY. An
        // `api_passphrase` field would leave `{{passphrase}}` unresolved, sending the header
        // present-but-empty and producing a generic Coinbase 401 with nothing in the UI to
        // explain it. Seven other declaration sites (template-parity, template-lint,
        // template-engine, taughtTemplatesLint, demoRequirement, the protocol contract test)
        // all use `passphrase`; the registry was the one that forked. Pinned against the
        // taught template by `registry-template-parity.test.ts` so it cannot fork again —
        // the repo's own 2026-08-03 shared-literal lesson.
        key: 'passphrase',
        label: 'Passphrase',
        type: 'secret',
        description: 'The passphrase you chose when creating the key.',
        required: false,
      },
    ],
    registration: {
      consoleUrl: 'https://www.coinbase.com/settings/api',
      instructions: [
        'Sign in to Coinbase and open Settings → API.',
        'Create a new API key and choose READ-ONLY permissions — this app never needs to trade.',
        'Copy the key name and secret now: the secret is shown only once.',
        'Paste the key name, secret, and passphrase into the fields below.',
      ],
    },
  },
  openweather: {
    displayName: 'OpenWeather',
    kind: 'api_key',
    aliases: ['OpenWeatherMap'],
    apiHosts: ['api.openweathermap.org'],
    // VERIFIED 2026-08-12: OpenWeather serves CORS headers on its data API — direct
    // browser fetch is a documented, widely-exercised path (OpenWeather's own support
    // answer confirms CORS is enabled: https://openweathermap.desk.com/customer/portal/questions/16823835-cors).
    browserCallable: true,
    // OpenWeather transports its key as `?appid=` — a QUERY-STRING credential. That
    // placement is host-side (the template engine), never authored into app code: the
    // AL-09 AC3 lint in examples/ fails any starter that writes `?appid=` itself.
    fields: [
      {
        key: 'api_key',
        label: 'API key',
        type: 'secret',
        description: 'Your OpenWeather API key. New keys can take a couple of hours to activate.',
      },
    ],
    registration: {
      consoleUrl: 'https://home.openweathermap.org/api_keys',
      instructions: [
        'Create a free OpenWeather account.',
        'Open the API keys tab in your account page.',
        'Copy the default key (or generate a new one) and paste it below.',
        'A brand-new key can take up to two hours to become active.',
      ],
    },
  },
  coingecko: {
    displayName: 'CoinGecko',
    kind: 'api_key',
    apiHosts: ['api.coingecko.com'],
    // VERIFIED 2026-08-12: the CoinGecko API is CORS-enabled for client-side browser
    // requests (the reason it is the standing browser-side alternative to APIs that
    // block them; https://www.coingecko.com/en/api).
    browserCallable: true,
    fields: [
      {
        key: 'api_key',
        label: 'Demo API key',
        type: 'secret',
        description: 'From the CoinGecko developer dashboard. The free Demo plan is enough for this app.',
      },
    ],
    registration: {
      consoleUrl: 'https://www.coingecko.com/en/developers/dashboard',
      instructions: [
        'Create a free CoinGecko account.',
        'Open the developer dashboard and add a Demo API key.',
        'Copy the key and paste it below.',
      ],
    },
  },
  // Apple Music's developer-token + music-user-token dance doesn't fit
  // oauth2_auth_code cleanly; listed so lookup returns SOME entry. Authors override.
  //
  // KIND PINS THE STATUS QUO (TASK-20260812 decision): `oauth2_auth_code` is what the
  // inferrer's old hardcode emitted for this entry, so declaring it changes nothing for
  // Apple Music while making the seat required everywhere. A truthful MusicKit kind
  // does not exist in CONNECTION_KINDS; choosing one is a follow-up with its own
  // walkthrough, not a side effect of this task.
  applemusic: {
    displayName: 'Apple Music',
    kind: 'oauth2_auth_code',
    endpoints: {
      authorizeUrl: 'https://music.apple.com/login',
      tokenUrl: 'https://api.music.apple.com/v1/me/storefront',
    },
    pkce: false,
    // VERIFIED 2026-08-12: Apple Music has NO OAuth redirect flow at all — the Music
    // User Token is provisioned by MusicKit's `authorize()` popup inside a secure
    // browser context; there is no redirect URI to register, so no loopback transport
    // exists to point at. The refusing https-bridge posture keeps the desktop wizard
    // honest until a truthful MusicKit kind exists (queued follow-up), consistent
    // with this entry's status-quo `oauth2_auth_code` pin.
    // https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit
    desktopRedirectPosture: 'https-bridge',
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
 *
 * EXACT-KEY lookup, deliberately. This is the RESOLUTION path: it answers "which
 * provider's pinned endpoints should this spec use", and resolving "Spotify Inc" to
 * Spotify here would hand a brand-adjacent declaration Spotify's real OAuth endpoints as
 * if it had asked for them. The BAN path is a different question and uses
 * `findBrandAdjacentRegistryKeys` below.
 */
export function lookupWellKnownProvider(name: string): WellKnownOauthProvider | undefined {
  return REGISTRY[normalizeProviderKey(name)];
}

/**
 * Split a provider name into comparison SEGMENTS: on non-alphanumerics, and additionally
 * at camelCase / letter→digit humps inside each token.
 *
 * The hump split is what makes `CoinbaseInc` and `SpotifyPremium` reachable — an attacker
 * that removes the separator would otherwise walk straight past a token-only test, which
 * was measured during the P5 review rather than assumed ("CoinbaseInc" evaded a
 * token-subset prototype).
 */
function providerNameSegments(name: string): string[] {
  const segments: string[] = [];
  for (const token of name.split(/[^A-Za-z0-9]+/)) {
    if (token === '') continue;
    let current = '';
    for (let index = 0; index < token.length; index += 1) {
      const char = token[index] as string;
      const previous = token[index - 1];
      // A hump is lower/digit → UPPER. `GITHUB` stays whole (no hump inside a run of
      // capitals), which is why the all-caps spelling still matches its key.
      const isHump = previous !== undefined && /[a-z0-9]/.test(previous) && /[A-Z]/.test(char);
      if (isHump) {
        segments.push(current.toLowerCase());
        current = char;
      } else {
        current += char;
      }
    }
    if (current !== '') segments.push(current.toLowerCase());
  }
  return segments;
}

/**
 * Every registry key this name BORROWS FROM — the brand-adjacent match the borrow ban
 * needs (P5, carried finding (a)).
 *
 * THE HOLE THIS CLOSES, reproduced by execution before it was fixed: `lookupWellKnownProvider`
 * collapses case and punctuation but NOT added words, so `Spotify` hit the registry while
 * `Spotify Inc`, `Spotify Connect` and `Spotify-Premium` all missed it — and a miss meant
 * the requirement was admitted with attacker-authored credential fields, an
 * attacker-authored header template and attacker-chosen hosts, under a trusted brand.
 * The host-intersection trigger only caught it when the attacker also declared a registry
 * host, which an attacker aiming a credential at their own server never does.
 *
 * MATCHING IS BOUNDARY-AWARE, not substring. A name matches when some CONTIGUOUS RUN of
 * its segments joins to exactly a registry key. That is what separates the attack from
 * the coincidence:
 *
 *   'Spotify Inc'       → ['spotify','inc']        → run 'spotify'  → MATCH
 *   'CoinbaseInc'       → ['coinbase','inc']       → run 'coinbase' → MATCH
 *   'GitHub Enterprise' → ['git','hub','enterprise'] → run 'github' → MATCH
 *   'Slackline Weather' → ['slackline','weather']  → no run equals a key → NO MATCH
 *   'Gmailer Tools'     → ['gmailer','tools']      → no run equals a key → NO MATCH
 *
 * A substring test would have fired on the last two — and on 'Slacker Radio' and
 * 'Googol Analytics' — which are genuinely different providers whose names merely contain
 * a registry name's letters. Rejecting those would be a false accusation, so the guard is
 * built to miss them and that is pinned by test.
 *
 * WHAT IT STILL DOES NOT CLAIM. ASCII lookalikes (`5potify`, `Spotlfy`) remain out of
 * scope exactly as ADR-0017 scopes them: they share no segment with a registry key. They
 * are carried by the host-intersection trigger and the review's provenance copy, and this
 * function must never be described as reaching them.
 */
export function findBrandAdjacentRegistryKeys(name: string): string[] {
  const segments = providerNameSegments(name);
  const matched = new Set<string>();
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = start + 1; end <= segments.length; end += 1) {
      const run = segments.slice(start, end).join('');
      if (Object.hasOwn(REGISTRY, run)) matched.add(run);
    }
  }
  return [...matched];
}

/** Exposed for tests. */
export const WELL_KNOWN_PROVIDERS_REGISTRY = REGISTRY;

// --------------------------------------------------------------------- TASK-20260812
// The INFERRER-scoped alias map and the ONE registry→requirement emitter. Both exist so
// the inferrer's rung 1 can be honest about what the registry holds; neither touches
// the resolution or ban semantics above.

/**
 * Alias (normalized) → registry key, derived from the entries' own `aliases` seats.
 *
 * CONSULTED ONLY BY THE INFERRER'S RUNG 1 (D3). `lookupWellKnownProvider` stays
 * exact-key: it is the RESOLUTION path, and two other callers
 * (`params-to-auth-spec.ts`) depend on a near-miss name NOT resolving — aliasing there
 * would grant "Coinbase Pro" the real Coinbase's pinned hosts and registration
 * walkthrough with wizard-grade legitimacy, which is the reviewed BLOCKER 1 this
 * boundary encodes.
 *
 * Built at module load and structurally collision-checked by test: no alias may shadow
 * a registry key (a shadow would silently re-route an exact hit), and every alias must
 * point at an entry that exists.
 */
export const INFERRER_ALIASES: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(REGISTRY)) {
    for (const alias of entry.aliases ?? []) {
      map[normalizeProviderKey(alias)] = key;
    }
  }
  return map;
})();

/**
 * Resolve a provider name through the inferrer alias map — EXACT after normalization,
 * never fuzzy (AC6 pins that `Cooinbase`/`Sp0tify` miss and fall through to inference,
 * which is ADR-0017's accepted lookalike posture).
 */
export function resolveInferrerAlias(name: string): { key: string; entry: WellKnownOauthProvider } | undefined {
  const key = INFERRER_ALIASES[normalizeProviderKey(name)];
  if (key === undefined) return undefined;
  const entry = REGISTRY[key];
  return entry === undefined ? undefined : { key, entry };
}

/**
 * The ONE emitter from a registry entry to a connection requirement (D2). The
 * inferrer's rung 1 used to build this literal inline — hardcoding
 * `kind: 'oauth2_auth_code'` and discarding the entry's `fields` — which is the defect
 * this task exists to close. Everything the entry holds is copied; nothing is invented.
 *
 * DEEP-COPIED per seat: the registry is a module singleton the borrow ban consults on
 * every admission, so handing out live references would let one downstream caller's
 * edit repoint the pinned truth for every later substitution (same rule as
 * `applyRegistryValues`).
 *
 * Output is COMPOSED, not parsed — the callers own their `connectionRequirementSchema`
 * parse so a failure surfaces on their channel (the AC3 structural suite proves every
 * shipped entry parses, which is what makes a new entry missing a required piece fail
 * in this package rather than in front of a user).
 */
export function requirementFromRegistryEntry(
  entry: WellKnownOauthProvider,
  providerName: string,
  slot: string,
  /**
   * One of the entry's `authOptions` — the user's CHOSEN alternate flow
   * (TASK-20260812-auth-kind-choice). Absent ⇒ the entry itself, i.e. the DEFAULT
   * option, byte-identical to the pre-option behavior. The option supplies the
   * credential-flow seats; identity seats (display name, hosts) are ALWAYS the
   * entry's — a flow choice must never move which hosts receive the credential.
   */
  option?: WellKnownAuthOption,
): ConnectionRequirement {
  const flow = option ?? entry;
  return {
    slot,
    provider: { name: entry.displayName ?? providerName },
    kind: flow.kind,
    ...(flow.fields !== undefined ? { fields: flow.fields.map((field) => ({ ...field })) } : {}),
    ...(flow.endpoints !== undefined ? { endpoints: { ...flow.endpoints } } : {}),
    ...(flow.registration !== undefined
      ? {
          registration: {
            ...(flow.registration.consoleUrl !== undefined ? { consoleUrl: flow.registration.consoleUrl } : {}),
            ...(flow.registration.instructions !== undefined
              ? { instructions: [...flow.registration.instructions] }
              : {}),
          },
        }
      : {}),
    ...(flow.authorizeParams !== undefined ? { authorizeParams: { ...flow.authorizeParams } } : {}),
    ...(flow.pkce !== undefined ? { pkce: flow.pkce } : {}),
    // The NEW seats (ADR-0022 §1) ride the same flow rule as every credential-flow
    // seat: the option's own when an option is chosen, the entry's otherwise — and an
    // option WITHOUT them emits none, because a different flow must never inherit a
    // signing template whose field keys it does not declare.
    ...(flow.request !== undefined
      ? {
          request: {
            ...(flow.request.headerTemplate !== undefined ? { headerTemplate: { ...flow.request.headerTemplate } } : {}),
            ...(flow.request.queryTemplate !== undefined ? { queryTemplate: { ...flow.request.queryTemplate } } : {}),
          },
        }
      : {}),
    ...(flow.testRequest !== undefined ? { testRequest: { ...flow.testRequest } } : {}),
    declaredApiHosts: [...entry.apiHosts],
  };
}
