// access-wants.ts — the access declaration's reader (TASK-20261010-host-broker PR-5, contract v2
// D-PR5-2; ADR-0076 §11): what an app says, in its own HTML head, it would like to read from the
// user's other apps — `<meta name="snug:access-wants" content='[{"purpose": …, "hints": …}]'>`.
//
// PURE, DOM-FREE, TOTAL. No DOM (the db package's test env has none, and the host reads a 5 MB
// html without building a document), no throw (any input answers a value or `undefined`). The
// host derives the `accessWants:<appId>` row from the app's CURRENT html at every admission and
// on every import (`userdb/access.ts`), and the shared install preview reads a bundle's html in
// memory — one reader for both, so the row and the preview can never disagree.
//
// A SMALL GRAMMAR, NOT AN HTML PARSER. Any ambiguity is NO declaration — never a refusal of the
// install: the app works as before and simply shows nothing before its first ask.
//  - The scan reads at most `ACCESS_WANTS_SCAN_MAX_UNITS` UTF-16 code units from offset 0 and
//    stops at the FIRST `<script`, `<style`, `<body` or `</head` (ASCII-case-insensitive) that is
//    not inside a `<!-- … -->` comment; a comment is skipped whole, and an unterminated one
//    swallows the rest.
//  - EXACTLY one `<meta>` names `snug:access-wants` (the `name` attribute, ASCII-case-
//    insensitive); it carries exactly one QUOTED `content` (`"…"` or `'…'`). Two such metas, a
//    second `name`, an unquoted, missing or doubled `content` → none.
//  - The content decodes ONLY `&quot; &apos; &amp; &lt; &gt;`; any other reference (`&nbsp;`,
//    `&#39;`, `&AMP;`) → none; an `&` that starts no reference stays literal.
//  - The decoded text over `ACCESS_WANTS_MAX_BYTES` UTF-8 → none (never truncated); then
//    `JSON.parse` → `accessWantsSchema` → every string, key and value, well-formed (v2.1 N3: a
//    lone surrogate from a `\ud800` escape → none).
// A browser may read the head differently (a meta inside `<title>`, an attribute value holding
// `<script`): the html is the app author's own, so whichever parser reads it the declaration is
// the author's text. What matters is that every host reads it the same way — and this one does.

import { ACCESS_WANTS_MAX_BYTES, accessWantsSchema, utf8ByteLength, type AccessWants } from '@snugprotocol/protocol';

/** How much of the html the reader looks at, in UTF-16 code units — the head of any app fits; the 5 MB body is never scanned. */
export const ACCESS_WANTS_SCAN_MAX_UNITS = 65_536;

/** The meta name the declaration rides under. */
const ACCESS_WANTS_META = 'snug:access-wants';

const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
const isSpace = (ch: string | undefined): boolean => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';

/** Where the head ends for this reader — matched ASCII-case-insensitively at a `<`. */
const STOP_TOKENS = ['<script', '<style', '<body', '</head'];

interface MetaAttribute {
  /** ASCII-lower-cased. */
  name: string;
  value: string | undefined;
  quoted: boolean;
}

/**
 * The attributes of the tag whose name ends at `start`, and the index just past its `>` — or
 * `undefined` when the tag (or a quoted value) never closes inside the scanned text.
 */
function readAttributes(text: string, start: number): { attributes: MetaAttribute[]; end: number } | undefined {
  const attributes: MetaAttribute[] = [];
  let i = start;
  for (;;) {
    while (i < text.length && (isSpace(text[i]) || text[i] === '/')) i += 1;
    if (i >= text.length) return undefined;
    if (text[i] === '>') return { attributes, end: i + 1 };
    const nameStart = i;
    while (i < text.length && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '>' && text[i] !== '=') i += 1;
    // A lone `=` with no name before it is an empty name, as a browser reads it; it matches nothing here.
    if (i === nameStart && text[i] === '=') i += 1;
    const name = asciiLower(text.slice(nameStart, i));
    let j = i;
    while (j < text.length && isSpace(text[j])) j += 1;
    if (text[j] !== '=') {
      attributes.push({ name, value: undefined, quoted: false });
      continue;
    }
    j += 1;
    while (j < text.length && isSpace(text[j])) j += 1;
    const quote = text[j];
    if (quote === '"' || quote === "'") {
      const close = text.indexOf(quote, j + 1);
      if (close === -1) return undefined;
      attributes.push({ name, value: text.slice(j + 1, close), quoted: true });
      i = close + 1;
      continue;
    }
    const valueStart = j;
    while (j < text.length && !isSpace(text[j]) && text[j] !== '>') j += 1;
    attributes.push({ name, value: text.slice(valueStart, j), quoted: false });
    i = j;
  }
}

/** The five references the content may carry — and nothing else is decoded. */
const ENTITIES: Readonly<Record<string, string>> = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' };
/** Something a browser would read as a character reference: `&` + name or number + `;`. */
const REFERENCE = /&[#A-Za-z0-9]+;/y;

/** The content decoded by the five references, or `undefined` when it carries any other one. */
function decodeContent(raw: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) return out + raw.slice(i);
    out += raw.slice(i, amp);
    REFERENCE.lastIndex = amp;
    const match = REFERENCE.exec(raw);
    if (match === null) {
      out += '&'; // a bare `&` (or `&apos` without its `;`) is literal
      i = amp + 1;
      continue;
    }
    const decoded = ENTITIES[match[0]];
    if (decoded === undefined) return undefined;
    out += decoded;
    i = amp + match[0].length;
  }
  return out;
}

/**
 * The DECODED `content` of the ONE head meta whose `name` is `name` (ASCII-case-insensitive), or
 * `undefined` — none, two, a doubled `name` or `content`, an unquoted or missing `content`, or a
 * reference outside the five. Attribute order is free. Total.
 */
export function findHeadMeta(html: string, name: string): string | undefined {
  const text = html.length > ACCESS_WANTS_SCAN_MAX_UNITS ? html.slice(0, ACCESS_WANTS_SCAN_MAX_UNITS) : html;
  const wanted = asciiLower(name);
  let found: string | undefined;
  let matches = 0;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('<', i);
    if (open === -1) break;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close === -1) break; // an unterminated comment swallows the rest
      i = close + 3;
      continue;
    }
    const head = asciiLower(text.slice(open, open + 7));
    if (STOP_TOKENS.some((stop) => head.startsWith(stop))) break;
    const afterName = open + 5;
    const isMeta = head.startsWith('<meta') && (afterName >= text.length || isSpace(text[afterName]) || text[afterName] === '/' || text[afterName] === '>');
    if (!isMeta) {
      i = open + 1;
      continue;
    }
    const tag = readAttributes(text, afterName);
    if (tag === undefined) break; // a tag that never closes ends the head this reader can see
    i = tag.end;
    const names = tag.attributes.filter((attribute) => attribute.name === 'name');
    if (!names.some((attribute) => attribute.value !== undefined && asciiLower(attribute.value) === wanted)) continue;
    matches += 1;
    const contents = tag.attributes.filter((attribute) => attribute.name === 'content');
    const content = contents[0];
    found = names.length === 1 && contents.length === 1 && content?.quoted === true && content.value !== undefined ? decodeContent(content.value) : undefined;
  }
  return matches === 1 ? found : undefined;
}

/** A lone UTF-16 surrogate anywhere in the text. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Every string in a parsed JSON value — keys and values — is well-formed UTF-16 (v2.1 N3). */
function wellFormed(value: unknown): boolean {
  if (typeof value === 'string') return !LONE_SURROGATE.test(value);
  if (Array.isArray(value)) return value.every(wellFormed);
  if (typeof value === 'object' && value !== null) return Object.entries(value).every(([key, item]) => !LONE_SURROGATE.test(key) && wellFormed(item));
  return true;
}

/** The app's access declaration, read from its html head by the grammar above — or `undefined`. Total: never throws. */
export function extractAccessWants(html: string): AccessWants | undefined {
  const content = findHeadMeta(html, ACCESS_WANTS_META);
  if (content === undefined || utf8ByteLength(content) > ACCESS_WANTS_MAX_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return undefined;
  }
  const parsed = accessWantsSchema.safeParse(json);
  return parsed.success && wellFormed(parsed.data) ? parsed.data : undefined;
}
