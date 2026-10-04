// page-blocks.mjs — the ONE grammar for the data blocks a live Snug page carries, and the
// ONE top-level tokenizer every reader of that page uses (TASK-20260905-binding-a-artifacts
// AC5/AC8/AC9). Pure string functions, no Node imports: the kit imports this module into the
// browser bundle (the artifact record splices the user file in; the hand-in reads bundles
// out), `snug-embed.mjs` uses it from the agent's shell, `check-host-kit.mjs` gates the
// built page with the same tokenizer, and the starters-index plugin escapes with the same
// function. Imported everywhere, restated nowhere. Types: page-blocks.d.mts (hand-kept).
//
// THE TWO BLOCKS, both SCRIPT DATA that can never end the element early:
//   <script type="text/plain" id="snug-db">{manifest}\n{base64}</script>
//       the user's SQLite (or SNUGENC1) file — base64 and a JSON manifest carry no `<`.
//   <script type="application/snug-app-bundle+json" data-lineage="<uuid>">{json}</script>
//       one `snug-app-bundle/1` per lineage, every `<` written `<`.
// Blocks sit between the kit's own `<script type="module">` and `</body>`; a writer that
// finds no block inserts before `</body>`. Readers locate blocks through the tokenizer —
// never a regex over bodies (the kit's own script legitimately contains `<script>` text).

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
 * The top-level elements of a document: `{ name, attrs, index, end, body? }` per start tag,
 * with the bodies of `<script>` and `<style>` captured whole and NEVER tokenized (raw text
 * elements end only at their own end tag). `index` is the start tag's `<`; `end` is just
 * past the element — the end tag's `>` for a raw-text element, the start tag's `>` for
 * everything else — so a caller can splice `html.slice(index, end)`.
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
    const element = { name, attrs, index: lt, end };
    if (RAW_TEXT.has(name)) {
      const closer = new RegExp(`</${name}\\b`, 'i');
      const rest = html.slice(end);
      const m = closer.exec(rest);
      element.body = m === null ? rest : rest.slice(0, m.index);
      const after = m === null ? n : end + m.index;
      const gt = html.indexOf('>', after);
      i = gt === -1 ? n : gt + 1;
      element.end = i;
    } else {
      i = end;
    }
    elements.push(element);
  }
  return elements;
}

// ------------------------------------------------------------------------------ escape

/** JSON text → JS-safe text with no `<` at all (still valid JSON) — a bundle block can never spell `</script` or `<!--`. */
export function escapeForInlineScript(json) {
  return json.replace(/</g, '\\u003c');
}

// ------------------------------------------------------------------------------ shared

export const DB_BLOCK_ID = 'snug-db';
export const DB_BLOCK_FORMAT = 'snug-db-block/1';
export const BUNDLE_BLOCK_TYPE = 'application/snug-app-bundle+json';
export const LINEAGE_RULE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isDbBlock = (e) => e.name === 'script' && (e.attrs.type ?? '') === 'text/plain' && e.attrs.id === DB_BLOCK_ID;
const isBundleBlock = (e) => e.name === 'script' && (e.attrs.type ?? '') === BUNDLE_BLOCK_TYPE;

/**
 * Insert `block` before the LAST `</body>` (case-insensitive); with no `</body>`, append. Located
 * by regex, not the tokenizer: a page whose ONLY `</body>` sat inside a script string would
 * take the block inside that script — unreachable on the kit page, whose real `</body>` is
 * last (the AC5 byte-equality e2e proves the splice), and `snug-embed` refuses a page with no
 * `</body>` at all.
 */
function insertBeforeBodyEnd(html, block) {
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return at === -1 ? `${html}\n${block}\n` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

function refuseCloser(text, label) {
  if (/<\/script/i.test(text) || /<!--/.test(text)) throw new Error(`page-blocks: the ${label} contains a sequence that would end or escape the block`);
}

// ------------------------------------------------------------------------ css refs

/**
 * Every external reference a stylesheet makes — an `@import`, or a `url(…)` that is not a
 * `data:` URL. ONE reader for check-host-kit (the kit page must carry none) and snug-embed
 * (an artifact-bound app must carry none — the viewer blocks CDN stylesheets and fonts).
 */
export function externalCssRefs(css) {
  const refs = [];
  if (/@import\b/i.test(css)) refs.push({ kind: 'import' });
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    if (!/^\s*data:/i.test(m[2])) refs.push({ kind: 'url', url: m[2] });
  }
  return refs;
}

// ---------------------------------------------------------------------------- db block

/**
 * Parse a db block's BODY (the text between the tags): a JSON manifest line, then the
 * base64. Every manifest field is checked against its shape (a hand-edited or truncated
 * manifest is CORRUPT, never a counter of NaN — correctness review 13). The kit calls this
 * on the block's `textContent` at boot; `readDbBlock` calls it after the tokenizer found the block.
 */
export function parseDbBlockBody(body) {
  const nl = body.indexOf('\n');
  const manifestText = nl === -1 ? body : body.slice(0, nl);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { corrupt: 'the snug-db block manifest is not JSON' };
  }
  if (typeof manifest !== 'object' || manifest === null || manifest.format !== DB_BLOCK_FORMAT) {
    return { corrupt: `the snug-db block manifest is not ${DB_BLOCK_FORMAT} (format ${String(manifest?.format)})` };
  }
  if (!Number.isInteger(manifest.bytes) || manifest.bytes < 0) return { corrupt: 'the snug-db block manifest has no byte length' };
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return { corrupt: 'the snug-db block manifest has no sha256' };
  if (!Number.isInteger(manifest.saved) || manifest.saved < 0) return { corrupt: 'the snug-db block manifest has no save counter' };
  if (typeof manifest.savedAt !== 'string') return { corrupt: 'the snug-db block manifest has no save instant' };
  return { manifest, base64: nl === -1 ? '' : body.slice(nl + 1).trim() };
}

/**
 * The db block, or `undefined` when the page carries none, or `{ corrupt }` when a block is
 * present but unreadable — an unreadable block is never "no file" (lesson 2026-08-22).
 */
export function readDbBlock(html) {
  const block = tokenizeTopLevel(html).find(isDbBlock);
  if (block === undefined) return undefined;
  const parsed = parseDbBlockBody(block.body ?? '');
  return parsed.corrupt !== undefined ? parsed : { ...parsed, index: block.index, end: block.end };
}

/** Write (replace or insert) the db block. The manifest is JSON; the base64 is one line. */
export function writeDbBlock(html, { manifest, base64 }) {
  const manifestText = JSON.stringify(manifest);
  refuseCloser(manifestText, 'manifest');
  if (!/^[A-Za-z0-9+/=]*$/.test(base64)) throw new Error('page-blocks: the base64 payload is not base64');
  const block = `<script type="text/plain" id="${DB_BLOCK_ID}">${manifestText}\n${base64}</script>`;
  const existing = tokenizeTopLevel(html).find(isDbBlock);
  return existing === undefined ? insertBeforeBodyEnd(html, block) : `${html.slice(0, existing.index)}${block}${html.slice(existing.end)}`;
}

// ------------------------------------------------------------------------ bundle blocks

/** Every bundle block in page order: `{ lineage, json, index, end }` — the JSON UNESCAPED (`<` restored), unparsed. */
export function readBundleBlocks(html) {
  return tokenizeTopLevel(html)
    .filter(isBundleBlock)
    .map((e) => ({ lineage: e.attrs['data-lineage'] ?? '', json: (e.body ?? '').trim(), index: e.index, end: e.end }));
}

function assertLineage(lineage) {
  if (!LINEAGE_RULE.test(lineage)) throw new Error(`page-blocks: "${lineage}" is not a lineage (a lowercase UUID)`);
}

/** Replace the block of `lineage`, or append a new one before `</body>`. `json` is the bundle text; every `<` is escaped here. */
export function upsertBundleBlock(html, lineage, json) {
  assertLineage(lineage);
  const block = `<script type="${BUNDLE_BLOCK_TYPE}" data-lineage="${lineage}">${escapeForInlineScript(json)}</script>`;
  const existing = readBundleBlocks(html).find((b) => b.lineage === lineage);
  return existing === undefined ? insertBeforeBodyEnd(html, block) : `${html.slice(0, existing.index)}${block}${html.slice(existing.end)}`;
}

/** Drop the block of `lineage` (and the newline the writer put after it). A page without it is returned unchanged. */
export function removeBundleBlock(html, lineage) {
  assertLineage(lineage);
  const existing = readBundleBlocks(html).find((b) => b.lineage === lineage);
  if (existing === undefined) return html;
  const tail = html[existing.end] === '\n' ? existing.end + 1 : existing.end;
  return `${html.slice(0, existing.index)}${html.slice(tail)}`;
}

// ---------------------------------------------------------------- the platform's wrappers
//
// The platform never hands a published page back as it was sent: `fetch(location.href)` and
// the Artifact tool's read return it INSIDE a wrapper of the platform's own, the kit's WHOLE
// document — doctype and all — in the wrapper's `<body>`, then `</body></html>`. Every
// reader unwraps first and every writer acts on the kit document; a republish sends the BARE
// kit page (artifactHtml.ts says why). Two wrappers have been measured and only those two are
// read — anything else is a named problem, never a guess:
//
//   the 0.2.67 SKELETON (2026-10-03, TASK-20261003 C3 — two REAL read-backs in
//     `scripts/fixtures/readback-0.2.67/`): `ARTIFACT_SKELETON_OPEN` byte-for-byte — charset,
//     viewport, a small reset and NOTHING else (no injected script in the stored source; the
//     live DOM has two) — then `\n`, the page, `\n</body></html>`. A chat-created artifact
//     and a tool-published one are stored alike. A page written as a FRAGMENT (its `<title>`
//     and `<style>` first, no doctype of its own) sits in that body as it is: a fragment is
//     not a kit document, so that form is refused by name, as is the skeleton around nothing.
//   the SEPTEMBER viewer (2026-09-06, TASK-20260905 AC13): a head carrying its frame runtime —
//     exactly two classic `<script>`s inside a comment fence — then a charset meta, a viewport
//     meta and a reset `<style>`, back to back. Read by SHAPE: the runtime's bodies were never
//     pinned (`scripts/fixtures/viewer-wrapper.mjs`).

/** The contract-0.2.67 skeleton through `<body>`: the 536 bytes both real read-backs open with. */
export const ARTIFACT_SKELETON_OPEN =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#faf9f5;color:#141413}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>';

/** What may sit before the September wrapper's `<html>` and between each pair of its head's elements, in order. */
const SEPTEMBER_HEAD_GAPS = ['<!doctype html>', '', '<!-- frame-runtime -->', '', '<!-- /frame-runtime -->', '', '', '</head>'];

const plainTag = (e, name) => e?.name === name && Object.keys(e.attrs).length === 0;

/** The September viewer's head: html, head, two classic scripts in the fence, charset, viewport, style, body — and only the measured text between them. */
function isSeptemberViewerHead(html, elements) {
  const [root, head, preamble, runtime, charset, viewport, style, body] = elements;
  const shaped =
    plainTag(root, 'html') && plainTag(head, 'head') && plainTag(preamble, 'script') && plainTag(runtime, 'script') &&
    charset?.name === 'meta' && charset.attrs.charset !== undefined &&
    viewport?.name === 'meta' && viewport.attrs.name === 'viewport' &&
    style?.name === 'style' && body?.name === 'body';
  if (!shaped) return false;
  const sequence = [root, head, preamble, runtime, charset, viewport, style, body];
  const gaps = [html.slice(0, root.index), ...sequence.slice(1).map((e, i) => html.slice(sequence[i].end, e.index))];
  return gaps.every((gap, i) => gap === SEPTEMBER_HEAD_GAPS[i]);
}

/**
 * The kit document lifted out of the platform's wrapper. Returns `{ html, wrapped: false }`
 * for a page that is not inside a measured wrapper (a bare kit page — anything else is then
 * refused by `verifyKitPage` or the caller's own checks), `{ html, wrapped: true }` for the
 * kit document out of ONE wrapper, or `{ wrapped: true, problem }` (no `html`). A SHAPE
 * check like `verifyKitPage`: the wrapper's body must open with nothing but the kit's doctype,
 * and nothing but `</body></html>` may follow the kit's `</html>`.
 */
export function unwrapViewerPage(html) {
  const elements = tokenizeTopLevel(html);
  const htmls = elements.filter((e) => e.name === 'html');
  const wrapper = html.startsWith(ARTIFACT_SKELETON_OPEN) ? 'the 0.2.67 skeleton' : isSeptemberViewerHead(html, elements) ? 'the September viewer wrapper' : undefined;
  if (wrapper === undefined) {
    if (htmls.length <= 1) return { html, wrapped: false };
    return { wrapped: true, problem: 'a wrapper whose head is neither the measured 0.2.67 skeleton (charset, viewport, reset — nothing else) nor the September viewer’s (its frame runtime, then charset, viewport, reset)' };
  }
  // Both heads were matched whole, so the first <body> is the wrapper's.
  const outerBody = elements.find((e) => e.name === 'body');
  if (htmls.length === 1) {
    const content = html.slice(outerBody.end).replace(/<\/body>\s*<\/html>\s*$/i, '');
    return content.trim() === ''
      ? { wrapped: true, problem: `${wrapper} carries nothing — there is no page inside it` }
      : { wrapped: true, problem: `${wrapper} carries a page fragment, not a kit document (no <!doctype html> of its own — a page written as a fragment)` };
  }
  const inner = htmls[1];
  const opening = html.slice(outerBody.end, inner.index);
  if (!/^\s*<!doctype html>\s*$/i.test(opening)) return { wrapped: true, problem: `${wrapper}’s body does not open with the kit document (its doctype)` };
  const start = outerBody.end + opening.search(/<!doctype html>/i);
  if (html.startsWith(ARTIFACT_SKELETON_OPEN, start)) return { wrapped: true, problem: `a skeleton inside a skeleton — ${wrapper} around another 0.2.67 skeleton, not around the kit page` };
  if (htmls.length > 2) return { wrapped: true, problem: `${htmls.length} <html> elements — a wrapper inside a wrapper, not one wrapper around the kit page` };
  const lower = html.toLowerCase();
  const outerClose = lower.lastIndexOf('</html>');
  const innerClose = outerClose === -1 ? -1 : lower.lastIndexOf('</html>', outerClose - 1);
  if (innerClose <= start) return { wrapped: true, problem: `the kit document inside ${wrapper} has no </html> of its own` };
  const between = html.slice(innerClose + '</html>'.length, outerClose);
  const after = html.slice(outerClose + '</html>'.length);
  if (!/^\s*(<\/body>)?\s*$/i.test(between) || !/^\s*$/.test(after)) {
    return { wrapped: true, problem: `content after the kit document inside ${wrapper} — not the shape the platform was measured to write` };
  }
  // The kit page ends in ONE newline (the build writes it) and the wrapper puts its own
  // before `</body>`: the first newline after the kit's `</html>` is the kit's.
  const end = innerClose + '</html>'.length;
  return { html: html.slice(start, html[end] === '\n' ? end + 1 : end), wrapped: true };
}

// ---------------------------------------------------------------------- verifyKitPage

/**
 * A SHAPE check on the page source the artifact record fetched before republishing — NOT a
 * security control: exactly one inline module script (the kit), a stamp equal to the
 * running page's, every other script a known data block, no `<script src>`, no `<link>`, a
 * doctype first, ONE `<html>`. What it catches is the viewer's INJECTED runtime, a platform
 * wrapper still around the kit document (the 0.2.67 skeleton injects no script, so only its
 * second `<html>` tells it apart — a save that published it would be stored as a skeleton
 * inside a skeleton) and a foreign or mismatched page (the contract forbids serializing the
 * live DOM — artifact.d.ts, 0.2.41 and 0.2.67 alike), so a republish never captures them.
 * It defends nothing against a page WRITER, who can edit the one module script and its
 * stamp: that boundary is the artifact's write permission (ADR-0065 §6 amendment).
 */
export function verifyKitPage(html, { expectedStamp }) {
  const problems = [];
  if (!/^\s*<!doctype html>/i.test(html)) problems.push('the page does not start with <!doctype html>');
  const elements = tokenizeTopLevel(html);
  const scripts = elements.filter((e) => e.name === 'script');
  for (const s of scripts) {
    if (s.attrs.src !== undefined) problems.push(`a <script src="${s.attrs.src}"> is on the page — the kit carries no external script`);
    else if (s.attrs.type === 'module') continue;
    else if (isDbBlock(s) || isBundleBlock(s)) continue;
    else problems.push(`an unknown inline <script${s.attrs.type ? ` type="${s.attrs.type}"` : ''}> is on the page — not the kit's, not a data block`);
  }
  const modules = scripts.filter((s) => s.attrs.src === undefined && s.attrs.type === 'module');
  if (modules.length !== 1) problems.push(`expected exactly one inline <script type="module">, found ${modules.length}`);
  for (const l of elements.filter((e) => e.name === 'link')) problems.push(`a <link rel="${l.attrs.rel ?? ''}"> is on the page — the kit carries no link element`);
  const stamps = elements.filter((e) => e.name === 'meta' && e.attrs.name === 'snug-host-build');
  if (stamps.length !== 1 || (stamps[0].attrs.content ?? '') !== expectedStamp) {
    problems.push(`the build stamp "${stamps[0]?.attrs.content ?? '(none)'}" is not this page's "${expectedStamp}"`);
  }
  const roots = elements.filter((e) => e.name === 'html').length;
  if (roots !== 1) problems.push(`the page carries ${roots} <html> elements — a platform wrapper is still around the kit document`);
  return problems;
}
