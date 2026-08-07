#!/usr/bin/env node
// check-whitepaper.mjs — conformance checks for the Snug Protocol whitepaper
// (TASK-20260807-protocol-whitepaper, acceptance criteria AC1–AC8).
//
// The whitepaper is a DERIVATIVE publication: the spec repo is normative, the paper only
// explains it. So the paper must never be the place a constant, a frame name, or a rule
// drifts. This checker treats the published spec repo as a FIXTURE and fails when the
// paper and the spec disagree — the dependency direction that keeps prose honest as the
// protocol moves.
//
// Dependency-free on purpose (node: builtins + regexes), matching
// scripts/update-code-map-counts.mjs. Run via `pnpm run check-whitepaper`, or directly:
//   node scripts/check-whitepaper.mjs [--spec <path-to-spec-repo>]
//
// What each check enforces:
//   AC1  the PDF exists, is a real PDF, and is non-trivial in size
//   AC2  embedded PDF metadata carries the exact title and Author "Jeetu Maker"
//        (the cover page is not enough — metadata is what tooling and libraries read)
//   AC3  every protocol constant quoted in the paper matches spec/SPEC*.md
//   AC4  the frame table matches spec/schemas/*.json (type const + required fields)
//   AC5  v0.2 material is marked DRAFT; schema v3 / Dynamic Auth surfaces are absent
//   AC6  no unbuilt claim, no anti-positioning language
//   AC7  figures are inline vector SVG, numbered, and each referenced from the body
//   AC8  structural completeness (abstract, TOC, refs, running heads, licence…)
//
// Exit code 0 = all green; 1 = at least one failure (details on stderr).

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const WP = join(REPO, 'docs', 'whitepaper');
const SRC_HTML = join(WP, 'src', 'paper.html');
const FIG_DIR = join(WP, 'src', 'figures');
const PDF = join(WP, 'dist', 'snug-protocol-whitepaper.pdf');

const specArgIdx = process.argv.indexOf('--spec');
const SPEC = specArgIdx !== -1 ? resolve(process.argv[specArgIdx + 1]) : resolve(REPO, '..', 'spec');

export const EXPECTED_TITLE = 'The Snug Protocol: An Open Protocol for Agent-Backed Personal Software';
export const EXPECTED_AUTHOR = 'Jeetu Maker';

// ---------------------------------------------------------------- tiny check harness

const failures = [];
const passes = [];

/** Record a check result. `detail` is only shown on failure. */
function check(id, name, ok, detail = '') {
  if (ok) passes.push(`${id} ${name}`);
  else failures.push(`${id} ${name}${detail ? `\n      ${detail}` : ''}`);
  return ok;
}

const read = (p) => readFileSync(p, 'utf8');
/** Collapse HTML to its visible-ish text so prose checks are not defeated by markup. */
const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ');

// ---------------------------------------------------------------- fixtures (the spec)

function loadSpecFixtures() {
  const specMd = join(SPEC, 'SPEC.md');
  const draftMd = join(SPEC, 'SPEC-v0.2-draft.md');
  const schemaDir = join(SPEC, 'schemas');
  if (!existsSync(specMd) || !existsSync(schemaDir)) {
    console.error(`FATAL: spec repo not found at ${SPEC} (pass --spec <path>)`);
    process.exit(2);
  }
  const schemas = {};
  for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
    schemas[f] = JSON.parse(read(join(schemaDir, f)));
  }
  return {
    spec: read(specMd),
    draft: existsSync(draftMd) ? read(draftMd) : '',
    schemas,
  };
}

/**
 * Pull every `const` string a schema pins as a message `type` (frames nest theirs inside
 * anyOf/oneOf branches, so this walks the whole tree rather than reading a fixed path).
 */
function collectTypeConsts(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collectTypeConsts(n, out);
    return out;
  }
  if (node.properties?.type?.const) out.add(node.properties.type.const);
  for (const v of Object.values(node)) collectTypeConsts(v, out);
  return out;
}

// ---------------------------------------------------------------- AC1 / AC2 — the PDF

/**
 * Read PDF document metadata without a PDF library. Chrome writes a classic `/Info`
 * dictionary; strings are either literal `(...)` (with escapes) or hex `<...>`, and may be
 * UTF-16BE with a BOM. Latin-1 decoding of the raw bytes keeps byte offsets intact.
 */
function pdfInfo(buf) {
  const raw = buf.toString('latin1');
  const out = {};
  for (const key of ['Title', 'Author', 'Subject', 'Creator']) {
    // Literal string: /Key (value) — allow escaped parens inside.
    const lit = raw.match(new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
    if (lit) {
      out[key] = decodePdfLiteral(lit[1]);
      continue;
    }
    // Hex string: /Key <48656C6C6F>
    const hex = raw.match(new RegExp(`/${key}\\s*<([0-9A-Fa-f\\s]+)>`));
    if (hex) out[key] = decodePdfHex(hex[1]);
  }
  return out;
}

function decodePdfLiteral(s) {
  const unescaped = s.replace(/\\([nrtbf()\\])/g, (_, c) =>
    ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c,
  );
  return maybeUtf16(Buffer.from(unescaped, 'latin1'));
}

function decodePdfHex(s) {
  const clean = s.replace(/\s+/g, '');
  return maybeUtf16(Buffer.from(clean.length % 2 ? clean + '0' : clean, 'hex'));
}

/** PDF text strings carry a UTF-16BE BOM when non-ASCII; otherwise they are PDFDocEncoding. */
function maybeUtf16(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.subarray(2).swap16().toString('utf16le');
  return buf.toString('latin1');
}

function checkPdf() {
  if (!check('AC1', 'PDF exists', existsSync(PDF), `expected ${PDF} — run: node docs/whitepaper/build.mjs`)) {
    check('AC2', 'PDF metadata (title + author)', false, 'skipped — no PDF');
    return;
  }
  const buf = readFileSync(PDF);
  const size = statSync(PDF).size;
  check('AC1', 'PDF is a valid, non-trivial document',
    buf.subarray(0, 5).toString() === '%PDF-' && size > 100_000,
    `header=${buf.subarray(0, 5).toString()} size=${size}B (expect %PDF- and >100KB)`);

  const info = pdfInfo(buf);
  check('AC2', 'PDF /Title is the whitepaper title', info.Title === EXPECTED_TITLE,
    `found: ${JSON.stringify(info.Title ?? null)}`);
  check('AC2', `PDF /Author is exactly "${EXPECTED_AUTHOR}"`, info.Author === EXPECTED_AUTHOR,
    `found: ${JSON.stringify(info.Author ?? null)}`);
}

// ---------------------------------------------------------------- AC3 — constants

/**
 * Constants the paper is allowed to state, each with the spec text that must also contain
 * it. A constant present in the paper but ABSENT from its spec source is drift and fails.
 * Stated as regexes because the paper may render "256 KiB" or "256&nbsp;KiB".
 */
const CONSTANTS = [
  { label: 'frame size cap 256 KiB', paper: /256\s*(?:&nbsp;|\s)?KiB/i, spec: /256\s*KiB/i, src: 'spec' },
  { label: 'db frame cap 8 MiB', paper: /8\s*(?:&nbsp;|\s)?MiB/i, spec: /8\s*MiB/i, src: 'spec' },
  { label: 'artifact cap 5 MiB', paper: /5\s*(?:&nbsp;|\s)?MiB/i, spec: /5\s*MiB/i, src: 'spec' },
  { label: 'rawExcerpt 200 chars', paper: /200\s*(?:&nbsp;|\s)?chars/i, spec: /200\s*chars/i, src: 'spec' },
  { label: 'displayName cap 80', paper: /displayName\s*(?:&nbsp;|\s)?80/i, spec: /displayName\s*80/i, src: 'spec' },
  { label: 'description cap 400', paper: /description\s*(?:&nbsp;|\s)?400/i, spec: /description\s*400/i, src: 'spec' },
  { label: 'parse-failure budget 3', paper: /3\s*consecutive/i, spec: /3\s*consecutive/i, src: 'spec' },
  { label: 'backoff 100/250/500 ms', paper: /100\s*\/\s*250\s*\/\s*500/, spec: /100\/250\/500/, src: 'spec' },
  { label: 'MAX_USERDB_BYTES 64 MiB', paper: /64\s*(?:&nbsp;|\s)?MiB/i, spec: /64\s*MiB/i, src: 'draft' },
  { label: 'VERSIONS_RETAINED 5', paper: /VERSIONS_RETAINED/, spec: /VERSIONS_RETAINED/, src: 'draft' },
];

function checkConstants(html, fx) {
  const text = stripTags(html);
  for (const c of CONSTANTS) {
    const inPaper = c.paper.test(text) || c.paper.test(html);
    if (!inPaper) {
      check('AC3', `constant present: ${c.label}`, false, `not found in paper text`);
      continue;
    }
    const source = c.src === 'draft' ? fx.draft : fx.spec;
    check('AC3', `constant matches spec: ${c.label}`, c.spec.test(source),
      `paper states it but ${c.src === 'draft' ? 'SPEC-v0.2-draft.md' : 'SPEC.md'} does not — drift`);
  }

  // The appDataToken rule is the subtlest normative claim in the paper; pin its shape.
  check('AC3', 'appDataToken rule stated as in the draft',
    /32\s*(?:&nbsp;|\s)?lowercase\s*hex/i.test(text) && /32 lowercase hex/i.test(fx.draft),
    'the UUID → 32 lowercase hex mapping must match SPEC-v0.2-draft.md §2.2');
}

// ---------------------------------------------------------------- AC4 — frame table

function checkFrames(html, fx) {
  const text = stripTags(html);
  const specTypes = new Set();
  for (const s of Object.values(fx.schemas)) for (const t of collectTypeConsts(s)) specTypes.add(t);

  check('AC4', 'schemas expose the expected frame count', specTypes.size === 9,
    `found ${specTypes.size} snug:* type consts in spec/schemas: ${[...specTypes].join(', ')}`);

  for (const t of [...specTypes].sort()) {
    check('AC4', `frame documented: ${t}`, text.includes(t), `"${t}" appears in schemas but not in the paper`);
  }

  // The chat envelope is schema'd without a `type` const (it is tag-delimited, not a frame).
  const env = fx.schemas['app-request-envelope.json'];
  if (env) {
    const required = env.required ?? [];
    check('AC4', 'chat envelope required fields documented',
      required.every((f) => text.includes(f)),
      `missing from paper: ${required.filter((f) => !text.includes(f)).join(', ')}`);
    check('AC4', 'chat envelope marker documented',
      /\[SNUG_APP_REQUEST\]/.test(text) && /snug["\s:]*1/.test(text),
      'the tag prefix + snug:1 marker pair is the detection rule (R1)');
  }

  // Error codes are an open set, but the known codes must all be listed (R5).
  const codes = (fx.spec.match(/`([A-Z_]{4,})`/g) ?? [])
    .map((m) => m.replace(/`/g, ''))
    .filter((c) => /^[A-Z][A-Z_]+$/.test(c) && c !== 'SNUG_APP_REQUEST' && c !== 'MAX_USERDB_BYTES');
  const missingCodes = [...new Set(codes)].filter((c) => !text.includes(c));
  check('AC4', 'all R5 error codes documented', missingCodes.length === 0,
    `missing from paper: ${missingCodes.join(', ')}`);
}

// ---------------------------------------------------------------- AC5 — draft marking

/** Surfaces deliberately excluded from publication (schema v3 / Dynamic Auth / broker). */
const EXCLUDED = [
  /schema\s*v3/i,
  /user_version\s*=\s*3/i,
  /snug_auth_specs/i,
  /dynamic\s*auth/i,
  /connected[-\s]?fetch/i,
  /net-request/i,
  /net-response/i,
  /credential\s*broker/i,
];

function checkDraftMarking(html) {
  const text = stripTags(html);
  check('AC5', 'v0.2 material is marked DRAFT', /\bDRAFT\b/.test(text) && /v0\.2/i.test(text),
    'the portable-user-database section must carry an explicit DRAFT marking');

  for (const re of EXCLUDED) {
    check('AC5', `excluded surface absent: ${re.source}`, !re.test(text),
      'schema v3 / Dynamic Auth is deliberately unpublished — see SPEC-v0.2-draft.md version note');
  }
}

// ---------------------------------------------------------------- AC6 — claim discipline

/**
 * Anti-positioning rules (internal/01-extraction-launch-plan.md §1) and the
 * never-claim-unbuilt rule (ADR-0003). `host-blind` is banned outright: the honest term is
 * publisher-blind until a KeyProvider ships (ADR-0014 §5).
 */
const FORBIDDEN = [
  { re: /no-code/i, why: 'anti-positioning: never "no-code"' },
  { re: /alternative to (claude )?(artifacts|bolt|v0|replit)/i, why: 'anti-positioning: never framed as an alternative to Artifacts/Bolt/v0' },
  { re: /host-blind/i, why: 'claim discipline: publisher-blind, never host-blind (ADR-0003/0014)' },
  { re: /zero[-\s]knowledge/i, why: 'claim discipline: no cryptographic custody claim is supported' },
  { re: /end-to-end encrypted/i, why: 'claim discipline: not implemented' },
  { re: /military[-\s]grade/i, why: 'unsupportable security claim' },
];

function checkClaims(html) {
  const text = stripTags(html);
  for (const f of FORBIDDEN) {
    check('AC6', `forbidden framing absent: ${f.re.source}`, !f.re.test(text), f.why);
  }
  // The honest custody claim must be present where secrets are discussed (ADR-0014 §5).
  check('AC6', 'at-rest secrets trade-off stated honestly',
    /trade-?off/i.test(text) && /snug_secrets/.test(text),
    '§5.4 must state the persistent at-rest storage trade-off rather than eliding it');
}

// ---------------------------------------------------------------- AC7 — figures

function checkFigures(html) {
  if (!check('AC7', 'figures directory exists', existsSync(FIG_DIR), `expected ${FIG_DIR}`)) return;

  const svgs = readdirSync(FIG_DIR).filter((f) => f.endsWith('.svg'));
  check('AC7', 'at least 7 figures authored', svgs.length >= 7, `found ${svgs.length}`);

  check('AC7', 'no raster images anywhere in the paper',
    !/<img\b/i.test(html) && !/data:image\/(png|jpe?g|gif|webp)/i.test(html),
    'figures must be inline vector SVG');

  // Every <figure> must carry a numbered caption, and each number must be cited in prose.
  const captions = [...html.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi)]
    .map((m) => stripTags(m[1]).trim());
  check('AC7', 'every figure has a caption', captions.length >= 7,
    `found ${captions.length} figcaptions for ${svgs.length} figures`);

  const numbered = captions.filter((c) => /Figure\s+\d+/i.test(c));
  check('AC7', 'captions are numbered "Figure N"', numbered.length === captions.length,
    `unnumbered: ${captions.filter((c) => !/Figure\s+\d+/i.test(c)).join(' | ')}`);

  const text = stripTags(html);
  const unreferenced = [];
  for (const c of numbered) {
    const n = c.match(/Figure\s+(\d+)/i)[1];
    // A reference is any mention of "Figure N" beyond the caption itself.
    const mentions = [...text.matchAll(new RegExp(`Fig(?:ure|\\.)\\s*${n}\\b`, 'gi'))].length;
    if (mentions < 2) unreferenced.push(n);
  }
  check('AC7', 'every figure is referenced from the body text', unreferenced.length === 0,
    `never cited in prose: Figure ${unreferenced.join(', ')}`);

  // Inline, not linked — the PDF must not depend on external files at render time.
  check('AC7', 'figures are inlined into the document', (html.match(/<svg\b/gi) ?? []).length >= 7,
    'build must inline each figure SVG so the PDF has no external asset dependency');
}

// ---------------------------------------------------------------- AC8 — structure

function checkStructure(html) {
  const text = stripTags(html);
  const required = [
    { label: 'abstract', re: /\bAbstract\b/ },
    { label: 'table of contents', re: /\bContents\b/i },
    { label: 'introduction section', re: /\bIntroduction\b/ },
    { label: 'security model section', re: /Security Model/i },
    { label: 'conformance section', re: /\bConformance\b/i },
    { label: 'related work section', re: /Related Work/i },
    { label: 'limitations section', re: /Limitations/i },
    { label: 'normative references', re: /Normative References/i },
    { label: 'appendix', re: /\bAppendix\b/i },
    { label: 'author byline', re: new RegExp(EXPECTED_AUTHOR) },
    { label: 'MIT licence note', re: /\bMIT\b/ },
    { label: 'security contact', re: /security@snugprotocol\.org/ },
  ];
  for (const r of required) check('AC8', `has ${r.label}`, r.re.test(text));

  // Print furniture lives in CSS, not the DOM.
  const cssPath = join(WP, 'src', 'paper.css');
  if (check('AC8', 'stylesheet exists', existsSync(cssPath), `expected ${cssPath}`)) {
    const css = read(cssPath);
    check('AC8', 'A4 page geometry declared', /@page\b/.test(css) && /A4/i.test(css));
    check('AC8', 'running heads / page numbers declared',
      /@top-(center|left|right)/.test(css) || /@bottom-(center|left|right)/.test(css),
      'margin boxes are what put running heads and folios on every page');
    check('AC8', 'section + figure counters declared',
      /counter-reset/.test(css) && /counter-increment/.test(css));
  }
}

// ---------------------------------------------------------------- run

function main() {
  const fx = loadSpecFixtures();

  if (!existsSync(SRC_HTML)) {
    console.error(`FATAL: whitepaper source not found at ${SRC_HTML}`);
    console.error('This checker is written test-first; it is expected to fail until the paper exists.');
    process.exit(1);
  }
  const html = read(SRC_HTML);

  checkPdf();
  checkConstants(html, fx);
  checkFrames(html, fx);
  checkDraftMarking(html);
  checkClaims(html);
  checkFigures(html);
  checkStructure(html);

  const total = passes.length + failures.length;
  if (failures.length) {
    console.error(`\n✗ whitepaper checks: ${failures.length}/${total} FAILED\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✓ whitepaper checks: ${total}/${total} passed (spec fixture: ${SPEC})`);
}

main();
