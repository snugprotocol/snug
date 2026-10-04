#!/usr/bin/env node
// snug-embed.mjs — hand apps in to a live Snug artifact page (TASK-20260905-binding-a-artifacts
// AC9, ADR-0065 §6). The agent's session reads the live page (the Artifact tool's read),
// runs this over it, and publishes the result: an edit is a republish, never a second runner.
// The read-back is the WRAPPED page — under contract 0.2.67 the platform's skeleton (charset,
// viewport, a reset) around the kit's whole document (two real read-backs, 2026-10-03; the
// September viewer's wrapper, AC13 2026-09-06, is still read): this script unwraps it through
// the one grammar, merges into the KIT document, and writes the BARE kit page — the form a
// republish takes (the platform wraps it again). Never re-wrap: a skeleton sent back would be
// stored inside a second one. A read-back whose skeleton carries a page FRAGMENT is not the
// kit page and is refused by name.
//
//   node scripts/snug-embed.mjs <live.html> --bundle app.json [--bundle …] [--remove <lineage>] [--out file] [--strict]
//
// THE SKILL'S OWN PAGE IS NEVER AN OUTPUT (TASK-20261003 K6). This script ships inside the
// skill, beside `assets/snug-host.html` — the kit page a first artifact starts from, and,
// since the plugin carries that page once, the very file the local runner serves. Writing in
// place is this script's default, so pointed at that file it would have rewritten it — and
// nothing downstream would have caught it: the runner checks the page against a `.sha256`
// pin only where one sits beside it (`apps/host-mcp` `page.ts`), and the plugin build does
// not write one yet (D8, owed), so the rewritten page would simply be served, embedded apps
// and all, to every later session. It refuses to write anywhere under its own skill's
// `assets/`, and an input that lives there needs `--out`.
//
// Merges `snug-app-bundle/1` documents into the page by lineage (replace the same lineage,
// append a new one, remove on request) through the ONE grammar (`lib/page-blocks.mjs`) —
// which keeps the `snug-db` block (the user's saved file) and every block it does not own
// byte-for-byte. Every `<` in a bundle is written `<`, so a bundle's html can never end
// or escape its block. A page the tokenizer cannot read, a bundle that is not a bundle,
// or a bundle over the size cap is a refusal (exit 2), never a half-merged page.
//
// THE LINT is a LOADING aid, not a safety check (threat-model R-21): the artifact viewer's
// embedder CSP admits scripts only from jsDelivr `/npm/` and cdnjs and no CDN stylesheets
// or fonts at all (T1 S1, measured), so an app that loads anything else renders broken
// inside an artifact. Warnings by default; `--strict` refuses. It says nothing about
// whether the code is safe — the sandbox (C2) is the safety boundary, unchanged.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINEAGE_RULE, externalCssRefs, readBundleBlocks, removeBundleBlock, tokenizeTopLevel, unwrapViewerPage, upsertBundleBlock } from './lib/page-blocks.mjs';

export const BUNDLE_FORMAT = 'snug-app-bundle/1';
/** The protocol's caps (packages/protocol/src/app-bundle.ts) — restated as numbers; the test pins them against that source text. */
export const BUNDLE_MAX_BYTES = 1024 * 1024;
export const BUNDLE_MAX_HTML_CHARS = 768 * 1024;
/** What the artifact viewer's embedder CSP lets an app load (T1 S1, verbatim allowlist prefixes). */
export const ARTIFACT_SCRIPT_ALLOWLIST = ['https://cdn.jsdelivr.net/npm/', 'https://cdnjs.cloudflare.com/'];

/** Warnings for an app html that will not load inside an artifact viewer. */
export function lintBundleHtml(html) {
  const warnings = [];
  for (const e of tokenizeTopLevel(html)) {
    if (e.name === 'script' && e.attrs.src !== undefined) {
      const src = e.attrs.src;
      if (!ARTIFACT_SCRIPT_ALLOWLIST.some((p) => src.startsWith(p))) {
        warnings.push(`<script src="${src}"> will not load inside an artifact — scripts must come from ${ARTIFACT_SCRIPT_ALLOWLIST.join(' or ')}`);
      }
    }
    if (e.name === 'link' && /^\s*data:/i.test(e.attrs.href ?? '') === false && (e.attrs.rel ?? '').toLowerCase().includes('stylesheet')) {
      warnings.push(`<link rel="stylesheet" href="${e.attrs.href ?? ''}"> will not load inside an artifact — inline the CSS in a <style> block`);
    }
    if (e.name === 'style') {
      for (const ref of externalCssRefs(e.body ?? '')) {
        warnings.push(ref.kind === 'import' ? 'a <style> uses @import — inline the CSS instead; artifact viewers block CDN stylesheets' : `a <style> references url(${ref.url}) — artifact viewers block CDN fonts and images; use a data: URL`);
      }
    }
  }
  return warnings;
}

/** Parse one bundle text at the boundary — the shape the protocol's zod schema also refuses, dependency-free. */
export function parseBundleText(text, label = 'bundle') {
  if (Buffer.byteLength(text, 'utf8') > BUNDLE_MAX_BYTES) return { ok: false, error: `${label}: over the ${BUNDLE_MAX_BYTES}-byte bundle cap` };
  let json;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, error: `${label}: not JSON` };
  }
  if (typeof json !== 'object' || json === null || json.format !== BUNDLE_FORMAT) return { ok: false, error: `${label}: not a ${BUNDLE_FORMAT} document` };
  if (typeof json.lineage !== 'string' || !LINEAGE_RULE.test(json.lineage)) return { ok: false, error: `${label}: lineage must be a lowercase UUID` };
  if (typeof json.html !== 'string' || json.html === '') return { ok: false, error: `${label}: html must be a non-empty string` };
  if (json.html.length > BUNDLE_MAX_HTML_CHARS) return { ok: false, error: `${label}: html is over the ${BUNDLE_MAX_HTML_CHARS}-character cap` };
  if (typeof json.app !== 'object' || json.app === null || typeof json.app.displayName !== 'string') return { ok: false, error: `${label}: no app.displayName` };
  if (!Array.isArray(json.connections)) return { ok: false, error: `${label}: connections must be an array (empty inside an artifact)` };
  // D4: connected apps are not available inside an artifact — the kit refuses such a bundle at
  // boot, so merging it would hand in nothing and print a refusal on every load.
  if (json.connections.length > 0) return { ok: false, error: `${label}: carries ${json.connections.length} connection(s) — connected apps are not available inside an artifact (D4); drop them` };
  return { ok: true, bundle: json, text: JSON.stringify(json) };
}

/**
 * Merge bundles into a page. Pure: returns `{ html, warnings, errors }`; `errors` non-empty
 * means the page is UNCHANGED (never half-merged). With `strict`, lint warnings are errors.
 */
export function embed({ page: input, bundles = [], remove = [], strict = false }) {
  const warnings = [];
  const errors = [];
  // The Artifact tool's read-back is wrapped: lift the kit document out first, and refuse a
  // wrapper of any other shape (or a fragment inside one) rather than embed into it.
  const lifted = unwrapViewerPage(input);
  if (lifted.html === undefined) errors.push(`the page is not one platform wrapper around the kit page (${lifted.problem})`);
  const page = lifted.html ?? input;
  if (!/^\s*<!doctype html>/i.test(page)) errors.push('the page does not start with <!doctype html> — is this the live artifact page?');
  if (!/<\/body\s*>/i.test(page)) errors.push('the page has no </body> — nothing to embed into');
  const parsed = [];
  bundles.forEach((entry, i) => {
    const label = entry.name ?? `bundle #${i + 1}`;
    const result = parseBundleText(entry.text, label);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    const lint = lintBundleHtml(result.bundle.html).map((w) => `${label}: ${w}`);
    warnings.push(...lint);
    if (strict && lint.length > 0) errors.push(`${label}: refused under --strict (${lint.length} loading problem${lint.length === 1 ? '' : 's'})`);
    parsed.push(result);
  });
  for (const lineage of remove) if (!LINEAGE_RULE.test(lineage)) errors.push(`--remove ${lineage}: not a lineage (a lowercase UUID)`);
  if (errors.length > 0) return { html: input, warnings, errors, unwrapped: lifted.wrapped };
  let html = page;
  for (const lineage of remove) html = removeBundleBlock(html, lineage);
  for (const { bundle, text } of parsed) html = upsertBundleBlock(html, bundle.lineage, text);
  return { html, warnings, errors, unwrapped: lifted.wrapped };
}

/** What the page carries — for `--list` (a wrapped read-back is read through the unwrap; an unrecognised wrapper lists nothing). */
export function listBlocks(page) {
  return readBundleBlocks(unwrapViewerPage(page).html ?? '').map((b) => {
    try {
      const json = JSON.parse(b.json);
      return { lineage: b.lineage, displayName: json?.app?.displayName, bytes: Buffer.byteLength(b.json, 'utf8') };
    } catch {
      return { lineage: b.lineage, displayName: undefined, bytes: Buffer.byteLength(b.json, 'utf8') };
    }
  });
}

export function parseArgs(argv) {
  const args = { bundles: [], remove: [], strict: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--bundle') args.bundles.push(argv[++i]);
    else if (a.startsWith('--bundle=')) args.bundles.push(a.slice('--bundle='.length));
    else if (a === '--remove') args.remove.push(argv[++i]);
    else if (a.startsWith('--remove=')) args.remove.push(a.slice('--remove='.length));
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--strict') args.strict = true;
    else if (a === '--list') args.list = true;
    else if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    else if (args.page === undefined) args.page = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (args.page === undefined) throw new Error('usage: snug-embed <live.html> --bundle app.json [--bundle …] [--remove <lineage>] [--out file] [--strict] [--list]');
  return args;
}

/** The real path of a file that may not exist yet: its nearest existing ancestor, resolved, plus the rest. */
function realPathOf(file) {
  const absolute = path.resolve(file);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    return parent === absolute ? absolute : path.join(realPathOf(parent), path.basename(absolute));
  }
}

/**
 * Why this run may not write `out`, or undefined when it may. The guarded directory is the
 * `assets/` beside this script's own `scripts/` — the skill it ships in. Compared by REAL
 * path on both sides: a symlink to the page, or into the directory, is the same file.
 * Run from the monorepo there is no such directory, and nothing is guarded.
 */
export function ownAssetsRefusal({ page, out }, scriptFile = fileURLToPath(import.meta.url)) {
  let assets;
  try {
    assets = realpathSync(path.resolve(path.dirname(scriptFile), '..', 'assets'));
  } catch {
    return undefined;
  }
  const within = (file) => {
    const real = realPathOf(file);
    return real === assets || real.startsWith(`${assets}${path.sep}`);
  };
  if (out === undefined) {
    return within(page) ? `${page} is this skill's own copy of the kit page — pass --out <file> to write the merged page somewhere else (the default writes in place)` : undefined;
  }
  return within(out) ? `--out ${out} is inside this skill's own assets/ — the kit page there is the one the runner serves; write the merged page somewhere else` : undefined;
}

export function main(argv, io = { log: console.log, error: console.error }) {
  const args = parseArgs(argv);
  const page = readFileSync(args.page, 'utf8');
  if (args.list) {
    for (const b of listBlocks(page)) io.log(`${b.lineage}  ${b.displayName ?? '(unnamed)'}  ${b.bytes} B`);
    return 0;
  }
  // Before anything is merged: a run that may not write must not get as far as a result.
  const refusal = ownAssetsRefusal({ page: args.page, out: args.out });
  if (refusal !== undefined) {
    io.error(`error: ${refusal}`);
    io.error('snug-embed: nothing written');
    return 2;
  }
  const bundles = args.bundles.map((file) => ({ name: path.basename(file), text: readFileSync(file, 'utf8') }));
  const result = embed({ page, bundles, remove: args.remove, strict: args.strict });
  for (const w of result.warnings) io.error(`warning: ${w}`);
  if (result.errors.length > 0) {
    for (const e of result.errors) io.error(`error: ${e}`);
    io.error('snug-embed: nothing written');
    return 2;
  }
  const out = args.out ?? args.page;
  writeFileSync(out, result.html);
  io.log(`snug-embed: ${bundles.length} bundle(s) merged${args.remove.length ? `, ${args.remove.length} removed` : ''} → ${out}${result.unwrapped ? ' (the platform wrapper was lifted off — publish this bare page as it is)' : ''}${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}`);
  return 0;
}

// Is this file the program being run? Compared by REAL path: Node resolves the main module's
// own URL through symlinks, so a script reached by a linked path (macOS's /var → /private/var,
// a plugin cache behind a link) used to compare unequal here — and exit 0 having done nothing.
if (process.argv[1] && realPathOf(process.argv[1]) === realPathOf(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`snug-embed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
