// AL-04 (TASK-20260806-auth-wizard) AC1: the render-directive contract — INTERNAL
// protocol surface (plan D1). Locks:
//   - `authSpecHintsSchema` as the single source of truth for transformer-input hints
//     (M8 — packages/auth re-derives ParamsToAuthSpecInput from it, never retypes);
//   - `llmProposalSchema` = hints MINUS registration copy + headerTemplate (M5 — an
//     LLM-authored proposal structurally cannot carry phishing registration copy or
//     control where the secret is injected);
//   - `inferrerProposalSchema` strict confidence in [0,1] + bounded evidence (M11);
//   - `authWizardDirectiveSchema` — the ONLY directive shape, which IS the persisted
//     shape: no credential slot, no evidence[], no docs-derived free text (M1);
//   - `authRequiredPayloadSchema` strict (M29);
//   - none of it enters json-schemas SOURCES (the publishes-to-spec line, mutation M1
//     of the AL-04 table — extends the AL-02/AL-03 guard).
import { describe, expect, it } from 'vitest';
import { AUTH_KINDS, authSpecHintsSchema } from '../auth-schema.js';
import { buildJsonSchemas } from '../json-schemas.js';
import { PROTOCOL_VERSION } from '../constants.js';
import {
  AUTH_EVIDENCE_MAX_CHARS,
  AUTH_EVIDENCE_MAX_ITEMS,
  AUTH_PROVENANCES,
  authRequiredPayloadSchema,
  authWizardDirectiveSchema,
  inferrerProposalSchema,
  llmProposalSchema,
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

describe('AC1/AC8 — llmProposalSchema excludes registration copy + headerTemplate + credential field definitions (M5/M21)', () => {
  it('accepts a proposal without the excluded fields', () => {
    expect(llmProposalSchema.safeParse(proposal).success).toBe(true);
  });

  for (const key of ['registrationConsoleUrl', 'registrationInstructions', 'headerTemplate', 'fields', 'userLayerFields'] as const) {
    it(`rejects ${key} (registry or explicit user entry only)`, () => {
      const poisoned = { ...proposal, [key]: fullHints[key] };
      const result = llmProposalSchema.safeParse(poisoned);
      expect(result.success).toBe(false);
    });
  }

  it('a credential-misdirection fields[] label is a strict rejection — on the proposal AND descending through the directive', () => {
    // The attack (fixFirst 2): an LLM authors the credentials step's own labels,
    // dictating WHICH secret the user pastes ("Your OpenAI admin key"), unreviewed
    // by spec_confirm. Field definitions come from per-kind defaults / the registry /
    // explicit user entry ONLY — the M5 exclusion applied to the label surface.
    const phishingFields = [{ key: 'k', label: 'Your OpenAI admin key (sk-…)', type: 'secret' }];
    expect(llmProposalSchema.safeParse({ ...proposal, fields: phishingFields }).success).toBe(false);
    const poisonedDirective = { ...directive, proposal: { ...proposal, fields: phishingFields } };
    expect(authWizardDirectiveSchema.safeParse(poisonedDirective).success).toBe(false);
    expect(renderDirectiveSchema.safeParse(poisonedDirective).success).toBe(false);
  });

  it('has no credential slot of any spelling (strict unknown-key reject)', () => {
    for (const slot of ['credential', 'secret', 'token', 'value', 'apiKey', 'api_key_value', 'password']) {
      const result = llmProposalSchema.safeParse({ ...proposal, [slot]: 'sk-live-abc123' });
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

// -------------------------------------------- AUTH_REQUIRED payload (M29)

describe('AC1 — authRequiredPayloadSchema (reserved code gets its payload, M29)', () => {
  const payload = { providerName: 'Spotify', kind: 'oauth2_auth_code', declaredApiHosts: ['api.spotify.com'] };

  it('parses the display-field payload', () => {
    expect(authRequiredPayloadSchema.safeParse(payload).success).toBe(true);
  });

  it('kind must be an AUTH_KINDS literal', () => {
    expect(AUTH_KINDS).toContain(payload.kind);
    expect(authRequiredPayloadSchema.safeParse({ ...payload, kind: 'oauth3' }).success).toBe(false);
  });

  it('strict-rejects unknown keys (M29 — the payload schema, not just the directive)', () => {
    expect(authRequiredPayloadSchema.safeParse({ ...payload, credential: 'x' }).success).toBe(false);
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
    const shape = {
      directiveKeys: Object.keys(authWizardDirectiveSchema.shape).sort(),
      proposalKeys: Object.keys(llmProposalSchema.shape).sort(),
      inferrerKeys: Object.keys(inferrerProposalSchema.shape).sort(),
      payloadKeys: Object.keys(authRequiredPayloadSchema.shape).sort(),
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
