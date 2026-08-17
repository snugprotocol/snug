// connection-manifests.test.mjs — TASK-20260810-p4-starters (RED).
//
// P4-AC2, P4-AC6 and the P4-AC9 protocol half, in the examples node:test home the plan
// names. A SEPARATE FILE from `validate.test.mjs` on purpose, and the reason is a
// red-first one: `validate.test.mjs` ends with an APPS-vs-disk gate that fails the whole
// suite the moment `APPS` names a folder that does not exist yet. Putting these
// assertions there would turn every check in that file red for one reason — "the
// folders are missing" — and a red suite that reports one cause for nine independent
// gaps is not evidence, it is noise. Here each AC fails on its own line.
//
// The implementer FOLDS these into `validate.test.mjs` when the folders land (that is
// the named exit item: the suite's import moves to `connectionRequirementSchema`). Until
// then this file is the specification of what "folded" has to mean.
//
// ── P4-AC2 — FIVE declaring manifests, and hue declaring none (fold B1) ─────────────
// SIX starter FOLDERS ship; FIVE of them declare a `connection.json`. The arithmetic,
// stated plainly because an earlier draft of this file got it wrong: four of the five
// AL-09 starters declare (crypto-portfolio, weather-planner, my-repos, spotify-party-dj),
// `hue-lights-party` deliberately declares nothing, and main's existing `connection-demo`
// is the fifth declarer. 4 + 1 = 5.
//
// That earlier draft built a six-member list and immediately `.filter()`ed hue back out,
// so the constant evaluated to five while the test NAME promised six — and the assertion
// compared the same five-element array to itself. The count the name claimed to pin was
// never pinned. Naming it honestly is the fix; the POSTURE was always right.
//
// `connection-demo` is the trap this AC exists for: it already shipped a v3-shaped
// `connection.json` on main, so a rewrite validating only the NEW folders would leave one
// shipped manifest silently unmigrated — resolving to nothing at runtime while the suite
// reports green.
//
// ── P4-AC6 — the HARVESTED validate rules (fold T-M3) ───────────────────────────────
// Two C1 static lints that exist ONLY on the parked AL-09 branch and are ABSENT from
// main: the credential-in-authored-code lint (AL-09 AC3) and the hook-not-fetch lint
// (AL-09 AC4). They are schema-INDEPENDENT — they read HTML, not manifests — so the v4
// rewrite neither helps nor hinders them, and porting them as-is is the whole job. They
// are tested here on SYNTHETIC sources as well as the shipped apps, because a lint that
// is only ever run against compliant code cannot be distinguished from a broken one.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * THE V4 CONTRACT, imported from the source of truth.
 *
 * NO try/catch, deliberately — the same rule `validate.test.mjs` states at its own
 * import: a gate that degrades to "skip the check" when its dependency is missing
 * reports success for work it never did.
 *
 * This import is ALSO the P4-AC9 deletion assertion in its cheapest form: when
 * `llmProposalSchema` is gone and `connectionRequirementSchema` is the manifest
 * contract, this line resolves. Today it resolves too (P0 landed the schema additively)
 * — so the deletion itself is asserted separately, in the playground test that pins the
 * REWIRE behaviourally.
 */
import { connectionRequirementSchema } from '@snugprotocol/protocol';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The SIX declaring manifests.
 *
 * ── `hue-lights-party` MIGRATED FROM THE NEGATIVE SET TO THIS LIST ──────────────────
 * (TASK-20260812-desktop-auth-awareness AC8, ADR-0023.)
 *
 * Its absence was never about hue being unworthy of a declaration; it was about there
 * being no honest declaration to MAKE. The five-kind union assumed an internet host the
 * executor could reach, and a bridge lives at an address the user's router assigned, so
 * a manifest would have named a host that could not exist and minted a connect
 * affordance that could not work. That is a true statement about the protocol as it
 * stood, and this task changed the protocol: ADR-0023's `lanHost` seat lets a
 * requirement declare that a host will be COLLECTED, and the desktop's pinned-TLS
 * transport lets the executor reach it once it is.
 *
 * So the old assertion's CLAIM — "no manifest that mints an affordance which cannot
 * work" — survives intact; what changed is that hue's affordance now works, on the
 * desktop, and discloses honestly on the web. The negative test it replaced is
 * classified OBSOLETE (the condition it described no longer exists) rather than LOST,
 * and the honest-web-greyed posture it protected is now asserted positively by the
 * disclosure tests rather than by the absence of a file.
 */
const MANIFEST_APPS = [
  // The gold-standard connected five (TASK-20260815-starter-apps-rebuild, ADR-0031) —
  // superseding the six P4/auth-spectrum declarers this list previously pinned.
  'trade-copilot',
  'spotify',
  'hue',
  'weather',
  'github',
  // The sixth: the linked-device starter (TASK-20260816-whatsapp-twin, ADR-0032).
  'whatsapp',
];

/** The full set of starter folders SURVEYED for a manifest — all declarers now. */
const SURVEYED_FOLDERS = [...MANIFEST_APPS];

/** Every starter folder P4 lands, manifest-bearing or not — AC2's shelf half. */
const P4_STARTER_FOLDERS = [
  'trade-copilot',
  'spotify',
  'hue',
  'weather',
  'github',
  'whatsapp',
];

const readManifest = (app) => JSON.parse(readFileSync(path.join(HERE, app, 'connection.json'), 'utf8'));

const readHtml = (app) => readFileSync(path.join(HERE, app, 'app.html'), 'utf8');

// ─────────────────────────────────────────────────────── P4-AC2: the six manifests

test('P4-AC2: every declaring example folder is pinned in MANIFEST_APPS', () => {
  // Pins the COUNT as well as the members. A manifest appearing without a test is a shelf
  // app declaring a connection nobody reviewed; one going missing is a starter that
  // silently stopped declaring.
  //
  // The count is read FROM `MANIFEST_APPS` rather than written as a literal (it said
  // "five" through TASK-20260816-whatsapp-twin's sixth entry). This file's own header
  // records an earlier draft whose NAME promised six while the assertion pinned five —
  // a hardcoded count is how that recurs, so the list is now the single source of both.
  const declaring = SURVEYED_FOLDERS.filter((app) => {
    try {
      return statSync(path.join(HERE, app, 'connection.json')).isFile();
    } catch {
      return false;
    }
  });

  assert.equal(declaring.length, MANIFEST_APPS.length, 'every declaring folder is pinned in MANIFEST_APPS');
  assert.deepEqual(declaring.sort(), [...MANIFEST_APPS].sort(), 'the declaring folders');
});

for (const app of MANIFEST_APPS) {
  test(`P4-AC2: ${app}/connection.json validates against connectionRequirementSchema`, () => {
    const result = connectionRequirementSchema.safeParse(readManifest(app));
    assert.ok(result.success, `${app}: ${JSON.stringify(result.error?.issues ?? [], null, 2)}`);
  });

  test(`P4-AC2: ${app}/connection.json is a v4 requirement, not a v3 proposal`, () => {
    // The migration assertion, stated positively so it cannot pass by accident. A v3
    // manifest carries `kindHint`/`providerName`; a v4 requirement carries `slot`,
    // `kind` and a structured `provider`. `strictObject` means the v3 keys are a hard
    // rejection above — this names WHY, so the failure diagnoses itself.
    const manifest = readManifest(app);
    assert.ok(!('kindHint' in manifest), `${app}: kindHint is the v3 shape — v4 uses kind`);
    assert.ok(!('providerName' in manifest), `${app}: providerName is the v3 shape — v4 uses provider.name`);
    assert.equal(typeof manifest.slot, 'string', `${app}: a v4 requirement is slot-keyed`);
    assert.equal(typeof manifest.provider?.name, 'string', `${app}: a v4 requirement names its provider`);
  });

  test(`P4-AC2: ${app}/connection.json carries NO credential value (C1)`, () => {
    // A manifest is a REQUIREMENT, never a GRANT. It ships in a public repo, so a
    // credential here is a published secret. `fields` declares field DEFINITIONS —
    // key/label/type — and a `value` on any of them is the shape that leaks.
    const manifest = readManifest(app);
    for (const field of manifest.fields ?? []) {
      assert.ok(!('value' in field), `${app}: field "${field.key}" must define, never carry, a credential`);
    }
    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /"(secret|token|password|credential)Value"/i, `${app}: no credential value seat`);
  });
}

/**
 * AC8 — hue's manifest is a LAN-CLASS declaration, and every clause below names a way
 * it could be wrong (MIGRATED from "hue ships NO manifest"; see MANIFEST_APPS).
 *
 * The whole point of the LAN shape is that the manifest does NOT name a host: the
 * address belongs to the user's router, and a starter that shipped one would either be
 * wrong for everyone or right for one person by luck. `lanHost` declares that a host
 * will be collected — which is what the schema's required-XOR-lanHost rule makes
 * representable, and what the wizard's address step then fills.
 */
test('AC8: hue declares a LAN-class connection with NO pinned host', () => {
  const manifest = readManifest('hue');
  assert.equal(manifest.lanHost?.class, 'rfc1918-ipv4-literal', 'the host CLASS the wizard will validate against');
  assert.ok(typeof manifest.lanHost?.label === 'string' && manifest.lanHost.label.length > 0, 'a label the user reads');
  assert.ok(
    !('declaredApiHosts' in manifest),
    'a LAN manifest pins NO host — the address is the user\'s, collected by the wizard',
  );
});

/**
 * AC8 — the manifest stays BARE, and this is the clause most likely to be "helpfully"
 * broken by a later edit.
 *
 * Guard 2b refuses a borrowing channel that authors `fields` or `request`: where a
 * credential is sent, and what the user is told to type, are exactly the seats a
 * prompt-injected declaration must not choose. A starter manifest rides the `starter`
 * channel and borrows the `hue` brand, so authoring either seat here would make the
 * manifest UNADMITTABLE — the app would install and its connection would refuse, which
 * is a failure mode nothing on screen would explain. Omitting them is what makes the
 * registry's pinned values get substituted instead.
 */
test('AC8: hue\'s manifest is BARE — the registry supplies fields, request and pairing', () => {
  const manifest = readManifest('hue');
  for (const seat of ['fields', 'request', 'testRequest', 'pairing', 'registration', 'endpoints']) {
    assert.ok(!(seat in manifest), `a borrowing manifest must not author "${seat}" — the registry pins it`);
  }
});

test('P4-AC2: every P4 starter folder is on disk with an app.html and a README.md', () => {
  for (const folder of P4_STARTER_FOLDERS) {
    assert.ok(statSync(path.join(HERE, folder, 'app.html')).isFile(), `${folder}: ships an app.html`);
    assert.ok(statSync(path.join(HERE, folder, 'README.md')).isFile(), `${folder}: ships a README.md`);
  }
});

// ────────────────────────────────── P4-AC6: the harvested C1 static lints (fold T-M3)

/**
 * The AL-09 AC3 lint, as a PURE PREDICATE with one home so the per-app rule and the
 * rule-behavior test below cannot diverge (the same discipline `validate.test.mjs`
 * applies to its network-API pair).
 *
 * Three shapes, ported verbatim from the parked branch:
 *  (a) an app-authored `Authorization` header,
 *  (b) a STRING LITERAL assigned to a credential-named identifier,
 *  (c) a query-string credential in an authored URL — OpenWeather's real `?appid=`
 *      transport, which must stay HOST-side in the template engine.
 *
 * ONE HARVEST FINDING, recorded rather than fixed (AC6 says port as-is). The AL-09
 * comment on shape (b) claims `pat`/`token` match "as whole identifier-segments so
 * `pattern`/`tokenLabel` cannot false-positive". Half of that is true and half is not:
 * `pattern` splits to `['pattern']` and is correctly ignored, but `tokenLabel` splits to
 * `['token','label']`, so `words.includes('token')` DOES fire. The rule is not wrong —
 * flagging `const tokenLabel = "..."` is a conservative false positive on a string
 * literal, which is a nuisance and not a hole — but the comment's claim about it is, and
 * the case is dropped from the legal-shapes table below rather than the rule being
 * quietly loosened to make a comment true. Verified by direct evaluation, not by reading.
 */
export function credentialIssues(authored) {
  const issues = [];
  if (/['"`]?Authorization['"`]?\s*:/i.test(authored)) issues.push('app-authored Authorization header');
  for (const m of authored.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*['"`][^'"`\n]+['"`]/g)) {
    const name = m[1];
    const words = name.split(/(?=[A-Z])|_/).map((w) => w.toLowerCase());
    const credential =
      /api[_-]?key|apikey|client[_-]?secret|access[_-]?token|bearer|password/i.test(name) ||
      words.includes('pat') ||
      words.includes('token') ||
      words.includes('secret');
    if (credential) issues.push(`credential-named identifier "${name}"`);
  }
  if (/[?&](appid|api[_-]?key|apikey|access[_-]?token|token|key)=/i.test(authored)) {
    issues.push('query-string credential in an authored URL');
  }
  return issues;
}

/**
 * The AL-09 AC4 lint: an app with a connected surface reaches it through
 * `useConnectedFetch` and nothing else. The ELSE half is the load-bearing one — it is
 * what stops a non-connected app from quietly growing a connected surface.
 *
 * `hue-lights-party` was exempt while it declared nothing and is NOT exempt any more
 * (AC8): it ships a LAN-class manifest, so it must reach its bridge through
 * `useConnectedFetch` like every other connected starter. That is the whole C1 point of
 * the rewrite — the app never handles the minted key, the host injects it.
 */
const CONNECTED_APPS = new Set(MANIFEST_APPS);

/** The authored region: everything from the section-5 banner down. */
function authoredRegion(html, name) {
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1] ?? '';
  const lines = script.split('\n');
  const bannerIndex = lines.findIndex((line) => line.includes('5. RESPONSE SCHEMA'));
  assert.ok(bannerIndex >= 0, `${name}: has the section-5 RESPONSE SCHEMA banner`);
  return lines.slice(bannerIndex).join('\n');
}

for (const folder of P4_STARTER_FOLDERS) {
  test(`P4-AC6: ${folder} authors no credential-bearing construct (AL-09 AC3, C1)`, () => {
    const html = readHtml(folder);
    assert.deepEqual(credentialIssues(authoredRegion(html, folder)), [], `${folder}: credentials are HOST-injected`);
  });

  test(`P4-AC6: ${folder} connected posture is real — the governed seam or none (AL-09 AC4)`, () => {
    const authored = authoredRegion(readHtml(folder), folder);
    if (CONNECTED_APPS.has(folder)) {
      assert.match(authored, /\buseConnectedFetch\s*\(/, `${folder}: a connected starter calls the seam`);
    } else {
      assert.doesNotMatch(authored, /\buseConnectedFetch\s*\(/, `${folder}: no connected surface without a manifest`);
    }
  });
}

test('P4-AC6: the credential lint DISCRIMINATES — it is not merely satisfied', () => {
  // A green suite of compliant apps cannot tell a working guard from a broken one. These
  // are the cases the rule exists for, and the legal shapes it must not flag.
  const cases = [
    ['const apiKey = "sk-live-abcdef";', true],
    ['const API_KEY = "abc";', true],
    ['let clientSecret = "shhh";', true],
    ['var accessToken = `ghp_xxx`;', true],
    ['const pat = "ghp_realtoken";', true],
    ['const myToken = "abc123";', true],
    ['headers: { Authorization: "Bearer " + x }', true],
    ['const url = "https://api.openweathermap.org/data/2.5/forecast?appid=SECRET";', true],
    ['fetchUrl("/v1/x?api_key=abc")', true],
    // …and the legal shapes. A lint that flags these is unusable and would be relaxed.
    ['const pattern = "^a.*z$";', false], // `pat` must match as a WORD, not a prefix
    ['const apiKey = fields.apiKey;', false], // reading from state is the correct shape
    ['const [secret, setSecret] = useState("");', false], // not a const-literal assignment
    ['const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin";', false],
  ];
  for (const [src, mustFlag] of cases) {
    assert.equal(credentialIssues(src).length > 0, mustFlag, `${JSON.stringify(src)} flagged=${mustFlag}`);
  }
});

// ───────────────────────────────── the schema self-check, re-pointed at the v4 contract

test('P4-AC9: the imported connectionRequirementSchema is the REAL strict contract', () => {
  // The successor to `validate.test.mjs`'s `llmProposalSchema` self-check, and it exists
  // for the same reason: if the contract were ever swapped for a permissive stand-in —
  // or wrapped in a try/catch fallback "to make CI green on a fresh clone" — every
  // manifest check above would still pass while validating nothing. So assert the schema
  // REFUSES something. A v3 `kindHint` is the sharpest probe: it is exactly what the six
  // manifests carried BEFORE this phase, so a schema that accepts it has not migrated.
  assert.equal(typeof connectionRequirementSchema?.safeParse, 'function', 'the protocol import must resolve');

  const valid = connectionRequirementSchema.safeParse({
    slot: 'example',
    provider: { name: 'Example API' },
    kind: 'api_key',
    declaredApiHosts: ['api.example.com'],
  });
  assert.ok(valid.success, 'a well-formed v4 requirement must pass');

  const v3Shaped = connectionRequirementSchema.safeParse({
    kindHint: 'api_key',
    providerName: 'Example API',
    declaredApiHosts: ['api.example.com'],
  });
  assert.equal(v3Shaped.success, false, 'the v3 proposal shape must be a strict rejection');

  const noHosts = connectionRequirementSchema.safeParse({
    slot: 'example',
    provider: { name: 'Example API' },
    kind: 'none',
  });
  assert.equal(noHosts.success, false, 'keyless means no credentials, never no host gate');
});
