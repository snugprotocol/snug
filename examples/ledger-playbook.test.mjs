// Ledger's cancellation playbook — the STRUCTURE that makes it readable.
// TASK-20260819-connection-failure-ux AC13/AC14.
//
// Run through the workspace, with the other example gates: pnpm --filter examples test
//
// THE DEFECT THIS PINS. `.leak` is `display: flex`, and the playbook panel was emitted as
// a direct child of it — a flex SIBLING of `.body` (which carries `flex: 1; min-width: 0`
// and is therefore the only child that shrinks). With the panel and the trailing action
// column also competing for the row's width, the merchant column collapsed to a ribbon
// and the step text overprinted it. The owner's screenshot is the artifact: good content,
// unreadable box.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE. There is no jsdom+babel harness for starter
// app.html in this workspace (ledger-analysis.test.mjs evaluates an EXTRACTED pure core;
// it never renders). So these are SOURCE-STRUCTURE assertions — the same technique
// apps/playground's connectionSurfaces suite uses on component source. They prove the
// panel is not nested inside the flex row and that the layout declares a column
// direction; they do NOT prove pixels. Rendered readability is owner-verified on
// hardware at both frame widths (task file §4.4).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, 'ledger', 'app.html'), 'utf8');

/** The JSX of one leak card: from the keyed row open to the close of its map callback. */
function leakCardSource() {
  const start = html.indexOf('<div className="leak" key={leak.merchant}>');
  assert.ok(start > 0, 'the leak card JSX was found');
  const end = html.indexOf('{leaks.length === 0 ?', start);
  assert.ok(end > start, 'the end of the leak list was found');
  return html.slice(start, end);
}

test('AC13: the playbook is NOT a flex sibling of the merchant column', () => {
  const card = leakCardSource();
  const rowOpen = card.indexOf('className="leak-row"');
  const planbox = card.indexOf('className="planbox"');
  assert.ok(rowOpen > 0, 'the leak card wraps its row children in .leak-row');
  assert.ok(planbox > 0, 'the playbook panel still renders');
  // The panel must come AFTER the row wrapper closes — i.e. it is a sibling of the ROW,
  // not of `.body` inside it. `.emoji` and `.body` must both sit inside the wrapper.
  const emoji = card.indexOf('className="emoji"');
  const body = card.indexOf('className="body"');
  assert.ok(emoji > rowOpen && body > rowOpen, 'emoji and body live inside the row wrapper');
  assert.ok(planbox > body, 'the playbook renders after the row content, not beside it');
});

test('AC13: .leak stacks its children, and .leak-row keeps the original horizontal layout', () => {
  const leakRule = /\.leak\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(leakRule, /flex-direction:\s*column/, '.leak stacks: row first, panel beneath');
  const rowRule = /\.leak-row\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(rowRule, /display:\s*flex/, '.leak-row carries the horizontal layout');
  // The descendant selectors that style the row internals must survive the new wrapper.
  assert.match(html, /\.leak \.body\s*\{[^}]*flex:\s*1/, '.body keeps flex:1 inside the wrapper');
});

test('AC13: the panel spans the full width of the card', () => {
  const planRule = /\.planbox\s*\{([^}]*)\}/.exec(html)?.[1] ?? '';
  assert.match(planRule, /width:\s*100%/, 'the panel spans the card rather than sharing the row');
});

test('AC14: steps are numbered by STRUCTURE, not by string concatenation', () => {
  const card = leakCardSource();
  // The old form built '1. ' + step into one text node, so a wrapped step's continuation
  // lines hung under the number instead of aligning with the text.
  assert.ok(
    !card.includes("(i + 1) + '. ' + step"),
    'the step number is its own element so long steps align under their text, not their digit',
  );
  assert.match(card, /className="step-n"/, 'each step renders a discrete number element');
  assert.match(card, /className="step-t"/, 'each step renders its text in a discrete element');
});

test('AC14: the email draft is a distinct block, and the panel owns an action bar', () => {
  const card = leakCardSource();
  assert.match(card, /className="draft"/, 'the email draft is its own block, not an inline <em>');
  assert.match(card, /className="plan-actions"/, 'the panel carries its own action bar');
  // The panel's CTA lives in that bar.
  const bar = card.indexOf('className="plan-actions"');
  assert.ok(card.indexOf('open the cancellation page') > bar, 'the cancel CTA sits in the action bar');
});

test('AC14: the panel keeps its custody sentence — Snug never sees those credentials', () => {
  // A restyle must not quietly drop the one line that tells the user where they are
  // signing in and who does not see it.
  assert.match(leakCardSource(), /Snug never sees those credentials/);
});

// ---------------------------------------------------------------------------
// Rewind's recently-played lane — TASK-20260819 AC3.
// ---------------------------------------------------------------------------
//
// The registry now pins `user-read-recently-played`, so the read that used to be an
// expected-403 should succeed. THE DEGRADE PATH MUST SURVIVE ANYWAY, and that is what
// this pins: a row consented under the old seven scopes still exists (its user may never
// complete re-consent — the accepted residual in the task file), a static-kind or
// non-registry Spotify row gains no scopes at all, and a user can decline. An app that
// assumed the grant would render a broken lane for all three.
const spotifyHtml = readFileSync(path.join(HERE, 'spotify', 'app.html'), 'utf8');

test('AC3: the recently-played read still handles failure as a labeled degrade', () => {
  assert.match(
    spotifyHtml,
    /setRecent\(\{\s*status:\s*rp\.fail\.kind === 'refused' \? 'unavailable' : 'failed'/,
    'a refusal still routes to the labeled unavailable state rather than crashing the lane',
  );
  assert.match(spotifyHtml, /recent\.status === 'unavailable'/, 'the caption still branches on the degraded state');
});

test('AC3: the granted lane exists and is reachable — chips render from real metrics', () => {
  assert.match(spotifyHtml, /recent\.status === 'ok' && recent\.stats/, 'the granted branch renders the chips');
  assert.match(spotifyHtml, /function recentMetrics\(/, 'the metrics helper the granted lane needs');
});

test('AC3: the app no longer claims the scope is absent — the comments match the registry', () => {
  // Three stale claims, 900 lines apart, all asserting the pin OMITS this scope. Left
  // alone they would teach the next reader (human or model) that the 403 is expected and
  // send them hunting for a bug that no longer exists.
  assert.ok(
    !/NOT user-read-recently-played/.test(spotifyHtml),
    'the scope-honesty comment must not still say the pin excludes the scope',
  );
  assert.ok(
    !/The registry pin omits its scope/.test(spotifyHtml),
    'the loadCore comment must not still call the 403 the expected answer',
  );
  assert.ok(
    !/needs a scope this connection doesn.t carry/.test(spotifyHtml),
    'the discovery caption must not blame a scope the registry now pins',
  );
});
