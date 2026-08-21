#!/usr/bin/env node
// check-whitepaper.mjs — conformance checks for the Snug Protocol whitepaper, edition 2
// (TASK-20260820-spec-v03-whitepaper; edition 1 checker was TASK-20260807, AC1–AC8).
//
// The whitepaper is a DERIVATIVE publication: the spec is normative, the paper only
// explains it. So the paper must never be the place a constant, a frame name, or a rule
// drifts. This checker treats the spec as a FIXTURE and fails when the two disagree.
//
// Edition-2 fixture: the STAGED consolidated draft (docs/spec-drafts/SPEC-v0.3-draft.md)
// plus the published schemas exported from packages/protocol — the monorepo is the master
// (SPEC_SYNC), so pre-publication the paper is checked against the staged spec. After the
// v0.3 push, point --spec at a spec-repo clone and the same checks run against it.
//
// Dependency-free on purpose (node: builtins + regexes). Run via
// `pnpm run check-whitepaper`, or directly:
//   node scripts/check-whitepaper.mjs [--spec <path-to-spec-repo>]
//
// What each check enforces:
//   AC1  the PDF exists, is a real PDF, and is non-trivial in size
//   AC2  embedded PDF metadata carries the exact title and Author "Jeetu Maker"
//   AC3  every protocol constant quoted in the paper matches the spec draft
//   AC4  the frame inventory matches schemas + the draft (13 frames); R5/NET codes listed
//   AC5  v0.3 surfaces are COVERED and marked DRAFT; superseded facts absent
//   AC6  claim discipline: forbidden framings absent; bounded claims stay bounded
//   AC7  figures are inline vector, numbered, and each cited in prose
//   AC8  structural completeness; section numbering cannot drift
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
const SPEC_OVERRIDE = specArgIdx !== -1 ? resolve(process.argv[specArgIdx + 1]) : null;

export const EXPECTED_TITLE = 'The Snug Protocol: An Open Protocol for Agent-Backed Personal Software';
export const EXPECTED_AUTHOR = 'Jeetu Maker';

// ---------------------------------------------------------------- tiny check harness

const failures = [];
const passes = [];

function check(id, name, ok, detail = '') {
  if (ok) passes.push(`${id} ${name}`);
  else failures.push(`${id} ${name}${detail ? `\n      ${detail}` : ''}`);
  return ok;
}

const read = (p) => readFileSync(p, 'utf8');

/**
 * Collapse HTML to the text a READER sees. Comments go first and deliberately: authoring
 * notes routinely mention the very strings the claim checks ban, and a comment is not
 * prose. Prose checks that fire on comments are checking the wrong document.
 */
const stripTags = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ');

// ---------------------------------------------------------------- assemble under test

/** Reproduce build.mjs's figure inlining so checks run against what a reader receives. */
function assembleForCheck() {
  const src = read(SRC_HTML);
  return src.replace(/<!--FIGURE:([a-z0-9-]+)\|([^|]*)\|([\s\S]*?)-->/g, (_m, name, _label, caption) => {
    const p = join(FIG_DIR, `${name}.svg`);
    if (!existsSync(p)) return `<figure><!-- MISSING FIGURE ${name} --></figure>`;
    const svg = read(p).replace(/<\?xml[^>]*\?>\s*/, '').trim();
    return `<figure>\n${svg}\n<figcaption>${caption.trim()}</figcaption>\n</figure>`;
  });
}

// ---------------------------------------------------------------- fixtures (the spec)

function loadSpecFixtures() {
  // Draft prose: the staged consolidated spec (or the same file in a --spec clone).
  const draftCandidates = SPEC_OVERRIDE
    ? [join(SPEC_OVERRIDE, 'SPEC-v0.3-draft.md'), join(SPEC_OVERRIDE, 'SPEC.md')]
    : [join(REPO, 'docs', 'spec-drafts', 'SPEC-v0.3-draft.md')];
  const draftPath = draftCandidates.find(existsSync);
  // Schemas: byte-authoritative from packages/protocol unless a spec clone is given.
  const schemaDir = SPEC_OVERRIDE
    ? join(SPEC_OVERRIDE, 'schemas')
    : join(REPO, 'packages', 'protocol', 'schemas');
  if (!draftPath || !existsSync(schemaDir)) {
    console.error(`FATAL: spec fixture not found (draft: ${draftCandidates.join(' | ')}; schemas: ${schemaDir})`);
    process.exit(2);
  }
  const schemas = {};
  for (const f of readdirSync(schemaDir).filter((f) => f.endsWith('.json'))) {
    schemas[f] = JSON.parse(read(join(schemaDir, f)));
  }
  return { spec: read(draftPath), specPath: draftPath, schemas };
}

/** Pull every `const` string a schema pins as a message `type`. */
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

function pdfInfo(buf) {
  const raw = buf.toString('latin1');
  const out = {};
  for (const key of ['Title', 'Author', 'Subject', 'Creator']) {
    const lit = raw.match(new RegExp(`/${key}\\s*\\(((?:\\\\.|[^\\\\)])*)\\)`));
    if (lit) {
      out[key] = decodePdfLiteral(lit[1]);
      continue;
    }
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
 * Constants the paper states, each with the spec text that must also contain it.
 * A constant present in the paper but ABSENT from the spec draft is drift and fails.
 */
const CONSTANTS = [
  { label: 'frame size cap 256 KiB', paper: /256\s*(?:&nbsp;|\s)?KiB/i, spec: /256\s*KiB/i },
  { label: 'db frame cap 8 MiB', paper: /8\s*(?:&nbsp;|\s)?MiB/i, spec: /8\s*MiB/i },
  { label: 'net frame cap 1 MiB + 64 KiB', paper: /1\s*MiB\s*\+\s*64\s*KiB/i, spec: /1\s*MiB\s*\+\s*64\s*KiB/i },
  { label: 'artifact cap 5 MiB', paper: /5\s*(?:&nbsp;|\s)?MiB/i, spec: /5\s*MiB/i },
  { label: 'rawExcerpt 200 chars', paper: /200\s*(?:&nbsp;|\s)?chars/i, spec: /200\s*chars/i },
  { label: 'displayName cap 80', paper: /displayName\s*(?:&nbsp;|\s)?80/i, spec: /displayName\s*80/i },
  { label: 'description cap 400', paper: /description\s*(?:&nbsp;|\s)?400/i, spec: /description\s*400/i },
  { label: 'parse-failure budget 3', paper: /3\s*consecutive/i, spec: /3\s*consecutive/i },
  { label: 'backoff 100/250/500 ms', paper: /100\s*\/\s*250\s*\/\s*500/, spec: /100\/250\/500/ },
  { label: 'MAX_USERDB_BYTES 64 MiB', paper: /64\s*(?:&nbsp;|\s)?MiB/i, spec: /64\s*MiB/i },
  { label: 'VERSIONS_RETAINED 5', paper: /VERSIONS_RETAINED/, spec: /VERSIONS_RETAINED/ },
  { label: 'storage schema version 6', paper: /user_version|schema version\s*[—-]?\s*\n?\s*currently 6|currently 6/i, spec: /user_version.*currently\s*\*?\*?6|currently 6/i },
  { label: 'runtime contract cap 2560 bytes', paper: /2560\s*bytes/i, spec: /2560\s*bytes/i },
  { label: 'PBKDF2 600,000 iterations', paper: /600,000\s*iterations/i, spec: /600,000/ },
  { label: 'data-lane bounds 200 rows / 32 KiB', paper: /200\s*rows\s*\/\s*32\s*KiB/i, spec: /200\s*rows\s*\/\s*32\s*KiB/i },
];

function checkConstants(html, fx) {
  const text = stripTags(html);
  for (const c of CONSTANTS) {
    const inPaper = c.paper.test(text) || c.paper.test(html);
    if (!inPaper) {
      check('AC3', `constant present: ${c.label}`, false, `not found in paper text`);
      continue;
    }
    check('AC3', `constant matches spec: ${c.label}`, c.spec.test(fx.spec),
      `paper states it but the spec draft does not — drift`);
  }

  // The appDataToken rule is the subtlest normative claim in the paper; pin its shape.
  check('AC3', 'appDataToken rule stated as in the draft',
    /32\s*(?:&nbsp;|\s)?lowercase\s*hex/i.test(text) && /32 lowercase hex/i.test(fx.spec),
    'the UUID → 32 lowercase hex mapping must match the spec draft');

  // The seven-kind set: the paper and spec must agree on the full enumeration.
  const KINDS = ['api_key', 'bearer_token', 'basic_auth', 'oauth2_client_creds', 'oauth2_auth_code', 'linked_device', 'none'];
  const missingPaper = KINDS.filter((k) => !text.includes(k));
  const missingSpec = KINDS.filter((k) => !fx.spec.includes(k));
  check('AC3', 'all seven connection kinds documented', missingPaper.length === 0,
    `missing from paper: ${missingPaper.join(', ')}`);
  check('AC3', 'all seven connection kinds present in spec draft', missingSpec.length === 0,
    `missing from spec: ${missingSpec.join(', ')}`);
}

// ---------------------------------------------------------------- AC4 — frame inventory

const V03_FRAMES = ['snug:net-request', 'snug:net-response', 'snug:open-url-request', 'snug:open-url-result'];

function checkFrames(html, fx) {
  const text = stripTags(html);
  const specTypes = new Set();
  for (const s of Object.values(fx.schemas)) for (const t of collectTypeConsts(s)) specTypes.add(t);

  check('AC4', 'published schemas expose the nine core frame types', specTypes.size === 9,
    `found ${specTypes.size} snug:* type consts in schemas: ${[...specTypes].join(', ')}`);

  for (const t of [...specTypes].sort()) {
    check('AC4', `frame documented: ${t}`, text.includes(t), `"${t}" appears in schemas but not in the paper`);
  }

  // The four v0.3 frames must be documented in BOTH the paper and the spec draft.
  for (const t of V03_FRAMES) {
    check('AC4', `v0.3 frame documented: ${t}`, text.includes(t) && fx.spec.includes(t),
      `"${t}" must appear in the paper and the spec draft`);
  }

  check('AC4', 'paper states the thirteen-frame inventory', /[Tt]hirteen frame types/.test(text),
    'the frame table intro must state the current count');

  // Chat envelope required fields + detection rule.
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

  // R5 core codes: every code named in the draft's R5 must be in the paper, exactly.
  const r5Spec = fx.spec.match(/R5 Error codes[\s\S]*?(?=- \*\*R6)/);
  if (r5Spec) {
    const setOf = (s) => new Set((s.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? [])
      .filter((c) => !['MAX', 'NET'].includes(c)));
    const coreCodes = [...setOf(r5Spec[0])].filter((c) => !c.startsWith('NET_'));
    const missing = coreCodes.filter((c) => !text.includes(c));
    check('AC4', 'all R5 core error codes documented', missing.length === 0,
      `missing from paper: ${missing.join(', ')}`);
  }

  // The paper's own R5 list must not contain a code the spec omits.
  const r5Paper = text.match(/The known codes are([\s\S]*?)(?:Receivers treat|MALFORMED is defined)/);
  if (r5Spec && r5Paper) {
    const setOf = (s) => new Set((s.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? []));
    const specSet = setOf(r5Spec[0]);
    const extra = [...setOf(r5Paper[1])].filter((c) => !specSet.has(c));
    check('AC4', "paper's R5 list contains no code the spec omits", extra.length === 0,
      `paper lists as a known code but the spec R5 does not: ${extra.join(', ')}`);
  }
}

// ---------------------------------------------------------------- AC5 — coverage + drift

/** v0.3 surfaces the paper MUST now cover (the inverse of edition 1's exclusions). */
const REQUIRED_SURFACES = [
  { label: 'connected applications section', re: /Connected applications/i },
  { label: 'frozen host ceiling', re: /frozen (host )?ceiling/i },
  { label: 'linked-device section', re: /Linked-device connections/i },
  { label: 'symbolic host / unix socket', re: /symbolic host/i },
  { label: 'runtime contracts', re: /runtime contract/i },
  { label: 'lane classification fails closed', re: /never a default lane|fails? closed/i },
  { label: '.snug naming rule', re: /user\.snug/ },
  { label: 'leading-bytes format rule', re: /leading bytes/i },
  { label: 'SNUGENC1 container', re: /SNUGENC1/ },
  { label: 'recovery key requirement', re: /recovery key/i },
  { label: 'unrecoverable-loss disclosure', re: /unrecoverable/i },
  { label: 'pseudonymisation backstop', re: /pseudonymisation/i },
  { label: 'the doctrine (proposes/approves)', re: /model proposes.*human approves|human approves.*host (enforces|freezes)/i },
];

/** Facts that would mark the paper as stale — superseded by the current draft. */
const SUPERSEDED = [
  { re: /snug_auth_specs/, why: 'table dropped at storage v5 — must not be described' },
  { re: /user_version\s*=\s*[234]\b/, why: 'storage schema is 6' },
  { re: /\bnine frame types are defined\b/i, why: 'the inventory is thirteen' },
  { re: /kind set is closed at six|[Ss]ix kinds/, why: 'seven kinds since linked_device' },
  { re: /credential broker/i, why: 'broker/subscription custody is unbuilt — never described as existing' },
];

function checkCoverage(html) {
  const text = stripTags(html);
  check('AC5', 'v0.3 material is marked DRAFT',
    /\bdraft\b/i.test(text) && /v0\.3/i.test(text) && /not\s+yet\s+normative/i.test(text),
    'v0.3 sections must carry an explicit DRAFT marking and say they are not yet normative');

  for (const s of REQUIRED_SURFACES) {
    check('AC5', `v0.3 surface covered: ${s.label}`, s.re.test(text),
      'the v0.3 spec surface must be covered by this edition');
  }
  for (const s of SUPERSEDED) {
    check('AC5', `superseded fact absent: ${s.re.source}`, !s.re.test(text), s.why);
  }

  // Provisional marking: standing approvals must be flagged as such wherever described.
  if (/standing approval/i.test(text)) {
    check('AC5', 'standing approvals marked provisional',
      /provisional/i.test(text) && /arming channel/i.test(text),
      'the standing-approval surface is provisional; the paper must say so and note the unspecified arming channel');
  }
}

// ---------------------------------------------------------------- AC6 — claim discipline

const FORBIDDEN = [
  { re: /no-code/i, why: 'anti-positioning: never "no-code"' },
  { re: /alternative to (claude )?(artifacts|bolt|v0|replit)/i, why: 'anti-positioning: never framed as an alternative to Artifacts/Bolt/v0' },
  { re: /military[-\s]grade/i, why: 'unsupportable security claim' },
];

/**
 * Terms that may appear ONLY in negation ("not zero-knowledge", "not end-to-end
 * encryption"): ADR-0043's bounded claim requires naming them to disclaim them.
 */
const NEGATION_ONLY = [
  { re: /zero[-\s]knowledge/gi, label: 'zero-knowledge' },
  { re: /end-to-end encrypt\w*/gi, label: 'end-to-end encryption' },
];

function checkNegationOnly(text) {
  for (const t of NEGATION_ONLY) {
    const offending = [];
    for (const m of text.matchAll(t.re)) {
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (!/\b(not|never|no|nor|neither)\b[^.]*$/i.test(before)) offending.push(text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10).trim());
    }
    check('AC6', `${t.label} appears only in negation`, offending.length === 0,
      `assertive use found: ${offending.join(' | ')}`);
  }
}

/** "host-blind" may be named only to DISCLAIM it (ADR-0003/0014). */
function checkHostBlind(text) {
  const asserted = /(?:is|are|we are|it['’]s|fully|truly|provides?|guarantees?|offers?)\s+(?:a\s+)?host-blind/i;
  const negated = /(?:no|never|not|without)\b[^.]{0,60}host-blind/i;
  const hits = [...text.matchAll(/[^.]*host-blind[^.]*\./gi)].map((m) => m[0].trim());
  const offending = hits.filter((s) => asserted.test(s) && !negated.test(s));
  check('AC6', 'host-blind is disclaimed, never claimed', offending.length === 0,
    `assertive use found: ${offending.join(' | ')} (ADR-0003/0014: publisher-blind, never host-blind)`);
}

function checkClaims(html) {
  const text = stripTags(html);
  for (const f of FORBIDDEN) {
    check('AC6', `forbidden framing absent: ${f.re.source}`, !f.re.test(text), f.why);
  }
  checkNegationOnly(text);
  checkHostBlind(text);

  check('AC6', 'at-rest secrets trade-off stated honestly',
    /trade-?off/i.test(text) && /snug_secrets/.test(text),
    'the persistent at-rest storage trade-off must be stated rather than elided');

  // ADR-0043: the encryption claim must be bounded wherever it is made.
  if (/passphrase/i.test(text)) {
    check('AC6', 'encryption claim carries the ADR-0043 bound',
      /only (the user|they|you) holds?/i.test(text) && /unrecoverable/i.test(text),
      'passphrase protection must be claimed as "a passphrase only the user holds" with the unrecoverable-loss disclosure');
  }

  // ADR-0040: the pseudonymisation class statement must travel with the feature.
  if (/pseudonymis/i.test(text)) {
    check('AC6', 'pseudonymisation carries the honest class statement',
      /anti-default/i.test(text) && /not anti-adversarial/i.test(text),
      'ADR-0040 §5: the backstop is anti-default and anti-naive, NOT anti-adversarial — the claim must travel with the feature');
  }
}

// ---------------------------------------------------------------- AC7 — figures

const MIN_FIGURES = 10;

function checkFigures(html) {
  if (!check('AC7', 'figures directory exists', existsSync(FIG_DIR), `expected ${FIG_DIR}`)) return;

  const svgs = readdirSync(FIG_DIR).filter((f) => f.endsWith('.svg'));
  check('AC7', `at least ${MIN_FIGURES} figures authored`, svgs.length >= MIN_FIGURES, `found ${svgs.length}`);

  check('AC7', 'no raster images anywhere in the paper',
    !/<img\b/i.test(html) && !/data:image\/(png|jpe?g|gif|webp)/i.test(html),
    'figures must be inline vector SVG');

  const captions = [...html.matchAll(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi)]
    .map((m) => stripTags(m[1]).trim());
  check('AC7', 'every figure has a caption', captions.length >= MIN_FIGURES,
    `found ${captions.length} figcaptions for ${svgs.length} figures`);

  const numbered = captions.filter((c) => /Figure\s+\d+/i.test(c));
  check('AC7', 'captions are numbered "Figure N"', numbered.length === captions.length,
    `unnumbered: ${captions.filter((c) => !/Figure\s+\d+/i.test(c)).join(' | ')}`);

  // Count citations in the BODY only — captions removed first so a caption can never be
  // mistaken for a reference to itself.
  const body = stripTags(html.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, ' '));
  const unreferenced = [];
  for (const c of numbered) {
    const n = c.match(/Figure\s+(\d+)/i)[1];
    const cited = new RegExp(`Fig(?:ure|\\.)\\s*${n}\\b`, 'i').test(body);
    if (!cited) unreferenced.push(n);
  }
  check('AC7', 'every figure is referenced from the body text', unreferenced.length === 0,
    `never cited in prose: Figure ${unreferenced.join(', ')}`);

  check('AC7', 'figures are inlined into the document', (html.match(/<svg\b/gi) ?? []).length >= MIN_FIGURES,
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
    { label: 'connected applications section', re: /Connected applications/i },
    { label: 'linked-device section', re: /Linked-device connections/i },
    { label: 'runtime contracts section', re: /Runtime contracts/i },
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

  const cssPath = join(WP, 'src', 'paper.css');
  if (check('AC8', 'stylesheet exists', existsSync(cssPath), `expected ${cssPath}`)) {
    const css = read(cssPath);
    check('AC8', 'A4 page geometry declared', /@page\b/.test(css) && /A4/i.test(css));
    check('AC8', 'running heads / page numbers declared',
      /@top-(center|left|right)/.test(css) || /@bottom-(center|left|right)/.test(css),
      'margin boxes are what put running heads and folios on every page');
    check('AC8', 'section + figure counters declared',
      /counter-reset/.test(css) && /counter-increment/.test(css));
    check('AC8', 'running head names the current spec version', /v0\.3/.test(css),
      'the @top-right margin box must carry the v0.3 label');
  }
}

// ------------------------------------------------- AC8 — numbering in the rendered PDF

function checkPdfNumbering(html) {
  const tocNums = [...html.matchAll(/<span class="num">(\d+)<\/span>/g)].map((m) => Number(m[1]));
  check('AC8', 'table of contents is numbered 1..N without gaps',
    tocNums.length >= 12 && tocNums[0] === 1 && tocNums.every((n, i) => n === i + 1),
    `TOC sequence: ${tocNums.join(', ') || '(none found)'}`);

  const cssPath = join(WP, 'src', 'paper.css');
  if (existsSync(cssPath)) {
    const css = read(cssPath).replace(/\/\*[\s\S]*?\*\//g, '');
    const nonumBlock = css.match(/h2\.nonum\s*\{([^}]*)\}/);
    check('AC8', 'unnumbered headings do not advance the section counter',
      !!nonumBlock && /counter-increment:\s*none/.test(nonumBlock[1]),
      'h2.nonum must set `counter-increment: none` — suppressing ::before alone still increments, shifting every section number');
  }

  if (!existsSync(PDF)) return; // AC1 already reported the missing build

  const raw = readFileSync(PDF).toString('latin1');
  const uncompressed = [...raw.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)].length;
  if (uncompressed < 50) {
    console.log('  note: PDF text streams are compressed — printed numbering verified via the CSS guard above.');
  }
}

// ---------------------------------------------------------------- run

function main() {
  const fx = loadSpecFixtures();

  if (!existsSync(SRC_HTML)) {
    console.error(`FATAL: whitepaper source not found at ${SRC_HTML}`);
    process.exit(1);
  }

  const html = assembleForCheck();

  checkPdf();
  checkConstants(html, fx);
  checkFrames(html, fx);
  checkCoverage(html);
  checkClaims(html);
  checkFigures(html);
  checkStructure(html);
  checkPdfNumbering(html);

  const total = passes.length + failures.length;
  if (failures.length) {
    console.error(`\n✗ whitepaper checks: ${failures.length}/${total} FAILED\n`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    console.error('');
    process.exit(1);
  }
  console.log(`✓ whitepaper checks: ${total}/${total} passed (spec fixture: ${fx.specPath})`);
}

main();
