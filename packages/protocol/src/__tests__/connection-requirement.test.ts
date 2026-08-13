// TASK-20260810-p0-contracts (Dynamic Auth v2, P0) AC1–AC4: `connectionRequirementSchema`
// — the RICHER, BOUNDED authoring channel that replaces `llmProposalSchema`'s omit-list.
//
// Root cause this schema exists to close (verified at source on main, render-directive.ts:63–69):
// `llmProposalSchema = authSpecHintsSchema.omit({registrationConsoleUrl, registrationInstructions,
// headerTemplate, fields, userLayerFields})`. Those five omissions are exactly the seats a
// Coinbase-shaped requirement needs, so every static-kind proposal collapsed to the transformer's
// single generic field — the owner's "Coinbase needs key + secret + passphrase" defect. AC1 is
// therefore not a happy-path smoke test: it is the falsifiable statement that the defect is fixed.
//
// The cost of re-admitting that channel is paid in bounds (AC2) and in guards (AC3). Both get
// NEGATIVE tests at the EDGE — one under, one over — because a bound asserted only in the middle
// of its range proves nothing about where it actually cuts.
//
// P0 IS ADDITIVE (fold B1): v4 contracts land ALONGSIDE v3. Nothing here touches
// `authSpecSchema` / `llmProposalSchema` / `snug_auth_specs` — those keep shipping until
// their last consumers are rewired in P3/P4.
import { describe, expect, it } from 'vitest';
import {
  AUTH_MAX_SLOTS_PER_APP,
  CONNECTION_HEADER_NAME_RULE,
  CONNECTION_KINDS,
  CONNECTION_PROVENANCES,
  CONNECTION_QUERY_NAME_RULE,
  CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS,
  CONNECTION_REQUIREMENT_MAX_FIELDS,
  CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES,
  CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS,
  CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES,
  CONNECTION_SLOT_RULE,
  canonicalRequirementHash,
  connectionRequirementSchema,
  type ConnectionRequirement,
} from '../connection-requirement.js';

// ------------------------------------------------------------------ fixtures

/**
 * The motivating case, in full. Coinbase EXCHANGE — three fields (`api_key`, `api_secret`,
 * `passphrase`), the signed `CB-ACCESS-*` header set, a registration walkthrough, declared hosts.
 *
 * HOST NOTE (flagged during the P0 design stage): the host is `api.exchange.coinbase.com`, NOT
 * the parent plan §5's `api.coinbase.com`. The passphrase field is the diagnostic marker of
 * Coinbase Exchange; `api.coinbase.com` is the different retail/CDP surface. Since
 * `declaredApiHosts` becomes the FROZEN ceiling at approval, shipping the wrong host would make
 * the executor's frozen-ceiling gate refuse the eval app's requests and present as an auth bug.
 *
 * TEMPLATE NOTE: the signature helper is `hmac_sha256_b64` — the one encoding-capable variant
 * pinned at P0 (four-name enum: timestamp | hmac_sha256 | hmac_sha256_b64 | base64). It is
 * variadic in its message tail so Exchange's real 4-part prehash (timestamp + method + path +
 * body) is expressible without nesting, which the shipped helper grammar cannot parse.
 */
const coinbaseRequirement = {
  slot: 'coinbase',
  provider: {
    name: 'Coinbase Exchange',
    homepageUrl: 'https://www.coinbase.com',
    docsUrl: 'https://docs.cdp.coinbase.com/exchange/docs/welcome',
  },
  kind: 'api_key',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'secret',
      description: 'The API key string shown once when you create the key.',
      placeholder: 'e.g. 8f2c...',
      required: true,
    },
    {
      key: 'api_secret',
      label: 'API Secret',
      type: 'secret',
      description: 'The base64 secret shown next to the key. Copy it before you close the page.',
      required: true,
    },
    {
      key: 'passphrase',
      label: 'Passphrase',
      type: 'secret',
      description: 'The passphrase you chose when creating the key.',
      required: true,
    },
  ],
  registration: {
    consoleUrl: 'https://www.coinbase.com/settings/api',
    instructions: [
      'Sign in to Coinbase and open Settings, then API.',
      'Choose New API Key and pick the portfolio this app should read.',
      'Give the key View permission only — this app never needs to trade.',
      'Choose a passphrase you can paste back here, then confirm.',
      'Copy the API key and the secret now: the secret is shown only once.',
    ],
  },
  request: {
    // `request.timestamp`, NOT `timestamp()`. This fixture is the canonical
    // Coinbase-Exchange requirement, so it must be a template that can actually RENDER —
    // the schema bounds only the envelope, so a template with an unrenderable body parses
    // happily and teaches the wrong shape to every reader of this file.
    //
    // It previously read `timestamp()` in the signature's argument list, which the auth
    // template lint REJECTS (verified by execution): the grammar is flat, so a helper CALL
    // is not an accepted ARGUMENT form. `request.timestamp` is the pinned render token
    // added for exactly this seat, and it is served from the same memoized slot as
    // `{{timestamp()}}` so the signed and sent timestamps cannot disagree. See ADR-0017
    // §`request.timestamp` and packages/auth `template-parity.test.ts`, which renders this
    // template and recomputes the HMAC from the timestamp it actually sent.
    headerTemplate: {
      'CB-ACCESS-KEY': '{{api_key}}',
      'CB-ACCESS-SIGN':
        '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
      'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
      'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
    },
  },
  declaredApiHosts: ['api.exchange.coinbase.com'],
} as const;

/** Minimal valid requirement — the base every AC2 edge case mutates one seat of. */
const minimalRequirement = {
  slot: 'openweather',
  provider: { name: 'OpenWeather' },
  kind: 'api_key',
  fields: [{ key: 'appid', label: 'API Key', type: 'secret' }],
  declaredApiHosts: ['api.openweathermap.org'],
};

/** Build a requirement with `count` distinct, individually-valid fields. */
const withFields = (count: number): Record<string, unknown> => ({
  ...minimalRequirement,
  fields: Array.from({ length: count }, (_, i) => ({
    key: `field_${i}`,
    label: `Field ${i}`,
    type: 'secret',
  })),
});

/** Build a requirement with `count` distinct, individually-valid instruction lines. */
const withInstructions = (count: number): Record<string, unknown> => ({
  ...minimalRequirement,
  registration: { instructions: Array.from({ length: count }, (_, i) => `Step ${i}.`) },
});

const parses = (input: unknown): boolean => connectionRequirementSchema.safeParse(input).success;

// ------------------------------------------------------------------------ AC1

describe('AC1 — the Coinbase-shaped requirement parses in FULL (the defect this rewrite exists to close)', () => {
  it('accepts three fields, a signed CB-ACCESS-* header template, a walkthrough, and declared hosts', () => {
    const parsed = connectionRequirementSchema.safeParse(coinbaseRequirement);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
  });

  it('preserves every seat `llmProposalSchema` omitted — no silent narrowing on the way through', () => {
    const req: ConnectionRequirement = connectionRequirementSchema.parse(coinbaseRequirement);
    // The three fields are the owner's grievance stated as an assertion: a key without its
    // secret (and its passphrase) is the defect, so the count and the keys both matter.
    expect(req.fields?.map((f) => f.key)).toEqual(['api_key', 'api_secret', 'passphrase']);
    // Per-field metadata is what the grandma wizard renders; dropping it re-creates the
    // "single generic field" collapse in a different place.
    expect(req.fields?.[0]?.description).toBe('The API key string shown once when you create the key.');
    expect(req.fields?.[0]?.placeholder).toBe('e.g. 8f2c...');
    expect(req.registration?.consoleUrl).toBe('https://www.coinbase.com/settings/api');
    expect(req.registration?.instructions).toHaveLength(5);
    expect(Object.keys(req.request?.headerTemplate ?? {})).toEqual([
      'CB-ACCESS-KEY',
      'CB-ACCESS-SIGN',
      'CB-ACCESS-TIMESTAMP',
      'CB-ACCESS-PASSPHRASE',
    ]);
    expect(req.declaredApiHosts).toEqual(['api.exchange.coinbase.com']);
  });

  it('carries the signing template VERBATIM — the strong review renders these bytes, so they must survive parse unchanged', () => {
    const req = connectionRequirementSchema.parse(coinbaseRequirement);
    expect(req.request?.headerTemplate?.['CB-ACCESS-SIGN']).toBe(
      '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
    );
  });

  it('pins the slot charset rule and the per-app slot cap as exported constants (never prose-only literals)', () => {
    expect(CONNECTION_SLOT_RULE.source).toBe('^[a-z0-9][a-z0-9-]{0,39}$');
    expect(AUTH_MAX_SLOTS_PER_APP).toBe(8);
    expect([...CONNECTION_PROVENANCES].sort()).toEqual(
      ['registry', 'inference', 'user_docs', 'starter', 'user'].sort(),
    );
  });

  it('is strict throughout — an unknown key anywhere is a rejection, not a passthrough', () => {
    expect(parses({ ...minimalRequirement, sneaky: true })).toBe(false);
    expect(parses({ ...minimalRequirement, provider: { name: 'X', adminUrl: 'https://e.example' } })).toBe(false);
    expect(
      parses({ ...minimalRequirement, fields: [{ key: 'k', label: 'K', type: 'secret', extra: 1 }] }),
    ).toBe(false);
    expect(parses({ ...minimalRequirement, registration: { instructions: ['a'], html: '<b>' } })).toBe(false);
  });
});

// ------------------------------------------------------------------------ AC2

describe('AC2 — every bound rejects AT ITS EDGE (a bound asserted mid-range proves nothing)', () => {
  it('fields: accepts exactly CONNECTION_REQUIREMENT_MAX_FIELDS, rejects one more', () => {
    expect(CONNECTION_REQUIREMENT_MAX_FIELDS).toBe(8);
    expect(parses(withFields(CONNECTION_REQUIREMENT_MAX_FIELDS))).toBe(true);
    expect(parses(withFields(CONNECTION_REQUIREMENT_MAX_FIELDS + 1))).toBe(false);
  });

  it('registration.instructions: accepts exactly 10, rejects 11', () => {
    expect(CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS).toBe(10);
    expect(parses(withInstructions(CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS))).toBe(true);
    expect(parses(withInstructions(CONNECTION_REQUIREMENT_MAX_INSTRUCTIONS + 1))).toBe(false);
  });

  it('field.label: accepts 80 chars, rejects 81', () => {
    const at = { ...minimalRequirement, fields: [{ key: 'k', label: 'a'.repeat(80), type: 'secret' }] };
    const over = { ...minimalRequirement, fields: [{ key: 'k', label: 'a'.repeat(81), type: 'secret' }] };
    expect(parses(at)).toBe(true);
    expect(parses(over)).toBe(false);
  });

  it('field.description: accepts 200 chars, rejects 201', () => {
    const field = (n: number) => ({ key: 'k', label: 'K', type: 'secret', description: 'a'.repeat(n) });
    expect(parses({ ...minimalRequirement, fields: [field(200)] })).toBe(true);
    expect(parses({ ...minimalRequirement, fields: [field(201)] })).toBe(false);
  });

  it('field.placeholder: accepts 60 chars, rejects 61', () => {
    const field = (n: number) => ({ key: 'k', label: 'K', type: 'secret', placeholder: 'a'.repeat(n) });
    expect(parses({ ...minimalRequirement, fields: [field(60)] })).toBe(true);
    expect(parses({ ...minimalRequirement, fields: [field(61)] })).toBe(false);
  });

  it('provider.name: accepts 120 chars, rejects 121 (matches the shipped AUTH_PROVIDER_NAME_MAX_CHARS)', () => {
    expect(parses({ ...minimalRequirement, provider: { name: 'a'.repeat(120) } })).toBe(true);
    expect(parses({ ...minimalRequirement, provider: { name: 'a'.repeat(121) } })).toBe(false);
    // Empty is not a name — the wizard renders this string as the provider identity.
    expect(parses({ ...minimalRequirement, provider: { name: '' } })).toBe(false);
  });

  it('declaredApiHosts: accepts a 253-char host, rejects 254 (RFC 1035 ceiling)', () => {
    // 253 chars built from valid labels, so ONLY the length bound can be the cut.
    const label = 'a'.repeat(63);
    const host253 = `${label}.${label}.${label}.${'a'.repeat(61)}`;
    expect(host253).toHaveLength(253);
    expect(parses({ ...minimalRequirement, declaredApiHosts: [host253] })).toBe(true);
    expect(parses({ ...minimalRequirement, declaredApiHosts: [`a${host253}`] })).toBe(false);
  });

  it('declaredApiHosts: accepts 32 hosts, rejects 33, and rejects an empty list for a credentialed kind', () => {
    const hosts = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
    expect(parses({ ...minimalRequirement, declaredApiHosts: hosts(32) })).toBe(true);
    expect(parses({ ...minimalRequirement, declaredApiHosts: hosts(33) })).toBe(false);
    expect(parses({ ...minimalRequirement, declaredApiHosts: [] })).toBe(false);
  });

  it('slot: enforces the pinned charset — no uppercase, no underscore, no leading dash, no dots, max 40', () => {
    for (const slot of ['coinbase', 'google-drive', 'a', '0', 'a'.repeat(40), 'x-1-2']) {
      expect(parses({ ...minimalRequirement, slot }), `slot ${slot} should parse`).toBe(true);
    }
    for (const slot of [
      '',
      'Coinbase',              // uppercase — slots are persisted PK halves; case drift forks rows
      'google_drive',          // underscore is outside the pinned charset
      '-leading-dash',
      'api.coinbase.com',      // a host is not a slot
      'a'.repeat(41),
      'spotify ',              // trailing space
      'sp/otify',
    ]) {
      expect(parses({ ...minimalRequirement, slot }), `slot ${JSON.stringify(slot)} should reject`).toBe(false);
    }
  });

  it('registration.consoleUrl and provider.docsUrl are https-ONLY (http/javascript/data are phishing vectors in the review UI)', () => {
    for (const url of ['http://console.example.com', 'javascript:alert(1)', 'data:text/html,<b>', 'ftp://x.example']) {
      expect(
        parses({ ...minimalRequirement, registration: { consoleUrl: url } }),
        `consoleUrl ${url} should reject`,
      ).toBe(false);
      expect(
        parses({ ...minimalRequirement, provider: { name: 'X', docsUrl: url } }),
        `docsUrl ${url} should reject`,
      ).toBe(false);
    }
    expect(parses({ ...minimalRequirement, registration: { consoleUrl: 'https://console.example.com' } })).toBe(true);
    expect(parses({ ...minimalRequirement, provider: { name: 'X', docsUrl: 'https://docs.example.com' } })).toBe(true);
  });

  it('headerTemplate: accepts 8 entries, rejects 9 (the template is rendered host-side into real requests)', () => {
    const template = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-H-${i}`, '{{appid}}']));
    expect(CONNECTION_REQUIREMENT_MAX_HEADER_ENTRIES).toBe(8);
    expect(parses({ ...minimalRequirement, request: { headerTemplate: template(8) } })).toBe(true);
    expect(parses({ ...minimalRequirement, request: { headerTemplate: template(9) } })).toBe(false);
  });
});

// ------------------------------------------------------------------------ AC3

describe('AC3 — provider.name confusable guard (promoted from AL-10; ADR-0016 clause 6 prerequisite)', () => {
  it('rejects NON-ASCII homoglyphs that borrow a trusted display name', () => {
    // Cyrillic ѕ (U+0455) in place of Latin s: renders as "spotify" in the review UI and, worse,
    // survives `normalizeProviderKey` as a DIFFERENT key — so it evades the registry-borrow ban
    // while looking pinned to a human. Both halves are why the guard sits at the schema.
    expect(parses({ ...minimalRequirement, provider: { name: 'ѕpotify' } })).toBe(false);
    // Cyrillic о (U+043E) inside an otherwise-Latin word.
    expect(parses({ ...minimalRequirement, provider: { name: 'Cоinbase' } })).toBe(false);
    // Fullwidth Latin — visually near-identical at UI sizes.
    expect(parses({ ...minimalRequirement, provider: { name: 'Ｓpotify' } })).toBe(false);
    // Zero-width joiner smuggled into an exact-looking name.
    expect(parses({ ...minimalRequirement, provider: { name: 'Spot​ify' } })).toBe(false);
    // Right-to-left override — reverses rendering without changing the code points a check reads.
    expect(parses({ ...minimalRequirement, provider: { name: 'Spot‮ify' } })).toBe(false);
  });

  it('still accepts the ordinary printable-ASCII names real providers actually use', () => {
    for (const name of ['Spotify', 'Coinbase Exchange', 'OpenWeather', 'Google Drive', "Bob's API", 'AT&T (v2)']) {
      expect(parses({ ...minimalRequirement, provider: { name } }), name).toBe(true);
    }
  });

  it('SCOPE STATEMENT (not a gap): pure-ASCII lookalikes are DELIBERATELY accepted here and defended by the strong review, per ADR-0017', () => {
    // `5potify` and `Spotlfy` are printable ASCII. No charset or normalization guard can reject
    // them without also rejecting legitimate names, and a denylist of lookalikes is unbounded.
    // The division of labor is stated in ADR-0017 and enforced elsewhere: the strong
    // field-by-field review carries the provenance copy ("proposed by a model — a guess, not an
    // authority") plus the full host list, and the registry-borrow ban (AC9, packages/auth) fires
    // on declaredApiHosts ∩ registry apiHosts — so borrowing Spotify's HOST under a lookalike NAME
    // is caught there. This test exists so that division is asserted, not merely documented: if a
    // future change makes these reject, the scoping in ADR-0017 has silently drifted.
    expect(parses({ ...minimalRequirement, provider: { name: '5potify' } })).toBe(true);
    expect(parses({ ...minimalRequirement, provider: { name: 'Spotlfy' } })).toBe(true);
    expect(parses({ ...minimalRequirement, provider: { name: 'C0inbase' } })).toBe(true);
  });
});

// ------------------------------------------------------------------------ AC4

describe('AC4 — the `none` kind is a first-class union member (Q6: take the cheap schema window now)', () => {
  it('CONNECTION_KINDS is the five shipped discriminators PLUS none', () => {
    expect([...CONNECTION_KINDS]).toEqual([
      'api_key',
      'bearer_token',
      'basic_auth',
      'oauth2_client_creds',
      'oauth2_auth_code',
      'none',
    ]);
  });

  it('parses a keyless requirement: no fields, no template, but declared hosts still required', () => {
    const keyless = {
      slot: 'coingecko',
      provider: { name: 'CoinGecko' },
      kind: 'none',
      declaredApiHosts: ['api.coingecko.com'],
    };
    const parsed = connectionRequirementSchema.safeParse(keyless);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    if (parsed.success) expect(parsed.data.kind).toBe('none');
  });

  it('a `none` requirement carries no credential seats — fields and request are structurally rejected', () => {
    const keyless = {
      slot: 'coingecko',
      provider: { name: 'CoinGecko' },
      kind: 'none',
      declaredApiHosts: ['api.coingecko.com'],
    };
    // A keyless kind that declares fields is incoherent: there is nothing for the wizard to
    // collect and nothing for the executor to inject. Fail closed at the schema rather than
    // letting a half-formed row reach the grant path.
    expect(parses({ ...keyless, fields: [{ key: 'k', label: 'K', type: 'secret' }] })).toBe(false);
    expect(parses({ ...keyless, request: { headerTemplate: { 'X-K': 'literal' } } })).toBe(false);
    // The host ceiling still applies — `none` means "no credentials", never "no gate".
    expect(parses({ ...keyless, declaredApiHosts: [] })).toBe(false);
  });

  it('rejects kinds outside the six (unknown discriminators fail closed, as with AUTH_KINDS)', () => {
    for (const kind of ['apikey', 'bearer', 'oauth2', 'NONE', '', 'mtls']) {
      expect(parses({ ...minimalRequirement, kind }), `kind ${JSON.stringify(kind)}`).toBe(false);
    }
  });
});

// ------------------------------------------------- request.queryTemplate (P3)

// TASK-20260812-desktop-auth-awareness P3 / ADR-0022 §3 — query-param credential
// placement. OpenWeather (`?appid=`) and CoinGecko's demo key are structurally
// unservable without it: no query mechanism existed anywhere, and the header rule's
// alnum+dash charset would reject CoinGecko's own `x_cg_demo_api_key` name. The seat
// gets its OWN key charset (P0 amendment 11) and reuses the headerTemplate VALUE
// bounds verbatim — "same lint family" means the value shape here and the
// declared-field-keys lint in packages/auth, never the key charset.
describe('P3/AC6 — request.queryTemplate: its own key charset, headerTemplate value bounds, strict envelope', () => {
  const withQuery = (queryTemplate: Record<string, string>): Record<string, unknown> => ({
    ...minimalRequirement,
    request: { queryTemplate },
  });

  it('accepts underscore keys — the CoinGecko demo form the HEADER charset would reject', () => {
    const parsed = connectionRequirementSchema.safeParse(withQuery({ x_cg_demo_api_key: '{{api_key}}' }));
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    if (parsed.success) {
      // Verbatim survival matters for the same reason as headerTemplate: the strong
      // review renders these bytes, and the host renders them into a real URL.
      expect(parsed.data.request?.queryTemplate).toEqual({ x_cg_demo_api_key: '{{api_key}}' });
    }
  });

  it('accepts the OpenWeather pinned shape ({ appid: …}) and every charset member: dot, brackets, dash, 64-char key', () => {
    expect(parses(withQuery({ appid: '{{api_key}}' }))).toBe(true);
    expect(parses(withQuery({ 'a.b': '{{appid}}' }))).toBe(true);
    expect(parses(withQuery({ 'filter[key]': '{{appid}}' }))).toBe(true);
    expect(parses(withQuery({ 'x-api-key': '{{appid}}' }))).toBe(true);
    expect(parses(withQuery({ ['k'.repeat(64)]: '{{appid}}' }))).toBe(true);
  });

  it('rejects keys outside the pinned charset — separators, spaces, percent, braces, non-ASCII, empty, 65 chars', () => {
    for (const key of ['bad key', 'bad=key', 'bad&key', 'bad%20key', '{appid}', 'bäd', 'ключ', '', 'k'.repeat(65)]) {
      expect(parses(withQuery({ [key]: '{{appid}}' })), `key ${JSON.stringify(key)} should reject`).toBe(false);
    }
  });

  it('pins CONNECTION_QUERY_NAME_RULE as an exported constant, and the HEADER rule stays alnum+dash, untouched', () => {
    expect(CONNECTION_QUERY_NAME_RULE.source).toBe(String.raw`^[A-Za-z0-9_.\[\]-]{1,64}$`);
    // The header charset must NOT silently widen to match: header names with
    // underscores are dropped or mangled by real proxies, and the narrowing was a
    // deliberate review-surface decision. Rule AND behavior, both pinned.
    expect(CONNECTION_HEADER_NAME_RULE.source).toBe('^[A-Za-z0-9-]{1,64}$');
    expect(
      parses({ ...minimalRequirement, request: { headerTemplate: { x_cg_demo_api_key: '{{appid}}' } } }),
    ).toBe(false);
  });

  it('values ride the headerTemplate bounds verbatim: empty rejected, 300 accepted, 301 rejected', () => {
    expect(parses(withQuery({ appid: '' }))).toBe(false);
    expect(parses(withQuery({ appid: 'a'.repeat(CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS) }))).toBe(true);
    expect(parses(withQuery({ appid: 'a'.repeat(CONNECTION_REQUIREMENT_HEADER_VALUE_MAX_CHARS + 1) }))).toBe(false);
  });

  it('accepts exactly CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES entries, rejects one more', () => {
    const template = (n: number): Record<string, string> =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`q_${i}`, '{{appid}}']));
    expect(CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES).toBe(8);
    expect(parses(withQuery(template(CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES)))).toBe(true);
    expect(parses(withQuery(template(CONNECTION_REQUIREMENT_MAX_QUERY_ENTRIES + 1)))).toBe(false);
  });

  it('headerTemplate and queryTemplate coexist in one request seat', () => {
    expect(
      parses({
        ...minimalRequirement,
        request: {
          headerTemplate: { 'X-Custom': '{{appid}}' },
          queryTemplate: { appid: '{{appid}}' },
        },
      }),
    ).toBe(true);
  });

  it('the request seat stays strict — an unknown sibling (bodyTemplate) is a rejection, never a passthrough', () => {
    expect(parses({ ...minimalRequirement, request: { bodyTemplate: { k: '{{appid}}' } } })).toBe(false);
    expect(
      parses({ ...minimalRequirement, request: { queryTemplate: { appid: '{{appid}}' }, sneaky: 1 } }),
    ).toBe(false);
  });

  it("kind 'none' coherence closes over the NEW seat: a query-only request template is still incoherent", () => {
    // Guard 2b's occupied-seat hole ("a queryTemplate-only request sails past") lives
    // in packages/auth; the schema's own coherence rule must not have the same hole.
    const keyless = {
      slot: 'coingecko',
      provider: { name: 'CoinGecko' },
      kind: 'none',
      declaredApiHosts: ['api.coingecko.com'],
    };
    expect(parses({ ...keyless, request: { queryTemplate: { appid: 'literal' } } })).toBe(false);
  });

  it('a changed queryTemplate is a DIFFERENT requirement — canonical identity sees the new seat', () => {
    const base = connectionRequirementSchema.parse(withQuery({ appid: '{{api_key}}' }));
    const changed = connectionRequirementSchema.parse(withQuery({ appid: '{{api_key}}', units: 'metric' }));
    expect(canonicalRequirementHash(changed)).not.toBe(canonicalRequirementHash(base));
    // And against the query-free base: adding the seat must bump requirement_version.
    const bare = connectionRequirementSchema.parse(minimalRequirement);
    expect(canonicalRequirementHash(base)).not.toBe(canonicalRequirementHash(bare));
  });
});

// --------------------------------------------------------- canonical identity

/**
 * `canonicalRequirementHash` backs AC15's `requirement_version` rule in packages/db AND
 * P2's edit-pipeline no-op. Both read "did this requirement change?" off this one
 * function, so its edges are pinned HERE, at its definition, rather than only through
 * the version numbers a db test happens to observe.
 */
describe('canonicalRequirementHash — key order is noise, array order is meaning (fold T-mn3)', () => {
  const parse = (value: unknown): ConnectionRequirement => connectionRequirementSchema.parse(value);

  it('is stable across permuted KEY order — the churn an LLM re-emission actually produces', () => {
    const canonical = canonicalRequirementHash(parse(coinbaseRequirement));
    const permuted = canonicalRequirementHash(
      parse({
        declaredApiHosts: coinbaseRequirement.declaredApiHosts,
        request: coinbaseRequirement.request,
        registration: coinbaseRequirement.registration,
        fields: coinbaseRequirement.fields,
        kind: coinbaseRequirement.kind,
        provider: coinbaseRequirement.provider,
        slot: coinbaseRequirement.slot,
      }),
    );
    expect(permuted).toBe(canonical);
  });

  it('sorts keys at EVERY depth, not just the top level', () => {
    // A shallow sort would leave nested objects (provider, registration, each field) at
    // the mercy of emission order, so the version would still bump on a no-op rebuild —
    // the bug would just get rarer and harder to reproduce.
    const nestedPermuted = parse({
      ...coinbaseRequirement,
      provider: {
        docsUrl: coinbaseRequirement.provider.docsUrl,
        name: coinbaseRequirement.provider.name,
        homepageUrl: coinbaseRequirement.provider.homepageUrl,
      },
    });
    expect(canonicalRequirementHash(nestedPermuted)).toBe(canonicalRequirementHash(parse(coinbaseRequirement)));
  });

  it('is WHITESPACE-FREE (the pinned canonicalization) and therefore stable under re-serialization', () => {
    const canonical = canonicalRequirementHash(parse(coinbaseRequirement));
    expect(canonical).not.toMatch(/\n|\s{2,}/);
    // Round-tripping the canonical bytes must be a fixed point: P2 compares a stored
    // requirement against a freshly-emitted one, and the stored side has been through
    // JSON.parse at least once.
    expect(canonicalRequirementHash(parse(JSON.parse(canonical)))).toBe(canonical);
  });

  it('PRESERVES array order — a reordered walkthrough is a DIFFERENT requirement', () => {
    // The deliberate reading of "stable array order" (see the function's WHY comment).
    // Every array here is semantically ordered and user-visible: sorting them would make
    // a reordered numbered walkthrough hash identical to the original, so the edit
    // pipeline would treat it as a no-op and nobody would ever re-review the change.
    const instructions = coinbaseRequirement.registration.instructions;
    const reversed = parse({
      ...coinbaseRequirement,
      registration: { ...coinbaseRequirement.registration, instructions: [...instructions].reverse() },
    });
    expect(canonicalRequirementHash(reversed)).not.toBe(canonicalRequirementHash(parse(coinbaseRequirement)));

    // Same rule for `fields`, which drives the wizard's input order.
    const reorderedFields = parse({
      ...coinbaseRequirement,
      fields: [...coinbaseRequirement.fields].reverse(),
    });
    expect(canonicalRequirementHash(reorderedFields)).not.toBe(canonicalRequirementHash(parse(coinbaseRequirement)));
  });

  it('differs whenever any VALUE differs — including a single added host or scope', () => {
    const base = canonicalRequirementHash(parse(coinbaseRequirement));
    expect(
      canonicalRequirementHash(
        parse({ ...coinbaseRequirement, declaredApiHosts: ['api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com'] }),
      ),
    ).not.toBe(base);
    expect(canonicalRequirementHash(parse({ ...coinbaseRequirement, scopes: ['read'] }))).not.toBe(base);
  });
});
