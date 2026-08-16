// starterQueryCredentialJourney.test.ts — TASK-20260812-desktop-auth-awareness P4,
// AC6's "the two broken starters work" clause. Written RED-FIRST.
//
// THE DEFECT THIS CLOSES (owner repro 2026-08-12, spec item 5): weather-planner and
// crypto-portfolio were functionally broken at credential injection. Their manifests are
// deliberately BARE — slot, provider, kind, declaredApiHosts and nothing else — so the
// registry's substitution is the ONLY source of their request template. Until P4 neither
// registry entry carried one, so the executor fell to the `api_key` kind default and sent
// `X-Api-Key` to providers that read a query parameter. The user pasted a working key, the
// wizard said connected, and every request came back unauthorized.
//
// RE-POINTED (TASK-20260815-starter-apps-rebuild): the shelf was re-curated.
// weather-planner's successor is `weather` (same slot, same bare OpenWeather manifest),
// and the journey below runs against it unchanged in strength. crypto-portfolio has NO
// query-credential successor — its Coinbase-shaped successor `trade-copilot`
// authenticates via the registry's pinned CDP JWT Authorization header, so the CoinGecko
// half of this file's subject is OBSOLETE at the shelf. The registry-level guarantees it
// exercised (coingecko pins EXACTLY the `x_cg_demo_api_key` query template, substitution
// reaches a bare borrower, an authored template is refused) remain covered in
// packages/auth/src/__tests__/registry-query-credentials.test.ts; the cross-contamination
// suite at the bottom is reworked accordingly.
//
// WHY THIS FILE EXISTS BESIDE THE AUTH SUITE — and why it is not a fifth copy of
// connected-fetch-query-observer's fixture. That suite proves the ENGINE renders a query
// template, from a hand-written literal spec. Nothing there proves the REGISTRY supplies
// one for the shipped starter, or that it survives the trip through install → declared row
// → double admission → the frozen ceiling → the executor's own reader. That trip spans
// packages (auth's registry, db's admission gate, the playground's install act and deps
// assembly), so only a playground-altitude test can see it end to end. The seam under test
// is precisely the one a per-package test structurally cannot reach.
//
// TWO ANTI-VACUITY RULES this file follows (lessons 2026-08-04 "assert the outcome" and
// the demoRequirementStarters hardcoded-`expected` bug):
//   1. The requirement comes from the SHIPPED MANIFEST ON DISK, never a retyped literal.
//      A test that types its own bare manifest proves nothing about what actually ships.
//   2. The deps come from the PRODUCTION assembly `connectedFetchDepsFor`, never a
//      hand-rolled deps object. A bespoke deps object is a second network path with its
//      own configuration — exactly what would hide a wiring defect.
//
// C1 — the credential is a test-local fake value and every assertion about it is about
// where it did or did NOT travel. The final assertions prove it never reaches the app.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionRequirement } from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey, type UserDb } from '@snugprotocol/db';
import { createConnectedFetch } from '@snugprotocol/auth';

import { persistConnectionRequirement } from '../agent/connectionPipeline.js';
import { connectedFetchDepsFor, invalidateNetGrants } from '../state/net.js';
import { installTestUserDb } from './userdbTestHelper.js';

/**
 * The shipped manifest, read off disk. See anti-vacuity rule 1 — `demoRequirementStarters`
 * uses the same idiom for the same reason.
 */
function readShippedManifest(folder: string): ConnectionRequirement {
  const file = path.resolve(process.cwd(), '../../examples', folder, 'connection.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ConnectionRequirement;
}

/**
 * The shipped query-credential starter, with the forecast URL the OpenWeather manifest's
 * own docsUrl pins (`/data/2.5/forecast`, the 5-day endpoint) and the query key its
 * provider reads. The URL is pinned to the manifest's declared host + documented
 * endpoint rather than read out of app source — RE-VERIFIED 2026-08-15 against the
 * shipped `examples/weather/app.html`: the app calls `/geo/1.0/direct` and the lat/lon
 * forecast endpoints on the same declared host, so this fixture URL exercises the same
 * host+query-credential mechanism. (This suite never reads app.html; it drives the
 * persisted row and the executor.)
 *
 * The app URL carries the app's OWN parameters and no credential — that is the C1 shape
 * the examples/ AL-09 AC3 lint enforces, and half of what this file asserts survives
 * injection.
 */
const STARTERS = [
  {
    folder: 'weather',
    slot: 'openweather',
    host: 'api.openweathermap.org',
    appUrl: 'https://api.openweathermap.org/data/2.5/forecast?q=London&units=metric',
    queryKey: 'appid',
    appParams: { q: 'London', units: 'metric' },
    credential: 'ow-test-1f4a29c7e3b05d68a1f2c3b4d5e6f708',
  },
] as const;

type FetchCall = { url: string; init: RequestInit };

const headerOf = (call: FetchCall, name: string): string | undefined => {
  const headers = (call.init.headers ?? {}) as Record<string, string>;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
};

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  vi.restoreAllMocks();
});

/**
 * The PRODUCTION path, start to finish: the shipped bare manifest goes through the real
 * pipeline persist (admission pass 1) into the db accessor (admission pass 2, the
 * production gate `userdbTestHelper` wires), the user's credential is stored where the
 * wizard stores it, the row is approved (freezing the ceiling), and the executor is built
 * from the exported production deps assembly over a stub fetch.
 *
 * Nothing here is a shortcut around a guard — every stage is the one the browser runs.
 */
async function installAndConnect(
  starter: (typeof STARTERS)[number],
  opts: { respond?: (url: string) => Response; appId?: string; credential?: string } = {},
): Promise<{ execute: ReturnType<typeof createConnectedFetch>['execute']; calls: FetchCall[]; appId: string }> {
  const appId = opts.appId ?? `app-${starter.folder}`;
  const credential = opts.credential ?? starter.credential;
  const declaration = readShippedManifest(starter.folder);

  // The manifest ships BARE — assert it, because the whole mechanism under test is that
  // substitution supplies the seat. If a future edit pinned a template INTO the manifest,
  // this test would still pass while proving something entirely different.
  expect(declaration.request, `${starter.folder}/connection.json must stay bare`).toBeUndefined();
  expect(declaration.fields, `${starter.folder}/connection.json must stay bare`).toBeUndefined();

  const outcome = await persistConnectionRequirement(db, { appId, requirement: declaration, channel: 'starter' });
  expect(outcome.ok, outcome.ok === false ? `persist refused: ${outcome.reason}` : '').toBe(true);

  db.setSecret(authConnectionCredentialSecretKey(appId, starter.slot, 'api_key'), credential);
  db.approveConnection(appId, starter.slot);
  invalidateNetGrants(appId);

  const calls: FetchCall[] = [];
  const respond =
    opts.respond ??
    (() => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const deps = connectedFetchDepsFor(db, async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url);
  });
  return { execute: createConnectedFetch(deps).execute, calls, appId };
}

for (const starter of STARTERS) {
  describe(`AC6 — ${starter.folder}: the substituted requirement reaches the wire as a QUERY credential`, () => {
    it('the installed row carries the registry-pinned query template (substitution ran)', async () => {
      const appId = `app-${starter.folder}`;
      const outcome = await persistConnectionRequirement(db, {
        appId,
        requirement: readShippedManifest(starter.folder),
        channel: 'starter',
      });
      expect(outcome.ok).toBe(true);

      // THE PERSISTED SHAPE — the row the executor will actually read. An assertion that
      // stopped at "admission ok" would be the tautology lesson 2026-08-12 warns about.
      const row = db.getConnection(appId, starter.slot);
      expect(row).toBeDefined();
      expect(row!.requirement.request?.queryTemplate, 'the registry must supply the query template').toEqual({
        [starter.queryKey]: '{{api_key}}',
      });
      expect(row!.requirement.request?.headerTemplate, 'a query credential must not also be a header').toBeUndefined();
      expect(row!.requirement.fields?.map((field) => field.key)).toEqual(['api_key']);
    });

    it('the credential arrives as a QUERY PARAM — not as X-Api-Key — and the app’s own params survive', async () => {
      // THE HEADLINE ASSERTION. Before P4 this failed in the most misleading way possible:
      // `X-Api-Key` present, `appid`/`x_cg_demo_api_key` absent, request 401 at the
      // provider, and nothing anywhere said why.
      const { execute, calls } = await installAndConnect(starter);
      const result = await execute(`app-${starter.folder}`, { url: starter.appUrl, method: 'GET' });
      expect(result).toMatchObject({ ok: true, status: 200 });
      expect(calls).toHaveLength(1);

      const outbound = new URL(calls[0]!.url);
      expect(outbound.searchParams.get(starter.queryKey), 'the credential must ride the query').toBe(
        starter.credential,
      );
      expect(headerOf(calls[0]!, 'x-api-key'), 'the api_key kind default must NOT also fire').toBeUndefined();
      expect(headerOf(calls[0]!, 'authorization'), 'nothing authorizes by header here').toBeUndefined();

      // The app asked a question; injection must not change the question.
      for (const [key, value] of Object.entries(starter.appParams)) {
        expect(outbound.searchParams.get(key), `the app’s own '${key}' must survive injection`).toBe(value);
      }
      expect(outbound.origin + outbound.pathname, 'the endpoint itself is untouched').toBe(
        new URL(starter.appUrl).origin + new URL(starter.appUrl).pathname,
      );
    });

    it('the APP-VISIBLE result never contains the credential (C1)', async () => {
      // The other half of AC6, and the one that matters most: the host may put the secret
      // on the wire, but nothing carrying it may come back across the iframe boundary.
      // Asserted over the WHOLE serialized result rather than named fields — a future seat
      // that echoed the outbound URL would slip past a field-by-field check.
      const { execute } = await installAndConnect(starter, {
        // A body and headers that ECHO the credentialed URL — the shape that would leak.
        respond: (url) =>
          new Response(JSON.stringify({ youCalled: url }), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: `W/"${url}"` },
          }),
      });
      const result = await execute(`app-${starter.folder}`, { url: starter.appUrl, method: 'GET' });

      expect(JSON.stringify(result), 'the credential must not cross the app boundary').not.toContain(
        starter.credential,
      );
      // And the URL the app is told about is the URL the app asked for.
      expect(JSON.stringify(result)).not.toContain(starter.queryKey + '=' + starter.credential);
    });

    it('a fetch that THROWS with the credentialed URL still returns a redacted message (C1)', async () => {
      // P0 security amendment 14's enumerated site: `NET_FETCH_FAILED` used to ship
      // `request failed: ${err.message}` unscrubbed, and fetch errors routinely embed the
      // full URL — query string included. That message reaches the app.
      const appId = `app-${starter.folder}`;
      const declaration = readShippedManifest(starter.folder);
      await persistConnectionRequirement(db, { appId, requirement: declaration, channel: 'starter' });
      db.setSecret(authConnectionCredentialSecretKey(appId, starter.slot, 'api_key'), starter.credential);
      db.approveConnection(appId, starter.slot);
      invalidateNetGrants(appId);

      const deps = connectedFetchDepsFor(db, async (url) => {
        throw new Error(`connect ECONNREFUSED while fetching ${url}`);
      });
      const result = await createConnectedFetch(deps).execute(appId, { url: starter.appUrl, method: 'GET' });

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result), 'a thrown credentialed URL must be redacted').not.toContain(starter.credential);
    });

    it('an off-ceiling host gets NO credential — the frozen ceiling still governs injection', async () => {
      // The negative that keeps the mechanism honest: query injection happens AFTER the
      // ceiling checks (ADR-0022 §3), so a host the user never approved must never see
      // the key. Without this, "inject into the query" could read as "inject everywhere".
      const { execute, calls } = await installAndConnect(starter);
      const result = await execute(`app-${starter.folder}`, {
        url: 'https://evil.example.com/collect?q=London',
        method: 'GET',
      });

      expect(result.ok, 'an off-ceiling host must be refused').toBe(false);
      expect(calls, 'nothing may reach the wire for an unapproved host').toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(starter.credential);
    });
  });
}

describe('AC6 — two installs do not cross-contaminate', () => {
  // REWORKED (TASK-20260815-starter-apps-rebuild). The original drove the TWO shipped
  // query starters (weather-planner/OpenWeather + crypto-portfolio/CoinGecko) and
  // asserted neither provider's query key nor credential crossed to the other's wire.
  // That two-query-starter premise is OBSOLETE: the re-curated shelf ships exactly ONE
  // query-credential starter (`weather`) — crypto-portfolio's successor `trade-copilot`
  // authenticates via the registry's pinned CDP JWT Authorization header and cannot sit
  // in a query table. The provider-level half of the old claim (each registry entry pins
  // EXACTLY its own query key; an authored template is refused; substitution deep-copies)
  // is covered in packages/auth/src/__tests__/registry-query-credentials.test.ts.
  //
  // What SURVIVES here — and was the catastrophic half — is the lookup keying: the
  // executor resolves the credential by (appId, slot), so one user's install must never
  // see another install's key. Asserted across two installs of the SAME shipped starter
  // with distinct credentials, through the same production path as everything above.
  it('each install gets ONLY its own credential on the wire', async () => {
    const first = await installAndConnect(STARTERS[0], { appId: 'app-weather-first' });
    const second = await installAndConnect(STARTERS[0], {
      appId: 'app-weather-second',
      credential: 'ow-test-second-7d3c91b5e2a04f68c1d2e3f4a5b60718',
    });

    await first.execute(first.appId, { url: STARTERS[0].appUrl, method: 'GET' });
    await second.execute(second.appId, { url: STARTERS[0].appUrl, method: 'GET' });

    const firstUrl = new URL(first.calls[0]!.url);
    expect(firstUrl.searchParams.get('appid')).toBe(STARTERS[0].credential);
    expect(first.calls[0]!.url, 'no foreign credential may ride along').not.toContain(
      'ow-test-second-7d3c91b5e2a04f68c1d2e3f4a5b60718',
    );

    const secondUrl = new URL(second.calls[0]!.url);
    expect(secondUrl.searchParams.get('appid')).toBe('ow-test-second-7d3c91b5e2a04f68c1d2e3f4a5b60718');
    expect(second.calls[0]!.url, 'no foreign credential may ride along').not.toContain(STARTERS[0].credential);
  });
});
