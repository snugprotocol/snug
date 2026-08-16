// starterInstallAct.test.ts — TASK-20260810-p4-starters (RED).
//
// P4-AC3, P4-AC4 and the behavioural half of P4-AC9.
//
// THE CHANGE THIS PHASE MAKES. Today the install-act declaration is resolved ON DEMAND
// and NEVER PERSISTED (`starterDeclaration.ts` reads the bundled manifest every time and
// withdraws it on any edit). R4 replaces that with a COPY: install writes the manifest
// into `snug_connections` as `declared` rows with provenance `starter`, and from then on
// the requirement is the USER'S OWN ROW. That is what makes the zero-key grandma path
// work — running an installed starter needs no LLM, no re-resolution and no glob, because
// the row is already there.
//
// WHAT THE COPY MUST NEVER CARRY, and why it is the first assertion in this file: a
// manifest ships in a public repo. It declares field DEFINITIONS — "you will need an API
// key and a secret" — and never values. If install ever wrote a credential, C1's token
// boundary would be breached by a `git clone`.
//
// THE LOCK (AC4) is the half that protects a user who has already said yes. Reinstalling
// a starter is a routine act (the hub's install_source dedup makes it a click), and a
// reinstall that refreshed an APPROVED row would swap the requirement out from under a
// grant the user reviewed field-by-field — silently re-pointing a live credential. So
// reinstall refreshes a still-`declared` row and REFUSES an approved one. The db's write
// rules already encode this (`putDeclaredConnection` throws on an approved row); these
// tests pin that the install act HONORS them rather than catching and ignoring.
//
// P4-AC9's behavioural half. `starterDeclaration.ts` FAILS SOFT — a bad parse is a
// `console.warn`, not a throw — so `grep`ing for `connectionRequirementSchema` would go
// green over a module that still silently accepts v3 shapes. The rewire is therefore
// asserted by BEHAVIOR: a v3-shaped manifest must now be REFUSED (it was the only
// accepted shape before), and a v4 requirement must now be ACCEPTED (it was refused
// before, since `llmProposalSchema` omits `fields`/`registration` and is strict).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import {
  installStarterConnections,
  resolveDeclaredIntent,
  starterDeclarationFor,
  __setDeclarationManifestsForTests,
  __resetDeclarationManifestsForTests,
} from '../starter/starterDeclaration.js';
import { installTestUserDb } from './userdbTestHelper.js';

// RE-POINTED (TASK-20260815-starter-apps-rebuild): `connection-demo` was removed in the
// shelf re-curation; `weather` is the plain-api_key declaring folder that stands in.
// Every suite here injects fixtures, so the folder is only the key the injected map and
// `install_source` agree on — the manifest values remain deliberate fixture values.
const DEMO_FOLDER = 'weather';
const DEMO_SOURCE = `starter:${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';
const SLOT = 'example-api';

const BUNDLED_HTML = '<!doctype html>\n<html>\n  <body>\n    <script>const app = 1;</script>\n  </body>\n</html>\n';

/**
 * The v4 manifest — a full `connectionRequirement`, which is the whole point of the
 * rewrite. It carries `fields` and `registration`: the two seats `llmProposalSchema`
 * structurally OMITS, so this shape is a strict rejection under the old contract and
 * accepted under the new one. That asymmetry is what makes the rewire assertable.
 */
const V4_MANIFEST = JSON.stringify({
  slot: SLOT,
  provider: { name: 'Example API', docsUrl: 'https://docs.example.com/api' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API key', type: 'secret', description: 'From your Example API dashboard.' },
  ],
  registration: {
    consoleUrl: 'https://docs.example.com/console',
    instructions: ['Open the Example API console.', 'Create a key and paste it below.'],
  },
  request: { headerTemplate: { 'X-Api-Key': '{{api_key}}' } },
  declaredApiHosts: [DECLARED_HOST],
});

/** The shape every manifest carried BEFORE this phase. Must now be refused. */
const V3_MANIFEST = JSON.stringify({
  kindHint: 'api_key',
  providerName: 'Example API',
  docsUrl: 'https://docs.example.com/api',
  declaredApiHosts: [DECLARED_HOST],
});

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: V4_MANIFEST, html: BUNDLED_HTML },
  });
});

afterEach(() => {
  __resetDeclarationManifestsForTests();
  vi.restoreAllMocks();
});

const installDemo = (html: string = BUNDLED_HTML): string =>
  db.installApp({ displayName: 'connection demo', html, installSource: DEMO_SOURCE }).appId;

describe('P4-AC3 — install COPIES the manifest into snug_connections as declared rows', () => {
  it('writes one declared row per manifest slot', async () => {
    const appId = installDemo();
    await installStarterConnections(db, appId);

    const rows = db.listConnections(appId);
    expect(rows, 'the install act must land the requirement as a row').toHaveLength(1);
    expect(rows[0]?.slot).toBe(SLOT);
    expect(rows[0]?.status).toBe('declared');
  });

  it('stamps provenance `starter` — never `registry`, never `user`', async () => {
    // Provenance drives the REVIEW POSTURE. `registry` may keep the light prefilled
    // path; a starter manifest is first-party but not registry-pinned, so it must force
    // the strong field-by-field review. Mislabelling it `registry` would shorten a
    // review the plan explicitly says install only PREFILLS, never shortens.
    const appId = installDemo();
    await installStarterConnections(db, appId);

    expect(db.listConnections(appId)[0]?.provenance).toBe('starter');
  });

  it('copies the requirement VERBATIM — fields and registration survive the copy', async () => {
    // The founding defect, at the install seam: a copy that dropped `fields` would put
    // the user back in front of one generic input.
    const appId = installDemo();
    await installStarterConnections(db, appId);

    const requirement = db.listConnections(appId)[0]?.requirement;
    expect(requirement?.fields?.map((field) => field.key)).toEqual(['api_key']);
    expect(requirement?.registration?.instructions).toHaveLength(2);
    expect(requirement?.declaredApiHosts).toEqual([DECLARED_HOST]);
  });

  it('NEVER writes a credential value — the row is a requirement, not a grant', async () => {
    // The C1 assertion, stated over the row's ENTIRE serialized bytes rather than a
    // known key list: a future seat that carried a value would slip past a key-by-key
    // check, and this is the boundary where a leak becomes durable (it is persisted, it
    // is exported, and it crosses the sync boundary).
    const appId = installDemo();
    await installStarterConnections(db, appId);

    const row = db.listConnections(appId)[0];
    expect(row?.status, 'install NEVER approves — no grant, so nothing to hold a value').toBe('declared');
    expect(row?.approvedAt).toBeUndefined();

    const serialized = JSON.stringify(row);
    for (const field of row?.requirement.fields ?? []) {
      expect(field, `field ${field.key} must be a definition`).not.toHaveProperty('value');
    }
    expect(serialized, 'no credential value may appear anywhere in the copied row').not.toMatch(
      /"value"\s*:|secretValue|credentialValue/i,
    );
  });

  it('writes no secret into the credential store either', async () => {
    // The row is one of two places a value could land. `snug_secrets` under
    // `auth:<appId>:<slot>:<fieldKey>` is the other, and it is the one that actually
    // holds credentials — so the install act must leave it untouched.
    const appId = installDemo();
    await installStarterConnections(db, appId);

    // Keyed exactly as ADR-0014 specifies (`auth:<appId>:<slot>:<fieldKey>`), one probe
    // per field the manifest declares — so a copy that "helpfully" seeded a placeholder
    // or an empty string is caught, not just one that stored a real value.
    for (const field of JSON.parse(V4_MANIFEST).fields as Array<{ key: string }>) {
      expect(
        db.getSecret(`auth:${appId}:${SLOT}:${field.key}`),
        'install collects no credential — the wizard does, later, with consent',
      ).toBeUndefined();
    }
  });

  it('a NON-declaring starter writes no rows at all', async () => {
    // The control. Most starters declare nothing, and install must stay silent for them
    // rather than minting an empty row that renders as a connect affordance.
    __setDeclarationManifestsForTests({});
    const appId = installDemo();
    await installStarterConnections(db, appId);

    expect(db.listConnections(appId)).toHaveLength(0);
  });

  it('an app whose HTML no longer matches its starter copies NOTHING', async () => {
    // The two-fact vouch still gates the copy. Persisting the requirement makes the
    // vouch MORE important, not less: an on-demand resolution that was wrong got
    // withdrawn on the next read, but a wrong ROW persists until someone revokes it.
    const appId = installDemo('<!doctype html><html><body>attacker</body></html>');
    await installStarterConnections(db, appId);

    expect(db.listConnections(appId), 'a failed vouch must never mint a row').toHaveLength(0);
  });
});

describe('P4-AC4 — install LOCKS until edit; reinstall refreshes only a declared row', () => {
  it('reinstall REFRESHES a still-declared row when the manifest changed', async () => {
    const appId = installDemo();
    await installStarterConnections(db, appId);
    expect(db.getConnection(appId, SLOT)?.requirement.provider.name).toBe('Example API');

    // The starter ships an updated manifest (a new field, say) and the user reinstalls.
    // Nothing was approved, so there is no grant to protect — refresh is correct.
    const updated = JSON.parse(V4_MANIFEST) as Record<string, unknown>;
    (updated['provider'] as { name: string }).name = 'Example API v2';
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: JSON.stringify(updated), html: BUNDLED_HTML },
    });

    await installStarterConnections(db, appId);
    expect(db.getConnection(appId, SLOT)?.requirement.provider.name).toBe('Example API v2');
    expect(db.listConnections(appId), 'refresh replaces the row — it never forks a second one').toHaveLength(1);
  });

  it('reinstall NEVER silently replaces an APPROVED grant', async () => {
    // The core of AC4. The user reviewed this requirement field-by-field and approved a
    // frozen host ceiling. A reinstall that overwrote it would re-point a live
    // credential at whatever the new manifest declares, with no review and no notice.
    const appId = installDemo();
    await installStarterConnections(db, appId);
    db.approveConnection(appId, SLOT);
    const approved = db.getConnection(appId, SLOT);
    expect(approved?.status).toBe('approved');

    const updated = JSON.parse(V4_MANIFEST) as Record<string, unknown>;
    updated['declaredApiHosts'] = ['api.example.com', 'evil.example'];
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: JSON.stringify(updated), html: BUNDLED_HTML },
    });

    await installStarterConnections(db, appId);

    const after = db.getConnection(appId, SLOT);
    expect(after?.status, 'the grant survives the reinstall').toBe('approved');
    expect(after?.requirement.declaredApiHosts, 'the approved requirement is untouched').toEqual([DECLARED_HOST]);
    expect(after?.allowedHosts, 'the FROZEN ceiling must never widen without a re-approval').not.toContain(
      'evil.example',
    );
    expect(after?.approvedAt).toBe(approved?.approvedAt);
  });

  it('a reinstall against an approved row does not throw — it declines', async () => {
    // `putDeclaredConnection` THROWS on an approved row. That is the right db rule, and
    // it means the install act must not call it blindly: an uncaught throw here would
    // break the install of an app the user already owns. Declining is the behavior.
    const appId = installDemo();
    await installStarterConnections(db, appId);
    db.approveConnection(appId, SLOT);

    await expect(installStarterConnections(db, appId)).resolves.not.toThrow();
  });

  it('a REVOKED row is never resurrected by a reinstall', async () => {
    // Revocation is a user decision and the row survives as a tombstone precisely so it
    // cannot be quietly undone. A reinstall that flipped it back to `declared` would
    // turn "no" into "ask me again" without the user acting.
    const appId = installDemo();
    await installStarterConnections(db, appId);
    db.approveConnection(appId, SLOT);
    db.revokeConnection(appId, SLOT);

    await installStarterConnections(db, appId);

    expect(db.getConnection(appId, SLOT)?.status, 'a tombstone stays a tombstone').toBe('revoked');
  });
});

describe('P4-AC9 — the rewire to connectionRequirementSchema, asserted BEHAVIOURALLY', () => {
  it('ACCEPTS a v4 requirement carrying fields and registration', async () => {
    // Under `llmProposalSchema` this is a strict rejection: that schema OMITS `fields`
    // and `registration` by construction (the AL-04 answer to credential misdirection).
    // So this passing is proof the module now parses with the v4 contract — not merely
    // that an import line was edited.
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    expect(result, 'a v4 manifest must resolve under the new contract').not.toBeNull();
    expect(result?.declaration.fields?.[0]?.key).toBe('api_key');
    expect(result?.declaration.registration?.consoleUrl).toBe('https://docs.example.com/console');
    expect(result?.declaration.slot).toBe(SLOT);
  });

  it('REFUSES the v3 proposal shape it used to be the only acceptor of', async () => {
    // The discriminating direction. Fails soft: one console warning, `null`, no throw.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: V3_MANIFEST, html: BUNDLED_HTML },
    });
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId), 'the v3 shape is no longer a valid manifest').toBeNull();
    expect(warn, 'a rejected manifest warns rather than throwing (fail soft)').toHaveBeenCalledTimes(1);
  });

  it('a v3-shaped manifest copies NO row — a refused parse must not reach storage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: V3_MANIFEST, html: BUNDLED_HTML },
    });
    const appId = installDemo();

    await installStarterConnections(db, appId);
    expect(db.listConnections(appId)).toHaveLength(0);
  });

  it('resolveDeclaredIntent still reports a mismatch rather than swallowing it', async () => {
    // The reporting contract survives the rewire. A silent withdrawal drops the user
    // back into an empty wizard with no diagnostic — the exact failure the original
    // module was written to avoid.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo('<!doctype html><html><body>edited</body></html>');

    expect((await resolveDeclaredIntent(db, appId)).mismatch).toBe('html_mismatch');
  });

  it('the manifest passes through ADMISSION on the `starter` channel', async () => {
    // A manifest is first-party but it is still a CHANNEL, and admission is where a
    // channel's claims are judged. The `starter` channel may not author a `userLayer`
    // (registry-synthesized only) — so a manifest that declares one must be refused
    // rather than copied, or the install act becomes the hole every other channel is
    // gated against.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poisoned = JSON.parse(V4_MANIFEST) as Record<string, unknown>;
    poisoned['userLayer'] = {
      kind: 'oauth2_auth_code',
      endpoints: {
        authorizeUrl: 'https://evil.example/authorize',
        tokenUrl: 'https://evil.example/token',
      },
      declaredApiHosts: ['evil.example'],
    };
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: JSON.stringify(poisoned), html: BUNDLED_HTML },
    });
    const appId = installDemo();

    await installStarterConnections(db, appId);
    expect(db.listConnections(appId), 'a starter may not author a userLayer').toHaveLength(0);
  });
});
