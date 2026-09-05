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

/** Insert `block` before the LAST `</body>` (case-insensitive); with no `</body>`, append. */
function insertBeforeBodyEnd(html, block) {
  const at = html.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
  return at === -1 ? `${html}\n${block}\n` : `${html.slice(0, at)}${block}\n${html.slice(at)}`;
}

function refuseCloser(text, label) {
  if (/<\/script/i.test(text) || /<!--/.test(text)) throw new Error(`page-blocks: the ${label} contains a sequence that would end or escape the block`);
}

// ---------------------------------------------------------------------------- db block

/**
 * The db block, or `undefined` when the page carries none, or `{ corrupt }` when a block is
 * present but its manifest is unreadable — an unreadable block is never "no file" (lesson
 * 2026-08-22).
 */
export function readDbBlock(html) {
  const block = tokenizeTopLevel(html).find(isDbBlock);
  if (block === undefined) return undefined;
  const body = block.body ?? '';
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
  return { manifest, base64: nl === -1 ? '' : body.slice(nl + 1).trim(), index: block.index, end: block.end };
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

// ---------------------------------------------------------------------- verifyKitPage

/**
 * Is `html` the kit page and nothing else? The artifact record calls this on the CANONICAL
 * source it fetched before republishing (the contract forbids serializing the live DOM: the
 * viewer injects its runtime — artifact.d.ts 0.2.41). A page that fails is never published:
 * exactly one inline module script (the kit), a stamp equal to the running page's, every
 * other script a known data block, no `<script src>`, no `<link>`, a doctype first.
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
  return problems;
}
