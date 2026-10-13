#!/usr/bin/env node
// sync-starter-hooks.mjs — TASK-20261010-host-broker PR-6 (D-PR6-7, contract note N35;
// ADR-0045 — every change to a starter's app.html is a release). Re-copy the embedded hooks
// block into every starter, renumber the two authored banners, and (with --release) release
// each starter whose page changed.
//
//   node scripts/sync-starter-hooks.mjs                                # re-copy + renumber, write
//   node scripts/sync-starter-hooks.mjs --dry                          # report only, write nothing
//   node scripts/sync-starter-hooks.mjs --release --date=YYYY-MM-DD    # + release each changed starter.json
//   node scripts/sync-starter-hooks.mjs --only=weather,gmail [...]     # a subset of the starters
//
// THE BLOCK. `packages/sdk/embedded/snug-hooks.js` is the copy-exactly hooks block, and every
// starter carries it between the line after `<script type="text/babel">` (the ONE line whose
// trimmed text IS the tag — a comment quoting it is not the opening) and the `// ====` rule
// above the RESPONSE SCHEMA banner — byte-identical under the validator's per-line-trim
// normalisation (`examples/validate.test.mjs`). The splice replaces exactly that region with the
// embedded file re-indented to the page's own first-line indent (the starters store the block
// unindented, whatsapp at four spaces — no whitespace churn), keeps the page's blank line before
// the rule when it has one, and renumbers the two authored banners to follow the block's last
// section (`// 8. RESPONSE SCHEMA`, `// 9. YOUR APP` while the block has seven). Nothing else in
// the authored region is touched. The banner is found by the ONE regex the examples' banner
// helper exports (`examples/infer-connection.mjs` `RESPONSE_SCHEMA_BANNER`, restated here because
// that module imports the built protocol package; the test pins the two equal), and a missing or
// doubled banner, or a banner with no rule above it, is a refusal — never a guess.
//
// THE RELEASE (--release). A starter whose page no longer hashes to its recorded `appHash` is
// released: `version + 1`, the wave's changelog entry prepended (dated --date; the two shared
// sentences first, the starter's one extra item last), and `appHash` recomputed with the
// validator's normalisation (CRLF → LF, trailing whitespace stripped, outer trim). A starter
// whose newest entry IS this wave's (same title and date) is only re-hashed, so a hand edit made
// after the first run (D-PR6-8's adoptions, a Gate-5 fold) rides the same release — and a second
// run with the SAME --date changes nothing. Until the wave is published, a re-run after a fold
// passes the wave's original date (PR-6's wave: --date=2026-10-12), so the edit is only
// re-hashed; any other date releases the page again. A page that did not change is never
// released (ADR-0045: no empty entries).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_EXAMPLES_DIR = path.join(ROOT, 'examples');
export const DEFAULT_EMBEDDED_FILE = path.join(ROOT, 'packages/sdk/embedded/snug-hooks.js');

/** The examples' ONE banner regex (`examples/infer-connection.mjs`) — any section number. */
export const RESPONSE_SCHEMA_BANNER = /\d+\. RESPONSE SCHEMA/;
const RESPONSE_SCHEMA_LINE = /^(\s*)\/\/ \d+\. RESPONSE SCHEMA(.*)$/;
const YOUR_APP_BANNER = /\d+\. YOUR APP\b/;
const YOUR_APP_LINE = /^(\s*)\/\/ \d+\. YOUR APP\b(.*)$/;
const RULE_LINE = /^\s*\/\/ =+$/;
const BABEL_OPEN = '<script type="text/babel">';

/** The validator's normalisation (`examples/validate.test.mjs`) — the test pins the two equal. */
export const normalizeAppHtml = (html) => html.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
export const appHtmlHash = (html) => createHash('sha256').update(normalizeAppHtml(html), 'utf8').digest('hex');
/** The hooks-block normalisation the validator and the sdk kb-sync test share: per-line trim, blank lines dropped. */
export const normalizeHooks = (code) => code.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).join('\n');

// ── The wave's release notes (D-PR6-7: the user's words, ADR-0045) ─────────────────────────────
export const WAVE_TITLE = 'Up to date with Snug';
export const WAVE_SECTION = 'What changed';
/** The two sentences every starter's entry carries, first; `<Name>` is the page's announced displayName. */
export const waveSharedItems = (displayName) => [
  `${displayName} works just as before: this release updates the built-in code every Snug app uses to talk to Snug to the version new apps are built with.`,
  'Customized your copy? You can skip this one — your version keeps working as it is.',
];
/** PR-6's per-starter extra item, last — the two starters that adopted the new hooks (D-PR6-8). A later wave edits this map. */
export const WAVE_EXTRA_ITEMS = Object.freeze({
  weather: 'The morning forecast and its one-time suggestion run on that updated code and work as before.',
  gmail: "'Load my real data' after connecting Gmail runs on that updated code and works as before.",
});
export const waveItems = (folder, displayName) => [
  ...waveSharedItems(displayName),
  ...(Object.hasOwn(WAVE_EXTRA_ITEMS, folder) ? [WAVE_EXTRA_ITEMS[folder]] : []),
];

/**
 * The block's last section number: its section banners are the `// N. ` lines directly under a
 * `// ====` rule, numbered 1..N in order. The authored banners follow it (N + 1, N + 2).
 */
export function lastSection(embedded) {
  const lines = embedded.split('\n');
  const numbers = lines.flatMap((line, at) => {
    const m = /^\/\/ (\d+)\. \S/.exec(line);
    return m && at > 0 && RULE_LINE.test(lines[at - 1]) ? [Number(m[1])] : [];
  });
  if (numbers.length === 0) throw new Error('the embedded hooks block has no numbered section banner');
  numbers.forEach((n, at) => {
    if (n !== at + 1) throw new Error(`the embedded hooks block's sections are not numbered 1..${numbers.length} in order (found ${numbers.join(', ')})`);
  });
  return numbers.length;
}

/**
 * The page's ONE opening-tag line: the line whose trimmed text IS `<script type="text/babel">`.
 * A line that merely quotes the tag (a comment, as the e2e fixtures' headers do) is not one, and
 * two bare opening-tag lines are a refusal — never a guess (RS-3, Gate 5).
 */
function babelOpenLine(lines) {
  const opens = lines.flatMap((line, at) => (line.trim() === BABEL_OPEN ? [at] : []));
  if (opens.length === 0) throw new Error(`no ${BABEL_OPEN} block`);
  if (opens.length > 1) throw new Error(`${opens.length} ${BABEL_OPEN} lines (${opens.map((at) => at + 1).join(', ')}) — two make the cut a guess`);
  return opens[0];
}

/**
 * Re-copy `embedded` into one page and renumber its two authored banners. Pure; throws (and so
 * writes nothing) when the page is not shaped the way every starter is.
 */
export function splice(html, embedded) {
  if (html.includes('\r')) throw new Error('the page has CR line endings — convert it to LF first');
  const lines = html.split('\n');
  const open = babelOpenLine(lines);
  const close = lines.findIndex((line, at) => at > open && line.includes('</script>'));
  if (close < 0) throw new Error(`the ${BABEL_OPEN} block is never closed`);

  const banners = [];
  for (let at = open + 1; at < close; at++) if (RESPONSE_SCHEMA_BANNER.test(lines[at])) banners.push(at);
  if (banners.length === 0) throw new Error(`no RESPONSE SCHEMA banner (${RESPONSE_SCHEMA_BANNER}) in the ${BABEL_OPEN} block`);
  if (banners.length > 1) throw new Error(`${banners.length} RESPONSE SCHEMA banner lines (${banners.map((at) => at + 1).join(', ')}) — two make the cut a guess`);
  const banner = banners[0];
  if (!RESPONSE_SCHEMA_LINE.test(lines[banner])) throw new Error(`the RESPONSE SCHEMA banner at line ${banner + 1} is not a \`// N. RESPONSE SCHEMA\` comment`);
  const rule = banner - 1;
  if (rule <= open || !RULE_LINE.test(lines[rule])) throw new Error(`no \`// ====\` rule above the RESPONSE SCHEMA banner at line ${banner + 1}`);

  const yourApp = [];
  for (let at = banner + 1; at < close; at++) if (YOUR_APP_BANNER.test(lines[at])) yourApp.push(at);
  if (yourApp.length > 1) throw new Error(`${yourApp.length} YOUR APP banner lines (${yourApp.map((at) => at + 1).join(', ')}) — renumbering would be a guess`);
  if (yourApp.length === 1 && !YOUR_APP_LINE.test(lines[yourApp[0]])) throw new Error(`the YOUR APP banner at line ${yourApp[0] + 1} is not a \`// N. YOUR APP\` comment`);

  const n = lastSection(embedded);
  const firstBlockLine = lines.slice(open + 1, rule).find((line) => line.trim() !== '') ?? '';
  const indent = /^[ \t]*/.exec(firstBlockLine)[0];
  const block = embedded.replace(/\n+$/, '').split('\n').map((line) => (line.trim() === '' ? '' : indent + line));
  const trailingBlank = rule - 1 > open && lines[rule - 1].trim() === '' ? [''] : [];

  const authored = lines.slice(rule);
  authored[banner - rule] = lines[banner].replace(RESPONSE_SCHEMA_LINE, (_, lead, rest) => `${lead}// ${n + 1}. RESPONSE SCHEMA${rest}`);
  if (yourApp.length === 1) authored[yourApp[0] - rule] = lines[yourApp[0]].replace(YOUR_APP_LINE, (_, lead, rest) => `${lead}// ${n + 2}. YOUR APP${rest}`);

  const out = [...lines.slice(0, open + 1), ...block, ...trailingBlank, ...authored];
  // The post-condition the validator checks: the region now normalises to the embedded file.
  const copied = out.slice(open + 1, open + 1 + block.length + trailingBlank.length).join('\n');
  if (normalizeHooks(copied) !== normalizeHooks(embedded)) throw new Error('the spliced block does not normalise to the embedded file');
  return out.join('\n');
}

/** The displayName the page announces through `useSnugApp` below its banner — the validator's own reading. */
export function announcedDisplayName(html) {
  const lines = html.split('\n');
  const open = babelOpenLine(lines);
  const banner = lines.findIndex((line, at) => at > open && RESPONSE_SCHEMA_BANNER.test(line));
  if (banner < 0) throw new Error(`no RESPONSE SCHEMA banner in the ${BABEL_OPEN} block`);
  const authored = lines.slice(banner).join('\n');
  const name = /\buseSnugApp\s*\(\s*\{[\s\S]*?\bdisplayName:\s*(['"`])((?:(?!\1)[^\\])+)\1/.exec(authored)?.[2];
  if (!name) throw new Error('the page announces no literal displayName through useSnugApp');
  return name;
}

/** `starter.json` as the twelve store it: 2-space JSON and a trailing newline. */
export const serializeStarterMeta = (meta) => `${JSON.stringify(meta, null, 2)}\n`;

/**
 * Release one starter's metadata for the page `html` (pure). Returns the next metadata and what
 * happened: `released` (version + 1, the wave entry prepended, the hash), `rehashed` (the newest
 * entry is already this wave's — only the hash moves) or `unchanged`.
 */
export function releaseStarterMeta(meta, { folder, html, date }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error(`a release needs a YYYY-MM-DD date (got ${date})`);
  if (!Number.isInteger(meta.version) || !Array.isArray(meta.changelog)) throw new Error('starter.json has no integer version or no changelog');
  const hash = appHtmlHash(html);
  const expected = { title: WAVE_TITLE, sections: [{ title: WAVE_SECTION, items: waveItems(folder, announcedDisplayName(html)) }] };
  const newest = meta.changelog[0];
  const next = structuredClone(meta);
  if (newest && newest.title === WAVE_TITLE && newest.date === date) {
    if (newest.version !== meta.version || JSON.stringify(newest.sections) !== JSON.stringify(expected.sections)) {
      throw new Error(`changelog[0] is a "${WAVE_TITLE}" entry dated ${date} that is not this wave's — fix it by hand`);
    }
    next.appHash = hash;
    return { meta: next, action: meta.appHash === hash ? 'unchanged' : 'rehashed' };
  }
  if (meta.appHash === hash) return { meta: next, action: 'unchanged' };
  next.version = meta.version + 1;
  next.changelog = [{ version: next.version, date, ...expected }, ...meta.changelog];
  next.appHash = hash;
  return { meta: next, action: 'released' };
}

/** The catalogue rule (`build-starters-pkg.mjs`): a folder IS a starter iff it has an `app.html`. */
export function starterFolders(examplesDir) {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(examplesDir, entry.name, 'app.html')))
    .map((entry) => entry.name)
    .sort();
}

const USAGE = 'usage: node scripts/sync-starter-hooks.mjs [--dry] [--release --date=YYYY-MM-DD] [--only=<folder>,<folder>…]';

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { dry: false, release: false };
  for (const arg of argv) {
    if (arg === '--dry') out.dry = true;
    else if (arg === '--release') out.release = true;
    else if (arg.startsWith('--date=')) out.date = arg.slice('--date='.length);
    else if (arg.startsWith('--only=')) out.only = arg.slice('--only='.length).split(',').filter(Boolean);
    else throw new UsageError(`unknown flag ${arg}\n${USAGE}`);
  }
  if (out.release && !/^\d{4}-\d{2}-\d{2}$/.test(out.date ?? '')) throw new UsageError(`--release needs --date=YYYY-MM-DD\n${USAGE}`);
  if (!out.release && out.date !== undefined) throw new UsageError(`--date only with --release\n${USAGE}`);
  return out;
}

/**
 * Sync every starter (or `only`) under `examplesDir` to `embeddedFile`. Every page and every
 * `starter.json` is computed before anything is written, so a refusal on one starter leaves the
 * whole tree untouched.
 */
export function syncStarters({ examplesDir = DEFAULT_EXAMPLES_DIR, embeddedFile = DEFAULT_EMBEDDED_FILE, dry = false, release = false, date, only } = {}) {
  const embedded = readFileSync(embeddedFile, 'utf8');
  const all = starterFolders(examplesDir);
  const unknown = (only ?? []).filter((folder) => !all.includes(folder));
  if (unknown.length > 0) throw new UsageError(`not a starter folder: ${unknown.join(', ')}`);
  const folders = only ? all.filter((folder) => only.includes(folder)) : all;

  const plan = folders.map((folder) => {
    const htmlFile = path.join(examplesDir, folder, 'app.html');
    const before = readFileSync(htmlFile, 'utf8');
    let after;
    try {
      after = splice(before, embedded);
    } catch (err) {
      throw new Error(`${folder}/app.html: ${err.message}`);
    }
    const entry = { folder, htmlFile, before, after, page: before === after ? 'unchanged' : 'changed' };
    if (release) {
      const metaFile = path.join(examplesDir, folder, 'starter.json');
      const raw = readFileSync(metaFile, 'utf8');
      const meta = JSON.parse(raw);
      if (serializeStarterMeta(meta) !== raw) throw new Error(`${folder}/starter.json is not 2-space JSON with a trailing newline — refusing to rewrite it`);
      let released;
      try {
        released = releaseStarterMeta(meta, { folder, html: after, date });
      } catch (err) {
        throw new Error(`${folder}/starter.json: ${err.message}`);
      }
      Object.assign(entry, { metaFile, rawMeta: raw, nextMeta: serializeStarterMeta(released.meta), release: released.action, from: meta.version, to: released.meta.version });
    }
    return entry;
  });

  if (!dry) {
    for (const entry of plan) {
      if (entry.page === 'changed') writeFileSync(entry.htmlFile, entry.after);
      if (entry.metaFile && entry.nextMeta !== entry.rawMeta) writeFileSync(entry.metaFile, entry.nextMeta);
    }
  }
  return plan.map(({ folder, page, release: action, from, to, before, after }) => ({
    folder,
    page,
    lines: after.split('\n').length - before.split('\n').length,
    ...(action ? { release: action, from, to } : {}),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const report = syncStarters(opts);
    for (const r of report) {
      const page = r.page === 'changed' ? `app.html changed (${r.lines >= 0 ? '+' : ''}${r.lines} lines)` : 'app.html unchanged';
      const meta = r.release === undefined ? '' : r.release === 'released' ? ` · starter.json v${r.from} → v${r.to} (released)` : ` · starter.json v${r.to} (${r.release})`;
      console.log(`${r.folder.padEnd(16)} ${page}${meta}`);
    }
    const changed = report.filter((r) => r.page === 'changed').length;
    console.log(`sync-starter-hooks: ${changed} of ${report.length} app.html ${opts.dry ? 'would change (dry run — nothing written)' : 'changed'}`);
  } catch (err) {
    if (err instanceof UsageError) { console.error(err.message); process.exit(2); }
    console.error(`sync-starter-hooks: REFUSED — ${err.message}`);
    process.exit(1);
  }
}
