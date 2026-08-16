// demoRequirement.ts — deterministic demo-brain variants for the P3 connection-wizard
// e2e, gated behind the `?demoreq=<variant>` URL flag (the `?webllm=1` / `?demoauth=`
// precedent: a URL-flag seam with zero footprint when absent).
//
// A TEST SEAM KEPT ON PURPOSE, and separate from `?demoauth=` rather than replacing it:
// the v3 variants emit `auth_wizard` directives against a surface whose deletion is not
// this phase's business, so the two flags coexist. The REAL builder teaching lives in the
// ADR-0004 store (knowledge-base/app-authoring/90-auth-and-connected-apis.md), and the
// taught emission format is sync-tested against the real scanner.
//
// Every requirement here is built from protocol constants and must survive the FULL
// production path — `connectionRequirementSchema`, `admitConnectionRequirement`, the
// template lint, and `putDeclaredConnection` — because the e2e asserts the real pipeline
// end to end. A variant that only passed a hand-written parser would prove nothing.
//
// STUB-HOST PATTERN (AL-03/AL-04, unchanged): the AUTHORED hosts are the REAL provider
// hosts. An e2e that authored `stub.snug.test` would prove the wizard works on a host no
// real app ever declares, which is the opposite of what these journeys are for.

import {
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  PROTOCOL_VERSION,
  type ConnectionRequirement,
} from '@snugprotocol/protocol';
import type { MockTurn } from '@snugprotocol/adapters';

import { ARTIFACT_WRITE_TOOL_NAME } from './tools.js';

/**
 * `undeclared` is the RECOVERY variant (fold): a connected app written with NO
 * `connection_requirement` directive at all. It is the one case the build-time inferrer
 * exists for — the app calls `useConnectedFetch` but the model closed its reply without
 * declaring anything, so every net call would resolve `{ ok: false }` forever and no
 * connect card could render. It is a variant rather than a hand-built input because the
 * assertion that matters is that the PRODUCTION post-turn seam reaches the inferrer; a
 * test that constructed the pipeline call itself would go green over a severed wire, which
 * is exactly the defect this variant was added to make impossible.
 */
export type DemoBuildVariant = 'coinbase' | 'bearer' | 'basic' | 'oauth' | 'undeclared';

/**
 * The STARTER variants (P4-AC10), each named for the example folder whose shipped
 * manifest it mirrors. `hue` is absent BY DESIGN: Hue declares nothing (AL-09 D10), so
 * there is no requirement for a demo brain to emit and a variant would be a fiction.
 *
 * These are an EXTENSION, never a replacement — the P3 build variants above drive the
 * wizard e2e and must keep resolving untouched.
 */
export type DemoStarterVariant =
  | 'starter-coinbase'
  | 'starter-openweather'
  | 'starter-github'
  | 'starter-spotify';

export type DemoRequirementVariant = DemoBuildVariant | DemoStarterVariant;

const STARTER_VARIANTS = [
  'starter-coinbase',
  'starter-openweather',
  'starter-github',
  'starter-spotify',
] as const;

const VARIANTS = new Set<string>([
  'coinbase',
  'bearer',
  'basic',
  'oauth',
  'undeclared',
  ...STARTER_VARIANTS,
]);

/** The active `?demoreq` variant, read per call (never cached across navigations). */
export function demoRequirementVariant(): DemoRequirementVariant | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('demoreq');
  return value !== null && VARIANTS.has(value) ? (value as DemoRequirementVariant) : null;
}

/**
 * A bridge-speaking app that fires ONE net-request at the e2e https stub.
 *
 * THE PORT IS THE WHOLE REMAP. The app dials the host the requirement DECLARES —
 * `api.meridian-exchange.example`
 * — which is what the user reviews and freezes, so the
 * journey exercises a ceiling a real app would actually have. Only the resolution is
 * local: the connection-wizard Playwright project maps that name to 127.0.0.1, and the
 * non-default port picks the stub's listener. An e2e that authored `stub.snug.test` would
 * prove the wizard works on a host no real app declares, which is the opposite of the point.
 */
const NET_DEMO_APP_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>connected app</title></head>
<body>
<div id="status">connecting</div>
<div id="net-status"></div>
<pre id="net-out"></pre>
<script>
(function () {
  var V = 1;
  var instanceId = null;
  var sent = false;
  function setText(id, text) { document.getElementById(id).textContent = text; }
  window.addEventListener('message', function (event) {
    var d = event.data;
    if (!d || d.v !== V) return;
    if (d.type === 'snug:host-ready') {
      instanceId = d.instanceId;
      setText('status', 'ready:net=' + (d.capabilities && d.capabilities.net));
      if (!sent) {
        sent = true;
        parent.postMessage({ v: V, type: 'snug:app-announce', appId: 'demo-connected-app',
          displayName: 'connected app', iconColor: '#3ba36f' }, '*');
        parent.postMessage({ v: V, type: 'snug:net-request', requestId: 'net-1',
          instanceId: instanceId, url: 'https://api.meridian-exchange.example:43120/v2/accounts', method: 'GET' }, '*');
      }
      return;
    }
    if (d.type === 'snug:net-response' && d.requestId === 'net-1') {
      setText('net-status', d.ok ? ('ok:' + d.status) : ('err:' + d.error.code));
      setText('net-out', d.ok ? d.body : JSON.stringify(d.error));
      return;
    }
  });
})();
</script>
</body></html>`;

/**
 * The UNDECLARED app: it reaches the connected surface via the bridge hook and names the
 * provider host in its own code, and NOTHING declares what that connection needs. Those
 * two facts are exactly what the recovery path reads — `htmlUsesConnectedFetch` to know
 * the app is broken, and the first absolute URL to know which provider to ask about — so
 * the fixture carries both and nothing else.
 */
const UNDECLARED_CONNECTED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>my playlists</title></head>
<body>
<div id="net-status"></div>
<script>
(function () {
  var conn = useConnectedFetch('spotify');
  conn.fetch('https://api.spotify.com/v1/me/playlists').then(function (r) {
    document.getElementById('net-status').textContent = r.ok ? 'ok' : 'err';
  });
})();
</script>
</body></html>`;

/**
 * The four shapes the wizard must carry. The Coinbase variant is the MOTIVATING DEFECT
 * in fixture form — three fields and an HMAC-signed header template, exactly the shape
 * v3's `llmProposalSchema` could not express.
 */
const REQUIREMENTS: Record<Exclude<DemoBuildVariant, 'undeclared'>, Record<string, unknown>> = {
  /**
   * THE MOTIVATING DEFECT IN FIXTURE FORM: three distinct secrets and an HMAC-signed
   * header template — exactly the shape v3's `llmProposalSchema` could not express.
   *
   * IT NAMES AN UNPINNED PROVIDER — "Meridian Exchange" on
   * `api.meridian-exchange.example` — and that is load-bearing rather than incidental.
   *
   * P4 pinned a `coinbase` REGISTRY ENTRY, and P5 widened the registry-borrow ban to
   * BRAND-ADJACENT names (`findBrandAdjacentRegistryKeys`). Under that ban any name
   * carrying the "coinbase" segment — plain "Coinbase", and "Coinbase Exchange" too —
   * is a borrow, so a variant that also authors its own `fields` and `headerTemplate` is
   * REFUSED by Guard 2b. That refusal is correct: credential-prompt copy rendered beside
   * a registry-grade brand is exactly what substitution would otherwise legitimize.
   *
   * The earlier "Coinbase Exchange is a genuinely different product, so this is honest"
   * reasoning is deliberately NOT preserved. It is true about the world and useless as a
   * guard: admission cannot verify that a brand-adjacent name belongs to a real
   * neighbouring product, and an attacker's "Coinbase Pro" makes exactly the same claim.
   * A genuinely different provider earns a registry entry of its own through a reviewed
   * PR; a FIXTURE just needs a name it does not have to borrow.
   *
   * So the variant moved to an unpinned provider. What this journey exists to exercise —
   * three distinct secrets, an HMAC-signed header template, a registration walkthrough —
   * is preserved byte-for-byte; only the brand changed, and it changed to one the fixture
   * is entitled to author.
   */
  coinbase: {
    slot: 'coinbase',
    provider: { name: 'Meridian Exchange', docsUrl: 'https://docs.meridian-exchange.example' },
    kind: 'api_key',
    fields: [
      { key: 'api_key', label: 'API key', type: 'secret', description: 'the key id from your API settings page', required: true },
      { key: 'api_secret', label: 'API secret', type: 'secret', description: 'shown once when you create the key', required: true },
      { key: 'passphrase', label: 'Passphrase', type: 'secret', description: 'the passphrase you chose at key creation', required: true },
    ],
    registration: {
      consoleUrl: 'https://meridian-exchange.example/access/api',
      instructions: [
        'sign in to your Meridian Exchange account',
        'open API settings and choose new API key',
        'copy the key, the secret, and the passphrase',
      ],
    },
    // The landed template, verbatim — it lints clean and signs correctly.
    request: {
      headerTemplate: {
        'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
        'CB-ACCESS-SIGN':
          '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
      },
    },
    declaredApiHosts: ['api.meridian-exchange.example'],
  },
  /**
   * THE BEARER VARIANT EXISTS TO EXERCISE THE NO-REGISTRATION PATH: a requirement with no
   * `registration` seat must SKIP the register screen rather than render it empty (the
   * e2e's journey 2 asserts exactly that), and it must author its own single field.
   *
   * IT NAMES A NON-REGISTRY PROVIDER, and P4 made that deliberate. It used to be
   * OpenWeather — until P4 added the OpenWeather REGISTRY ENTRY, which extended the
   * registry-borrow ban to that name and host. Two things then broke at once, and both
   * were the guard working correctly: the authored `fields` became a Guard 2b refusal
   * (a borrowing channel may not author credential-prompt copy, because substitution
   * would lend registry legitimacy to it), and the registry's own registration
   * walkthrough was substituted IN — so the register screen appeared and the
   * "skipped, not empty" property could no longer be tested at all.
   *
   * A pinned provider is simply the wrong fixture for this journey: once the registry
   * knows a provider, it supplies the walkthrough, which is the whole point of P4. So the
   * variant moved to a provider the registry does NOT pin, where "no registration seat"
   * is a state that can genuinely exist. The alternative — keeping OpenWeather and
   * deleting the skip assertion — would have removed real coverage to accommodate a
   * fixture.
   */
  bearer: {
    slot: 'tidegauge',
    provider: { name: 'TideGauge' },
    kind: 'bearer_token',
    fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
    declaredApiHosts: ['api.tidegauge.example'],
  },
  basic: {
    slot: 'basic-demo',
    provider: { name: 'Basic Demo' },
    kind: 'basic_auth',
    fields: [
      { key: 'username', label: 'Username', type: 'text', required: true },
      { key: 'password', label: 'Password', type: 'secret', required: true },
    ],
    declaredApiHosts: ['api.basic-demo.example'],
  },
  /**
   * THE OAUTH VARIANT RESOLVES ITS STUB AT THE BROWSER, not in the page — and that is a
   * real constraint rather than a convenience.
   *
   * The obvious choices both fail. `accounts.fake-idp.example` is what shipped, and it made
   * journey 4 die with ERR_NAME_NOT_RESOLVED once the flow actually started opening a
   * window: the popup went, correctly, to a host that does not exist. `127.0.0.1` is worse
   * — `isForbiddenNetHost` refuses every loopback literal, so admission rejects the
   * requirement outright and no connect card renders at all. That guard is not negotiable
   * for a test.
   *
   * `idp.snug.test` is a name that passes every real gate, and the connection-wizard
   * Playwright project maps it to 127.0.0.1 with `--host-resolver-rules`. So what the model
   * declares, what the user reviews and what the ceiling freezes are all the same
   * ordinary-looking host, while the bytes land on the local fake IdP. An OAuth journey
   * needs this because it NAVIGATES the browser and POSTs to the token endpoint — neither
   * is an injected header whose target the page could remap.
   */
  oauth: {
    slot: 'fake-idp',
    provider: { name: 'Local Fake IdP' },
    kind: 'oauth2_auth_code',
    // https, and port 43122 — the fixture's TLS twin. `connectionRequirementSchema`
    // demands https for every OAuth endpoint (a plaintext authorize URL is a
    // credential-grade downgrade), which is why the fixture grew a TLS listener rather
    // than the schema growing an exception.
    endpoints: {
      authorizeUrl: 'https://idp.snug.test:43122/authorize',
      tokenUrl: 'https://idp.snug.test:43122/token',
    },
    pkce: true,
    fields: [{ key: 'client_id', label: 'Client ID', type: 'text', required: true }],
    registration: {
      instructions: ['create an app in the provider dashboard', 'paste the redirect uri below into it'],
    },
    declaredApiHosts: ['idp.snug.test'],
  },
};

/**
 * THE STARTER REQUIREMENTS (P4-AC10) — one per shipped, manifest-bearing starter.
 *
 * THEY MIRROR THE SHIPPED MANIFESTS, and that is the whole property being bought. A demo
 * variant emitting a requirement the shipped manifests do not contain would let the P4
 * e2e go green against a fictional provider while every real starter stayed broken. The
 * seam's value is that it is the PRODUCTION path with a scripted model, so what it emits
 * has to be the production artifact.
 *
 * RE-CURATED SHELF (TASK-20260815-starter-apps-rebuild): the four folders these mirror
 * are now `trade-copilot` (Coinbase), `weather` (OpenWeather), `github` (GitHub) and
 * `spotify` (Spotify). `starter-coingecko` became `starter-coinbase` with that curation —
 * crypto-portfolio was removed and its Coinbase-shaped successor is trade-copilot.
 *
 * WHY THESE ARE BARE (no `fields`, no `request`) while the BUILD variants above are rich.
 * All four name a registry provider, so `admitConnectionRequirement` fires the
 * registry-borrow ban and SUBSTITUTES the registry's pinned hosts, registration
 * walkthrough, display name and — since the P4 review fold — its credential `fields`.
 * Guard 2b still REFUSES any non-registry channel that AUTHORS credential-prompt seats
 * beside a borrowed brand: a label reading "Paste your Spotify password" rendered next to
 * registry-grade hosts is exactly what substitution would otherwise legitimize. The
 * asymmetry is the contract — omit and you RECEIVE the pinned list, author and you are
 * refused. So the registry supplies `fields`/`registration` and the manifest supplies only
 * what it legitimately knows: the slot, the kind, and the host it dials. Verified against
 * the real guard, not assumed. (`trade-copilot`'s shipped manifest carries fields that
 * BYTE-MATCH the registry's pinned Coinbase pair — admission's idempotency accepts a
 * registry-identical copy — but the variant stays bare like its peers: the mirror is over
 * slot/kind/provider/hosts, and bare is the shape the borrow contract recommends.)
 *
 * The spectrum is deliberate (AL-09's founding point): api_key, bearer_token, and
 * oauth2_auth_code all appear, so no shape is left unrepresented by a table that collapsed
 * to one kind.
 *
 * SCOPE, STATED HONESTLY (P4 review fold). These four variants are UNIT-LEVEL FIXTURES.
 * No Playwright journey drives `?demoreq=starter-*` today — the e2e starter coverage runs
 * through `starters-connect.spec.ts` (the shipped apps' degraded state and Hue's greyed
 * posture) and `connection-declaration.spec.ts` (the full install → CTA → review → approve
 * journey on `weather`). What these variants DO buy is real but narrower: every
 * one is pinned against the shipped manifest it mirrors, read off disk, and driven through
 * the full production path (schema → admission → template lint) in
 * `demoRequirementStarters.test.ts`. They are ready for an e2e that wants a scripted
 * starter chat; claiming they already serve one would be the kind of coverage fiction this
 * phase's review existed to catch.
 *
 * C1: field DEFINITIONS only, never values — and here, not even definitions. A scripted
 * brain is precisely where someone would bake in a working key "to make the journey run
 * end to end"; the e2e types its secrets, the requirement never carries one.
 */
export const DEMO_STARTER_REQUIREMENTS: Record<DemoStarterVariant, ConnectionRequirement> = {
  'starter-coinbase': {
    slot: 'coinbase',
    provider: { name: 'Coinbase' },
    kind: 'api_key',
    declaredApiHosts: ['api.coinbase.com'],
  },
  'starter-openweather': {
    slot: 'openweather',
    provider: { name: 'OpenWeather', docsUrl: 'https://openweathermap.org/forecast5' },
    kind: 'api_key',
    declaredApiHosts: ['api.openweathermap.org'],
  },
  'starter-github': {
    slot: 'github',
    provider: { name: 'GitHub', docsUrl: 'https://docs.github.com/en/rest/repos/repos' },
    kind: 'bearer_token',
    declaredApiHosts: ['api.github.com'],
  },
  'starter-spotify': {
    slot: 'spotify',
    provider: { name: 'Spotify', docsUrl: 'https://developer.spotify.com/documentation/web-api' },
    kind: 'oauth2_auth_code',
    declaredApiHosts: ['api.spotify.com'],
  },
};

const isStarterVariant = (variant: DemoRequirementVariant): variant is DemoStarterVariant =>
  (STARTER_VARIANTS as readonly string[]).includes(variant);

/** The scripted chat for a demoreq run: write the app, then emit the requirement. */
export function demoRequirementChatScript(variant: DemoRequirementVariant): MockTurn[] {
  if (variant === 'undeclared') {
    // A connected app and a sign-off that declares NOTHING — the exact reply shape the
    // build-time recovery path exists to rescue. Deliberately plausible prose: the failure
    // mode is a model that believes it finished, not one that emits something malformed.
    const closing = '\n\nyour app is ready — run it and it will pull your latest prices.';
    return [
      {
        deltas: ['writing your app now.'],
        text: 'writing your app now.',
        toolCalls: [
          { name: ARTIFACT_WRITE_TOOL_NAME, input: { content: UNDECLARED_CONNECTED_HTML, title: 'connected app' } },
        ],
      },
      { deltas: [closing], text: closing },
    ];
  }
  // The requirement is read from the table that OWNS this variant. Resolving both from
  // one lookup would interpolate `undefined` for any name the table did not know and
  // still emit two well-shaped turns — a directive with a hole where the requirement
  // belongs, which reads as a working script and proves nothing.
  const requirement = isStarterVariant(variant) ? DEMO_STARTER_REQUIREMENTS[variant] : REQUIREMENTS[variant];
  const directive = JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
    requirement,
  });
  const closing =
    '\n\nyour app is ready — it needs a provider connection before its network calls will work:\n\n```json\n' +
    directive +
    '\n```\n\nreview and approve it in the connect card above.';
  return [
    {
      deltas: ['writing your app now.'],
      text: 'writing your app now.',
      toolCalls: [{ name: ARTIFACT_WRITE_TOOL_NAME, input: { content: NET_DEMO_APP_HTML, title: 'connected app' } }],
    },
    { deltas: [closing], text: closing },
  ];
}
