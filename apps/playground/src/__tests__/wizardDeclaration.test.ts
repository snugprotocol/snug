// wizardDeclaration.test.ts — TASK-20260807-connection-reachability, plan v2 §V2-1/V2-3.
//
// The wizard half of the install-act channel: a chat-less app's declaration reaches the
// wizard session as its OWN immutable field, and the net-error CTA becomes async without
// losing the property that made it correct.
//
// Two things are being pinned here, and they are pinned together because the second one
// is what a naive implementation of the first breaks:
//
//   T4  — `openWizardForNetError` carries the declaration onto the session, in a field
//         no later step can overwrite (V2-1: provenance is DERIVED, never stored).
//   T4b — the function still refuses honestly. It is now async, so its caller awaits a
//         Promise; a Promise is ALWAYS truthy, so `if (await open(...))` would dismiss
//         the CTA even on a refusal. The refusal must survive the async conversion.

import { NET_ERROR_CODES } from '@snugprotocol/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import {
  __resetWizardStateForTests,
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

function installDemo(html: string = BUNDLED_HTML): string {
  return db.installApp({ displayName: 'connection demo', html, installSource: DEMO_SOURCE }).appId;
}

describe('T4 — the CTA carries the install-act declaration onto the session', () => {
  it('a declaring app opens a session with `declaration` populated', async () => {
    const appId = installDemo();
    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened).toBe(true);
    const session = wizardStore.get();
    expect(session?.declaration?.providerName).toBe('Example API');
    expect(session?.declaration?.declaredApiHosts).toEqual([DECLARED_HOST]);
  });

  it('a NON-declaring app opens the same plain session it always did', async () => {
    const appId = db.installApp({ displayName: 'chess', html: '<html>c</html>', installSource: 'starter:chess' })
      .appId;
    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened).toBe(true);
    expect(wizardStore.get()?.declaration, 'no manifest ⇒ no declaration').toBeUndefined();
  });

  it('an app whose HTML no longer matches its starter opens WITHOUT a declaration', async () => {
    // The resolver reports the mismatch; the wizard must not paper over it by falling
    // back to the manifest anyway. The user gets today's plain wizard, plus (later) the
    // Settings surface explaining why.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo('<html>edited by someone else</html>');
    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened).toBe(true);
    expect(wizardStore.get()?.declaration).toBeUndefined();
  });

  it('the declaration does NOT set provenance — provenance stays derived (V2-1)', async () => {
    // `AUTH_PROVENANCES` is a persisted enum reached through the directive channel. A
    // declaration must never mint a new member or borrow an existing one, or the light
    // approve-as-is path becomes reachable by an app-supplied literal.
    const appId = installDemo();
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    const session = wizardStore.get();
    expect(session?.provenance, 'a declaration is not a provenance').toBeUndefined();
    expect(session?.proposal, 'the declaration lives in its OWN field, not `proposal`').toBeUndefined();
  });

  it('the session still records the error_cta source and the mapped mode', async () => {
    const appId = installDemo();
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    const session = wizardStore.get();
    expect(session?.source).toBe('error_cta');
    expect(session?.mode).toBe('connect');
  });
});

describe('T4b — the async conversion must not turn a refusal into a truthy Promise', () => {
  it('resolves FALSE for a code that never opens the wizard', async () => {
    const appId = installDemo();
    // NET_HOST_BLOCKED is post-approval (Gate 4) and deliberately has no CTA. If this
    // resolved true, the run view would dismiss the banner and leave the user with
    // nothing — the exact regression the call-site rework guards.
    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_HOST_BLOCKED);

    expect(opened).toBe(false);
    expect(wizardStore.get(), 'no session may be created').toBeNull();
  });

  it('resolves FALSE when a wizard is already open (the parked-session refusal)', async () => {
    const appId = installDemo();
    openWizard({ source: 'settings', appId, mode: 'connect' });

    const opened = await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(opened, 'a second open must refuse, and say so through the resolved value').toBe(false);
    expect(wizardStore.get()?.source, 'the first session survives untouched').toBe('settings');
  });

  it('a code with no CTA refuses WITHOUT reading the user DB', async () => {
    // Found by mutation M8: moving the mode check after the resolver left every other
    // assertion green. The ordering is a real property — the CTA fires on app-timed net
    // errors, and codes like NET_HOST_BLOCKED can arrive in a loop, so a refusal must be
    // a pure function of the code and never an app-triggered read of the user's library.
    const appId = installDemo();
    const spy = vi.spyOn(db, 'getApp');

    expect(await openWizardForNetError(appId, NET_ERROR_CODES.NET_HOST_BLOCKED)).toBe(false);
    expect(spy, 'a no-CTA code must short-circuit before any DB access').not.toHaveBeenCalled();
  });

  it('the refusal is a resolved false, not a rejection', async () => {
    // Belt and braces on the call-site contract: `.then(opened => ...)` must run. A
    // thrown/rejected refusal would skip the handler and leave the CTA in limbo.
    const appId = installDemo();
    await expect(openWizardForNetError(appId, NET_ERROR_CODES.NET_HOST_BLOCKED)).resolves.toBe(false);
  });

  it('a declaring app that REFUSES to open stores no declaration anywhere', async () => {
    const appId = installDemo();
    openWizard({ source: 'settings', appId, mode: 'connect' });
    await openWizardForNetError(appId, NET_ERROR_CODES.NET_NOT_APPROVED);

    expect(wizardStore.get()?.declaration, 'the parked session must not absorb it').toBeUndefined();
  });
});
