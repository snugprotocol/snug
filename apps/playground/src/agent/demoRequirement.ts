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

import { CONNECTION_REQUIREMENT_DIRECTIVE_KIND, PROTOCOL_VERSION } from '@snugprotocol/protocol';
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
export type DemoRequirementVariant = 'coinbase' | 'bearer' | 'basic' | 'oauth' | 'undeclared';

const VARIANTS = new Set<string>(['coinbase', 'bearer', 'basic', 'oauth', 'undeclared']);

/** The active `?demoreq` variant, read per call (never cached across navigations). */
export function demoRequirementVariant(): DemoRequirementVariant | null {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get('demoreq');
  return value !== null && VARIANTS.has(value) ? (value as DemoRequirementVariant) : null;
}

/**
 * A bridge-speaking app that fires ONE net-request at the e2e https stub.
 *
 * THE PORT IS THE WHOLE REMAP. The app dials the REAL provider host — `api.coinbase.com`
 * — which is what the requirement declares and what the user reviews and freezes, so the
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
          instanceId: instanceId, url: 'https://api.coinbase.com:43120/v2/accounts', method: 'GET' }, '*');
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
const REQUIREMENTS: Record<Exclude<DemoRequirementVariant, 'undeclared'>, Record<string, unknown>> = {
  coinbase: {
    slot: 'coinbase',
    provider: { name: 'Coinbase', docsUrl: 'https://docs.cdp.coinbase.com/' },
    kind: 'api_key',
    fields: [
      { key: 'api_key', label: 'API key', type: 'secret', description: 'the key id from your API settings page', required: true },
      { key: 'api_secret', label: 'API secret', type: 'secret', description: 'shown once when you create the key', required: true },
      { key: 'passphrase', label: 'Passphrase', type: 'secret', description: 'the passphrase you chose at key creation', required: true },
    ],
    registration: {
      consoleUrl: 'https://portal.cdp.coinbase.com/access/api',
      instructions: [
        'sign in to your Coinbase account',
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
    declaredApiHosts: ['api.coinbase.com'],
  },
  bearer: {
    slot: 'openweather',
    provider: { name: 'OpenWeather' },
    kind: 'bearer_token',
    fields: [{ key: 'token', label: 'API token', type: 'secret', required: true }],
    declaredApiHosts: ['api.openweathermap.org'],
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
  const directive = JSON.stringify({
    v: PROTOCOL_VERSION,
    kind: CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
    requirement: REQUIREMENTS[variant],
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
