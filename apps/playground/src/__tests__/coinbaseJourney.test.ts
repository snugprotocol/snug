// coinbaseJourney.test.ts — TASK-20260812-registry-authoritative-auth, P3
// (the whole-surface check: the owner's ACTUAL journey, end to end on production seams).
//
// THE JOURNEY UNDER TEST: the model writes a Coinbase app that calls
// `useConnectedFetch` and closes its reply with no directive → the post-turn recovery
// asks the inferrer → the registry rung answers → a row PERSISTS with the registry's
// OWN kind and all three named fields → the wizard opens for it and routes
// credentials → done, never rendering a Connect button.
//
// WHY EACH LINK IS PINNED. The P0 reproduction (task file, 2026-08-12) showed the
// pre-fix chain silently produced a WRONG-KIND row: the inferrer hardcoded
// `oauth2_auth_code`, admission substituted the fields but (deliberately, D6) never the
// kind, and the wizard then routed an API-key provider to an OAuth sign-in that cannot
// succeed. This suite is the one place the whole chain is asserted TOGETHER, so a
// regression in any link fails here even if every unit suite stays green.
import { beforeEach, describe, expect, it } from 'vitest';

import type { UserDb } from '@snugprotocol/db';
import { deriveConnectionAllowedHosts } from '@snugprotocol/protocol';
import { requirementFromRegistryEntry, WELL_KNOWN_PROVIDERS_REGISTRY } from '@snugprotocol/auth';

import { finalizeConnectionDeclaration } from '../agent/connectionPipeline.js';
import { runConnectionRequirementInference } from '../agent/connectionInferrerAdapter.js';
import { authChoiceForPersistedRow } from '../agent/authChoiceCard.js';
import { chooseAuthOption } from '../state/authKindChoice.js';
import {
  __resetConnectionWizardForTests,
  connectionWizardSlotStore,
  connectionWizardStore,
  needsOAuthConnectStep,
  nextStep,
  openConnectionWizardForApp,
} from '../state/connectionWizard.js';
import { installTestUserDb } from './userdbTestHelper.js';

const APP = 'app-coinbase-journey';

const COINBASE_HTML = `<!doctype html><html><body><script>
  const { fetch: connectedFetch } = useConnectedFetch();
  connectedFetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
</script></body></html>`;

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __resetConnectionWizardForTests();
});

describe('P3 — the owner journey: undeclared Coinbase build → reviewable api_key row → no Connect step', () => {
  it('recovery persists the registry-authoritative row and the wizard routes around OAuth', async () => {
    // 1. BUILD: the reply declares nothing; the production recovery wire runs, with a
    //    poison adapter so any model call is a hard failure (Coinbase is pinned).
    const outcome = await finalizeConnectionDeclaration(db, {
      appId: APP,
      html: COINBASE_HTML,
      reply: 'here is your tracker!',
      channel: 'inference',
      recoverRequirement: async (request) => {
        const result = await runConnectionRequirementInference({
          ...request,
          adapter: {
            complete: async () => {
              throw new Error('the registry rung must answer without a model');
            },
          },
        });
        if (!result.ok || result.requirement === null) return undefined;
        return { requirement: result.requirement, provenance: result.provenance };
      },
    });

    expect(outcome?.ok, 'recovery must persist, not fall through to the honest note').toBe(true);

    // 2. THE ROW: registry-authoritative kind AND fields, reviewable, never approved.
    const rows = db.listConnections(APP);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.slot).toBe('coinbase');
    expect(row.status).toBe('declared');
    expect(row.provenance).toBe('registry');
    expect(row.requirement.kind, 'the registry\'s OWN kind — the founding fix').toBe('api_key');
    expect(row.requirement.provider.name).toBe('Coinbase');
    // MIGRATED 2026-08-13 (TASK-20260812-desktop-auth-awareness P3, ADR-0022 §5): the
    // named CDP pair — the old key/secret/passphrase trio described retail HMAC keys
    // Coinbase expired 2025-02-05. The founding defect was UNNAMED boxes, not a count.
    expect(
      row.requirement.fields?.map((field) => field.key),
      'the named CDP secrets reach the row (the founding defect was unnamed boxes)',
    ).toEqual(['api_key', 'ed25519_private_key']);
    expect(
      row.requirement.request?.headerTemplate,
      'the pinned signing template must PERSIST — a row without it falls to the X-Api-Key kind default',
    ).toEqual({ Authorization: 'Bearer {{cdp_jwt(api_key, ed25519_private_key)}}' });
    expect(row.requirement.testRequest, 'the pinned probe must persist for the wizard').toEqual({
      method: 'GET',
      pathAndQuery: '/api/v3/brokerage/accounts',
    });
    expect(row.allowedHosts).toEqual(['api.coinbase.com']);

    // 3. THE CTA: the same call the net-error banner makes now finds the row.
    const opened = await openConnectionWizardForApp(APP, 'error_cta');
    expect(opened).toBe(true);
    expect(connectionWizardStore.get()?.appId).toBe(APP);
    expect(connectionWizardSlotStore.get()).toBe('coinbase');

    // 4. THE ROUTING: an api_key requirement goes credentials → done. No Connect
    //    button, no OAuth flow, no 'this connection does not sign you in' dead end.
    expect(needsOAuthConnectStep(row.requirement)).toBe(false);
    expect(nextStep('credentials', row.requirement)).toBe('done');
  });
});

describe('P4 (auth-kind-choice) — the SWITCHED journey: the user picks Coinbase OAuth instead', () => {
  it('recovery seeds the choice; choosing OAuth rebinds the row and routes to the connect step', async () => {
    // Same build as above, condensed: recovery lands the api_key default.
    const outcome = await finalizeConnectionDeclaration(db, {
      appId: APP,
      html: COINBASE_HTML,
      reply: 'here is your tracker!',
      channel: 'inference',
      recoverRequirement: async (request) => {
        const result = await runConnectionRequirementInference({
          ...request,
          adapter: { complete: async () => { throw new Error('registry must answer'); } },
        });
        if (!result.ok || result.requirement === null) return undefined;
        return { requirement: result.requirement, provenance: result.provenance };
      },
    });
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;

    // The turn seeds a choice card for this multi-option provider (AC3's other half).
    const seed = authChoiceForPersistedRow({ appId: APP, requirement: outcome.requirement });
    expect(seed).toBeDefined();
    expect(seed!.providerName).toBe('Coinbase');

    // The user picks the OAuth option (the card builds this exact requirement).
    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['coinbase']!;
    const oauthOption = entry.authOptions![0]!;
    const chosen = await chooseAuthOption({
      appId: APP,
      slot: 'coinbase',
      requirement: requirementFromRegistryEntry(entry, 'Coinbase', 'coinbase', oauthOption),
    });
    expect(chosen.ok).toBe(true);

    // The STORED row is the user's choice, durably (AC12 + R3), and routing follows it.
    const row = db.getConnection(APP, 'coinbase')!;
    expect(row.provenance).toBe('user');
    expect(row.requirement.kind).toBe('oauth2_auth_code');
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['client_id']);
    expect(row.requirement.endpoints?.authorizeUrl).toBe('https://login.coinbase.com/oauth2/auth');
    expect(needsOAuthConnectStep(row.requirement)).toBe(true);
    expect(nextStep('credentials', row.requirement)).toBe('connect');
    // The frozen-ceiling derivation now includes the OAuth host, from the option's own
    // endpoints — never from anything a message proposed.
    expect(deriveConnectionAllowedHosts(row.requirement)).toEqual(['api.coinbase.com', 'login.coinbase.com']);
  });
});

describe('P4 (auth-kind-choice) — the GitHub journey: PAT default, OAuth app on request', () => {
  it('an undeclared GitHub app recovers as bearer_token; choosing the OAuth app rebinds fully', async () => {
    const html = `<!doctype html><html><body><script>
      const { fetch: connectedFetch } = useConnectedFetch();
      connectedFetch('https://api.github.com/user/repos');
    </script></body></html>`;
    const outcome = await finalizeConnectionDeclaration(db, {
      appId: 'app-github-journey',
      html,
      reply: 'repo browser, done!',
      channel: 'inference',
      recoverRequirement: async (request) => {
        const result = await runConnectionRequirementInference({
          ...request,
          adapter: { complete: async () => { throw new Error('registry must answer'); } },
        });
        if (!result.ok || result.requirement === null) return undefined;
        return { requirement: result.requirement, provenance: result.provenance };
      },
    });
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok !== true) return;
    expect(outcome.requirement.kind).toBe('bearer_token');
    expect(nextStep('credentials', outcome.requirement)).toBe('done');

    const entry = WELL_KNOWN_PROVIDERS_REGISTRY['github']!;
    const chosen = await chooseAuthOption({
      appId: 'app-github-journey',
      slot: 'github',
      requirement: requirementFromRegistryEntry(entry, 'GitHub', 'github', entry.authOptions![0]!),
    });
    expect(chosen.ok).toBe(true);
    const row = db.getConnection('app-github-journey', 'github')!;
    expect(row.provenance).toBe('user');
    expect(row.requirement.kind).toBe('oauth2_auth_code');
    expect(row.requirement.fields?.map((field) => field.key)).toEqual(['client_id', 'client_secret']);
    expect(nextStep('credentials', row.requirement)).toBe('connect');
  });
});
