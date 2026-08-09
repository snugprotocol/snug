// wizardPostRevoke.test.ts — TASK-20260807-connection-reachability §V2-5.
//
// After the user REVOKES an app's connection, the app's own retry loop must not get the
// prefilled review handed back to it. The next CTA for that app opens the PLAIN wizard;
// the user can still reconnect deliberately from Settings.
//
// ⚠️ THIS IS UX FRICTION, NOT A SECURITY BOUNDARY, and the plan says so explicitly
// (fidelity check C2). Revoke leaves ZERO DB residue by design — `deleteAuthSpec` is a
// bare DELETE — so "has had a row in this session" can only live in page memory. It dies
// on reload, and an app that induces a refresh gets the prefilled sheet back. The real
// fix is the revoke TOMBSTONE, already queued to AL-10. What this buys is narrow and
// honest: the app's cadence becomes strictly less useful than the user's own click.
//
// The tests below therefore pin BOTH halves — that the friction works, and that it is
// only friction. A future reader must not mistake this for a boundary and stop building
// the tombstone.

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import {
  __resetWizardStateForTests,
  forceCloseWizard,
  noteAuthSpecRevoked,
  openWizard,
  openWizardForNetError,
  wizardStore,
} from '../state/wizard.js';
import {
  __setDeclarationManifestsForTests,
  __resetDeclarationManifestsForTests,
} from '../starter/starterDeclaration.js';
import { installTestUserDb } from './userdbTestHelper.js';

const DEMO_FOLDER = 'connection-demo';
const DEMO_SOURCE = `starter:${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';
const BUNDLED_HTML = '<!doctype html>\n<html><body><script>const app = 1;</script></body></html>\n';

const VALID_MANIFEST = JSON.stringify({
  kindHint: 'api_key',
  providerName: 'Example API',
  declaredApiHosts: [DECLARED_HOST],
});

let db: UserDb;

beforeEach(async () => {
  __resetWizardStateForTests();
  db = await installTestUserDb();
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
  });
});

afterEach(() => {
  __resetWizardStateForTests();
  __resetDeclarationManifestsForTests();
  vi.restoreAllMocks();
});

function installDemo(): string {
  return db.installApp({ displayName: 'connection demo', html: BUNDLED_HTML, installSource: DEMO_SOURCE }).appId;
}

describe('T7b — after a revoke, the app’s CTA opens the PLAIN wizard', () => {
  it('the first CTA is prefilled', async () => {
    // The baseline this test is a delta against — without it, the assertion below could
    // pass because the declaration never arrives at all.
    const appId = installDemo();
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(wizardStore.get()?.declaration).toBeDefined();
  });

  it('after a revoke, the SAME app’s CTA is not prefilled', async () => {
    const appId = installDemo();
    noteAuthSpecRevoked(appId);

    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(
      wizardStore.get()?.declaration,
      'the app’s own retry must not re-offer what the user just revoked',
    ).toBeUndefined();
  });

  it('the wizard still OPENS — the app is not locked out, just not prefilled', async () => {
    // Refusing to open would be a denial of service on the user's own app. The friction
    // is on the convenience, never on the access.
    const appId = installDemo();
    noteAuthSpecRevoked(appId);

    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened).toBe(true);
    expect(wizardStore.get()?.appId).toBe(appId);
  });

  it('a DIFFERENT app is unaffected', async () => {
    // The note is per-app. A blanket flag would punish every app for one revoke.
    //
    // NOTE ON THE FIXTURE: both apps must DECLARE, and `install_source` carries a UNIQUE
    // index (the racing-install backstop), so installing twice from the same source
    // returns the SAME row — a first draft did exactly that and compared an app against
    // itself, even after an explicit `appId` was supplied. Two declaring apps therefore
    // need two distinct SOURCES, i.e. a second bundled folder.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
      'second-demo': { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
    });
    const revoked = installDemo();
    const other = db.installApp({
      displayName: 'other',
      html: BUNDLED_HTML,
      installSource: 'starter:second-demo',
    }).appId;
    expect(other, 'the fixture must produce two DISTINCT apps').not.toBe(revoked);
    noteAuthSpecRevoked(revoked);

    await openWizardForNetError(other, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(wizardStore.get()?.declaration, 'one app’s revoke must not silence another').toBeDefined();
  });

  it('the USER’s own Settings click still gets the prefilled review', async () => {
    // The whole design: the user's deliberate act stays first-class, and only the app's
    // timing loop is degraded. Settings passes the declaration explicitly, so this path
    // is unaffected by the note.
    const appId = installDemo();
    noteAuthSpecRevoked(appId);

    openWizard({
      source: 'settings',
      appId,
      mode: 'connect',
      declaration: { providerName: 'Example API', kindHint: 'api_key', declaredApiHosts: [DECLARED_HOST] },
    });

    expect(wizardStore.get()?.declaration, 'the user’s own click is never rate-limited').toBeDefined();
  });
});

describe('the honest limits of V2-5 — pinned so nobody mistakes it for a boundary', () => {
  it('is page-lifetime memory only: a reset restores the prefill', async () => {
    // `__resetWizardStateForTests` stands in for a page reload, which is exactly the
    // documented hole (fidelity check C2): revoke leaves no DB residue, so nothing can
    // survive a refresh. An app that induces one gets the prefilled sheet back.
    //
    // This test EXISTS TO FAIL if someone later claims V2-5 is a security control — the
    // claim and this assertion cannot both be true. The real fix is AL-10's tombstone.
    const appId = installDemo();
    noteAuthSpecRevoked(appId);
    __resetWizardStateForTests();

    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(
      wizardStore.get()?.declaration,
      'V2-5 is friction, not a boundary — it does NOT survive a reload',
    ).toBeDefined();
  });

  it('leaves no trace in the user DB — the tombstone is still AL-10’s job', async () => {
    const appId = installDemo();
    noteAuthSpecRevoked(appId);

    expect(db.listAuthSpecs(), 'nothing is persisted by the note').toHaveLength(0);
  });
});

describe('the note is recorded where the revoke actually happens', () => {
  it('re-opening after a revoke-then-close cycle stays unprefilled', async () => {
    // The realistic sequence: connect, revoke, the app keeps retrying. Each retry must
    // keep getting the plain wizard for as long as the page lives.
    const appId = installDemo();
    noteAuthSpecRevoked(appId);

    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);
    forceCloseWizard();
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(wizardStore.get()?.declaration).toBeUndefined();
  });
});
