// demoRequirementStarters.test.ts — TASK-20260810-p4-starters, P4-AC10 (RED).
//
// THE `?demoreq=` DEMO-BRAIN SEAM, EXTENDED TO THE STARTER JOURNEYS.
//
// P3 shipped this seam with five BUILD variants (coinbase/bearer/basic/oauth/undeclared):
// each scripts a chat that writes an app and emits a `connection_requirement` directive,
// which is what the P3 wizard e2e drives. P4's journeys are different in kind — the user
// INSTALLS a starter rather than building one, and the requirement arrives through the
// install act rather than through a directive — but the e2e still needs a zero-LLM,
// deterministic brain for the parts of the journey that DO involve chat (an app-attached
// conversation on an installed starter, the edit path that unlocks R3).
//
// WHY THE VARIANTS MUST MATCH THE SHIPPED MANIFESTS, and why this is a unit test rather
// than something the e2e discovers: a demo variant that emits a requirement the six
// shipped manifests do not contain would let the P4 e2e go green against a fictional
// provider while every real starter stayed broken. The seam's whole value is that it is
// the PRODUCTION path with a scripted model — so what it emits has to be the production
// artifact. Pinning that here, in fast unit tests, is what keeps the slow browser suite
// honest.
//
// EVERY VARIANT MUST SURVIVE THE FULL PRODUCTION PATH. The P3 file states this rule for
// its own variants and it applies unchanged: `connectionRequirementSchema`, then
// `admitConnectionRequirement` on the emitting channel, then the template lint. A variant
// that only passed a hand-written parser would prove nothing about the pipeline.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { connectionRequirementSchema } from '@snugprotocol/protocol';
import { admitConnectionRequirement, lintAuthHeaderTemplate } from '@snugprotocol/auth';

import {
  demoRequirementVariant,
  demoRequirementChatScript,
  DEMO_STARTER_REQUIREMENTS,
} from '../agent/demoRequirement.js';

/**
 * The starter variants P4 adds, each named for the folder whose manifest it mirrors.
 * `hue` is absent by design — Hue declares nothing (AL-09 D10), so there is no
 * requirement for a demo brain to emit and a variant would be a fiction.
 */
const STARTER_VARIANTS = ['starter-coingecko', 'starter-openweather', 'starter-github', 'starter-spotify'] as const;

/**
 * Each variant paired with the example FOLDER whose shipped manifest it mirrors.
 *
 * The pairing is the thing under test: without it "mirrors the manifests" degrades to
 * "matches a table someone typed next to the assertion", which is what it had degraded to.
 */
const VARIANT_FOLDERS = [
  { variant: 'starter-coingecko', folder: 'crypto-portfolio' },
  { variant: 'starter-openweather', folder: 'weather-planner' },
  { variant: 'starter-github', folder: 'my-repos' },
  { variant: 'starter-spotify', folder: 'spotify-party-dj' },
] as const satisfies ReadonlyArray<{ variant: (typeof STARTER_VARIANTS)[number]; folder: string }>;

interface ShippedManifest {
  slot: string;
  kind: string;
  provider: { name: string };
  declaredApiHosts: string[];
}

/**
 * apps/playground → repo root → examples/<folder>/connection.json
 *
 * Resolved from `process.cwd()` (vitest runs each project from its own package root), NOT
 * from `import.meta.url`: this suite runs in the jsdom environment, where `import.meta.url`
 * is not a `file:` URL and `fileURLToPath` throws.
 */
function readShippedManifest(folder: string): ShippedManifest {
  const file = path.resolve(process.cwd(), '../../examples', folder, 'connection.json');
  return JSON.parse(readFileSync(file, 'utf8')) as ShippedManifest;
}

function setSearch(variant: string | null): void {
  const url = new URL(window.location.href);
  if (variant === null) url.searchParams.delete('demoreq');
  else url.searchParams.set('demoreq', variant);
  window.history.replaceState({}, '', url);
}

describe('P4-AC10 — the seam recognizes the starter variants', () => {
  it('resolves each starter variant from the URL flag', () => {
    for (const variant of STARTER_VARIANTS) {
      setSearch(variant);
      expect(demoRequirementVariant(), `?demoreq=${variant} must resolve`).toBe(variant);
    }
  });

  it('still resolves the P3 build variants — this is an EXTENSION, not a replacement', () => {
    // The P3 wizard e2e drives these four journeys and must keep working untouched. A
    // variant table rewritten rather than extended would break that suite silently, in a
    // file P4 never opens.
    for (const variant of ['coinbase', 'bearer', 'basic', 'oauth', 'undeclared']) {
      setSearch(variant);
      expect(demoRequirementVariant(), `the P3 variant ${variant} must survive`).toBe(variant);
    }
  });

  it('refuses an unknown variant — the seam has ZERO footprint when absent', () => {
    // The security property of a URL-flag seam: anything not on the pinned list resolves
    // to null, so a stray query param can never inject a requirement into a real session.
    setSearch('starter-evil');
    expect(demoRequirementVariant()).toBeNull();
    setSearch(null);
    expect(demoRequirementVariant()).toBeNull();
  });
});

describe('P4-AC10 — every starter variant survives the FULL production path', () => {
  for (const variant of STARTER_VARIANTS) {
    it(`${variant}: parses under connectionRequirementSchema`, () => {
      const parsed = connectionRequirementSchema.safeParse(DEMO_STARTER_REQUIREMENTS[variant]);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    });

    it(`${variant}: is admitted on the \`starter\` channel`, () => {
      // The channel the install act uses. A variant admitted only on `registry` would
      // exercise a path no starter ever takes.
      const result = admitConnectionRequirement(DEMO_STARTER_REQUIREMENTS[variant], { channel: 'starter' });
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    });

    it(`${variant}: its header template passes the lint against its own field keys`, () => {
      const requirement = DEMO_STARTER_REQUIREMENTS[variant];
      const template = requirement.request?.headerTemplate;
      if (template === undefined) return; // oauth and keyless shapes carry none

      const result = lintAuthHeaderTemplate(template, {
        fieldKeys: (requirement.fields ?? []).map((field) => field.key),
      });
      expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    });

    it(`${variant}: emits a chat script whose CLOSING turn carries the requirement`, () => {
      // The seam's shape contract: the requirement rides the POST-TURN path (P2), so the
      // script must have a closing turn after the artifact write. A single-turn script
      // would never reach `finalizeConnectionDeclaration`.
      const script = demoRequirementChatScript(variant);
      expect(script.length, 'write the app, then close the turn').toBeGreaterThanOrEqual(2);
      expect(script[0]?.toolCalls?.length ?? 0).toBeGreaterThan(0);

      // …and the closing text must actually CONTAIN this variant's requirement. Without
      // this, the assertion passes vacuously on an unknown variant: the generic branch
      // interpolates `REQUIREMENTS[variant]` — `undefined` for a name it does not know —
      // and still returns two well-shaped turns (verified red-first: these four were the
      // only starter-variant assertions passing before this line was added).
      const closing = script[script.length - 1]?.text ?? '';
      expect(closing, 'the directive must not be a hole where the requirement should be').not.toContain(
        '"requirement":null',
      );
      expect(closing).toContain(DEMO_STARTER_REQUIREMENTS[variant].declaredApiHosts[0]);
      expect(closing).toContain(DEMO_STARTER_REQUIREMENTS[variant].slot);
    });
  }
});

describe('P4-AC10 — the starter variants MIRROR the shipped manifests', () => {
  // THE FIX THIS BLOCK CARRIES, stated because the previous version of it was mutation-
  // proven vacuous. It was titled "MIRROR the shipped manifests" and compared the demo
  // table against a `const expected` hardcoded INSIDE the test — `examples/*/connection.json`
  // was never read. Changing `examples/my-repos/connection.json`'s kind from `bearer_token`
  // to `api_key` — drifting the shipped manifest away from the variant it supposedly
  // mirrors — left all 19 root tasks green.
  //
  // A fixture cannot catch a typo in a manifest that actually ships. That is the harvested
  // AL-09 discipline verbatim, and it is why every assertion below reads DISK.

  for (const { variant, folder } of VARIANT_FOLDERS) {
    it(`${variant}: mirrors examples/${folder}/connection.json field for field`, () => {
      const manifest = readShippedManifest(folder);
      const demo = DEMO_STARTER_REQUIREMENTS[variant] as Record<string, unknown>;

      // The four seats that decide which provider the journey actually exercises. A drift
      // in any one of them means the e2e proves a journey no shipped starter performs.
      expect(demo['slot'], `${variant}: slot must match the shipped manifest`).toBe(manifest.slot);
      expect(demo['kind'], `${variant}: kind must match — it selects the whole auth flow`).toBe(manifest.kind);
      expect((demo['provider'] as { name: string }).name).toBe(manifest.provider.name);
      expect(demo['declaredApiHosts']).toEqual(manifest.declaredApiHosts);
    });
  }

  it('declares only hosts the shipped manifests declare — never a fiction', () => {
    // The anti-fiction assertion. If a variant declared `stub.snug.test` the e2e would
    // prove the journey works on a host no starter declares — the exact inversion the
    // stub-host pattern exists to prevent. Read off disk, so a manifest host edit moves
    // the expectation with it rather than silently disagreeing.
    for (const { variant, folder } of VARIANT_FOLDERS) {
      for (const host of DEMO_STARTER_REQUIREMENTS[variant].declaredApiHosts) {
        expect(readShippedManifest(folder).declaredApiHosts, `${variant}: ${host} is in no shipped manifest`).toContain(
          host,
        );
      }
    }
  });

  it('covers the credential spectrum the starters span — api_key, bearer_token, oauth', () => {
    // AL-09's whole point was the SPECTRUM: one starter per auth shape. A variant table
    // that collapsed to one kind would leave the other journeys untested.
    const kinds = new Set(STARTER_VARIANTS.map((variant) => DEMO_STARTER_REQUIREMENTS[variant].kind));
    expect(kinds).toContain('api_key');
    expect(kinds).toContain('bearer_token');
    expect(kinds).toContain('oauth2_auth_code');
  });

  it('carries NO credential value in any variant (C1)', () => {
    // A demo brain is scripted, so it is precisely where someone would be tempted to bake
    // in a working key "to make the journey run end to end". The e2e types its secrets;
    // the requirement never carries one.
    for (const variant of STARTER_VARIANTS) {
      const serialized = JSON.stringify(DEMO_STARTER_REQUIREMENTS[variant]);
      expect(serialized, `${variant} must declare fields, never values`).not.toMatch(/"value"\s*:/);
      for (const field of DEMO_STARTER_REQUIREMENTS[variant].fields ?? []) {
        expect(field).not.toHaveProperty('value');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// P5 — the starters must actually PERSIST through the production seam.
// ---------------------------------------------------------------------------

/**
 * THE SHIPPED BLOCKER THIS PINS, found by driving `?demoreq=starter-github` through a real
 * browser during the P5 review.
 *
 * Everything above this line checks the variants against the manifests and pushes them
 * through schema → admission → template lint. All of it passed while the product was
 * broken, because none of it ever CALLED the persist path. On that path admission runs a
 * SECOND time inside the db accessor, and the substituted `fields` the first pass had just
 * added were read by the second pass as borrower-authored credential copy — so
 * `putDeclaredConnection` threw `ConnectionNotAdmitted`, the post-turn seam reported
 * `write_refused`, and the user saw "the agent proposed a connection that failed
 * validation" with NO connect card. Every registry-backed starter, which is all of them.
 *
 * Two things had to be true for that to stay invisible, and both are fixed:
 *   - admission was not idempotent (packages/auth, `fieldsMatchRegistry`);
 *   - `installTestUserDb` opened the db WITHOUT the production `admissionGate`, so no
 *     playground test exercised the second pass at all.
 *
 * This test is the vitest half of the guard — `connection-wizard.spec.ts` journey 5 is the
 * browser half. It asserts what the unit layer can honestly assert: the row LANDS, and it
 * lands carrying the registry's pinned credential fields.
 */
describe('P5 — every starter variant PERSISTS through the real post-turn seam', () => {
  it('lands a declared row carrying the registry-pinned fields, for each variant', async () => {
    const { finalizeConnectionDeclaration } = await import('../agent/connectionPipeline.js');
    const { installTestUserDb } = await import('./userdbTestHelper.js');
    const db = await installTestUserDb();

    for (const variant of STARTER_VARIANTS) {
      const turns = demoRequirementChatScript(variant);
      const reply = turns.map((turn) => turn.text ?? '').join('');
      const html = (turns[0]!.toolCalls![0]!.input as { content: string }).content;
      const appId = `app-${variant}`;
      db.installApp({ appId, displayName: variant, html });

      const outcome = await finalizeConnectionDeclaration(db, {
        appId,
        html,
        reply,
        channel: 'inference',
      });

      expect(outcome, `${variant}: the seam returned nothing`).toBeDefined();
      expect(
        outcome!.ok,
        `${variant} FAILED TO PERSIST: ${outcome!.ok === false ? outcome!.message : ''}`,
      ).toBe(true);

      // The row is really there, and it really carries the pinned credential fields —
      // "admitted" and "stored with usable fields" are different claims, and the P4 defect
      // lived in the gap between them.
      const row = db.getConnection(appId, DEMO_STARTER_REQUIREMENTS[variant].slot);
      expect(row, `${variant}: no row was written`).toBeDefined();
      const fields = row!.requirement.fields ?? [];
      expect(fields.length, `${variant}: the stored row has ZERO credential fields`).toBeGreaterThan(0);
    }
  });
});
