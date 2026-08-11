// AL-04 (TASK-20260806-auth-wizard) AC1: the render-directive contract — INTERNAL
// protocol surface (plan D1). Locks:
//   - `authSpecHintsSchema` as the single source of truth for transformer-input hints
//     (M8 — packages/auth re-derives ParamsToAuthSpecInput from it, never retypes);
//   - `llmProposalSchema` = hints MINUS registration copy + headerTemplate (M5 — an
//     LLM-authored proposal structurally cannot carry phishing registration copy or
//     control where the secret is injected);
//   - `inferrerProposalSchema` strict confidence in [0,1] + bounded evidence (M11);
//   - `authWizardDirectiveSchema` — the persisted directive shape: no credential slot,
//     no evidence[], no docs-derived free text (M1);
//   - none of it enters json-schemas SOURCES (the publishes-to-spec line, mutation M1
//     of the AL-04 table — extends the AL-02/AL-03 guard).
//
// TASK-20260810-p0-contracts (Dynamic Auth v2, P0) changes TWO things here, both
// deliberate rather than incidental churn:
//   - `authRequiredPayloadSchema` is DELETED (task §Scope D18). It was an orphan with
//     ZERO non-test consumers, so its only cost was test churn; the display fields an
//     app-side connect CTA needs now come from the persisted `snug_connections` row.
//     Its three tests and its snapshot key go with it.
//   - the directive union gains `connection_requirement` ADDITIVELY (fold B1). Every
//     `auth_wizard` assertion below stays EXACTLY as it was — that is the cutover rule
//     asserted, not merely promised: v3's channel must keep shipping green through P0.
import { describe, expect, it } from 'vitest';
import {
  AUTH_HINT_HOSTS_MAX_ITEMS,
  AUTH_HINT_HOST_MAX_CHARS,
  AUTH_HINT_SCOPES_MAX_ITEMS,
  AUTH_HINT_SCOPE_MAX_CHARS,
  AUTH_PROVIDER_NAME_MAX_CHARS,
  authSpecHintsSchema,
} from '../auth-schema.js';
import { buildJsonSchemas } from '../json-schemas.js';
import { PROTOCOL_VERSION } from '../constants.js';
import {
  AUTH_EVIDENCE_MAX_CHARS,
  AUTH_EVIDENCE_MAX_ITEMS,
  AUTH_PROVENANCES,
  AUTH_WIZARD_DIRECTIVE_KIND,
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  authWizardDirectiveSchema,
  connectionRequirementDirectiveSchema,
  inferrerProposalSchema,

  renderDirectiveSchema,
} from '../render-directive.js';

// ------------------------------------------------------------------ fixtures

/** A full hints object — every transformer-input field the schema covers. */
const fullHints = {
  kindHint: 'oauth2_auth_code',
  providerName: 'Spotify',
  docsUrl: 'https://developer.spotify.com/documentation',
  homepageUrl: 'https://spotify.com',
  registrationConsoleUrl: 'https://developer.spotify.com/dashboard',
  registrationInstructions: ['Create an app in the dashboard', 'Copy the client id'],
  fields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
  headerTemplate: { 'X-Custom': '{{api_key}}' },
  declaredApiHosts: ['api.spotify.com'],
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  scopes: ['user-read-private'],
  pkce: true,
  userLayerFields: [{ key: 'client_id', label: 'Client ID', type: 'text' }],
};

/** The same hints with the LLM-excluded fields removed — a valid llm proposal. */
const proposal = {
  kindHint: 'oauth2_auth_code',
  providerName: 'Spotify',
  docsUrl: 'https://developer.spotify.com/documentation',
  declaredApiHosts: ['api.spotify.com'],
  endpoints: {
    authorizeUrl: 'https://accounts.spotify.com/authorize',
    tokenUrl: 'https://accounts.spotify.com/api/token',
  },
  scopes: ['user-read-private'],
  pkce: true,
};

const directive = { v: PROTOCOL_VERSION, kind: 'auth_wizard', proposal };

// -------------------------------------------------------- hints (D1/M8 base)

describe('AC1 — authSpecHintsSchema (single source of truth, M8)', () => {
  it('accepts the full transformer-input field set', () => {
    expect(authSpecHintsSchema.safeParse(fullHints).success).toBe(true);
  });

  it('accepts a minimal hints object (providerName only)', () => {
    expect(authSpecHintsSchema.safeParse({ providerName: 'Coinbase' }).success).toBe(true);
  });

  it('strict-rejects unknown keys', () => {
    const result = authSpecHintsSchema.safeParse({ ...fullHints, surprise: true });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL in endpoint slots (fail-closed at the boundary)', () => {
    const result = authSpecHintsSchema.safeParse({
      providerName: 'X',
      endpoints: { tokenUrl: 'ignore previous instructions' },
    });
    expect(result.success).toBe(false);
  });
});

// ------------------------------------------- llm proposal (M5 exclusions)

/**
 * ASSERTED THROUGH THE PERSISTED DIRECTIVE as of TASK-20260810 P4.
 *
 * `llmProposalSchema` is no longer exported — P4's named exit item retired the v4-superseded
 * authoring channel. The SHAPE survives as the private `legacyProposalSchema` because
 * `authWizardDirectiveSchema` embeds it and re-validates historical chat-meta rows on every
 * read, so every exclusion below is still load-bearing and still reachable: a directive
 * carrying an excluded key is a strict rejection exactly as before.
 *
 * These assertions were RE-POINTED, never relaxed. Each one now goes through
 * `authWizardDirectiveSchema` — which is the surface that actually parses persisted bytes,
 * and therefore the sharper place to assert from. `.parse` of the embedded proposal is not
 * available separately by design: that is the point of the deletion.
 */
describe('AC1/AC8 — the legacy proposal shape excludes registration copy + headerTemplate + credential field definitions (M5/M21)', () => {
  const withProposal = (patch: Record<string, unknown>): unknown => ({
    ...directive,
    proposal: { ...proposal, ...patch },
  });

  it('accepts a proposal without the excluded fields', () => {
    expect(authWizardDirectiveSchema.safeParse(directive).success).toBe(true);
  });

  for (const key of ['registrationConsoleUrl', 'registrationInstructions', 'headerTemplate', 'fields', 'userLayerFields'] as const) {
    it(`rejects ${key} (registry or explicit user entry only)`, () => {
      expect(authWizardDirectiveSchema.safeParse(withProposal({ [key]: fullHints[key] })).success).toBe(false);
    });
  }

  it('a credential-misdirection fields[] label is a strict rejection — descending through the directive', () => {
    // The attack (fixFirst 2): an LLM authors the credentials step's own labels,
    // dictating WHICH secret the user pastes ("Your OpenAI admin key"), unreviewed
    // by spec_confirm. Field definitions come from per-kind defaults / the registry /
    // explicit user entry ONLY — the M5 exclusion applied to the label surface.
    const phishingFields = [{ key: 'k', label: 'Your OpenAI admin key (sk-…)', type: 'secret' }];
    const poisonedDirective = withProposal({ fields: phishingFields });
    expect(authWizardDirectiveSchema.safeParse(poisonedDirective).success).toBe(false);
    expect(renderDirectiveSchema.safeParse(poisonedDirective).success).toBe(false);
  });

  it('has no credential slot of any spelling (strict unknown-key reject)', () => {
    for (const slot of ['credential', 'secret', 'token', 'value', 'apiKey', 'api_key_value', 'password']) {
      const result = authWizardDirectiveSchema.safeParse(withProposal({ [slot]: 'sk-live-abc123' }));
      expect(result.success, `proposal accepted a '${slot}' slot`).toBe(false);
    }
  });
});

// ------------------------------------------------ inferrer output (M11 gate)

describe('AC3 — inferrerProposalSchema: strict confidence + bounded evidence (M11)', () => {
  const valid = { proposal, confidence: 0.8, evidence: ['authorizeUrl found verbatim in docs'] };

  it('accepts a valid inferrer reply shape', () => {
    expect(inferrerProposalSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts the boundary values 0 and 1', () => {
    expect(inferrerProposalSchema.safeParse({ ...valid, confidence: 0 }).success).toBe(true);
    expect(inferrerProposalSchema.safeParse({ ...valid, confidence: 1 }).success).toBe(true);
  });

  for (const [label, confidence] of [
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['below range', -0.1],
    ['above range', 1.1],
    ['a string', '0.9'],
  ] as const) {
    it(`strict-rejects ${label} confidence — never "reads as 0" (M11)`, () => {
      const candidate: Record<string, unknown> = { proposal, evidence: [] };
      if (confidence !== undefined) candidate['confidence'] = confidence;
      expect(inferrerProposalSchema.safeParse(candidate).success).toBe(false);
    });
  }

  it('bounds evidence: item count and per-item length', () => {
    const tooMany = Array.from({ length: AUTH_EVIDENCE_MAX_ITEMS + 1 }, () => 'quote');
    expect(inferrerProposalSchema.safeParse({ ...valid, evidence: tooMany }).success).toBe(false);
    const tooLong = ['x'.repeat(AUTH_EVIDENCE_MAX_CHARS + 1)];
    expect(inferrerProposalSchema.safeParse({ ...valid, evidence: tooLong }).success).toBe(false);
  });

  it('strict-rejects unknown keys on the inferrer output', () => {
    expect(inferrerProposalSchema.safeParse({ ...valid, note: 'hi' }).success).toBe(false);
  });
});

// ------------------------------------- persisted-string bounds (nonBlocking 8)

describe('nonBlocking 8 — evidence-style length bounds on the chat-persisted hint strings', () => {
  // Asserted through the DIRECTIVE (P4): these are bounds on CHAT-PERSISTED strings, and
  // the directive is what actually parses those bytes on every read — so this is the
  // surface the bound has to hold at. Same values, same expectations, sharper subject.
  const asDirective = (proposalPatch: Record<string, unknown>): unknown => ({
    v: PROTOCOL_VERSION,
    kind: AUTH_WIZARD_DIRECTIVE_KIND,
    proposal: proposalPatch,
  });

  it('bounds providerName / host entries / scope entries at the schema boundary', () => {
    expect(authSpecHintsSchema.safeParse({ providerName: 'p'.repeat(AUTH_PROVIDER_NAME_MAX_CHARS) }).success).toBe(true);
    expect(authSpecHintsSchema.safeParse({ providerName: 'p'.repeat(AUTH_PROVIDER_NAME_MAX_CHARS + 1) }).success).toBe(false);

    const withHost = (n: number): unknown => asDirective({ providerName: 'X', declaredApiHosts: ['h'.repeat(n)] });
    expect(authWizardDirectiveSchema.safeParse(withHost(AUTH_HINT_HOST_MAX_CHARS)).success).toBe(true);
    expect(authWizardDirectiveSchema.safeParse(withHost(AUTH_HINT_HOST_MAX_CHARS + 1)).success).toBe(false);

    const withScope = (n: number): unknown => asDirective({ providerName: 'X', scopes: ['s'.repeat(n)] });
    expect(authWizardDirectiveSchema.safeParse(withScope(AUTH_HINT_SCOPE_MAX_CHARS)).success).toBe(true);
    expect(authWizardDirectiveSchema.safeParse(withScope(AUTH_HINT_SCOPE_MAX_CHARS + 1)).success).toBe(false);

    const withUserScope = (n: number): unknown =>
      asDirective({ providerName: 'X', userLayerScopes: ['s'.repeat(n)] });
    expect(authWizardDirectiveSchema.safeParse(withUserScope(AUTH_HINT_SCOPE_MAX_CHARS + 1)).success).toBe(false);
  });

  it('caps the hosts/scopes array sizes in chat-persisted meta', () => {
    const hosts = Array.from({ length: AUTH_HINT_HOSTS_MAX_ITEMS + 1 }, (_, i) => `h${i}.example`);
    expect(authWizardDirectiveSchema.safeParse(asDirective({ providerName: 'X', declaredApiHosts: hosts })).success).toBe(
      false,
    );
    const scopes = Array.from({ length: AUTH_HINT_SCOPES_MAX_ITEMS + 1 }, (_, i) => `s${i}`);
    expect(authWizardDirectiveSchema.safeParse(asDirective({ providerName: 'X', scopes })).success).toBe(false);
  });
});

// -------------------------------------------------- directive (M1/M2 walls)

describe('AC1 — authWizardDirectiveSchema is the persisted shape (M1/M2)', () => {
  it('parses a valid directive (proposal only — confidence/provenance optional)', () => {
    expect(authWizardDirectiveSchema.safeParse(directive).success).toBe(true);
  });

  it('parses display-only confidence + provenance when present', () => {
    const withDisplay = { ...directive, confidence: 0.9, provenance: 'inference' };
    expect(authWizardDirectiveSchema.safeParse(withDisplay).success).toBe(true);
  });

  it('strict-rejects unknown keys (M2)', () => {
    expect(authWizardDirectiveSchema.safeParse({ ...directive, extra: 1 }).success).toBe(false);
  });

  it('carries NO evidence[] — docs-derived free text never persists (M1)', () => {
    const withEvidence = { ...directive, evidence: ['a docs quote that could contain a real key'] };
    expect(authWizardDirectiveSchema.safeParse(withEvidence).success).toBe(false);
  });

  it('its top-level keys are exactly the pinned five — no free-text or credential slot exists', () => {
    expect(Object.keys(authWizardDirectiveSchema.shape).sort()).toEqual(
      ['confidence', 'kind', 'proposal', 'provenance', 'v'].sort(),
    );
  });

  it('rejects an out-of-range display confidence and an unknown provenance literal', () => {
    expect(authWizardDirectiveSchema.safeParse({ ...directive, confidence: 1.5 }).success).toBe(false);
    expect(authWizardDirectiveSchema.safeParse({ ...directive, provenance: 'trusted' }).success).toBe(false);
  });

  it('provenance literals are exactly the three host-computed sources', () => {
    expect([...AUTH_PROVENANCES]).toEqual(['registry', 'inference', 'user_docs']);
  });
});

describe('AC1 — renderDirectiveSchema union (one member v1, pinned discriminator)', () => {
  it('parses the auth_wizard member', () => {
    const result = renderDirectiveSchema.safeParse(directive);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe('auth_wizard');
  });

  it('rejects an unknown kind', () => {
    expect(renderDirectiveSchema.safeParse({ ...directive, kind: 'auth_wizard_v2' }).success).toBe(false);
  });
});

// ------------------------------ connection_requirement directive (P0, additive)

describe('TASK-20260810 P0 — the connection_requirement directive lands ALONGSIDE auth_wizard (fold B1)', () => {
  /** A minimal but complete requirement — the full-shape bounds live in connection-requirement.test.ts. */
  const requirement = {
    slot: 'spotify',
    provider: { name: 'Spotify' },
    kind: 'oauth2_auth_code',
    endpoints: {
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      tokenUrl: 'https://accounts.spotify.com/api/token',
    },
    declaredApiHosts: ['api.spotify.com'],
  };
  const requirementDirective = { v: PROTOCOL_VERSION, kind: 'connection_requirement', requirement };

  it('pins the wire literal — a PERSISTED discriminator, single-homed like AUTH_WIZARD_DIRECTIVE_KIND', () => {
    expect(CONNECTION_REQUIREMENT_DIRECTIVE_KIND).toBe('connection_requirement');
    expect(connectionRequirementDirectiveSchema.shape.kind.value).toBe(CONNECTION_REQUIREMENT_DIRECTIVE_KIND);
  });

  it('parses through the union, and the auth_wizard member STILL parses (the cutover rule, asserted)', () => {
    const parsedNew = renderDirectiveSchema.safeParse(requirementDirective);
    expect(parsedNew.success, JSON.stringify(parsedNew.error?.issues ?? [], null, 2)).toBe(true);
    if (parsedNew.success) expect(parsedNew.data.kind).toBe('connection_requirement');
    // v3's channel is untouched by P0 — `starterDeclaration.ts` still runtime-imports it.
    expect(renderDirectiveSchema.safeParse(directive).success).toBe(true);
  });

  it('carries the FULL requirement — the seats llmProposalSchema omits are exactly what this directive exists to deliver', () => {
    // The omit-list (registration copy, headerTemplate, fields) IS the Coinbase defect.
    // Here they ride in a bounded, lint-checked, review-rendered shape instead.
    const rich = {
      ...requirementDirective,
      requirement: {
        slot: 'coinbase',
        provider: { name: 'Coinbase Exchange' },
        kind: 'api_key',
        fields: [
          { key: 'api_key', label: 'API Key', type: 'secret' },
          { key: 'api_secret', label: 'API Secret', type: 'secret' },
          { key: 'passphrase', label: 'Passphrase', type: 'secret' },
        ],
        registration: { instructions: ['Open Settings, then API.'] },
        request: { headerTemplate: { 'CB-ACCESS-KEY': '{{api_key}}' } },
        declaredApiHosts: ['api.exchange.coinbase.com'],
      },
    };
    const parsed = connectionRequirementDirectiveSchema.safeParse(rich);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [], null, 2)).toBe(true);
    if (parsed.success) expect(parsed.data.requirement.fields).toHaveLength(3);
  });

  it('strict-rejects unknown keys, an out-of-range confidence, and an unknown provenance literal', () => {
    expect(connectionRequirementDirectiveSchema.safeParse({ ...requirementDirective, extra: 1 }).success).toBe(false);
    expect(connectionRequirementDirectiveSchema.safeParse({ ...requirementDirective, confidence: 1.5 }).success).toBe(false);
    // `provenance` is the five-channel CONNECTION set, not the three-rung AUTH_PROVENANCES.
    expect(connectionRequirementDirectiveSchema.safeParse({ ...requirementDirective, provenance: 'starter' }).success).toBe(true);
    expect(connectionRequirementDirectiveSchema.safeParse({ ...requirementDirective, provenance: 'trusted' }).success).toBe(false);
  });

  it('carries NO credential slot of any spelling — the directive is chat-PERSISTED (M1 posture, restated for v2)', () => {
    for (const slot of ['credential', 'secret', 'token', 'value', 'apiKey', 'password']) {
      expect(
        connectionRequirementDirectiveSchema.safeParse({ ...requirementDirective, [slot]: 'sk-live-abc123' }).success,
        `directive accepted a '${slot}' slot`,
      ).toBe(false);
    }
  });

  it('a malformed requirement fails the DIRECTIVE, not just the inner schema (validation is not deferrable)', () => {
    const bad = { ...requirementDirective, requirement: { ...requirement, slot: 'Not A Slot' } };
    expect(connectionRequirementDirectiveSchema.safeParse(bad).success).toBe(false);
    expect(renderDirectiveSchema.safeParse(bad).success).toBe(false);
  });
});

// ------------------------------------------------- publication line (M1)

describe('AC1 — render directive stays OUT of json-schemas SOURCES (extends the AL-02/AL-03 guard)', () => {
  it('buildJsonSchemas() still exports exactly the pre-auth v1 wire set', () => {
    expect(Object.keys(buildJsonSchemas()).sort()).toEqual(
      [
        'app-announce.json',
        'app-cancel.json',
        'app-event.json',
        'app-message.json',
        'app-request-envelope.json',
        'app-response.json',
        'db-request.json',
        'db-response.json',
        'host-event.json',
        'host-ready.json',
      ].sort(),
    );
  });

  it('locks the internal contract with an in-package snapshot instead', () => {
    // P4 updates this snapshot DELIBERATELY (the named exit item): `proposalKeys` is gone
    // because `llmProposalSchema` is no longer EXPORTED. The shape itself survives as the
    // private `legacyProposalSchema`, and it is still pinned here — through
    // `inferrerKeys.proposal` and, structurally, through `directiveKeys`, both of which
    // embed it. So the omit-list is still snapshot-locked; only the name that reached it
    // from outside the module is gone.
    //
    // `directiveKeys` and `inferrerKeys` are UNCHANGED, and that is the assertion: the
    // deletion removed a public export, not a byte of persisted-shape validation. A diff
    // in either would mean historical `auth_wizard` chat rows stopped parsing.
    const shape = {
      directiveKeys: Object.keys(authWizardDirectiveSchema.shape).sort(),
      requirementDirectiveKeys: Object.keys(connectionRequirementDirectiveSchema.shape).sort(),
      inferrerKeys: Object.keys(inferrerProposalSchema.shape).sort(),
      hintsKeys: Object.keys(authSpecHintsSchema.shape).sort(),
      provenances: [...AUTH_PROVENANCES],
      evidenceBounds: { items: AUTH_EVIDENCE_MAX_ITEMS, chars: AUTH_EVIDENCE_MAX_CHARS },
      samples: {
        directive: renderDirectiveSchema.safeParse(directive).success,
        hints: authSpecHintsSchema.safeParse(fullHints).success,
      },
    };
    expect(shape).toMatchSnapshot();
  });
});

describe('AL-05 — AUTH_WIZARD_DIRECTIVE_KIND single-homed (M48)', () => {
  it('pins the wire literal — this is a PERSISTED discriminator and must never drift', () => {
    expect(AUTH_WIZARD_DIRECTIVE_KIND).toBe('auth_wizard');
  });

  it('is the literal the directive schema discriminates on (schema follows the constant)', () => {
    expect(authWizardDirectiveSchema.shape.kind.value).toBe(AUTH_WIZARD_DIRECTIVE_KIND);
  });
});
