// TASK-20261010-cross-app-access AC24 — the app-authoring KB teaches access between apps
// (ADR-0075 §1 the frame pair, §4 the strip and its three answers, §5 what the app learns,
// §6 the scoped read and its bounds, §9 revocation and the `access-changed` hint).
//
// TWO CLAIMS, TESTED SEPARATELY — the scheduled-runs-KB pattern (85's test is the precedent):
//
//  1. CONTENT SYNC. The helper snippet names the REAL frame types through placeholders (the
//     rendered text carries `FRAME_TYPES` values, the source carries none), the event name is
//     the protocol's `ACCESS_CHANGED_EVENT` (the constant the SDK's `onChange` subscribes
//     with), the error table is `ACCESS_ERROR_CODES` exactly — every code, no extra — and
//     every bound the page states is the protocol's constant. A snippet that drifts from
//     `packages/sdk/src/access.ts` produces apps whose asks the runner answers MALFORMED or
//     never answers, and nothing else would catch it.
//  2. RETRIEVAL DELIVERY. The page reaches the builder ONLY as `searchKnowledge`'s top
//     sections (it is NOT in the inline core). "read another app's data" must rank it first;
//     the phrasings a builder actually uses must reach it in the top five; and the headings
//     are pinned, because they are the retrieval keys (ADR-0004).
//
// Beside them: the one row `30-bridge-protocol.md` gains, the one clause `00-summary.md`
// gains, the trigger clause in `tools/app-builder.md`, and the skill's *Access between apps*
// section with its references line (the Schedules section's shape).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  ACCESS_CHANGED_EVENT,
  ACCESS_ERROR_CODES,
  ACCESS_HINT_TABLES_MAX,
  ACCESS_HINT_WORD_MAX_CHARS,
  ACCESS_HINT_WORDS_MAX,
  ACCESS_MAX_PARAMS,
  ACCESS_MAX_RESULT_BYTES,
  ACCESS_MAX_ROWS,
  ACCESS_OPS,
  ACCESS_PURPOSE_MAX_CHARS,
  ACCESS_QUERY_RATE_PER_MINUTE,
  ACCESS_QUERY_TIMEOUT_MS,
  ACCESS_REQUEST_MIN_GAP_MS,
  ACCESS_SQL_MAX_CHARS,
  ACCESS_TIMEOUT_STRIKES,
  FRAME_TYPES,
  PROTOCOL_VERSION,
} from '@snugprotocol/protocol';

import {
  INLINE_KNOWLEDGE_CORE_FILES,
  getKnowledgeBase,
  getKnowledgeSummary,
  getToolPrompt,
  searchKnowledge,
} from '../index.js';
import { promptFilesOnDisk, repoRoot } from './helpers.js';

const KB_FILE = 'knowledge-base/app-authoring/87-cross-app-access.md';
const KB_BRIDGE = 'knowledge-base/app-authoring/30-bridge-protocol.md';
const KB_SUMMARY_SOURCE = 'knowledge-base/app-authoring/00-summary.md';
const SKILL_FILE = 'skills/snug/SKILL.md';

/** The module SDK's hook, read from its SOURCE so the embedded snippet and the typed hook cannot drift. */
const SDK_ACCESS_SOURCE = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'src', 'access.ts'), 'utf8');
const SDK_BRIDGE_SOURCE = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'src', 'bridge.ts'), 'utf8');
const SDK_INDEX_SOURCE = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'src', 'index.ts'), 'utf8');
const SDK_TYPES_SOURCE = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'src', 'types.ts'), 'utf8');

/** The two HOST_ERROR messages the SDK's `accessRequest` answers before host-ready / without the capability. */
const SDK_GUARD_MESSAGES = (() => {
  const block = /export function accessRequest[\s\S]*?\n\}/.exec(SDK_BRIDGE_SOURCE)?.[0];
  if (block === undefined) throw new Error('packages/sdk/src/bridge.ts no longer exports accessRequest');
  // Keyed by the GUARD CONDITION each result follows, never by source order (W6 finding 33): a
  // reorder of the two guards in bridge.ts changes nothing here.
  const after = (guard: string): { message: string; retryable: boolean } => {
    const m = new RegExp(`${guard}\\s*\\{[\\s\\S]*?message: '([^']+)', retryable: (true|false)`).exec(block);
    if (m === null) throw new Error(`accessRequest no longer answers a guard result after ${guard}`);
    return { message: m[1] as string, retryable: m[2] === 'true' };
  };
  return { notReady: after('if \\(!bridge\\.ready\\)'), noCapability: after('if \\(bridge\\.capabilities\\.access !== true\\)') };
})();

/** The method names of `SnugAccess`, read from the SDK's types. */
const SDK_ACCESS_METHODS = (() => {
  const block = /export interface SnugAccess \{([\s\S]*?)\n\}/.exec(SDK_TYPES_SOURCE)?.[1];
  if (block === undefined) throw new Error('packages/sdk/src/types.ts no longer exports interface SnugAccess');
  return [...block.matchAll(/^\s*(\w+)\(/gm)].map((m) => m[1] as string);
})();

function rendered(file: string): string {
  const section = getKnowledgeBase().find((doc) => doc.file === file);
  expect(section, `${file} missing from the knowledge base`).toBeDefined();
  return (section as { text: string }).text;
}

function source(file: string): string {
  const entry = promptFilesOnDisk().find((f) => f.rel === file);
  if (entry === undefined) throw new Error(`${file} is not on disk`);
  return entry.content;
}

/** The text as sentences: the files are hard-wrapped, and a claim must not hide across a line break. */
const prose = (text: string): string => text.replace(/\s+/g, ' ');

/** Every fenced ```javascript block in the rendered teaching. */
const fencedJs = (text: string): string[] => [...text.matchAll(/```javascript\r?\n([\s\S]*?)\r?\n```/g)].map((m) => (m[1] as string).trim());

/** One `##` section of a rendered page, up to the next `##`. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `no "${heading}" section`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The prose a person or model reads as words: fenced code and inline code spans removed (they carry wire names). */
const wordsOnly = (text: string): string => text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');

/** AC17's vocabulary, applied to the page's prose: the UI says *access* and *history*. */
const INTERNAL_NOUNS = /\b(grants?|granted|readers?|scopes?|scoped|logs?|logged)\b/i;

describe('AC24 — the page is in the store, out of the inline core, with its headings pinned', () => {
  it('exists with the four-field header, renders, and is NOT in the inline core (a tool-free brain gets no cross-app teaching)', () => {
    const text = source(KB_FILE);
    const header = text.slice(0, text.indexOf('-->'));
    for (const field of ['layer: knowledge-base', 'destination:', 'blast-radius:', 'source:']) expect(header).toMatch(new RegExp(`^${field}`, 'm'));
    expect(header).toMatch(/NOT in the inline core/);
    expect(rendered(KB_FILE)).toContain('# Access Between Apps');
    expect(INLINE_KNOWLEDGE_CORE_FILES).not.toContain(KB_FILE);
  });

  it('the heading tree is pinned — these are the retrieval keys', () => {
    const doc = getKnowledgeBase().find((entry) => entry.file === KB_FILE)!;
    expect(doc.headingTree).toEqual([
      '# Access Between Apps',
      "## Read Another App's Data Only With the User's Say",
      '## Ask After a User Act, Never on Load',
      '## The Two Frames and Their Four Ops',
      '## What Your App Learns',
      '## Query: One Read-Only SELECT',
      '## When It Stops, Pauses or Ends',
      '## What Each Refusal Means',
      '## The Cross-App Helper (copy beside the hooks block)',
      '## Rules for Reading Another App',
    ]);
  });

  it('says *access* and *history* in its prose — never grant, reader, scope or log outside a code span (AC17’s vocabulary)', () => {
    const words = wordsOnly(rendered(KB_FILE));
    expect(words.match(INTERNAL_NOUNS)?.[0], 'an internal noun in the page prose').toBeUndefined();
    // The scan can fail: a planted sentence is caught, the same sentence in a code span is not.
    expect(wordsOnly('The reader holds a grant.')).toMatch(INTERNAL_NOUNS);
    expect(wordsOnly('The `grant` seat holds `grantId`.')).not.toMatch(INTERNAL_NOUNS);
  });
});

describe('AC24 content sync — the exchange the KB teaches is the one the protocol and the SDK implement', () => {
  it('the SOURCE names no frame type literally — placeholders only', () => {
    const text = source(KB_FILE);
    expect(text).toContain('{{frameType:accessRequest}}');
    expect(text).toContain('{{frameType:accessResponse}}');
    expect(text).toContain('{{frameType:hostEvent}}');
    expect(text).toContain('{{protocolVersion}}');
    for (const literal of Object.values(FRAME_TYPES)) expect(text, `source retypes ${literal}`).not.toContain(literal);
  });

  it('the RENDERED helper posts the real request frame through SnugBridge.post with a fresh requestId, and answers each requestId once', () => {
    const [helper] = fencedJs(rendered(KB_FILE));
    expect(helper).toBeDefined();
    expect(helper).toContain('function snugAccessRequest(op, fields)');
    expect(helper).toContain('const requestId = crypto.randomUUID();');
    expect(helper).toContain(`SnugBridge.post({ type: '${FRAME_TYPES.accessRequest}', requestId, op, ...fields });`);
    // requestId → resolve, deleted on the one terminal answer.
    expect(helper).toContain('SNUG_ACCESS_PENDING.set(requestId, resolve);');
    expect(helper).toContain('SNUG_ACCESS_PENDING.delete(data.requestId);');
    // No plumbing of its own: the bridge's post, never a hand-rolled postMessage.
    expect(helper).not.toContain('postMessage(');
  });

  it('the RENDERED listener filters on the parent window, the wire version, the real response type and the event name the SDK subscribes with', () => {
    const [helper] = fencedJs(rendered(KB_FILE));
    expect(helper).toContain("addEventListener('message'");
    expect(helper).toContain('event.source !== window.parent');
    expect(helper).toContain(`data.v !== ${PROTOCOL_VERSION}`);
    expect(helper).toContain(`data.type === '${FRAME_TYPES.accessResponse}'`);
    expect(helper).toContain(`data.type === '${FRAME_TYPES.hostEvent}' && data.event === '${ACCESS_CHANGED_EVENT}'`);
    // The SDK's onChange subscribes with the same constant — so the snippet and the hook hear the same event.
    expect(SDK_ACCESS_SOURCE).toContain('onHostEvent(ACCESS_CHANGED_EVENT,');
    // ids only: the hint carries a grantId and the helper reads nothing else from it.
    expect(helper).toContain("typeof change.grantId === 'string'");
    expect(helper).toContain('onAccessChanged(change.grantId)');
  });

  it('answers the SDK’s two guard results with nothing posted: HOST_ERROR before host-ready (retryable) and without capabilities.access (not retryable)', () => {
    const [helper] = fencedJs(rendered(KB_FILE));
    expect(SDK_GUARD_MESSAGES.notReady.retryable).toBe(true);
    expect(SDK_GUARD_MESSAGES.noCapability.retryable).toBe(false);
    expect(helper).toContain(
      `if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: '${SDK_GUARD_MESSAGES.notReady.message}', retryable: true } });`,
    );
    expect(helper).toContain(
      `if (SnugBridge.capabilities.access !== true) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: '${SDK_GUARD_MESSAGES.noCapability.message}', retryable: false } });`,
    );
  });

  it('the usage snippet asks from a user act with a purpose and hints, then queries with bound params by the id it was given', () => {
    const [, usage] = fencedJs(rendered(KB_FILE));
    expect(usage).toBeDefined();
    expect(usage).toMatch(/^async function on\w+Click\(\)/); // a click handler — never on load
    expect(usage).toContain("snugAccessRequest('request', {");
    expect(usage).toMatch(/purpose: '[^']{1,200}'/);
    expect(usage).toMatch(/hints: \{ words: \[[^\]]+\], tables: \[[^\]]+\] \}/);
    expect(usage).toContain("snugAccessRequest('query', {");
    expect(usage).toContain('grantId: access.id');
    expect(usage).toMatch(/sql: 'SELECT [^']+\?[^']*'/);
    expect(usage).toMatch(/params: \[/);
    expect(usage).not.toMatch(/useEffect|setTimeout|setInterval/);
  });

  it('teaches the four ops of the request — ACCESS_OPS exactly — in the frames table', () => {
    const table = section(rendered(KB_FILE), '## The Two Frames and Their Four Ops');
    const body = table.slice(table.indexOf('|---|')); // the rows, below the header row (whose first cell is `op`)
    const ops = [...body.matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(ops).toEqual([...ACCESS_OPS]);
    expect(prose(table)).toContain('The request is STRICT');
  });

  it('the error-code table equals ACCESS_ERROR_CODES — every code, no extra', () => {
    const table = section(rendered(KB_FILE), '## What Each Refusal Means');
    expect(table).toContain('|---|');
    const codes = [...table.slice(table.indexOf('|---|')).matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(new Set(codes).size, 'a code listed twice').toBe(codes.length);
    expect([...codes].sort()).toEqual(Object.values(ACCESS_ERROR_CODES).sort());
  });

  it('states the bounds it claims, in agreement with the protocol constants', () => {
    const text = prose(rendered(KB_FILE));
    expect(text).toContain(`at most ${ACCESS_PURPOSE_MAX_CHARS} characters`);
    expect(text).toContain(`up to ${ACCESS_HINT_WORDS_MAX} \`words\` (each at most ${ACCESS_HINT_WORD_MAX_CHARS} characters)`);
    expect(text).toContain(`up to ${ACCESS_HINT_TABLES_MAX} \`tables\``);
    expect(text).toContain(`at most ${ACCESS_SQL_MAX_CHARS.toLocaleString('en-US')} characters`);
    expect(text).toContain(`at most ${ACCESS_MAX_PARAMS} scalars`);
    expect(text).toContain(`At most ${ACCESS_MAX_ROWS} rows and ${ACCESS_MAX_RESULT_BYTES / 1024} KiB`);
    expect(text).toContain(`A read has ${ACCESS_QUERY_TIMEOUT_MS / 1000} s`);
    expect(ACCESS_TIMEOUT_STRIKES).toBe(3);
    expect(text).toContain('three in a row pause the access');
    expect(text).toContain(`At most ${ACCESS_QUERY_RATE_PER_MINUTE} queries a minute, and one \`request\` per ${ACCESS_REQUEST_MIN_GAP_MS / 1000} s`);
  });

  it('teaches the ask: after a user act, never on load; the strip with its three acts; the three answers; the durations', () => {
    const text = prose(rendered(KB_FILE));
    expect(text).toMatch(/Ask ONLY when the user has just done something/);
    expect(text).toMatch(/Never on load, never on every open, never on a timer\./);
    expect(text).toContain('*review* · *not now* · *stop asking*');
    expect(text).toContain('never a modal');
    expect(text).toContain('*not now* → `ACCESS_DECLINED` with `retryable: true`');
    // W6 finding 37 — the two final answers are told apart: *don't allow* declines THIS ask;
    // *stop asking* answers EVERY later ask the same, until the user turns asks back on.
    expect(text).toContain("*don't allow* → `ACCESS_DECLINED` with `retryable: false` — THIS ask (its hints) stays declined");
    expect(text).toContain('*stop asking* → the same answer for EVERY later ask from your app');
    expect(text).toContain('after *stop asking* the app asks no more');
    expect(text).not.toContain('a muted app is not asked again');
    expect(text).toContain('*while it\'s open*');
    expect(text).toContain('*until I stop it*');
    expect(text).toContain('*also while I\'m away*');
    expect(text).toContain('`ACCESS_UNATTENDED`');
  });

  it('says what the app learns and ONLY that — never the user’s other apps, never an app id', () => {
    const learns = prose(section(rendered(KB_FILE), '## What Your App Learns'));
    for (const seat of ['id', 'source', 'displayName', 'tables', 'columns', 'duration', 'expiresAt', 'unattended']) expect(learns).toContain(seat);
    expect(learns).toContain('That is all your app learns');
    expect(learns).toContain("Never the user's other apps, never an app id");
  });

  it('teaches query as ONE read-only SELECT with bound params over the allowed tables, absent tables, masked credential columns', () => {
    const query = prose(section(rendered(KB_FILE), '## Query: One Read-Only SELECT'));
    expect(query).toContain('ONE statement, a `SELECT`');
    expect(query).toContain('`ACCESS_QUERY_REFUSED`');
    expect(query).toContain('Bind values through `params`');
    expect(query).toContain('a table you were not allowed is not there at all');
    expect(query).toContain('`truncated: true` and `totalRows`');
    expect(query).toContain('arrives as `***`');
    expect(query).toContain("Every read is recorded in the other app's history");
  });

  it('teaches the access-changed hint as ids only and the re-list, and names the module SDK by its real exports', () => {
    const changes = prose(section(rendered(KB_FILE), '## When It Stops, Pauses or Ends'));
    expect(changes).toContain(`\`event: '${ACCESS_CHANGED_EVENT}'\``);
    expect(changes).toContain('`data: { grantId }` — ids only');
    expect(changes).toContain('re-`list`');
    // W6 finding 36 — the engine never rings on expiry (spec §23.3): the page must not promise it.
    expect(changes).toContain('An expiry is not announced');
    expect(changes).toContain('`ACCESS_EXPIRED`');
    const helperCode = section(rendered(KB_FILE), '## The Cross-App Helper (copy beside the hooks block)');
    expect(helperCode).toContain('an access was stopped or paused');
    expect(helperCode).not.toMatch(/ran out/);
    expect(SDK_INDEX_SOURCE).toMatch(/export \{[^}]*\buseSnugAccess\b[^}]*\} from '\.\/access\.js'/);
    const helper = prose(section(rendered(KB_FILE), '## The Cross-App Helper (copy beside the hooks block)'));
    expect(helper).toContain("`useSnugAccess()` from `@snugprotocol/sdk`");
    for (const method of SDK_ACCESS_METHODS) expect(helper, `SnugAccess.${method}`).toContain(`\`${method}(`);
    expect(SDK_ACCESS_METHODS.sort()).toEqual(['list', 'onChange', 'query', 'release', 'request']);
  });
});

describe('AC24 — the one row, the one clause, the trigger, the skill section', () => {
  it('30-bridge-protocol gains ONE table row for the access pair, through the placeholders', () => {
    const src = source(KB_BRIDGE);
    const rows = src.split('\n').filter((line) => line.includes('{{frameType:accessRequest}}') || line.includes('{{frameType:accessResponse}}'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^\| `\{\{frameType:accessRequest\}\}` \/ `\{\{frameType:accessResponse\}\}` \| app ↔ host \| /);
    const text = rendered(KB_BRIDGE);
    expect(text).toContain(`| \`${FRAME_TYPES.accessRequest}\` / \`${FRAME_TYPES.accessResponse}\` | app ↔ host |`);
  });

  it('00-summary gains at most ONE clause — and it points at the reading of another app', () => {
    const summary = prose(getKnowledgeSummary());
    expect(summary.match(/another app's data/g)).toHaveLength(1);
    expect(summary).toContain("may read another app's data only under an access the user allows");
    expect(source(KB_SUMMARY_SOURCE)).not.toContain('{{frameType:access');
  });

  it('tools/app-builder.md carries the trigger: when the user wants an app that reads another app’s data', () => {
    const tool = prose(getToolPrompt('app-builder'));
    expect(tool).toContain("when the user wants an app that reads another app's data");
    expect(tool).toContain('`"read another app\'s data"`');
  });

  it('the skill has an *Access between apps* section in the Schedules section’s shape, and lists the reference where it lists references', () => {
    const skill = source(SKILL_FILE);
    expect(skill.split('## Access between apps').length - 1).toBe(1);
    // After the hand-in and the data-location sections, before Schedules (whose tests read to "## Never").
    expect(skill.indexOf('## Access between apps')).toBeGreaterThan(skill.indexOf("## Where the user's data lives"));
    expect(skill.indexOf('## Access between apps')).toBeLessThan(skill.indexOf('## Schedules'));
    const access = prose(skill.split('## Access between apps')[1]?.split('## Schedules')[0] ?? '');
    expect(access).toMatch(/^ ?The user allows access between apps; an app never takes it, and neither do you\./);
    expect(access).toContain('`references/87-cross-app-access.md`');
    expect(access).toMatch(/only after the user has done something/);
    expect(access).toMatch(/never on load/);
    expect(access).toMatch(/never put another app's data into the bundle/);
    const references = prose(skill.split('## Build the app')[1]?.split('## Hand the app in')[0] ?? '');
    expect(references).toContain("`references/87-cross-app-access.md` — when the app should read another app's data.");
    expect(promptFilesOnDisk().some((f) => f.rel === KB_FILE)).toBe(true);
  });
});

describe('AC23 host-mcp line — the launch protocol says who allows access between apps', () => {
  // instructions.md is sent at MCP initialize and spliced into the skill under *The local
  // runner* (check-host-mcp byte-compares the bundle that carries it).
  const instructions = readFileSync(path.join(repoRoot, 'apps', 'host-mcp', 'src', 'instructions.md'), 'utf8');
  const paragraphs = instructions.split(/\n(?=- |\n|#)/).map(prose).filter((p) => /each other's data/.test(p));

  it('carries ONE paragraph: apps read each other’s data only under an access the user allows in the runner; the agent never allows it', () => {
    expect(paragraphs).toHaveLength(1);
    const [paragraph] = paragraphs as [string];
    expect(paragraph).toContain("Apps can read each other's data only under an access the user allows in the runner");
    expect(paragraph).toContain("You never allow it on the user's behalf");
    expect(paragraph).toContain('after the user has done something that needs it');
    // It sits with the other things the agent does not do here.
    expect(instructions.indexOf("each other's data")).toBeGreaterThan(instructions.indexOf('## What you do not do here'));
    expect(instructions.indexOf("each other's data")).toBeLessThan(instructions.indexOf('## Talking about it'));
  });

  it('says it in the user’s words — no grant, reader, scope or log', () => {
    expect(paragraphs.join(' ').match(INTERNAL_NOUNS)?.[0]).toBeUndefined();
  });
});

describe('AC24 retrieval delivery — build-time queries reach the teaching', () => {
  it('"read another app\'s data" ranks the file FIRST', () => {
    const [top] = searchKnowledge("read another app's data");
    expect(top?.file, `top hit: ${top?.file}#${top?.heading}`).toBe(KB_FILE);
  });

  const queries = [
    'app that reads data from another app',
    'access another app tables query',
    'ask the user for access to another app',
    'access-request access-changed',
  ];
  for (const query of queries) {
    it(`"${query}" returns the access file in the top 5`, () => {
      const hits = searchKnowledge(query).slice(0, 5);
      expect(
        hits.some((hit) => hit.file === KB_FILE),
        `top-5 for "${query}": ${hits.map((h) => `${h.file}#${h.heading}`).join(' | ')}`,
      ).toBe(true);
    });
  }

  it('does NOT displace the sections that own the SDK call, the template or the app database', () => {
    expect(searchKnowledge('sendMessage').slice(0, 2).map((hit) => hit.file)).not.toContain(KB_FILE);
    expect(searchKnowledge('mandatory html template').slice(0, 1).map((hit) => hit.file)).not.toContain(KB_FILE);
    expect(searchKnowledge('persistence sql schema').slice(0, 1).map((hit) => hit.file)).not.toContain(KB_FILE);
  });
});
