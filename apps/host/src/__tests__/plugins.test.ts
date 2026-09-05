// The build plugins (TASK-20260905-host-kit P5, AC1, AC11): the single-file inliner —
// script and stylesheet inlined, every other emitted file refused, the three refusals
// (`</script`, `<!--` in script data, `</style`), the build stamp written — the starters
// index virtual module (escaped so the inlined JSON can never close a script), and the
// build stamp's shape.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildStamp } from '../plugins/build-stamp.js';
import { inlineSingleFile } from '../plugins/inline-single-file.js';
import { STARTERS_INDEX_MODULE, startersIndexPlugin } from '../plugins/starters-index.js';

type Bundle = Record<string, { type: 'chunk'; fileName: string; code: string; isEntry: boolean } | { type: 'asset'; fileName: string; source: string | Uint8Array }>;

const HTML = (head: string): string =>
  `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <meta name="snug-host-build" content="dev" />\n    <title>Snug</title>\n${head}  </head>\n  <body>\n    <div id="root"></div>\n  </body>\n</html>\n`;

function viteShapedBundle(over: { js?: string; css?: string; extra?: Bundle; head?: string } = {}): Bundle {
  const js = over.js ?? 'console.log("hi")';
  const css = over.css ?? 'body{margin:0}';
  const head =
    over.head ??
    '    <script type="module" crossorigin src="./assets/index-AbC123.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-DeF456.css">\n';
  return {
    'index.html': { type: 'asset', fileName: 'index.html', source: HTML(head) },
    'assets/index-AbC123.js': { type: 'chunk', fileName: 'assets/index-AbC123.js', code: js, isEntry: true },
    'assets/index-DeF456.css': { type: 'asset', fileName: 'assets/index-DeF456.css', source: css },
    ...over.extra,
  };
}

function run(bundle: Bundle, stamp = '0.1.0 abc1234'): string {
  const plugin = inlineSingleFile({ stamp, fileName: 'snug-host.html' });
  const generate = plugin.generateBundle as (this: unknown, options: unknown, bundle: Bundle) => void;
  generate.call({}, {}, bundle);
  const html = bundle['snug-host.html'];
  if (html === undefined || html.type !== 'asset') throw new Error('no html emitted');
  return html.source as string;
}

describe('inlineSingleFile', () => {
  it('inlines the entry chunk as <script type="module"> and the stylesheet as <style>, deletes both files, renames the page', () => {
    const bundle = viteShapedBundle();
    const html = run(bundle);
    expect(Object.keys(bundle)).toEqual(['snug-host.html']);
    expect(html).toContain('<script type="module">console.log("hi")</script>');
    expect(html).toContain('<style>body{margin:0}</style>');
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*rel="stylesheet"/);
    expect(html).not.toContain('crossorigin');
  });

  it('writes the build stamp into the meta placeholder and refuses a page without one', () => {
    const html = run(viteShapedBundle(), '0.1.0 deadbee-dirty');
    expect(html).toContain('<meta name="snug-host-build" content="0.1.0 deadbee-dirty" />');
    expect(html).not.toContain('content="dev"');
    const noStamp = viteShapedBundle();
    (noStamp['index.html'] as { source: string }).source = HTML('').replace(/<meta name="snug-host-build"[^>]*>\n\s*/, '');
    expect(() => run(noStamp)).toThrow(/snug-host-build/);
  });

  it('drops modulepreload links (their chunks are inlined by inlineDynamicImports)', () => {
    const head =
      '    <script type="module" crossorigin src="./assets/index-AbC123.js"></script>\n    <link rel="modulepreload" crossorigin href="./assets/index-AbC123.js">\n    <link rel="stylesheet" crossorigin href="./assets/index-DeF456.css">\n';
    const html = run(viteShapedBundle({ head }));
    expect(html).not.toContain('modulepreload');
  });

  it('REFUSES script code containing `</script` (any case) — the page would end its own script', () => {
    expect(() => run(viteShapedBundle({ js: 'const s = "</script>"' }))).toThrow(/<\/script/i);
    expect(() => run(viteShapedBundle({ js: 'const s = "</SCRIPT >"' }))).toThrow(/<\/script/i);
  });

  it('REFUSES script code with an UNCLOSED `<!--` — the tokenizer could stay escaped past the real closing tag', () => {
    expect(() => run(viteShapedBundle({ js: 'const s = "<!-- hi"' }))).toThrow(/UNCLOSED "<!--"/);
    expect(() => run(viteShapedBundle({ js: 'const s = "<!-- a --> ok <!-- b"' }))).toThrow(/UNCLOSED "<!--"/);
  });

  it('accepts a `<!--` that a later `-->` closes (React and the knowledge base carry these inside strings)', () => {
    const html = run(viteShapedBundle({ js: 'const s = "<!-- layer: kb -->"; const t = "<!-- a"; const u = "b -->"' }));
    expect(html).toContain('<!-- layer: kb -->');
  });

  it('accepts the escaped forms esbuild emits (`<\\/script`, `\\x3C!--`)', () => {
    const html = run(viteShapedBundle({ js: 'const s = "<\\/script>"; const t = "\\x3C!--"' }));
    expect(html).toContain('<\\/script>');
  });

  it('REFUSES a stylesheet containing `</style`', () => {
    expect(() => run(viteShapedBundle({ css: 'a::after{content:"</style>"}' }))).toThrow(/<\/style/i);
  });

  it('REFUSES any other emitted file — self-containment is structural, a stray font or wasm fails the build by name', () => {
    const extra: Bundle = { 'assets/sql-wasm-Xyz.wasm': { type: 'asset', fileName: 'assets/sql-wasm-Xyz.wasm', source: new Uint8Array([0, 97, 115, 109]) } };
    expect(() => run(viteShapedBundle({ extra }))).toThrow(/sql-wasm-Xyz\.wasm/);
  });

  it('REFUSES a page that still references ./assets/ after inlining (a shape the inliner did not recognise)', () => {
    const head = '    <script type="module" crossorigin src="./assets/index-AbC123.js"></script>\n    <link rel="stylesheet" crossorigin href="./assets/index-DeF456.css">\n    <link rel="icon" href="./assets/icon-Q.svg">\n';
    const extra: Bundle = { 'assets/icon-Q.svg': { type: 'asset', fileName: 'assets/icon-Q.svg', source: '<svg/>' } };
    expect(() => run(viteShapedBundle({ head, extra }))).toThrow(/icon-Q\.svg/);
  });

  it('REFUSES a bundle with two html pages or two entry chunks — one file, one entry', () => {
    const two = viteShapedBundle({ extra: { 'micro.html': { type: 'asset', fileName: 'micro.html', source: HTML('') } } });
    expect(() => run(two)).toThrow(/exactly one html/);
  });
});

describe('startersIndexPlugin', () => {
  it('serves the index as a default export with every `<` escaped, so the inlined JSON can never close a script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snug-starters-index-'));
    const file = join(dir, 'index.json');
    const evil = { format: 'snug-starters-index/1', name: 'n', version: '1.0.0', starters: { x: { file: 'x.js', sha384: 'h', bytes: 1, inline: { meta: '</script><!-- <b>' } } } };
    writeFileSync(file, JSON.stringify(evil));
    const plugin = startersIndexPlugin(file);
    const resolve = plugin.resolveId as (this: unknown, id: string) => string | null;
    const load = plugin.load as (this: unknown, id: string) => string | null;
    const id = resolve.call({}, STARTERS_INDEX_MODULE);
    expect(id).not.toBeNull();
    expect(resolve.call({}, 'react')).toBeNull();
    const code = load.call({}, id!)!;
    expect(code).not.toContain('<');
    expect(code).not.toContain('</script');
    const value = new Function(`${code.replace(/^export default /, 'return ')}`)() as typeof evil;
    expect(value).toEqual(evil);
  });

  it('refuses a missing or malformed index — a kit build without the starters package is not a kit build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snug-starters-index-'));
    const missing = startersIndexPlugin(join(dir, 'absent.json'));
    const resolve = missing.resolveId as (this: unknown, id: string) => string;
    const load = missing.load as (this: unknown, id: string) => string;
    expect(() => load.call({}, resolve.call({}, STARTERS_INDEX_MODULE))).toThrow(/build:starters|absent\.json/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ format: 'other', starters: {} }));
    const badPlugin = startersIndexPlugin(bad);
    expect(() => (badPlugin.load as (this: unknown, id: string) => string).call({}, resolve.call({}, STARTERS_INDEX_MODULE))).toThrow(/format/);
  });
});

describe('buildStamp', () => {
  it('is `<version> <sha>` with `-dirty` only when the tree is dirty', () => {
    expect(buildStamp({ version: '0.1.0', sha: 'abc1234', dirty: false })).toBe('0.1.0 abc1234');
    expect(buildStamp({ version: '0.1.0', sha: 'abc1234', dirty: true })).toBe('0.1.0 abc1234-dirty');
  });
  it('refuses an empty sha or version — an unstamped page is not reproducible evidence', () => {
    expect(() => buildStamp({ version: '', sha: 'abc1234', dirty: false })).toThrow();
    expect(() => buildStamp({ version: '0.1.0', sha: '', dirty: false })).toThrow();
  });
});
