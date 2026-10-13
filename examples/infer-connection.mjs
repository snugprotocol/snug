// infer-connection.mjs — the DEV-TIME connection inference script
// (TASK-20260810-p4-starters, P4-AC8; parent plan R4).
//
// WHY THIS EXISTS AT ALL. Nobody hand-writes a Coinbase header template correctly, and
// nobody remembers that OpenWeather transports its key as `?appid=` rather than a header.
// Inference is genuinely useful — so the capability is kept and MOVED, from the running
// app to the author's machine.
//
// WHY DEV-TIME AND NOT RUNTIME. P3 REMOVED run-time inference. An app must never be able
// to propose a connection while it is running: a requirement authored at runtime is a
// live negotiation with whatever the model was talked into saying, arriving after the
// user already trusted the app. What this script emits instead is a CONSTANT — a
// `connection.json` committed to the repo and reviewed in a PR like any other
// first-party content. The artifact that ships is reviewed; the negotiation is not.
//
// THE OUTPUT IS NOT TRUSTED BECAUSE A MODEL PRODUCED IT. Every emission runs the same
// three host-side gates a shipped manifest passes — schema, then the observed-host
// cross-check, then a refusal-writes-nothing rule — and the author still reads the diff.
// A script whose output the manifest gate would reject is a script nobody can use, so it
// is cheaper to fail here, at the author's terminal, than in CI or in a user's DB.
//
// NO NETWORK AND NO MODEL CALL IN THE DEFAULT TEST PATH: the `complete` seam is
// injectable (the same shape `ConnectionRequirementInferrerDeps` uses), so CI drives it
// deterministically. A dev-time tool that could only be exercised by calling a live model
// would be untested, which is where it would rot.
//
// USAGE:
//   pnpm --filter examples infer-connection <folder> [--write]

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectionRequirementSchema } from '@snugprotocol/protocol';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The hosts the app ACTUALLY dials, read out of the authored source.
 *
 * This is the half a model cannot be trusted with and a human reviewer would otherwise do
 * by eye. Two failures it catches, both real: a requirement declaring a host the app never
 * calls widens the approved ceiling for nothing, and one MISSING a host the app does call
 * ships a starter that cannot work. Read from the source text rather than asked of the
 * model, because the source is the ground truth.
 */
export function observedHosts(source) {
  const hosts = new Set();
  for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = match[1].toLowerCase();
    // Loopback/doc hosts are never a declared API ceiling.
    if (host === 'localhost' || host.startsWith('127.') || host.endsWith('.local')) continue;
    hosts.add(host);
  }
  return [...hosts].sort();
}

/**
 * THE ONE RESPONSE SCHEMA BANNER HELPER (TASK-20261010-host-broker PR-6, D-PR6-7 / AC40g).
 *
 * Every reader of "where app-authored code starts" — `validate.test.mjs` (the hooks-block
 * cut, the posture lint, the `useSnugApp` property check), `connection-manifests.test.mjs`,
 * `gmail-analysis.test.mjs` and this script — goes through these three functions. HOMED
 * HERE, not in `validate.test.mjs`, because a sibling that imported a test file would
 * re-register all of that file's tests in its own process; this module is side-effect free
 * when imported (the CLI below runs only as the entry point).
 *
 * WHY A REGEX AND A HARD ASSERT. The readers used to look for the LITERAL
 * '5. RESPONSE SCHEMA' and treat not-found softly: `html.slice(html.indexOf(…))` sliced ONE
 * character on −1 and every check over the "authored region" passed vacuously; this script
 * fell back to the whole script. PR-6 renumbers the banner to `// 8.` (the hooks block grows
 * to seven sections), which would have turned those soft readers into silent no-ops. So: the
 * kb-sync test's own regex `/\d+\. RESPONSE SCHEMA/` (any section number), exactly ONE banner
 * line (two make the cut a guess), and not-found THROWS.
 */
export const RESPONSE_SCHEMA_BANNER = /\d+\. RESPONSE SCHEMA/;

/** The `<script type="text/babel">` body of an app page. Throws when the page has none. */
export function babelScript(html, name) {
  const script = /<script type="text\/babel">\n([\s\S]*?)\n\s*<\/script>/.exec(html)?.[1];
  assert.ok(script, `${name}: has a <script type="text/babel"> block`);
  return script;
}

/**
 * The babel script's lines and the index of its ONE RESPONSE SCHEMA banner line. Throws when
 * the banner is missing or appears more than once.
 */
export function responseSchemaBanner(html, name) {
  const lines = babelScript(html, name).split('\n');
  const hits = [];
  lines.forEach((line, index) => {
    if (RESPONSE_SCHEMA_BANNER.test(line)) hits.push(index);
  });
  assert.ok(hits.length > 0, `${name}: has the RESPONSE SCHEMA banner (${RESPONSE_SCHEMA_BANNER}) — the line app-authored code starts at`);
  assert.equal(hits.length, 1, `${name}: carries exactly one RESPONSE SCHEMA banner line (found ${hits.length}) — two make the cut a guess`);
  return { lines, index: hits[0] };
}

/**
 * The authored region — everything from the RESPONSE SCHEMA banner down, the region the
 * examples validate suite lints. Scanning the WHOLE file would pick up hosts from the
 * scaffold's own comments and the CDN script tags, which are not the app's API surface.
 */
export function authoredRegion(html, name) {
  const { lines, index } = responseSchemaBanner(html, name);
  return lines.slice(index).join('\n');
}

/**
 * The prompt sent to the model rung. Kept here rather than in the central prompt store
 * because this is a DEV tool, not a shipped runtime path — but it states the same rule the
 * shipped inferrer prompt does: extract, never invent.
 */
function buildPrompt(folder, source, hosts) {
  return [
    `You are inferring the auth requirement for a first-party Snug starter app: "${folder}".`,
    '',
    'The app calls these hosts (extracted from its source — treat them as ground truth):',
    ...hosts.map((host) => `  - ${host}`),
    '',
    'Reply with ONE JSON object matching the connectionRequirement contract: slot, provider',
    '{name, docsUrl?}, kind (api_key|bearer_token|basic_auth|oauth2_auth_code|custom_header|none),',
    'fields[] {key,label,type}, registration {consoleUrl,instructions[]}, request {headerTemplate},',
    'declaredApiHosts[]. Extract, never invent — omit anything the evidence does not support.',
    'Never emit a credential VALUE; fields are definitions only.',
    '',
    '--- app source ---',
    source,
  ].join('\n');
}

/**
 * Infer the requirement for one example folder.
 *
 * Returns a RESULT rather than throwing, so the CLI and the tests read the same failures.
 * `ok:false` guarantees nothing was written — see the write step below.
 */
export async function inferConnectionForFolder(folder, deps = {}) {
  const dir = path.isAbsolute(folder) ? folder : path.join(HERE, folder);
  let html;
  try {
    html = readFileSync(path.join(dir, 'app.html'), 'utf8');
  } catch {
    return { ok: false, message: `no app.html in ${dir}` };
  }

  let authored;
  try {
    authored = authoredRegion(html, path.basename(dir));
  } catch (error) {
    // No (or an ambiguous) banner: there is no authored region to infer from. Refused —
    // never the whole script — and before any model is asked.
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const hosts = observedHosts(authored);

  const complete = deps.complete;
  if (typeof complete !== 'function') {
    return { ok: false, message: 'no completion seam supplied — pass { complete } (dev tool, no built-in model wire)' };
  }

  let reply;
  try {
    reply = await complete(buildPrompt(path.basename(dir), authored, hosts), {});
  } catch (error) {
    return { ok: false, message: `completion failed: ${String(error)}`, observedHosts: hosts };
  }

  let parsed;
  try {
    parsed = JSON.parse(reply);
  } catch {
    // A model that emitted prose, a fenced block, or a truncated object. Refused, not
    // repaired: silently salvaging half a requirement is how a wrong host gets declared.
    return { ok: false, message: 'the model reply was not valid JSON', observedHosts: hosts };
  }

  const result = connectionRequirementSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      message: `the emission is not a valid connectionRequirement: ${JSON.stringify(result.error.issues)}`,
      observedHosts: hosts,
    };
  }

  const requirement = result.data;

  // The cross-check. A declared set that omits a dialed host ships a broken starter; the
  // author sees both lists and decides, but a MISSING host is refused outright because it
  // is never the right answer.
  const missing = hosts.filter((host) => !requirement.declaredApiHosts.includes(host));
  if (missing.length > 0) {
    return {
      ok: false,
      message: `the app dials ${missing.join(', ')} but the requirement does not declare it`,
      observedHosts: hosts,
      requirement,
    };
  }

  if (deps.write === true) {
    // Written ONLY after every gate above passed — a refused inference must never leave a
    // half-written manifest behind for the next run to "confirm".
    writeFileSync(path.join(dir, 'connection.json'), `${JSON.stringify(requirement, null, 2)}\n`, 'utf8');
  }

  return { ok: true, requirement, observedHosts: hosts };
}

// ------------------------------------------------------------------------ the CLI

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const folder = args.find((arg) => !arg.startsWith('--'));
  const write = args.includes('--write');

  if (folder === undefined) {
    console.error('usage: pnpm --filter examples infer-connection <folder> [--write]');
    process.exit(2);
  }

  // The dev wire is BYOK-by-environment and deliberately explicit: this tool is run by a
  // human on their own machine, so there is no settings ladder to consult and no silent
  // fallback to a mock (which would emit a confident, wrong manifest).
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (apiKey === undefined) {
    console.error('ANTHROPIC_API_KEY is not set — this is a dev-time tool that calls a real model.');
    console.error('Alternatively, run the same inferrer seam from Claude Code and paste the reviewed JSON.');
    process.exit(2);
  }

  const complete = async (prompt) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    const body = await response.json();
    return (body.content ?? []).map((block) => block.text ?? '').join('');
  };

  const result = await inferConnectionForFolder(folder, { complete, write });
  if (!result.ok) {
    console.error(`✗ ${result.message}`);
    process.exit(1);
  }
  console.log(JSON.stringify(result.requirement, null, 2));
  console.error(`\n✓ observed hosts: ${(result.observedHosts ?? []).join(', ')}`);
  console.error(write ? '✓ written — REVIEW THE DIFF before committing' : '(dry run — pass --write to emit)');
}
