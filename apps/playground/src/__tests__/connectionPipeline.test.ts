// TASK-20260810-p2-pipeline (Dynamic Auth v2, P2) AC1/AC2/AC4/AC5/AC6 — the BUILD/EDIT
// pipeline: what a build reply's `connection_requirement` directive does to storage, and
// when.
//
// WHY THIS FILE IS IN THE PLAYGROUND AND NOT IN packages/db (the 2026-08-05 lesson).
// P0 already proved the ACCESSORS behave (packages/db `connections.test.ts`): a declared
// row replaces, an approved row refuses, staging writes one column. None of that answers
// the motivating defect, which is a question about TIMING and CALLER: does a row exist
// BEFORE the app first runs, and does the save seam call the right accessor? That decision
// is made where the app version is saved — `agent/artifactSink.ts` — so it is tested here,
// against the real user DB, the real schema, the real admission gate.
//
// Written RED-FIRST at Gate 3 against a seam that does not exist yet
// (`agent/connectionPipeline.ts` + the `write()` options bag). The failures below are
// module-resolution and signature failures, which is the correct RED for a phase whose
// whole content is a new seam.
//
// CUTOVER (fold B1): nothing here touches `llmProposalSchema` or `snug_auth_specs`. The v3
// surface keeps shipping green; its deletion is P3/P4's named exit item.

import { describe, expect, it } from 'vitest';
import {
  CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
  CONNECTION_STATUS,
  PROTOCOL_VERSION,
  canonicalRequirementHash,
  connectionRequirementSchema,
} from '@snugprotocol/protocol';
import { authConnectionCredentialSecretKey } from '@snugprotocol/db';

import type { UserDb } from '@snugprotocol/db';

import { createAppTargetSink, type ArtifactWriteResult } from '../agent/artifactSink.js';
import {
  finalizeConnectionDeclaration,
  persistConnectionRequirement,
  validateConnectedBuild,
  type ConnectionDeclarationOutcome,
  type ConnectionPersistOutcome,
} from '../agent/connectionPipeline.js';
import { installTestUserDb } from './userdbTestHelper.js';

// --------------------------------------------------------------------- fixtures

const SLOT = 'coinbase';

/**
 * The parent plan's motivating requirement, in the shape P0 verified expressible. The
 * signature is the Coinbase-Exchange one pinned in the task brief — five message parts,
 * `hmac_sha256_b64`, EXCHANGE host (`api.exchange.coinbase.com`, not the retail host: a
 * wrong host freezes a ceiling that refuses every real request and presents as an auth bug).
 */
const coinbaseRequirement = {
  slot: SLOT,
  provider: { name: 'Coinbase Exchange', docsUrl: 'https://docs.cdp.coinbase.com/exchange' },
  kind: 'api_key',
  fields: [
    { key: 'api_key', label: 'API Key', type: 'text', required: true },
    { key: 'api_secret', label: 'API Secret', type: 'secret', required: true },
    { key: 'passphrase', label: 'Passphrase', type: 'secret', required: true },
  ],
  registration: {
    consoleUrl: 'https://exchange.coinbase.com/profile/api',
    instructions: [
      'Open your Coinbase Exchange profile',
      'Create an API key',
      'Copy the key, secret and passphrase',
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
  declaredApiHosts: ['api.exchange.coinbase.com'],
} as const;

const requirementWith = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...coinbaseRequirement,
  ...patch,
});

/** A build reply closing with the directive, exactly as the KB teaches it. */
function replyWithDirective(requirement: unknown): string {
  return [
    'your coinbase portfolio tracker is ready — it shows a "connect Coinbase" state until you connect.',
    '```json',
    JSON.stringify({
      v: PROTOCOL_VERSION,
      kind: CONNECTION_REQUIREMENT_DIRECTIVE_KIND,
      requirement,
    }),
    '```',
    'review and approve the connection to see live balances.',
  ].join('\n\n');
}

/** App HTML that CALLS the connected surface — the trigger for the AC2 build gate. */
const CONNECTED_HTML = [
  '<!DOCTYPE html><html><head><title>Coinbase Tracker</title></head><body>',
  '<script type="text/babel">',
  '  const { fetch: connectedFetch } = useConnectedFetch();',
  '  connectedFetch("https://api.exchange.coinbase.com/accounts");',
  '</script></body></html>',
].join('\n');

/** App HTML that makes NO external calls — the never-case for the AC2 gate. */
const OFFLINE_HTML = [
  '<!DOCTYPE html><html><head><title>Todo</title></head><body>',
  '<script type="text/babel">const [items, setItems] = usePersistedState("items", []);</script>',
  '</body></html>',
].join('\n');

/**
 * ONE BUILD TURN, in the order production actually runs it (P2 fold).
 *
 * The first cut of these tests called `sink.write(html, title, { reply })` — an options
 * bag no production caller ever passed, which is exactly how the unwired seam reported
 * green. The real sequence is: `artifact_write` saves the version MID-TURN (no reply text
 * exists yet), then the POST-TURN finalizer scans the completed reply and declares. This
 * helper replays that sequence, so every AC below is asserted against the real ordering.
 */
async function runBuildTurn(
  db: UserDb,
  sink: ReturnType<typeof createAppTargetSink>,
  html: string,
  title: string,
  reply: string,
): Promise<{ written: ArtifactWriteResult; outcome: ConnectionDeclarationOutcome | undefined }> {
  const written = await sink.write(html, title);
  const outcome = await finalizeConnectionDeclaration(db, {
    appId: written.id,
    html,
    reply,
    channel: 'inference',
  });
  return { written, outcome };
}

// ------------------------------------------ AC1: directive → declared row AT SAVE TIME

describe('P2-AC1 — a build reply\'s directive is validated and PERSISTED as a `declared` row at version save (R1)', () => {
  it('lands the row BEFORE first run: the save returns, and the row is already there', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });

    // Nothing exists before the save — the assertion below is about the SAVE, not setup.
    expect(db.listConnections()).toEqual([]);

    const { written } = await runBuildTurn(
      db,
      sink,
      CONNECTED_HTML,
      'Coinbase Tracker',
      replyWithDirective(coinbaseRequirement),
    );

    // The row exists the moment the BUILD TURN resolves. No run, no wizard open, no CTA
    // click — that ordering IS the motivating defect ("declared before first run", §5 R1).
    const row = db.getConnection(written.id, SLOT);
    expect(row, 'no `declared` row after the version save').toBeDefined();
    expect(row!.status).toBe(CONNECTION_STATUS.declared);
    expect(row!.provenance).toBe('inference');
    // A declared row is a REQUIREMENT, never a GRANT.
    expect(row!.approvedAt).toBeUndefined();
    await db.close();
  });

  it('persists the app version and the requirement TOGETHER — a v1 app with a directive is never left row-less', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const { written } = await runBuildTurn(
      db,
      sink,
      CONNECTED_HTML,
      'Coinbase Tracker',
      replyWithDirective(coinbaseRequirement),
    );
    expect(written.version).toBe(1);
    expect(db.getAppHtml(written.id)).toBe(CONNECTED_HTML);
    expect(db.listConnections(written.id)).toHaveLength(1);
    await db.close();
  });

  it('NEGATIVE — a directive that fails ADMISSION persists nothing (registry borrow + credential-prompt seats)', async () => {
    const db = await installTestUserDb();
    // Names a registry provider AND occupies `fields`/`request` — the seats admission
    // cannot substitute, so `admitConnectionRequirement` refuses outright (P0 AC9).
    const borrowed = requirementWith({
      slot: 'spotify',
      provider: { name: 'Spotify' },
      declaredApiHosts: ['api.spotify.com'],
    });

    const outcome: ConnectionPersistOutcome = await persistConnectionRequirement(db, {
      appId: 'app-borrow',
      requirement: borrowed,
      channel: 'inference',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('admission_refused');
    expect(db.listConnections('app-borrow')).toEqual([]);
    await db.close();
  });

  it('NEGATIVE — a directive whose header template fails the LINT persists nothing', async () => {
    const db = await installTestUserDb();
    // `md5` is not in the pinned helper enum, and the engine's unknown-token→literal
    // fallback must never be reachable from an unlinted template (fold S-M2).
    const unlinted = requirementWith({
      request: { headerTemplate: { 'CB-ACCESS-SIGN': '{{md5(api_secret)}}' } },
    });

    const outcome = await persistConnectionRequirement(db, {
      appId: 'app-unlinted',
      requirement: unlinted,
      channel: 'inference',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('template_lint_failed');
    expect(db.listConnections('app-unlinted')).toEqual([]);
    await db.close();
  });

  it('NEGATIVE — a structurally invalid requirement persists nothing (fail closed at ingest)', async () => {
    const db = await installTestUserDb();
    const outcome = await persistConnectionRequirement(db, {
      appId: 'app-malformed',
      requirement: { slot: SLOT, kind: 'api_key' }, // no provider, no declaredApiHosts
      channel: 'inference',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('schema_rejected');
    expect(db.listConnections('app-malformed')).toEqual([]);
    await db.close();
  });
});

// -------------------------------------------------------- AC2: the build-validation gate

describe('P2-AC2 — build validation FAILS CLOSED at BUILD when connected HTML declares no requirement', () => {
  it('HTML calling useConnectedFetch with NO requirement fails validation', () => {
    const verdict = validateConnectedBuild({ html: CONNECTED_HTML, requirement: undefined });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('connected_html_without_requirement');
  });

  it('the same HTML WITH a requirement passes', () => {
    const verdict = validateConnectedBuild({ html: CONNECTED_HTML, requirement: coinbaseRequirement });
    expect(verdict.ok).toBe(true);
  });

  it('never-case: HTML with no connected surface and no requirement passes (no false gate)', () => {
    const verdict = validateConnectedBuild({ html: OFFLINE_HTML, requirement: undefined });
    expect(verdict.ok).toBe(true);
  });

  /**
   * FOLD: this test previously asserted the gate threw at `sink.write()` and unwound the
   * whole save. That contract was impossible AND wrong, on both halves:
   *
   *  - IMPOSSIBLE, because `write()` is a mid-turn tool call that cannot see the reply the
   *    directive lives in, so the gate only ever saw `undefined` and refused EVERY
   *    connected build. (Verified by execution — it threw on the real production shape.)
   *  - WRONG, because discarding the app is the more damaging failure. The HTML is the
   *    user's work; a model that forgot to declare a connection is a recoverable problem,
   *    and throwing it away loses the build entirely — in webllm mode, silently.
   *
   * The guarantee the gate actually owed was never "no version": it was "never SILENTLY
   * connected-but-unconnectable". So the app saves, and the condition is REPORTED. That is
   * what is asserted here, at the seam that can see the reply.
   */
  it('a connected app with no directive still saves, and the unconnectable condition is REPORTED', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });

    const { written, outcome } = await runBuildTurn(
      db,
      sink,
      CONNECTED_HTML,
      'Coinbase Tracker',
      'here is your tracker — enjoy!',
    );

    // Reported, not swallowed: the caller has something to put in front of the user.
    expect(outcome).toBeDefined();
    expect(outcome!.ok).toBe(false);
    expect(outcome!.ok === false && outcome!.reason).toBe('connected_html_without_requirement');
    expect(outcome!.ok === false && outcome!.message).toMatch(/connect card/);

    // The user's work survives; no connection row was invented to paper over the gap.
    expect(db.getAppHtml(written.id)).toBe(CONNECTED_HTML);
    expect(db.listConnections()).toEqual([]);
    await db.close();
  });
});

// ------------------------------------------------------- AC4: the UI-only edit no-op

describe('P2-AC4 — an identical re-emitted requirement is a deterministic NO-OP (R3)', () => {
  it('re-emitting the SAME requirement on a later version writes nothing: no version bump, no updated_at change', async () => {
    const db = await installTestUserDb();
    const sink = createAppTargetSink({ getDb: () => Promise.resolve(db) });
    const { written } = await runBuildTurn(
      db,
      sink,
      CONNECTED_HTML,
      'Coinbase Tracker',
      replyWithDirective(coinbaseRequirement),
    );
    const before = db.getConnection(written.id, SLOT)!;

    // A UI-only edit: different HTML, byte-identical requirement re-emitted with its keys
    // in a DIFFERENT order — which is what an LLM actually does turn to turn. Canonical
    // key-sorting is what makes this a no-op rather than a churn write.
    const reordered = {
      declaredApiHosts: coinbaseRequirement.declaredApiHosts,
      request: coinbaseRequirement.request,
      registration: coinbaseRequirement.registration,
      fields: coinbaseRequirement.fields,
      kind: coinbaseRequirement.kind,
      provider: coinbaseRequirement.provider,
      slot: coinbaseRequirement.slot,
    };
    const outcome = await persistConnectionRequirement(db, {
      appId: written.id,
      requirement: reordered,
      channel: 'inference',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.action).toBe('noop');

    const after = db.getConnection(written.id, SLOT)!;
    expect(after.requirementVersion).toBe(before.requirementVersion);
    expect(after.requirement).toEqual(before.requirement);
    // NOTE (fold): `updated_at` is deliberately NOT asserted. `now()` is millisecond
    // resolution and `putDeclaredConnection` rewrites the column unconditionally on the
    // replace path, so two writes inside one millisecond produce equal timestamps — the
    // assertion passed even with the no-op skip mutated away, making it read as evidence
    // it never was. The guarantee actually lives in `action === 'noop'` and the unchanged
    // `requirementVersion` above, both of which DO go red under that mutation.
    await db.close();
  });

  it('the no-op is decided by canonicalRequirementHash — the SAME function the version bump uses', async () => {
    const db = await installTestUserDb();
    // Pins the canonicalization contract the no-op rests on: stable KEY order, array order
    // PRESERVED (a reordered walkthrough is a different walkthrough), whitespace-free JSON.
    const parsed = connectionRequirementSchema.parse(coinbaseRequirement);
    const reorderedKeys = connectionRequirementSchema.parse({
      declaredApiHosts: coinbaseRequirement.declaredApiHosts,
      kind: coinbaseRequirement.kind,
      slot: coinbaseRequirement.slot,
      provider: coinbaseRequirement.provider,
      fields: coinbaseRequirement.fields,
      registration: coinbaseRequirement.registration,
      request: coinbaseRequirement.request,
    });
    expect(canonicalRequirementHash(reorderedKeys)).toBe(canonicalRequirementHash(parsed));
    expect(canonicalRequirementHash(parsed)).not.toMatch(/\n|\s{2,}/);

    // ...and a reordered instruction list is NOT the same requirement.
    const reorderedSteps = connectionRequirementSchema.parse(
      requirementWith({
        registration: {
          ...coinbaseRequirement.registration,
          instructions: [...coinbaseRequirement.registration.instructions].reverse(),
        },
      }),
    );
    expect(canonicalRequirementHash(reorderedSteps)).not.toBe(canonicalRequirementHash(parsed));

    // The pipeline must agree with that judgement, not re-implement it.
    const written = await persistConnectionRequirement(db, {
      appId: 'app-hash',
      requirement: coinbaseRequirement,
      channel: 'inference',
    });
    expect(written.ok === true && written.action).toBe('created');
    const second = await persistConnectionRequirement(db, {
      appId: 'app-hash',
      requirement: reorderedSteps,
      channel: 'inference',
    });
    expect(second.ok === true && second.action).toBe('replaced');
    await db.close();
  });

  it('a CHANGED requirement on a `declared` row replaces it and bumps the version (the legitimate R3 path)', async () => {
    const db = await installTestUserDb();
    await persistConnectionRequirement(db, {
      appId: 'app-edit',
      requirement: coinbaseRequirement,
      channel: 'inference',
    });
    const before = db.getConnection('app-edit', SLOT)!;

    const outcome = await persistConnectionRequirement(db, {
      appId: 'app-edit',
      requirement: requirementWith({
        declaredApiHosts: ['api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com'],
      }),
      channel: 'inference',
    });

    expect(outcome.ok === true && outcome.action).toBe('replaced');
    const after = db.getConnection('app-edit', SLOT)!;
    expect(after.requirementVersion).toBeGreaterThan(before.requirementVersion);
    expect(after.status).toBe(CONNECTION_STATUS.declared);
    await db.close();
  });
});

// ------------------------------------------- AC5: an auth-touching edit on an APPROVED row

describe('P2-AC5 — a changed requirement on an APPROVED row STAGES, never replaces (fold B2)', () => {
  it('stages into pending: requirement, frozen hosts, status, approval stamp and credentials all untouched', async () => {
    const db = await installTestUserDb();
    const APP = 'app-approved';
    await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'inference',
    });
    const approved = db.approveConnection(APP, SLOT);
    const REAL_KEY = 'ck-live-9f3a7c21b4e05d68a1f2c3b4d5e6f708';
    db.setSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'), REAL_KEY);

    // The edit widens the host set — the exact silent-widening the pending column exists
    // to prevent.
    const widened = requirementWith({
      declaredApiHosts: ['api.exchange.coinbase.com', 'exfil.example.com'],
    });
    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: widened,
      channel: 'inference',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.action).toBe('staged');

    const row = db.getConnection(APP, SLOT)!;
    // The PENDING requirement is what the diff renders.
    expect(row.pendingRequirement).toEqual(connectionRequirementSchema.parse(widened));
    // ...and the grant is byte-for-byte what the user approved.
    expect(row.status).toBe(CONNECTION_STATUS.approved);
    expect(row.requirement).toEqual(approved.requirement);
    expect(row.allowedHosts).toEqual(approved.allowedHosts);
    expect(row.allowedHosts).not.toContain('exfil.example.com');
    expect(row.approvedAt).toBe(approved.approvedAt);
    expect(row.requirementVersion).toBe(approved.requirementVersion);
    expect(db.getSecret(authConnectionCredentialSecretKey(APP, SLOT, 'api_key'))).toBe(REAL_KEY);
    await db.close();
  });

  it('an IDENTICAL requirement on an approved row stages NOTHING — a UI-only edit never asks for re-approval', async () => {
    const db = await installTestUserDb();
    const APP = 'app-approved-noop';
    await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'inference',
    });
    db.approveConnection(APP, SLOT);

    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'inference',
    });

    expect(outcome.ok === true && outcome.action).toBe('noop');
    // No pending seat ⇒ the derived "needs re-approval" pill never lights up.
    expect(db.getConnection(APP, SLOT)!.pendingRequirement).toBeUndefined();
    await db.close();
  });
});

// ------------------------------------- AC6: user provenance is never overwritten by inference

describe("P2-AC6 — a `user`-provenance requirement is NEVER overwritten by inference (OProject's user_confirmed-wins rule, verbatim)", () => {
  it('inference against a hand-confirmed `declared` row is refused, and the row is unchanged', async () => {
    const db = await installTestUserDb();
    const APP = 'app-user-owned';
    // The user hand-confirmed this in the wizard: provenance `user`.
    await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'user',
    });
    const before = db.getConnection(APP, SLOT)!;
    expect(before.provenance).toBe('user');

    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: requirementWith({ declaredApiHosts: ['api.exchange.coinbase.com', 'other.example.com'] }),
      channel: 'inference',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.action).toBe('skipped_user_provenance');

    const after = db.getConnection(APP, SLOT)!;
    expect(after.provenance).toBe('user');
    expect(after.requirement).toEqual(before.requirement);
    expect(after.requirementVersion).toBe(before.requirementVersion);
    expect(after.updatedAt).toBe(before.updatedAt);
    await db.close();
  });

  it('the rule is PROVENANCE-keyed, not content-keyed: user_docs may still be overwritten by inference', async () => {
    const db = await installTestUserDb();
    const APP = 'app-userdocs';
    await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'user_docs',
    });
    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: requirementWith({ scopes: ['read'] }),
      channel: 'inference',
    });
    expect(outcome.ok === true && outcome.action).toBe('replaced');
    await db.close();
  });

  it('the USER channel may still overwrite the user\'s own row (the rule blocks inference, not the user)', async () => {
    const db = await installTestUserDb();
    const APP = 'app-user-rewrite';
    await persistConnectionRequirement(db, {
      appId: APP,
      requirement: coinbaseRequirement,
      channel: 'user',
    });
    const outcome = await persistConnectionRequirement(db, {
      appId: APP,
      requirement: requirementWith({ scopes: ['read'] }),
      channel: 'user',
    });
    expect(outcome.ok === true && outcome.action).toBe('replaced');
    await db.close();
  });
});
