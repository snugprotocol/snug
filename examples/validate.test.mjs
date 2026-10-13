// Validates the curated example apps against the Snug app-authoring contract.
//
// Run through the workspace (the suite imports @snugprotocol/protocol, so that package
// must be built — turbo's test → build → ^build chain handles it):
//
//   pnpm --filter examples test
//
// Checks, per app:
//   1. single-file HTML — no external references beyond the allowlisted CDN <script> tags
//   2. the embedded hooks block is byte-identical to packages/sdk/embedded/snug-hooks.js
//      (after the same whitespace normalization the sdk kb-sync test uses)
//   3. announce metadata (appId / displayName / description / iconEmoji / iconColor) present
//   4. no direct browser-storage usage (the sandboxed iframe has a null origin)
//   5. parses as HTML (jsdom when available at the repo root; structural checks otherwise)
//   6. under the 5 MB artifact limit
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The manifest contract, imported from the SOURCE OF TRUTH rather than restated
 * (TASK-20260807-connection-reachability MINOR 10). `connection.json` is validated at
 * runtime by `connectionRequirementSchema` in the playground; restating that shape here
 * would let the curation gate and the runtime drift, and the drift would show up as a
 * manifest that passes review and then silently resolves to nothing.
 *
 * REPOINTED AT v4 (TASK-20260810-p4-starters, the NAMED EXIT ITEM). This import used to
 * be `llmProposalSchema`, which is now DELETED. That schema was the v3 proposal shape —
 * `authSpecHintsSchema` minus registration copy, header template, and credential field
 * definitions — and those omissions were exactly why a Coinbase-shaped requirement
 * collapsed to one generic input. The six shipped manifests are full
 * `connectionRequirement`s now, so validating them against the old contract would reject
 * every one of them (verified: it did, loudly, before this line changed).
 *
 * NO try/catch, deliberately. A gate that degrades to "skip the check" when its own
 * dependency is missing is not a gate — it reports success for work it never did. If
 * this import fails the suite must fail loudly, and the workspace dep on
 * `@snugprotocol/protocol` plus turbo's `test → build → ^build` chain is what makes it
 * resolve (verified: with `packages/protocol/dist` deleted, `turbo run test
 * --filter=examples` rebuilds protocol BEFORE this file runs).
 */
import { connectionRequirementSchema, isRfc1918Ipv4Literal, runtimeContractSchema } from '@snugprotocol/protocol';

// The ONE RESPONSE SCHEMA banner helper (TASK-20261010-host-broker D-PR6-7) — homed in the
// example tooling so every reader (this suite, connection-manifests, gmail-analysis and the
// inference script itself) shares it; see its comment for why a test file cannot be its home.
import { authoredRegion, RESPONSE_SCHEMA_BANNER, responseSchemaBanner } from './infer-connection.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const EMBEDDED_HOOKS = path.join(REPO_ROOT, 'packages', 'sdk', 'embedded', 'snug-hooks.js');
const APPS = [
  // The keepers (owner curation, TASK-20260815-starter-apps-rebuild).
  // (trivia-night was removed permanently 2026-08-21, TASK-20260821-hardening-polish —
  // owner decision on record in next-steps 2026-08-20.)
  'chess',
  'flying-pig',
  'adventure-quest',
  'quiz-me',
  // The gold-standard connected five (TASK-20260815-starter-apps-rebuild, ADR-0031):
  // each complements its provider's own app, exploits the provider chat lane, and
  // ships its authoring provenance in `authoring/` (prompts + wiki docs). One per
  // credential shape, superseding the auth-spectrum demos:
  //   trade-copilot → api_key + cdp_jwt Ed25519 (Coinbase; ported from the owner's
  //                   hub-built app — the app-authored code is the original, verbatim)
  //   spotify       → oauth2_auth_code (PKCE)    weather → api_key (query-injected)
  //   github        → bearer_token / oauth_app   hue     → LAN-class lanHost
  // `hue` remains the LAN starter: manifest declares `lanHost` (the bridge address is
  // COLLECTED from the user, never shipped) and the app drives the bridge through
  // connection-relative URLs — the real-connection pins at the bottom of this file
  // are its dedicated gate.
  'trade-copilot',
  'spotify',
  'hue',
  'weather',
  'github',
  // The linked-device starter (TASK-20260816-whatsapp-twin, ADR-0032/0033). Sixth
  // connected app and the first of its credential shape: a locally-spawned helper
  // reached over a unix socket, not a host — see the ADRs for why the sidecar is a
  // capability rather than a ceiling entry.
  'whatsapp',
  // The seventh connected starter (TASK-20260818-ledger-starter, ADR-0038): the
  // personal-finance flagship. First `basic_auth` + token-claim credential shape —
  // the SimpleFIN access pair is MINTED by the wizard's claim, never typed.
  'ledger',
  // The eighth connected starter (TASK-20260819-gmail-starter, ADR-0039): the AI
  // inbox manager. Second `oauth2_auth_code` shape after Spotify, and the first
  // starter whose value is DESTRUCTIVE work on a user's real account — which is why
  // its whole design is preview-then-one-confirm, and why the registry pin
  // deliberately withholds the scope that could permanently delete (ADR-0039 D3).
  'gmail',
];

/**
 * ADR-0011 posture, declared per app and enforced here (TASK-20260806 AC2): an
 * LLM-free app sets `RESPONSE_SCHEMA = null` and never calls `sendMessage` in its
 * authored code; an agent-driven app calls `sendMessage` WITH a `responseSchema`.
 * Everything not in this set is agent-driven.
 */
const LLM_FREE_APPS = new Set([
  // ADR-0011's LLM-free exemplars. The connected five are all agent-driven BY DESIGN
  // (TASK-20260815, ADR-0031): their wow is live provider data COMPOSED by an agent
  // that is grounded in it — the provider chat lane and each app's runtime contract
  // carry that posture, and the strict agent-driven branch of the lint below verifies
  // a real RESPONSE_SCHEMA plus a shipped runtime-contract.json for every one.
  'flying-pig',
]);
/**
 * The no-network-APIs rule, as a PAIR of patterns with one home (so the per-app rule
 * below and the rule-behavior test at the bottom of this file can never diverge).
 * See the long comment at the call site for why both are load-bearing.
 */
const DIRECT_NETWORK_API = /(?<![.\w])(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;
const QUALIFIED_NETWORK_API = /\b(window|globalThis|self)\s*\.\s*(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/;

const CDN_ALLOWLIST = ['https://cdn.jsdelivr.net', 'https://cdnjs.cloudflare.com', 'https://unpkg.com'];
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

/**
 * A connected app's own `connection.json` (TASK-20260807-connection-reachability):
 * the install-act declaration. Returns `null` when the folder ships no manifest —
 * which is most apps, and which grants NO exception of any kind.
 *
 * Read as raw text and JSON.parsed here (never `import`ed) so a malformed manifest is
 * this suite's failure to report, not a module-load crash.
 */
function readDeclaredHosts(app) {
  let raw;
  try {
    raw = readFileSync(path.join(HERE, app, 'connection.json'), 'utf8');
  } catch {
    return null; // no manifest — no exception
  }
  const parsed = JSON.parse(raw); // a malformed manifest MUST fail the suite loudly

  // The SAME strict schema the runtime resolver applies. `strictObject` throughout means
  // an unknown key anywhere is a rejection rather than a passthrough — catching it here
  // means a bad manifest never reaches a review, rather than being silently dropped once
  // shipped. The v3 keys (`kindHint`/`providerName`) now fail here by construction.
  const result = connectionRequirementSchema.safeParse(parsed);
  assert.ok(
    result.success,
    `${app}: connection.json must satisfy connectionRequirementSchema — ${result.error?.message ?? ''}`,
  );

  /*
    THE HOST RULE, FORKED WITH THE SCHEMA (ADR-0023; TASK-20260812 AC8/AC9).

    Until this task every manifest pinned at least one host, and this assertion
    said so. The `lanHost` seat makes a SECOND legal shape: a requirement that
    declares a host will be COLLECTED from the user rather than pinned by the
    author — which is the only honest declaration for a device at an address the
    user's own router assigned.

    The old rule's content survives verbatim in branch (a): a manifest with no
    `lanHost` must still declare a non-empty host list, so nothing is weakened
    for the five starters it was written for. Branch (b) states the LAN case's
    own obligation, and it is the STRICTER of the two — a LAN manifest must
    declare NO hosts at all, because a starter that shipped one would either be
    wrong for every user or right for one by luck, and it would freeze into a
    ceiling the review screen describes as "a device on your own network".

    Returning `[]` for a LAN manifest is deliberate and is what `urlAllowed`
    then does with it: no URL literal in the app's authored code is allowlisted
    by a LAN declaration. The address is not the author's to know, so it must
    not appear in authored code — the same conclusion from the other direction.
  */
  const hosts = parsed.declaredApiHosts;
  if (parsed.lanHost === undefined) {
    assert.ok(Array.isArray(hosts) && hosts.length > 0, `${app}: connection.json declares a non-empty declaredApiHosts`);
    return hosts;
  }
  assert.ok(
    hosts === undefined,
    `${app}: a lanHost manifest pins NO host — the address is the user's, collected by the wizard`,
  );
  return [];
}

/**
 * The allowlist decision for ONE url in ONE app. A declared API host is permitted as a
 * URL LITERAL in authored code — that is the whole point of a connected app — but the
 * caller still refuses it as a `<script src>`/`href`, so a declared host can never
 * become executable code or a subresource load. Host match is exact (never a prefix:
 * `api.example.com.evil.test` must not pass on `api.example.com`).
 */
function urlAllowed(url, declaredHosts) {
  if (CDN_ALLOWLIST.some((cdn) => url.startsWith(cdn + '/'))) return true;
  if (declaredHosts === null) return false;
  let host;
  try {
    ({ host } = new URL(url));
  } catch {
    return false;
  }
  return declaredHosts.includes(host);
}

// jsdom lives in the repo-root devDependencies; the suite degrades gracefully without it.
let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  // fine — structural checks still run
}

/** Same normalization as packages/sdk/src/__tests__/kb-sync.test.ts: per-line trim, blank lines dropped. */
const normalize = (code) =>
  code
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');

/**
 * The hook portion of an app: the `<script type="text/babel">` body, cut before the
 * RESPONSE SCHEMA banner (app-authored code starts there). Mirrors the sdk kb-sync test's
 * extraction so all three checks share one definition of "the hook block".
 *
 * The banner is found by the ONE banner helper (`infer-connection.mjs`;
 * TASK-20261010-host-broker D-PR6-7): the regex `/\d+\. RESPONSE SCHEMA/` — the kb-sync
 * test's own — with a missing or doubled banner a HARD failure. It used to look for the
 * LITERAL '5. RESPONSE SCHEMA'; PR-6 renumbers every starter's banner to `// 8.`.
 */
function hookBlock(html, name) {
  const { lines, index } = responseSchemaBanner(html, name);
  assert.ok(
    index >= 1 && /^\s*\/\/ =+$/.test(lines[index - 1]),
    `${name}: the RESPONSE SCHEMA banner sits under its ==== line, below the hook block`,
  );
  return lines.slice(0, index - 1).join('\n'); // also drops the ==== line above the banner
}

const expectedHooks = normalize(readFileSync(EMBEDDED_HOOKS, 'utf8'));

// ── The per-app HTML rules, one named function each ───────────────────────────────
// TASK-20261010-host-broker PR-6 (D-PR6-7, AC40g): the per-app loop below calls these, and
// so do the fixture rows further down ("a listener after the banner", "an app-authored
// region that calls useSnugAccess()", the planted `useSnugApp` property fixture) — so a
// fixture that "passes every per-app rule" runs the SAME rules the twelve starters face,
// never a hand-picked subset that could drift from the loop. The folder-bound rules (the
// size limit, runtime-contract.json) stay in the loop: they read the folder, not the page.

/**
 * The value `useSnugApp` returns, DERIVED from `packages/sdk/embedded/snug-hooks.js` rather
 * than restated, so it cannot drift from the hook (see the property-check test's comment).
 */
function useSnugAppReturns() {
  const hooks = readFileSync(EMBEDDED_HOOKS, 'utf8');
  // The single `return { ... }` inside useSnugApp — sliced from the function body so a
  // later hook gaining another object literal cannot widen the set by accident.
  const hookBody = /function useSnugApp\([\s\S]*?\n}\n/.exec(hooks)?.[0] ?? '';
  assert.ok(hookBody, 'located useSnugApp in the SDK hooks file');
  const returned = /return \{([\s\S]*?)\};/.exec(hookBody)?.[1] ?? '';
  const allowed = new Set([...returned.matchAll(/^\s*(\w+)\s*[:,]/gm)].map(([, key]) => key));
  assert.ok(allowed.size >= 4, `derived an implausibly small hook surface: ${[...allowed]}`);
  return allowed;
}

function ruleSingleFile(html, name, declaredHosts) {
  assert.match(html, /^<!DOCTYPE html>/i, 'starts with <!DOCTYPE html>');
  // Every absolute URL in the file must sit on the CDN allowlist — or, for a
  // connected app, be a host that app's own connection.json declares (the URL it is
  // entitled to call through the governed seam). Undeclared hosts still fail.
  for (const [url] of html.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    assert.ok(urlAllowed(url, declaredHosts), `URL ${url} is on the CDN allowlist or declared by this app`);
  }
  // …and may only appear as a <script src>. No stylesheets, imports, images, or
  // fetches. NOTE the deliberate asymmetry: a DECLARED host is permitted as a URL
  // literal above, but never here — a declared API host must not become executable
  // code or any subresource load, so this check stays CDN-only.
  for (const m of html.matchAll(/(src|href)\s*=\s*["']([^"']*)["']/g)) {
    const [, attr, value] = m;
    assert.equal(attr, 'src', `${value}: no href-based external references`);
    assert.ok(
      CDN_ALLOWLIST.some((cdn) => value.startsWith(cdn + '/')),
      `src ${value} is an allowlisted CDN script`,
    );
  }
  assert.doesNotMatch(html, /<link\b/i, 'no <link> elements');
  assert.doesNotMatch(html, /@import\b/, 'no CSS @import');
  assert.doesNotMatch(html, /url\(\s*['"]?https?:/i, 'no remote url() in CSS');
  // The no-network-APIs rule applies to the APP-AUTHORED region: the canonical hook
  // block is byte-locked to sdk/embedded by the sync test below, and since AL-03 it
  // legitimately DEFINES a `fetch(url, opts)` method on the useConnectedFetch handle
  // — that method posts a snug:net-request frame; connect-src stays blocked, so it
  // is the governed seam, not a network API call. Anything an APP writes is still
  // fully checked (AL-04 repair of the AL-03 rule conflict this suite carried,
  // masked until now by turbo's own-files cache key).
  const appAuthored = html.replace(hookBlock(html, name), '');
  // AL-03-rule repair #2 (cherry-picked from TASK-20260807-starters-auth-spectrum so
  // the two tasks cannot fork on a security literal — 2026-08-03 shared-literal
  // lesson): `useConnectedFetch()` hands the app an object whose `.fetch(url)` METHOD
  // is the governed net seam, so a METHOD call (`api.fetch(`) is legal app code while
  // a BARE network call stays forbidden. `\bfetch` treated the dot as a boundary and
  // flagged the seam itself.
  //
  // THE TWO ASSERTIONS ARE A PAIR — neither ships without the other. The bare-call
  // regex below uses `(?<![.\w])`, which by design no longer matches `window.fetch(`;
  // the old single regex caught that case incidentally via `\b`. Assertion 2 is what
  // keeps window-qualified calls forbidden. Deleting it opens a real hole.
  assert.doesNotMatch(appAuthored, DIRECT_NETWORK_API, 'no direct network APIs (connect-src is blocked)');
  assert.doesNotMatch(appAuthored, QUALIFIED_NETWORK_API, 'no window-qualified network APIs either');
}

function ruleHooksByteIdentical(html, name) {
  assert.equal(normalize(hookBlock(html, name)), expectedHooks);
}

function ruleAnnounce(html) {
  for (const field of ['appId', 'displayName', 'description', 'iconEmoji', 'iconColor']) {
    assert.match(html, new RegExp(`${field}:\\s*['"\`]`), `announce field ${field} present with a literal value`);
  }
  assert.match(html, /useSnugApp\(\{/, 'announces via useSnugApp');
}

function ruleNoBrowserStorage(html) {
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!html.includes(banned), `does not reference ${banned}`);
  }
}

function ruleNoForms(html) {
  // C2's sandbox is allow-scripts only — no allow-forms. Chromium blocks a form
  // submission at initiation ("Blocked form submission to ''…"), so a React
  // onSubmit handler NEVER RUNS: the pattern looks fine in jsdom and is dead in
  // every real browser (found live by the AL-08 Playwright spec). Buttons with
  // onClick + an Enter keydown on the input are the working equivalent.
  assert.doesNotMatch(html, /<form\b/i, 'no <form> — submission is sandbox-blocked before any handler runs');
}

function ruleParses(html) {
  assert.match(html, /<html\b[^>]*>/i, 'has <html>');
  assert.match(html, /<\/html>\s*$/i, 'closes </html>');
  assert.match(html, /<title>[^<]+<\/title>/i, 'has a non-empty <title>');
  assert.match(html, /<div id="root"><\/div>/, 'has the #root mount node');
  assert.match(html, /<meta name="viewport"/, 'has a viewport meta (mobile-usable)');
  if (JSDOM) {
    const dom = new JSDOM(html); // scripts NOT executed — parse only
    const doc = dom.window.document;
    assert.ok(doc.getElementById('root'), 'jsdom: #root exists');
    // The three RUNTIME scripts are mandatory and exact; past them, an app may load
    // ONLY builds from the KB's known-good table (80-cdn-compatibility.md) — pinned
    // here as patterns so "on the CDN allowlist" can never quietly become "any script
    // the CDN hosts" (TASK-20260817-telepath widened this from exactly-three when
    // Telepath's charts brought in Chart.js 4, the first KB-blessed extra).
    const scripts = [...doc.querySelectorAll('script[src]')].map((node) => node.getAttribute('src'));
    for (const required of [
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/react@18\//,
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/react-dom@18\//,
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/@babel\/standalone@7\//,
    ]) {
      assert.ok(scripts.some((src) => required.test(src)), `jsdom: runtime script ${required} present`);
    }
    const KNOWN_GOOD_EXTRA_CDN_SCRIPTS = [
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\//,
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/d3@7\//,
    ];
    const extras = scripts.filter((src) =>
      !/^https:\/\/cdn\.jsdelivr\.net\/npm\/(react@18|react-dom@18|@babel\/standalone@7)\//.test(src));
    for (const extra of extras) {
      assert.ok(
        KNOWN_GOOD_EXTRA_CDN_SCRIPTS.some((pattern) => pattern.test(extra)),
        `jsdom: extra script ${extra} is a KB known-good pinned build`,
      );
    }
    assert.equal(doc.querySelectorAll('script[type="text/babel"]').length, 1, 'jsdom: exactly one babel script');
    assert.ok(doc.querySelector('style'), 'jsdom: inline styles present');
  }
}

function ruleLiteralSql(html) {
  // Adversarial-review NOTE on AL-08: a statement assembled from strings at the call
  // site ('DELETE FROM ' + table) is the habit that graduates into injection. Apps
  // that run agent-authored SQL pass a validated VARIABLE (allowed); apps issuing
  // their own statements write them as literals.
  assert.doesNotMatch(html, /\.exec\(\s*['"][^'"]*['"]\s*\+/, 'no concatenated SQL literal at an exec() call site');
}

function rulePosture(html, name, llmFree) {
  // The authored region: everything from the RESPONSE SCHEMA banner to the end of the
  // babel script — the hook block above it is contract code and legitimately DEFINES
  // sendMessage, so posture is only meaningful below the banner. (The ONE banner helper —
  // a missing banner is a hard failure, never an empty region.)
  const authored = authoredRegion(html, name);
  if (llmFree) {
    assert.match(authored, /const RESPONSE_SCHEMA = null/, 'LLM-free: RESPONSE_SCHEMA is null');
    assert.doesNotMatch(authored, /\bsendMessage\s*\(/, 'LLM-free: authored code never calls sendMessage');
  } else {
    assert.match(authored, /\bsendMessage\s*\(/, 'agent-driven: authored code calls sendMessage');
    assert.match(authored, /responseSchema:/, 'agent-driven: a responseSchema travels with the request');
  }
}

/**
 * Every property the page reads off a WHOLE-OBJECT `useSnugApp` binding is one the hook
 * returns (the rule and its history: the "apps read only properties useSnugApp actually
 * returns" test below). The authored region comes from the ONE banner helper: the old
 * `html.slice(html.indexOf('5. RESPONSE SCHEMA'))` sliced ONE character when the literal was
 * absent, so after a renumber this check would have passed for every app, vacuously — the
 * planted fixture below proves it can fail.
 */
function ruleUseSnugAppProperties(html, name, allowed = useSnugAppReturns()) {
  // Find `const <name> = useSnugApp(` — the whole-object style.
  const binding = /(?:const|let)\s+(\w+)\s*=\s*useSnugApp\s*\(/.exec(html)?.[1];
  if (!binding) return; // destructured, or LLM-free: nothing to check
  const authored = authoredRegion(html, name);
  for (const [, prop] of authored.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))) {
    assert.ok(
      allowed.has(prop),
      `${name}: reads \`${binding}.${prop}\`, which useSnugApp does not return (it returns ${[...allowed].join(', ')}) — a misspelled property is undefined, not an error, so this fails silently at runtime`,
    );
  }
}

/** Every per-app HTML rule, in the loop's order — what a fixture must pass to be a legal app. */
function assertEveryPerAppHtmlRule(html, name, { llmFree, declaredHosts = null }) {
  ruleSingleFile(html, name, declaredHosts);
  ruleHooksByteIdentical(html, name);
  ruleAnnounce(html);
  ruleNoBrowserStorage(html);
  ruleNoForms(html);
  ruleParses(html);
  ruleLiteralSql(html);
  rulePosture(html, name, llmFree);
  ruleUseSnugAppProperties(html, name);
}

for (const app of APPS) {
  const file = path.join(HERE, app, 'app.html');
  const html = readFileSync(file, 'utf8');

  test(`${app}: single-file HTML with no external refs beyond allowlisted CDN scripts`, () => {
    ruleSingleFile(html, app, readDeclaredHosts(app));
  });

  test(`${app}: embedded hooks block is byte-identical to sdk/embedded/snug-hooks.js (normalized)`, () => {
    ruleHooksByteIdentical(html, app);
  });

  test(`${app}: announce metadata is complete`, () => {
    ruleAnnounce(html);
  });

  test(`${app}: no direct browser storage (sandboxed iframe has a null origin)`, () => {
    ruleNoBrowserStorage(html);
  });

  test(`${app}: no <form> elements (sandbox blocks submission BEFORE the submit event fires)`, () => {
    ruleNoForms(html);
  });

  test(`${app}: parses as HTML`, () => {
    ruleParses(html);
  });

  test(`${app}: within the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MB artifact limit`, () => {
    assert.ok(statSync(file).size <= MAX_ARTIFACT_BYTES, 'app.html is within the artifact size limit');
  });

  test(`${app}: SQL at exec() call sites is literal, never string-built`, () => {
    ruleLiteralSql(html);
  });

  test(`${app}: declares its ADR-0011 LLM posture honestly`, () => {
    rulePosture(html, app, LLM_FREE_APPS.has(app));
  });

  test(`${app}: runtime contract matches its LLM posture (ADR-0018)`, () => {
    // An agent-driven starter is the reference implementation of a well-built Snug app,
    // so it must ship the artifact the KB tells every builder to write. An LLM-free app
    // must NOT ship one: a contract for an app that never calls the model is dead text
    // that would still be copied forward on every version.
    const contractPath = path.join(REPO_ROOT, 'examples', app, 'runtime-contract.json');
    const present = existsSync(contractPath);
    if (LLM_FREE_APPS.has(app)) {
      assert.equal(present, false, 'LLM-free: ships no runtime-contract.json');
      return;
    }
    assert.ok(present, 'agent-driven: ships runtime-contract.json');
    // Parsed through the REAL schema — a starter contract that the host would reject at
    // install time is worse than none, because the app looks contract-bearing on disk.
    const parsed = runtimeContractSchema.safeParse(JSON.parse(readFileSync(contractPath, 'utf8')));
    assert.ok(parsed.success, `runtime-contract.json must satisfy runtimeContractSchema: ${parsed.error?.message ?? ''}`);
  });
}

// ── The banner helper, tested directly (TASK-20261010-host-broker D-PR6-7) ──────────────
// A green suite of compliant starters cannot tell a working banner reader from a broken one.
// The helper must read ANY section number (PR-6 renumbers `// 5.` → `// 8.`), and must FAIL —
// never return an empty or whole-script region — when the banner is missing or doubled.
test('the banner helper reads any section number and hard-fails on a missing or doubled banner', () => {
  const page = (...lines) => `<!DOCTYPE html>\n<script type="text/babel">\n${lines.join('\n')}\n</script>\n`;
  assert.equal(RESPONSE_SCHEMA_BANNER.source, String.raw`\d+\. RESPONSE SCHEMA`, 'the kb-sync regex, not a literal');
  for (const banner of ['// 5. RESPONSE SCHEMA — describe the JSON', '    // 8. RESPONSE SCHEMA — describe the JSON', '// 12. RESPONSE SCHEMA']) {
    const html = page('// ====', 'const hook = 1;', '// ====', banner, 'const RESPONSE_SCHEMA = null;');
    assert.equal(authoredRegion(html, 'any-number'), `${banner}\nconst RESPONSE_SCHEMA = null;`, `the region starts AT ${banner.trim()}`);
    assert.equal(normalize(hookBlock(html, 'any-number')), '// ====\nconst hook = 1;', 'the hook block ends above the banner\'s ==== line');
  }
  // Not found: a HARD failure for every reader — never `indexOf → slice`.
  const bannerless = page('// ====', 'const hook = 1;', '// ====', '// RESPONSE SCHEMA', 'const RESPONSE_SCHEMA = null;');
  assert.throws(() => authoredRegion(bannerless, 'bannerless'), /RESPONSE SCHEMA banner/);
  assert.throws(() => hookBlock(bannerless, 'bannerless'), /RESPONSE SCHEMA banner/);
  assert.throws(() => rulePosture(bannerless, 'bannerless', true), /RESPONSE SCHEMA banner/);
  // Doubled: which one starts the authored region would be a guess.
  const doubled = page('// ====', '// 5. RESPONSE SCHEMA', '// ====', '// 8. RESPONSE SCHEMA', 'const RESPONSE_SCHEMA = null;');
  assert.throws(() => authoredRegion(doubled, 'doubled'), /exactly one RESPONSE SCHEMA banner/);
  // No ==== line above the banner: the hook-block cut would eat a line of hook code.
  const unruled = page('const hook = 1;', '// 8. RESPONSE SCHEMA', 'const RESPONSE_SCHEMA = null;');
  assert.throws(() => hookBlock(unruled, 'unruled'), /under its ==== line/);
  // No babel script at all.
  assert.throws(() => authoredRegion('<!DOCTYPE html><p>no script</p>', 'scriptless'), /text\/babel/);
});

// ── A complete, legal fixture page (PR-6) ─────────────────────────────────────────────
// The embedded hooks block, optionally followed by `inside` (a hooks EDIT), then the
// RESPONSE SCHEMA banner (on `8.` — the number PR-6 gives every starter) and an authored
// region. Carries every structural element the per-app rules require (viewport, the three
// runtime scripts, an inline style, #root), so a fixture row can run EVERY per-app rule.
const FIXTURE_BANNER = '    // ============================================================\n    // 8. RESPONSE SCHEMA — describe the JSON the agent must return\n    // ============================================================';

function fixturePage({ authored, inside = '' }) {
  const hooks = readFileSync(EMBEDDED_HOOKS, 'utf8');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>fixture</title>
<script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
<style>body { margin: 0; }</style>
</head><body><div id="root"></div>
<script type="text/babel">
${hooks}${inside ? `\n    ${inside}\n` : '\n'}${FIXTURE_BANNER}
    ${authored}
</script>
</body></html>`;
}

/**
 * A SECOND `message` listener AFTER the banner is legal app code (originally
 * TASK-20261009-scheduling-framework A7, written for KB 85's schedule listener — which
 * PR-6 retires: the schedule hook in section 6 of the block now answers those hints, and an
 * app carrying both would answer twice). The rule stands on its own and has a live user:
 * whatsapp's LIVE-DOORBELL (`examples/whatsapp/app.html`, the `connection-event` listener
 * `whatsapp-analysis.test.mjs` extracts and drives) and gmail's open-url bridge are
 * hand-rolled listeners after the banner. So the fixture is a doorbell-shaped listener, and
 * the pair below is the rule and its mutant: a listener AFTER the banner passes every
 * per-app rule; the same listener INSIDE the block (before the banner) is a hooks edit and
 * reds the byte-compare.
 */
const SECOND_LISTENER = `window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.v !== 1) return;
      if (data.type !== 'snug:host-event' || data.event !== 'connection-event') return;
      for (const ring of doorbellRings) ring(data.data);
    });`;

function secondListenerFixture({ inside }) {
  const authored = `const RESPONSE_SCHEMA = null;
    const doorbellRings = new Set();
    function App() {
      const { isReady } = useSnugApp({ appId: 'second-listener', displayName: 'Second Listener', description: 'fixture', iconEmoji: '🔔', iconColor: '#333' });
      return isReady ? <main /> : null;
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    ${inside ? '' : SECOND_LISTENER}`;
  return fixturePage({ authored, inside: inside ? SECOND_LISTENER : '' });
}

test('an app.html may add a second `message` listener AFTER the hooks block (a doorbell like whatsapp\'s) and still pass every per-app rule', () => {
  const html = secondListenerFixture({ inside: false });
  assert.equal((html.match(/addEventListener\('message'/g) ?? []).length, 2, 'the fixture carries exactly two message listeners');
  // The rule: every per-app rule the starters face — the hooks block still byte-identical to
  // the SDK reference, the app-authored region (the second listener included) clean …
  assertEveryPerAppHtmlRule(html, 'second-listener', { llmFree: true });
  // … and the second listener really is in the app-authored region.
  assert.ok(authoredRegion(html, 'second-listener').includes("data.event !== 'connection-event'"), 'the second listener is in the app-authored region');
});

test('the mutant: the same listener INSIDE the hooks block (before the banner) is a hooks edit and fails the byte-compare', () => {
  const html = secondListenerFixture({ inside: true });
  assert.equal((html.match(/addEventListener\('message'/g) ?? []).length, 2);
  assert.notEqual(normalize(hookBlock(html, 'second-listener-inside')), expectedHooks);
  assert.throws(() => ruleHooksByteIdentical(html, 'second-listener-inside'));
});

/*
 * RETIRED (TASK-20261010-host-broker PR-6, D-PR6-7 / AC40g): the access-helper fixture pair
 * that stood here — "an app.html may add the KB access helper AFTER the hooks block" and its
 * mutant (TASK-20261010-cross-app-access AC5). Both rendered the `snugAccessRequest` helper
 * out of KB 87's "## The Cross-App Helper (copy beside the hooks block)" section, on the
 * premise that the embedded block stays unchanged (Q9). PR-6 removes that helper from KB 87
 * and carries access in the block itself (section 7, `useSnugAccess`), so the snippet the
 * pair rendered no longer exists and its premise is reversed. This suite no longer reads
 * the knowledge package at all. The generic "a listener after the banner" rule lives on in
 * the pair above; the row below is what replaces the access pair: an app that reads another
 * app's data through the HOOK is a legal app.
 */
test('an app whose authored region calls useSnugAccess() — the block\'s section 7 — passes every per-app rule', () => {
  const authored = `const RESPONSE_SCHEMA = null;
    function App() {
      const { isReady } = useSnugApp({ appId: 'access-reader', displayName: 'Access Reader', description: 'fixture', iconEmoji: '⋈', iconColor: '#333' });
      const access = useSnugAccess();
      const [grant, setGrant] = useState(null);
      const [rows, setRows] = useState([]);
      const ask = useCallback(async () => {
        const asked = await access.request('show the recipes I saved');
        if (asked.ok) setGrant(asked.grant);
      }, [access]);
      const read = useCallback(async () => {
        if (!grant) return;
        const result = await access.query(grant.id, 'SELECT title FROM recipes WHERE rating >= ?', [4]);
        if (result.ok) setRows(result.rows);
      }, [access, grant]);
      useEffect(() => {
        const offs = [access.onChange(() => { void read(); }), access.onDataChanged(() => { void read(); })];
        return () => { for (const off of offs) off(); };
      }, [access, read]);
      if (!isReady) return null;
      return grant ? <ul>{rows.map((row) => <li key={row[0]}>{row[0]}</li>)}</ul> : <button onClick={ask}>Use my recipes</button>;
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);`;
  const html = fixturePage({ authored });
  // The hook the region calls is one the copy-exactly block DEFINES (section 7) — RED until
  // the embedded file carries it (AC40a; D-PR6-4).
  assert.match(hookBlock(html, 'access-reader'), /\bfunction useSnugAccess\s*\(/, 'the hooks block defines useSnugAccess (section 7)');
  assert.match(authoredRegion(html, 'access-reader'), /\buseSnugAccess\s*\(\s*\)/, 'the authored region calls the hook');
  // No second listener is needed any more: the block's own bridge carries the access frames.
  assert.equal((html.match(/addEventListener\('message'/g) ?? []).length, 1, 'only the bridge\'s own message listener');
  assert.doesNotMatch(html, /\bsnugAccessRequest\b|\bSNUG_ACCESS_PENDING\b/, 'none of the retired helper\'s names');
  assertEveryPerAppHtmlRule(html, 'access-reader', { llmFree: true });
});

// ── Lean runtime requests (ADR-0018) ───────────────────────────────────────────────
test('chess sends its board state ONCE, not in both payload and state', () => {
  // The measured over-send this task fixed: `fen` appeared in the payload AND in
  // `state`, and `state.history` was unbounded while the payload copy was capped.
  // Pinned as a regression because it is invisible in the UI and costs on every move.
  const html = readFileSync(path.join(REPO_ROOT, 'examples', 'chess', 'app.html'), 'utf8');
  const call = /sendMessage\('player_move',([\s\S]*?)responseSchema/.exec(html)?.[1] ?? '';
  assert.ok(call.length > 0, 'found the player_move request');
  const payload = call.slice(0, call.indexOf('state:'));
  assert.doesNotMatch(payload, /\bfen\b/, 'fen belongs in state only');
  assert.doesNotMatch(payload, /moveHistory/, 'history belongs in state only');
  assert.match(call, /moveHistory: history\.slice\(-12\)/, 'the state copy of history is bounded');
});


// ─────────────────────────────────────────── AC9: authoring provenance (TASK-20260815)

/**
 * Every CONNECTED starter ships its authoring provenance (owner requirement,
 * 2026-08-15): the verbatim dev-time build prompts plus the standard wiki slugs the hub
 * keeps for user-built apps — file-per-slug, 1:1 with `snug_app_docs`, ingestable by a
 * later phase. The gate asserts presence and slug validity so a sixth connected starter
 * cannot ship provenance-less, and pins that `authoring/` can never reach the bundled
 * shelf: the playground glob is DERIVED from the source of truth rather than restated
 * (lesson 2026-07-31 — for artifacts no local suite executes, parse the producer).
 */
const CONNECTED_APPS = ['trade-copilot', 'spotify', 'hue', 'weather', 'github', 'whatsapp', 'ledger', 'gmail'];
const STANDARD_DOC_SLUGS = new Set(['vision', 'requirements', 'plan', 'lessons', 'memory', 'next-tasks']);

for (const app of CONNECTED_APPS) {
  test(`AC9: ${app} ships its authoring provenance bundle`, () => {
    const prompts = readdirSync(path.join(HERE, app, 'authoring', 'prompts')).filter((f) => f.endsWith('.md'));
    // At least one numbered prompt (01-… build or 02-… extension); 00-assembly alone is
    // a pointer, not a prompt record.
    assert.ok(
      prompts.some((f) => /^(0[1-9]|[1-9]\d)-.+\.md$/.test(f)),
      `${app}: authoring/prompts must hold at least one numbered dev-time prompt (found: ${prompts.join(', ')})`,
    );
    const docs = readdirSync(path.join(HERE, app, 'authoring', 'docs')).filter((f) => f.endsWith('.md'));
    const slugs = docs.map((f) => f.replace(/\.md$/, ''));
    for (const required of ['vision', 'requirements', 'plan']) {
      assert.ok(slugs.includes(required), `${app}: authoring/docs must include ${required}.md`);
    }
    for (const slug of slugs) {
      assert.ok(
        STANDARD_DOC_SLUGS.has(slug) || /^[a-z0-9][a-z0-9-]*$/.test(slug),
        `${app}: authoring/docs/${slug}.md must use a standard or kebab-case slug (snug_app_docs shape)`,
      );
      const body = readFileSync(path.join(HERE, app, 'authoring', 'docs', `${slug}.md`), 'utf8');
      assert.ok(body.trim().length >= 40, `${app}: authoring/docs/${slug}.md must hold real content, not a stub`);
    }
  });
}

/**
 * AC7 (TASK-20260821-hardening-polish): the authoring FLOOR, for every starter — not just
 * the connected ones AC9 above governs. Owner decision (item 6): a starter's wiki is part
 * of the product, so EVERY shipped app carries the full Ledger-style doc set plus at
 * least one build prompt, and the absent-only docs seed (ADR-0035/ADR-0045) has something
 * to deliver on every install and every update. AC9's rule stands unchanged; this floor
 * is deliberately a separate, wider gate — vision/requirements/plan alone no longer
 * clears a starter for the shelf.
 */
const REQUIRED_DOC_SLUGS = ['vision', 'requirements', 'plan', 'lessons', 'next-tasks'];

for (const app of APPS) {
  test(`AC7: ${app} ships the full authoring wiki floor (docs + a build prompt)`, () => {
    for (const slug of REQUIRED_DOC_SLUGS) {
      const docPath = path.join(HERE, app, 'authoring', 'docs', `${slug}.md`);
      assert.ok(existsSync(docPath), `${app}: authoring/docs/${slug}.md is part of the floor — every starter ships it`);
      assert.ok(
        readFileSync(docPath, 'utf8').trim().length >= 40,
        `${app}: authoring/docs/${slug}.md must hold real content, not a stub`,
      );
    }
    const prompts = readdirSync(path.join(HERE, app, 'authoring', 'prompts')).filter((f) => f.endsWith('.md'));
    assert.ok(prompts.length >= 1, `${app}: authoring/prompts must hold at least one prompt page`);
  });
}

/**
 * AC7's honesty twin, SCOPED to exactly the four keepers whose build prompts were written
 * AFTER the apps (lessons 2026-08-20: scope a must-appear assertion to the construct it
 * governs — asserting over every prompt would force the label onto the verbatim dev-time
 * records, where it would be a lie). The retro label is load-bearing: a reader of the
 * installed wiki must be able to tell a reconstructed prompt from the prompt that
 * actually drove the build.
 */
const RETRO_PROMPT_APPS = ['chess', 'flying-pig', 'adventure-quest', 'quiz-me'];

for (const app of RETRO_PROMPT_APPS) {
  test(`AC7: ${app}'s build prompt carries the retrospective label`, () => {
    const body = readFileSync(path.join(HERE, app, 'authoring', 'prompts', '01-build.md'), 'utf8');
    assert.ok(
      body.includes('Reconstructed retrospectively'),
      `${app}: authoring/prompts/01-build.md must say 'Reconstructed retrospectively' — the label is load-bearing honesty`,
    );
  });
}

/**
 * Starter versioning metadata (TASK-20260820-starter-updates, ADR-0045). Every starter
 * declares `starter.json`: an integer `version`, a cumulative `changelog` (newest
 * first), and `appHash` — the sha-256 of the NORMALIZED `app.html`. The hash is what
 * makes the authoring rule enforceable rather than requested: editing a starter's html
 * without bumping the version and writing release notes fails HERE, instead of shipping
 * a fix that no installed copy is ever offered (the exact silent gap this scheme
 * closes — a stale version number means `updateAvailable` stays false for every user
 * whose install recorded it).
 *
 * The normalization is byte-identical to `starterDeclaration.ts`'s `normalize` (the
 * two-fact vouch semantics): CRLF → LF, trailing whitespace stripped, outer trim. One
 * semantic on purpose — the hash must consider "changed" exactly what the vouch and the
 * update detector consider "changed", or a formatting-only touch would demand a release.
 */
const normalizeAppHtml = (html) => html.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
const appHtmlHash = (html) => createHash('sha256').update(normalizeAppHtml(html), 'utf8').digest('hex');

for (const app of APPS) {
  test(`ADR-0045: ${app} declares versioned starter metadata bound to its bytes`, () => {
    const raw = readFileSync(path.join(HERE, app, 'starter.json'), 'utf8');
    const meta = JSON.parse(raw);

    assert.ok(Number.isInteger(meta.version) && meta.version >= 1, `${app}: version must be an integer ≥ 1`);

    const expected = appHtmlHash(readFileSync(path.join(HERE, app, 'app.html'), 'utf8'));
    assert.equal(
      meta.appHash,
      expected,
      `${app}: app.html changed but starter.json was not released — bump "version", add a changelog entry, and set "appHash": "${expected}"`,
    );

    assert.ok(Array.isArray(meta.changelog) && meta.changelog.length >= 1, `${app}: changelog must be a non-empty array`);
    assert.equal(
      meta.changelog[0].version,
      meta.version,
      `${app}: the newest changelog entry must document the current version`,
    );
    let previous = Infinity;
    for (const entry of meta.changelog) {
      assert.ok(Number.isInteger(entry.version) && entry.version >= 1, `${app}: changelog entry versions are integers ≥ 1`);
      assert.ok(entry.version < previous, `${app}: changelog must be newest-first with strictly descending versions`);
      previous = entry.version;
      assert.match(String(entry.date), /^\d{4}-\d{2}-\d{2}$/, `${app}: changelog v${entry.version} needs a YYYY-MM-DD date`);
      assert.ok(Array.isArray(entry.sections) && entry.sections.length >= 1, `${app}: changelog v${entry.version} needs at least one section`);
      for (const section of entry.sections) {
        assert.ok(
          typeof section.title === 'string' && section.title.trim().length > 0,
          `${app}: changelog v${entry.version} sections need titles`,
        );
        assert.ok(
          Array.isArray(section.items) &&
            section.items.length >= 1 &&
            section.items.every((item) => typeof item === 'string' && item.trim().length > 0),
          `${app}: changelog v${entry.version} "${section.title}" needs at least one non-empty item`,
        );
      }
    }
  });
}

test('AC9 / ADR-0035 / ADR-0045 / TASK-20260905-host-kit AC14: starterSource.ts owns EXACTLY the five examples globs, and no other starter module declares one', () => {
  // The producers are PARSED, never restated: a widened pattern (e.g. `examples/**/*.html`)
  // would silently ship provenance files, and a glob smuggled back into a consumer module
  // would let the host kit's single alias miss it (the kit keeps the ≈ 1 MB of starter
  // bytes out of its bundle by aliasing this ONE module — TASK-20260905-host-kit A3).
  const STARTER_DIR = path.join(REPO_ROOT, 'apps', 'playground', 'src', 'starter');
  const globsOf = (file) =>
    [...readFileSync(path.join(STARTER_DIR, file), 'utf8').matchAll(/import\.meta\.glob\(\s*'([^']+)'/g)].map((m) => m[1]);
  const owned = globsOf('starterSource.ts').map((g) => g.replace(/^(\.\.\/)+/, ''));
  assert.deepEqual(
    owned.sort(),
    [
      'examples/*/app.html', // the shelf: exactly one app.html per folder, never deeper
      'examples/*/authoring/{docs,prompts}/*.md', // ADR-0035: the ONE provenance channel
      'examples/*/connection.json', // the declaration manifest
      'examples/*/runtime-contract.json', // ADR-0018: the authored contract
      'examples/*/starter.json', // ADR-0045: release metadata
    ],
    'starterSource.ts declares exactly the five pinned globs',
  );
  // EVERY other module in the directory, discovered rather than listed: a glob smuggled into
  // a file this test never named (starterUpdate.ts, a future starterX.ts) would otherwise
  // ship its bytes past the kit's single alias.
  const consumers = readdirSync(STARTER_DIR).filter((f) => f.endsWith('.ts') && f !== 'starterSource.ts');
  assert.ok(consumers.length >= 5, `expected the starter consumers, found ${consumers.length}`);
  for (const consumer of consumers) {
    assert.deepEqual(globsOf(consumer), [], `${consumer} declares no glob of its own — it reads through starterSource`);
  }
});

// ---------------------------------------------------------------------------
// The no-network-APIs rule, tested directly (TASK-20260807-connection-reachability,
// owner decision (i)). The per-app assertions above prove the SHIPPED apps are clean;
// this proves the RULE ITSELF discriminates correctly — a green suite of compliant
// apps cannot tell a working guard from a broken one.
//
// Both patterns are asserted together exactly as the call site uses them, so the
// documented invariant ("neither ships without the other") is enforced, not just
// commented: deleting QUALIFIED_NETWORK_API turns the three qualified rows red.
test('the no-network-APIs rule forbids direct calls and allows only the governed seam', () => {
  const forbidden = (src) => DIRECT_NETWORK_API.test(src) || QUALIFIED_NETWORK_API.test(src);
  const cases = [
    // [source, must be forbidden?]
    ['const r = await fetch(url);', true],
    ['const r = await window.fetch(url);', true], // the case DIRECT_ alone would miss
    ['globalThis.fetch(url);', true],
    ['self . fetch (url);', true], // whitespace must not defeat it
    ['new XMLHttpRequest();', true],
    ['new WebSocket(wsUrl);', true],
    ['new EventSource(streamUrl);', true],
    // The AL-03 governed seam: `useConnectedFetch()` returns a handle whose `.fetch`
    // METHOD posts a snug:net-request frame. connect-src stays blocked; the host is
    // the only caller that reaches the network. This is the line the old rule broke.
    ['const r = await api.fetch(url);', false],
    ['const r = await net.fetch(url, { method: "POST" });', false],
    ['const data = await this.fetch(path);', false],
    // Identifiers that merely CONTAIN a forbidden name are not calls to it.
    ['const doFetch = () => refetch(url);', false],
    ['prefetchAssets();', false],
  ];
  for (const [src, mustBeForbidden] of cases) {
    assert.equal(forbidden(src), mustBeForbidden, `${JSON.stringify(src)} forbidden=${mustBeForbidden}`);
  }
});

// The declared-host allowlist exception, tested directly (TASK-20260807, owner decision
// (i)). Negative cases first and in the majority: this rule EXISTS to keep the check
// total, so the only thing worth proving is what it still refuses.
test('the CDN allowlist admits a declared API host only for the app that declares it', () => {
  const declared = ['api.example.com'];
  const cases = [
    // [url, declaredHosts, allowed?]
    ['https://cdn.jsdelivr.net/npm/react@18/x.js', null, true], // CDN, no manifest needed
    ['https://api.example.com/v1/data', declared, true], // the whole point
    ['https://api.example.com/v1/data', null, false], // NO manifest ⇒ no exception
    ['https://api.evil.test/v1/data', declared, false], // undeclared host
    ['https://api.example.com.evil.test/x', declared, false], // suffix attack — exact host only
    ['https://evil.test/?x=api.example.com', declared, false], // declared host in the QUERY, not the host
    ['https://sub.api.example.com/x', declared, false], // subdomain is a different host
    ['http://api.example.com/v1', declared, true], // scheme is not this rule's job (CSP/connect-src is)
    ['not a url at all', declared, false],
  ];
  for (const [url, hosts, allowed] of cases) {
    assert.equal(urlAllowed(url, hosts), allowed, `${url} (declared: ${JSON.stringify(hosts)}) allowed=${allowed}`);
  }
});

/**
 * THE CURATION GATE ITSELF (TASK-20260807-connection-reachability).
 *
 * `APPS` is a hand-maintained list, and every per-app check above iterates it — so a new
 * folder that nobody adds to the list ships to the shelf COMPLETELY UNVALIDATED while
 * this suite stays green and merely reports a smaller number. That is the worst possible
 * failure mode for a curation gate: silence that reads as approval. (Found by mutating
 * `connection-demo` out of `APPS`: the suite went 84 → 75 and stayed green.)
 *
 * The playground's shelf is glob-driven (`import.meta.glob('examples/*./app.html')`), so
 * the filesystem — not this list — decides what users actually get. This test makes the
 * filesystem the authority here too.
 */
test('every examples/ folder shipping an app.html is in APPS — the list cannot silently under-report', () => {
  const onDisk = readdirSync(HERE, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(path.join(HERE, name, 'app.html')).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  assert.deepEqual(
    [...APPS].sort(),
    onDisk,
    'APPS and the examples/ folders on disk have drifted — a shelf app is unvalidated, or APPS names a folder that no longer exists',
  );
});

/**
 * `examples/README.md` tells contributors every example ships a `README.md`, and until
 * now nothing enforced it — the ninth folder landed without one, in the same commit that
 * edited the file stating the rule (found by the Gate-4 implementation review). An
 * unenforced convention drifts on first use, which is exactly what happened.
 */
test('every example folder ships a README.md (the documented contributor rule, now enforced)', () => {
  for (const app of APPS) {
    const readme = path.join(HERE, app, 'README.md');
    assert.ok(
      (() => {
        try {
          return statSync(readme).isFile();
        } catch {
          return false;
        }
      })(),
      `${app}: examples/README.md requires every example to ship its own README.md`,
    );
  }
});

/**
 * MINOR 10's self-check: the imported contract must really BE the contract.
 *
 * The failure this guards is subtle. If the schema were ever swapped for a permissive
 * stand-in — or if a future editor wrapped the import in a try/catch and fell back to
 * `{ safeParse: () => ({ success: true }) }` to "make CI green on a fresh clone" — every
 * manifest check above would still pass, and this suite would report success for
 * validation it no longer performs. So assert the schema REFUSES something.
 *
 * REPOINTED AT v4 with the import above. The probe changed with it, and deliberately:
 * the sharpest thing to refuse is now the V3 SHAPE ITSELF (`kindHint`/`providerName`),
 * because that is exactly what all six manifests carried before this phase. A schema
 * that still accepts it has not migrated, and every check above would be validating the
 * old contract while the runtime used the new one.
 */
test('the imported connectionRequirementSchema is the REAL strict contract, not a permissive stand-in', () => {
  assert.equal(typeof connectionRequirementSchema?.safeParse, 'function', 'the protocol import must resolve');

  const valid = connectionRequirementSchema.safeParse({
    slot: 'example-api',
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

  const missingHosts = connectionRequirementSchema.safeParse({
    slot: 'example-api',
    provider: { name: 'Example API' },
    kind: 'api_key',
  });
  assert.equal(missingHosts.success, false, 'declaredApiHosts is required — there is no ungated kind');
});

/**
 * TASK-20260814-hue-pairing-e2e (ADR-0025) — the hue starter's copy must tell the truth
 * on EVERY platform and in EVERY connection state.
 *
 * The owner's hardware test surfaced two claims that read as lies from the desktop app
 * after a successful pairing:
 *   - the apply control's "this control waits for the desktop app" — the user WAS in
 *     the desktop app, paired, and the control still said it was waiting for it;
 *   - the preconnect notice's web-framed rationale ("which a web page cannot reach")
 *     rendered verbatim on desktop, implying the user was somewhere they were not.
 * Together they made a SUCCESSFUL pairing indistinguishable from a failed one — the
 * app's real blocker is the runtime's app-addressing gap (apps are never told the
 * bridge's address), and the copy must name that, not a platform the user may not be on.
 */
test('hue copy is platform-agnostic and names the real runtime gap', () => {
  const html = readFileSync(path.join(HERE, 'hue', 'app.html'), 'utf8');

  assert.ok(
    !/waits for the desktop app/i.test(html),
    'the apply control must not claim to wait for the desktop app — it is false there after pairing',
  );
  assert.ok(
    !/which a web page cannot reach/i.test(html),
    'the preconnect notice must not frame its rationale around being on the web',
  );
  // NOTE (TASK-20260814-hue-starter-real-connection, AC9): the third assertion this test
  // carried — that the apply control says the capability "isn't available yet" — is
  // REPLACED by the real-connection pins below, deliberately and in the same commit. The
  // capability now exists (ADR-0026); pinning its absence would pin a lie.
});

/**
 * TASK-20260814-hue-starter-real-connection (ADR-0026) — the hue starter runs on the
 * REAL connection: symbolic addressing, live CLIP v2 data, and code-keyed honest
 * fallbacks. No mocked room or light data may remain anywhere in the file.
 */
test('hue drives the real bridge through connection-relative URLs — no dummy data', () => {
  const html = readFileSync(path.join(HERE, 'hue', 'app.html'), 'utf8');

  // The mount probe doubles as the data fetch (ADR-0026 §4): rooms come from the bridge.
  assert.ok(
    html.includes('snug-connection://hue/clip/v2/resource/room'),
    'the starter must read rooms from the bridge through the symbolic scheme',
  );
  // Scene apply is a real grouped-light write, addressed symbolically.
  assert.ok(
    html.includes('snug-connection://hue/clip/v2/resource/grouped_light/'),
    'scene apply must write to the bridge through the symbolic scheme',
  );
  // The mocked room list is gone — rooms render from the bridge response.
  assert.ok(
    !/const ROOMS\s*=/.test(html),
    'the hardcoded room list must not survive the real-connection rewrite',
  );
  assert.ok(
    !/'Living room'|"Living room"/.test(html),
    'no mocked room name may remain — rooms come from the bridge',
  );
  // Fallbacks are keyed on the executor's CODES, and the ambiguity refusal must never
  // render the connect CTA (Gate-2 review advisory).
  assert.ok(html.includes('NET_NOT_APPROVED'), 'the connect CTA must key on NET_NOT_APPROVED');
  assert.ok(
    html.includes('NET_AMBIGUOUS_CONNECTION'),
    'the ambiguity refusal must be handled distinctly (never the connect CTA)',
  );
  // No literal bridge host anywhere: the app never learns the address (ADR-0026 §3).
  // The class check is the PROTOCOL's own (`isRfc1918Ipv4Literal`), never a restated
  // range table — a restated table keeps passing when the protocol's private class
  // broadens, and the drift is silent because the two share no source.
  const dottedQuads = html.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  for (const literal of dottedQuads) {
    assert.ok(
      !isRfc1918Ipv4Literal(literal),
      `the starter must not carry a literal private address (found ${literal}) — the ceiling is the only place the host lives`,
    );
  }
});

/**
 * Every property an app reads off `useSnugApp`'s return value must be one the hook
 * ACTUALLY returns (TASK-20260819-gmail-starter, lesson 2026-08-19).
 *
 * WHY THIS GATE EXISTS. The Gmail starter shipped `app.ready` where the hook returns
 * `isReady`, and the app sat on its loading skeleton forever — with every gate in this
 * file green. Nothing here was wrong: these rules check SHAPE (single file, hooks
 * byte-identity, announce fields, no forms), and the per-app analysis suites evaluate
 * only the pure extracted core, which by design never renders. A misspelled property on
 * a JS object is `undefined`, not a throw, so the failure is silent, total, and lands on
 * the very first screen a user sees.
 *
 * The valid set is DERIVED from `packages/sdk/embedded/snug-hooks.js` rather than
 * restated, so it cannot drift from the hook: adding a field to the hook admits it here
 * automatically, and removing one starts failing the apps that still read it.
 *
 * Only whole-object usage (`const app = useSnugApp(...)` → `app.x`) is checkable this
 * way; the destructuring style every other starter uses is already compile-checked by
 * being a plain binding. That asymmetry is the point — the object style is the one with
 * no safety net, which is exactly how this bug survived to a browser.
 *
 * The rule itself is `ruleUseSnugAppProperties` (above), which reads the authored region
 * through the ONE banner helper; the planted fixture after this test proves it can fail.
 */
test('apps read only properties useSnugApp actually returns', () => {
  const allowed = useSnugAppReturns();
  for (const app of APPS) {
    ruleUseSnugAppProperties(readFileSync(path.join(HERE, app, 'app.html'), 'utf8'), app, allowed);
  }
});

/**
 * The planted fixture (TASK-20261010-host-broker D-PR6-7, AC40g): the property check above
 * CAN fail. Until PR-6 its authored region was `html.slice(html.indexOf('5. RESPONSE
 * SCHEMA'))`; on a page whose banner is `// 8.` that is `slice(-1)` — ONE character — and
 * the check passed for every app, vacuously, right when PR-6 renumbers every banner. Gmail
 * (the only whole-object starter) is the app it exists for.
 */
test('the planted fixture: a whole-object app reading app.nope below an `// 8.` banner reds the property check', () => {
  const allowed = useSnugAppReturns();
  const reading = (prop) => `const RESPONSE_SCHEMA = null;
    function App() {
      const app = useSnugApp({ appId: 'planted', displayName: 'Planted', description: 'fixture', iconEmoji: '🪴', iconColor: '#333' });
      return app.${prop} ? <main /> : null;
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);`;
  const planted = fixturePage({ authored: reading('nope') });
  assert.ok(!allowed.has('nope'), 'nope is not a useSnugApp property');
  assert.match(planted, /\/\/ 8\. RESPONSE SCHEMA/, 'the planted page carries the renumbered banner');
  assert.throws(
    () => ruleUseSnugAppProperties(planted, 'planted', allowed),
    /reads `app\.nope`, which useSnugApp does not return/,
    'a property the hook does not return reds the check',
  );
  // The evidence for why the reader changed: the old literal reader saw one character here.
  assert.equal(planted.slice(planted.indexOf('5. RESPONSE SCHEMA')).length, 1, 'indexOf → slice was vacuous on this page');
  // The positive twin: the same page reading a real property passes …
  assert.ok(allowed.has('isReady'));
  ruleUseSnugAppProperties(fixturePage({ authored: reading('isReady') }), 'honest', allowed);
  // … and the same planted page with no numbered banner is a HARD failure, never a pass.
  const bannerless = planted.replace('// 8. RESPONSE SCHEMA', '// RESPONSE SCHEMA');
  assert.throws(() => ruleUseSnugAppProperties(bannerless, 'planted-bannerless', allowed), /RESPONSE SCHEMA banner/);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// TASK-20261010-host-broker PR-6 — the twelve releases (D-PR6-7, D-PR6-8; AC40g)
// ─────────────────────────────────────────────────────────────────────────────────────
//
// PR-6 grows the copy-exactly hooks block to seven sections (6: onHostEvent · useHostEvents
// · useSnugSchedule · proposeSchedule; 7: useSnugAccess) and every starter re-copies it as a
// release (ADR-0045). The byte-compare above already reds the moment the embedded file
// changes; these rows pin what the re-copy must ALSO carry — the block's new names, both
// authored banners renumbered, the user's release-note words — and the two adoptions
// (weather's schedule, gmail's refresh), so a re-copy cannot quietly drop or widen either.
// Version bumps are NOT pinned here: the I-3 mechanical proof compares against the
// merge-base.

/** The copy-exactly names the re-copied block must define (AC40a's eight + the two section-6 functions). */
const BLOCK_DEFINITIONS = [
  /\bconst SnugBridge = \{/,
  /\bfunction useSnugApp\s*\(/,
  /\bfunction usePersistedState\s*\(/,
  /\bfunction useAppDB\s*\(/,
  /\bfunction useConnectedFetch\s*\(/,
  /\bfunction useHostEvents\s*\(/,
  /\bfunction useSnugSchedule\s*\(/,
  /\bfunction useSnugAccess\s*\(/,
  /\bfunction onHostEvent\s*\(/,
  /\bfunction proposeSchedule\s*\(/,
];

/** The nine starters that carry a YOUR APP banner (the contract's anchor 7) — `// 9.` after PR-6. */
const YOUR_APP_STARTERS = new Set(['adventure-quest', 'chess', 'github', 'hue', 'ledger', 'quiz-me', 'spotify', 'weather', 'whatsapp']);

/** The release notes, in the user's words (D-PR6-7). `<Name>` is the app's announced displayName. */
const RELEASE_TITLE = 'Up to date with Snug';
const RELEASE_DATE = '2026-10-12';
const RELEASE_SECTION = 'What changed';
const releaseItems = (displayName) => [
  `${displayName} works just as before: this release updates the built-in code every Snug app uses to talk to Snug to the version new apps are built with.`,
  'Customized your copy? You can skip this one — your version keeps working as it is.',
];
const RELEASE_EXTRA_ITEM = {
  weather: 'The morning forecast and its one-time suggestion run on that updated code and work as before.',
  gmail: "'Load my real data' after connecting Gmail runs on that updated code and works as before.",
};

/** The displayName the page announces through useSnugApp — the `<Name>` in the shared sentence. */
function announcedDisplayName(html, name) {
  const authored = authoredRegion(html, name);
  const displayName = /\buseSnugApp\s*\(\s*\{[\s\S]*?\bdisplayName:\s*(['"`])((?:(?!\1)[^\\])+)\1/.exec(authored)?.[2];
  assert.ok(displayName, `${name}: announces a literal displayName through useSnugApp`);
  return displayName;
}

const MESSAGE_LISTENER = /addEventListener\(\s*['"]message['"]/g;
/** A call to any of section 6's or 7's functions. */
const NEW_HOOK_CALL = /\b(useHostEvents|useSnugSchedule|useSnugAccess|proposeSchedule|onHostEvent)\s*\(/;

for (const app of APPS) {
  const html = readFileSync(path.join(HERE, app, 'app.html'), 'utf8');

  test(`PR-6: ${app}'s hooks block carries sections 6–7 (the seven hooks, onHostEvent, proposeSchedule)`, () => {
    const block = hookBlock(html, app);
    for (const definition of BLOCK_DEFINITIONS) {
      assert.match(block, definition, `${app}: the re-copied hooks block defines ${definition.source}`);
    }
  });

  test(`PR-6: ${app} renumbers its authored banners (// 8. RESPONSE SCHEMA${YOUR_APP_STARTERS.has(app) ? ', // 9. YOUR APP' : ''})`, () => {
    const { lines, index } = responseSchemaBanner(html, app);
    assert.match(lines[index].trim(), /^\/\/ 8\. RESPONSE SCHEMA\b/, `${app}: the RESPONSE SCHEMA banner is section 8`);
    const yourApp = lines.flatMap((line, at) => (/\d+\. YOUR APP\b/.test(line) ? [at] : []));
    if (YOUR_APP_STARTERS.has(app)) {
      assert.equal(yourApp.length, 1, `${app}: exactly one YOUR APP banner`);
      assert.match(lines[yourApp[0]].trim(), /^\/\/ 9\. YOUR APP\b/, `${app}: the YOUR APP banner is section 9`);
      assert.ok(yourApp[0] > index, `${app}: YOUR APP follows RESPONSE SCHEMA`);
    } else {
      assert.equal(yourApp.length, 0, `${app}: carries no YOUR APP banner (none to renumber)`);
    }
  });

  test(`PR-6: ${app}'s release notes are the user's words (D-PR6-7)`, () => {
    const meta = JSON.parse(readFileSync(path.join(HERE, app, 'starter.json'), 'utf8'));
    const entry = meta.changelog[0];
    assert.equal(entry.title, RELEASE_TITLE, `${app}: changelog[0] is titled "${RELEASE_TITLE}"`);
    assert.equal(entry.date, RELEASE_DATE, `${app}: changelog[0] is dated ${RELEASE_DATE}`);
    assert.ok(
      entry.sections.every((section) => section.title !== "What's new"),
      `${app}: no "What's new" section — nothing is new for the user in this release`,
    );
    assert.deepEqual(entry.sections.map((section) => section.title), [RELEASE_SECTION], `${app}: ONE "${RELEASE_SECTION}" section`);
    const expected = [...releaseItems(announcedDisplayName(html, app)), ...(RELEASE_EXTRA_ITEM[app] ? [RELEASE_EXTRA_ITEM[app]] : [])];
    assert.deepEqual(
      [...entry.sections[0].items].sort(),
      [...expected].sort(),
      `${app}: the two shared sentences${RELEASE_EXTRA_ITEM[app] ? ' and its one extra item' : ''}, nothing else`,
    );
  });

  test(`PR-6: ${app}'s authored region adopts exactly what D-PR6-8 says`, () => {
    const authored = authoredRegion(html, app);
    const listeners = [...authored.matchAll(MESSAGE_LISTENER)];
    // D-PR6-1: no starter reads another app's data — none calls the access hook.
    assert.doesNotMatch(authored, /\buseSnugAccess\s*\(/, `${app}: no starter calls useSnugAccess (none reads another app)`);
    if (app === 'weather') {
      // The window-level schedule listener and its SCHEDULE_HANDLED set are gone — the hook answers.
      assert.equal(listeners.length, 0, 'weather: no `message` listener of its own');
      assert.doesNotMatch(authored, /\bSCHEDULE_HANDLED\b/, 'weather: no SCHEDULE_HANDLED');
      assert.doesNotMatch(authored, /event:\s*['"]schedule-(request|result)['"]/, 'weather: no raw schedule-request / schedule-result post — the hooks own both frames');
      assert.match(authored, /\buseSnugSchedule\s*\(/, 'weather: mounts useSnugSchedule');
      assert.match(authored, /\bproposeSchedule\s*\(/, 'weather: suggests through proposeSchedule');
    } else if (app === 'gmail') {
      // The hand-rolled connection-event listener is gone; the open-url bridge stays.
      assert.doesNotMatch(authored, /['"`]snug:host-event['"`]/, "gmail: no 'snug:host-event' literal");
      assert.equal(listeners.length, 1, 'gmail: exactly one `message` listener of its own');
      assert.ok(
        authored.slice(listeners[0].index, listeners[0].index + 400).includes('snug:open-url-result'),
        'gmail: the one listener left is the open-url bridge',
      );
      // RS-4 (Gate 5): sequential requestIds — a sibling frame could resolve a pending unsubscribe-link
      // request. The listener answers only window.parent, like the block's own bridge (D-PR6-2).
      assert.match(
        authored.slice(listeners[0].index, listeners[0].index + 400),
        /\(event\) => \{\s*const data = event\.data;\s*if \(event\.source !== window\.parent \|\| !data \|\| data\.v !== 1 \|\| data\.type !== 'snug:open-url-result'\) return;/,
        'gmail: the open-url listener carries the source guard',
      );
      assert.match(authored, /\buseHostEvents\s*\(/, 'gmail: subscribes through useHostEvents');
      const call = authored.slice(authored.search(/\buseHostEvents\s*\(/), authored.search(/\buseHostEvents\s*\(/) + 400);
      for (const kept of ["'connection-event'", "'gmail'", 'requestRefresh', 'sync()']) {
        assert.ok(call.includes(kept), `gmail: the useHostEvents call keeps the refresh behaviour (${kept})`);
      }
      assert.doesNotMatch(authored, /\b(useSnugSchedule|proposeSchedule)\s*\(/, 'gmail: adopts useHostEvents only');
    } else {
      // The ten others only re-copy the block.
      assert.doesNotMatch(authored, NEW_HOOK_CALL, `${app}: calls none of the block's new functions — it only re-copies the block`);
    }
  });
}
