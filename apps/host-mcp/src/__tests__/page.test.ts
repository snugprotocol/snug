// D8 (the process half) — the page the process serves is found by ONE module and pinned.
//
// The plugin ships the page ONCE — the skill's `assets/snug-host.html`, which is also the
// artifact route's page (ADR-0072 §1) — and (from a later range) its sha256 beside the page.
// A partial copy or a stale mix of two versions serves a page that does not match the
// process — and both look perfectly healthy over HTTP. So when a pin exists the bytes must
// match it, and when they do not the locator hands back NO page at all: the process serves
// nothing (decided 2026-10-03 — a damaged install binds nothing) and says why through its
// tools. No pin (a developer's tree) → the page is served as it is.
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
/** Where the bundle sits; every candidate is relative to here. */
let dir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'snug-page-'));
  dir = path.join(root, 'apps', 'host-mcp', 'dist');
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The three homes, as files under this test's root (MIGRATED 2026-10-03, K1: one page, `snug-host.html`). */
const inPlugin = (): string => path.join(root, 'apps', 'host-mcp', 'skills', 'snug', 'assets', 'snug-host.html');
const inRepo = (): string => path.join(root, 'apps', 'host', 'dist', 'snug-host.html');
const beside = (): string => path.join(dir, 'snug-host.html');
const put = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe('where the page is looked for', () => {
  it('has three homes, in order: the plugin layout, the repo layout, then a sibling of the bundle', () => {
    // MIGRATED 2026-10-03 (K1) from "keeps today’s two homes": the second build of the kit
    // is gone, so the page is `snug-host.html` and the plugin ships it once, as the skill's
    // asset. `scripts/build-plugin.test.mjs` resolves the FIRST entry inside a built tree,
    // so this list and the plugin's layout cannot drift apart.
    expect([...PAGE_CANDIDATES]).toEqual(['../skills/snug/assets/snug-host.html', '../../host/dist/snug-host.html', 'snug-host.html']);
  });

  it('finds the page in the plugin layout — the skill’s asset, beside the scripts directory the bundle sits in', () => {
    put(inPlugin(), PAGE);
    expect(locatePage(dir)).toEqual({ html: PAGE, file: inPlugin(), damaged: false });
  });

  it('falls back to the sibling app’s build — how a developer runs dist/ straight out of the repo', () => {
    put(inRepo(), PAGE);
    // (One object, not two property reads: a damaged result has no `html` to read — the type
    // says so since 2026-10-03.)
    expect(locatePage(dir)).toEqual({ html: PAGE, file: inRepo(), damaged: false });
  });

  it('falls back last to a page beside the bundle — how a scratch install (the browser suite’s copy) carries it', () => {
    put(beside(), PAGE);
    expect(locatePage(dir)).toEqual({ html: PAGE, file: beside(), damaged: false });
  });

  it('prefers the plugin layout over the repo build, and the repo build over a sibling', () => {
    put(beside(), 'the sibling');
    put(inRepo(), 'the repo build');
    expect(locatePage(dir)).toMatchObject({ html: 'the repo build' });
    put(inPlugin(), PAGE);
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
    put(inPlugin(), PAGE);
    writeFileSync(`${inPlugin()}.sha256`, `${sha(PAGE)}\n`);
    expect(locatePage(dir)).toEqual({ html: PAGE, file: inPlugin(), damaged: false });
  });

  it('accepts the `shasum` spelling — the digest, then the file name', () => {
    put(inPlugin(), PAGE);
    writeFileSync(`${inPlugin()}.sha256`, `${sha(PAGE).toUpperCase()}  snug-host.html\n`);
    expect(locatePage(dir).damaged).toBe(false);
  });

  it('REFUSES bytes that do not match: damaged, and NO page comes back — not the stale bytes, not a stand-in', () => {
    // The mutant this kills: reading the pin and serving the page anyway.
    // MIGRATED 2026-10-03: the result used to carry a fixed "this install is damaged"
    // document for a listener to serve. A damaged install opens no listener now, so there
    // is nothing to serve it and the result carries nothing servable at all.
    put(inPlugin(), `${PAGE}<script>/* a stale mix */</script>`);
    writeFileSync(`${inPlugin()}.sha256`, sha(PAGE));
    const found = locatePage(dir);
    expect(found).toEqual({ damaged: true, file: inPlugin() });
    expect(JSON.stringify(found)).not.toContain('stale mix');
  });

  it('a pin with NO page is a partial copy — damaged, and it does not fall through to another page', () => {
    // The repo build and a sibling exist here; serving either would be the stale mix the pin
    // exists to stop.
    put(inRepo(), 'the repo build');
    put(beside(), 'the sibling');
    mkdirSync(path.dirname(inPlugin()), { recursive: true });
    writeFileSync(`${inPlugin()}.sha256`, sha(PAGE));
    const found = locatePage(dir);
    expect(found).toEqual({ damaged: true, file: inPlugin() });
  });

  it('a pin that is not a sha256 at all is damage, never a pass', () => {
    put(inPlugin(), PAGE);
    writeFileSync(`${inPlugin()}.sha256`, '');
    expect(locatePage(dir).damaged).toBe(true);
    writeFileSync(`${inPlugin()}.sha256`, 'not-a-digest');
    expect(locatePage(dir).damaged).toBe(true);
  });

  it('no pin → the page is served as it is (the developer’s tree)', () => {
    put(inRepo(), 'anything at all');
    expect(locatePage(dir)).toMatchObject({ html: 'anything at all', damaged: false });
  });

  it('a pinned sibling is checked like any other home (the scratch installs the interop suite builds)', () => {
    put(beside(), 'a stale mix');
    writeFileSync(`${beside()}.sha256`, sha(PAGE));
    expect(locatePage(dir)).toEqual({ damaged: true, file: beside() });
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
