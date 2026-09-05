// inline-single-file.ts — ONE page (TASK-20260905-host-kit P5, AC1). Runs after Vite has
// emitted its html + one entry chunk + one stylesheet, inlines the chunk as
// `<script type="module">` and the stylesheet as `<style>`, drops modulepreload links,
// writes the build stamp, renames the page, and then REFUSES anything that would make the
// result not one file: a second html, a second entry, any emitted file left over (a font,
// a wasm, an icon), any remaining `./assets/` reference.
//
// THE THREE REFUSALS (review minor 2 — until now the page's safety was esbuild's escaping
// plus luck). In HTML's script-data tokenizer only ONE sequence can end the element early:
// `</script` (any case). esbuild escapes it inside string literals by default (`<\/script`,
// measured 2026-09-05 — and `supported['inline-script']=false` turns that OFF, so the kit
// config leaves the default alone); anything that survives is refused here. `<!--` moves
// the tokenizer into the "escaped" states, where `</script` still closes the element —
// EXCEPT after a later `<script` (the "double escaped" state), which only `-->` or a
// literal `</script` can leave. So a `<!--` that is CLOSED by a later `-->` is harmless
// (React's own DOM code and the knowledge base's app template carry closed ones inside
// strings), and an UNCLOSED one is refused: the page's real closing tag might never be
// seen. CSS: `</style` is the one sequence, refused outright. Each refusal names the
// neighbourhood of every hit so the offender is findable; the build fails.

import type { Plugin, Rollup } from 'vite';

export interface InlineSingleFileOptions {
  /** `<version> <sha>[-dirty]` — written into `<meta name="snug-host-build">`. */
  stamp: string;
  /** The emitted page's name, e.g. `snug-host.html`. */
  fileName: string;
}

const STAMP_META = /<meta name="snug-host-build" content="[^"]*" \/>/;
const SCRIPT_SRC = /<script\b([^>]*?)\ssrc="([^"]+)"([^>]*)><\/script>/g;
const LINK_STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g;
const LINK_MODULEPRELOAD = /[ \t]*<link\b[^>]*\brel="modulepreload"[^>]*>\n?/g;
const ASSET_REF = /(?:src|href)="(?:\.\/)?(assets\/[^"]+)"/g;

const escapeAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const keyOf = (href: string): string => href.replace(/^\.\//, '').replace(/^\//, '');

/** The neighbourhood of each hit, so the refusal names WHERE the sequence comes from. */
const neighbourhoods = (code: string, re: RegExp, limit = 5): string[] =>
  [...code.matchAll(re)].slice(0, limit).map((m) => `@${m.index}: …${JSON.stringify(code.slice(Math.max(0, m.index - 60), m.index + 40))}…`);

export function refuseUnsafeScript(code: string, label: string): void {
  const closers = neighbourhoods(code, /<\/script/gi);
  if (closers.length > 0) {
    throw new Error(`inline-single-file: ${label} contains "</script" — it would close the inlined script:\n  ${closers.join('\n  ')}`);
  }
  if (code.includes('__VITE_PRELOAD__')) {
    throw new Error(`inline-single-file: ${label} still contains Vite's unresolved "__VITE_PRELOAD__" marker — every lazy import would throw at runtime (build.modulePreload must be { polyfill: false }, never false)`);
  }
  const lastOpen = code.lastIndexOf('<!--');
  if (lastOpen !== -1 && code.indexOf('-->', lastOpen + 4) === -1) {
    throw new Error(`inline-single-file: ${label} contains an UNCLOSED "<!--" — script-data escaping could hide the page's closing tag:\n  ${neighbourhoods(code.slice(lastOpen), /<!--/g, 1).join('')}`);
  }
}

export function refuseUnsafeStyle(css: string, label: string): void {
  const closer = /<\/style/i.exec(css);
  if (closer !== null) throw new Error(`inline-single-file: ${label} contains "</style" at ${closer.index} — it would close the inlined stylesheet`);
}

export function inlineSingleFile(options: InlineSingleFileOptions): Plugin {
  return {
    name: 'snug-host:inline-single-file',
    enforce: 'post',
    // `order: 'post'` on the HOOK, not only `enforce` on the plugin: a user post plugin's
    // generateBundle still runs BEFORE Vite's core `vite:build-import-analysis`, which is
    // the hook that resolves the `__VITE_PRELOAD__` markers around lazy imports. Captured
    // earlier, the chunk still carried the marker and every run-view route threw on a
    // blank page (found by the e2e 2026-09-05). Rollup runs every `order: 'post'` hook
    // after all normal-order ones, so this sees the finished chunk; the marker refusal
    // below is the pin.
    generateBundle: {
      order: 'post',
      handler(_outputOptions, bundle: Rollup.OutputBundle) {
      const htmlKeys = Object.keys(bundle).filter((k) => bundle[k]!.type === 'asset' && k.endsWith('.html'));
      if (htmlKeys.length !== 1) throw new Error(`inline-single-file: exactly one html page expected, found ${htmlKeys.length}: ${htmlKeys.join(', ')}`);
      const entries = Object.values(bundle).filter((item) => item.type === 'chunk' && item.isEntry);
      if (entries.length !== 1) throw new Error(`inline-single-file: exactly one entry chunk expected, found ${entries.length}`);

      const htmlKey = htmlKeys[0]!;
      const page = bundle[htmlKey] as Rollup.OutputAsset;
      let html = typeof page.source === 'string' ? page.source : new TextDecoder().decode(page.source);

      html = html.replace(SCRIPT_SRC, (_match, _before: string, src: string) => {
        const key = keyOf(src);
        const item = bundle[key];
        if (item === undefined || item.type !== 'chunk') throw new Error(`inline-single-file: <script src="${src}"> is not an emitted chunk`);
        refuseUnsafeScript(item.code, key);
        delete bundle[key];
        return `<script type="module">${item.code}</script>`;
      });

      html = html.replace(LINK_STYLESHEET, (_match, href: string) => {
        const key = keyOf(href);
        const item = bundle[key];
        if (item === undefined || item.type !== 'asset') throw new Error(`inline-single-file: stylesheet "${href}" is not an emitted asset`);
        const css = typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source);
        refuseUnsafeStyle(css, key);
        delete bundle[key];
        return `<style>${css}</style>`;
      });

      html = html.replace(LINK_MODULEPRELOAD, '');

      if (!STAMP_META.test(html)) throw new Error('inline-single-file: the page carries no <meta name="snug-host-build"> placeholder');
      html = html.replace(STAMP_META, `<meta name="snug-host-build" content="${escapeAttr(options.stamp)}" />`);

      const leftoverRefs = [...html.matchAll(ASSET_REF)].map((m) => m[1]!);
      if (leftoverRefs.length > 0) throw new Error(`inline-single-file: the page still references emitted assets: ${leftoverRefs.join(', ')}`);

      const leftoverFiles = Object.keys(bundle).filter((k) => k !== htmlKey);
      if (leftoverFiles.length > 0) throw new Error(`inline-single-file: files other than the page would be emitted: ${leftoverFiles.join(', ')}`);

      delete bundle[htmlKey];
      page.fileName = options.fileName;
      page.source = html;
      bundle[options.fileName] = page;
      },
    },
  };
}
