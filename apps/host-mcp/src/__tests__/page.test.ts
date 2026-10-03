// D8 (the process half) — the page the process serves is found by ONE module and pinned.
//
// The plugin ships the page beside the bundle, and (from a later range) its sha256 beside
// the page. A partial copy or a stale mix of two versions serves a page that does not match
// the process — and both look perfectly healthy over HTTP. So when a pin exists the bytes
// must match it, and when they do not the locator hands back NO page at all: the process
// serves nothing (decided 2026-10-03 — a damaged install binds nothing) and says why through
// its tools. No pin (a developer's tree) → the page is served as it is.
//
// What this does NOT catch, recorded as such: another process running as the same user can
// rewrite the page and its pin together.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { locatePage, MISSING_PAGE, PAGE_CANDIDATES } from '../page.js';

const PAGE = '<!doctype html><title>kit</title><p>héllo'; // non-ASCII: the hash is over BYTES
const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

let root: string;
/** Where the bundle sits; the second candidate climbs two levels from here. */
let dir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'snug-page-'));
  dir = path.join(root, 'apps', 'host-mcp', 'dist');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const beside = (name = 'snug-host-local.html'): string => path.join(dir, name);

describe('where the page is looked for', () => {
  it('keeps today’s two homes, in order: beside the bundle, then the sibling app’s build', () => {
    expect([...PAGE_CANDIDATES]).toEqual(['snug-host-local.html', '../../host/dist-local/snug-host-local.html']);
  });

  it('finds the page beside the bundle — how the plugin ships it', () => {
    writeFileSync(beside(), PAGE);
    expect(locatePage(dir)).toEqual({ html: PAGE, file: beside(), damaged: false });
  });

  it('falls back to the sibling app’s build — how a developer runs dist/ straight out of the repo', () => {
    const sibling = path.join(root, 'apps', 'host', 'dist-local');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'snug-host-local.html'), PAGE);
    // (One object, not two property reads: a damaged result has no `html` to read — the type
    // says so since 2026-10-03.)
    expect(locatePage(dir)).toMatchObject({ html: PAGE, damaged: false });
  });

  it('prefers the page beside the bundle over the sibling build', () => {
    const sibling = path.join(root, 'apps', 'host', 'dist-local');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'snug-host-local.html'), 'the sibling');
    writeFileSync(beside(), PAGE);
    expect(locatePage(dir)).toMatchObject({ html: PAGE });
  });

  it('serves the named placeholder when there is no page anywhere — missing, not damaged', () => {
    const found = locatePage(dir);
    expect(found).toEqual({ html: MISSING_PAGE, damaged: false });
    expect(MISSING_PAGE).toMatch(/missing from this install/);
  });
});

describe('the pin', () => {
  it('serves a page whose bytes match the sha256 beside it', () => {
    writeFileSync(beside(), PAGE);
    writeFileSync(`${beside()}.sha256`, `${sha(PAGE)}\n`);
    expect(locatePage(dir)).toEqual({ html: PAGE, file: beside(), damaged: false });
  });

  it('accepts the `shasum` spelling — the digest, then the file name', () => {
    writeFileSync(beside(), PAGE);
    writeFileSync(`${beside()}.sha256`, `${sha(PAGE).toUpperCase()}  snug-host-local.html\n`);
    expect(locatePage(dir).damaged).toBe(false);
  });

  it('REFUSES bytes that do not match: damaged, and NO page comes back — not the stale bytes, not a stand-in', () => {
    // The mutant this kills: reading the pin and serving the page anyway.
    // MIGRATED 2026-10-03: the result used to carry a fixed "this install is damaged"
    // document for a listener to serve. A damaged install opens no listener now, so there
    // is nothing to serve it and the result carries nothing servable at all.
    writeFileSync(beside(), `${PAGE}<script>/* a stale mix */</script>`);
    writeFileSync(`${beside()}.sha256`, sha(PAGE));
    const found = locatePage(dir);
    expect(found).toEqual({ damaged: true, file: beside() });
    expect(JSON.stringify(found)).not.toContain('stale mix');
  });

  it('a pin with NO page is a partial copy — damaged, and it does not fall through to another page', () => {
    // The sibling build exists here; serving it would be the stale mix the pin exists to stop.
    const sibling = path.join(root, 'apps', 'host', 'dist-local');
    mkdirSync(sibling, { recursive: true });
    writeFileSync(path.join(sibling, 'snug-host-local.html'), 'the sibling');
    writeFileSync(`${beside()}.sha256`, sha(PAGE));
    const found = locatePage(dir);
    expect(found).toEqual({ damaged: true, file: beside() });
  });

  it('a pin that is not a sha256 at all is damage, never a pass', () => {
    writeFileSync(beside(), PAGE);
    writeFileSync(`${beside()}.sha256`, '');
    expect(locatePage(dir).damaged).toBe(true);
    writeFileSync(`${beside()}.sha256`, 'not-a-digest');
    expect(locatePage(dir).damaged).toBe(true);
  });

  it('no pin → the page is served as it is (the developer’s tree)', () => {
    writeFileSync(beside(), 'anything at all');
    expect(locatePage(dir)).toMatchObject({ html: 'anything at all', damaged: false });
  });
});

describe('what a damaged install has to serve', () => {
  it('NOTHING: the module keeps no "this install is damaged" document — nothing is left that could serve one', async () => {
    // MIGRATED 2026-10-03 from "the damaged page says what to do". The sentence a person
    // reads is the `page-damaged` row of the refusal table (`refusals.test.ts`); a document
    // kept here with no listener to serve it would be dead code that reads like a feature.
    const exported = await import('../page.js');
    expect(exported).not.toHaveProperty('DAMAGED_PAGE');
    for (const [name, value] of Object.entries(exported)) {
      if (typeof value === 'string') expect(value, name).not.toMatch(/damaged/i);
    }
    // The one fixed document it does keep is for a page that is MISSING — which is not damage.
    expect(MISSING_PAGE).toMatch(/missing from this install/);
  });
});
