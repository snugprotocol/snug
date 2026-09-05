#!/usr/bin/env node
// snug-embed.mjs — hand apps in to a live Snug artifact page (TASK-20260905-binding-a-artifacts
// AC9, ADR-0065 §6). The agent's session reads the live page (the Artifact tool's read),
// runs this over it, and publishes the result: an edit is a republish, never a second runner.
//
//   node scripts/snug-embed.mjs <live.html> --bundle app.json [--bundle …] [--remove <lineage>] [--out file] [--strict]
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

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LINEAGE_RULE, readBundleBlocks, removeBundleBlock, tokenizeTopLevel, upsertBundleBlock } from './lib/page-blocks.mjs';

export const BUNDLE_FORMAT = 'snug-app-bundle/1';
/** The protocol's whole-bundle cap (packages/protocol app-bundle.ts) — restated as a number, pinned by the test. */
export const BUNDLE_MAX_BYTES = 1024 * 1024;
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
      const css = e.body ?? '';
      if (/@import\b/i.test(css)) warnings.push('a <style> uses @import — inline the CSS instead; artifact viewers block CDN stylesheets');
      for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
        if (!/^\s*data:/i.test(m[2])) warnings.push(`a <style> references url(${m[2]}) — artifact viewers block CDN fonts and images; use a data: URL`);
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
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: `${label}: not JSON` };
  }
  if (typeof json !== 'object' || json === null || json.format !== BUNDLE_FORMAT) return { ok: false, error: `${label}: not a ${BUNDLE_FORMAT} document` };
  if (typeof json.lineage !== 'string' || !LINEAGE_RULE.test(json.lineage)) return { ok: false, error: `${label}: lineage must be a lowercase UUID` };
  if (typeof json.html !== 'string' || json.html === '') return { ok: false, error: `${label}: html must be a non-empty string` };
  return { ok: true, bundle: json, text: JSON.stringify(json) };
}

/**
 * Merge bundles into a page. Pure: returns `{ html, warnings, errors }`; `errors` non-empty
 * means the page is UNCHANGED (never half-merged). With `strict`, lint warnings are errors.
 */
export function embed({ page, bundles = [], remove = [], strict = false }) {
  const warnings = [];
  const errors = [];
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
  if (errors.length > 0) return { html: page, warnings, errors };
  let html = page;
  for (const lineage of remove) html = removeBundleBlock(html, lineage);
  for (const { bundle, text } of parsed) html = upsertBundleBlock(html, bundle.lineage, text);
  return { html, warnings, errors };
}

/** What the page carries — for `--list`. */
export function listBlocks(page) {
  return readBundleBlocks(page).map((b) => {
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

export function main(argv, io = { log: console.log, error: console.error }) {
  const args = parseArgs(argv);
  const page = readFileSync(args.page, 'utf8');
  if (args.list) {
    for (const b of listBlocks(page)) io.log(`${b.lineage}  ${b.displayName ?? '(unnamed)'}  ${b.bytes} B`);
    return 0;
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
  io.log(`snug-embed: ${bundles.length} bundle(s) merged${args.remove.length ? `, ${args.remove.length} removed` : ''} → ${out}${result.warnings.length ? ` (${result.warnings.length} warning(s))` : ''}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`snug-embed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
