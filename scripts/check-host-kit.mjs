#!/usr/bin/env node
// check-host-kit.mjs — the host kit's structural gate (TASK-20260905-host-kit P8, AC1/AC11).
// The built page (`apps/host/dist/snug-host.html`) must be ONE self-contained file: DOM-
// parsed, it carries no `<script src>`, no `<link>` of any kind (stylesheet, preload,
// modulepreload, icon), no `<base>`, no `@import` or non-data `url(…)` in a top-level
// `<style>`, exactly one inline module script, a build stamp of the shape
// `<version> <sha>[-dirty]`, is the only file in `dist/`, and sits under two caps: the
// 16 MiB artifact limit and a ceiling measured from the real build (2,219,519 bytes on
// 2026-09-05 with the starter swap; 3,255,702 without it — the ceiling is what makes a
// dead swap, or the 6 MB WebLLM engine, red).
//
// STRUCTURAL, NEVER A STRING SWEEP (lesson, TASK-20260905-host-kit): the inlined page
// legitimately contains dozens of `<script src=` and `https://` strings — React's own DOM
// code, the knowledge base's app template, the CDN allowlists. A tokenizer walks the
// TOP-LEVEL document and skips script and style BODIES entirely; only real elements count.
// Dependency-free (node: builtins), like the other scripts/ checkers.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_DIST_DIR = path.join(ROOT, 'apps/host/dist');
export const KIT_FILE_NAME = 'snug-host.html';
/** The artifact viewer's hard limit. */
export const KIT_HARD_CAP_BYTES = 16 * 1024 * 1024;
/** Measured 2,219,519 B (2026-09-05); a starter regression adds ≈ 1.04 MB, WebLLM ≈ 6 MB. */
export const KIT_SIZE_CEILING_BYTES = 2_750_000;
export const STAMP_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)? [0-9a-f]{7,40}(?:-dirty)?$/;

// ---------------------------------------------------------------------------- tokenizer

const RAW_TEXT = new Set(['script', 'style']);

/** Parse one start tag's attributes from `pos` (just after the tag name). Quoted values may contain `>`. */
function readAttributes(html, pos) {
  const attrs = {};
  let i = pos;
  const n = html.length;
  for (;;) {
    while (i < n && /\s/.test(html[i])) i++;
    if (i >= n) return { attrs, end: n, selfClosing: false };
    if (html[i] === '>') return { attrs, end: i + 1, selfClosing: false };
    if (html[i] === '/' && html[i + 1] === '>') return { attrs, end: i + 2, selfClosing: true };
    let name = '';
    while (i < n && !/[\s=>/]/.test(html[i])) name += html[i++];
    if (name === '') {
      i++;
      continue;
    }
    while (i < n && /\s/.test(html[i])) i++;
    let value = '';
    if (html[i] === '=') {
      i++;
      while (i < n && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        value = html.slice(i + 1, close === -1 ? n : close);
        i = close === -1 ? n : close + 1;
      } else {
        while (i < n && !/[\s>]/.test(html[i])) value += html[i++];
      }
    }
    attrs[name.toLowerCase()] = value;
  }
}

/**
 * The top-level elements of a document: `{ name, attrs, body? }` per start tag, with the
 * bodies of `<script>` and `<style>` captured whole and NEVER tokenized (raw text elements
 * end only at their own end tag — the inliner guarantees no `</script` inside a body).
 */
export function tokenizeTopLevel(html) {
  const elements = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?' || next === '/') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(html.slice(lt + 1, lt + 64));
    if (nameMatch === null) {
      i = lt + 1;
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const { attrs, end } = readAttributes(html, lt + 1 + name.length);
    const element = { name, attrs, index: lt };
    if (RAW_TEXT.has(name)) {
      const closer = new RegExp(`</${name}\\b`, 'i');
      const rest = html.slice(end);
      const m = closer.exec(rest);
      element.body = m === null ? rest : rest.slice(0, m.index);
      const after = m === null ? n : end + m.index;
      const gt = html.indexOf('>', after);
      i = gt === -1 ? n : gt + 1;
    } else {
      i = end;
    }
    elements.push(element);
  }
  return elements;
}

// -------------------------------------------------------------------------------- rules

const isDataUrl = (value) => /^\s*data:/i.test(value);

/** Every problem with the page as a string, on the top-level structure only. Empty = pass. */
export function checkHostKitPage(html, { sizeBytes = Buffer.byteLength(html, 'utf8') } = {}) {
  const problems = [];
  const elements = tokenizeTopLevel(html);

  if (sizeBytes > KIT_HARD_CAP_BYTES) problems.push(`page is ${sizeBytes} bytes, over the 16 MiB artifact cap`);
  if (sizeBytes > KIT_SIZE_CEILING_BYTES) {
    problems.push(`page is ${sizeBytes} bytes, over the ${KIT_SIZE_CEILING_BYTES}-byte ceiling — did the starter swap or the WebLLM stub go dead?`);
  }

  const scripts = elements.filter((e) => e.name === 'script');
  for (const s of scripts) if (s.attrs.src !== undefined) problems.push(`<script src="${s.attrs.src}"> — the page must carry its script inline`);
  const inlineModules = scripts.filter((s) => s.attrs.src === undefined && s.attrs.type === 'module');
  if (inlineModules.length !== 1) problems.push(`expected exactly one inline <script type="module">, found ${inlineModules.length}`);
  for (const s of scripts) if (s.attrs.src === undefined && s.attrs.type !== 'module') problems.push('an inline classic <script> — the page has exactly one module script');

  for (const l of elements.filter((e) => e.name === 'link')) problems.push(`<link rel="${l.attrs.rel ?? ''}"> — the page must carry no link element (${l.attrs.href ?? ''})`);
  for (const b of elements.filter((e) => e.name === 'base')) problems.push(`<base href="${b.attrs.href ?? ''}"> — the page must not rebase`);
  for (const m of elements.filter((e) => e.name === 'meta' && (e.attrs['http-equiv'] ?? '').toLowerCase() === 'refresh')) {
    problems.push(`<meta http-equiv="refresh" content="${m.attrs.content ?? ''}"> — the page must not navigate`);
  }
  for (const e of elements.filter((e) => ['img', 'iframe', 'video', 'audio', 'source', 'object', 'embed', 'track'].includes(e.name))) {
    const ref = e.attrs.src ?? e.attrs.data ?? e.attrs.href;
    if (ref !== undefined && !isDataUrl(ref)) problems.push(`<${e.name}> references ${ref} — every top-level resource is inline`);
  }

  for (const st of elements.filter((e) => e.name === 'style')) {
    const css = st.body ?? '';
    if (/@import\b/i.test(css)) problems.push('top-level <style> uses @import — every stylesheet is inline');
    for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
      if (!isDataUrl(m[2])) problems.push(`top-level <style> references url(${m[2]}) — every asset is a data: URL`);
    }
  }

  const stamps = elements.filter((e) => e.name === 'meta' && e.attrs.name === 'snug-host-build');
  if (stamps.length !== 1) problems.push(`expected exactly one <meta name="snug-host-build">, found ${stamps.length}`);
  else if (!STAMP_SHAPE.test(stamps[0].attrs.content ?? '')) problems.push(`build stamp "${stamps[0].attrs.content ?? ''}" is not <version> <sha>[-dirty]`);

  return problems;
}

/** The dist directory: exactly one file, named as the kit. */
export function checkHostKitDist(distDir = KIT_DIST_DIR) {
  if (!existsSync(distDir)) return [`${distDir} does not exist — run \`pnpm --filter host build\` first`];
  const entries = readdirSync(distDir);
  const problems = [];
  if (entries.length !== 1 || entries[0] !== KIT_FILE_NAME) problems.push(`dist/ must contain exactly ${KIT_FILE_NAME}, found: ${entries.join(', ') || '(nothing)'}`);
  const file = path.join(distDir, KIT_FILE_NAME);
  if (!existsSync(file)) return problems;
  const html = readFileSync(file, 'utf8');
  problems.push(...checkHostKitPage(html, { sizeBytes: statSync(file).size }));
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkHostKitDist();
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-host-kit: ${p}`);
    process.exit(1);
  }
  const size = statSync(path.join(KIT_DIST_DIR, KIT_FILE_NAME)).size;
  console.log(`check-host-kit: ok (${KIT_FILE_NAME}, ${size} bytes, ceiling ${KIT_SIZE_CEILING_BYTES})`);
}
