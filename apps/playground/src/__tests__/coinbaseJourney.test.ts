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

import { finalizeConnectionDeclaration } from '../agent/connectionPipeline.js';
import { runConnectionRequirementInference } from '../agent/connectionInferrerAdapter.js';
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
    expect(
      row.requirement.fields?.map((field) => field.key),
      'all three named secrets reach the row (the founding defect)',
    ).toEqual(['api_key', 'api_secret', 'passphrase']);
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
