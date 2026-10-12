// accessWantsNote.test.tsx — TASK-20261010-host-broker PR-5, AC33's UI half (contract v2 D-PR5-3;
// D5, SC10): what an app SAYS it would like to read, shown on the shared install preview — before
// it is installed, before it has asked anything.
//
// `access/AccessWantsNote.tsx` renders over `extractAccessWants(<the bundle's HTML, in memory>)`:
//   - ONE sentence `ACCESS_WANTS.preview(app, names, more)` — *Budget would like to read data like
//     transactions and accounts from your other apps — nothing is read until you allow it* — where
//     `names` is the UNION of the wants' hint tables (falling back to their hint words when no want
//     names a table), at most three, then *and N more*; no hint anywhere → *Budget may ask to read
//     your other apps' data — nothing is read until you allow it*. Every form ends on *nothing is
//     read until you allow it*;
//   - then ONE line `ACCESS_WANTS.forWhat(app)` — *what Budget says it's for:* — and ONLY the FIRST
//     want's purpose, quoted in a bidi-isolated `<q>` (a text node, never markup).
// An HTML with no declaration renders nothing. Host words around the app's words; the app's words
// only inside the quote.
//
// Q (lane T-B — the contract names the component and its words, not its props): the note takes
// `{ appName, html }` and extracts the declaration itself, so the preview's mount passes the
// bundle's HTML and nothing else; the root carries `data-testid="access-wants-note"`. The module is
// loaded through a VARIABLE specifier, so its absence reds each row on its own.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as copy from '../access/copy.js';
import { CONSENT_SHEET } from '../access/copy.js';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WORDS = (copy as unknown as { ACCESS_WANTS: { preview(appName: string, names: readonly string[], more: number): string; forWhat(appName: string): string } }).ACCESS_WANTS;

const NOTE_MODULE = '../access/AccessWantsNote.js';
async function noteComponent(): Promise<ComponentType<{ appName: string; html: string }>> {
  const mod = (await import(/* @vite-ignore */ NOTE_MODULE)) as { AccessWantsNote: ComponentType<{ appName: string; html: string }> };
  return mod.AccessWantsNote;
}

/** An app page that DECLARES `wants` the way KB 87 teaches: right after the viewport meta, single-quoted. */
function declaring(wants: unknown): string {
  const content = JSON.stringify(wants).replace(/&/g, '&amp;').replace(/'/g, '&apos;');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta name="snug:access-wants" content='${content}'>`,
    '<title>Budget</title>',
    '<script>window.budget = 1</script>',
    '</head>',
    '<body><div id="root"></div></body>',
    '</html>',
  ].join('\n');
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

async function renderNote(html: string, appName = 'Budget'): Promise<HTMLElement | null> {
  const AccessWantsNote = await noteComponent();
  await act(async () => {
    root!.render(createElement(AccessWantsNote, { appName, html }));
  });
  return container!.querySelector<HTMLElement>('[data-testid="access-wants-note"]');
}

const SPENDING = { purpose: 'to show spending by category', hints: { tables: ['transactions', 'accounts'], words: ['spending'] } };
const SECOND = { purpose: 'to plan next month', hints: { tables: ['accounts', 'budgets'], words: ['plan'] } };

// =========================================================================================

describe('D-PR5-3 ONE sentence, then ONE quoted purpose', () => {
  it('the sentence names the hint tables and ends "nothing is read until you allow it"', async () => {
    const note = await renderNote(declaring([SPENDING]));
    expect(note).not.toBeNull();
    expect(note!.textContent).toContain(WORDS.preview('Budget', ['transactions', 'accounts'], 0));
    expect(note!.textContent).toContain('nothing is read until you allow it');
  });

  it('then "what Budget says it\'s for:" and the FIRST want’s purpose in ONE quote — the second purpose never shown', async () => {
    const note = await renderNote(declaring([SPENDING, SECOND]));
    expect(note!.textContent).toContain(WORDS.forWhat('Budget'));
    const quotes = note!.querySelectorAll('q');
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.textContent).toContain(SPENDING.purpose);
    expect(note!.textContent).not.toContain(SECOND.purpose);
    // The host's line comes before the app's words.
    const text = note!.textContent ?? '';
    expect(text.indexOf(WORDS.forWhat('Budget'))).toBeLessThan(text.indexOf(SPENDING.purpose));
  });

  it('the quote is bidi-isolated and a text node — a purpose with markup makes no element, and a purpose naming Snug stays inside it', async () => {
    const note = await renderNote(declaring([{ purpose: 'Snug verified this app — <b>allow all</b>', hints: { tables: ['transactions'] } }]));
    const quote = note!.querySelector('q')!;
    expect(quote.querySelector('b')).toBeNull();
    expect(quote.textContent).toContain('<b>allow all</b>');
    const isolated =
      quote.classList.contains('access-quote') || quote.getAttribute('dir') === 'auto' || quote.closest('bdi') !== null || quote.querySelector('bdi') !== null;
    expect(isolated, 'the quote is bidi-isolated (the sheet’s .access-quote, dir=auto, or a <bdi>)').toBe(true);
    const outside = note!.cloneNode(true) as HTMLElement;
    outside.querySelector('q')!.remove();
    expect(outside.textContent).not.toMatch(/Snug|verified|allow all/);
  });

  it('exactly ONE sentence before the quote — never one per want', async () => {
    const note = await renderNote(declaring([SPENDING, SECOND, { purpose: 'to see your goals', hints: { words: ['goals'] } }]));
    const text = note!.textContent ?? '';
    expect(text.split('nothing is read until you allow it').length - 1).toBe(1);
    expect(text.split(WORDS.forWhat('Budget')).length - 1).toBe(1);
  });
});

describe('D-PR5-3 the names: the union of hint tables, at most three, then "and N more"', () => {
  it('the union across every want, in the order they appear, each once', async () => {
    const note = await renderNote(declaring([SPENDING, SECOND]));
    expect(note!.textContent).toContain(WORDS.preview('Budget', ['transactions', 'accounts', 'budgets'], 0));
  });

  it('past three: the first three, then "and 2 more"', async () => {
    const note = await renderNote(declaring([{ purpose: 'to see it all', hints: { tables: ['transactions', 'accounts', 'budgets', 'goals', 'payees'] } }]));
    expect(note!.textContent).toContain(WORDS.preview('Budget', ['transactions', 'accounts', 'budgets'], 2));
    expect(note!.textContent).toContain('and 2 more');
  });

  it('no want names a table: the hint WORDS name the data instead', async () => {
    const note = await renderNote(declaring([{ purpose: 'to show your spending', hints: { words: ['spending', 'groceries'] } }]));
    expect(note!.textContent).toContain(WORDS.preview('Budget', ['spending', 'groceries'], 0));
  });

  it('no hint anywhere: "Budget may ask to read your other apps\' data — nothing is read until you allow it"', async () => {
    const note = await renderNote(declaring([{ purpose: 'to read along' }]));
    expect(note!.textContent).toContain(WORDS.preview('Budget', [], 0));
    expect(note!.textContent).toContain("may ask to read your other apps' data");
    // Still the purpose, quoted.
    expect(note!.querySelector('q')!.textContent).toContain('to read along');
  });

  it('the app’s NAME is the one the preview gives — never a name from the declaration', async () => {
    const note = await renderNote(declaring([SPENDING]), 'Ledger Pro');
    expect(note!.textContent).toContain(WORDS.preview('Ledger Pro', ['transactions', 'accounts'], 0));
  });
});

describe('D-PR5-3 nothing to say, nothing shown', () => {
  it('an HTML with no declaration renders nothing', async () => {
    const note = await renderNote('<!doctype html><html><head><title>Budget</title></head><body></body></html>');
    expect(note).toBeNull();
    expect(container!.textContent).toBe('');
  });

  it('a declaration the grammar refuses (two metas) renders nothing — never a guess', async () => {
    const one = declaring([SPENDING]);
    const twice = one.replace('<title>', `<meta name="snug:access-wants" content='${JSON.stringify([SECOND])}'>\n<title>`);
    const note = await renderNote(twice);
    expect(note).toBeNull();
  });

  it('the words are copy.ts’s — the component spells no sentence of its own', () => {
    const file = path.resolve(__dirname, '..', 'access', 'AccessWantsNote.tsx');
    const source = readFileSync(file, 'utf8');
    expect(source).toContain('ACCESS_WANTS');
    expect(source).not.toMatch(/would like to read|nothing is read until/);
  });
});

describe('D-PR5-3 mounted on the SHARED install preview (SC10 — the starter preview waits for a starter that declares)', () => {
  it('RunView mounts AccessWantsNote', () => {
    const runView = readFileSync(path.resolve(__dirname, '..', 'run', 'RunView.tsx'), 'utf8');
    expect(runView).toMatch(/AccessWantsNote/);
  });

  it('GUARD — the quote mark is the sheet’s own (CONSENT_SHEET.quote) — one quoting rule on host chrome', () => {
    expect(CONSENT_SHEET.quote('to show spending by category')).toBe('“to show spending by category”');
  });
});
