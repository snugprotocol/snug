// check-website-sync.mjs — AC5 of TASK-20260821-website-launch (ADR-0048 §4).
//
// The public website derives pages from in-repo sources (the spec draft, the protocol
// schemas, the whitepaper, product-vision). This gate reads the manifest
// (apps/website/docs-sync.json), re-hashes every source, and goes RED naming the
// affected website pages whenever a source changed since the site last synced.
//
// What a green DOES prove: no tracked source moved since the last sync.
// What it does NOT prove: that the derived pages are GOOD — an authored page can be
// stale in spirit with matching hashes if its update was sloppy. The /sync-website
// command owns quality; this gate owns "nobody forgot".
//
// Remedy when red: run the /sync-website Claude command (regenerates generated pages
// via `pnpm --filter website sync-docs`, walks authored pages, re-hashes the manifest).
//
// C4: a manifest source under internal/ is refused outright — the website must never
// derive public content from the private strategy tree.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const args = { root: resolve(join(new URL('.', import.meta.url).pathname, '..')), manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') args.root = resolve(argv[i + 1]);
    if (argv[i] === '--manifest') args.manifest = resolve(argv[i + 1]);
  }
  if (!args.manifest) args.manifest = join(args.root, 'apps', 'website', 'docs-sync.json');
  return args;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const { root, manifest: manifestPath } = parseArgs(process.argv.slice(2));

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`website-sync: cannot read manifest at ${manifestPath}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
  console.error('website-sync: manifest has no entries — refusing to vouch for nothing');
  process.exit(1);
}

const problems = [];
const drifted = [];
let sourceCount = 0;

for (const entry of manifest.entries) {
  if (typeof entry.page !== 'string' || !Array.isArray(entry.sources) || entry.sources.length === 0) {
    problems.push(`malformed entry: ${JSON.stringify(entry).slice(0, 120)}`);
    continue;
  }
  if (!existsSync(join(root, entry.page))) {
    problems.push(`derived page missing: ${entry.page}`);
  }
  for (const source of entry.sources) {
    sourceCount += 1;
    if (source.path.startsWith('internal/') || source.path.includes('/internal/')) {
      problems.push(`C4: source under internal/ refused: ${source.path} (page ${entry.page})`);
      continue;
    }
    const full = join(root, source.path);
    if (!existsSync(full)) {
      problems.push(`source missing: ${source.path} (page ${entry.page})`);
      continue;
    }
    const actual = sha256File(full);
    if (actual !== source.sha256) {
      drifted.push({ page: entry.page, kind: entry.kind ?? 'authored', source: source.path });
    }
  }
}

if (problems.length > 0) {
  console.error('website-sync: FAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (drifted.length > 0) {
  console.error('website-sync: DRIFT — sources changed since the website last synced:');
  for (const d of drifted) {
    console.error(`  - ${d.source} → ${d.page} (${d.kind})`);
  }
  console.error('');
  console.error('Remedy: run the /sync-website command in Claude Code');
  console.error('  (generated pages: `pnpm --filter website sync-docs`; authored pages: update');
  console.error('   by hand against the changed source, then sync-docs re-hashes the manifest).');
  process.exit(1);
}

console.log(
  `website-sync: OK — ${manifest.entries.length} pages verified against ${sourceCount} source hashes`,
);
