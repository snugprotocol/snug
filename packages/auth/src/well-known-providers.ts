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
 * Deliberately out of scope (carried from the source): no runtime .well-known fetching —
 * every entry here was reviewed by a human. Scopes: the original "no default scopes"
 * posture was AMENDED by ADR-0028 — an entry may pin a human-reviewed, ADR-recorded
 * scope list (ENTRY-level only, never per option; privilege breadth is brand identity),
 * because the harm was always "a scope the user never sees" and pinned scopes render on
 * the wizard review screen and the provider's consent screen. Entries not recorded in
 * ADR-0028 still pin none.
 */

import type {
  ConnectionKind,
  ConnectionLanHost,
  ConnectionRequest,
  ConnectionRequirement,
  ConnectionTestRequest,
} from '@snugprotocol/protocol';
import { SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';

/**
 * A PAIRING EXCHANGE — how a provider MINTS a credential that the user cannot type
 * (ADR-0023 Decision 2, TASK-20260812-desktop-auth-awareness P5).
 *
 * DESIGNED PROVIDER-AGNOSTICALLY, used by exactly one provider today. A Hue bridge's
 * application key is not published on any screen: you press the physical link button and
 * POST to the bridge, which mints and returns one. The wizard therefore needs the
 * exchange described as DATA — method, path, body, where the minted value lives in the
 * response, and which declared field it fills — so the next LAN device (a printer, a
 * hub, a thermostat) is a registry row rather than a new branch in the wizard.
 *
 * WHAT THIS SEAT DELIBERATELY CANNOT EXPRESS:
 *  - A HOST. The exchange always runs against the connection's own frozen ceiling host
 *    (ADR-0023's binding order: collect address → approve → freeze → pair), so a
 *    registry-authored host here would be a second host channel around the ceiling.
 *  - A HEADER TEMPLATE. The pairing request is UNCREDENTIALED by definition — it is the
 *    request that creates the credential — so there is nothing to inject and no seat to
 *    inject it through.
 *  - ARBITRARY RESPONSE HANDLING. `secretPath` is a literal walk (object keys and array
 *    indices), never an expression: the response comes from a device on the user's
 *    network and must be READ, never evaluated.
 *
 * CUSTODY (C1): the minted value goes straight into `snug_secrets` under the connection's
 * `secretField` key. The exchange response never enters app-, LLM-, or export-visible
 * state — the wizard is the only reader, and it reads exactly `secretPath`.
 */
export interface WellKnownPairingExchange {
  /**
   * The EXCHANGE shape (ADR-0023): one POST, one response, `secretPath` walks to the key.
   *
   * REQUIRED and explicit, rather than an optional field defaulting to `'exchange'`. A
   * union whose members can be told apart only by which OTHER fields happen to be present
   * is a union that every reader must re-derive; a defaulted discriminant additionally
   * makes "nobody has decided yet" and "this is an exchange" the same value. One narrowing
   * read on `kind` answers it everywhere.
   */
  kind: 'exchange';
  /** POST only at v1 — a pairing exchange CREATES a credential, so it is never a read. */
  method: 'POST';
  /** Path on the connection's own ceiling host. Leading '/' — never a URL. */
  pathAndQuery: string;
  /** The literal JSON body. Pinned registry data — no substitution, no user input. */
  body: Record<string, string | number | boolean>;
  /** Literal walk to the minted secret in the response (keys and array indices). */
  secretPath: ReadonlyArray<string | number>;
  /** Which of the entry's OWN declared `fields` the minted value fills. */
  secretField: string;
  /**
   * What the user must do BEFORE the exchange will succeed, rendered verbatim by the
   * wizard immediately before it fires the request. This copy is the whole difference
   * between a working pairing and an unexplained failure: the exchange only succeeds
   * inside the device's own consent window.
   */
  preconditionInstruction: string;
  /**
   * THE VERIFY READ (ADR-0025) — the credentialed request the wizard fires after the
   * mint and BEFORE it claims connected. GET only: it PROVES the key, it never
   * exercises it. It runs on the pinned transport against the connection's own frozen
   * ceiling host, the credential rides the entry's own `request.headerTemplate`
   * (rendered with only the just-minted `secretField` value — no second injection
   * vocabulary), and the response is read for its STATUS alone.
   *
   * REQUIRED, deliberately: a pairing provider that cannot be verified post-mint
   * re-creates the instant-connected defect this seat exists to kill — the owner's
   * hardware report that a wizard said "connected" while nothing had proven the key.
   */
  verify: {
    method: 'GET';
    /** Path on the connection's own ceiling host. Leading '/' — never a URL. */
    pathAndQuery: string;
  };
}

/**
 * A DEVICE LINK — how a provider mints a credential by having the user prove possession of
 * an already-authenticated device (ADR-0032, TASK-20260816).
 *
 * WHY THE EXCHANGE SHAPE ABOVE CANNOT CARRY THIS. Hue's exchange is one POST whose single
 * response contains the key. A device link is three beats: START a session, render a QR the
 * user scans with their phone, then POLL until the provider confirms and releases the token.
 * The minted value therefore arrives in the response of a route that `secretPath` does not
 * name, and there is no single request to walk. Overloading `secretPath` to sometimes mean
 * "this response" and sometimes "some other route's response" would make one field mean two
 * things — so the seat is discriminated instead.
 *
 * WHAT THIS SEAT DELIBERATELY CANNOT EXPRESS, inheriting the exchange's discipline: no HOST
 * (reachability belongs to the transport, never to registry data), no HEADER TEMPLATE (the
 * pairing routes are uncredentialed by definition — they are what CREATE the credential),
 * and no arbitrary response handling.
 *
 * CUSTODY (C1) is the same and is the point: the token the poll returns goes straight to
 * `snug_secrets`. The provider's OWN session material — for WhatsApp, the Signal/noise keys
 * a linked device holds — never crosses this boundary at all; it stays in the helper's disk
 * store. The host holds a key to the helper, not a key to the user's account.
 */
export interface WellKnownDeviceLinkPairing {
  kind: 'device-link';
  /** Begins a link session. POST, because it creates server-side state. */
  startPathAndQuery: string;
  /** Returns the QR payload the user scans. Rendered by the wizard, never followed. */
  qrPathAndQuery: string;
  /** Polled until the provider reports the device linked; releases the token ONCE. */
  pollPathAndQuery: string;
  /** How often to poll. A device link waits on a human, so this is seconds, not millis. */
  pollIntervalMs: number;
  /**
   * When to give up. REQUIRED: a QR has a provider-side lifetime and a user may simply
   * walk away, so an unbounded poll is a wizard that hangs forever on the commonest
   * non-error outcome — the scan that never happens.
   */
  pollTimeoutMs: number;
  /** Which of the entry's OWN declared `fields` the released token fills. */
  secretField: string;
  /** Shown verbatim before the QR — the user needs to know to reach for their phone. */
  preconditionInstruction: string;
  /** THE VERIFY READ (ADR-0025), identical in purpose to the exchange's. */
  verify: {
    method: 'GET';
    pathAndQuery: string;
  };
}

/**
 * A TOKEN CLAIM — how a claim-once provider mints a credential from a one-time token the
 * user pastes (ADR-0038, TASK-20260818; SimpleFIN is the first occupant).
 *
 * WHY NEITHER SIBLING CAN CARRY THIS. The exchange's request body is PINNED REGISTRY
 * DATA and its response is walked by `secretPath`; a device link is three beats and a
 * poll. Here the pasted token IS the request target (a base64-encoded claim URL, POSTed
 * once with an empty body), the response BODY is the minted credential (an access URL
 * whose userinfo carries HTTP Basic credentials), and the mint fills TWO fields.
 * Overloading `secretPath` to mean "parse the body as a URL and split its userinfo"
 * would make one field mean two things — the exact reason `device-link` was
 * discriminated rather than folded into `exchange`.
 *
 * WHAT THIS SEAT DELIBERATELY CANNOT EXPRESS, inheriting the family discipline:
 *  - A HOST. The decoded claim URL and the returned access URL are checked AGAINST the
 *    connection's frozen ceiling (ADR-0023's binding order: approve → freeze → claim →
 *    verify); the pasted token is user-supplied data and is never trusted to name a
 *    destination. https-only, default port, empty userinfo on the CLAIM target,
 *    `redirect:'error'` on every request.
 *  - A HEADER TEMPLATE. The claim is uncredentialed by definition.
 *  - ARBITRARY RESPONSE HANDLING. The body is parsed by the URL API and refused unless
 *    its path is exactly `accessPath` — the base-path assumption is a checked invariant
 *    (fresh-context review Blocker 3), so a bridge minting under a different prefix
 *    refuses loudly at claim time instead of breaking silently mid-sync.
 *
 * CUSTODY (C1): the minted username/password go straight into `snug_secrets` under the
 * entry's own declared fields, written TOGETHER with the connected state by the function
 * that ran the verify (the `completeDeviceLink` lesson). The setup token is consumed and
 * never persisted; the claim response never enters app-, LLM-, or export-visible state.
 */
export interface WellKnownTokenClaimPairing {
  kind: 'token-claim';
  /** Label for the wizard's paste box — the provider's own name for the token. */
  tokenLabel: string;
  /**
   * Which of the entry's OWN declared `fields` the minted values fill — TWO seats,
   * named rather than an ordered array, because the basic_auth kind default reads
   * fields[0] as the username and fields[1] as the password and a mixed-up pair is a
   * credential that fails on every request while looking stored.
   */
  usernameField: string;
  passwordField: string;
  /**
   * The EXACT path the returned access URL must carry (leading '/', never a URL).
   * Checked, not hoped: any other path is a named refusal at claim time.
   */
  accessPath: string;
  /** Shown verbatim above the paste box — where the token comes from, and its one-use nature. */
  preconditionInstruction: string;
  /** THE VERIFY READ (ADR-0025), identical in purpose to both siblings'. */
  verify: {
    method: 'GET';
    pathAndQuery: string;
  };
}

/** Any pairing shape. Readers narrow on `kind` — never on which fields are present. */
export type WellKnownPairing =
  | WellKnownPairingExchange
  | WellKnownDeviceLinkPairing
  | WellKnownTokenClaimPairing;

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
  /**
   * Pinned scopes — undefined for every entry NOT recorded in ADR-0028. A pinned list
   * is reviewed registry data: emitted into the requirement, REPLACED over any authored
   * list on borrow hits, rendered by the wizard review/diff screens, and a change on an
   * approved row always re-consents (the drift migration refuses to promote it
   * silently). ENTRY-level only — options never carry scopes.
   */
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
  /**
   * Human-reviewed API hosts this provider's credential may be injected against.
   *
   * OPTIONAL since ADR-0023, and ONLY because of the `lanHost` fork below: the structural
   * rule is now "pinned `apiHosts` XOR `lanHost`", set-equality-pinned by
   * `well-known-providers.test.ts`. Every non-LAN entry still MUST carry a non-empty
   * list, and the same test refuses an entry that carries neither seat or both.
   */
  apiHosts?: string[];
  /**
   * LAN-CLASS HOST SOURCING — the entry declares that its host is COLLECTED FROM THE
   * USER rather than pinned (ADR-0023 Decision 1). A Philips Hue bridge's address is
   * assigned by the user's own router, so no human review could ever pin it.
   *
   * The seat rides through `requirementFromRegistryEntry` into the requirement's own
   * `lanHost` seat (protocol), which is what makes the pre-collection row representable
   * and what tells the wizard to render an address step. It carries NO address and never
   * will: the collected value lands in `declaredApiHosts`, the one seat
   * `deriveConnectionAllowedHosts` unions into the frozen ceiling.
   *
   * ENTRY-LEVEL ONLY, like `apiHosts` — for exactly the same reason ADR-0020 gives:
   * which hosts may receive a credential is a per-PROVIDER decision, never a per-flow
   * one. An `authOptions` entry may not declare a `lanHost`.
   */
  lanHost?: ConnectionLanHost;
  /**
   * How this provider's credential is MINTED when the user cannot type it (ADR-0023
   * Decision 2). Entry-level: the exchange belongs to the device, not to a flow.
   */
  pairing?: WellKnownPairing;
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
  /**
   * WEB-SURFACE redirect capability (ADR-0049 §1, TASK-20260822-gmail-dual-mode) — the
   * provider's client registration can accept the connecting web origin's
   * `/oauth/callback` as an exact Authorized redirect URI ('origin-callback', the sole
   * member today; gmail's "Web application" client type is the first case).
   *
   * RENDER-TIME REGISTRY DATA in exactly `desktopRedirectPosture`'s class (ADR-0021
   * §1): resolved at wizard render time when the runtime has no desktop OAuth
   * capability, NEVER emitted into a `ConnectionRequirement`, never persisted — which
   * is what keeps the seat protocol-free and drift-free. ENTRY-level only, and NOT an
   * `authOptions` flow BY STRUCTURE (web-surface-seats.test.ts): options are
   * discriminated by KIND, and a web flow shares `oauth2_auth_code` with the entry — a
   * same-kind option is invisible to `matchedRegistryOption`, inherits the entry's
   * loopback through `resolveDesktopPosture`'s fallback, and seeds the chat
   * AuthChoiceCard on every surface (the four blockers in ADR-0049's alternatives).
   * Requires `webRegistration` beside it, and vice versa — a posture without its
   * walkthrough leaves the register screen describing the wrong client type.
   */
  webRedirectPosture?: WebRedirectPosture;
  /**
   * The WEB-surface "register your app" walkthrough — same trust rules as
   * `registration` above (AL-04 D5: registry and explicit user entry are the ONLY
   * sources), same shape, rendered by the wizard's register screen INSTEAD of the
   * entry's (desktop) walkthrough when `webRedirectPosture` is declared and the
   * runtime has no desktop OAuth capability. Field definitions are deliberately NOT
   * duplicated here: the entry's `fields` serve both surfaces (gmail's
   * client_id/client_secret pair is identical across client types), and an edit to
   * pinned field copy stages a full re-credential drift walk for approved rows
   * (`fieldsMatchPinnedList` compares every property) — ADR-0049 §2.
   */
  webRegistration?: {
    consoleUrl?: string;
    instructions?: string[];
  };
}

/**
 * How a WEB page hands the provider's redirect back (ADR-0049 §1). One member today:
 * the playground origin's own `/oauth/callback` route, registered by the user as an
 * exact Authorized redirect URI on a web-capable client type.
 */
export type WebRedirectPosture = 'origin-callback';

const GOOGLE_ENDPOINTS = {
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
} as const;

/** Google needs these to return a refresh token; harmless nowhere else, so scoped here. */
const GOOGLE_AUTHORIZE_PARAMS = { access_type: 'offline', prompt: 'consent' } as const;

// The gmail walkthroughs' SHARED steps (ADR-0049 Gate-5 review): project creation, API
// enable, consent screen, and both provider traps are facts about the Google PROJECT,
// not the client type — so the desktop and web walkthroughs compose them from one
// definition (the same shared-constant pattern as GOOGLE_ENDPOINTS above) and differ
// only where the surfaces genuinely differ: the create-client step (application type +
// redirect registration) and the web-only custody disclosure.
const GMAIL_CONSOLE_URL = 'https://console.cloud.google.com/auth/clients';
const GMAIL_PROJECT_STEPS = [
  'Open the Google Cloud console (link above) and sign in with the SAME Google account whose mail you want to manage. If you have never used it before, accept the terms — it is free.',
  'Create a project: click the project dropdown in the top bar, choose "New project", give it any name (e.g. "My Snug Inbox"), and create it. This is YOUR project; Snug never sees it.',
  'Enable the Gmail API: search "Gmail API" in the console search bar, open it, and click "Enable". Without this step sign-in succeeds and every request is refused.',
  'Set up the consent screen: choose "External" user type, fill in an app name and your own email where asked, and add YOUR OWN email address under "Test users". Skip every optional field.',
] as const;
const GMAIL_TRAP_STEPS = [
  'When you first sign in, Google shows an "unverified app" warning — this is expected for a project only you use. Click "Advanced", then "Continue" to your app.',
  // VERIFIED 2026-08-19 against Google's OAuth refresh-token expiration rules: a
  // project left in "Testing" publishing status issues refresh tokens that expire
  // after 7 days. This is the one trap that presents as "Snug broke for no reason" a
  // week after a successful setup, so it is disclosed here with its fix.
  'One thing to know: while your project stays in "Testing" status, Google expires the connection after 7 days and you will be asked to sign in again. To avoid that, open the consent screen page and click "Publish app" — for a project only you use, no Google review is required.',
] as const;

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
    // ADR-0028 §4 (owner decision 2026-08-15, read + playback control) — ORDERED as the
    // consent screen renders them. A scope-less Spotify token can read only public data:
    // the starter's own `GET /v1/me/playlists` answered 403, surfaced as "the key may be
    // wrong, expired, or revoked". `user-read-email` deliberately excluded.
    //
    // AMENDED 2026-08-19 (TASK-20260819-connection-failure-ux, ADR-0028 §4 amendment):
    // `user-read-recently-played` joins the set. Rewind ships a COMPLETE recently-played
    // lane — `recentMetrics`, the recent-chips row, the second branch of the discovery
    // caption — that the original pin left unreachable, so the app made one read per
    // session that could only 403. The host's auth-shaped-failure observer cannot know a
    // refusal was expected, so a perfectly healthy connection raised the repair alarm on
    // every launch. Widening the pin is the honest fix: it makes shipped functionality
    // reachable rather than teaching the host to tolerate refusals. The tradeoff is the
    // ordinary one and the consent screen states it — listening history is readable by
    // any Snug app connected to Spotify.
    scopes: [
      'playlist-read-private',
      'playlist-read-collaborative',
      'user-read-private',
      'user-library-read',
      'user-top-read',
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-recently-played',
    ],
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
        // VERIFIED 2026-08-15 against Spotify's Feb-2026 policy update: Development mode
        // now allows at most FIVE allowlisted users (was 25), requires the app owner to
        // hold an active Premium subscription, and grants one Client ID per developer.
        // https://developer.spotify.com/blog/2026-02-06-update-on-developer-access-and-platform-security
        'New Spotify apps start in Development mode: sign in with the SAME Spotify account that owns this dashboard app, or add the listening account under "User Management" first (Spotify allows up to five). Anyone else completes sign-in but every request is refused (403).',
        'Development mode also requires the app owner to hold an active Spotify Premium subscription — a free-tier owner sees sign-in succeed and every request refused.',
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
    // ADR-0049 (TASK-20260822-gmail-dual-mode): VERIFIED by live probe 2026-08-21
    // (recorded in next-steps at the time) — `gmail.googleapis.com`, the exact host
    // pinned below, reflects an arbitrary `Origin` and its preflight allows
    // `authorization`, so a browser fetch with a Bearer token works from any web
    // origin. (The legacy `www.googleapis.com` alias answered the same, but the pin
    // names only the host this entry actually uses — lesson 2026-08-18: pin the host
    // you probed, and probe the host you pin.)
    browserCallable: true,
    // The WEB path (ADR-0049 §1/§4): a Google "Web application" client CAN register an
    // https web origin's callback — which is exactly what the Desktop-app client type
    // cannot, the fact that made this tile desktop-only at v1 (ADR-0039 §5). The OAuth
    // exchange still requires the client secret even with PKCE — probed 2026-08-21:
    // PKCE is code-injection protection, not client auth, and only native client types
    // skip the secret. Both seats are RENDER-TIME data for the wizard's register
    // screen; they never enter a requirement (web-surface-seats.test.ts).
    webRedirectPosture: 'origin-callback',
    apiHosts: ['gmail.googleapis.com'],
    authorizeParams: { ...GOOGLE_AUTHORIZE_PARAMS },
    // ADR-0039 (TASK-20260819-gmail-starter) — the SECOND ADR-0028 pin, and the entry
    // that turned this row from "resolvable" into "connectable": before this change the
    // Gmail journey dead-ended (no scopes → a token that reads nothing; no fields → a
    // wizard credential screen with zero inputs, since it renders `fields ?? []`).
    //
    // Three scopes, each load-bearing for the Inbox Copilot starter:
    //   gmail.modify        — the cleanup core: read, label, trash, mark-spam.
    //   gmail.settings.basic — auto-trash rules and sender blocking ARE Gmail FILTERS,
    //                          a settings resource; gmail.modify cannot create one.
    //   gmail.send          — the mailto: half of List-Unsubscribe, as a confirmed write.
    //
    // NOT pinned, deliberately: `https://mail.google.com/`. It is the only Gmail scope
    // that permits permanent deletion (`messages.delete`/`batchDelete`). Withholding it
    // makes "your mail is only ever moved to Trash" a property of the MINTED TOKEN
    // rather than a promise kept by app code (ADR-0039 D3).
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.settings.basic',
      'https://www.googleapis.com/auth/gmail.send',
    ],
    // BOTH credentials, unlike the Spotify entry above — and the difference is probed,
    // not assumed. PROBED 2026-08-19: Google's native-app documentation lists
    // `client_secret` as "Optional" in the code-exchange parameter table, but the token
    // endpoint REFUSES a Desktop-client exchange without it (`client_secret is missing.`)
    // even when a valid `code_verifier` is present. Google's own position is that an
    // installed app's secret "is not treated as a secret" — it ships inside every
    // distributed desktop binary — so collecting it is the provider's intended posture,
    // not a C1 compromise: it lives in the user's own file beside their tokens, never
    // enters the iframe, the LLM, or a publisher. GitHub's `oauth_app` option is the
    // in-repo precedent for a secret-collecting field. (The Coinbase lesson — a stale
    // docs page read as truth — is exactly why this was probed before the copy below
    // was written.)
    fields: [
      {
        key: 'client_id',
        label: 'Client ID',
        type: 'text',
        description: 'From the OAuth client you create below. Long, ends in .apps.googleusercontent.com.',
      },
      {
        key: 'client_secret',
        label: 'Client secret',
        type: 'password',
        description:
          'Shown beside the Client ID. Google issues one even for desktop apps and refuses sign-in without it. It stays in your own file.',
      },
    ],
    // Wizard-grade walkthrough — registry data, never wizard component copy (AL-04 D5).
    // Written for someone who has never opened Google Cloud Console: every step names
    // the screen, and the two provider traps are disclosed rather than discovered
    // (Spotify development-mode precedent).
    registration: {
      // VERIFIED 2026-08-19: Google's consolidated Auth Platform clients page — the
      // Cloud Console redirects the older /apis/credentials path here.
      consoleUrl: GMAIL_CONSOLE_URL,
      instructions: [
        ...GMAIL_PROJECT_STEPS,
        'Create the credentials: on the Clients page, click "Create client", choose application type "Desktop app", name it anything, and create. Copy the Client ID and the Client secret into the fields below — Google shows both, and desktop sign-in needs both.',
        ...GMAIL_TRAP_STEPS,
      ],
    },
    // The WEB walkthrough (ADR-0049 §4) — rendered INSTEAD of the block above when the
    // runtime has no desktop OAuth capability. Composed from the shared project/trap
    // steps above; the create-client step is where the surfaces genuinely differ
    // (application type "Web application" + the pasted redirect URI), and the final
    // step is the ADR-0049 §4 custody disclosure: one active client pair per app — a
    // completed web sign-in replaces a desktop sign-in held in the same file.
    webRegistration: {
      // Same consolidated Auth Platform clients page as the desktop walkthrough
      // (VERIFIED 2026-08-19; the client-type choice happens inside "Create client").
      consoleUrl: GMAIL_CONSOLE_URL,
      instructions: [
        ...GMAIL_PROJECT_STEPS,
        'Create the credentials: on the Clients page, click "Create client" and choose application type "Web application" — not "Desktop app"; only a web client can accept this page\'s address. Under "Authorized redirect URIs" click "Add URI" and paste the "redirect URI to register" shown below, exactly as displayed — Google matches it character for character. Then create, and copy the Client ID and the Client secret into the fields below; a web client refuses sign-in without its secret, even though this hub also uses PKCE.',
        ...GMAIL_TRAP_STEPS,
        'If you also connected Gmail from the Snug desktop app using this same Snug file: this hub keeps ONE Google sign-in per app, so completing this web sign-in replaces the desktop one (and vice versa) — you would simply reconnect when you switch surfaces.',
      ],
    },
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
  // the FROZEN ceiling via `deriveConnectionAllowedHosts`. NO `scopes` — a static-kind
  // credential has no consent screen to scope (and ADR-0028 pins scopes only where an
  // ADR records them).
  coinbase: {
    displayName: 'Coinbase',
    kind: 'api_key',
    optionLabel: 'API key (recommended)',
    aliases: ['Coinbase Pro'],
    // RETAIL OAUTH — the alternate way in (TASK-20260812-auth-kind-choice). Coinbase
    // also offers a standard OAuth2 authorization-code flow for retail accounts via
    // login.coinbase.com. It is NOT the default: the API-key surface is what the
    // founding starter targets (now via the pinned CDP signing template below), and
    // OAuth requires the user to register an OAuth2 app first. The user may still
    // choose it — the choice card offers both, and a choice persists on the `user`
    // channel. The option pins NO request/testRequest of its own: a sign-in flow
    // injects a token the OAuth service manages, never the api_key flow's JWT template.
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
    apiHosts: ['api.coinbase.com'],
    // VERIFIED 2026-08-12: api.coinbase.com does not answer browser CORS preflights —
    // the motivating case of the 2026-08-12 BYOK CORS advisory (docs/next-steps.md):
    // a browser hub gets an opaque "Failed to fetch"; desktop's native fetch is the
    // advisory's rung 2. The wizard discloses this BEFORE credentials are pasted.
    browserCallable: false,
    // THE CDP CREDENTIAL PAIR (ADR-0030, superseding ADR-0022 §5's EC-key pin).
    //
    // VERIFIED 2026-08-15 against Coinbase's JWT-authentication docs + their own
    // `coinbase-advanced-py` jwt_generator: retail/Advanced Trade authentication is a
    // CDP key — the key NAME (`organizations/{org}/apiKeys/{key}`, non-secret, rides
    // the JWT's kid/sub) plus an **Ed25519** secret that signs a fresh EdDSA JWT per
    // request, sent as `Authorization: Bearer`. Ed25519 is the portal's DEFAULT and
    // recommended key type; ECDSA (ES256) is Coinbase's documented legacy ("use only
    // when required by specific SDKs") and is deliberately NOT accepted here — a
    // legacy EC paste earns a fix-naming error (ed25519-key.ts). The 2026-08-12 recon
    // note claiming "Ed25519 keys are NOT accepted" read a stale docs page and was
    // WRONG — the inversion is the founding defect of TASK-20260815-coinbase-ed25519
    // (the portal's default key type was exactly what the wizard rejected).
    // The legacy retail HMAC keys EXPIRED provider-side on 2025-02-05; HMAC+passphrase
    // survives only on the institutional `api.exchange.coinbase.com` surface, which
    // stays dropped (ADR-0022, deliberately NOT an authOption).
    // https://docs.cdp.coinbase.com/get-started/authentication/jwt-authentication
    // https://github.com/coinbase/coinbase-advanced-py (jwt_generator.py)
    //
    // FIELD KEY `ed25519_private_key` IS LOAD-BEARING (ADR-0030 §4): the drift and
    // re-approve digests read field KEYS only, so the rename — not a relabel — is what
    // makes an EC-era saved row refuse re-admission and walk the credential half again.
    fields: [
      {
        key: 'api_key',
        label: 'API key name (organizations/…/apiKeys/…)',
        type: 'text',
        description: 'The full key name shown when you created the key — the organizations/…/apiKeys/… path, not a display label.',
      },
      {
        key: 'ed25519_private_key',
        label: 'Ed25519 private key (secret)',
        type: 'secret',
        description:
          'The API key secret from the portal — paste the base64 secret exactly as delivered, or the whole PEM key file (BEGIN/END lines included).',
      },
    ],
    // WHERE the credential goes — the pinned CDP signing template (ADR-0022 §1,
    // ADR-0030). `cdp_jwt` mints the EdDSA JWT host-side per request
    // (template-engine.ts); both arguments are declared field keys by the helper's own
    // lint rule. This seat is exactly what Guard 2b refuses borrowers for authoring:
    // with it pinned here, the executor stops falling to the generic `X-Api-Key` kind
    // default that made the saved credential dead weight.
    request: {
      headerTemplate: { Authorization: 'Bearer {{cdp_jwt(api_key, ed25519_private_key)}}' },
    },
    // HOW the connection is verified — the wizard's "test this connection" probe:
    // GET https://api.coinbase.com/api/v3/brokerage/accounts (host from apiHosts; a
    // credentialed read that 401s on bad credentials instead of silently "connecting").
    testRequest: { method: 'GET', pathAndQuery: '/api/v3/brokerage/accounts' },
    registration: {
      // The CDP portal — the same console the OAuth option cites; retail Settings→API
      // no longer issues keys for this surface (VERIFIED 2026-08-12, sources above).
      consoleUrl: 'https://portal.cdp.coinbase.com/',
      instructions: [
        'Sign in to the Coinbase Developer Platform (link above) with your Coinbase account and open (or create) a project.',
        'Open API keys and create a new Secret API key with VIEW (read-only) permission — this app never needs to trade.',
        'Keep the Ed25519 key type (the portal default). Do NOT switch to ECDSA — that is Coinbase’s legacy format and will not work here.',
        'Copy or download the key secret when it is offered: Coinbase shows it only once.',
        'Paste the key name (the organizations/…/apiKeys/… path) and the Ed25519 secret (the base64 string, or the whole PEM file) into the fields below.',
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
    //
    // WHERE THAT PLACEMENT IS PINNED (TASK-20260812-desktop-auth-awareness P4, ADR-0022 §3):
    // the `request.queryTemplate` seat below. Until P4 this comment described a mechanism
    // with no data behind it — the executor fell to the `api_key` kind default and sent a
    // meaningless `X-Api-Key` header while OpenWeather read a query parameter that was
    // never there, so weather-planner was broken at credential injection (spec item 5).
    // The executor renders this AFTER every ceiling check and scrubs the rendered value
    // from error strings, logs, inspector payloads and net-result echoes (C1).
    // VERIFIED 2026-08-13 (live + primary docs): `appid` is the documented query parameter
    // (https://openweathermap.org/current — "appid required: Your unique API key").
    fields: [
      {
        key: 'api_key',
        label: 'API key',
        type: 'secret',
        description: 'Your OpenWeather API key. New keys can take a couple of hours to activate.',
      },
    ],
    request: {
      queryTemplate: { appid: '{{api_key}}' },
    },
    // HOW the connection is verified — the wizard's "test this connection" probe.
    // Current conditions for one city: the cheapest free-tier read OpenWeather offers,
    // and it EXERCISES the credential rather than merely reaching the host. VERIFIED
    // live 2026-08-13: without a valid `appid` it answers 401 with
    // `{"cod":401,"message":"Invalid API key…"}` (https://openweathermap.org/faq#error401),
    // so a typo'd or not-yet-active key fails the probe instead of reporting connected.
    // (OpenWeather marks `q=` city lookups deprecated-but-functional in favour of
    // lat/lon geocoding; kept here because the probe needs no geocoding round trip and
    // the starter itself uses the same call.)
    testRequest: { method: 'GET', pathAndQuery: '/data/2.5/weather?q=London' },
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
    // WHERE the credential goes (TASK-20260812-desktop-auth-awareness P4, ADR-0022 §3).
    //
    // VERIFIED 2026-08-13 against the primary docs
    // (https://docs.coingecko.com/reference/authentication) AND a live probe: the DEMO
    // tier lives on `api.coingecko.com` and accepts its key EITHER as the query parameter
    // `x_cg_demo_api_key` OR as the header `x-cg-demo-api-key`. (The paid tier is a
    // different host and a different key name — `pro-api.coingecko.com` /
    // `x_cg_pro_api_key` — deliberately not carried here; the free Demo plan is what this
    // entry and its starter are for.)
    //
    // The QUERY form is chosen deliberately, for ONE platform-independence reason that
    // survived verification:
    //   * A query parameter is a SIMPLE request — it triggers no CORS preflight at all,
    //     on any host, ever. It cannot break on a provider's preflight policy because it
    //     never asks for one.
    // REFUTED, and recorded so it is not re-litigated: this task's plan asserted the
    // header form was unusable because `x-cg-demo-api-key` is absent from CoinGecko's
    // preflight allow-list. A live OPTIONS probe on 2026-08-13 disproved it — CoinGecko
    // reflects the requested header back in `access-control-allow-headers`, so BOTH forms
    // work from a browser today. The query form is still the right pin (it depends on no
    // reflective-CORS behaviour that CoinGecko could tighten without notice), but the
    // reason is preflight-independence, not a CORS wall that does not exist.
    //
    // NO `testRequest` — a DELIBERATE omission, not an oversight. `api.coingecko.com` is a
    // documented "Keyless Public API" (https://docs.coingecko.com/docs/keyless-public-api):
    // /ping, /simple/price and the rest answer 200 with NO key, and a demo key only raises
    // the rate-limit ceiling. Every candidate probe on this host therefore reports
    // CONNECTED for a typo'd key — worse than no probe, because it launders a broken
    // connection into a green checkmark. The one key-requiring endpoint, `/api/v3/key`, is
    // Pro-plan-only on the OTHER host (live probe on the demo host: 401 error_code 10005,
    // "limited to PRO API subscribers") — it would fail for every CORRECT demo key and sits
    // off this entry's ceiling besides. The wizard shows no "test this connection" button
    // for CoinGecko rather than one whose result means nothing. Revisit if CoinGecko ever
    // key-gates the demo host.
    request: {
      queryTemplate: { x_cg_demo_api_key: '{{api_key}}' },
    },
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
  // ─────────────────────────────────────────── the first LAN-CLASS entry (ADR-0023, P5)
  //
  // Philips Hue is the entry that forced the host fork. Every other entry pins hosts a
  // human reviewed; a Hue bridge sits at an address the USER's router assigned, so there
  // is nothing to pin and never will be. Hence `lanHost` INSTEAD of `apiHosts` — the
  // registry declares that a host will be collected, the wizard collects and validates
  // it (RFC-1918 IPv4 literal only), and the collected address freezes into the ceiling
  // exactly like a pinned one.
  //
  // THE THREE ADMISSION CONSEQUENCES, each probe-verified as blocking before this entry
  // could exist (P0 amendment 10; see `lan-class-registry.test.ts` for the probe output):
  // `registryHostIndex` must SKIP an apiHosts-less entry (otherwise this row makes every
  // admission of every requirement throw), `applyRegistryValues` must PRESERVE the
  // declaration's hosts for a LAN entry (otherwise it deletes the address the user just
  // typed), and admission must RE-VALIDATE the host class (otherwise a borrower smuggles
  // a public host under this brand).
  //
  // PROVIDER FACTS (task recon, 2026-08-12, primary docs + live probes):
  //  - CLIP v2 is HTTPS-ONLY on the bridge. The cert's CN is the bridgeId, signed by
  //    Signify's private CA on current firmware and self-signed on older ones, so native
  //    fetch refuses it — hence ADR-0023's TOFU pin captured at pairing and the desktop
  //    `lan_fetch` command. That transport is the DESKTOP lane's; this entry is the
  //    declaration it serves.
  //  - The credential is MINTED, not issued: press the bridge's physical link button,
  //    then POST /api {"devicetype":…,"generateclientkey":true} within ~30 seconds and
  //    the bridge returns success[0].username — the value the `hue-application-key`
  //    header carries. (`clientkey` comes back too; it is the Entertainment-API stream
  //    key, unused at v1 and deliberately not stored.)
  //  - https://developers.meethue.com/develop/hue-api-v2/getting-started/
  hue: {
    displayName: 'Philips Hue',
    kind: 'api_key',
    // The names a person actually writes for this device. Both are brand-adjacent by
    // `findBrandAdjacentRegistryKeys` anyway (they contain the `hue` segment), so the
    // BAN already reaches them; the aliases are what let the INFERRER's rung 1 resolve
    // them to this entry instead of guessing a requirement.
    aliases: ['Philips Hue', 'Hue Bridge'],
    // NO `apiHosts` — the XOR. See `lanHost` below.
    lanHost: { class: 'rfc1918-ipv4-literal', label: 'Bridge IP address' },
    // VERIFIED: the bridge serves a private-CA/self-signed certificate on a private IP.
    // A browser page cannot reach it — no CORS headers, and the cert fails the browser's
    // own chain check with no per-host trust escape. This is a DESKTOP-only provider and
    // the wizard discloses that before anything is collected (the disclosedBrowserWall
    // pattern; ADR-0023 Decision 1 keeps the ROW portable — web discloses, never breaks).
    browserCallable: false,
    // ONE field, and the user never types into it. It exists so the secret has a named
    // slot in `snug_secrets` and the header template has a key to reference; the PAIRING
    // exchange below fills it. The copy says so plainly — telling the user to "paste
    // your application key" would send them hunting for a value no Hue surface displays.
    fields: [
      {
        key: 'application_key',
        label: 'Bridge application key',
        type: 'secret',
        description:
          'Created for you when you press the link button — Snug asks the bridge for it during setup. There is nothing to look up.',
      },
    ],
    // WHERE the minted key goes: CLIP v2's own header. Never a query parameter, never a
    // bearer token — the bridge reads exactly this name.
    request: {
      headerTemplate: { 'hue-application-key': '{{application_key}}' },
    },
    // NO `testRequest`, deliberately (same discipline as coingecko's omission at P4):
    // every CLIP v2 read requires the key the pairing step mints, so a probe before
    // pairing can only fail and a probe after it merely repeats what pairing proved. No
    // button beats a meaningless one — pairing IS the verification.
    //
    // THE PAIRING EXCHANGE (ADR-0023 Decision 2). Runs against the connection's own
    // frozen ceiling host, after approval, over the desktop pinned-TLS command in
    // `mode:'pair'`. The minted value goes straight to `snug_secrets`.
    pairing: {
      // The discriminant, explicit since ADR-0032 added `device-link`. Hue's shape is
      // otherwise unchanged byte for byte.
      kind: 'exchange',
      method: 'POST',
      pathAndQuery: '/api',
      body: { devicetype: 'snug#hub', generateclientkey: true },
      /*
        THE WALK, CORRECTED AGAINST THE WIRE (TASK-20260812 P5-flow; supersedes the
        pinned literal's spelling, journaled in the task file).

        The task file pins this as `success[0].username`, and P5-shape encoded that
        prose reading literally as `['success', 0, 'username']`. The prose is
        ambiguous and the encoding inverted it: a CLIP v1 pairing response is an
        ARRAY OF RESULT OBJECTS, outermost —

            [{"success":{"username":"…","clientkey":"…"}}]

        — so the index comes FIRST. Probed both ways against a real-shaped body
        before changing anything: `['success', 0, 'username']` resolves to
        `undefined` on every real response, which would have made pairing fail
        forever with "the device did not hand back a key" while the bridge was
        answering perfectly. The registry's own comment above already described the
        array-outermost shape, and the desktop lane's fixtures already used it — the
        PATH was the only thing that disagreed with the wire, and it disagreed
        invisibly because the one test pinning it asserted the array verbatim rather
        than walking a response with it (lesson 2026-08-04: assert the outcome).
      */
      secretPath: [0, 'success', 'username'],
      secretField: 'application_key',
      preconditionInstruction:
        'Press the link button — the big round button on top of your Hue bridge — now, then continue within 30 seconds. The bridge only hands out a key during that window.',
      // THE VERIFY READ (ADR-0025): CLIP v2's bridge resource — the one read every
      // bridge serves, and it 401/403s without a valid `hue-application-key`, so an
      // unauthenticated 200 cannot fake it. Verified against the live API docs at the
      // original task recon (2026-08-12) and re-checked for this seat: the response is
      // read for its STATUS only, so its body shape can drift freely.
      verify: { method: 'GET', pathAndQuery: '/clip/v2/resource/bridge' },
    },
    registration: {
      // No console, no account, no developer portal: the "registration" for a Hue bridge
      // is finding it on your own network and pressing its button. Written for someone
      // who has never opened a router page.
      instructions: [
        'Make sure this computer and the Hue bridge are on the same home network — the bridge is the round white box plugged into your router.',
        'Find the bridge IP address: open the Philips Hue app, go to Settings → My Hue System → tap your bridge, and read the "IP address" line (it looks like 192.168.1.50). "Find my bridge" below can also look it up for you.',
        'Type that address into the field below and continue.',
        'When Snug asks, press the link button — the big round button on top of the bridge — because that is how the bridge knows it is really you standing next to it.',
        'Continue within 30 seconds of pressing it. The bridge creates the key itself; there is nothing for you to copy or paste.',
      ],
    },
  },

  /**
   * WhatsApp Personal via a linked device (ADR-0032, TASK-20260816) — the first
   * `linked_device` entry, and the reason the kind exists.
   *
   * WHAT IS ACTUALLY CONNECTED HERE. Not "WhatsApp's API": personal WhatsApp has no public
   * one. Snug runs a local helper (the sidecar) that links to the user's account exactly the
   * way WhatsApp Web does — the user scans a QR with their phone — and thereafter holds the
   * session. The credential THIS ROW governs is the token that lets the hub talk to that
   * helper. The WhatsApp session material never reaches the hub at all, which is what keeps
   * C1 honest: compromising everything Snug stores does not yield the user's WhatsApp.
   *
   * WHY THE HOST IS SYMBOLIC. The helper listens on a unix socket, not a network address.
   * The pinned host below exists because a connection row must name a ceiling — it is an
   * IDENTITY for the connection, resolved by the desktop transport, and it is never dialled
   * as DNS. This is deliberate: an earlier draft gave the sidecar a loopback address, which
   * (the ceiling being host-granular, with no port) would have granted every loopback port on
   * the machine. A name that resolves to nothing cannot be dialled by accident.
   *
   * TERMS OF SERVICE, STATED PLAINLY. Automating personal WhatsApp through a linked device
   * is contrary to WhatsApp's terms, and accounts do get banned for it. That is disclosed in
   * `instructions` below (which the wizard renders verbatim before anything is collected) and
   * again in the starter's README. The pacing and rate limits elsewhere in this task are
   * there to keep automated behaviour humane and low-volume — they are not, and must never be
   * described as, a way to avoid detection.
   */
  // KEY IS `whatsapp`, NOT `whatsapp-personal` — and the distinction is load-bearing, not
  // cosmetic. BOTH resolution rungs key on the NORMALIZED registry key:
  // `lookupWellKnownProvider` does `REGISTRY[normalizeProviderKey(name)]`, which strips
  // non-alphanumerics, and `findBrandAdjacentRegistryKeys` joins name segments and asks
  // `Object.hasOwn(REGISTRY, run)`. `normalizeProviderKey('WhatsApp')` is `whatsapp`, so a
  // hyphenated key is reachable by NEITHER — the borrow ban would never fire for the
  // WhatsApp brand, and a declaration claiming the name while aiming the credential at
  // another host would be admitted. Caught by a red test, and it is ADR-0023's P6
  // amendment repeating (hue's rows persist `'Philips Hue'`, which normalizes to
  // `philipshue`, not the key `hue`). `displayName` carries the human spelling.
  whatsapp: {
    displayName: 'WhatsApp',
    kind: 'linked_device',
    // Aliases are for spellings the KEY does not already answer. `'WhatsApp'` is NOT one:
    // it normalizes to `whatsapp`, which IS this entry's key, so listing it would shadow
    // the exact-hit rung with an alias — refused by the self-containment suite, and rightly
    // (an alias that shadows a key silently re-routes a resolution that already worked).
    // The inferrer is separately forbidden from ever PROPOSING this kind.
    aliases: ['WhatsApp Personal', 'WhatsApp Web'],
    // A symbolic identity, not a routable name — see the comment above. `.localhost` is
    // reserved by RFC 6761 precisely so it can never be a real public host.
    apiHosts: [SIDECAR_SYMBOLIC_HOST],
    // A unix socket cannot be reached from a browser tab. Disclose, never dead-end.
    browserCallable: false,
    // One field the user never types: the sidecar token, minted by the link below.
    fields: [
      {
        key: 'sidecar_token',
        label: 'Helper access token',
        type: 'secret',
        description:
          'Created for you when you link your phone — Snug and the helper agree on it during setup. There is nothing to look up.',
      },
    ],
    request: {
      headerTemplate: { authorization: 'Bearer {{sidecar_token}}' },
    },
    // No `testRequest`: every read needs the token the link mints, so a probe before
    // linking can only fail, and after it merely repeats what `verify` already proved.
    // Same discipline as the hue entry's omission.
    pairing: {
      kind: 'device-link',
      startPathAndQuery: '/pair/start',
      qrPathAndQuery: '/pair/qr',
      pollPathAndQuery: '/pair/status',
      // A human is walking to their phone, so poll politely and give them long enough to
      // find the menu. WhatsApp rotates the QR on its own schedule; the wizard re-reads
      // `qrPathAndQuery` each tick rather than assuming the first payload stays valid.
      pollIntervalMs: 2_000,
      pollTimeoutMs: 180_000,
      secretField: 'sidecar_token',
      preconditionInstruction:
        'On your phone, open WhatsApp → Settings → Linked devices → Link a device, then scan the code below. This adds Snug as a linked device, exactly like WhatsApp Web — your phone stays in charge and you can unlink it there at any time.',
      // ADR-0025 verify-before-claim: prove the token against the helper before anything
      // says "connected".
      verify: { method: 'GET', pathAndQuery: '/session/status' },
    },
    registration: {
      // No console and no developer account — the "registration" is installing the helper
      // and scanning a code. Written for someone who has never heard of a sidecar, and
      // leading with the honest warning rather than burying it.
      instructions: [
        'Please read first: linking an automation tool to a personal WhatsApp account is against WhatsApp’s terms of service, and accounts have been banned for it. Only continue if you accept that risk on this account.',
        'This works in the Snug desktop app only — the helper runs on your own computer and is not reachable from a browser tab.',
        'Snug starts the helper for you. Nothing is sent anywhere: your WhatsApp session stays on this machine, and Snug itself only ever holds a key to the helper.',
        'When the code appears, open WhatsApp on your phone → Settings → Linked devices → Link a device, and scan it.',
        'Keep the desktop app open while you use the app — the linked session lives with the helper, and your phone can unlink it at any time.',
      ],
    },
  },

  simplefin: {
    displayName: 'SimpleFIN',
    kind: 'basic_auth',
    // `'SimpleFIN'` normalizes to this entry's key, so only the added-word spelling is
    // an alias (the whatsapp shadowing lesson).
    aliases: ['SimpleFIN Bridge'],
    // EXACTLY ONE host, and the singleton is load-bearing (review Blocker 2): symbolic
    // `snug-connection://` resolution refuses a ceiling that is not exactly one host,
    // and the declared test probe fires at `allowedHosts[0]`.
    //
    // WHY `beta-` IS THE PRODUCTION HOST (owner-found on the first real walk,
    // 2026-08-18): `bridge.simplefin.org` is a 302 ALIAS to
    // `beta-bridge.simplefin.org` — the "beta" name is historical; it is where the
    // accounts live, where setup tokens are minted, and where their decoded claim URLs
    // point. The first pin used the alias, so every REAL token refused at the ceiling
    // gate with "points somewhere other than the SimpleFIN Bridge". Verified by probe:
    // `curl -sI https://bridge.simplefin.org/` → `302 Location:
    // https://beta-bridge.simplefin.org/`.
    apiHosts: ['beta-bridge.simplefin.org'],
    // VERIFIED 2026-08-18 by live probe AGAINST THIS HOST: OPTIONS and GET
    // /simplefin/accounts echo an arbitrary Origin with `access-control-allow-headers:
    // authorization` and credentials allowed; the claim POST returns CORS headers and
    // is preflight-free (empty body, no custom headers).
    browserCallable: true,
    // Two fields the user never types: the claim below parses them out of the minted
    // access URL. Injection ORDER is the contract — the basic_auth kind default reads
    // fields[0] as the username and fields[1] as the password.
    fields: [
      {
        key: 'username',
        label: 'Access ID',
        type: 'text',
        description:
          'Created for you when Snug claims your setup token — there is nothing to look up.',
      },
      {
        key: 'password',
        label: 'Access key',
        type: 'secret',
        description:
          'Created together with the Access ID during the claim. Both live in your own Snug file, never on a server.',
      },
    ],
    // NO `request` seat, deliberately: the basic_auth kind default produces the
    // `Authorization: Basic` header, and a request seat would SUPPRESS it (ADR-0022).
    // The bridge serves under /simplefin (probed 2026-08-18); `balances-only=1` keeps
    // the probe cheap, and the bridge's 403-on-bad-credentials is what makes it a GOOD
    // probe (the CoinGecko anti-lesson).
    testRequest: { method: 'GET', pathAndQuery: '/simplefin/accounts?balances-only=1' },
    pairing: {
      kind: 'token-claim',
      tokenLabel: 'SimpleFIN setup token',
      usernameField: 'username',
      passwordField: 'password',
      accessPath: '/simplefin',
      preconditionInstruction:
        'In SimpleFIN Bridge, create a new app connection and copy the whole setup token — a long block of letters and numbers. It works exactly once and expires quickly, so paste it here soon after copying. Snug trades it for a permanent access key stored in your own file.',
      // ADR-0025 verify-before-claim, at the SAME spelling as `testRequest` — one path,
      // two seats, zero drift.
      verify: { method: 'GET', pathAndQuery: '/simplefin/accounts?balances-only=1' },
    },
    registration: {
      consoleUrl: 'https://beta-bridge.simplefin.org/',
      instructions: [
        'Create a SimpleFIN Bridge account at beta-bridge.simplefin.org — a small paid service (about $1.50 a year) built exactly for apps like this. Your banks connect to SimpleFIN, and SimpleFIN hands apps read-only data.',
        'Inside SimpleFIN Bridge, choose "Connect a bank" and sign in to each bank or credit-card provider you want the app to see. Your bank passwords stay with SimpleFIN — they never touch Snug. You can add more banks later.',
        'When your banks are connected, create a new app connection — SimpleFIN calls this a setup token.',
        'Copy the whole setup token and paste it on the next screen. It works exactly once and expires quickly, so paste it soon after copying.',
        'Snug trades the token for a permanent read-only access key and stores it in your own file. To disconnect later, revoke the app inside SimpleFIN Bridge, or delete the connection here — both work.',
      ],
    },
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
 * WHICH REGISTRY ENTRY DOES THIS PROVIDER NAME REACH? — the NAME half of the
 * borrow resolution, exported so there is exactly one of it.
 *
 * WHY IT LEFT `requirement-admission.ts` (TASK-20260812 P5-flow). Admission
 * resolves `'Philips Hue'` to the `hue` entry through the brand-adjacent
 * fallback and substitutes its pinned seats onto the row; the wizard then needs
 * the SAME entry to read its `pairing` exchange. Re-deriving that inside the
 * wizard would be a second resolution of the same question — and the 2026-08-12
 * lesson is precise about the failure mode: when a rule is evaluated twice, the
 * two copies eventually disagree, and here disagreement means the wizard pairing
 * with a device using one entry's exchange while the row carries another
 * entry's template. So the rule moved here, admission calls it, and the wizard
 * calls it.
 *
 * TWO RUNGS, in this order and no other:
 *  1. EXACT after normalization — the resolution path. `lookupWellKnownProvider`
 *     answers "which provider's pinned values should this use", so a legitimate
 *     `Google Drive` resolves to `googledrive` and never to `google`.
 *  2. BRAND-ADJACENT — the ban path's boundary-aware segment match, which is
 *     what catches `Spotify Inc`, `CoinbaseInc` and the human spellings of a
 *     LAN device (`Philips Hue`, `Hue Bridge` → `hue`). Sorted, first taken, so
 *     the answer is stable rather than dependent on registry insertion order.
 *
 * The HOST rung stays in admission: it reads a requirement's declared hosts,
 * which is a requirement-shaped question this module has no business knowing.
 */
export function resolveRegistryEntryByName(
  name: string,
): { key: string; entry: WellKnownOauthProvider } | undefined {
  const entry = lookupWellKnownProvider(name);
  if (entry !== undefined) {
    const key = Object.entries(REGISTRY).find(([, value]) => value === entry)?.[0];
    if (key !== undefined) return { key, entry };
  }
  for (const key of findBrandAdjacentRegistryKeys(name).sort()) {
    const adjacent = REGISTRY[key];
    if (adjacent !== undefined) return { key, entry: adjacent };
  }
  return undefined;
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
    // THE HOST FORK (ADR-0023 Decision 1) — pinned hosts XOR a lanHost declaration, and
    // the emitter honors whichever the ENTRY carries (never an option's: hosts are an
    // identity seat, and a LAN seat is a host seat).
    //
    // A LAN entry emits NO `declaredApiHosts` at all. That is the PRE-COLLECTION shape:
    // the requirement is honest that it has no host yet, `deriveConnectionAllowedHosts`
    // returns an empty ceiling that refuses everything, and the wizard's address step is
    // what fills the seat. Emitting a placeholder would be the same lie the endpoints
    // comment above refuses — a nonexistent host unioned into a frozen ceiling.
    //
    // Deep-copied like every other seat: the registry is a module singleton.
    ...(entry.lanHost !== undefined ? { lanHost: { ...entry.lanHost } } : {}),
    ...(entry.apiHosts !== undefined ? { declaredApiHosts: [...entry.apiHosts] } : {}),
    // SCOPES ARE AN IDENTITY SEAT (ADR-0028): read from the ENTRY, never an option —
    // privilege breadth is a per-PROVIDER decision exactly like which hosts receive the
    // credential, and a flow choice must never move it. Emitted only for the flows that
    // CONSUME scopes (Gate-5 review): a static-kind flow under a scope-pinned entry has
    // no consent screen for them, and carrying the seat anyway is what made static rows
    // stage a meaningless "what this sign-in may do" diff. Deep-copied like every seat.
    ...(entry.scopes !== undefined && (flow.kind === 'oauth2_auth_code' || flow.kind === 'oauth2_client_creds')
      ? { scopes: [...entry.scopes] }
      : {}),
  };
}
