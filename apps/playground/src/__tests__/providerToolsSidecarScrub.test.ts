/**
 * providerToolsSidecarScrub.test.ts — TASK-20260820-host-pseudonymisation AC10.
 *
 * The provider chat lane returns sidecar tool-result bodies to the model with no
 * app-message wire involved (fresh-context plan review 2026-08-20, blocker 2), so the
 * egress scrub at the transport seam never sees them. The SAME redaction module is
 * applied to sidecar-class results inside `renderProviderResult` — and ONLY
 * sidecar-class results: an ordinary API body is the provider's own data surface and
 * stays raw.
 *
 * OWN FILE, not more describes in providerTools.test.ts: the platform is set-once and
 * locked at first `getPlatform()` read, and that file's suites have already read it by
 * the time a sidecar seat could be installed. A vitest file is its own module registry,
 * so THIS file installs a desktop platform with a sidecar seat before anything reads it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { authConnectionCredentialSecretKey, SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY } from '@snugprotocol/db';
import { SIDECAR_SYMBOLIC_HOST } from '@snugprotocol/protocol';

import { installTestUserDb } from './userdbTestHelper.js';
import { buildProviderTools, PROVIDER_REQUEST_TOOL_NAME, renderProviderResult } from '../agent/providerTools.js';
import { scrubText } from '../agent/pseudonymizeEgress.js';
import { setPlatform } from '../platform/platform.js';
import { __resetNetStateForTests, invalidateNetGrants } from '../state/net.js';
import { __resetSidecarIdentityForTests } from '../state/sidecarIdentity.js';
import { getUserDb } from '../state/userdb.js';

const APP = 'app-telepath-chat';
const WA_SLOT = 'whatsapp';
const API_SLOT = 'melodine';
const API_HOST = 'api.melodine.example';

// Set ONCE, before any getPlatform read in this file's module registry. The seat
// delegates to a mutable stub so each test can vary the helper's answer.
let sidecarBody = '{}';
setPlatform({
  kind: 'desktop',
  capabilities: { subscriptionMode: false, hubSyncOrigin: false, lanHttpPrivate: true },
  sidecarCtl: async () => ({ running: true, nonce: 'n' }),
  sidecarFetch: async () => ({ status: 200, body: sidecarBody }),
});

const CONTACT_BODY = JSON.stringify({
  chats: [{ jid: '919876543210@s.whatsapp.net', name: 'Priya Sharma', isGroup: false }],
});

function buildTool(response?: () => Response): (input: Record<string, unknown>) => Promise<string> {
  const tools = buildProviderTools({
    appId: APP,
    getDb: () => getUserDb(),
    fetchImpl: async () => response?.() ?? new Response('{"top":"song"}', { status: 200 }),
  });
  const tool = tools.find((entry) => entry.def.name === PROVIDER_REQUEST_TOOL_NAME);
  if (tool === undefined) throw new Error('provider_request tool missing');
  return (input) => tool.run(input) as Promise<string>;
}

beforeEach(async () => {
  __resetNetStateForTests();
  __resetSidecarIdentityForTests();
  invalidateNetGrants(APP);
  sidecarBody = CONTACT_BODY;
  const db = await installTestUserDb();
  db.putDeclaredConnection(
    APP,
    WA_SLOT,
    {
      // No `fields`: pinned registry provider — the admission gate substitutes its own.
      slot: WA_SLOT,
      provider: { name: 'WhatsApp' },
      kind: 'linked_device',
      declaredApiHosts: [SIDECAR_SYMBOLIC_HOST],
    },
    'starter',
  );
  db.approveConnection(APP, WA_SLOT);
  // The executor injects credentials before the seat is dialed; without stored values it
  // refuses with NET_AUTH_FAILED and no body ever exists to scrub.
  db.setSecret(authConnectionCredentialSecretKey(APP, WA_SLOT, 'sidecar_token'), 'tok-minted-test');
  db.setSecret(authConnectionCredentialSecretKey(APP, API_SLOT, 'api_key'), 'key-test');
  db.putDeclaredConnection(
    APP,
    API_SLOT,
    {
      slot: API_SLOT,
      provider: { name: 'Melodine Streaming' },
      kind: 'api_key',
      fields: [{ key: 'api_key', label: 'API key', type: 'secret' }],
      request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
      declaredApiHosts: [API_HOST],
    },
    'inference',
  );
  db.approveConnection(APP, API_SLOT);
  db.setSetting(SIDECAR_IDENTITY_DIRECTORY_SETTING_KEY, ['Priya Sharma']);
});

describe('R-9 — sidecar-class results are pseudonymised before re-entering the context (AC10)', () => {
  it('a sidecar read reaches the model with identities and primitives redacted', async () => {
    const run = buildTool();
    const result = await run({ url: `snug-connection://${WA_SLOT}/chats`, method: 'GET' });

    expect(result).toContain('<api_result>');
    expect(result, 'R-9: a raw name must not re-enter the model context').not.toContain('Priya Sharma');
    expect(result, 'a jid is a dialable identifier').not.toContain('919876543210@s.whatsapp.net');
    expect(result).toContain('[contact]');
  });

  it('non-canonical spellings the executor accepts are still sidecar-class (review fold: line-scan finding 1)', async () => {
    // parseConnectionUrl lowercases the scheme and connected-fetch strips \t\n\r + trims
    // BEFORE parsing, so both of these EXECUTE as sidecar reads. A predicate that
    // re-spelled the grammar said "not sidecar" and returned the raw body to the model.
    const run = buildTool();
    for (const spelling of [`SNUG-CONNECTION://${WA_SLOT}/chats`, `  snug-connection://${WA_SLOT}/chats`]) {
      const result = await run({ url: spelling, method: 'GET' });
      expect(result, `spelling: ${JSON.stringify(spelling)}`).not.toContain('Priya Sharma');
      if (result.includes('<api_result>')) expect(result).toContain('[contact]');
    }
  });

  it('an ordinary API result stays raw — names an app is entitled to fetch are not redacted', async () => {
    const run = buildTool(() => new Response('{"organizer":"Priya Sharma"}', { status: 200 }));
    const result = await run({ url: `https://${API_HOST}/v1/guests`, method: 'GET' });

    expect(result).toContain('Priya Sharma');
    expect(result).not.toContain('[contact]');
  });

  it('renderProviderResult applies the injected scrub before the size cap', () => {
    const rendered = renderProviderResult(
      {
        ok: true,
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '{"who":"Priya Sharma","phone":"+91 98765 43210"}',
      },
      (text) => scrubText(text, ['Priya Sharma']),
    );
    expect(rendered).not.toContain('Priya Sharma');
    expect(rendered).not.toContain('98765');
    expect(rendered).toContain('[contact]');
    expect(rendered).toContain('[number]');
  });
});
