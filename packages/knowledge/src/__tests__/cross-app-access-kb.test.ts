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
//
// TASK-20261010-host-broker PR-5 (AC39; D-PR5-2): KB 87's new section on the access declaration
// (the meta after the viewport, before any script or style, single-quoted, parsed by the protocol's
// own schema; declare AND ask; never a bundle field), the falsified sentences gone from 87, 00-summary,
// the skill and instructions.md, KB 85's fetch-first sentence, and KB 20's fence unchanged. The
// heading-tree pin is AMENDED (the one new heading set aside; every old one still pinned in order).
//
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-4, D-PR6-6; AC40f): the cross-app HELPER and its
// second `message` listener are RETIRED — section 7 of the copy-exactly hooks block (`useSnugAccess()`,
// over section 6's `onHostEvent`) is the one way an app reads another app. So: "## The Cross-App
// Helper (copy beside the hooks block)" becomes "## The Access Hook" with ONE javascript fence (the
// usage); the helper rows are RE-HOMED on the embedded file (`packages/sdk/embedded/snug-hooks.js`) —
// the guards' messages still read from `packages/sdk/src/bridge.ts`; `data-changed` is taught as
// `{ table }` or `{}`; and the PR-5 pin that KB 20's fence is UNCHANGED is INVERTED: it carries
// sections 6 and 7 now.
import { createHash } from 'node:crypto';
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
  ACCESS_READ_EVENT,
  ACCESS_REQUEST_MIN_GAP_MS,
  ACCESS_SOURCE_CHANGED_EVENT,
  ACCESS_SQL_MAX_CHARS,
  ACCESS_TIMEOUT_STRIKES,
  ACCESS_WANTS_MAX_BYTES,
  ACCESS_WRITE_MAX_ROWS,
  DATA_CHANGED_EVENT,
  FRAME_TYPES,
  PROTOCOL_VERSION,
  accessWantsSchema,
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
/** The copy-exactly hooks block every app carries (PR-6: sections 1–7) — the form the KB teaches. */
const EMBEDDED_HOOKS = readFileSync(path.join(repoRoot, 'packages', 'sdk', 'embedded', 'snug-hooks.js'), 'utf8');

/**
 * One numbered section of the embedded hooks block: from the `// ====` line above `// <n>.` to the
 * line before the `// ====` line above the next numbered banner (or the end of the file).
 * `undefined` while the section does not exist — a red row, never a thrown suite.
 */
function embeddedSection(n: number): string | undefined {
  const lines = EMBEDDED_HOOKS.split('\n');
  const at = lines.findIndex((line) => line.trim().startsWith(`// ${n}. `));
  if (at < 1) return undefined;
  const next = lines.findIndex((line, i) => i > at && /^\s*\/\/ \d+\. /.test(line));
  return lines.slice(at - 1, next === -1 ? undefined : next - 1).join('\n');
}

/**
 * The text of every call to `callee` in `code`, from the callee to its balancing `)`. The fences
 * carry no unbalanced parenthesis inside a string, so a paren count is enough here.
 */
function callBlocks(code: string, callee: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  for (const match of code.matchAll(new RegExp(`(?<![\\w.])${callee}\\(`, 'g'))) {
    const start = match.index as number;
    let depth = 0;
    let end = start + callee.length;
    for (; end < code.length; end += 1) {
      if (code[end] === '(') depth += 1;
      else if (code[end] === ')' && --depth === 0) break;
    }
    out.push({ index: start, text: code.slice(start, end + 1) });
  }
  return out;
}

/** The Snug names a page teaches — the hooks and the helpers an app calls — never React's own hooks. */
const SNUG_NAMES = /\b(use(?:Snug\w*|PersistedState|AppDB|ConnectedFetch|HostEvents)|proposeSchedule|scheduleInputKey|onHostEvent)\b/g;

/** The retired PR-5 snippet's top-level names (anchor 6): no page may teach them as code to copy. */
const RETIRED_HELPER_NAMES = ['snugAccessRequest', 'onAccessChanged', 'onAccessSourceChanged', 'onAccessRead'] as const;

/** PR-6 (D-PR6-6): the one migration sentence, verbatim. */
const ACCESS_MIGRATION =
  'An app that still carries the older access helper and its listener: delete them, `SNUG_ACCESS_PENDING` included, when you copy sections 6–7.';

/** PR-6 (D-PR6-6): the hook's heading, in place of "## The Cross-App Helper (copy beside the hooks block)". */
const HOOK_HEADING = '## The Access Hook';

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

/** TASK-20261010-host-broker PR-5 (AC39, D-PR5-2): the one section KB 87 gains. */
const PR5_HEADING = '## Saying what your app would like to read';

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

  it('the heading tree is pinned — these are the retrieval keys (PR-3: "Four Ops" → "Seven Ops", moved together with the frames-table section key; PR-6: "## The Access Hook")', () => {
    const doc = getKnowledgeBase().find((entry) => entry.file === KB_FILE)!;
    // AMENDED — AC39 (D-PR5-2): KB 87 gains ONE section, "## Saying what your app would like to read"
    // (its place is the KB lane's; its presence, once, is pinned in the PR-5 block below). Every
    // heading that was here stays pinned, in order — only the new one is set aside for this check.
    expect(doc.headingTree.filter((heading) => heading !== PR5_HEADING)).toEqual([
      '# Access Between Apps',
      "## Read Another App's Data Only With the User's Say",
      '## Ask After a User Act, Never on Load',
      '## The Two Frames and Their Seven Ops',
      '## What Your App Learns',
      '## Query: One Read-Only SELECT',
      '## When It Stops, Pauses or Ends',
      '## What Each Refusal Means',
      // PR-6 (D-PR6-6): "## The Cross-App Helper (copy beside the hooks block)" → the hook.
      HOOK_HEADING,
      '## Your App Need Not Read Another App Itself',
      '## Rules for Reading Another App',
    ]);
  });

  it('TASK-20261010-host-broker PR-2 (ADR-0076 §1–§3): the page says the chat beside the app and a scheduled question to its AI read what the user allowed, with no code in the app, and that the other app’s history shows it as the app’s read', () => {
    const text = rendered(KB_FILE);
    expect(text).toContain("The runner's own AI beside your app");
    expect(text).toContain('none of it reaches your app\'s frame');
    expect(text).toContain('A scheduled *ask <app>\'s AI* question sees the same');
    expect(text).toContain("history shows every such read as YOUR app's read");
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
    // PR-6: `{{protocolVersion}}` is no longer pinned here — the only place 87 used it was the retired
    // helper listener's `data.v !==` guard (D-PR6-6); the bridge's guard is section 1's now.
    for (const literal of Object.values(FRAME_TYPES)) expect(text, `source retypes ${literal}`).not.toContain(literal);
  });

  // ---- PR-6: the helper rows RE-HOMED on the embedded file (sections 1 and 7) -------------------
  it('PR-6: section 7 posts the real request frame through SnugBridge.post with a fresh requestId, and section 1 settles each requestId once', () => {
    const seven = embeddedSection(7);
    expect(seven, 'the embedded hooks block has a section 7').toBeDefined();
    const code = seven as string;
    expect(code).toContain('function snugAccessCall(fields, settle)');
    expect(code).toContain('const requestId = crypto.randomUUID();');
    expect(code).toContain(`SnugBridge.post({ type: '${FRAME_TYPES.accessRequest}', requestId, ...fields });`);
    // requestId → settle, deleted on the one terminal answer (section 1's arm), and on a failed post.
    expect(code).toContain('SnugBridge.accessPending.set(requestId,');
    const one = embeddedSection(1) ?? '';
    expect(one).toContain('const settle = SnugBridge.accessPending.get(data.requestId);');
    expect(one).toContain('SnugBridge.accessPending.delete(data.requestId);');
    expect(one.indexOf('SnugBridge.accessPending.delete(data.requestId);'), 'deleted BEFORE it is settled — terminal once').toBeLessThan(one.indexOf('settle(data);'));
    // No plumbing of its own: the bridge's post, never a hand-rolled postMessage.
    expect(code).not.toContain('postMessage(');
  });

  it('PR-6: section 1 accepts a frame only from the parent window at the wire version, settles the real response type, and section 7 hears the event the SDK subscribes with — ids only', () => {
    const one = embeddedSection(1) ?? '';
    expect(one).toContain(`if (event.source !== window.parent || !data || data.v !== ${PROTOCOL_VERSION}) return;`);
    expect(one).toContain(`if (data.type === '${FRAME_TYPES.accessResponse}') {`);
    const seven = embeddedSection(7) ?? '';
    expect(seven).toContain(`onChange: snugGrantHint('${ACCESS_CHANGED_EVENT}')`);
    // The SDK's onChange subscribes with the same constant — through grantHint — so the block and the module hear the same event.
    expect(SDK_ACCESS_SOURCE).toContain('onChange: grantHint(ACCESS_CHANGED_EVENT)');
    // …and grantHint subscribes through the bridge's onHostEvent with the event it was handed (the one place).
    expect(SDK_ACCESS_SOURCE).toContain('onHostEvent(event,');
    // ids only: the hint carries a grantId and the hook hands the listener nothing else.
    expect(seven).toContain("typeof data.grantId === 'string' && data.grantId !== ''");
    expect(seven).toContain('listener({ grantId: data.grantId })');
  });

  it('answers the SDK’s two guard results with nothing posted: HOST_ERROR before host-ready (retryable) and without capabilities.access (not retryable) — PR-6: in section 7', () => {
    const seven = embeddedSection(7) ?? '';
    expect(SDK_GUARD_MESSAGES.notReady.retryable).toBe(true);
    expect(SDK_GUARD_MESSAGES.noCapability.retryable).toBe(false);
    expect(seven).toContain(
      `if (!SnugBridge.ready) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: '${SDK_GUARD_MESSAGES.notReady.message}', retryable: true } });`,
    );
    expect(seven).toContain(
      `if (SnugBridge.capabilities.access !== true) return Promise.resolve({ ok: false, error: { code: 'HOST_ERROR', message: '${SDK_GUARD_MESSAGES.noCapability.message}', retryable: false } });`,
    );
    // Both guards come before the post: nothing is posted, nothing is pending.
    expect(seven.indexOf('if (!SnugBridge.ready)')).toBeLessThan(seven.indexOf('SnugBridge.post('));
    expect(seven.indexOf('if (SnugBridge.capabilities.access !== true)')).toBeLessThan(seven.indexOf('SnugBridge.accessPending.set('));
  });

  // ---- PR-6: the ONE fence — the usage of the hook ----------------------------------------------
  it('PR-6: the usage is `const access = useSnugAccess()` in the component — the granted view named `grant`, never `access`', () => {
    const [usage] = fencedJs(rendered(KB_FILE));
    expect(usage).toBeDefined();
    const code = usage as string;
    expect(code).toContain('const access = useSnugAccess();');
    const accessDeclarations = [...code.matchAll(/\b(?:const|let|var)\s+access\b[^\n]*/g)].map((m) => m[0]);
    expect(accessDeclarations, 'access names the hook and nothing else').toEqual(['const access = useSnugAccess();']);
    expect(code, 'the granted view is named grant').toMatch(/\b(?:const|let)\s+(?:\[\s*)?grant\b/);
    expect(code).toMatch(/\.grant\b/);
    // NEGATIVE: the retired helper is not taught here.
    for (const name of RETIRED_HELPER_NAMES) expect(code, name).not.toContain(name);
    expect(code).not.toContain('SNUG_ACCESS_PENDING');
    expect(code).not.toContain("addEventListener('message'");
    expect(code).not.toContain('SnugBridge');
  });

  it('PR-6: access.request from a user act with a purpose and hints, never in an effect; then access.query with bound params by grant.id', () => {
    const code = fencedJs(rendered(KB_FILE))[0] ?? '';
    const requests = callBlocks(code, 'access.request');
    expect(requests.length, 'one ask').toBeGreaterThanOrEqual(1);
    expect(requests[0]?.text, 'the purpose is one plain line').toMatch(/^access\.request\(\s*'[^']{1,200}'/);
    expect(code).toMatch(/hints: \{ words: \[[^\]]+\], tables: \[[^\]]+\] \}/);
    for (const effect of callBlocks(code, 'useEffect')) expect(effect.text, 'never asks from an effect').not.toContain('access.request(');
    expect(code).toMatch(/\bon[A-Z]\w*Click\b/); // a click handler — never on load
    expect(code).toMatch(/access\.query\(\s*grant\.id,\s*'SELECT [^']*\?[^']*',\s*\[/);
    expect(code).not.toMatch(/setTimeout|setInterval/);
  });

  it('PR-6: access.write and access.refresh sit behind their flags — a table’s `write`, the view’s `refresh`', () => {
    const code = fencedJs(rendered(KB_FILE))[0] ?? '';
    expect(code).toMatch(/access\.write\(\s*grant\.id,/);
    expect(code).toMatch(/access\.refresh\(\s*grant\.id\s*\)/);
    expect(code, 'a table’s write flag is read').toMatch(/\.write(?!\s*\()\b/);
    expect(code, 'the view’s refresh flag is read').toMatch(/grant\.refresh(?!\s*\()\b/);
    for (const effect of callBlocks(code, 'useEffect')) {
      expect(effect.text).not.toContain('access.write(');
      expect(effect.text).not.toContain('access.refresh(');
    }
  });

  it('PR-6: the four on* subscriptions live in ONE useEffect whose deps list the useCallbacks it calls, and it returns their unsubscribes', () => {
    const code = fencedJs(rendered(KB_FILE))[0] ?? '';
    const subscriptions = ['access.onChange(', 'access.onSourceChanged(', 'access.onDataChanged(', 'access.onRead('];
    const effects = callBlocks(code, 'useEffect').filter((effect) => subscriptions.some((s) => effect.text.includes(s)));
    expect(effects, 'one effect subscribes').toHaveLength(1);
    const effect = effects[0]?.text ?? '';
    for (const subscription of subscriptions) expect(effect, subscription).toContain(subscription);
    // Each subscription's unsubscribe is kept — never a bare statement (whatever precedes the call is
    // an assignment, an array or an argument, not the end of a statement) — and the effect returns a cleanup.
    const effectCode = effect.replace(/\/\/[^\n]*/g, ''); // line comments out — they are words, not statements
    for (const subscription of subscriptions) {
      const at = effectCode.indexOf(subscription);
      const before = effectCode.slice(0, at).trimEnd();
      expect(before.slice(-1), `${subscription}'s unsubscribe is kept`).not.toMatch(/[;{}]/);
    }
    expect(effect).toMatch(/return \(\) =>/);
    // The deps list the useCallbacks the effect calls.
    const deps = /\],?\s*\)$/.test(effect) ? (/\[([^[\]]*)\]\s*\)$/.exec(effect)?.[1] ?? '') : '';
    const callbacks = [...code.matchAll(/const (\w+) = useCallback\(/g)].map((m) => m[1] as string).filter((name) => new RegExp(`\\b${name}\\b`).test(effect.replace(/\[[^[\]]*\]\s*\)$/, '')));
    expect(callbacks.length, 'the effect calls at least one useCallback').toBeGreaterThan(0);
    for (const name of callbacks) expect(deps, `the deps list ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    // The hint names belong to the hook, never the usage — and never useHostEvents.
    for (const event of [ACCESS_CHANGED_EVENT, ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT]) expect(code, event).not.toContain(`'${event}'`);
    expect(code).not.toContain('useHostEvents');
  });

  it('teaches the seven ops of the request — ACCESS_OPS exactly — in the frames table (PR-3: the section is "…Seven Ops", moved with the heading tree)', () => {
    const table = section(rendered(KB_FILE), '## The Two Frames and Their Seven Ops');
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

  it('teaches the access-changed hint as ids only and the re-list, and names the hook’s eleven methods (PR-3: SnugAccess has eleven methods; PR-6: named in "## The Access Hook")', () => {
    const changes = prose(section(rendered(KB_FILE), '## When It Stops, Pauses or Ends'));
    expect(changes).toContain(`\`event: '${ACCESS_CHANGED_EVENT}'\``);
    expect(changes).toContain('`data: { grantId }` — ids only');
    expect(changes).toContain('re-`list`');
    // W6 finding 36 — the engine never rings on expiry (spec §23.3): the page must not promise it.
    expect(changes).toContain('An expiry is not announced');
    expect(changes).toContain('`ACCESS_EXPIRED`');
    // PR-6: re-homed from the retired helper section on the hook's section (W6 finding 36 — the
    // onChange hint means stopped or paused; an expiry is never announced).
    const hookCode = section(rendered(KB_FILE), HOOK_HEADING);
    expect(hookCode).toContain('an access was stopped or paused');
    expect(hookCode).not.toMatch(/ran out/);
    expect(SDK_INDEX_SOURCE).toMatch(/export \{[^}]*\buseSnugAccess\b[^}]*\} from '\.\/access\.js'/);
    const hook = prose(section(rendered(KB_FILE), HOOK_HEADING));
    // PR-6 (D-PR6-6, :346-352): the module sentence as the contract words it.
    expect(hook).toContain("the hook's eleven methods (typed in `@snugprotocol/sdk`):");
    for (const method of SDK_ACCESS_METHODS) expect(hook, `SnugAccess.${method}`).toContain(`\`${method}(`);
    expect(SDK_ACCESS_METHODS.sort()).toEqual(
      ['discover', 'list', 'onChange', 'onDataChanged', 'onRead', 'onSourceChanged', 'query', 'refresh', 'release', 'request', 'write'],
    );
  });
});

// TASK-20261010-host-broker PR-3 (AC27; spec 1.2, ADR-0076 §4–§8; D-PR3-5, DS10/DS11): KB 87 v2
// teaches the three new ops, the write rule and the 1.1-host fallback, and its helper hears the
// three new hints. The content-sync pins read the protocol's constants, never retyped values.
describe('PR-3 — KB 87 v2: write, refresh, discover, the three hints, the fallback', () => {
  it('the refusal table lists the fifteen codes — ACCESS_WRITE_REFUSED, ACCESS_BUSY and ACCESS_REFRESH_FAILED among them', () => {
    const table = section(rendered(KB_FILE), '## What Each Refusal Means');
    const codes = [...table.slice(table.indexOf('|---|')).matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
    expect(codes).toHaveLength(15);
    for (const code of ['ACCESS_WRITE_REFUSED', 'ACCESS_BUSY', 'ACCESS_REFRESH_FAILED']) expect(codes, code).toContain(code);
  });

  it('the frames table lists the seven ops in ACCESS_OPS order, write, refresh and discover in their places', () => {
    const table = section(rendered(KB_FILE), '## The Two Frames and Their Seven Ops');
    const ops = [...table.slice(table.indexOf('|---|')).matchAll(/^\| `(\w+)` \|/gm)].map((m) => m[1]);
    expect(ops).toEqual(['request', 'query', 'write', 'refresh', 'list', 'release', 'discover']);
  });

  it('states the MALFORMED fallback: a 1.1 runner answers the new ops — and an ask carrying access — MALFORMED (D-PR3-5)', () => {
    expect(prose(rendered(KB_FILE))).toContain(
      '`MALFORMED` answer to `write`, `refresh` or `discover`, or to an ask that carried `access`, means the runner predates 1.2 — show the honest fallback, and ask again without `access`',
    );
  });

  it('states the write rule among the rules, bounded by ACCESS_WRITE_MAX_ROWS — and no longer says "read, never write"', () => {
    const rules = prose(section(rendered(KB_FILE), '## Rules for Reading Another App'));
    expect(ACCESS_WRITE_MAX_ROWS).toBe(200);
    expect(rules).toContain(
      `**Write only what the user allowed.** A table is writable only when its view says \`write: true\`; one plain INSERT/UPDATE/DELETE with literal values, at most ${ACCESS_WRITE_MAX_ROWS} rows at a time, every change undoable by the user from the other app's access`,
    );
    expect(rules).not.toContain('**Read, never write.**');
  });

  // PR-6 (D-PR6-6; AC40f) INVERTS PR-3's "exactly two fences: the helper, then the usage": the helper
  // is retired, and the page keeps ONE javascript fence — the usage of the hook, under its heading.
  it('PR-6: the page keeps exactly ONE javascript fence — the usage of useSnugAccess(), under "## The Access Hook"', () => {
    const fences = fencedJs(rendered(KB_FILE));
    expect(fences).toHaveLength(1);
    expect(fences[0]).toContain('useSnugAccess()');
    expect(fences[0]).not.toContain('function snugAccessRequest(op, fields)');
    expect(fencedJs(section(rendered(KB_FILE), HOOK_HEADING))).toHaveLength(1);
  });

  it('PR-6: section 7 hears the three new hints by name — access-source-changed, data-changed and access-read, the event names the SDK subscribes with (re-homed from the retired helper)', () => {
    const seven = embeddedSection(7) ?? '';
    const [usage] = fencedJs(rendered(KB_FILE));
    expect([ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT]).toEqual(['access-source-changed', 'data-changed', 'access-read']);
    expect(seven).toContain(`onSourceChanged: snugGrantHint('${ACCESS_SOURCE_CHANGED_EVENT}')`);
    expect(seven).toContain(`return onHostEvent('${DATA_CHANGED_EVENT}',`);
    expect(seven).toContain(`onRead: snugGrantHint('${ACCESS_READ_EVENT}')`);
    for (const event of [ACCESS_SOURCE_CHANGED_EVENT, DATA_CHANGED_EVENT, ACCESS_READ_EVENT]) {
      expect(usage ?? '', `${event} belongs to the hook, not the usage`).not.toContain(`'${event}'`);
    }
    // The 1.1 hint stays (pinned above), and the SDK subscribes to the same three constants:
    // the two { grantId } hints through grantHint (which calls onHostEvent(event, …), pinned above);
    // data-changed directly, since its listener reads the data shape, not a grantId (SEC-5).
    expect(seven).toContain(`onChange: snugGrantHint('${ACCESS_CHANGED_EVENT}')`);
    const sdkSubscriptions: ReadonlyArray<readonly [string, string]> = [
      ['ACCESS_SOURCE_CHANGED_EVENT', 'onSourceChanged: grantHint(ACCESS_SOURCE_CHANGED_EVENT)'],
      ['DATA_CHANGED_EVENT', 'onHostEvent(DATA_CHANGED_EVENT,'],
      ['ACCESS_READ_EVENT', 'onRead: grantHint(ACCESS_READ_EVENT)'],
    ];
    for (const [constant, subscription] of sdkSubscriptions) {
      expect(SDK_ACCESS_SOURCE, constant).toContain(subscription);
    }
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

  it('PR-3: 00-summary\'s one clause gains "or change, when you allowed it" — still ONE clause about another app\'s data', () => {
    const summary = prose(getKnowledgeSummary());
    expect(summary).toContain('or change, when you allowed it');
    expect(summary.match(/another app's data/g)).toHaveLength(1);
    expect(summary.match(/or change, when you allowed it/g)).toHaveLength(1);
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

  // TASK-20261010-host-broker PR-3 (I-W; D-PR3-4/23): access may now CHANGE the other app's rows when
  // the user ticks it — the skill's section says so in ONE clause, the contract's words verbatim.
  it('PR-3: the *Access between apps* section says an app may also change the other app’s data — "— or change it, when the user ticked that" — once', () => {
    const skill = source(SKILL_FILE);
    const access = prose(skill.split('## Access between apps')[1]?.split('## Schedules')[0] ?? '');
    expect(access.split('— or change it, when the user ticked that').length - 1).toBe(1);
    // The clause rides the user's words: still nothing the user did not allow, still never on load.
    expect(access).toMatch(/^ ?The user allows access between apps; an app never takes it, and neither do you\./);
    expect(access).toMatch(/never on load/);
    expect(access.match(INTERNAL_NOUNS)?.[0]).toBeUndefined();
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

  // TASK-20261010-host-broker PR-3 (I-W): the same one paragraph says access may also change the other
  // app's data when the user ticked that — the contract's clause verbatim, once.
  it('PR-3: the one paragraph adds "— or change it, when the user ticked that" — and is still the one paragraph', () => {
    expect(paragraphs).toHaveLength(1);
    const [paragraph] = paragraphs as [string];
    expect(paragraph.split('— or change it, when the user ticked that').length - 1).toBe(1);
    expect(paragraph).toContain("You never allow it on the user's behalf");
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

// =========================================================================================
// TASK-20261010-host-broker PR-5 — AC39 (contract v2 D-PR5-2, D-PR5-3, D-PR5-11, D-PR5-19)
//
// KB 87 gains ONE section, "## Saying what your app would like to read": the access DECLARATION —
// a `<meta name="snug:access-wants" content='[…]'>` in the head, RIGHT AFTER the viewport meta and
// BEFORE any `<script>`/`<style>` (the host's small grammar stops scanning at the first of those),
// its content single-quoted JSON of 1..4 `{purpose, hints?}` — which the host derives from the app's
// own HTML at every admission and shows before the app ever asks; it is never a bundle field, and
// declaring is not asking: the app still ASKS at runtime, after a user act. The sentences PR-5
// falsifies go: KB 87's "does not change the other app" (the chat may now propose a change the
// user applies), 00-summary's chat clause (:12), the skill's chat sentence (:132-146), and
// instructions.md's "asks for it itself, at runtime" (:42-45). KB 85 says the scheduler may fetch
// new data first. KB 20's template fence is UNCHANGED (it sits in the inline core's byte budget —
// the declaration is taught in 87, retrieved, never inlined).
// =========================================================================================

/**
 * The KB 87 example's purpose — the one the consent sheet's declared says-line is pinned with (D4).
 * G5-16 (ii-3): the example now CARRIES an apostrophe, written `&apos;` inside the single-quoted
 * content, so the trap it teaches is in the example itself (was 'to show spending by category').
 */
const KB_EXAMPLE_PURPOSE = "to show this month's spending by category";
/** sha256 of KB 20's ```html fence as of PR-4's merge (main @ a133978) — unchanged by PR-5. */
const KB20_FENCE_SHA256 = '1cb4a5028c11c965e797cb1ecf19b4791dc6edf8c8ddd3a536b03b76a647840f';

/** The five entities the host's grammar decodes — and no other. */
const decodeEntities = (text: string): string =>
  text.replace(/&(quot|apos|lt|gt|amp);/g, (_m, name: string) => ({ quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' })[name] as string);

describe('PR-5 — KB 87’s section "Saying what your app would like to read" (AC39; D-PR5-2)', () => {
  it('the section exists, once, in the rendered heading tree', () => {
    const doc = getKnowledgeBase().find((entry) => entry.file === KB_FILE)!;
    expect(doc.headingTree.filter((heading) => heading === PR5_HEADING)).toHaveLength(1);
  });

  it('its html example puts the meta RIGHT AFTER the viewport meta and BEFORE any <script> or <style>', () => {
    const text = section(source(KB_FILE), PR5_HEADING);
    const fence = /```html\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1];
    expect(fence, 'an html fence in the section').toBeDefined();
    const lines = fence!.split(/\r?\n/).filter((line) => line.trim() !== '');
    const viewport = lines.findIndex((line) => /<meta\s+name="viewport"/i.test(line));
    const meta = lines.findIndex((line) => /<meta\s+name=["']snug:access-wants["']/i.test(line));
    expect(viewport, 'the viewport meta').toBeGreaterThanOrEqual(0);
    expect(meta, 'the access-wants meta').toBe(viewport + 1);
    const before = lines.slice(0, meta).join('\n');
    expect(before).not.toMatch(/<script|<style/i);
    expect(lines.filter((line) => /snug:access-wants/.test(line))).toHaveLength(1);
  });

  it('the content attribute is SINGLE-quoted JSON that parses under the protocol’s own schema — the example purpose is KB_EXAMPLE_PURPOSE (G5-16 ii-3: it carries an apostrophe)', () => {
    const text = section(source(KB_FILE), PR5_HEADING);
    const fence = /```html\r?\n([\s\S]*?)\r?\n```/.exec(text)?.[1] ?? '';
    const metaLine = fence.split(/\r?\n/).find((line) => /snug:access-wants/.test(line)) ?? '';
    const content = /\bcontent='([^']*)'/.exec(metaLine)?.[1];
    expect(content, 'content is single-quoted').toBeDefined();
    const parsed = accessWantsSchema.safeParse(JSON.parse(decodeEntities(content!)));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
    const wants = parsed.success ? parsed.data : [];
    expect(wants[0]?.purpose).toBe(KB_EXAMPLE_PURPOSE);
    expect(wants[0]?.hints?.tables?.length ?? 0, 'the example names a table (a pair needs a table-tier match)').toBeGreaterThan(0);
    expect(JSON.stringify(wants).length).toBeLessThanOrEqual(ACCESS_WANTS_MAX_BYTES);
  });

  it('declare AND ask: the section says the app still asks at runtime, after a user act — declaring allows nothing', () => {
    const words = prose(wordsOnly(section(rendered(KB_FILE), PR5_HEADING)));
    expect(words).toMatch(/\bask/i);
    expect(words).toMatch(/user act|after the user|the user (has )?done/i);
    expect(words).toMatch(/(nothing|never)[^.]*(allow|read|grant)/i);
  });

  it('never a bundle field: the section says the declaration lives in the app’s HTML, not in the bundle', () => {
    const words = prose(section(rendered(KB_FILE), PR5_HEADING));
    expect(words).toMatch(/(never|not)[^.]*\bbundle\b|\bbundle\b[^.]*(never|not)/i);
  });

  it('says *access* and never grant, reader, scope or log in its prose (AC17’s vocabulary)', () => {
    const words = wordsOnly(section(rendered(KB_FILE), PR5_HEADING));
    expect(words.match(INTERNAL_NOUNS)?.[0]).toBeUndefined();
  });

  it('retrieval: "declare what my app would like to read" reaches THIS section of KB 87 in the top 3', () => {
    const hits = searchKnowledge('declare what my app would like to read snug:access-wants').slice(0, 3);
    expect(
      hits.some((hit) => hit.file === KB_FILE && /would like to read/i.test(hit.heading)),
      hits.map((h) => `${h.file}#${h.heading}`).join(' | '),
    ).toBe(true);
  });
});

describe('PR-5 — the sentences PR-5 falsifies are gone (AC39; AC39e grep)', () => {
  it('KB 87 no longer says the chat "does not change the other app"', () => {
    expect(prose(source(KB_FILE))).not.toContain('does not change the other app');
    expect(prose(rendered(KB_FILE))).not.toContain('does not change the other app');
  });

  it('KB 87’s chat section now says the chat may propose a change the user applies', () => {
    const words = prose(section(rendered(KB_FILE), '## Your App Need Not Read Another App Itself'));
    expect(words).toMatch(/chang/i);
    expect(words).toMatch(/appl(y|ies)/i);
  });

  it('00-summary (:12): the chat clause no longer says the chat only SEES what the user allowed — it may propose a change too; still ONE clause about another app’s data', () => {
    const summary = prose(getKnowledgeSummary());
    const chat = /the chat beside an app[^)]*\)/.exec(summary)?.[0] ?? '';
    expect(chat, 'the chat clause').not.toBe('');
    expect(chat).toMatch(/chang/i);
    expect(summary.match(/another app's data/g)).toHaveLength(1);
  });

  it('SKILL (:132-146): the chat sentence says it may propose a change, and the section names the declaration meta', () => {
    const skill = source(SKILL_FILE);
    const access = prose(skill.split('## Access between apps')[1]?.split('## Schedules')[0] ?? '');
    const chat = /The chat beside an app[^.]*\./.exec(access)?.[0] ?? '';
    expect(chat, 'the chat sentence').not.toBe('');
    expect(chat).toMatch(/chang/i);
    expect(access).toContain('snug:access-wants');
    // Still the user's: never on load, and the opening sentence unchanged.
    expect(access).toMatch(/^ ?The user allows access between apps; an app never takes it, and neither do you\./);
    expect(access).toMatch(/never on load/);
  });

  it('instructions.md (:42-45): "asks for it itself, at runtime" is amended — and it is still the ONE paragraph with its pins', () => {
    const instructions = readFileSync(path.join(repoRoot, 'apps', 'host-mcp', 'src', 'instructions.md'), 'utf8');
    const paragraphs = instructions.split(/\n(?=- |\n|#)/).map(prose).filter((p) => /each other's data/.test(p));
    expect(paragraphs).toHaveLength(1);
    const [paragraph] = paragraphs as [string];
    expect(paragraph).not.toContain('asks for it itself, at runtime');
    expect(paragraph).toContain("You never allow it on the user's behalf");
    expect(paragraph).toContain('after the user has done something that needs it');
    expect(paragraph.match(INTERNAL_NOUNS)?.[0]).toBeUndefined();
  });
});

describe('PR-5 — KB 85 and KB 20 (AC39; D-PR5-19)', () => {
  it('KB 85 says a scheduled step may fetch new data first — from the apps it may read while the user is away', () => {
    const words = prose(rendered('knowledge-base/app-authoring/85-scheduled-runs.md'));
    expect(words).toMatch(/fetch new data first/i);
  });

  // PR-6 (D-PR6-6; AC40f) INVERTS this row: KB 20's fence carries sections 6 and 7 now — the hooks
  // block grew, the declaration is STILL taught in 87 and never in the template.
  it('PR-6: KB 20’s fence carries sections 6 and 7 (the banners, the names), the authored banners renumbered 8 and 9 — and still no declaration meta', () => {
    const text = source('knowledge-base/app-authoring/20-html-template.md');
    const fences = [...text.matchAll(/```html\r?\n([\s\S]*?)\r?\n```/g)].map((m) => m[1] as string);
    expect(fences).toHaveLength(1);
    expect(createHash('sha256').update(fences[0]!, 'utf8').digest('hex'), 'the fence changed from PR-5’s').not.toBe(KB20_FENCE_SHA256);
    expect(fences[0]).not.toContain('snug:access-wants');
    const renderedFence = /```html\r?\n([\s\S]*?)\r?\n```/.exec(rendered('knowledge-base/app-authoring/20-html-template.md'))?.[1] ?? '';
    const banners = renderedFence.split('\n').map((line) => line.trim()).filter((line) => /^\/\/ \d+\. /.test(line));
    expect(banners[5]).toBe('// 6. useHostEvents + useSnugSchedule (copy exactly when the app listens to the host or takes part in schedules; omit otherwise)');
    expect(banners[6]).toBe("// 7. useSnugAccess (copy exactly, WITH section 6, when the app reads or changes another app's data; omit otherwise)");
    expect(banners[7]).toMatch(/^\/\/ 8\. RESPONSE SCHEMA/);
    expect(banners[8]).toMatch(/^\/\/ 9\. YOUR APP/);
    expect(banners).toHaveLength(9);
    for (const name of ['onHostEvent', 'useHostEvents', 'useSnugSchedule', 'proposeSchedule', 'scheduleInputKey', 'snugAccessCall', 'useSnugAccess']) {
      expect(renderedFence, name).toContain(`function ${name}(`);
    }
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-5 — Gate-5 fold G5-16 (ii-3, ii-11): what KB 87 and the skill
// teach about the declaration's TEXT.
//
//  ii-3  The content is single-quoted, so an ASCII apostrophe inside the purpose ends the value and
//        the meta silently becomes no declaration ("to show this month's spending" → undefined). KB 87
//        says, in ONE sentence, that an apostrophe is written `&apos;` (or ’), the KB example carries
//        one (pinned above through KB_EXAMPLE_PURPOSE), and SKILL's mention says the same.
//  ii-11 The declined-ask carry keys on the HINTS (`accessRequestHash` never hashes the purpose), so
//        "declare AND ask, with the same purpose words" sends an author to the wrong half: the KB says
//        "declare AND ask, with the same purpose and the same hints".
// =========================================================================================

/** G5-16 (ii-3): the one sentence KB 87's section gains — the lane writes it as is. */
const APOSTROPHE_SENTENCE =
  "An apostrophe inside the content is written `&apos;` (or ’): a plain `'` would end the single-quoted value, and the meta would be no declaration.";

describe('G5-16 (ii-3) — an apostrophe in the purpose is written &apos; (or ’)', () => {
  it('G5-16 (ii-3) KB 87’s section says it, in one sentence', () => {
    expect(prose(section(source(KB_FILE), PR5_HEADING))).toContain(prose(APOSTROPHE_SENTENCE));
    expect(prose(section(rendered(KB_FILE), PR5_HEADING))).toContain(prose(APOSTROPHE_SENTENCE));
  });

  it('G5-16 (ii-3) the KB example writes its apostrophe as &apos; in the meta — never a raw one, which would end the value', () => {
    const fence = /```html\r?\n([\s\S]*?)\r?\n```/.exec(section(source(KB_FILE), PR5_HEADING))?.[1] ?? '';
    const metaLine = fence.split(/\r?\n/).find((line) => /snug:access-wants/.test(line)) ?? '';
    const content = /\bcontent='([^']*)'/.exec(metaLine)?.[1] ?? '';
    expect(content).toContain('&apos;');
    // The value runs to the closing quote of the attribute: nothing of the JSON is left after it.
    expect(metaLine.slice(metaLine.indexOf(content) + content.length)).toMatch(/^'>\s*$/);
    expect(decodeEntities(content)).toContain("month's");
  });

  it('G5-16 (ii-3) SKILL’s mention of the meta says it too', () => {
    const access = prose(source(SKILL_FILE).split('## Access between apps')[1]?.split('## Schedules')[0] ?? '');
    expect(access).toMatch(/apostrophe[^.]*`&apos;` \(or ’\)/);
  });
});

describe('G5-16 (ii-11) — declare AND ask, with the same purpose and the same hints', () => {
  it('G5-16 (ii-11) KB 87 says the hints must match too (the declined ask is recognised by its hints)', () => {
    const words = prose(section(rendered(KB_FILE), PR5_HEADING));
    expect(words).toContain('declare AND ask, with the same purpose and the same hints');
  });

  it('G5-16 (ii-11) the purpose-only sentence is gone', () => {
    expect(prose(source(KB_FILE))).not.toContain('with the same purpose words');
  });
});

// =========================================================================================
// TASK-20261010-host-broker PR-6 (contract v2 D-PR6-4, D-PR6-6; AC40f): KB 87 reads true against
// the access hook. The three "the helper below" lines (:27, :94, :370) say "the access hook";
// `data-changed` is `{ table }` or `{}`; the page never names the retired helper except the ONE
// migration sentence (which names `SNUG_ACCESS_PENDING` so an author can find and delete it); the
// hints are answered through `access.on*`, never `useHostEvents`; KB 10's Section Map names the page.
// =========================================================================================
describe('PR-6 — KB 87 reads true against the access hook (D-PR6-6)', () => {
  it('teaches data-changed as "{ table }, or {} when the host could not name it — re-read everything you show"', () => {
    const stops = prose(section(rendered(KB_FILE), '## When It Stops, Pauses or Ends'));
    expect(stops).toMatch(/`(?:data: )?\{ table \}`, or `(?:data: )?\{\}` when the host could not name it — re-read everything you show/);
    // …and section 7 delivers it: `{}` when the host sent no table (the retired helper DROPPED those).
    const seven = embeddedSection(7) ?? '';
    expect(seven).toContain('if (data.table === undefined) listener({});');
    expect(seven).toContain("else if (typeof data.table === 'string' && data.table !== '') listener({ table: data.table });");
  });

  it('"the helper below" is gone — the three places say "the access hook"', () => {
    const text = rendered(KB_FILE);
    expect(prose(text)).not.toMatch(/helper below/);
    expect(prose(section(text, "## Read Another App's Data Only With the User's Say"))).toContain('the access hook');
    expect(prose(section(text, PR5_HEADING))).toContain('the access hook');
    expect(prose(section(text, '## Your App Need Not Read Another App Itself'))).toContain('the access hook');
  });

  it('carries the migration sentence exactly once, verbatim — the ONLY place the retired names appear', () => {
    const text = prose(rendered(KB_FILE));
    expect(text.split(ACCESS_MIGRATION).length - 1).toBe(1);
    expect(text.split('SNUG_ACCESS_PENDING').length - 1, 'SNUG_ACCESS_PENDING only in the migration sentence').toBe(1);
    for (const name of RETIRED_HELPER_NAMES) {
      expect(text, `${name} is never taught`).not.toContain(name);
      expect(source(KB_FILE), `${name} is not in the source`).not.toContain(name);
    }
    // The page teaches no second listener of its own.
    expect(text).not.toContain("addEventListener('message'");
  });

  it('answers the access hints through access.on*, never useHostEvents — the hook checks their ids', () => {
    expect(prose(rendered(KB_FILE))).toMatch(/[Aa]nswer the access hints through `access\.on\*`, never `useHostEvents` — the hook checks their ids/);
  });

  it('every Snug hook the page names is a function the embedded hooks block defines', () => {
    const names = new Set([...rendered(KB_FILE).matchAll(SNUG_NAMES)].map((m) => m[1] as string));
    expect(names, '87 teaches useSnugAccess').toContain('useSnugAccess');
    for (const name of names) expect(EMBEDDED_HOOKS, `embedded/snug-hooks.js defines ${name}`).toContain(`function ${name}(`);
  });

  it('section 7’s banner says it needs section 6 — the hook calls section 6’s onHostEvent', () => {
    const seven = embeddedSection(7) ?? '';
    expect(seven).toContain("// 7. useSnugAccess (copy exactly, WITH section 6, when the app reads or changes another app's data; omit otherwise)");
    expect(seven).toContain('onHostEvent(');
    expect(embeddedSection(6) ?? '', 'section 6 defines what section 7 calls').toContain('function onHostEvent(event, listener)');
  });

  it('KB 10’s Section Map names "Access Between Apps"', () => {
    expect(rendered('knowledge-base/app-authoring/10-overview-and-contract.md')).toContain('- "Access Between Apps" —');
  });
});
