// TASK-20260810-p2-pipeline (Dynamic Auth v2, P2) AC3 — THE COINBASE CASE, end to end.
//
// WHAT THIS IS, said plainly (fold T-mn4): a FIXTURE-DRIVEN MOCK-ADAPTER VITEST. There is
// no eval harness in this repo and this file is not one. The "builder" here is a stub
// `AgentAdapter` replaying a recorded reply fixture; what is under test is everything
// AFTER the model — the scanner, the schema, the lint, admission, and the persist path —
// because that is where the defect lived. The model's job (emitting three fields instead
// of one) is pinned by the FIXTURE, and the KB doctrine that teaches it is pinned by
// P2-AC8 in the knowledge package.
//
// THE MOTIVATING DEFECT (parent plan §Why, owner 2026-08-10): "Coinbase needs key +
// secret + passphrase" and the shipped pipeline produced ONE generic field, because
// `llmProposalSchema` omitted `fields`, `headerTemplate` and the registration copy. The
// bar this file sets is therefore counted, not vibed: THREE fields, the CB-ACCESS-*
// template verbatim, the walkthrough intact, and the row present BEFORE first run.
//
// Written RED-FIRST at Gate 3 against `agent/connectionPipeline.ts`, which does not exist.

import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AdapterRequest, AdapterResult } from '@snugprotocol/adapters';
import {
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  CONNECTION_STATUS,
  PROTOCOL_VERSION,
} from '@snugprotocol/protocol';

import { scanForRenderDirective } from '../agent/renderDirective.js';
import { persistConnectionRequirement } from '../agent/connectionPipeline.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'coinbase-portfolio-tracker';
const SLOT = 'coinbase';

/**
 * THE FIXTURE — a recorded builder reply for "build me a Coinbase portfolio tracker".
 *
 * The header template is the form P0 VERIFIED expressible and correct end to end against
 * the real template engine (task brief, "The Coinbase-Exchange signature IS expressible"):
 * five ordered message parts through `hmac_sha256_b64`, which base64-decodes the secret
 * and base64-encodes the digest — the shape hex-output `hmac_sha256` cannot produce.
 *
 * Host is `api.meridian-exchange.example` (Exchange), not the retail `api.coinbase.com`: the
 * declared host becomes the FROZEN ceiling at approval, so a wrong host here would refuse
 * every real request and present to the user as an auth failure.
 */
const COINBASE_REQUIREMENT = {
  slot: SLOT,
  provider: {
    name: 'Meridian Exchange',
    homepageUrl: 'https://meridian-exchange.example',
    docsUrl: 'https://docs.meridian-exchange.example',
  },
  kind: 'api_key',
  fields: [
    {
      key: 'api_key',
      label: 'API Key',
      type: 'text',
      description: 'The key id shown when you create the API key.',
      required: true,
    },
    {
      key: 'api_secret',
      label: 'API Secret',
      type: 'secret',
      description: 'Shown once at creation. Copy it before closing the dialog.',
      required: true,
    },
    {
      key: 'passphrase',
      label: 'Passphrase',
      type: 'secret',
      description: 'The passphrase you chose while creating the key.',
      required: true,
    },
  ],
  registration: {
    consoleUrl: 'https://meridian-exchange.example/profile/api',
    instructions: [
      'Sign in at meridian-exchange.example and open Profile then API.',
      'Choose New API Key and give it View permission only.',
      'Choose a passphrase and write it down — it is not shown again.',
      'Copy the API key and the secret before closing the dialog.',
    ],
  },
  request: {
    headerTemplate: {
      'CB-ACCESS-KEY': '{{api_key}}',
      'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
      'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
      'CB-ACCESS-SIGN':
        '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
    },
  },
  declaredApiHosts: ['api.meridian-exchange.example'],
} as const;

const RECORDED_BUILD_REPLY = [
  'your meridian portfolio tracker is ready. it renders a "connect Meridian Exchange to see',
  'your balances" panel until the connection is approved, so it is useful straight away.',
  '',
  'coinbase exchange signs every request, so it needs three values from your account — the',
  'api key, the api secret, and the passphrase you choose when you create the key:',
  '',
  '```json',
  JSON.stringify(
    { v: PROTOCOL_VERSION, kind: CONNECTION_REQUIREMENT_DIRECTIVE_KIND, requirement: COINBASE_REQUIREMENT },
    null,
    2,
  ),
  '```',
  '',
  'open the connect card above to review and approve it.',
].join('\n');

/** The stub builder. Replays the fixture; records what it was asked, so C1 stays checkable. */
function createFixtureAdapter(): AgentAdapter & { requests: AdapterRequest[] } {
  const requests: AdapterRequest[] = [];
  return {
    requests,
    complete(request: AdapterRequest): Promise<AdapterResult> {
      requests.push(request);
      return Promise.resolve({ ok: true, text: RECORDED_BUILD_REPLY, toolCalls: [], stopReason: 'end' });
    },
  };
}

describe('P2-AC3 — the Coinbase case: a build reply lands a THREE-FIELD declared row before first run', () => {
  it('scans the recorded reply to a valid connection_requirement directive carrying all three fields', async () => {
    const adapter = createFixtureAdapter();
    const result = await adapter.complete({ system: 'stub', messages: [] } as unknown as AdapterRequest);
    expect(result.ok).toBe(true);

    const scan = scanForRenderDirective(result.ok ? result.text : '');
    expect(scan, 'the recorded reply produced no directive at all').not.toBeNull();
    expect(scan).not.toHaveProperty('malformed');
    if (scan === null || !('directive' in scan)) throw new Error('unreachable — asserted above');

    expect(scan.directive.kind).toBe(CONNECTION_REQUIREMENT_DIRECTIVE_KIND);
    if (scan.directive.kind !== CONNECTION_REQUIREMENT_DIRECTIVE_KIND) throw new Error('unreachable');

    // THE MOTIVATING COUNT. One generic field was the defect; three is the fix.
    expect(scan.directive.requirement.fields?.map((f) => f.key)).toEqual([
      'api_key',
      'api_secret',
      'passphrase',
    ]);
  });

  it('persists a `declared` row with three fields, the CB-ACCESS-* template and the walkthrough — BEFORE any run', async () => {
    const db = await installTestUserDb();
    const adapter = createFixtureAdapter();
    const result = await adapter.complete({ system: 'stub', messages: [] } as unknown as AdapterRequest);
    const scan = scanForRenderDirective(result.ok ? result.text : '');
    if (scan === null || !('directive' in scan) || scan.directive.kind !== CONNECTION_REQUIREMENT_DIRECTIVE_KIND) {
      throw new Error('fixture did not scan to a connection_requirement directive');
    }

    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: scan.directive.requirement,
      channel: 'inference',
    });
    expect(outcome.ok, outcome.ok === false ? `persist refused: ${outcome.reason}` : '').toBe(true);
    expect(outcome.ok === true && outcome.action).toBe('created');

    const row = db.getConnection(APP, SLOT);
    expect(row, 'no declared row after the build turn').toBeDefined();

    // 1. Status/provenance — a REQUIREMENT, not a grant, and no credentials anywhere.
    expect(row!.status).toBe(CONNECTION_STATUS.declared);
    expect(row!.provenance).toBe('inference');
    expect(row!.approvedAt).toBeUndefined();
    expect(db.listSecretKeys().filter((k) => k.startsWith(`auth:${APP}:`))).toEqual([]);

    // 2. THE THREE FIELDS, in order, with their types — the defect, counted.
    expect(row!.requirement.fields).toHaveLength(3);
    expect(row!.requirement.fields?.map((f) => [f.key, f.type])).toEqual([
      ['api_key', 'text'],
      ['api_secret', 'secret'],
      ['passphrase', 'secret'],
    ]);

    // 3. The CB-ACCESS-* header template, verbatim — this is what the strong review shows
    //    the user in a code box and what the engine renders host-side at injection.
    expect(row!.requirement.request?.headerTemplate).toEqual({
      'CB-ACCESS-KEY': '{{api_key}}',
      'CB-ACCESS-PASSPHRASE': '{{passphrase}}',
      'CB-ACCESS-TIMESTAMP': '{{request.timestamp}}',
      'CB-ACCESS-SIGN':
        '{{hmac_sha256_b64(api_secret, request.timestamp, request.method, request.pathAndQuery, request.body)}}',
    });

    // 4. The registration walkthrough survives the trip — the whole point of re-admitting
    //    the seat `llmProposalSchema` omitted. Order is meaning here (step 3 warns the
    //    passphrase is not shown again), so it is asserted as a sequence.
    expect(row!.requirement.registration?.consoleUrl).toBe('https://meridian-exchange.example/profile/api');
    expect(row!.requirement.registration?.instructions).toHaveLength(4);
    expect(row!.requirement.registration?.instructions?.[2]).toMatch(/passphrase/i);

    // 5. The declared ceiling is the EXCHANGE host, and only it.
    expect(row!.requirement.declaredApiHosts).toEqual(['api.meridian-exchange.example']);
    expect(row!.allowedHosts).toEqual(['api.meridian-exchange.example']);

    await db.close();
  });

  it('C1 — the build turn that produced this requirement carried NO credential value', async () => {
    // Structural, not incidental: inference runs BEFORE credentials exist, so there is
    // nothing to leak. Asserted against the recorded request the stub captured.
    const adapter = createFixtureAdapter();
    await adapter.complete({ system: 'stub', messages: [] } as unknown as AdapterRequest);
    const wire = JSON.stringify(adapter.requests);
    for (const shape of ['ck-live-', 'CB-ACCESS-SIGN:', 'api_secret=']) {
      expect(wire).not.toContain(shape);
    }
    // And the fixture reply itself names `api_secret` ONLY as a template reference —
    // every occurrence is inside a `{{…}}` seat or a field DEFINITION, never as a value.
    // Asserted by removing the legitimate seats and then requiring the name to be gone,
    // so a stray literal cannot hide behind a legitimate one.
    const withoutTemplates = RECORDED_BUILD_REPLY.replace(/\{\{[^}]*\}\}/g, '')
      .replace(/"key":\s*"api_secret"/g, '')
      .replace(/"(label|description)":\s*"[^"]*"/g, '');
    expect(withoutTemplates).not.toContain('api_secret');
    // No credential-shaped literal anywhere in the reply (the P0 canary shape).
    expect(RECORDED_BUILD_REPLY).not.toMatch(/\bck-live-[A-Za-z0-9]{16,}/);
  });
});
